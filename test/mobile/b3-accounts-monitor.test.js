/**
 * b3-accounts-monitor.test.js: listener-scoped account monitoring.
 *
 * WHY: a disabled phone listener must do no account work. Account route
 * events and Glass file events refresh enabled listeners without roster
 * polling, and late async results cannot revive stopped monitoring.
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
const mobile = require('../../src/web/mobile');
const { getStore } = require('../../src/state/store');

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

test('the Glass directory watcher needs no periodic file polling', async () => {
  const h = watcherHarness();
  let changes = 0;
  const stop = h.client.watchStateFile(() => { changes += 1; });
  assert.strictEqual(h.intervals.size, 0);
  assert.strictEqual(h.watchers[0].folder, h.folder);
  h.watchers[0].notify('rename', 'state.json');
  h.watchers[0].notify('change', 'state.json');
  h.flush();
  assert.strictEqual(changes, 1, 'atomic replacement events coalesce');
  h.watchers[0].notify('change', 'unrelated.json');
  h.flush();
  assert.strictEqual(changes, 1);
  stop();
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
  assert.strictEqual(h.intervals.size, 0);
  h.watchers[0].emit('error', new Error('fixture watch failure'));
  assert.strictEqual(h.intervals.size, 1);
  stop();
  assert.strictEqual(h.intervals.size, 0);
});

H.run('B3 accounts monitor', tests);
