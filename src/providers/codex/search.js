/**
 * Codex search adapter.
 *
 * Phase 17 Plan 17-02 (CDX-05 search half, CDX-06).
 *
 * Mirrors src/providers/claude/search.js structurally. Walks the cached
 * list of $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl files,
 * JSON-parses each line, applies the envelope-aware skip set, extracts
 * text from response_item.message content arrays, and builds approximately
 * +/-100 char snippets around the first match in each matching line. Result
 * records carry provider: 'codex' so the dispatcher in src/web/server.js
 * (GET /api/search) can ship a merged ranked list without re-tagging.
 *
 * Differences from claude/search.js (intentional, narrow):
 *
 *   1. File list source: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
 *      instead of ~/.claude/projects/<encoded>/<uuid>.jsonl. The cache key
 *      is the resolved $CODEX_HOME path; if a caller mutates the env
 *      between calls, the cache invalidates automatically.
 *
 *   2. Envelope-aware skip set: session_meta, turn_context, compacted,
 *      event_msg are skipped entirely (CDX-05 search half). Only
 *      response_item.message lines contribute to the searchable text.
 *
 *   3. Content extraction: walks response_item.payload.content[] for
 *      input_text and output_text parts; joins them before snippet
 *      computation. Mirrors parse.js extractMessageText so the same byte
 *      sequence the parser would emit is the byte sequence we search.
 *
 *   4. Title resolution: lazy. On first match per file, scan the in-memory
 *      file body for the latest event_msg.thread_name_updated.thread_name
 *      and use it; if none, fall back to providerSessionId. The result is
 *      cached on the fileInfo descriptor so subsequent matches in the
 *      same file reuse it (one walk per file at worst).
 *
 * Behavior contract (consumed by src/web/server.js GET /api/search via
 * Plan 16-01's Promise.allSettled dispatcher):
 *
 *   - Returns {results, timedOut, searchedFiles}; results is ALWAYS an array.
 *   - timedOut is true when Date.now() - startTime > timeBudgetMs at any
 *     in-loop checkpoint and the loop broke early.
 *   - searchedFiles is the count of files inspected (diagnostic).
 *   - Each result record carries provider: 'codex' (gsd:provider-literal-allowed).
 *   - Snippet shape: +/-100 chars around the match, whitespace-normalized
 *     (CR/LF collapsed to single spaces, runs of whitespace collapsed),
 *     ellipsis prepended/appended on truncation. Same as claude/search.js.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/search
 */

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

// BUILD-CONTRACT P9.4: the title cascade. Search used to label a result with
// whatever `thread_name_updated` event it could find inside the file, an event
// that exists in 2 of 796 rollouts, and fall back to a raw UUID for the other
// 794. The store and the session index between them carry a title for most
// threads, and P8 already built the cascade that resolves one; this module just
// has to ask.
//
// No require cycle: state-db pulls in ./paths only, and discover pulls in
// parse's _internal. Nothing under providers/codex requires search except the
// provider barrel.
const stateDb = require('./state-db');
const discover = require('./discover');

// ─── Blocking-read guards (2026-07-02, mirrors claude/search.js) ─────────
// Rollouts are usually small, but the same failure class applies: a sync
// whole-file read blocks the event loop so neither the in-loop budget check
// nor the dispatcher's race timer can fire. Oversized files are tail-read
// (JSONL is append-only, recent content lives at the end); all reads are
// async so I/O never blocks timers.
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024;  // full-read cap per file
const HUGE_FILE_TAIL_BYTES = 2 * 1024 * 1024;   // tail window for oversized files

/**
 * Read the last `tailBytes` of a file asynchronously and drop the first
 * (almost certainly partial) line so the caller only sees whole JSONL lines.
 * Duplicated from claude/search.js intentionally: providers stay isolated.
 *
 * @param {string} filePath  - Absolute file path.
 * @param {number} fileSize  - Size in bytes from a fresh stat.
 * @param {number} tailBytes - Window size to read from the end.
 * @returns {Promise<string>} UTF-8 text of the tail window, whole lines only.
 */
