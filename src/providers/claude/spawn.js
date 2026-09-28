/**
 * Claude provider spawn descriptor builder.
 *
 * MOVED from src/web/pty-manager.js lines 293-335 (the inline Claude flag
 * construction block) in Plan 14-04. This file is the single source of truth
 * for how the Claude CLI is invoked. The function is PURE: no file I/O, no
 * child_process, no node-pty, no environment lookup. The caller (pty-manager
 * in production, the test spy in unit tests) takes the returned
 * SpawnDescriptor and runs it.
 *
 * NOTE on args[] semantics: pty-manager joins these tokens with spaces and
 * runs the joined string through the platform shell (cmd.exe /c on Windows,
 * /bin/sh -c elsewhere). Tokens MAY contain shell-quoted substrings; this
 * function passes validated model tokens bare and single-quotes initialPrompt so
 * the shell parses them as a single argument with shell-special characters
 * intact. A future phase may switch pty-manager to argv-style spawn (no
 * shell wrap), at which point this function will need to drop the explicit
 * quoting. Until then, the canonical contract is: shell-quoted tokens that
 * round-trip through `bash -c "<joined>"` and `cmd.exe /c "<joined>"`.
 *
 * Validation invariants preserved verbatim from pty-manager.js (so any
 * input that historically passed the SHELL_UNSAFE gate still passes here):
 *   - model regex /^[a-zA-Z0-9._:-]+$/      (was pty-manager.js:288)
 *   - providerSessionId regex /^[a-zA-Z0-9_-]+$/  (was pty-manager.js:284)
 *   - flags regex /^[a-zA-Z0-9-]+$/         (was pty-manager.js:325)
 *
 * The prompt single-quote escape pattern from pty-manager.js is preserved.
 * Model tokens need no quoting under their validation rule, and cmd.exe
 * would pass single quotes through as literal characters in the model id.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/claude/spawn
 */

'use strict';

// ─── Mobile v2 (BUILD-CONTRACT S10): effort, permission mode, extra args ────
//
// The phone's session settings (PROTOCOL.md 4.5.3) reach this descriptor as
// `effort` and `permissionMode`. Both are closed enums, so an unknown value
// is dropped with a warning, the same way the flag filter below drops a
// malformed flag, and nothing a person typed can reach the command line.
//
// Evidence, the help output of the installed Claude Code 2.1.283:
// the effort option lists low, medium, high, xhigh, max;
// the permission mode option lists acceptEdits, auto,
// bypassPermissions, manual, dontAsk, plan. There is no "default" choice in
// that build, so the phone's "default" ("Ask before changes") is emitted as
// the CLI's "manual", and "bypassPermissions" keeps using the existing
// dangerously-skip-permissions path so old records behave as before.

/** Effort values the settings schema offers (PROTOCOL.md 4.5.3). */
const CLAUDE_EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
/** Permission modes the settings schema offers (PROTOCOL.md 4.5.3). */
const CLAUDE_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
/** Schema value to the CLI's own spelling where they differ (2.1.283 help). */
const CLI_PERMISSION_MODE = Object.freeze({ default: 'manual' });
/**
 * Flags an in process caller may pass through argsExtra (B3's migration
 * launch, BUILD-CONTRACT 3.4.3 createSession). Never fed from an HTTP body.
 */
const ARGS_EXTRA_FLAGS = Object.freeze(['--append-system-prompt-file', '--add-dir', '--resume', '--fork-session']);
/**
 * A value that follows a flag in argsExtra: a path or an id with no space,
 * quote or shell metacharacter (and no "=", "," or ";", which cmd.exe treats
 * as argument separators), so it reads as one argument in cmd.exe and in a
 * POSIX shell alike (W2: no free text on a command line).
 */
const ARGS_EXTRA_VALUE_RE = /^[A-Za-z0-9._:\\/~+@-]+$/;
/** Most extra arguments one descriptor accepts. */
const ARGS_EXTRA_MAX = 32;

/** Values already warned about, so a bad record logs once, not per spawn. */
const warnedValues = new Set();

/**
 * Warn once per distinct dropped value.
 *
 * @param {string} what - Field name.
 * @param {*} value - The dropped value.
 */
function warnDropped(what, value) {
  const key = what + ':' + String(value);
  if (warnedValues.has(key)) return;
  warnedValues.add(key);
  try { console.warn('[claude spawn] dropped unknown ' + what + ' value'); } catch (_) { /* never fatal */ }
}

/**
 * Validate argsExtra: known flags, and values that are single safe tokens.
 * Throws on anything else, so a launch that asked for extra arguments fails
 * loudly instead of starting without them.
 *
 * @param {*} argsExtra - Candidate list.
 * @returns {string[]} The accepted tokens (empty when none).
 * @throws {Error} on an unknown flag or an unsafe value.
 */
