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
 * function single-quotes the model and initialPrompt values explicitly so
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
 * Single-quote escape pattern (was pty-manager.js:319,333) is preserved so
 * the shell-wrap parses identically to v0.9.36.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/claude/spawn
 */

'use strict';

/**
 * Build a SpawnDescriptor for the Claude CLI.
 *
 * Pure function. Does NOT touch the filesystem, the network, or any state.
 * Throws on invalid input. Returns a descriptor that pty-manager joins,
 * shell-wraps, and runs through node-pty.
 *
 * @param {Object} init
 * @param {string} init.sessionId             - Myrlin internal session id (currently unused, reserved for future flagging).
 * @param {string|null} [init.providerSessionId]  - Claude transcript UUID for `--resume`. Validated against /^[a-zA-Z0-9_-]+$/.
 * @param {string|null} [init.newSessionId]   - UUID to assign to a FRESH conversation via `--session-id`. Ignored when
 *                                              providerSessionId is set (a resume already has an id). Same validation.
 *                                              Minted by pty-manager (2026-09-22) so the transcript id is known before
 *                                              the CLI starts, instead of being watched for or guessed afterwards.
 * @param {string|null} [init.cwd]            - Working directory (passes through; pty-manager validates and falls back).
 * @param {boolean} [init.bypassPermissions]  - Adds `--dangerously-skip-permissions`.
 * @param {string[]} [init.flags]             - Extra `--<flag>` tokens. Each must match /^[a-zA-Z0-9-]+$/ or it is silently dropped.
 * @param {string|null} [init.model]          - Model id, e.g. `sonnet` or `claude-3-5-haiku-latest`. Validated.
 * @param {boolean} [init.verbose]            - Adds `--verbose`.
 * @param {string|null} [init.initialPrompt]  - First-turn prompt to append as the trailing positional arg. Single-quote-escaped.
 * @param {string|null} [init.attachShortId]  - Short id of a live Claude Code BACKGROUND session (`claude agents --json`
 *                                              `id`, 8 chars today). When set the descriptor is `claude attach <id>`
 *                                              and every other option is ignored: the attach client joins the running
 *                                              session instead of forking its transcript with --resume (2026-09-26).
 *                                              Validated against /^[A-Za-z0-9]{4,32}$/ because the id is joined into
 *                                              the pane's shell command line.
 * @returns {{cmd: string, args: string[], cwd: (string|null), env: Object<string,(string|undefined)>}} SpawnDescriptor.
 * @throws {Error} when model fails the validation regex.
 * @throws {Error} when providerSessionId fails the validation regex.
 * @throws {Error} when attachShortId fails the validation regex.
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

  const args = [];
  if (providerSessionId) {
    args.push('--resume');
    args.push(providerSessionId);
  } else if (newSessionId) {
    // Fresh conversation with a caller-chosen id. `claude --session-id <uuid>`
    // makes the CLI write its transcript as <uuid>.jsonl, so the Workbook
    // knows the resume id at spawn time. Never combined with --resume.
    args.push('--session-id');
    args.push(newSessionId);
  }
  if (bypassPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (verbose) {
    args.push('--verbose');
  }
  if (model) {
    // Single-quote the model value so shell glob characters in aliases like
    // sonnet[1m] are not expanded by bash before being passed to claude.
    // Escape pattern: ' becomes '\''  (close-quote, escaped quote, reopen-quote).
    const safeModel = "'" + model.replace(/'/g, "'\\''") + "'";
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

module.exports = { spawnCommand };
