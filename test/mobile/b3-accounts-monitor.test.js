/**
 * b3-accounts-monitor.test.js: listener-scoped account monitoring.
 *
 * WHY: a disabled phone listener must do no account work. Account route
 * events, Glass file changes and local identity fingerprints keep enabled
 * listeners current. Late async results cannot revive stopped monitoring.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const mobile = require('../../src/web/mobile');
const { getStore } = require('../../src/state/store');
const { createAccounts } = require('../../src/web/mobile/workspace/accounts');

/** Let the first Glass snapshot and its immediate publication settle. */
const INITIAL_SNAPSHOT_MS = 30;
/** Keep the next label changes within the accounts publication window. */
const LABEL_CHANGE_WAIT_MS = 100;
/** Wait past the two-second accounts publication window after restart. */
const RESTART_SETTLE_MS = 2500;
/** Let the new agent-swap baseline finish after monitoring starts again. */
const SWAP_BASELINE_WAIT_MS = 200;
/** Age the fixture swap entries well before the listener restart. */
const HOUR_MS = 60 * 60 * 1000;
/** The local account fingerprint interval prescribed for external login changes. */
const FINGERPRINT_CHECK_MS = 30 * 1000;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let ctx;
let activeWatcher;
let deferredStatus = null;
let label = 'Before';
const calls = { status: 0, roster: 0, watched: 0, stopped: 0 };
const settings = { enabled: false, host: '127.0.0.1', port: 0, detectTailscale: false, advertiseLoopback: true, legacyPairEnabled: false, publicUrls: [], qrLinkStyle: 'scheme', apns: null };

/** Complete account lookup promise continuations without a wall-clock poll. */
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

