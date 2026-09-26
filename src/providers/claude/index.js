/**
 * Claude Code Provider object.
 *
 * Implements the Provider contract defined in src/providers/index.js
 * (and mirrored in docs/PROVIDER-INTERFACE.md). Aggregates the discover,
 * parse, path-decode, and search modules into a single object the
 * registry can register and downstream code can call.
 *
 * Plan 14-03 (ABST-03) introduces this file. The spawnCommand below is
 * a PLACEHOLDER that throws; Plan 14-04 (PTY-03) replaces it with the
 * real flag-construction logic lifted from src/web/pty-manager.js. The
 * search method is a stub (Phase 16 territory). discover and
 * parseTranscript are minimum-viable implementations introduced in
 * Plan 14-03 to satisfy the contract surface (no Phase 14 route
 * consumes them yet).
 *
 * COST-04 wiring: costAdapter points at src/web/cost-worker.js. Plan
 * 14-03 added a `if (parentPort)` guard inside cost-worker.js so the
 * file is safe to require() from the main thread (the original code
 * unconditionally called `parentPort.on()` which crashes outside a
 * Worker context). Worker-thread behavior is unchanged.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/claude
 */

'use strict';

const discover = require('./discover');
const { parseTranscript, extractCustomTitle, extractSessionName } = require('./parse');
const { search } = require('./search');
const { findJsonlFile, findJsonlByWorkingDir } = require('./path-decode');
// Issue #10 Tier 1: per-line mirror parser (separate module; parseTranscript
// in ./parse is intentionally untouched per code-preservation rules).
const mirror = require('./mirror');

// COST-04: cost-worker is required (and module-cached) so the strict
// equality check in test/cost-worker-via-claude.test.js holds. The
// worker file is safe to require from the main thread (parentPort
// listener is now guarded).
const costAdapter = require('../../web/cost-worker');

/**
 * CLAUDE_IDLE_REGEX: derived from src/web/public/terminal.js
 * (_checkForCompletion, line ~1206) which uses the combined predicate:
 *   /[❯$>]\s*$/.test(lineText) || /^(Human:|Type.*message)/.test(lineText)
 *
 * The terminal.js detector reads the raw cursor row from the xterm.js
 * buffer and tests the trimmed text. Here we test a single line of input
 * directly; trimming is the caller's responsibility (or pty-manager's
 * scrollback inspector). The two regexes are kept literal so a future
 * Phase 19 update (Codex-specific detector + locale-aware prompts) can
 * diff against the existing surface.
 */
const CLAUDE_IDLE_PROMPT_RE = /[❯$>]\s*$/;
const CLAUDE_IDLE_HUMAN_RE = /^(Human:|Type.*message)/;

/**
 * Detect whether a line of terminal output looks like a Claude prompt.
 * Mirrors the predicate used by terminal.js _checkForCompletion to
 * keep frontend and backend idle detection in lockstep.
 *
 * @param {string} line - A single line of terminal text (already trimmed
 *   by the caller in most cases; we trim defensively to match terminal.js).
 * @returns {boolean} True when the line looks like a Claude idle prompt.
 */
function isIdleSignal(line) {
  if (line == null) return false;
  const text = String(line).trim();
  return CLAUDE_IDLE_PROMPT_RE.test(text) || CLAUDE_IDLE_HUMAN_RE.test(text);
}

/**
 * Per-provider key bindings.
 *
 * Claude Code's renderer is Ink-based: plain \r and \n are interpreted as
 * "submit the prompt", which means a naive Shift+Enter that sends \r would
 * submit instead of inserting a newline in the input. The Anthropic-
 * documented sequence for "newline in input" is ESC+CR (\x1b\r); that is
 * what /terminal-setup wires for Claude users and what terminal.js has
 * shipped to the PTY since v0.9.33.
 *
 * Plan 19-02 (PTY-05) reconciles this value with the live frontend behavior:
 * previously this function returned '\r' (incorrect for Ink), while
 * terminal.js sent '\x1b\r' hardcoded inline. The frontend now dispatches
 * through provider-specs.js which mirrors this value, and a parity test
 * (test/keybindings-dispatch.test.js) asserts agreement between this
 * function and the frontend spec.
 *
 * @returns {{shiftEnter:string}}
 */
function getKeyBindings() {
  return { shiftEnter: '\x1b\r' };
}

/**
 * supportsCost capability flag. Claude has token-priced JSONL transcripts
 * (the cost-worker reads `message.usage` fields per assistant turn), so
 * cost reporting is meaningful. Codex returns false in v1.2 because no
 * token usage shape is locked in yet.
 *
 * @returns {boolean}
 */
function supportsCost() {
  return true;
}

