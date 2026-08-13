/**
 * ChatGPT Codex Provider object.
 *
 * Implements the Provider contract defined in src/providers/index.js
 * (and mirrored in docs/PROVIDER-INTERFACE.md). Aggregates the four
 * single-purpose modules (discover, parse, spawn, search) into a single
 * object the registry can register and downstream code can call.
 *
 * Phase 17 Plan 17-02 (CDX-05/06/07/10 wiring half). The discover and
 * parseTranscript implementations were shipped by Plan 17-01; spawn and
 * search are shipped by this plan. This file is the bind-it-all-together
 * step that makes register(codexProvider) work in src/providers/index.js.
 *
 * Capability flags:
 *   - supportsCost: false. Codex cost tracking is deferred to v1.3
 *     (CROSS-COST-01). No token usage shape is locked in yet; returning
 *     false prevents misleading $0 stubs from showing up in /api/cost.
 *   - isIdleSignal: defensive default until Phase 19 (Codex Live PTY)
 *     refines against real terminal output. The default detects both an
 *     explicit `codex>` prompt and the generic shell prompt shape Claude
 *     also uses (`[❯$>]\s*$`). False positives are acceptable here
 *     because the frontend idle detection only treats this as a hint;
 *     mis-classifying a non-idle line as idle just triggers an early
 *     check that proves the session is still active.
 *   - getKeyBindings: returns Claude's defaults ({shiftEnter:'\r'}).
 *     Phase 19 may diverge if Codex CLI handles Shift+Enter differently.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const discover = require('./discover');
const { parseTranscript, parseTranscriptDetailed, parseLine } = require('./parse');
const { spawnCommand } = require('./spawn');
const { accountsCapability } = require('./accounts');
const { search } = require('./search');
// BUILD-CONTRACT P8.8: the read-only state store, used here purely as an O(1)
// index in front of the existing O(n) walk. Never throws; returns null when
// unavailable, at which point every call site below behaves exactly as before.
const stateDb = require('./state-db');
// BUILD-CONTRACT P9.3: token accounting. Codex has usage but no price model, so
// this backs supportsTokenUsage + parseUsage while supportsCost stays false.
const usage = require('./usage');

// ---------------------------------------------------------------------------
// Idle signal detection
// ---------------------------------------------------------------------------

/**
 * Match an explicit `codex>` prompt. The trailing optional whitespace
 * tolerates terminal output that may pad the prompt with trailing spaces.
 * The literal `codex` is the Codex CLI prompt; this file is inside
 * src/providers/codex/ so the grep gate (Plan 14-05) ignores the literal,
 * but we mark it for future readers.
 */
const CODEX_PROMPT_RE = /^codex>\s*$/; // gsd:provider-literal-allowed

/**
 * Match a generic shell prompt shape. Mirrors the predicate Claude uses for
 * fallback idle detection. Covers POSIX `$` prompts, modern arrow `❯`
 * (oh-my-zsh, starship, etc.), and explicit `>` prompts that appear in
 * various REPLs.
 */
const GENERIC_PROMPT_RE = /[❯$>]\s*$/;

/**
 * Detect whether a line of terminal output looks like a Codex idle prompt.
 * Phase 19 will refine this regex against real Codex terminal output once
 * the live PTY pipeline is wired up; until then, the defensive default is
 * "any prompt-shaped line ending the buffer".
 *
 * @param {string} line - A single line of terminal text (caller may trim).
 * @returns {boolean} True when the line looks like a Codex idle prompt.
 */
function isIdleSignal(line) {
  if (line == null) return false;
  const text = String(line).trim();
  if (text.length === 0) return false;
  return CODEX_PROMPT_RE.test(text) || GENERIC_PROMPT_RE.test(text);
}

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------

/**
 * Per-provider key bindings. Codex behaves like Claude for Shift+Enter
 * (literal newline so multi-line prompts can be composed). Phase 19 may
 * diverge once we observe real Codex CLI key handling.
 *
 * @returns {{shiftEnter:string}}
 */
