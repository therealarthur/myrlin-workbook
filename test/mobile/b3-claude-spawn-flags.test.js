/**
 * b3-claude-spawn-flags.test.js: the Claude spawn descriptor's effort,
 * permission mode and extra arguments (BUILD-CONTRACT S10, 3.7.2
 * "Settings"; PROTOCOL.md 4.5.3; W2).
 *
 * Every known value emits the matching flag in the spelling of the
 * installed CLI (2.1.283: "default" is "manual"); unknown values are
 * dropped, never passed through; bypassPermissions keeps the existing
 * dangerously-skip-permissions path and a known explicit mode wins over the
 * legacy boolean; argsExtra only carries known flags and single safe tokens
 * (no spaces, quotes or cmd.exe separators), placed before a positional
 * prompt; and the pty manager hands the stored values to the descriptor.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const kit = require('./b3-kit');
const spawn = require('../../src/providers/claude/spawn');

const SID = '0f6f0b39-9c1b-4d77-9a55-6f1d5a9e2c11';
const base = { sessionId: 'wb1', cwd: 'C:\\work', providerSessionId: null, model: null };

/** Args of a descriptor built from base plus some fields. */
function argsOf(extra) {
  return spawn.spawnCommand(Object.assign({}, base, extra)).args;
}

/** Value after a flag, or undefined. */
function after(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

kit.test('every effort value emits --effort with that value', () => {
  kit.eq(spawn.CLAUDE_EFFORT_VALUES, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const v of spawn.CLAUDE_EFFORT_VALUES) kit.eq(after(argsOf({ effort: v }), '--effort'), v, v);
  kit.ok(!argsOf({}).includes('--effort'), 'no flag when unset');
});

kit.test('every permission mode emits the CLI spelling; bypass uses the existing flag', () => {
  const want = { default: 'manual', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto' };
  for (const [mode, cli] of Object.entries(want)) {
    const a = argsOf({ permissionMode: mode });
    kit.eq(after(a, '--permission-mode'), cli, mode);
    kit.ok(!a.includes('--dangerously-skip-permissions'), mode + ' never skips permissions');
  }
  const b = argsOf({ permissionMode: 'bypassPermissions' });
  kit.ok(b.includes('--dangerously-skip-permissions'), 'bypass keeps the legacy flag');
  kit.ok(!b.includes('--permission-mode'), 'and no second mode flag');
});

kit.test('a known explicit mode wins over the legacy boolean; unknown modes fall back to it', () => {
  const a = argsOf({ bypassPermissions: true, permissionMode: 'plan' });
  kit.ok(!a.includes('--dangerously-skip-permissions'), 'plan wins over an old bypass boolean');
  kit.eq(after(a, '--permission-mode'), 'plan');
  const b = argsOf({ bypassPermissions: true, permissionMode: 'yolo' });
  kit.ok(b.includes('--dangerously-skip-permissions'), 'unknown mode dropped, legacy rule applies');
  kit.ok(!b.includes('yolo') && !b.includes('--permission-mode'), 'nothing unknown reaches the line');
  kit.ok(argsOf({ bypassPermissions: true }).includes('--dangerously-skip-permissions'), 'old records behave as before');
});

kit.test('unknown effort values are dropped, never passed through', () => {
  for (const bad of ['turbo', 'high; del x', '--model', 'HIGH']) {
    const a = argsOf({ effort: bad });
    kit.ok(!a.includes('--effort') && !a.includes(bad), JSON.stringify(bad));
  }
});

kit.test('argsExtra carries only known flags and single safe tokens, before the prompt', () => {
  const a = argsOf({ argsExtra: ['--append-system-prompt-file', 'C:\\data\\migrations\\m1\\CHARTER.md', '--add-dir', 'C:\\data\\migrations\\m1\\pack'], initialPrompt: 'hello' });
  kit.eq(after(a, '--append-system-prompt-file'), 'C:\\data\\migrations\\m1\\CHARTER.md');
  kit.eq(after(a, '--add-dir'), 'C:\\data\\migrations\\m1\\pack');
  kit.ok(a.indexOf('--add-dir') < a.length - 1 && a[a.length - 1].includes('hello'), 'the prompt stays last');
  const fork = argsOf({ argsExtra: ['--resume', SID, '--fork-session'] });
  kit.eq(after(fork, '--resume'), SID);
  kit.ok(fork.includes('--fork-session'));
  const refused = [
    ['--dangerously-skip-permissions'],
    ['--model', 'x'],
    ['--add-dir', 'C:\\Program Files\\x'],
    ['--add-dir', 'a&b'],
    ['--add-dir', 'a"b'],
    ['--add-dir', 'a;b'],
    ['--add-dir', 'a,b'],
    ['--add-dir', 'a=b'],
    ['--add-dir', 'a|b'],
    ['--add-dir', '%PATH%'],
    ['--add-dir', ''],
    'not a list',
    new Array(40).fill('x'),
  ];
  for (const r of refused) {
    let threw = false;
    try { argsOf({ argsExtra: r }); } catch (_) { threw = true; }
    kit.ok(threw, 'refused: ' + JSON.stringify(r).slice(0, 60));
  }
  kit.eq(spawn.checkArgsExtra(null), []);
});

kit.test('the model goes bare, so cmd.exe cannot hand the CLI a quoted name', () => {
  // cmd.exe keeps single quotes; Claude Code 2.1.283 refused "'claude-haiku-4-5'"
  // through cmd.exe /c and accepted the bare name (scratch check, 2026-09-27).
  kit.eq(after(argsOf({ model: 'claude-opus-5-5' }), '--model'), 'claude-opus-5-5');
  kit.eq(after(argsOf({ model: 'opus' }), '--model'), 'opus');
  let threw = false;
  try { argsOf({ model: "sonnet'; rm -rf" }); } catch (_) { threw = true; }
  kit.ok(threw, 'an unsafe model is still refused before anything is built');
});

kit.test('the pty manager hands stored effort, mode and argsExtra to the descriptor', async () => {
  await kit.initProviders();
  const { PtySessionManager } = require('../../src/web/pty-manager');
  const pm = new PtySessionManager();
  const seen = [];
  const fake = (file, args) => { seen.push({ file, args }); return { pid: 5151, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, on() {} }; };
  try {
    pm.spawnSession('wb-flags', { command: 'claude', cwd: process.cwd(), provider: 'claude', effort: 'xhigh', permissionMode: 'acceptEdits', argsExtra: ['--add-dir', 'C:\\pack'], newSession: true, _liveChecked: true, _ptySpawnForTesting: fake }); // gsd:provider-literal-allowed (test fixture)
    kit.eq(seen.length, 1, 'spawned once');
    const line = seen[0].args.join(' ');
    kit.ok(/--effort xhigh/.test(line), line);
    kit.ok(/--permission-mode acceptEdits/.test(line), line);
    kit.ok(/--add-dir C:\\pack/.test(line), line);
    kit.ok(!/--dangerously-skip-permissions/.test(line), line);
  } finally {
    try { pm.destroyAll(); } catch (_) { /* ignore */ }
  }
});

kit.run();
