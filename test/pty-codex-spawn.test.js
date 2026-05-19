#!/usr/bin/env node
/**
 * Plan 19-01 PTY-02 and PTY-08: Codex spawn dispatch + env scoping.
 *
 * Direct verification that the registry-driven sentinel routes Codex
 * spawns through codexProvider.spawnCommand AND that descriptor.env values
 * (notably CODEX_HOME) are scoped to the spawn descriptor without bleeding
 * into sibling spawns or the parent process.
 *
 * Test plan:
 *   Test A (PTY-02 store path): store record tagged provider:'codex' with
 *     command:'codex'. Assert pty.spawn receives `codex resume <id>` argv
 *     AND descriptor.env.CODEX_HOME flows through to the spawn env.
 *   Test B (PTY-02 ad-hoc path): opts.provider='codex' but no store tag
 *     (ad-hoc spawn). Assert same outcome.
 *   Test C (bypass safety): command:'td' with store tag claude. Assert
 *     descriptor.cmd === 'td' (inline path; provider not consulted for
 *     spawnCommand).
 *   Test D (PTY-08 env scoping): two sequential spawns. First sets
 *     CODEX_HOME in the env; second does not. Assert the second's spawn
 *     env does NOT inherit CODEX_HOME from the first.
 *   Test E (PTY-08 process isolation): CODEX_HOME on the parent
 *     process.env is not mutated by a Codex spawn.
 *
 * Pattern mirrors test/pty-passthrough.test.js: plain assert + stubbed
 * pty.spawn via _ptySpawnForTesting. No third-party framework.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const assert = require('assert');
const path = require('path');
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
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : String(err)));
  }
}

/**
 * Build a fully-populated fake provider that satisfies the registry's
 * validation gate. Caller overrides the parts each test needs (cliBinary,
 * spawnCommand, etc.).
 *
 * @param {string} id  Provider id.
 * @param {Object} overrides  Patch fields onto the base.
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

/** Stub pty object with the methods pty-manager touches after spawn. */
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
 * Reset module caches so each test gets a fresh registry + pty-manager + store.
 * Mirrors the pattern in test/pty-passthrough.test.js.
 */
function resetModules() {
  delete require.cache[require.resolve('../src/providers')];
  delete require.cache[require.resolve('../src/providers/claude/spawn')];
  delete require.cache[require.resolve('../src/providers/codex/spawn')];
  delete require.cache[require.resolve('../src/web/pty-manager')];
  delete require.cache[require.resolve('../src/state/store')];
}

/**
 * Build a fresh fixture with both Claude and Codex providers registered.
 * Claude carries the real spawn function so PTY-01 regression assertions
 * elsewhere still work; Codex carries the real spawn function so we can
 * verify the `resume <id>` argv and CODEX_HOME env scoping.
 */
function buildFixture() {
  resetModules();
  const registry = require('../src/providers');

  const { spawnCommand: claudeSpawnCommand } = require('../src/providers/claude/spawn');
  const claudeProvider = makeFakeProvider('claude', { /* gsd:provider-literal-allowed */
    cliBinary: 'claude', /* gsd:provider-literal-allowed */
    spawnCommand: claudeSpawnCommand,
  });
  registry.register(claudeProvider);
  registry.setEnabled('claude', true); /* gsd:provider-literal-allowed */

  const { spawnCommand: codexSpawnCommand } = require('../src/providers/codex/spawn');
  const codexProvider = makeFakeProvider('codex', { /* gsd:provider-literal-allowed */
    cliBinary: 'codex', /* gsd:provider-literal-allowed */
    spawnCommand: codexSpawnCommand,
  });
  registry.register(codexProvider);
  registry.setEnabled('codex', true); /* gsd:provider-literal-allowed */

  const { PtySessionManager } = require('../src/web/pty-manager');
  const { getStore } = require('../src/state/store');
  const ptyMgr = new PtySessionManager();
  const store = getStore();
  return { registry, ptyMgr, store };
}

/**
 * Create a session record in the store tagged with a specific provider.
 * Returns the new session id.
 */