function getKeyBindings() {
  return { shiftEnter: '\r' };
}

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/**
 * supportsCost capability flag: does this provider report a MONEY figure.
 *
 * Still false, and BUILD-CONTRACT P9.3 asked for it to be flipped to true. The
 * deviation is deliberate and is recorded in DEVIATIONS.md; the reasoning:
 *
 *   - The contract's done criterion is "Codex cost is real, or honestly absent,
 *     never a false zero".
 *   - The frontend gates purely on this flag. `renderSessionItem` renders
 *     `$` + the cached cost when it is true, and the em-dash "not tracked"
 *     badge when it is false. Nothing downstream consults the cost route's own
 *     response to decide which to show.
 *   - Codex desktop bills against a ChatGPT plan. The rollouts carry
 *     `rate_limits.plan_type` and a credits block; they carry no price, and no
 *     per-token rate exists that could be applied without inventing one.
 *
 * So flipping this flag with no price model would have replaced the false
 * `$0.00` with a differently-false `$0.00`, which is the exact outcome the
 * criterion forbids. What P9.3 actually asked for underneath, real numbers or
 * an honest absence, is delivered by supportsTokenUsage + parseUsage below and
 * by the route gate that now reports `costSupported: false` with the real token
 * counts attached.
 *
 * Flip this the moment a price model exists. Nothing else needs to change.
 *
 * @returns {boolean} False: Codex has usage, not cost.
 */
function supportsCost() {
  return false;
}

/**
 * supportsTokenUsage capability flag: does this provider report TOKEN counts.
 *
 * BUILD-CONTRACT P9.3. OPTIONAL member, deliberately separate from
 * supportsCost, because "we know exactly how many tokens this session burned"
 * and "we know what it cost in money" are different claims and Codex can only
 * make the first one. A single flag conflated them, which is how a session with
 * 226 million tokens against it came to be displayed as `$0.00`.
 *
 * A provider that omits this member is treated as "unknown", so no existing
 * provider changes behaviour by not having it.
 *
 * @returns {boolean} True: see parseUsage.
 */
function supportsTokenUsage() {
  return true;
}

/**
 * supportsForkResume capability flag (issue #10 Tier 1). OPTIONAL Provider
 * member; NOT in the registry's REQUIRED_METHODS list. Codex CLI has no
 * fork-from-message / resume-at-checkpoint affordance, so this returns
 * false. The flag exists (rather than being absent) so callers can probe
 * every provider uniformly with provider.supportsForkResume?.() and treat
 * an explicit false and a missing member identically; explicit is clearer
 * for readers and greppers.
 *
 * @returns {boolean} Always false for Codex.
 */