function checkArgsExtra(argsExtra) {
  if (argsExtra === null || argsExtra === undefined) return [];
  if (!Array.isArray(argsExtra) || argsExtra.length > ARGS_EXTRA_MAX) {
    throw new Error('unsafe argsExtra: not a short list');
  }
  const out = [];
  for (const token of argsExtra) {
    if (typeof token !== 'string' || !token) throw new Error('unsafe argsExtra token');
    if (token.startsWith('-')) {
      if (!ARGS_EXTRA_FLAGS.includes(token)) throw new Error('unsafe argsExtra flag: ' + token);
    } else if (!ARGS_EXTRA_VALUE_RE.test(token)) {
      throw new Error('unsafe argsExtra value');
    }
    out.push(token);
  }
  return out;
}

/**
 * Build a SpawnDescriptor for the Claude CLI.
 *
 * Pure function. Does NOT touch the filesystem, the network, or any state.
 * Throws on invalid input. Returns a descriptor that pty-manager joins,
 * shell-wraps, and runs through node-pty.
 *
 * @param {Object} init
 * @param {string} init.sessionId             - Myrlin internal session id (currently unused, reserved for future flagging).
 * @param {string|null} [init.providerSessionId]  - Claude transcript UUID for the resume option. Validated against /^[a-zA-Z0-9_-]+$/.
 * @param {string|null} [init.newSessionId]   - UUID to assign to a FRESH conversation via the session id option. Ignored when
 *                                              providerSessionId is set (a resume already has an id). Same validation.
 *                                              Minted by pty-manager (2026-09-22) so the transcript id is known before
 *                                              the CLI starts, instead of being watched for or guessed afterwards.
 * @param {string|null} [init.cwd]            - Working directory (passes through; pty-manager validates and falls back).
 * @param {boolean} [init.bypassPermissions]  - Adds the skip permissions flag.
 * @param {string[]} [init.flags]             - Extra flag names (letters, digits and hyphens), each emitted with two leading hyphens.
 * @param {string|null} [init.model]          - Model id, e.g. `sonnet` or `claude-3-5-haiku-latest`. Validated.
 * @param {boolean} [init.verbose]            - Adds the verbose flag.
 * @param {string|null} [init.initialPrompt]  - First-turn prompt to append as the trailing positional arg. Single-quote-escaped.
 * @param {string|null} [init.attachShortId]  - Short id of a live Claude Code BACKGROUND session (the id field of the JSON listing of `claude agents`,
 *                                              8 chars today). When set the descriptor is `claude attach <id>`
 *                                              and every other option is ignored: the attach client joins the running
 *                                              session instead of forking its transcript with resume (2026-09-26).
 *                                              Validated against /^[A-Za-z0-9]{4,32}$/ because the id is joined into
 *                                              the pane's shell command line.
 * @param {string|null} [init.effort]         - Mobile v2 (S10): one of CLAUDE_EFFORT_VALUES, emitted as the effort option;
 *                                              anything else is dropped with a warning.
 * @param {string|null} [init.permissionMode] - Mobile v2 (S10): one of CLAUDE_PERMISSION_MODES. bypassPermissions
 *                                              uses the skip permissions flag; the others the permission mode option
 *                                              (default is spelled "manual" by the 2.1.283 CLI). Unknown values
 *                                              are dropped with a warning and the legacy bypassPermissions flag rules.
 * @param {string[]|null} [init.argsExtra]    - Mobile v2: extra arguments from an in process caller (the migration
 *                                              charter flags). Only ARGS_EXTRA_FLAGS and single safe tokens pass.
 * @returns {{cmd: string, args: string[], cwd: (string|null), env: Object<string,(string|undefined)>}} SpawnDescriptor.
 * @throws {Error} when model fails the validation regex.
 * @throws {Error} when providerSessionId fails the validation regex.
 * @throws {Error} when attachShortId fails the validation regex.
 * @throws {Error} when argsExtra holds an unknown flag or an unsafe value.
 */