/**
 * supportsForkResume capability flag (issue #10 Tier 1). OPTIONAL Provider
 * member; NOT in the registry's REQUIRED_METHODS list. Claude Code supports
 * forking a conversation by resuming a session id into a new session
 * (claude --resume/--fork-session semantics), so the mirror UI may offer a
 * "fork from here" affordance for Claude sessions. Codex exports an explicit
 * false; callers probe uniformly via provider.supportsForkResume?.().
 *
 * @returns {boolean} Always true for Claude Code.
 */
function supportsForkResume() {
  return true;
}

/**
 * Provider lifecycle hook. Idempotent. Reserved for warming caches or
 * opening filesystem watchers; no-op in Phase 14 because discovery is
 * synchronous-on-demand and the existing watcher in pty-manager owns
 * the post-spawn JSONL watch.
 *
 * @returns {Promise<void>}
 */
async function init() { /* no-op */ }

/**
 * Provider lifecycle hook. Mirrors init: nothing to tear down in
 * Phase 14. Future watcher additions go here.
 *
 * @returns {Promise<void>}
 */
async function dispose() { /* no-op */ }

/**
 * Resolve the on-disk path of a Claude session's transcript artifact.
 * Wraps the findJsonlFile helper (lifted into ./path-decode.js by Plan 15-01).
 * codexProvider now exposes the SAME method shape (sync, absolute-path-or-null)
 * for its rollout-*.jsonl files under $CODEX_HOME/sessions/ and
 * archived_sessions/, which is why route handlers in src/web/server.js can
 * dispatch through provider.findArtifactPath uniformly via
 * getProviderForSession. NOTE: this parity was ASPIRATIONAL until the
 * session-lifecycle fix actually added the two methods to codexProvider; the
 * previous wording claimed parity that did not exist, which is why a
 * codex-tagged session 500'd GET /api/cost/batch.
 *
 * Plan 15-01 (DISC-03).
 *
 * @param {string} providerSessionId - Claude session UUID.
 * @returns {string|null} Absolute path to the .jsonl, or null if not found.
 */
function findArtifactPath(providerSessionId) {
  return findJsonlFile(providerSessionId);
}

/**
 * Resolve the on-disk path of a Claude transcript by matching a working
 * directory to a Claude project directory. Used as a fallback when
 * resumeSessionId is not set. Returns the most recent JSONL file path
 * along with its claudeSessionId.
 *
 * Plan 15-01 (DISC-03).
 *
 * @param {string} workingDir - The session's working directory.
 * @returns {{jsonlPath: string, claudeSessionId: string}|null}
 */
function findArtifactByWorkingDir(workingDir) {
  return findJsonlByWorkingDir(workingDir);
}

const { spawnCommand } = require('./spawn');
// 2026-09-26: live background/interactive session lookup (claude agents
// --json), used before a pane resumes a transcript so a live session is
// attached to instead of forked. The module resolves the data dir only on the
// first liveSessionLookup() call, so loading the provider stays side-effect free.
const liveSessions = require('./live-sessions');

/**
 * The process-wide live-session lookup (cached `claude agents --json`).
 * OPTIONAL Provider member, probed with typeof by pty-manager and the legacy
 * start/restart routes; providers without it (Codex, test fakes) keep the
 * plain resume path.
 *
 * @returns {ReturnType<typeof liveSessions.createLiveSessionLookup>}
 */
function liveSessionLookup() {
  return liveSessions.getDefaultLookup();
}

module.exports = {
  id: 'claude', // gsd:provider-literal-allowed
  displayName: 'Claude Code',
  accentToken: 'mauve',
  cliBinary: 'claude', // gsd:provider-literal-allowed
  discover: discover,
  parseTranscript: parseTranscript,
  spawnCommand: spawnCommand,
  search: search,
  init: init,
  dispose: dispose,
  supportsCost: supportsCost,
  isIdleSignal: isIdleSignal,
  getKeyBindings: getKeyBindings,
  costAdapter: costAdapter,
  // Issue #10 Tier 1: OPTIONAL mirror capability. mirror.parseLine maps one
  // raw transcript JSONL line to a MirrorMessage (or null); the session-
  // mirror wiring feeds it lines from src/web/jsonl-tailer.js. Optional
  // member: NOT added to REQUIRED_METHODS, so providers without a mirror
  // still validate.
  mirror: { parseLine: mirror.parseLine },
  // Issue #10 Tier 1: OPTIONAL capability flag; Claude supports forking via
  // session resume, so the mirror UI may offer "fork from here".
  supportsForkResume: supportsForkResume,
  // Plan 15-01 (DISC-03): transcript artifact path resolution.
  findArtifactPath: findArtifactPath,
  findArtifactByWorkingDir: findArtifactByWorkingDir,
  // 2026-09-26: OPTIONAL live-session lookup (attach instead of fork).
  liveSessionLookup: liveSessionLookup,
  // Re-exports for callers that previously imported from server.js
  extractCustomTitle: extractCustomTitle,
  extractSessionName: extractSessionName,
};