async function readFileTail(filePath, fileSize, tailBytes) {
  const start = Math.max(0, fileSize - tailBytes);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(tailBytes, fileSize));
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Module-scoped file-list cache. Mirrors claude/search.js's cache pattern.
// The cache invalidates when the resolved $CODEX_HOME path differs from the
// cached key, which handles the test-time env-mutation pattern naturally.
// ---------------------------------------------------------------------------

let _codexSearchFileCache = null;
let _codexSearchFileCacheTime = 0;
let _codexSearchFileCacheRoot = null;
const CODEX_SEARCH_FILE_CACHE_TTL = 30000; // 30 seconds; same as Claude.

/**
 * Resolve $CODEX_HOME at call time (NOT module load) so a user can change
 * the env var between calls. Falls back to ~/.codex when unset. Honored
 * strictly: if CODEX_HOME points at a non-existent path, search returns []
 * rather than silently falling back to the default.
 *
 * @returns {string} Absolute path to the Codex home directory.
 */
function getCodexHome() {
  // gsd:provider-literal-allowed (default Codex home directory name)
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Build (or return cached) list of all rollout JSONL files under
 * $CODEX_HOME/sessions/. 30s TTL. The cache key is the resolved $CODEX_HOME
 * path; a change to the resolved path invalidates the cache immediately
 * (handles test-time env mutation between calls).
 *
 * Returns descriptors carrying enough resolved per-file metadata that the
 * inner search loop can run without re-reading directories:
 *   - filePath: absolute path to the rollout file
 *   - sessionId: providerSessionId extracted from the filename (or null
 *     when the filename does not match the canonical id-suffix pattern)
 *   - mtimeMs: file modification time (used for ordering when relevant)
 *
 * The sessionName, projectName, projectPath fields are resolved lazily on
 * first match per file (inside search()), not here, to avoid reading every
 * file's head when no query matches it.
 *
 * @returns {Array<{filePath: string, sessionId: string|null, mtimeMs: number}>}
 */
function getSearchableFiles() {
  const codexHome = getCodexHome();
  const now = Date.now();
  if (
    _codexSearchFileCacheRoot === codexHome &&
    _codexSearchFileCache &&
    now - _codexSearchFileCacheTime < CODEX_SEARCH_FILE_CACHE_TTL
  ) {
    return _codexSearchFileCache;
  }

  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    _codexSearchFileCache = [];
    _codexSearchFileCacheTime = now;
    _codexSearchFileCacheRoot = codexHome;
    return _codexSearchFileCache;
  }

  const files = [];
  try {
    // Manual three-level YYYY/MM/DD walk. Mirrors discover.js's
    // walkSessionsTreeManual exactly so the same disk layout assumptions
    // hold. We could use fs.readdirSync(..., {recursive: true}) here for
    // a small wall-clock win, but the manual walk works on every Node 18+
    // build without depending on the recursive option.
    let years;
    try {
      years = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch (_) {
      years = [];
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
          let dayFiles;
          try {
            dayFiles = fs.readdirSync(dayDir);
          } catch (_) {
            continue;
          }
          for (const f of dayFiles) {
            const lower = f.toLowerCase();
            if (!lower.startsWith('rollout-') || !lower.endsWith('.jsonl')) continue;
            const filePath = path.join(dayDir, f);
            // Extract the UUID-shaped sessionId suffix from the filename
            // when present. Matches the canonical Codex rollout filename
            // pattern: rollout-<ISO>-<UUID>.jsonl.
            const idMatch =
              /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
                f
              );
            const sessionId = idMatch ? idMatch[1].toLowerCase() : null;
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch (_) { /* keep 0 */ }
            files.push({
              filePath: filePath,
              sessionId: sessionId,
              mtimeMs: mtimeMs,
              archived: false,
            });
          }
        }
      }
    }
  } catch (_) {
    // Top-level walk failed; cache empty list so we do not hammer the FS.
  }

  // Archived sessions: $CODEX_HOME/archived_sessions/ holds ended threads as
  // flat rollout-*.jsonl files (same envelope format). They are invisible to
  // the sessions/ walk above, so content search would silently miss them. We
  // scan them here (guarded by existsSync) and tag each descriptor
  // archived: true so results carry the flag through to the frontend.
  try {
    const archivedRoot = path.join(codexHome, 'archived_sessions');
    if (fs.existsSync(archivedRoot)) {
      // Recursive readdir handles both the flat layout and any nested
      // date-bucketing; a corrupt/unreadable root just yields nothing.
      let archEntries = [];
      try {
        archEntries = fs.readdirSync(archivedRoot, { recursive: true, withFileTypes: true });
      } catch (_) {
        // Older Node / rejected recursive option: fall back to a flat readdir.
        try {
          for (const name of fs.readdirSync(archivedRoot)) {
            archEntries.push({ name: name, isFile: () => true, parentPath: archivedRoot });
          }
        } catch (_) { archEntries = []; }
      }
      for (const e of archEntries) {
        if (typeof e.isFile === 'function' && !e.isFile()) continue;
        const lower = e.name.toLowerCase();
        if (!lower.startsWith('rollout-') || !lower.endsWith('.jsonl')) continue;
        const parent = e.parentPath || e.path || archivedRoot;
        const filePath = path.join(parent, e.name);
        const idMatch =
          /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
            e.name
          );
        const sessionId = idMatch ? idMatch[1].toLowerCase() : null;
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) { /* keep 0 */ }
        files.push({
          filePath: filePath,
          sessionId: sessionId,
          mtimeMs: mtimeMs,
          archived: true,
        });
      }
    }
  } catch (_) {
    // Archived scan is best-effort; a failure never blocks live-session search.
  }

  // Order newest-first so the time-budget self-check serves the most-recent
  // sessions first when callers care more about recent context than old.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  _codexSearchFileCache = files;
  _codexSearchFileCacheTime = now;
  _codexSearchFileCacheRoot = codexHome;
  return files;
}