function supportsForkResume() {
  return false;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks (no-ops in Phase 17)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Filesystem watcher (Plan 22-03)
// ---------------------------------------------------------------------------

let _watcher = null;
let _archivedWatcher = null;
let _pollTimer = null;
let _debounceTimer = null;
let _onChange = null;
const DEBOUNCE_MS = 500;
const POLL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Filename filter for the rollout watchers.
 *
 * BUILD-CONTRACT P9.5, and this is a LIVE BUG FIX rather than a widening.
 *
 * The previous pattern was `/rollout-[a-f0-9-]+\.jsonl$/i`, which requires
 * every character after `rollout-` to be a hex digit or a hyphen. A real Codex
 * filename is
 *
 *     rollout-2026-08-12T13-16-17-019ff6f9-8b5f-7fb1-acef-874b662c6bc8.jsonl
 *
 * and the `T` in the ISO timestamp is not in that class, so the pattern matched
 * NOTHING the desktop app has ever written. The watcher fired only for the
 * synthetic filenames in its own test; in production every rollout event was
 * discarded and the sidebar depended entirely on the 5-minute fallback poll.
 * That is why a new Codex session "took a few minutes to show up".
 *
 * The replacement matches any `rollout-*.jsonl` at the end of a path, which is
 * what the walk, discovery and search have always matched on, and still rejects
 * `session_index.jsonl`, `state_5.sqlite-wal` and everything else in the noisy
 * directory. The separator exclusion keeps it anchored to the basename, because
 * fs.watch on a recursive watch reports a RELATIVE PATH, not a name.
 */
const ROLLOUT_RE = /rollout-[^\\/]*\.jsonl$/i;

// ─── State-store polling (BUILD-CONTRACT P9.5, CODEX-PARITY B23) ───────────
//
// The rollout watcher above sees a file appear. It does NOT see the desktop app
// record a thread, archive one, rename one or move it between folders, because
// all of that happens inside `state_5.sqlite`, which is now the primary source
// of discovery. A thread created in the app was therefore invisible to the
// workbook until the 5-minute fallback poll happened to fire.
//
// It is a POLL, not an fs.watch, and that is the load-bearing decision.
// CODEX-PARITY D.6 measured why: CODEX_HOME churns constantly from WAL
// activity, `state_5.sqlite-wal` changed size unprompted during the
// investigation, and the P9 read-only proof harness watched two files change in
// six seconds with the workbook completely idle. An fs.watch on that directory
// fires continuously. Two cheap stat calls on an interval do not.
//
// Two separate numbers, because they answer two different questions:
//
//   POLL     how often to LOOK. Two stats, so it can be brisk.
//   MIN_FIRE how often to TELL ANYONE. Each fire clears the discover cache and
//            broadcasts SSE to every connected client, and the WAL mtime
//            advances whenever the app so much as breathes, so without this
//            floor an active Codex session would refresh every client every
//            15 seconds all day.
//
// A change observed during the cooldown is not dropped: it sets a pending flag
// and fires on the trailing edge, so the worst case is one refresh per
// MIN_FIRE window rather than a missed thread.
const STATE_DB_POLL_MS = Number(process.env.CWM_CODEX_STATE_DB_POLL_MS) > 0
  ? Number(process.env.CWM_CODEX_STATE_DB_POLL_MS)
  : 15 * 1000;
const STATE_DB_MIN_FIRE_MS = Number(process.env.CWM_CODEX_STATE_DB_MIN_FIRE_MS) > 0
  ? Number(process.env.CWM_CODEX_STATE_DB_MIN_FIRE_MS)
  : 30 * 1000;

let _stateDbTimer = null;
let _stateDbKey = null;
let _stateDbLastFire = 0;
let _stateDbPendingTimer = null;

/**
 * Resolve the Codex sessions directory from process.env at call time.
 * Mirrors the resolution discover.js does so the watcher and discover
 * always agree on what to watch / scan.
 *
 * @returns {string}
 */
function _sessionsDir() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

/**
 * Resolve the Codex archived-sessions directory from process.env at call time.
 *
 * BUILD-CONTRACT P9.5: the watcher covered `sessions/` only, so a thread the
 * desktop app archived, which MOVES its rollout out of `sessions/` and into
 * this flat directory, produced no event at all. Discovery and search have both
 * read this directory since the session-lifecycle work; the watcher had not
 * caught up.
 *
 * @returns {string}
 */
function _archivedSessionsDir() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'archived_sessions');
}

/**
 * Fire the registered onChange callback inside a try/catch so a thrower
 * does not crash the watcher.
 *
 * BUILD-CONTRACT P9.5: every fire, from every source, first drops the state
 * store's warm cache. The callback's whole purpose is to make a consumer
 * re-read, and a consumer that re-reads through a cache that still holds the
 * pre-change snapshot has been told to look and then shown the old picture.
 * The cache's own TTL is two seconds, so this is belt and braces rather than
 * the only mechanism, but the cost is a few map assignments.
 */
function _fire() {
  try { stateDb.invalidate(); }
  catch (_) { /* state-db is non-throwing; a broken contract must not stop the fire */ }
  if (typeof _onChange !== 'function') return;
  try { _onChange(); }
  catch (err) { console.warn('[codex/watch] onChange threw: ' + err.message); }
}

/**
 * Fire, but no more often than STATE_DB_MIN_FIRE_MS.
 *
 * A change seen during the cooldown is remembered and fired on the trailing
 * edge, so rate limiting delays a refresh and never drops one.
 *
 * @returns {void}
 */
function _fireRateLimited() {
  const now = Date.now();
  const sinceLast = now - _stateDbLastFire;
  if (sinceLast >= STATE_DB_MIN_FIRE_MS) {
    _stateDbLastFire = now;
    _fire();
    return;
  }
  if (_stateDbPendingTimer) return; // already scheduled for the trailing edge
  _stateDbPendingTimer = setTimeout(() => {
    _stateDbPendingTimer = null;
    _stateDbLastFire = Date.now();
    _fire();
  }, STATE_DB_MIN_FIRE_MS - sinceLast);
  // Do not hold the process open for a refresh notification.
  if (typeof _stateDbPendingTimer.unref === 'function') _stateDbPendingTimer.unref();
}