function spawnCommand({
  sessionId,
  providerSessionId = null,
  newSessionId = null,
  cwd = null,
  bypassPermissions = false,
  flags = [],
  model = null,
  verbose = false,
  initialPrompt = null,
  attachShortId = null,
  effort = null,
  permissionMode = null,
  argsExtra = null,
} = {}) {
  // The literal 'claude' below is the CLI binary name. This file lives inside
  // src/providers/claude/, which the grep gate (Plan 14-05) skips, so the
  // marker is defensive (extra signal for future readers) rather than required.
  const cmd = 'claude'; // gsd:provider-literal-allowed (Claude provider CLI binary)

  // Attach to a live background session (2026-09-26). Checked first and
  // returned early: `claude attach` takes only the id, and none of the
  // resume/model/permission flags apply to a session that is already running
  // with its own settings. Same env scrub as the resume path below.
  if (attachShortId !== null && attachShortId !== undefined && attachShortId !== '') {
    if (typeof attachShortId !== 'string' || !/^[A-Za-z0-9]{4,32}$/.test(attachShortId)) {
      throw new Error('unsafe attachShortId: ' + attachShortId);
    }
    return {
      cmd,
      args: ['attach', attachShortId],
      cwd: cwd || null,
      env: { CLAUDECODE: undefined },
    };
  }

  // Defense-in-depth validation. Mirrors pty-manager.js lines 284-291 verbatim
  // so any input that historically passed the SHELL_UNSAFE gate continues to
  // pass here. Throwing (rather than returning null) is appropriate because
  // pty-manager wraps this call in try/catch and converts thrown errors to
  // the same null return + console.error path the v0.9.36 code took.
  if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) {
    throw new Error('unsafe model: ' + model);
  }
  if (providerSessionId && !/^[a-zA-Z0-9_-]+$/.test(providerSessionId)) {
    throw new Error('unsafe providerSessionId: ' + providerSessionId);
  }
  if (newSessionId && !/^[a-zA-Z0-9_-]+$/.test(newSessionId)) {
    throw new Error('unsafe newSessionId: ' + newSessionId);
  }
  // Mobile v2 (S10): extra arguments are checked before anything is built.
  const extra = checkArgsExtra(argsExtra);

  // Mobile v2 (S10): resolve the permission mode first. A known explicit
  // mode wins over the legacy boolean (the phone's settings write both
  // consistently); an unknown one is dropped and the legacy rule applies.
  let mode = null;
  if (permissionMode !== null && permissionMode !== undefined && permissionMode !== '') {
    if (CLAUDE_PERMISSION_MODES.includes(permissionMode)) mode = permissionMode;
    else warnDropped('permissionMode', permissionMode);
  }
  const skipPermissions = mode ? mode === 'bypassPermissions' : !!bypassPermissions;

  const args = [];
  if (providerSessionId) {
    args.push('--resume');
    args.push(providerSessionId);
  } else if (newSessionId) {
    // Fresh conversation with a caller-chosen id. The session id option makes
    // the CLI write its transcript as <uuid>.jsonl, so the Workbook knows the
    // resume id at spawn time. Never combined with the resume option.
    args.push('--session-id');
    args.push(newSessionId);
  }
  if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (mode && mode !== 'bypassPermissions') {
    args.push('--permission-mode');
    args.push(CLI_PERMISSION_MODE[mode] || mode);
  }
  if (effort !== null && effort !== undefined && effort !== '') {
    if (CLAUDE_EFFORT_VALUES.includes(effort)) {
      args.push('--effort');
      args.push(effort);
    } else {
      warnDropped('effort', effort);
    }
  }
  if (verbose) {
    args.push('--verbose');
  }
  if (model) {
    // The check above throws for any character outside [a-zA-Z0-9._:-], so
    // the quoting branch below is a guard that current values never reach.
    //
    // Mobile v2 (B3, session settings model): the check above already limits
    // the value to [a-zA-Z0-9._:-], which no shell expands, so such a value
    // goes bare. Workbook launches through cmd.exe on Windows, which keeps
    // single quotes, and the CLI then refused the quoted model ("There's an
    // issue with the selected model ('claude-haiku-4-5')", Claude Code
    // 2.1.283 through cmd.exe /c, 2026-09-27). The quoting stays for any
    // value that would need it.
    const needsQuotes = /[^a-zA-Z0-9._:-]/.test(model);
    const safeModel = needsQuotes ? "'" + model.replace(/'/g, "'\\''") + "'" : model;
    args.push('--model');
    args.push(safeModel);
  }
  if (Array.isArray(flags)) {
    for (const f of flags) {
      // Silently drop malformed flag tokens (no exception). Matches the
      // v0.9.36 behavior at pty-manager.js:323-328.
      if (f && /^[a-zA-Z0-9-]+$/.test(f)) {
        args.push('--' + f);
      }
    }
  }
  // Mobile v2 (S10): the checked extra arguments (migration charter flags),
  // ahead of any positional prompt so the CLI reads them as options.
  for (const token of extra) args.push(token);
  // Initial prompt: appended as the last positional argument on first launch.
  // Wrap in single quotes, escaping any single quotes inside the prompt.
  if (initialPrompt && typeof initialPrompt === 'string') {
    const escaped = initialPrompt.replace(/'/g, "'\\''");
    args.push("'" + escaped + "'");
  }

  // env: { CLAUDECODE: undefined } means DELETE this key from the spawn env.
  // pty-manager honors undefined values as DELETE-this-key semantics so the
  // existing `delete sessionEnv.CLAUDECODE` (was pty-manager.js:358) is
  // preserved. Without this scrub, a Myrlin session running inside a parent
  // Claude Code session inherits CLAUDECODE=1 and triggers the nested-session
  // detection error inside the spawned `claude` process.
  return {
    cmd,
    args,
    cwd: cwd || null,
    env: { CLAUDECODE: undefined },
  };
}

module.exports = {
  spawnCommand,
  // Mobile v2 (S10): the enums and the argsExtra rules, for B3's settings
  // schema and migration launch so there is one source of truth.
  CLAUDE_EFFORT_VALUES,
  CLAUDE_PERMISSION_MODES,
  CLI_PERMISSION_MODE,
  ARGS_EXTRA_FLAGS,
  ARGS_EXTRA_VALUE_RE,
  checkArgsExtra,
};