// ---------------------------------------------------------------------------
// Title and project index (BUILD-CONTRACT P9.4)
// ---------------------------------------------------------------------------

/**
 * Cached title/cwd index, keyed by the resolved CODEX_HOME so a test that
 * mutates the env invalidates it exactly the way the file-list cache does.
 */
let _titleIndex = null;
let _titleIndexTime = 0;
let _titleIndexRoot = null;

/**
 * Same TTL as the file-list cache. A search is a burst of work against a
 * snapshot of the disk; both caches should age at the same rate or the labels
 * and the files they label can disagree.
 */
const TITLE_INDEX_TTL = CODEX_SEARCH_FILE_CACHE_TTL;

/**
 * Build (or return cached) `threadId -> {title, projectPath}`.
 *
 * BUILD-CONTRACT P9.4 / CODEX-PARITY B9. Measured coverage of the sources, over
 * the 125-thread visible set:
 *
 *   local_thread_catalog.display_title        1 row
 *   threads.name                              0 rows
 *   session_index.jsonl thread_name          55 of 125
 *   event_msg.thread_name_updated             2 of 796 FILES
 *   threads.preview (truncated)             all 125
 *
 * Search previously used ONLY the fourth of those, and fell back to printing a
 * raw UUID. So 794 of 796 files were labelled with a UUID in the results list.
 * The cascade resolves the first four in memory and truncates the preview when
 * nothing better exists, which is the same label the sidebar shows, so a search
 * hit and a sidebar row finally name the same session the same way.
 *
 * Degrades to an empty map on any failure, at which point every call site falls
 * back to exactly what it did before.
 *
 * Built ONCE per search, before the file loop, so the per-match path stays a
 * map lookup and the whole index costs one database read rather than one per
 * matching file.
 *
 * @returns {Promise<Map<string, {title: (string|null), projectPath: (string|null)}>>}
 */
