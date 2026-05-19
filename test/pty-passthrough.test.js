#!/usr/bin/env node
/**
 * Unit tests for the PTY pass-through refactor (Plan 14-04, PTY-03).
 *
 * Covers:
 *   Test 1  Descriptor flow: provider.spawnCommand result is what pty.spawn receives
 *   Test 2  env merge: undefined values DELETE the key from the spawn env
 *   Test 3  Non-Claude provider with invalid cwd falls back to homedir (NOT cwdFromJsonl)
 *   Test 4  Claude provider with invalid cwd uses cwdFromJsonl fallback (MANDATORY)
 *   Test 5  PTY-01 regression: Claude descriptor.cmd === 'claude' and --resume present
 *   Test 6  Non-default-command bypass: command:'td' bypasses provider lookup entirely
 *
 * Test pattern mirrors test/providers-registry.test.js: no third-party framework,
 * stubbed pty.spawn via the test-only `_ptySpawnForTesting` opt that pty-manager
 * accepts. Stub cwdFromJsonl via `_cwdFromJsonlForTesting`. Both injections are
 * documented as @private test-only in pty-manager.spawnSession's JSDoc.
 *
 * IMPORTANT: this test depends on pty-manager.js exposing the two injection
 * opts (Plan 14-04 Task 4 wires them). Without them, all 6 tests RED.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : String(err)));
  }
}

/**
 * Build a fully-populated fake provider that satisfies the registry's validation
 * gate. The spawnCommand override is the part each test cares about.
 * @param {string} id  Provider id.
 * @param {Object} overrides  Patch fields onto the base.
 * @returns {Object} Provider object.
 */
function makeFakeProvider(id, overrides) {
  const base = {
    id,
    displayName: 'Fake ' + id,
    accentToken: 'mauve',
    cliBinary: id,
    discover: async () => [],
    parseTranscript: async () => [],
    spawnCommand: () => ({ cmd: id, args: [], cwd: null, env: {} }),
    search: async () => [],
    init: async () => {},
    dispose: async () => {},
    supportsCost: () => false,
    isIdleSignal: () => false,
    getKeyBindings: () => ({}),
  };
  return Object.assign(base, overrides || {});
}

/**
 * Build a stub PTY object that has the methods pty-manager touches after
 * spawn. `onData` and `onExit` capture the registered handler so the test
 * can drive them; default no-ops are fine for the descriptor-flow tests.
 */
