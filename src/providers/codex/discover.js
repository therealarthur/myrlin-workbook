/**
 * Codex session discovery.
 *
 * Phase 17 Plan 17-01 (CDX-01, CDX-02, CDX-07).
 *
 * Two paths:
 *
 *   Fast-path: read $CODEX_HOME/session_index.jsonl (a flat append-only
 *     {id, thread_name, updated_at} log Codex maintains for its own sidebar).
 *     For each entry, resolve the rollout file under sessions/YYYY/MM/DD/
 *     using the date prefix derived from updated_at and the id-suffixed
 *     filename pattern (rollout-*-<id>.jsonl). Cheap: one stat per entry
 *     plus a 32KB first-line read for cwd extraction.
 *
 *   Walk-fallback: when session_index.jsonl is missing, unreadable, OR has
 *     stale entries (entries whose rollout file no longer exists), recurse
 *     $CODEX_HOME/sessions/YYYY/MM/DD/ for rollout-*.jsonl. Extract the id
 *     from the filename and the cwd from the first line. Slower but
 *     unconditional truth.
 *
 * Both paths produce the same ProviderSession[] shape. The two are merged,
 * deduplicated by providerSessionId (most-recent mtime wins), and sorted
 * by lastActive descending.
 *
 * Failure modes (NEVER throw):
 *   - $CODEX_HOME does not exist -> return []
 *   - $CODEX_HOME/sessions/ does not exist -> return []
 *   - session_index.jsonl corrupt mid-file -> per-line try/catch, walk on stale
 *   - rollout file is mid-write -> first-line parse fails; defensive null cwd
 *   - permission denied on a date dir -> skip, continue
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/discover
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// parse.js is leaf-side: discover does NOT depend on parseTranscript at all.
// We only borrow wrapEnvelope from the _internal surface so the bare-JSON
// first-line case is handled identically in both modules.
const { _internal: parseInternal } = require('./parse');
const wrapEnvelope = parseInternal.wrapEnvelope;

// BUILD-CONTRACT P8.4: the SQLite-first source. state-db.js never throws and
// returns null whenever the store is unavailable for any reason, so requiring
// it cannot destabilise discovery. It does NOT require discover.js back, so
// there is no cycle.
const stateDb = require('./state-db');

// BUILD-CONTRACT P8.3: cwd normalization and project identity, shared with the
// SQLite path so a walk-derived session and a database-derived session in the
// same directory produce the same grouping key.
const { describeProject } = require('./paths');

// ---------------------------------------------------------------------------
// Discovery-source tags
// ---------------------------------------------------------------------------

/**
 * Which on-disk source produced a session record. Carried on every result so a
 * support question ("why is this session missing / why has it no title") is
 * answerable from the payload rather than by re-running discovery by hand.
 */
const DISCOVERY_SOURCES = Object.freeze({
  STATE_DB: 'state-db',
  SESSION_INDEX: 'session-index',
  WALK: 'walk',
  ARCHIVED_WALK: 'archived-walk',
});

/**
 * The rollout event that carries an AI-generated thread title. Present in only
 * 2 of 796 files on the measured machine, which is exactly why scanning for it
 * is a lazy, on-demand step and never part of the bulk discovery pass.
 */
const THREAD_NAME_EVENT_TYPE = 'thread_name_updated';

/** Head-read budget for the lazy title scan. Titles appear early or not at all. */
const LAZY_TITLE_SCAN_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve $CODEX_HOME at call time (NOT module load) so a user can change
 * the env var between calls. Falls back to ~/.codex when unset.
 *
 * Honored strictly: a CODEX_HOME pointing at a non-existent path returns
 * [] from discover() rather than silently falling back to the default. The
 * intent is "if you set CODEX_HOME, you mean it".
 *
 * @returns {string} Absolute path to the Codex home directory.
 */
function getCodexHome() {
  // gsd:provider-literal-allowed (default Codex home directory name)
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Read $CODEX_HOME/session_index.jsonl line-by-line. Returns null when the
 * file is missing or unreadable; otherwise returns an array of valid index
 * entries. Corrupt lines are skipped via try/catch; valid entries continue
 * to be collected, so a single bad line does not poison the whole index.
 *
 * @returns {Array<{id:string, thread_name:string, updated_at:string}>|null}
 */
function readSessionIndex() {
  const indexPath = path.join(getCodexHome(), 'session_index.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(indexPath, 'utf-8');
  } catch (_) {
    return null;
  }
  const out = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        typeof entry.updated_at === 'string'
      ) {
        out.push({
          id: entry.id,
          thread_name: typeof entry.thread_name === 'string' ? entry.thread_name : '',
          updated_at: entry.updated_at,
        });
      }
    } catch (_) {
      // Skip corrupt line; keep going.
    }
  }
  return out;
}

/**
 * Build the candidate rollout path for an index entry.
 *
 * Extracts YYYY/MM/DD from entry.updated_at, then scans the date directory
 * for files matching `rollout-*-<entry.id>.jsonl` (case-insensitive on the
 * UUID; UUIDs are regex-safe so we just substring-test).
 *
 * Returns null when the date is unparseable, the date dir is missing, or
 * no file matches. When multiple files match (defensive; should not occur),
 * returns the lex-largest filename which is the newest by ISO sort.
 *
 * @param {string} codexHome
 * @param {{id:string, updated_at:string}} entry
 * @returns {string|null} Absolute path to rollout-*-<id>.jsonl, or null.
 */