/**
 * One poll tick: compare the store's content key and fire when it moved.
 *
 * The key is `size:mtime` of `state_5.sqlite` plus the same for its `-wal`,
 * which is exactly the key the store's own cache uses, so the watcher and the
 * cache can never disagree about whether the database changed. Two stat calls,
 * no open, no read, no parse.
 *
 * @returns {void}
 */
function _pollStateDb() {
  let key = null;
  try {
    key = stateDb._internal.currentCacheKey();
  } catch (_) {
    return; // no database on this machine, or an unreadable one: nothing to do
  }
  if (key === null) return;
  if (_stateDbKey === null) {
    // First observation establishes the baseline. Firing here would mean one
    // spurious refresh on every server start.
    _stateDbKey = key;
    return;
  }
  if (key === _stateDbKey) return;
  _stateDbKey = key;
  _fireRateLimited();
}

/**
 * Start the rollout-file watcher + the 5-minute fallback poll. Idempotent:
 * a second call replaces the registered onChange but does not double-start
 * the watch handle. Exposed via init(onChange) for normal use and via
 * _startWatcherForTesting for unit tests.
 *
 * fs.watch on Windows is well-known to miss events on some filesystem
 * operations (atomic renames, network drives, paused notify queues). The
 * fallback poll catches anything the watch misses. Together they give
 * a "new Codex session shows up in the sidebar within ~1s" UX.
 *
 * @param {() => void} onChange - Callback fired after debounce / on poll.
 */
function _startWatcher(onChange) {
  _onChange = onChange;
  const sessionsDir = _sessionsDir();
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_watcher) { try { _watcher.close(); } catch (_) {} _watcher = null; }
  if (_archivedWatcher) { try { _archivedWatcher.close(); } catch (_) {} _archivedWatcher = null; }
  if (_stateDbTimer) { clearInterval(_stateDbTimer); _stateDbTimer = null; }
  if (_stateDbPendingTimer) { clearTimeout(_stateDbPendingTimer); _stateDbPendingTimer = null; }
  _stateDbKey = null;
  _stateDbLastFire = 0;
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  if (!fs.existsSync(sessionsDir)) {
    console.warn('[codex/watch] sessions dir missing: ' + sessionsDir + ' (poll fallback active)');
  } else {
    try {
      _watcher = fs.watch(sessionsDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (!ROLLOUT_RE.test(String(filename))) return;
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_fire, DEBOUNCE_MS);
      });
      _watcher.on('error', (err) => {
        console.warn('[codex/watch] watcher error: ' + err.message + ' (poll fallback active)');
      });
    } catch (err) {
      console.warn('[codex/watch] could not start watcher: ' + err.message);
    }
  }

  // BUILD-CONTRACT P9.5: archiving a thread MOVES its rollout from sessions/ to
  // archived_sessions/, which the watch above cannot see because the file is
  // gone from the tree it watches. Same debounce, same rollout-name filter, so
  // the two watches coalesce into one fire when a move produces both events.
  // Absent directory is the normal case on a machine that has never archived.
  const archivedDir = _archivedSessionsDir();
  if (fs.existsSync(archivedDir)) {
    try {
      _archivedWatcher = fs.watch(archivedDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (!ROLLOUT_RE.test(String(filename))) return;
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_fire, DEBOUNCE_MS);
      });
      _archivedWatcher.on('error', (err) => {
        console.warn('[codex/watch] archived watcher error: ' + err.message);
      });
    } catch (err) {
      console.warn('[codex/watch] could not watch archived_sessions: ' + err.message);
    }
  }

  // BUILD-CONTRACT P9.5: the state-store poll. Two stat calls per tick, rate
  // limited on the way out. See the constants above for why this is a poll and
  // not an fs.watch.
  _stateDbTimer = setInterval(_pollStateDb, STATE_DB_POLL_MS);
  if (typeof _stateDbTimer.unref === 'function') _stateDbTimer.unref();
  // Establish the baseline immediately so the first tick compares against the
  // state at startup rather than firing on it.
  _pollStateDb();

  _pollTimer = setInterval(_fire, POLL_MS);
}

/**
 * Stop the watcher + fallback poll. Idempotent.
 */