function makeStubPty() {
  return {
    pid: 99999,
    onData: () => {},
    onExit: () => {},
    on: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}

/**
 * Reset all relevant module caches so each test gets a fresh registry +
 * pty-manager + store. Mirrors the technique used in test/run.js.
 */
function resetModules() {
  delete require.cache[require.resolve('../src/providers')];
  delete require.cache[require.resolve('../src/providers/claude/spawn')];
  delete require.cache[require.resolve('../src/web/pty-manager')];
  delete require.cache[require.resolve('../src/state/store')];
}

/**
 * Build a fresh PtySessionManager + registry pair. Adds a freshly-built
 * fake provider (from `providerOpts`) plus the real Claude spawn function
 * if the test enables Claude. Returns helper handles for the test.
 *
 * @param {Object} cfg
 * @param {Object} [cfg.fakeProviderOverrides]  Patches for the fake provider.
 * @param {boolean} [cfg.includeClaude]  Register a minimal claude provider.
 * @param {boolean} [cfg.fakeProviderEnabled]  Add fake to enabled set.
 * @returns {{registry, ptyMgr, fakeProvider, store}}
 */
function buildFixture(cfg) {
  resetModules();
  const registry = require('../src/providers');
  const fakeProvider = makeFakeProvider('faketest', cfg && cfg.fakeProviderOverrides);
  registry.register(fakeProvider);
  if (cfg && cfg.fakeProviderEnabled) registry.setEnabled('faketest', true);

  if (cfg && cfg.includeClaude) {
    const { spawnCommand } = require('../src/providers/claude/spawn');
    const claudeProvider = makeFakeProvider('claude', { spawnCommand });
    registry.register(claudeProvider);
    registry.setEnabled('claude', true);
  }

  const { PtySessionManager } = require('../src/web/pty-manager');
  const { getStore } = require('../src/state/store');
  const ptyMgr = new PtySessionManager();
  const store = getStore();

  return { registry, ptyMgr, fakeProvider, store };
}

/**
 * Make a session record in the store with a specific provider tag. Returns
 * the session id. Uses createSession then updateSession to set provider since
 * createSession does not accept provider directly (defaults handled at load time).
 */
function makeSessionWithProvider(store, providerId, opts) {
  const ws = store.createWorkspace({ name: 'pty-test-ws-' + Math.random().toString(36).slice(2, 8) });
  const sess = store.createSession({
    name: 'pty-test-' + Math.random().toString(36).slice(2, 8),
    workspaceId: ws.id,
    workingDir: (opts && opts.workingDir) || '',
    command: (opts && opts.command) || 'claude',
  });
  // Set provider directly via updateSession; the store's read-side normalizer
  // ensures it round-trips. v1.2 schema permits arbitrary additional fields.
  store.updateSession(sess.id, { provider: providerId });
  return sess.id;
}

console.log('\n  Plan 14-04 PTY pass-through tests');
console.log('  ' + '-'.repeat(42));

// ──────────────────────────────────────────────────────────────────────
// Test 1: Descriptor flow — provider.spawnCommand descriptor flows to pty.spawn
// ──────────────────────────────────────────────────────────────────────
// To exercise the provider path (NOT the bypass branch), call with the
// default command 'claude' and override the claude provider's spawnCommand
// to return a known descriptor. This proves the provider's descriptor
// (cmd/args/env) propagates through the shell-wrap and reaches pty.spawn.
check('Test 1 (PTY-03): provider.spawnCommand descriptor flows to pty.spawn', () => {
  const { ptyMgr, store } = buildFixture({ includeClaude: true });
  const registry = require('../src/providers');
  const claude = registry.getProvider('claude');
  let spawnCommandCalled = false;
  claude.spawnCommand = (init) => {
    spawnCommandCalled = true;
    return {
      cmd: 'claude', // gsd:provider-literal-allowed (test-local override)
      args: ['--foo', '--bar'],
      cwd: os.tmpdir(),
      env: { FOO: 'bar' },
    };
  };

  const sessionId = makeSessionWithProvider(store, 'claude', { command: 'claude' });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  ptyMgr.spawnSession(sessionId, {
    // Use the default command ('claude') so the provider path fires
    _ptySpawnForTesting: spy,
    _cwdFromJsonlForTesting: () => null,
  });

  assert.ok(spawnCommandCalled, 'provider.spawnCommand must have been invoked on the claude path');
  assert.ok(captured, 'pty.spawn spy must have been invoked');
  // Shell wrap: the joined fullCommand should contain claude + descriptor flags.
  const fullCommand = captured.shellArgs[captured.shellArgs.length - 1];
  assert.ok(fullCommand.includes('--foo'), 'fullCommand must include descriptor.args[0], got: ' + fullCommand);
  assert.ok(fullCommand.includes('--bar'), 'fullCommand must include descriptor.args[1]');
  // env merge: descriptor.env.FOO should land on the spawn env
  assert.strictEqual(captured.spawnOpts.env.FOO, 'bar', 'descriptor.env.FOO=bar must propagate to spawn env');
  // resolvedCwd should be the os.tmpdir() returned by the descriptor
  assert.strictEqual(captured.spawnOpts.cwd, os.tmpdir(),
    'descriptor.cwd must propagate to spawn opts, got: ' + captured.spawnOpts.cwd);
});

// ──────────────────────────────────────────────────────────────────────
// Test 2: env merge with undefined = DELETE
// ──────────────────────────────────────────────────────────────────────
check('Test 2 (PTY-03): descriptor.env undefined values DELETE the key from spawn env', () => {
  process.env.PTY_TEST_DELETE_ME = 'should-be-deleted';

  const { ptyMgr, store } = buildFixture({
    includeClaude: true,
    fakeProviderEnabled: true,
    fakeProviderOverrides: {
      spawnCommand: () => ({
        cmd: 'fake-cli',
        args: [],
        cwd: os.tmpdir(),
        env: { PTY_TEST_DELETE_ME: undefined, PTY_TEST_KEEP_ME: 'kept' },
      }),
    },
  });
  // Use claude provider here (default 'claude' command + provider tag) so
  // useProvider===true and provider.spawnCommand fires. Override the claude
  // provider's spawnCommand for this test only by patching directly.
  const registry = require('../src/providers');
  const claude = registry.getProvider('claude');
  claude.spawnCommand = () => ({
    cmd: 'claude', // gsd:provider-literal-allowed (test-local override)
    args: [],
    cwd: os.tmpdir(),
    env: { PTY_TEST_DELETE_ME: undefined, PTY_TEST_KEEP_ME: 'kept' },
  });

  const sessionId = makeSessionWithProvider(store, 'claude', { command: 'claude' });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = spawnOpts;
    return makeStubPty();
  };
  ptyMgr.spawnSession(sessionId, { _ptySpawnForTesting: spy });

  assert.ok(captured, 'pty.spawn must have been invoked');
  assert.ok(!('PTY_TEST_DELETE_ME' in captured.env),
    'PTY_TEST_DELETE_ME must be DELETED from env, got: ' + captured.env.PTY_TEST_DELETE_ME);
  assert.strictEqual(captured.env.PTY_TEST_KEEP_ME, 'kept',
    'PTY_TEST_KEEP_ME must be preserved');

  delete process.env.PTY_TEST_DELETE_ME;
});

