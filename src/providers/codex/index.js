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
const { parseTranscript, parseLine } = require('./parse');
const { spawnCommand } = require('./spawn');
const { accountsCapability } = require('./accounts');
const { search } = require('./search');
// BUILD-CONTRACT P8.8: the read-only state store, used here purely as an O(1)
// index in front of the existing O(n) walk. Never throws; returns null when
// unavailable, at which point every call site below behaves exactly as before.
const stateDb = require('./state-db');

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
 * supportsCost capability flag. Codex returns false in v1.2 because no
 * token usage shape is locked in yet (the cost worker would emit
 * misleading $0 entries). Cost tracking is deferred to v1.3 (CROSS-COST-01).
 *
 * @returns {boolean}
 */
function supportsCost() {
  return false;
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
let _pollTimer = null;
let _debounceTimer = null;
let _onChange = null;
const DEBOUNCE_MS = 500;
const POLL_MS = 5 * 60 * 1000; // 5 minutes
const ROLLOUT_RE = /rollout-[a-f0-9-]+\.jsonl$/i;

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
 * Fire the registered onChange callback inside a try/catch so a thrower
 * does not crash the watcher.
 */
function _fire() {
  if (typeof _onChange !== 'function') return;
  try { _onChange(); }
  catch (err) { console.warn('[codex/watch] onChange threw: ' + err.message); }
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
  _pollTimer = setInterval(_fire, POLL_MS);
}

/**
 * Stop the watcher + fallback poll. Idempotent.
 */
function _stopWatcher() {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_watcher) { try { _watcher.close(); } catch (_) {} _watcher = null; }
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
  spawnCommand: spawnCommand,
  search: search,
  init: init,
  dispose: dispose,
  supportsCost: supportsCost,
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
};