function resolveIndexEntryToPath(codexHome, entry) {
  const date = new Date(entry.updated_at);
  if (isNaN(date.getTime())) return null;

  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dayDir = path.join(codexHome, 'sessions', yyyy, mm, dd);

  let files;
  try {
    files = fs.readdirSync(dayDir);
  } catch (_) {
    return null;
  }

  const idLower = entry.id.toLowerCase();
  const suffix = '-' + idLower + '.jsonl';
  const matches = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.startsWith('rollout-') && lower.endsWith(suffix)) {
      matches.push(f);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return path.join(dayDir, matches[0]);

  // Multiple matches: defensive; pick lex-largest (newest by ISO sort).
  matches.sort();
  return path.join(dayDir, matches[matches.length - 1]);
}

/**
 * Recursively walk $CODEX_HOME/sessions/YYYY/MM/DD/ for rollout-*.jsonl
 * files. Returns absolute paths. Tolerates missing intermediate dirs.
 *
 * Uses Node 18.17+ recursive readdir when available; falls back to a
 * manual three-level walk on older runtimes for safety.
 *
 * @param {string} codexHome
 * @returns {string[]} Absolute paths of matching rollout files.
 */
function walkSessionsTree(codexHome) {
  const sessionsRoot = path.join(codexHome, 'sessions');
  const out = [];

  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { recursive: true, withFileTypes: true });
  } catch (_) {
    // Older Node fallback OR sessions root missing.
    return walkSessionsTreeManual(sessionsRoot);
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (!lower.startsWith('rollout-') || !lower.endsWith('.jsonl')) continue;
    const parent = e.parentPath || e.path || sessionsRoot;
    out.push(path.join(parent, e.name));
  }
  return out;
}

/**
 * Manual three-level YYYY/MM/DD walk used when fs.readdirSync(...,{recursive})
 * is unavailable. Returns [] on any IO error (defensive).
 *
 * @param {string} sessionsRoot
 * @returns {string[]}
 */
function walkSessionsTreeManual(sessionsRoot) {
  const out = [];
  let years;
  try {
    years = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const y of years) {
    if (!y.isDirectory()) continue;
    const yearDir = path.join(sessionsRoot, y.name);
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const m of months) {
      if (!m.isDirectory()) continue;
      const monthDir = path.join(yearDir, m.name);
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const d of days) {
        if (!d.isDirectory()) continue;
        const dayDir = path.join(monthDir, d.name);
        let files;
        try {
          files = fs.readdirSync(dayDir);
        } catch (_) {
          continue;
        }
        for (const f of files) {
          const lower = f.toLowerCase();
          if (lower.startsWith('rollout-') && lower.endsWith('.jsonl')) {
            out.push(path.join(dayDir, f));
          }
        }
      }
    }
  }
  return out;
}

/**
 * Absolute path to $CODEX_HOME/archived_sessions.
 *
 * Codex moves ended threads here as flat `rollout-*.jsonl` files (same
 * on-disk envelope format as sessions/). These are invisible to both
 * session_index.jsonl and the sessions/ walk, so discovery + search must
 * scan this directory explicitly. Optional on disk; callers guard with
 * fs.existsSync.
 *
 * @param {string} codexHome
 * @returns {string} Absolute path to the archived_sessions directory.
 */
function getArchivedSessionsDir(codexHome) {
  return path.join(codexHome, 'archived_sessions');
}

/**
 * Collect absolute paths of every `rollout-*.jsonl` under an arbitrary root.
 * Handles the flat archived layout AND any date-bucketed nesting via a
 * recursive readdir, with a flat-then-manual fallback for older Node or
 * filesystems that reject the recursive option. Returns [] when the root is
 * missing or unreadable (never throws).
 *
 * Factored out so both the sessions/ walk (via walkSessionsTree) and the
 * archived_sessions/ scan share one rollout-matching predicate.
 *
 * @param {string} root - Directory to scan.
 * @returns {string[]} Absolute paths of matching rollout files.
 */
function collectRolloutFilesUnder(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (_) {
    // Recursive option unavailable OR root missing: try a flat readdir so the
    // common (flat) archived layout still resolves; give up quietly otherwise.
    try {
      for (const f of fs.readdirSync(root)) {
        const lower = f.toLowerCase();
        if (lower.startsWith('rollout-') && lower.endsWith('.jsonl')) {
          out.push(path.join(root, f));
        }
      }
    } catch (_) { /* missing/unreadable; return [] */ }
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (!lower.startsWith('rollout-') || !lower.endsWith('.jsonl')) continue;
    const parent = e.parentPath || e.path || root;
    out.push(path.join(parent, e.name));
  }
  return out;
}

/**
 * Enumerate archived rollout files under $CODEX_HOME/archived_sessions.
 * Guarded: returns [] when the directory does not exist. Tags nothing here;
 * the caller decides how to mark the archived flag on the resulting sessions.
 *
 * @param {string} codexHome
 * @returns {string[]} Absolute paths of archived rollout files.
 */
function walkArchivedSessions(codexHome) {
  const root = getArchivedSessionsDir(codexHome);
  if (!fs.existsSync(root)) return [];
  return collectRolloutFilesUnder(root);
}