// ──────────────────────────────────────────────────────────────────────
// Test 3: non-Claude provider invalid cwd falls back to homedir (NOT JSONL)
// ──────────────────────────────────────────────────────────────────────
// Use the bypass branch (command:'faketest') so the inline descriptor is
// built. Pass cwd:'/invalid/path' explicitly so resolvedCwd starts invalid
// and the cwd-fallback branch fires. The branch should hit the homedir
// fallback (because useProvider===false), NOT the cwdFromJsonl path.
check('Test 3 (PTY-03): non-Claude provider invalid cwd falls back to homedir', () => {
  const { ptyMgr, store } = buildFixture({ fakeProviderEnabled: true });
  const sessionId = makeSessionWithProvider(store, 'faketest', { command: 'faketest' });

  let captured = null;
  let cwdFromJsonlInvoked = false;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = spawnOpts;
    return makeStubPty();
  };
  const cwdFromJsonlSpy = () => { cwdFromJsonlInvoked = true; return '/should/not/use/this'; };

  ptyMgr.spawnSession(sessionId, {
    command: 'faketest', // non-claude, triggers bypass branch
    cwd: '/this/path/does/not/exist/anywhere/at/all',
    _ptySpawnForTesting: spy,
    _cwdFromJsonlForTesting: cwdFromJsonlSpy,
  });

  assert.ok(captured, 'pty.spawn must have been invoked');
  assert.strictEqual(captured.cwd, os.homedir(),
    'non-claude provider must fall back to homedir, got: ' + captured.cwd);
  assert.strictEqual(cwdFromJsonlInvoked, false,
    'cwdFromJsonl MUST NOT be called for non-claude providers');
});

// ──────────────────────────────────────────────────────────────────────
// Test 4: Claude provider invalid cwd uses cwdFromJsonl (MANDATORY)
// ──────────────────────────────────────────────────────────────────────
check('Test 4 (PTY-03): Claude invalid cwd resolves via cwdFromJsonl fallback', () => {
  const { ptyMgr, store } = buildFixture({ includeClaude: true });
  // Override claude provider's spawnCommand to return an invalid cwd so we
  // exercise the JSONL fallback branch.
  const registry = require('../src/providers');
  const claude = registry.getProvider('claude');
  claude.spawnCommand = () => ({
    cmd: 'claude', // gsd:provider-literal-allowed (test-local override)
    args: [],
    cwd: '/this/path/does/not/exist/anywhere/either',
    env: {},
  });

  const sessionId = makeSessionWithProvider(store, 'claude', { command: 'claude' });

  // Inject a fake cwdFromJsonl that returns a real, valid path. os.tmpdir()
  // is guaranteed to exist on every platform.
  const validTmpDir = os.tmpdir();
  let cwdFromJsonlInvoked = false;
  const cwdFromJsonlSpy = (resumeId) => {
    cwdFromJsonlInvoked = true;
    return validTmpDir;
  };

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = spawnOpts;
    return makeStubPty();
  };

  ptyMgr.spawnSession(sessionId, {
    _ptySpawnForTesting: spy,
    _cwdFromJsonlForTesting: cwdFromJsonlSpy,
  });

  assert.ok(captured, 'pty.spawn must have been invoked');
  assert.strictEqual(cwdFromJsonlInvoked, true,
    'cwdFromJsonl MUST be called for claude provider with invalid cwd');
  assert.strictEqual(captured.cwd, validTmpDir,
    'claude must resolve cwd via JSONL fallback, got: ' + captured.cwd);
});