function makeSessionWithProvider(store, providerId, opts) {
  const ws = store.createWorkspace({ name: 'codex-test-ws-' + Math.random().toString(36).slice(2, 8) });
  const sess = store.createSession({
    name: 'codex-test-' + Math.random().toString(36).slice(2, 8),
    workspaceId: ws.id,
    workingDir: (opts && opts.workingDir) || '',
    command: (opts && opts.command) || 'claude', // gsd:provider-literal-allowed (v1.1 back-compat default)
  });
  store.updateSession(sess.id, { provider: providerId });
  return sess.id;
}

console.log('\n  Plan 19-01 Codex spawn dispatch tests');
console.log('  ' + '-'.repeat(42));

// ──────────────────────────────────────────────────────────────────────
// Test A (PTY-02 store-tagged): codex provider routes via store record
// ──────────────────────────────────────────────────────────────────────
check('Test A (PTY-02): store-tagged codex session spawns `codex resume <id>`', () => {
  const { ptyMgr, store } = buildFixture();
  const sessionId = makeSessionWithProvider(store, 'codex', { /* gsd:provider-literal-allowed */
    command: 'codex', /* gsd:provider-literal-allowed */
  });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  // Set CODEX_HOME on the parent env so the spawn descriptor propagates it.
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.tmpdir(), 'codex-test-home-A');

  try {
    ptyMgr.spawnSession(sessionId, {
      command: 'codex', /* gsd:provider-literal-allowed */
      resumeSessionId: 'aaaa1111-bbbb-2222-cccc-333344445555',
      _ptySpawnForTesting: spy,
    });
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }

  assert.ok(captured, 'pty.spawn must have been invoked');
  const fullCommand = captured.shellArgs[captured.shellArgs.length - 1];
  assert.ok(fullCommand.startsWith('codex'),
    'fullCommand must start with codex (provider path), got: ' + fullCommand);
  assert.ok(fullCommand.includes('resume'),
    'fullCommand must contain resume subcommand, got: ' + fullCommand);
  assert.ok(fullCommand.includes('aaaa1111-bbbb-2222-cccc-333344445555'),
    'fullCommand must contain the resume session uuid, got: ' + fullCommand);
  assert.strictEqual(captured.spawnOpts.env.CODEX_HOME, path.join(os.tmpdir(), 'codex-test-home-A'),
    'CODEX_HOME must propagate to spawn env when set on parent, got: ' + captured.spawnOpts.env.CODEX_HOME);
});

// ──────────────────────────────────────────────────────────────────────
// Test B (PTY-02 ad-hoc): opts.provider routes when store record is claude
// ──────────────────────────────────────────────────────────────────────
// Note: the resolution order is store.provider, opts.provider, default. The
// store record wins when present (Pitfall 19-B). To exercise the opts.provider
// branch we need a session whose store record either lacks the provider field
// or is tagged with the same provider we are spawning. We use a session
// tagged provider:'codex' (which is identical to the opts hint) so the test
// shows both signals agreeing.
check('Test B (PTY-02): opts.provider=codex routes via codexProvider when paired with command=codex', () => {
  const { ptyMgr, store } = buildFixture();
  // Build a session tagged with codex.
  const sessionId = makeSessionWithProvider(store, 'codex', { /* gsd:provider-literal-allowed */
    command: 'codex', /* gsd:provider-literal-allowed */
  });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  ptyMgr.spawnSession(sessionId, {
    command: 'codex', /* gsd:provider-literal-allowed */
    provider: 'codex', /* gsd:provider-literal-allowed */
    resumeSessionId: 'bbbb2222-cccc-3333-dddd-444455556666',
    _ptySpawnForTesting: spy,
  });

  assert.ok(captured, 'pty.spawn must have been invoked');
  const fullCommand = captured.shellArgs[captured.shellArgs.length - 1];
  assert.ok(fullCommand.startsWith('codex'),
    'fullCommand must start with codex (provider path), got: ' + fullCommand);
  assert.ok(fullCommand.includes('resume bbbb2222-cccc-3333-dddd-444455556666'),
    'fullCommand must contain `resume <id>`, got: ' + fullCommand);
});