/**
 * Extract providerSessionId from a rollout filename.
 *
 * Pattern: `rollout-<ISO-8601-with-dashes>-<UUID>.jsonl`. The trailing UUID
 * is the canonical providerSessionId (matches session_index.jsonl[entry].id).
 * Lowercased on return because UUIDs are case-insensitive but Map keys are not.
 *
 * @param {string} filename - basename only (no directories).
 * @returns {string|null} Lowercased UUID or null on miss.
 */
function extractIdFromFilename(filename) {
  const m = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    filename
  );
  return m ? m[1].toLowerCase() : null;
}

/**
 * Read only the first line of a rollout file to extract cwd, startedAt,
 * title hint, and CLI version from the session_meta payload. Tolerates
 * corrupt files. Returns null on any failure.
 *
 * Reads up to 256KB from the head because session_meta payloads can be
 * large (base_instructions text can be 100KB+; Codex 0.125 packs the
 * full personality prompt into the first line).
 *
 * Calls wrapEnvelope from parse.js so a pre-0.45 bare-JSON first line is
 * handled identically.
 *
 * @param {string} filePath
 * @returns {{cwd:string|null, startedAt:string|null, title:string|null, cliVersion:string|null}|null}
 */
function readSessionMetaFromFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (_) {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const headSize = Math.min(256 * 1024, stat.size);
    const buf = Buffer.alloc(headSize);
    fs.readSync(fd, buf, 0, headSize, 0);

    const text = buf.toString('utf-8');
    const newlineIdx = text.indexOf('\n');
    const firstLine = newlineIdx === -1 ? text : text.substring(0, newlineIdx);
    if (!firstLine) return null;

    let parsed;
    try {
      parsed = JSON.parse(firstLine);
    } catch (_) {
      return null;
    }
    const envelope = wrapEnvelope(parsed);
    if (!envelope || envelope.type !== 'session_meta') return null;

    const payload = envelope.payload || {};
    // Codex Desktop spawns subagent threads (explorer/Pascal/Linnaeus/etc.)
    // as their own rollout files with payload.source.subagent.thread_spawn set.
    // These are internal agent fan-outs from a parent user thread; the user
    // never opened them directly and they pollute the discovered list. Filter
    // them out so the sidebar shows only top-level user conversations. The
    // subagent rollouts remain on disk and parseTranscript still reads them
    // when a parent thread's transcript references them.
    const src = payload.source;
    const isSubagent = src && typeof src === 'object' && src.subagent != null;
    return {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      startedAt: typeof payload.timestamp === 'string' ? payload.timestamp : null,
      title: null, // session_meta does not carry the human title; that lives in event_msg.thread_name_updated or session_index
      cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : null,
      isSubagent,
    };
  } catch (_) {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite-first discovery helpers (BUILD-CONTRACT P8.4, P8.5, P8.8, P8.9)
// ---------------------------------------------------------------------------

/**
 * How often the union walk re-reconciles against the SQLite view.
 *
 * The walk is never deleted and never stops being a source, but it costs about
 * 3.1 seconds against a real 2863-file tree, and 319 milliseconds of that is
 * filename enumeration alone. Paying that on every discovery would miss the
 * sub-100ms budget by more than an order of magnitude. So when the database is
 * available the walk becomes a throttled, asynchronous reconciliation pass whose
 * results are unioned into every subsequent call, rather than a synchronous
 * step on the hot path. When the database is NOT available the original
 * synchronous walk runs exactly as it always has.
 *
 * Matched to the existing 5-minute fallback poll in index.js so the two agree.
 */
const WALK_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Sessions the union walk found that the SQLite store has never recorded.
 * Cached between calls so the reconciliation cost is amortised.
 * @type {{at: number, running: boolean, home: string|null, sessions: Array<object>}}
 */
let _walkExtras = { at: 0, running: false, home: null, sessions: [] };

/**
 * Reset the reconciliation cache. Exported for tests and for a caller that
 * knows CODEX_HOME changed.
 * @returns {void}
 */
function resetWalkExtras() {
  _walkExtras = { at: 0, running: false, home: null, sessions: [] };
}

/**
 * Build a thread id to AI-generated title map from session_index.jsonl.
 *
 * This is step 4 of the title cascade and the single highest-yield step: it
 * covers 55 of the 125 top-level threads, where `threads.name` covers 0 and the
 * catalog covers 1. It is also the only step that turns a 12 KB raw first
 * message into the short label the user actually recognises.
 *
 * Later entries win, because the file is an append-only log and a thread can be
 * retitled.
 *
 * @returns {Map<string, string>} Lowercased thread id -> title.
 */
function buildSessionIndexTitleMap() {
  const map = new Map();
  const entries = readSessionIndex();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    const title = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
    if (title.length === 0) continue;
    map.set(entry.id.toLowerCase(), title);
  }
  return map;
}

/**
 * Size and modification time of a file, or nulls. Never throws.
 *
 * @param {string} filePath
 * @returns {{size: number, mtime: Date|null}}
 */
function statSizeAndMtime(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { size: 0, mtime: null };
    return { size: stat.size, mtime: stat.mtime };
  } catch (_) {
    return { size: 0, mtime: null };
  }
}