async function getTitleIndex() {
  const codexHome = getCodexHome();
  const now = Date.now();
  if (
    _titleIndexRoot === codexHome &&
    _titleIndex &&
    now - _titleIndexTime < TITLE_INDEX_TTL
  ) {
    return _titleIndex;
  }

  const index = new Map();
  try {
    // Every thread, not the visible projection: a search can match inside an
    // archived thread or a spawn child, and a result the user can see deserves
    // a label whatever the sidebar decided about it.
    let threads = null;
    try {
      threads = await stateDb.listThreads({
        includeArchived: true,
        includeSpawnChildren: true,
        includeHidden: true,
      });
    } catch (_) {
      threads = null; // state-db is non-throwing; the guard is belt and braces
    }

    let indexTitles = new Map();
    try {
      indexTitles = discover._internal.buildSessionIndexTitleMap();
    } catch (_) {
      indexTitles = new Map();
    }

    if (Array.isArray(threads)) {
      for (const t of threads) {
        if (!t || typeof t.id !== 'string') continue;
        const parts = Object.assign({}, t.titleParts || {}, {
          indexTitle: indexTitles.get(t.id) || null,
        });
        let resolved = null;
        try {
          resolved = stateDb.resolveTitle(parts);
        } catch (_) {
          resolved = null;
        }
        index.set(t.id, {
          title: resolved && resolved.title ? resolved.title : null,
          projectPath: t.cwd || null,
        });
      }
    }

    // Threads the store never saw, or a cold cache: the session index alone
    // still labels a good share of them.
    for (const [id, title] of indexTitles) {
      if (index.has(id)) continue;
      index.set(id, { title: title, projectPath: null });
    }
  } catch (_) {
    // Never throws; an empty index means every caller falls back.
  }

  _titleIndex = index;
  _titleIndexTime = now;
  _titleIndexRoot = codexHome;
  return index;
}

/**
 * Extract the joined text from a response_item.message content array.
 * Codex content parts have type in {input_text, output_text}; other parts
 * (image, tool result, etc.) are filtered out. Mirrors parse.js exactly so
 * the same byte sequence the parser would emit is the byte sequence we
 * search.
 *
 * @param {Array} content - response_item.message.content array
 * @returns {string} Joined text, possibly empty when no input/output parts exist
 */
function extractMessageText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (
      c &&
      typeof c === 'object' &&
      (c.type === 'input_text' || c.type === 'output_text') &&
      typeof c.text === 'string'
    ) {
      out += c.text;
    }
  }
  return out;
}

/**
 * Find the latest thread_name from event_msg.thread_name_updated lines in
 * a pre-parsed list of envelopes. Returns null when no name was ever set.
 *
 * Walks once forward (newest line wins because event_msg.thread_name_updated
 * is append-only). Used lazily on first match per file so we don't pay the
 * cost on files that produced no matches.
 *
 * @param {string[]} lines - raw file body split on '\n'
 * @returns {string|null}
 */
function findLatestThreadName(lines) {
  let latest = null;
  for (const line of lines) {
    if (!line) continue;
    // Cheap pre-check before JSON.parse; thread_name_updated is rare.
    if (line.indexOf('thread_name_updated') === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!parsed || parsed.type !== 'event_msg') continue;
    const payload = parsed.payload;
    if (!payload || payload.type !== 'thread_name_updated') continue;
    if (typeof payload.thread_name === 'string' && payload.thread_name.length > 0) {
      latest = payload.thread_name;
    }
  }
  return latest;
}

/**
 * Read the cwd from a file's session_meta line (line 1). Returns null on
 * any failure. Walks every line in the buffer so a corrupt first line does
 * not lose the cwd entirely (rare; the canonical first line is the
 * session_meta envelope but the parser tolerates mixed-order files).
 *
 * @param {string[]} lines - raw file body split on '\n'
 * @returns {string|null}
 */
function findCwd(lines) {
  for (const line of lines) {
    if (!line) continue;
    if (line.indexOf('session_meta') === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!parsed || parsed.type !== 'session_meta') continue;
    const payload = parsed.payload;
    if (payload && typeof payload.cwd === 'string') return payload.cwd;
  }
  return null;
}