// ──────────────────────────────────────────────────────────────────────
// Test 5: PTY-01 regression — Claude descriptor.cmd === 'claude'
// ──────────────────────────────────────────────────────────────────────
check('Test 5 (PTY-01): Claude descriptor uses --resume when resumeSessionId provided', () => {
  const { ptyMgr, store } = buildFixture({ includeClaude: true });
  const sessionId = makeSessionWithProvider(store, 'claude', { command: 'claude' });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  ptyMgr.spawnSession(sessionId, {
    resumeSessionId: 'abc-123-def',
    _ptySpawnForTesting: spy,
    _cwdFromJsonlForTesting: () => os.tmpdir(),
  });

  assert.ok(captured, 'pty.spawn must have been invoked');
  const joined = captured.shellArgs.join(' ');
  assert.ok(joined.includes('claude'), 'fullCommand must contain claude binary, got: ' + joined);
  assert.ok(joined.includes('--resume'), 'fullCommand must contain --resume, got: ' + joined);
  assert.ok(joined.includes('abc-123-def'), 'fullCommand must contain the resume id, got: ' + joined);
});

// ──────────────────────────────────────────────────────────────────────
// Test 6: Non-default-command bypass — command:'td' bypasses provider lookup
// ──────────────────────────────────────────────────────────────────────
// Plan 19-01 PTY-02 refactor note: under the new sentinel
// (useProvider = provider.cliBinary === command), the registry IS consulted
// to fetch the candidate provider's cliBinary. The old "getProviderCallCount
// MUST be 0" assertion overconstrained the implementation. The contract that
// matters is unchanged: a command that does NOT match any provider's cliBinary
// (e.g., 'td', scheduler/templates) MUST fall through to the inline
// descriptor builder so descriptor.cmd === command. Test 6 now asserts the
// outcome (descriptor.cmd, fullCommand prefix) without overconstraining the
// internal lookup path. The registry IS consulted, but provider.spawnCommand
// is NOT — that's the real bypass guarantee.
check('Test 6 (PTY-03 safety net): command:"td" bypasses provider, fullCommand starts with td', () => {
  const { ptyMgr, store, registry } = buildFixture({ includeClaude: true });

  // Spy on claude provider's spawnCommand to confirm provider.spawnCommand
  // is NEVER invoked on the bypass path. The registry lookup is allowed
  // (the new sentinel needs cliBinary), but spawnCommand must not fire.
  const claude = registry.getProvider('claude');
  const realSpawnCommand = claude.spawnCommand;
  let spawnCommandCallCount = 0;
  claude.spawnCommand = function(init) {
    spawnCommandCallCount++;
    return realSpawnCommand.call(claude, init);
  };

  // Create a session tagged with claude — but the deciding factor for
  // bypass is `command !== provider.cliBinary`. Since the requested
  // command is 'td' and claude.cliBinary is 'claude', the sentinel returns
  // useProvider=false and the inline descriptor builder fires.
  const sessionId = makeSessionWithProvider(store, 'claude', { command: 'td' });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  ptyMgr.spawnSession(sessionId, {
    command: 'td',
    _ptySpawnForTesting: spy,
  });

  // Restore the real spawnCommand before any subsequent test runs.
  claude.spawnCommand = realSpawnCommand;

  assert.ok(captured, 'pty.spawn must have been invoked');
  // The fullCommand should START with 'td' (it's the descriptor.cmd).
  // After shell-wrap, shellArgs is something like ['/c', 'td'] (cmd) or
  // ['-l', '-c', 'td'] (bash). Last token is the joined fullCommand.
  const fullCommand = captured.shellArgs[captured.shellArgs.length - 1];
  assert.ok(fullCommand.startsWith('td'),
    'fullCommand must START with td (not claude), got: ' + fullCommand);
  assert.ok(!fullCommand.startsWith('claude'),
    'fullCommand must NOT start with claude on bypass path, got: ' + fullCommand);
  assert.strictEqual(spawnCommandCallCount, 0,
    'claudeProvider.spawnCommand MUST NOT be called on the non-default-command bypass path. ' +
    'Called ' + spawnCommandCallCount + ' times.');
});