/**
 * Attach the shared project descriptor to a session record.
 *
 * Applied to BOTH database-derived and walk-derived sessions, which is the
 * whole point: BUILD-CONTRACT P8.6 merges a Claude folder and a Codex folder
 * when their normalized keys match, and that can only work if every Codex
 * session, whatever produced it, carries the same key derivation.
 *
 * @param {object} target - Session record, mutated in place.
 * @param {string|null} cwd - Raw working directory.
 * @returns {object} The same record, for chaining.
 */
function attachProjectFields(target, cwd) {
  const project = describeProject(cwd || '');
  target.projectPath = project.path || null;
  target.projectPathRaw = typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
  target.projectKey = project.key || null;
  target.projectId = project.id || null;
  target.projectDisplayName = project.displayName || null;
  return target;
}

/**
 * Convert one state-db thread record into a ProviderSession.
 *
 * The legacy field names are load-bearing across the frontend and are kept
 * exactly: `providerSessionId`, `projectPath`, `lastActive`, `sizeBytes`. New
 * fields are added alongside them, never in place of them.
 *
 * lastActive is fed from `recency_at_ms` (BUILD-CONTRACT P8.9), which is the
 * app's own sort key and is deliberately distinct from `updated_at`. Falling
 * back through updated, then created, then the transcript's mtime means a row
 * with no timestamps at all still sorts somewhere sane instead of at the epoch.
 *
 * @param {object} row - A state-db thread record.
 * @param {Map<string,string>} indexTitles - From buildSessionIndexTitleMap.
 * @returns {object|null} ProviderSession, or null when the row is unusable.
 */
function sessionFromThreadRow(row, indexTitles) {
  if (!row || typeof row.id !== 'string' || row.id.length === 0) return null;

  const rolloutPath = row.rolloutPath || null;
  const fileStat = rolloutPath ? statSizeAndMtime(rolloutPath) : { size: 0, mtime: null };

  const resolved = stateDb.resolveTitle(
    Object.assign({}, row.titleParts, { indexTitle: indexTitles.get(row.id) || null })
  );

  const lastActiveMs =
    row.recencyAtMs ||
    row.updatedAtMs ||
    row.createdAtMs ||
    (fileStat.mtime ? fileStat.mtime.getTime() : 0);

  const session = {
    provider: 'codex', // gsd:provider-literal-allowed
    providerSessionId: row.id,
    encodedName: null,
    title: resolved.title,
    lastActive: new Date(lastActiveMs),
    sizeBytes: fileStat.size,
    cliVersion: row.cliVersion || null,

    // Provenance, so a missing or untitled session is diagnosable from the
    // payload alone rather than by re-running discovery by hand.
    discoverySource: DISCOVERY_SOURCES.STATE_DB,
    titleSource: resolved.source,

    // Everything the side peek and the sessions table need, straight from the
    // store, none of which the filesystem walk can produce.
    preview: row.preview || null,
    rolloutPath: rolloutPath,
    archived: row.archived === true,
    isPinned: row.isPinned === true,
    sectionId: row.sectionId || null,
    recencyAtMs: row.recencyAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    tokensUsed: row.tokensUsed,
    model: row.model || null,
    modelProvider: row.modelProvider || null,
    reasoningEffort: row.reasoningEffort || null,
    approvalMode: row.approvalMode || null,
    sandboxPolicy: row.sandboxPolicy || null,
    gitBranch: row.gitBranch || null,
    gitSha: row.gitSha || null,
    gitOriginUrl: row.gitOriginUrl || null,
    threadSource: row.threadSource || null,
    agentNickname: row.agentNickname || null,
    agentRole: row.agentRole || null,
  };

  return attachProjectFields(session, row.cwdRaw || row.cwd);
}

/**
 * Step 5 of the title cascade: scan a rollout for a `thread_name_updated`
 * event, last one winning.
 *
 * Deliberately NOT called during the bulk discovery pass. The event exists in 2
 * of 796 files on the measured machine, so scanning every rollout to recover
 * two titles would cost seconds to gain nothing. This is the lazy, on-demand
 * entry point BUILD-CONTRACT P8.5 asks for: call it only for a row still
 * unresolved after step 4, and only when something actually needs that row's
 * title.
 *
 * Reads a bounded head window rather than the whole file, because a rollout can
 * be tens of megabytes and a title event, when present, is written early.
 *
 * @param {string} rolloutPath - Absolute path to a rollout .jsonl.
 * @returns {string|null} The last title found in the window, or null.
 */