/**
 * Search Codex transcripts for matches against a query.
 *
 * Self-checks Date.now() - startTime > timeBudgetMs at the SAME two
 * checkpoints as claude/search.js (top of outer file-loop AND inside the
 * inner line loop) so the early-termination behavior is identical. The
 * dispatcher in server.js wraps this call in a Promise.race against a hard
 * timeBudgetMs + grace timer as a second-line defense; this function's own
 * self-check is the primary mechanism.
 *
 * Defensive validation: identical to claude/search.js (empty/short query
 * returns empty result; invalid timeBudgetMs returns empty result). The
 * function MUST NOT throw on bad inputs.
 *
 * @param {Object} args
 * @param {string} args.query        - Free-text query; case-insensitive substring match. Returns empty on < 2 chars.
 * @param {number} args.limit        - Max number of result records to collect (1..200).
 * @param {number} args.timeBudgetMs - Per-call wall-clock budget; loop breaks when exceeded.
 * @returns {Promise<{results: Array, timedOut: boolean, searchedFiles: number}>}
 */
async function search({ query, limit, timeBudgetMs } = {}) {
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return { results: [], timedOut: false, searchedFiles: 0 };
  }
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) {
    return { results: [], timedOut: false, searchedFiles: 0 };
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

  const searchQuery = query.trim().toLowerCase();
  const startTime = Date.now();
  const files = getSearchableFiles();
  // BUILD-CONTRACT P9.4: resolve the label index ONCE, before the loop, so a
  // result carries the title the user recognises instead of a UUID. Cached with
  // the same TTL as the file list, so a burst of searches costs one read.
  const titleIndex = await getTitleIndex();
  const results = [];
  let searchedFiles = 0;
  let timedOut = false;

  for (const fileInfo of files) {
    if (Date.now() - startTime > timeBudgetMs) {
      timedOut = true;
      break;
    }
    searchedFiles++;

    let content;
    try {
      // Stat first so oversized rollouts get a tail-window read instead of a
      // whole-file read (see blocking-read guards at the top of this module).
      const st = await fsp.stat(fileInfo.filePath);
      if (st.size > MAX_SEARCH_FILE_BYTES) {
        content = await readFileTail(fileInfo.filePath, st.size, HUGE_FILE_TAIL_BYTES);
      } else {
        content = await fsp.readFile(fileInfo.filePath, 'utf-8');
      }
    } catch (_) {
      continue; // unreadable; skip
    }

    // Yield between files so the dispatcher's hard-timeout race timer can
    // fire even during long scans.
    await new Promise((resolve) => setImmediate(resolve));

    const lines = content.split('\n');
    // Lazy-computed per-file metadata; resolved on first match in this file.
    let sessionName = null;
    let projectPath = null;
    let projectName = null;
    let lazyResolved = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (Date.now() - startTime > timeBudgetMs) {
        timedOut = true;
        break;
      }
      const line = lines[lineIdx];
      if (!line) continue;

      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (_) {
        continue; // corrupt line; skip silently
      }
      if (!envelope || typeof envelope !== 'object') continue;

      // Envelope-aware skip set (CDX-05 search half).
      // We skip session_meta (file header), turn_context (per-turn config
      // metadata), compacted (the placeholder text would generate
      // false-positive matches), and event_msg entirely (response_item
      // mirrors the same content with richer structure, and the lifecycle
      // event subtypes carry no searchable user content).
      if (envelope.type === 'session_meta') continue;
      if (envelope.type === 'turn_context') continue;
      if (envelope.type === 'compacted') continue;
      if (envelope.type === 'event_msg') continue;
      if (envelope.type !== 'response_item') continue;

      const payload = envelope.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (payload.type !== 'message') continue;

      const role = payload.role;
      // Match the parser's emit set: developer/system messages are skipped
      // from search because they are usually permission instructions, not
      // user-authored content. user and assistant content is searchable.
      if (role !== 'user' && role !== 'assistant') continue;

      const text = extractMessageText(payload.content);
      if (!text) continue;

      const lowerText = text.toLowerCase();
      const matchIndex = lowerText.indexOf(searchQuery);
      if (matchIndex === -1) continue;

      if (results.length < safeLimit) {
        if (!lazyResolved) {
          // BUILD-CONTRACT P9.4: the cascade first, the file scan second.
          //
          // The old order was the file scan and then a raw UUID, which is what
          // 794 of 796 results were labelled with, because the
          // `thread_name_updated` event the scan looks for exists in 2 files.
          // The index resolves catalog title, user rename, session_index title
          // and truncated preview from memory; the scan stays as the fallback
          // for a thread the store has never recorded, which is the one case it
          // can still win.
          const indexed = fileInfo.sessionId ? titleIndex.get(fileInfo.sessionId) : null;
          sessionName = indexed && indexed.title ? indexed.title : null;
          if (!sessionName) {
            try {
              sessionName = findLatestThreadName(lines);
            } catch (_) { sessionName = null; }
          }
          if (!sessionName) {
            sessionName = fileInfo.sessionId || null;
          }
          // The store's cwd is normalised (the `\\?\` prefix stripped), which
          // the raw session_meta value is not, so preferring it also fixes the
          // duplicate-folder split for search results.
          projectPath = indexed && indexed.projectPath ? indexed.projectPath : null;
          if (!projectPath) {
            try {
              projectPath = findCwd(lines);
            } catch (_) { projectPath = null; }
          }
          projectName = projectPath ? path.basename(projectPath) : null;
          lazyResolved = true;
        }

        // Build ~200 char snippet around the match (radius 100 each side).
        // Whitespace-normalization mirrors claude/search.js byte-for-byte.
        const snippetRadius = 100;
        const snippetStart = Math.max(0, matchIndex - snippetRadius);
        const snippetEnd = Math.min(text.length, matchIndex + searchQuery.length + snippetRadius);
        let snippet = text
          .substring(snippetStart, snippetEnd)
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (snippetStart > 0) snippet = '...' + snippet;
        if (snippetEnd < text.length) snippet = snippet + '...';

        results.push({
          provider: 'codex', // gsd:provider-literal-allowed (provider tags its own results)
          sessionId: fileInfo.sessionId,
          sessionName: sessionName,
          projectPath: projectPath,
          projectName: projectName,
          timestamp: typeof envelope.timestamp === 'string' ? envelope.timestamp : null,
          role: role,
          snippet: snippet,
          lineNumber: lineIdx + 1, // 1-based to match Claude's wire format
          // Carry the archived flag so the UI can distinguish results that
          // came from $CODEX_HOME/archived_sessions/ (ended threads).
          archived: fileInfo.archived === true,
        });
      }
    }

    if (timedOut) break;
  }

  return { results: results, timedOut: timedOut, searchedFiles: searchedFiles };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  search: search,
  // Test introspection surface (mirrors parse.js _internal pattern). Tests
  // assert behavior end-to-end through search() in production code, but the
  // internal helpers are exposed here so an isolated unit test of the cache
  // invalidation logic remains feasible without spying on fs.
  _internal: {
    getCodexHome: getCodexHome,
    getSearchableFiles: getSearchableFiles,
    extractMessageText: extractMessageText,
    findLatestThreadName: findLatestThreadName,
    findCwd: findCwd,
    // BUILD-CONTRACT P9.4: the label index, exposed so a test can assert the
    // cascade directly rather than inferring it from a result row.
    getTitleIndex: getTitleIndex,
    /** Reset the file-list cache; used by tests to force a re-walk. */
    _resetCache: function () {
      _codexSearchFileCache = null;
      _codexSearchFileCacheTime = 0;
      _codexSearchFileCacheRoot = null;
      _titleIndex = null;
      _titleIndexTime = 0;
      _titleIndexRoot = null;
    },
  },
};