function _stopWatcher() {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_watcher) { try { _watcher.close(); } catch (_) {} _watcher = null; }
  // P9.5: the two additions get torn down in the same place, so a dispose still
  // leaves no timer and no handle behind.
  if (_archivedWatcher) { try { _archivedWatcher.close(); } catch (_) {} _archivedWatcher = null; }
  if (_stateDbTimer) { clearInterval(_stateDbTimer); _stateDbTimer = null; }
  if (_stateDbPendingTimer) { clearTimeout(_stateDbPendingTimer); _stateDbPendingTimer = null; }
  _stateDbKey = null;
  _stateDbLastFire = 0;
  _onChange = null;
}

/**
 * Provider lifecycle hook. Plan 22-03: optionally starts the watcher when
 * the registry passes an onChange callback. Plan 14 callers that pass no
 * arg still get the no-op behavior.
 *
 * @param {{onChange?: () => void}} [opts]
 * @returns {Promise<void>}
 */
async function init(opts) {
  if (opts && typeof opts.onChange === 'function') {
    _startWatcher(opts.onChange);
  }
}

/**
 * Provider lifecycle hook. Closes the watcher + fallback poll if active.
 *
 * @returns {Promise<void>}
 */
async function dispose() {
  _stopWatcher();
}

// ---------------------------------------------------------------------------
// Transcript artifact resolution (parity with claudeProvider)
// ---------------------------------------------------------------------------
//
// These two methods bring Codex to parity with claudeProvider.findArtifactPath
// / findArtifactByWorkingDir. Their absence caused a production 500: GET
// /api/cost/batch calls provider.findArtifactPath(resumeSessionId) for every
// session, and a codex-tagged store session threw
// "provider.findArtifactPath is not a function", 500ing the whole batch so
// cost badges broke for EVERY session (Claude included). Both are synchronous
// and null-on-miss to match the exact call signature the server route handlers
// use (they treat the result as a path string / null, not a Promise).
//
// The scan reuses discover.js's internal helpers so there is one source of
// truth for the on-disk layout (sessions/ date-bucketed + archived_sessions/
// flat). No duplicated walk logic.

const {
  getCodexHome: _discGetCodexHome,
  walkSessionsTree: _discWalkSessionsTree,
  walkArchivedSessions: _discWalkArchivedSessions,
  extractIdFromFilename: _discExtractId,
  readSessionMetaFromFile: _discReadMeta,
} = discover._internal;

/**
 * Enumerate every rollout file under sessions/ then archived_sessions/.
 * Ordering matters for findArtifactPath: a live thread is preferred over an
 * archived copy of the same id (sessions/ paths come first). Each sub-walk is
 * wrapped so one failing root never denies the other.
 *
 * @param {string} codexHome
 * @returns {string[]} Absolute rollout paths (sessions/ first, then archived).
 */
function _allRolloutFiles(codexHome) {
  const files = [];
  try { files.push.apply(files, _discWalkSessionsTree(codexHome)); } catch (_) { /* ignore */ }
  try { files.push.apply(files, _discWalkArchivedSessions(codexHome)); } catch (_) { /* ignore */ }
  return files;
}

/**
 * Locate the on-disk rollout transcript for a Codex session UUID.
 *
 * Scans BOTH $CODEX_HOME/sessions/ (date-bucketed) and
 * $CODEX_HOME/archived_sessions/ (flat) for a file whose filename embeds the
 * given UUID (rollout-<ISO>-<uuid>.jsonl). Sync + null-on-miss to match
 * claudeProvider.findArtifactPath exactly.
 *
 * @param {string} providerSessionId - Codex session UUID.
 * @returns {string|null} Absolute path to the rollout .jsonl, or null.
 */
function findArtifactPath(providerSessionId) {
  if (!providerSessionId || typeof providerSessionId !== 'string') return null;

  // BUILD-CONTRACT P8.8: ask the state store first. `threads.rollout_path` is a
  // direct absolute path, so this is an O(1) map lookup where the walk below is
  // O(n) over 2863 files, repeated once per session by /api/cost/batch.
  //
  // It also reaches transcripts the walk structurally cannot: two threads on
  // the measured machine have rollouts under `D:\CodexArchive`, and the walk
  // only ever looks under $CODEX_HOME.
  //
  // Synchronous by necessity: server route handlers call this without awaiting.
  // The synchronous form answers from the warm cache that discovery populates,
  // and returns null when the cache is cold, at which point the original walk
  // runs exactly as it always has. Never a new failure mode, only a fast path.
  try {
    const fromStore = stateDb.resolveRolloutPathSync(providerSessionId);
    if (fromStore) return fromStore;
  } catch (_) {
    // state-db is contractually non-throwing; the guard is here so that even a
    // broken contract costs the fast path rather than artifact resolution.
  }

  const codexHome = _discGetCodexHome();
  if (!fs.existsSync(codexHome)) return null;
  const target = providerSessionId.toLowerCase();
  const files = _allRolloutFiles(codexHome);
  for (const filePath of files) {
    const id = _discExtractId(path.basename(filePath));
    if (id === target) return filePath;
  }
  return null;
}