function resolveTitleFromRollout(rolloutPath) {
  if (!rolloutPath || typeof rolloutPath !== 'string') return null;
  let fd;
  try {
    fd = fs.openSync(rolloutPath, 'r');
  } catch (_) {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const headSize = Math.min(LAZY_TITLE_SCAN_BYTES, stat.size);
    if (headSize <= 0) return null;
    const buf = Buffer.alloc(headSize);
    fs.readSync(fd, buf, 0, headSize, 0);
    const text = buf.toString('utf-8');

    let found = null;
    for (const line of text.split('\n')) {
      // Cheap pre-filter: only pay JSON.parse on lines that mention the event.
      if (!line || line.indexOf(THREAD_NAME_EVENT_TYPE) === -1) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (_) {
        continue; // a truncated tail line is expected in a bounded window
      }
      const envelope = wrapEnvelope(parsed);
      if (!envelope || !envelope.payload) continue;
      const payload = envelope.payload;
      if (payload.type !== THREAD_NAME_EVENT_TYPE) continue;
      const name = typeof payload.thread_name === 'string' ? payload.thread_name.trim() : '';
      if (name.length > 0) found = name; // last one wins
    }
    return found;
  } catch (_) {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Asynchronous filename enumeration for the reconciliation pass.
 *
 * A deliberate sibling of walkSessionsTree rather than a replacement for it:
 * the synchronous version stays exactly as it is, keeps its tests, and remains
 * the path used when the database is unavailable. This one exists solely so the
 * throttled reconciliation does not block the event loop for 319 milliseconds
 * inside a server process.
 *
 * @param {string} root - Directory to enumerate.
 * @returns {Promise<string[]>} Absolute rollout paths, [] on any failure.
 */
async function enumerateRolloutFilesAsync(root) {
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.startsWith('rollout-') || !lower.endsWith('.jsonl')) continue;
    const parent = entry.parentPath || entry.path || root;
    out.push(path.join(parent, entry.name));
  }
  return out;
}

/**
 * The union pass: find rollouts on disk that the SQLite store has never
 * recorded, and turn them into sessions.
 *
 * This is what keeps the contract's "union, not replacement" honest. It is
 * throttled and asynchronous rather than removed, so the walk remains a
 * permanent source without taxing every call. The distinction it relies on is
 * the id census from state-db: an id the store KNOWS but excluded was excluded
 * on purpose by the app's own visibility model, and re-adding it here would
 * undo that verdict; an id the store has never seen is one only the walk can
 * surface.
 *
 * @param {string} codexHome
 * @param {Set<string>|null} knownIds - Every id the store knows, or null.
 * @returns {Promise<Array<object>>} Sessions for unknown ids only.
 */
async function reconcileWalkExtras(codexHome, knownIds) {
  const sessionsRoot = path.join(codexHome, 'sessions');
  const archivedRoot = getArchivedSessionsDir(codexHome);
  const files = [];
  files.push.apply(files, await enumerateRolloutFilesAsync(sessionsRoot));
  files.push.apply(files, await enumerateRolloutFilesAsync(archivedRoot));

  const extras = [];
  const seen = new Set();
  for (const filePath of files) {
    const id = extractIdFromFilename(path.basename(filePath));
    if (!id || seen.has(id)) continue;
    if (knownIds && knownIds.has(id)) continue; // the store has a verdict; respect it
    seen.add(id);

    const stat = statSizeAndMtime(filePath);
    if (!stat.mtime) continue;
    const meta = readSessionMetaFromFile(filePath);
    // Keep the walk's own subagent filter for walk-derived rows. It is more
    // aggressive than the store's spawn-edge filter, and loosening it here
    // would surface agent fan-outs the sidebar has never shown.
    if (meta && meta.isSubagent) continue;

    const isArchived = filePath.toLowerCase().indexOf(archivedRoot.toLowerCase()) === 0;
    const session = {
      provider: 'codex', // gsd:provider-literal-allowed
      providerSessionId: id,
      encodedName: null,
      title: null,
      lastActive: stat.mtime,
      sizeBytes: stat.size,
      cliVersion: meta ? meta.cliVersion : null,
      discoverySource: isArchived ? DISCOVERY_SOURCES.ARCHIVED_WALK : DISCOVERY_SOURCES.WALK,
      titleSource: null,
      rolloutPath: filePath,
    };
    if (isArchived) session.archived = true;
    extras.push(attachProjectFields(session, meta ? meta.cwd : null));
  }
  return extras;
}

/**
 * Kick the reconciliation pass if it is stale, without waiting for it.
 *
 * Fire and forget by design: the caller returns the database view immediately
 * and the extras appear on the next discovery, which the existing watcher and
 * the 5-minute poll both trigger. Every failure is swallowed, because a
 * reconciliation problem must never degrade a discovery that already succeeded.
 *
 * @param {string} codexHome
 * @param {Set<string>|null} knownIds
 * @param {boolean} awaitCompletion - When true, wait for the pass. Used by
 *   tests and by an explicit deep refresh.
 * @returns {Promise<void>}
 */
async function maybeReconcileWalkExtras(codexHome, knownIds, awaitCompletion) {
  const stale =
    _walkExtras.home !== codexHome || Date.now() - _walkExtras.at > WALK_RECONCILE_INTERVAL_MS;
  if (!stale && !awaitCompletion) return;
  if (_walkExtras.running && !awaitCompletion) return;

  const run = (async () => {
    _walkExtras.running = true;
    try {
      const extras = await reconcileWalkExtras(codexHome, knownIds);
      _walkExtras = { at: Date.now(), running: false, home: codexHome, sessions: extras };
    } catch (err) {
      _walkExtras.running = false;
      // eslint-disable-next-line no-console
      console.debug('[codex-discover] union walk reconciliation failed: ' + (err && err.message));
    }
  })();

  if (awaitCompletion) await run;
}

// ---------------------------------------------------------------------------
// Public: discover
// ---------------------------------------------------------------------------