// ──────────────────────────────────────────────────────────────────────
// Test 7 (Plan 19-01 PTY-02): WS-plumbed provider hint routes through Codex
// ──────────────────────────────────────────────────────────────────────
// Simulates the WS-server -> pty-manager handoff: the client sent
// ?provider=codex&command=codex on the WS URL; pty-server parsed it,
// populated spawnOpts.provider and spawnOpts.command, then called
// ptyManager.spawnSession. The registry-driven sentinel must route the
// spawn through codexProvider.spawnCommand (descriptor.cmd === 'codex',
// args === ['resume', <id>]), NOT the inline descriptor builder.
check('Test 7 (PTY-02): spawnOpts.provider=codex routes through codex provider', () => {
  const { ptyMgr, store } = buildFixture({ includeClaude: true });
  const registry = require('../src/providers');
  // Register a real-shaped codex provider; the Codex spawn module is the
  // production code that builds the resume descriptor.
  const { spawnCommand: codexSpawnCommand } = require('../src/providers/codex/spawn');
  const codexProvider = makeFakeProvider('codex', { /* gsd:provider-literal-allowed */
    cliBinary: 'codex', /* gsd:provider-literal-allowed */
    spawnCommand: codexSpawnCommand,
  });
  registry.register(codexProvider);
  registry.setEnabled('codex', true); /* gsd:provider-literal-allowed */

  // Build a session WITHOUT a store-tagged provider; the WS-query hint
  // should be the deciding signal. This mirrors the ad-hoc spawn path
  // where discovery has not yet populated the store row.
  const sessionId = makeSessionWithProvider(store, 'claude', { command: 'claude' });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  // Mirror the post-Plan-19-01 WS-server call: command + provider both set.
  // The store record is tagged claude (Pitfall 19-B), but the test fixture
  // session has no resumeSessionId, so codex spawnCommand produces an
  // arglist of [] (fresh session). The store record DOES tag claude here,
  // so for this test we want the WS hint to fail-safe: store wins.
  // Re-create with explicit codex tag:
  store.updateSession(sessionId, { provider: 'codex' }); /* gsd:provider-literal-allowed */

  ptyMgr.spawnSession(sessionId, {
    command: 'codex', /* gsd:provider-literal-allowed */
    provider: 'codex', /* gsd:provider-literal-allowed */
    resumeSessionId: 'codex-uuid-abc-123',
    _ptySpawnForTesting: spy,
  });

  assert.ok(captured, 'pty.spawn must have been invoked');
  const fullCommand = captured.shellArgs[captured.shellArgs.length - 1];
  assert.ok(fullCommand.startsWith('codex'),
    'fullCommand must START with codex (provider path), got: ' + fullCommand);
  assert.ok(fullCommand.includes('resume'),
    'fullCommand must contain the resume subcommand, got: ' + fullCommand);
  assert.ok(fullCommand.includes('codex-uuid-abc-123'),
    'fullCommand must contain the resume session id, got: ' + fullCommand);
});

// ──────────────────────────────────────────────────────────────────────
// Test 8 (Plan 19-01 PTY-08): CODEX_HOME propagates only to its spawn
// ──────────────────────────────────────────────────────────────────────
// Per-spawn env scoping safety net at the pty-passthrough layer (the
// dedicated env-scoping suite lives in test/pty-codex-spawn.test.js). This
// extra assertion in pty-passthrough makes sure the descriptor.env merge
// behavior still routes CODEX_HOME correctly through the new sentinel.
check('Test 8 (PTY-08): Codex descriptor.env.CODEX_HOME propagates only on Codex spawn', () => {
  const { ptyMgr, store } = buildFixture({ includeClaude: true });
  const registry = require('../src/providers');
  const { spawnCommand: codexSpawnCommand } = require('../src/providers/codex/spawn');
  const codexProvider = makeFakeProvider('codex', { /* gsd:provider-literal-allowed */
    cliBinary: 'codex', /* gsd:provider-literal-allowed */
    spawnCommand: codexSpawnCommand,
  });
  registry.register(codexProvider);
  registry.setEnabled('codex', true); /* gsd:provider-literal-allowed */

  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = os.tmpdir();

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = spawnOpts;
    return makeStubPty();
  };

  try {
    const sid = makeSessionWithProvider(store, 'codex', { /* gsd:provider-literal-allowed */
      command: 'codex', /* gsd:provider-literal-allowed */
    });
    ptyMgr.spawnSession(sid, {
      command: 'codex', /* gsd:provider-literal-allowed */
      resumeSessionId: 'pty-test-codex-uuid-8',
      _ptySpawnForTesting: spy,
    });
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }

  assert.ok(captured, 'pty.spawn must have been invoked');
  assert.strictEqual(captured.env.CODEX_HOME, os.tmpdir(),
    'Codex spawn env must carry CODEX_HOME captured from process.env at spawn time, got: ' +
    captured.env.CODEX_HOME);
});

// ──────────────────────────────────────────────────────────────────────
console.log('  ' + '-'.repeat(42));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('  ' + '-'.repeat(42) + '\n');

if (failed > 0) {
  process.exit(1);
}
console.log('All passed.');
process.exit(0);