/**
 * Resolve the most-recent Codex rollout transcript whose recorded cwd matches
 * a working directory. Fallback used when a session has no resumeSessionId
 * yet (discovered/imported sessions).
 *
 * Mirrors claudeProvider.findArtifactByWorkingDir's return shape EXACTLY:
 * {jsonlPath, claudeSessionId}. The `claudeSessionId` key is the
 * cross-provider contract server.js reads (result.jsonlPath +
 * result.claudeSessionId) at the workingDir fallback and the backfill loop;
 * here it carries the Codex UUID, not a Claude-specific value. Renaming the
 * key would break the shared caller, so the legacy name is intentional.
 *
 * Reads each rollout's session_meta cwd (payload.cwd), normalizes for
 * case-insensitive comparison, and returns the newest match by mtime. Returns
 * null when nothing matches. Never throws.
 *
 * @param {string} workingDir - The session's working directory.
 * @returns {{jsonlPath: string, claudeSessionId: string}|null}
 */
function findArtifactByWorkingDir(workingDir) {
  if (!workingDir || typeof workingDir !== 'string') return null;

  // BUILD-CONTRACT P8.8: consult the state store's in-memory index first.
  //
  // The walk below does not merely enumerate files, it READS THE FIRST 256 KB
  // OF EVERY ONE of them to recover the cwd from session_meta: 2923 file opens
  // per call on the measured machine, and this function is a fallback that runs
  // whenever a workbook session has no recorded upstream id. Matching against
  // the census map costs one pass over 3006 in-memory entries.
  //
  // Matching is on the normalized, case-folded path, so a working directory
  // stored in one spelling still matches a thread the app recorded in the
  // other. An empty result also means "cache cold", so the original walk stays
  // exactly where it is and runs unchanged in that case.
  try {
    const candidates = stateDb.resolveThreadsByCwdSync(workingDir);
    let newest = null;
    for (const candidate of candidates) {
      if (!candidate.rolloutPath) continue;
      let mtimeMs;
      try {
        const stat = fs.statSync(candidate.rolloutPath);
        if (!stat.isFile()) continue;
        mtimeMs = stat.mtimeMs;
      } catch (_) {
        continue; // recorded but gone from disk
      }
      if (!newest || mtimeMs > newest.mtimeMs) {
        // `claudeSessionId` is the cross-provider key server.js reads. The
        // legacy name is load-bearing across the frontend and is deliberately
        // preserved here; it carries the Codex UUID, not a Claude value.
        newest = { jsonlPath: candidate.rolloutPath, claudeSessionId: candidate.id, mtimeMs: mtimeMs };
      }
    }
    if (newest) return { jsonlPath: newest.jsonlPath, claudeSessionId: newest.claudeSessionId };
  } catch (_) {
    // state-db is contractually non-throwing; the guard keeps a broken contract
    // from costing artifact resolution rather than just the fast path.
  }

  const codexHome = _discGetCodexHome();
  if (!fs.existsSync(codexHome)) return null;
  const normalizedWorkDir = workingDir.replace(/[/\\]/g, path.sep).replace(/[/\\]$/, '').toLowerCase();
  const files = _allRolloutFiles(codexHome);
  let best = null; // { jsonlPath, claudeSessionId, mtimeMs }
  for (const filePath of files) {
    const id = _discExtractId(path.basename(filePath));
    if (!id) continue;
    const meta = _discReadMeta(filePath);
    if (!meta || typeof meta.cwd !== 'string' || meta.cwd.length === 0) continue;
    const normalizedCwd = meta.cwd.replace(/[/\\]/g, path.sep).replace(/[/\\]$/, '').toLowerCase();
    if (normalizedCwd !== normalizedWorkDir) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) { continue; }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { jsonlPath: filePath, claudeSessionId: id, mtimeMs: mtimeMs };
    }
  }
  if (!best) return null;
  return { jsonlPath: best.jsonlPath, claudeSessionId: best.claudeSessionId };
}