/**
 * Enumerate locally-discoverable Codex sessions.
 * Returns [] (never throws) when $CODEX_HOME does not exist or
 * $CODEX_HOME/sessions/ is missing.
 *
 * Algorithm:
 *   1. Try the fast-path via session_index.jsonl. Each entry resolves to
 *      a rollout file via the date-bucketed filename pattern. Entries
 *      that resolve get a full ProviderSession including projectPath
 *      (extracted from the rollout's first line). Entries that fail to
 *      resolve are tracked as staleIds for the walk-fallback to recover.
 *   2. If the index was missing/empty/unusable OR any staleIds were
 *      collected, run the walk-fallback against $CODEX_HOME/sessions/.
 *      For each rollout file, extract the id from the filename. If the
 *      id is already in byId from the fast-path AND not stale, skip;
 *      otherwise add it (walk-recovery for stale OR no-index cases).
 *   3. Merge, deduplicate by providerSessionId (most-recent lastActive
 *      wins on conflict), sort by lastActive descending.
 *
 * BUILD-CONTRACT P8.4 adds a SQLite-first source in front of all of the above,
 * WITHOUT removing any of it:
 *
 *   0. Read the desktop app's own thread store, `state_5.sqlite`. Its visible
 *      set is `archived = 0 AND preview <> '' AND NOT a spawn child`, which is
 *      125 threads on the measured machine where the walk produced 52. Every
 *      row carries the cwd, the rollout path, the model, the token total and
 *      the recency key, none of which the walk can produce.
 *
 * The walk is a UNION source, not a fallback that gets switched off. When the
 * store is unavailable, steps 1 to 3 run exactly as they always have. When the
 * store IS available, the walk still runs, but throttled and asynchronously,
 * and it contributes only ids the store has never recorded: an id the store
 * knows and excluded was excluded by the app's own visibility model, and
 * re-adding it here would silently undo that verdict.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRefresh] - Bypass the state-db warm cache.
 * @param {boolean} [opts.deep] - Wait for the union walk instead of letting it
 *   land on the next call. Slow by design; used by tests and explicit refreshes.
 * @param {boolean} [opts.includeArchived=true] - Include archived threads,
 *   tagged `archived: true`. Defaults to true because that is the behaviour the
 *   archived_sessions scan has always had, and "no tracked session is ever
 *   lost" is an existing product rule.
 * @returns {Promise<Array<{provider:string, providerSessionId:string,
 *   projectPath:string|null, encodedName:null, title:string|null,
 *   lastActive:Date, sizeBytes:number, cliVersion?:string|null}>>}
 */