/** Wait for a real publication or baseline deadline in the restart tests. */
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Build accounts directly with sandbox state, fake Glass and observable outputs. */
function accountHarness(manualIntervals = false) {
  const events = [];
  const notices = [];
  const pushes = [];
  const intervals = new Set();
  const state = { label: 'One', swapLog: [], claudeId: 'fixture-first', codexId: null, statusCalls: 0 };
  const accountCtx = {
    dataDir: fs.mkdtempSync(path.join(H.sandbox.dir, 'direct-monitor-')),
    credentialManager: { getSafeList: () => ({ profiles: [] }), getActiveAccountUuid: () => state.claudeId },
    codexAccountManager: { getSafeList: () => ({ accounts: [] }), getActiveAccountId: () => state.codexId },
    mobile: {
      hub: { publish: (topic, type, data) => events.push({ topic, type, data }), publishNotice: (notice) => notices.push(notice) },
      push: { notify: (event) => pushes.push(event) },
    },
  };
  const glass = {
    status: async () => {
      state.statusCalls += 1;
      return { generatedAtMs: Date.now(), accounts: [{ provider: 'claude', id: 'acc-1', label: state.label, active: true, windows: [], state: 'ok' }], swapLog: state.swapLog, swapsEnabled: true };
    },
    apiUp: () => false,
    stateFileAgeMs: () => null,
    readStateFile: () => null,
    watchStateFile: () => () => {},
  };
  let factory = createAccounts;
  if (manualIntervals) {
    const file = path.join(H.REPO_ROOT, 'src/web/mobile/workspace/accounts.js');
    const sandbox = {
      module: { exports: {} }, require: createRequire(file), process,
      setTimeout, clearTimeout,
      setInterval(fn, ms) { const handle = { fn, ms, unref() {} }; intervals.add(handle); return handle; },
      clearInterval(handle) { intervals.delete(handle); },
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
    factory = sandbox.module.exports.createAccounts;
  }
  return { accounts: factory({ ctx: accountCtx, glass }), events, notices, pushes, intervals, state };
}

/** A safe roster with no credential files or vendor network calls. */
function roster() {
  calls.roster += 1;
  return { profiles: [{ profileId: 'fixture-primary', label, email: '', isActive: true, usage: null }] };
}

/** Change only the sandbox listener settings. */
function enable(enabled, extra) { H.seedSettings(ctx.store, Object.assign({}, settings, extra || {}, { enabled })); }

/** Collect the directory watcher's timers in isolation from the real runtime. */
function watcherHarness() {
  const intervals = new Set();
  const timeouts = new Set();
  const watchers = [];
  let unavailable = false;
  const fakeFs = Object.assign({}, fs, {
    watch(folder, fn) {
      if (unavailable) throw Object.assign(new Error('watch unavailable'), { code: 'ENOENT' });
      const watcher = new EventEmitter();
      watcher.folder = folder;
      watcher.notify = fn;
      watcher.closed = false;
      watcher.close = () => { watcher.closed = true; };
      watchers.push(watcher);
      return watcher;
    },
    statSync() { return { mtimeMs: 7 }; },
  });
  const sandbox = {
    module: { exports: {} },
    require: (id) => id === 'fs' ? fakeFs : require(id),
    process,
    setTimeout(fn) { const handle = { fn, unref() {} }; timeouts.add(handle); return handle; },
    clearTimeout(handle) { timeouts.delete(handle); },
    setInterval(fn) { const handle = { fn, unref() {} }; intervals.add(handle); return handle; },
    clearInterval(handle) { intervals.delete(handle); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(H.REPO_ROOT, 'src/web/mobile/workspace/glass-client.js'), 'utf8'), sandbox);
  const folder = path.join(H.sandbox.dir, 'glass-watch-fixture');
  const client = sandbox.module.exports.createGlassClient({ env: { CWM_GLASS_DIR: folder } });
  return { client, folder, watchers, intervals, timeouts, unavailable: (value) => { unavailable = value; }, flush() { for (const t of Array.from(timeouts)) { timeouts.delete(t); t.fn(); } } };
}

test('mounting with the listener disabled reads no rosters and starts no Glass watcher', async () => {
  await mobile.stopMobile();
  mobile._resetForTests();
  const store = getStore();
  H.seedSettings(store, settings);
  ctx = {
    store,
    dataDir: fs.mkdtempSync(path.join(H.sandbox.dir, 'accounts-monitor-')),
    credentialManager: { getSafeList: roster, isCredentialPoolReadOnly: () => false },
    codexAccountManager: { getSafeList: () => ({ accounts: [] }) },
    log: () => {},
    broadcastSSE: () => {},
    mobile: {},
    trackOptions: {
      chat: { screenModel: false },
      workspace: { glass: {
        status: async () => { calls.status += 1; return deferredStatus ? deferredStatus.promise : null; },
        apiUp: () => false,
        stateFileAgeMs: () => null,
        readStateFile: () => null,
        watchStateFile(fn) { calls.watched += 1; activeWatcher = fn; return () => { calls.stopped += 1; activeWatcher = null; }; },
      } },
    },
  };
  const status = await mobile.startMobile(ctx);
  await settle();
  assert.strictEqual(status.running, false);
  assert.ok(ctx.mobile.workspace, 'workspace layout hooks remain mounted');
  assert.deepStrictEqual(calls, { status: 0, roster: 0, watched: 0, stopped: 0 });
  mobile.onAccountChange('credentials:usage');
  await settle();
  assert.strictEqual(calls.status, 0);
});

test('successful listener start begins one monitor and repeated starts are idempotent', async () => {
  enable(true);
  assert.strictEqual((await mobile.restartListener()).running, true);
  await settle();
  assert.strictEqual(calls.watched, 1);
  assert.strictEqual(calls.status, 1);
  assert.ok(calls.roster > 0);
  await mobile.startMobile(ctx);
  await settle();
  assert.strictEqual(calls.watched, 1);
  assert.strictEqual(calls.status, 1);
});

test('credential and provider account events refresh the current safe roster', async () => {
  for (const type of ['credentials:changed', 'credentials:usage', 'credentials:mac', 'provider-accounts:changed', 'provider-accounts:usage']) {
    const before = calls.status;
    label = type;
    mobile.onAccountChange(type);
    await settle();
    assert.strictEqual(calls.status, before + 1, type);
    assert.strictEqual(ctx.mobile.workspace.accounts.snapshot().providers[0].accounts[0].label, type);
  }
  const before = calls.status;
  mobile.onAccountChange('session:updated');
  await settle();
  assert.strictEqual(calls.status, before);
});

test('a Glass state file event refreshes the snapshot', async () => {
  const before = calls.status;
  label = 'File event';
  activeWatcher();
  await settle();
  assert.strictEqual(calls.status, before + 1);
  assert.strictEqual(ctx.mobile.workspace.accounts.snapshot().providers[0].accounts[0].label, label);
});

test('listener disable ignores a late account lookup and queued events', async () => {
  let resolve;
  deferredStatus = { promise: new Promise((done) => { resolve = done; }) };
  const oldSnapshot = ctx.mobile.workspace.accounts.snapshot();
  mobile.onAccountChange('credentials:usage');
  mobile.onAccountChange('provider-accounts:changed');
  const before = { status: calls.status, roster: calls.roster };
  enable(false);
  await mobile.restartListener();
  label = 'Late lookup';
  resolve(null);
  deferredStatus = null;
  await settle();
  assert.strictEqual(calls.stopped, 1);
  assert.strictEqual(activeWatcher, null);
  assert.strictEqual(calls.status, before.status);
  assert.strictEqual(calls.roster, before.roster);
  assert.deepStrictEqual(ctx.mobile.workspace.accounts.snapshot(), oldSnapshot);
  mobile.onAccountChange('credentials:usage');
  await settle();
  assert.strictEqual(calls.status, before.status);
});

test('listener reenable observes changes and shutdown stops it again', async () => {
  enable(true);
  await mobile.restartListener();
  await settle();
  assert.strictEqual(calls.watched, 2);
  assert.strictEqual(ctx.mobile.workspace.accounts.snapshot().providers[0].accounts[0].label, 'Late lookup');
  await mobile.stopMobile();
  assert.strictEqual(calls.stopped, 2);
  const before = calls.status;
  mobile.onAccountChange('provider-accounts:usage');
  await settle();
  assert.strictEqual(calls.status, before);
});

test('a refused listener bind leaves account monitoring stopped', async () => {
  enable(true, { host: '0.0.0.0' });
  const before = calls.status;
  assert.strictEqual((await mobile.restartListener()).running, false);
  await settle();
  assert.strictEqual(calls.status, before);
  assert.strictEqual(calls.watched, 2);
});

test('a listener start completing after stop cannot revive account monitoring', async () => {
  enable(true);
  const listener = mobile.getRuntime().listener;
  const realStart = listener.start;
  const realStatus = listener.status;
  let resolve;
  listener.start = () => new Promise((done) => { resolve = done; });
  listener.status = () => ({ running: true });
  try {
    const pending = mobile.startMobile(ctx);
    await mobile.stopMobile();
    resolve({ running: true });
    await pending;
    await settle();
    assert.strictEqual(calls.watched, 2, 'a stale bind continuation must not restart the monitor');
  } finally {
    listener.start = realStart;
    listener.status = realStatus;
  }
  ctx.mobile.workspace.stop();
  ctx.mobile.chat.stop();
});

test('stop flushes the latest account update for replay after a listener restart', async () => {
  const h = accountHarness();
  try {
    h.accounts.start();
    await sleep(INITIAL_SNAPSHOT_MS);
    h.state.label = 'Two';
    h.accounts.onWorkbookEvent('credentials:changed');
    await sleep(LABEL_CHANGE_WAIT_MS);
    h.state.label = 'Three';
    h.accounts.onWorkbookEvent('credentials:changed');
    await sleep(LABEL_CHANGE_WAIT_MS);
    h.accounts.stop();
    h.accounts.start();
    await sleep(RESTART_SETTLE_MS);
    const updates = h.events.filter((event) => event.type === 'accounts.updated');
    assert.strictEqual(updates[updates.length - 1].data.accounts.providers[0].accounts[0].label, 'Three');
  } finally {
    h.accounts.stop();
  }
});

test('agent swaps logged while monitoring is off become a silent restart baseline', async () => {
  const h = accountHarness();
  try {
    h.accounts.start();
    await sleep(INITIAL_SNAPSHOT_MS);
    h.accounts.stop();
    for (const hours of [2, 3]) h.state.swapLog.push({ source: 'agent', ok: true, atMs: Date.now() - hours * HOUR_MS });
    h.accounts.start();
    await sleep(SWAP_BASELINE_WAIT_MS);
    assert.strictEqual(h.pushes.filter((event) => event.kind === 'swap').length, 0);
    assert.strictEqual(h.notices.filter((notice) => notice.code === 'AGENT_SWAP').length, 0);
  } finally {
    h.accounts.stop();
  }
});

test('local identity changes trigger one refresh and the fingerprint interval stops with monitoring', async () => {
  const h = accountHarness(true);
  try {
    assert.strictEqual(h.intervals.size, 0);
    h.accounts.start();
    await settle();
    assert.strictEqual(h.intervals.size, 1);
    const timer = Array.from(h.intervals)[0];
    assert.strictEqual(timer.ms, FINGERPRINT_CHECK_MS);
    const before = h.state.statusCalls;
    timer.fn();
    await settle();
    assert.strictEqual(h.state.statusCalls, before, 'unchanged local identities do not call Glass');
    h.state.claudeId = 'fixture-second';
    timer.fn();
    await settle();
    assert.strictEqual(h.state.statusCalls, before + 1);
    timer.fn();
    await settle();
    assert.strictEqual(h.state.statusCalls, before + 1, 'the changed identity is remembered');
    h.accounts.stop();
    assert.strictEqual(h.intervals.size, 0);
  } finally {
    h.accounts.stop();
  }
});

test('the Glass directory watcher keeps a slow mtime poll as a safety net', async () => {
  const h = watcherHarness();
  let changes = 0;
  const stop = h.client.watchStateFile(() => { changes += 1; });
  assert.strictEqual(h.intervals.size, 1);
  assert.strictEqual(h.watchers[0].folder, h.folder);
  h.watchers[0].notify('rename', 'state.json');
  h.watchers[0].notify('change', 'state.json');
  h.flush();
  assert.strictEqual(changes, 1, 'atomic replacement events coalesce');
  h.watchers[0].notify('change', 'unrelated.json');
  h.flush();
  assert.strictEqual(changes, 1);
  stop();
  assert.strictEqual(h.intervals.size, 0);
  assert.strictEqual(h.watchers[0].closed, true);
  assert.strictEqual(h.timeouts.size, 0);
});

test('watcher failure falls back to file polling and returns to events on recovery', async () => {
  const h = watcherHarness();
  h.unavailable(true);
  let changes = 0;
  const stop = h.client.watchStateFile(() => { changes += 1; });
  assert.strictEqual(h.intervals.size, 1);
  h.unavailable(false);
  Array.from(h.intervals)[0].fn();
  h.flush();
  assert.strictEqual(changes, 1);
  assert.strictEqual(h.intervals.size, 1);
  h.watchers[0].emit('error', new Error('fixture watch failure'));
  assert.strictEqual(h.intervals.size, 1);
  stop();
  assert.strictEqual(h.intervals.size, 0);
});

H.run('B3 accounts monitor', tests);