// ---------------------------------------------------------------------------
// Provider object (the public contract)
// ---------------------------------------------------------------------------

module.exports = {
  id: 'codex',                      // gsd:provider-literal-allowed
  displayName: 'ChatGPT Codex',
  // Catppuccin green token. Architecture Section 7 reserved this slot for
  // Codex so the sidebar accent and tab strip stay distinct from Claude's
  // mauve. Phase 18 will wire the actual CSS variables.
  accentToken: 'green',
  cliBinary: 'codex',               // gsd:provider-literal-allowed
  discover: discover,
  parseTranscript: parseTranscript,
  // BUILD-CONTRACT P9.2: OPTIONAL member. Same parse, plus the counters that
  // say what it did NOT emit. NOT added to REQUIRED_METHODS, so a provider
  // without one still validates; callers probe with
  // `typeof provider.parseTranscriptDetailed === 'function'`.
  //
  // Exists because a message list cannot express "43 percent of this file was
  // an unrecognised shape and was dropped", which is precisely what was
  // happening, silently, before P9.1. `stats.unknown > 0` is the drift signal.
  parseTranscriptDetailed: parseTranscriptDetailed,
  spawnCommand: spawnCommand,
  search: search,
  init: init,
  dispose: dispose,
  supportsCost: supportsCost,
  // BUILD-CONTRACT P9.3: OPTIONAL capability pair. supportsTokenUsage says the
  // provider can report token counts even though it cannot report money;
  // parseUsage produces them. NOT in REQUIRED_METHODS, so providers without
  // token accounting still validate, and callers probe both defensively.
  supportsTokenUsage: supportsTokenUsage,
  parseUsage: usage.parseUsage,
  totalTokensSync: usage.totalTokensSync,
  COST_UNAVAILABLE: usage.COST_UNAVAILABLE,
  isIdleSignal: isIdleSignal,
  getKeyBindings: getKeyBindings,
  // Issue #10 Tier 1: OPTIONAL mirror capability. mirror.parseLine maps one
  // raw rollout JSONL line to a MirrorMessage (or null); the session-mirror
  // wiring feeds it lines from src/web/jsonl-tailer.js. Optional member:
  // NOT added to REQUIRED_METHODS, so providers without a mirror still
  // validate.
  mirror: { parseLine: parseLine },
  // Account switcher: OPTIONAL capability consumed by the generic
  // src/web/provider-account-manager.js (design doc
  // 2026-07-03-codex-account-switcher-design.md). Mirrors the optional
  // `mirror` member pattern above: NOT added to REQUIRED_METHODS, so
  // providers without account switching still validate.
  accounts: accountsCapability,
  // Issue #10 Tier 1: OPTIONAL capability flag; false because Codex has no
  // fork/resume affordance (see the function's JSDoc for why an explicit
  // false is exported instead of omitting the member).
  supportsForkResume: supportsForkResume,
  // Transcript artifact resolution: parity with claudeProvider so
  // server.js route handlers (cost batch, cost single, backfill) dispatch
  // through provider.findArtifactPath / findArtifactByWorkingDir uniformly.
  findArtifactPath: findArtifactPath,
  findArtifactByWorkingDir: findArtifactByWorkingDir,
  // BUILD-CONTRACT P8.2/P8.8: OPTIONAL capability exposing the read-only state
  // store. NOT added to REQUIRED_METHODS, so providers without one still
  // validate. Consumers must treat every member as returning null when the
  // desktop app has never run on this machine.
  stateDb: stateDb,
  // Test-only: lets the watcher test set its own onChange without
  // going through the registry. Production code must use init().
  _startWatcherForTesting: _startWatcher,
  _stopWatcherForTesting: _stopWatcher,
  // BUILD-CONTRACT P9.5 test surface: the state-store poll tick and its two
  // intervals, exposed so a test can drive the tick directly instead of waiting
  // fifteen seconds for a timer.
  _pollStateDbForTesting: _pollStateDb,
  _watcherConstants: {
    DEBOUNCE_MS: DEBOUNCE_MS,
    POLL_MS: POLL_MS,
    STATE_DB_POLL_MS: STATE_DB_POLL_MS,
    STATE_DB_MIN_FIRE_MS: STATE_DB_MIN_FIRE_MS,
  },
};