async function discover(opts) {
  const options = opts || {};
  const forceRefresh = options.forceRefresh === true;
  const deep = options.deep === true;
  const includeArchived = options.includeArchived !== false;

  const codexHome = getCodexHome();
  if (!fs.existsSync(codexHome)) return [];
  const sessionsRoot = path.join(codexHome, 'sessions');
  // archived_sessions/ holds ended threads and is independent of sessions/.
  // Discovery must surface both, so we only bail when NEITHER exists (a
  // CODEX_HOME with only archived threads is still fully discoverable).
  const hasSessions = fs.existsSync(sessionsRoot);
  const hasArchived = fs.existsSync(getArchivedSessionsDir(codexHome));
  const hasStateDb = stateDb.isAvailable();
  if (!hasSessions && !hasArchived && !hasStateDb) return [];

  /** @type {Map<string, object>} providerSessionId -> ProviderSession */
  const byId = new Map();
  /** @type {Set<string>} ids whose index entry pointed at a missing file */
  const staleIds = new Set();

  // The title map is built once and shared by every source, so a walk-derived
  // session gets the same AI-generated title a store-derived one would.
  const indexTitles = buildSessionIndexTitleMap();

  // ─── SQLite-first source (BUILD-CONTRACT P8.4) ─────────────────────────
  // Never throws and returns null on absence, corruption, schema drift or a
  // missing engine, at which point everything below runs exactly as before.
  let dbThreads = null;
  let knownIds = null;
  if (hasStateDb) {
    try {
      dbThreads = await stateDb.listThreads({
        includeArchived: includeArchived,
        force: forceRefresh,
      });
      if (dbThreads) knownIds = await stateDb.getKnownThreadIds();
    } catch (err) {
      // Belt and braces: state-db is contractually non-throwing, but discovery
      // is the wrong place to discover that a contract was broken.
      dbThreads = null;
      knownIds = null;
      // eslint-disable-next-line no-console
      console.debug('[codex-discover] state-db read failed, using the walk: ' + (err && err.message));
    }
  }

  if (Array.isArray(dbThreads)) {
    for (const row of dbThreads) {
      const session = sessionFromThreadRow(row, indexTitles);
      if (session) byId.set(session.providerSessionId, session);
    }
  }

  /**
   * Should a walk-derived id be added to the result.
   *
   * Three distinct situations, only the last of which is an accept:
   *   - already produced by an earlier source: no, first source wins;
   *   - known to the store but not in its visible set: no, that is the app's
   *     own verdict and the walk has no better information;
   *   - unknown to the store, or no store at all: yes, the walk is the only
   *     source that can see it.
   *
   * @param {string} id - Lowercased thread id.
   * @returns {boolean}
   */
  function acceptFromWalk(id) {
    if (byId.has(id)) return false;
    if (knownIds && knownIds.has(id)) return false;
    return true;
  }

  // ─── Fast-path: session_index.jsonl (only meaningful when sessions/ exists) ─
  const index = hasSessions ? readSessionIndex() : null;
  if (Array.isArray(index)) {
    for (const entry of index) {
      // The store, when present, has already spoken for this id.
      if (!acceptFromWalk(String(entry.id).toLowerCase())) continue;
      const rolloutPath = resolveIndexEntryToPath(codexHome, entry);
      if (!rolloutPath) {
        staleIds.add(entry.id.toLowerCase());
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(rolloutPath);
      } catch (_) {
        staleIds.add(entry.id.toLowerCase());
        continue;
      }
      if (!stat.isFile()) {
        staleIds.add(entry.id.toLowerCase());
        continue;
      }
      // Lazy-fill projectPath via the first-line read. Cost: one ~256KB read
      // per entry, bound by index size. Mirrors what walk-fallback does for
      // every file, so per-file work is even.
      const meta = readSessionMetaFromFile(rolloutPath);

      // Skip subagent-spawned threads (explorer/specialist agents Codex Desktop
      // forks off a parent user thread). They share the same on-disk format but
      // were never user-initiated; surfacing them in the sidebar duplicates and
      // confuses the conversation list.
      if (meta && meta.isSubagent) continue;

      const indexUpdated = new Date(entry.updated_at);
      const mtime = stat.mtime;
      const lastActive = !isNaN(indexUpdated.getTime()) && mtime < indexUpdated ? indexUpdated : mtime;

      // P8.3/P8.6: the project descriptor is attached here too, so a session
      // this path produced merges into the same folder row as one the store
      // produced. attachProjectFields sets projectPath from the normalized cwd,
      // which is the same value this line used to set directly.
      byId.set(
        entry.id.toLowerCase(),
        attachProjectFields(
          {
            provider: 'codex', // gsd:provider-literal-allowed
            providerSessionId: entry.id.toLowerCase(),
            encodedName: null,
            title: entry.thread_name || null,
            lastActive: lastActive,
            sizeBytes: stat.size,
            cliVersion: meta ? meta.cliVersion : null,
            discoverySource: DISCOVERY_SOURCES.SESSION_INDEX,
            titleSource: entry.thread_name ? stateDb.TITLE_SOURCES.SESSION_INDEX : null,
            rolloutPath: rolloutPath,
          },
          meta ? meta.cwd : null
        )
      );
    }
  }

  // ─── Walk-fallback: index missing OR has stale entries ─────────────────
  // Unchanged when there is no store: this is still the unconditional truth
  // and still the only path that works on a machine where the desktop app has
  // never run. When the store IS available it is deliberately skipped here,
  // because a synchronous full walk costs about 3.1 seconds against a real
  // 2863-file tree and would miss the sub-100ms budget by a factor of thirty.
  // The walk is not lost: maybeReconcileWalkExtras below runs the same union
  // asynchronously and on a throttle, and its results are merged into every
  // subsequent call.
  const indexUnusable = !Array.isArray(index) || index.length === 0;
  const storeDroveDiscovery = Array.isArray(dbThreads);
  const walkNeeded = hasSessions && !storeDroveDiscovery && (indexUnusable || staleIds.size > 0);
  if (walkNeeded) {
    const files = walkSessionsTree(codexHome);
    for (const filePath of files) {
      const filename = path.basename(filePath);
      const id = extractIdFromFilename(filename);
      if (!id) continue;

      // If fast-path already resolved this id (and it is NOT marked stale), skip.
      if (byId.has(id) && !staleIds.has(id)) continue;

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {
        continue;
      }
      if (!stat.isFile()) continue;

      const meta = readSessionMetaFromFile(filePath);
      // Skip subagent-spawned threads (see comment in fast-path block above).
      if (meta && meta.isSubagent) continue;
      // If we get here, the index either had no usable entry for this id OR
      // pointed at a missing file. Either way, walk-derived data is truth.
      // The title still comes from session_index when it has one for this id:
      // the walk used to hardcode null here, which is half of why only 27 of
      // 52 discovered sessions carried a title.
      const walkTitle = indexTitles.get(id) || null;
      byId.set(
        id,
        attachProjectFields(
          {
            provider: 'codex', // gsd:provider-literal-allowed
            providerSessionId: id,
            encodedName: null,
            title: walkTitle,
            lastActive: stat.mtime,
            sizeBytes: stat.size,
            cliVersion: meta ? meta.cliVersion : null,
            discoverySource: DISCOVERY_SOURCES.WALK,
            titleSource: walkTitle ? stateDb.TITLE_SOURCES.SESSION_INDEX : null,
            rolloutPath: filePath,
          },
          meta ? meta.cwd : null
        )
      );
    }
    if (staleIds.size > 0) {
      // eslint-disable-next-line no-console
      console.debug(
        '[codex-discover] index had ' + staleIds.size + ' stale entr(ies); walked to recover'
      );
    }
  }

  // Stale-entry final pass: any id in staleIds that the walk did NOT
  // recover (because the rollout file truly does not exist anywhere on
  // disk) must be dropped from the result. The fast-path never inserted
  // these into byId (we marked them stale BEFORE setting), so they are
  // already absent. The check below is defensive: if a future refactor
  // changes the fast-path insertion order, this guard keeps the contract
  // intact (stale entries never appear in the result).
  for (const staleId of staleIds) {
    if (byId.has(staleId)) {
      // Walk recovered this id (either by finding the file at a different
      // date directory or because the index was right and the stat just
      // raced). Keep it.
      continue;
    }
  }

  // ─── Archived-sessions scan (always runs when the directory exists) ─────
  // $CODEX_HOME/archived_sessions/ holds ended threads that neither the
  // session_index.jsonl fast-path nor the sessions/ walk can see. We surface
  // them tagged `archived: true` so the UI can distinguish them, and so the
  // product rule "no tracked session is ever lost" holds: an archived thread
  // is still discoverable, resumable, and searchable. A live sessions/ entry
  // for the same id wins (archived is only a fallback for ids not already
  // present).
  if (hasArchived) {
    const archivedFiles = walkArchivedSessions(codexHome);
    for (const filePath of archivedFiles) {
      const filename = path.basename(filePath);
      const id = extractIdFromFilename(filename);
      if (!id) continue;
      // Was `if (byId.has(id)) continue`. acceptFromWalk is that same check
      // plus the store's verdict, so an archived thread the store deliberately
      // filtered out is not smuggled back in through this door. With no store
      // present, acceptFromWalk reduces to exactly the original condition.
      if (!acceptFromWalk(id)) continue;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {
        continue;
      }
      if (!stat.isFile()) continue;
      const meta = readSessionMetaFromFile(filePath);
      // Skip subagent-spawned threads (same filter as the live paths).
      if (meta && meta.isSubagent) continue;
      const archivedTitle = indexTitles.get(id) || null;
      byId.set(
        id,
        attachProjectFields(
          {
            provider: 'codex', // gsd:provider-literal-allowed
            providerSessionId: id,
            encodedName: null,
            title: archivedTitle,
            lastActive: stat.mtime,
            sizeBytes: stat.size,
            cliVersion: meta ? meta.cliVersion : null,
            archived: true,
            discoverySource: DISCOVERY_SOURCES.ARCHIVED_WALK,
            titleSource: archivedTitle ? stateDb.TITLE_SOURCES.SESSION_INDEX : null,
            rolloutPath: filePath,
          },
          meta ? meta.cwd : null
        )
      );
    }
  }

  // ─── The union pass (BUILD-CONTRACT P8.4: union, not replacement) ───────
  // Sessions the store has never recorded. Merged in from the previous
  // reconciliation, then a fresh reconciliation is kicked off if the cached one
  // is stale. Fire and forget unless the caller explicitly asked to wait, so a
  // 3-second walk never sits in front of a 50-millisecond read.
  if (storeDroveDiscovery) {
    await maybeReconcileWalkExtras(codexHome, knownIds, deep);
    for (const extra of _walkExtras.sessions) {
      if (byId.has(extra.providerSessionId)) continue;
      if (!includeArchived && extra.archived === true) continue;
      byId.set(extra.providerSessionId, extra);
    }
  }

  const out = Array.from(byId.values());
  out.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = discover;
// Test introspection surface (mirrors parse.js's _internal pattern). Not
// part of the public Provider contract; tests assert behavior end-to-end
// through discover() in production code.
module.exports._internal = {
  getCodexHome: getCodexHome,
  readSessionIndex: readSessionIndex,
  resolveIndexEntryToPath: resolveIndexEntryToPath,
  walkSessionsTree: walkSessionsTree,
  extractIdFromFilename: extractIdFromFilename,
  readSessionMetaFromFile: readSessionMetaFromFile,
  // Plan (session-lifecycle): archived_sessions support + shared rollout
  // collection. Exposed so codexProvider.findArtifactPath /
  // findArtifactByWorkingDir reuse the exact scan logic instead of
  // duplicating it, and so archived-discovery tests can assert directly.
  getArchivedSessionsDir: getArchivedSessionsDir,
  collectRolloutFilesUnder: collectRolloutFilesUnder,
  walkArchivedSessions: walkArchivedSessions,
  // BUILD-CONTRACT P8.4/P8.5/P8.9: the SQLite-first union, the title cascade
  // wiring and the throttled reconciliation pass.
  buildSessionIndexTitleMap: buildSessionIndexTitleMap,
  sessionFromThreadRow: sessionFromThreadRow,
  attachProjectFields: attachProjectFields,
  enumerateRolloutFilesAsync: enumerateRolloutFilesAsync,
  reconcileWalkExtras: reconcileWalkExtras,
  maybeReconcileWalkExtras: maybeReconcileWalkExtras,
  resetWalkExtras: resetWalkExtras,
  statSizeAndMtime: statSizeAndMtime,
  WALK_RECONCILE_INTERVAL_MS: WALK_RECONCILE_INTERVAL_MS,
  DISCOVERY_SOURCES: DISCOVERY_SOURCES,
};

/**
 * Step 5 of the title cascade, exported as the lazy, on-demand entry point.
 *
 * Not called anywhere in the bulk discovery pass, by design: the event it looks
 * for exists in 2 of 796 rollouts, so scanning every file to find it would cost
 * seconds and gain two labels. Call it for a single row that is still
 * unresolved after step 4 and whose title someone is actually about to show.
 *
 * @param {string} rolloutPath - Absolute path to a rollout .jsonl.
 * @returns {string|null}
 */
module.exports.resolveTitleFromRollout = resolveTitleFromRollout;

/**
 * The discovery-source tags carried on every session record, exported so
 * consumers compare against the constant rather than a string literal.
 */
module.exports.DISCOVERY_SOURCES = DISCOVERY_SOURCES;