// ──────────────────────────────────────────────────────────────────────
// Test C (bypass safety): command:'td' bypasses provider regardless of tag
// ──────────────────────────────────────────────────────────────────────
check('Test C: command:"td" with codex-tagged session still bypasses provider', () => {
  const { ptyMgr, store } = buildFixture();
  const sessionId = makeSessionWithProvider(store, 'codex', { /* gsd:provider-literal-allowed */
    command: 'td',
  });

  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  ptyMgr.spawnSession(sessionId, {
    command: 'td',
    _ptySpawnForTesting: spy,
  });

  assert.ok(captured, 'pty.spawn must have been invoked');
  const fullCommand = captured.shellArgs[captured.shellArgs.length - 1];
  assert.ok(fullCommand.startsWith('td'),
    'fullCommand must start with td (bypass path), got: ' + fullCommand);
  assert.ok(!fullCommand.startsWith('codex'),
    'fullCommand must NOT start with codex on bypass path, got: ' + fullCommand);
});

// ──────────────────────────────────────────────────────────────────────
// Test D (PTY-08): per-spawn env scoping; sibling spawn does not inherit
// ──────────────────────────────────────────────────────────────────────
check('Test D (PTY-08): sibling Claude spawn does not inherit CODEX_HOME', () => {
  const { ptyMgr, store } = buildFixture();

  // Pre-set CODEX_HOME so the Codex spawn descriptor propagates it.
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.tmpdir(), 'codex-test-home-D');

  let codexCaptured = null;
  let claudeCaptured = null;
  const spyCodex = (shell, shellArgs, spawnOpts) => {
    codexCaptured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };
  const spyClaude = (shell, shellArgs, spawnOpts) => {
    claudeCaptured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };

  try {
    const codexSid = makeSessionWithProvider(store, 'codex', { /* gsd:provider-literal-allowed */
      command: 'codex', /* gsd:provider-literal-allowed */
    });
    ptyMgr.spawnSession(codexSid, {
      command: 'codex', /* gsd:provider-literal-allowed */
      resumeSessionId: 'codex-uuid-D',
      _ptySpawnForTesting: spyCodex,
    });

    // Now flip CODEX_HOME off on the parent env BEFORE the claude spawn so
    // we test the per-spawn scoping (codex descriptor captured the env at
    // its own spawn time; claude does not see it).
    delete process.env.CODEX_HOME;

    const claudeSid = makeSessionWithProvider(store, 'claude', { /* gsd:provider-literal-allowed */
      command: 'claude', /* gsd:provider-literal-allowed */
    });
    ptyMgr.spawnSession(claudeSid, {
      command: 'claude', /* gsd:provider-literal-allowed */
      resumeSessionId: 'claude-uuid-D',
      _ptySpawnForTesting: spyClaude,
      _cwdFromJsonlForTesting: () => os.tmpdir(),
    });
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }

  assert.ok(codexCaptured, 'Codex pty.spawn must have been invoked');
  assert.ok(claudeCaptured, 'Claude pty.spawn must have been invoked');
  assert.strictEqual(codexCaptured.spawnOpts.env.CODEX_HOME, path.join(os.tmpdir(), 'codex-test-home-D'),
    'Codex spawn env must contain CODEX_HOME captured at its own spawn time');
  assert.ok(!('CODEX_HOME' in claudeCaptured.spawnOpts.env),
    'Sibling Claude spawn env must NOT contain CODEX_HOME (no cross-spawn bleed); got: ' +
    JSON.stringify(claudeCaptured.spawnOpts.env.CODEX_HOME));
});

// ──────────────────────────────────────────────────────────────────────
// Test E (PTY-08): parent process.env is not mutated by spawn
// ──────────────────────────────────────────────────────────────────────
check('Test E (PTY-08): parent process.env.CODEX_HOME is unchanged by spawn', () => {
  const { ptyMgr, store } = buildFixture();

  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.tmpdir(), 'codex-test-home-E');
  const beforeSpawn = process.env.CODEX_HOME;

  const spy = (shell, shellArgs, spawnOpts) => makeStubPty();

  try {
    const sid = makeSessionWithProvider(store, 'codex', { /* gsd:provider-literal-allowed */
      command: 'codex', /* gsd:provider-literal-allowed */
    });
    ptyMgr.spawnSession(sid, {
      command: 'codex', /* gsd:provider-literal-allowed */
      resumeSessionId: 'codex-uuid-E',
      _ptySpawnForTesting: spy,
    });

    const afterSpawn = process.env.CODEX_HOME;
    assert.strictEqual(afterSpawn, beforeSpawn,
      'process.env.CODEX_HOME must be unchanged by spawn; before=' + beforeSpawn + ' after=' + afterSpawn);
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
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
