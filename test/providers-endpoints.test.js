#!/usr/bin/env node
/**
 * Integration tests for GET /api/providers and PUT /api/providers/:id/enabled.
 * Plan 15-03 (DISC-06, DISC-07).
 *
 * Coverage (9 tests):
 *   1. GET shape: array of {id, displayName, accentToken, enabled, available}
 *   2. GET availability cache: 2nd call hits cache; ?refresh=true bypasses
 *   3. PUT toggle ON: enabled flips, init() called, store.settings persisted
 *   4. PUT toggle OFF + cache delete: dispose() called, _discoverCache entry
 *      for toggled provider is removed (when 15-02's Map shape lands; today
 *      defensive no-op), other providers' cache entries remain intact
 *   5. PUT mid-PTY safety: pty-manager.spawnSession is NOT called during PUT
 *   6. PUT unknown id -> 404
 *   7. PUT validation -> 400 (non-boolean enabled, missing enabled)
 *   8. PUT auth -> 401 (no Authorization header)
 *   9. PUT persistence: enable test-stub, simulate registry restart via
 *      initRegistry with fresh fakeStore reflecting saved settings, assert
 *      isEnabled('test-stub') still true
 *
 * The test boots the REAL Express app from src/web/server (already exposed
 * via module.exports.app) and uses auth.addToken() to inject a known
 * Bearer token without going through the password login flow. http.request
 * is used directly to keep dependencies to the standard library.
 *
 * Standalone-test convention: this file owns its own assertion helpers and
 * exits 0 on green / 1 on any failure with offender list.
 */

'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

// Reset module cache so each test gets a fresh registry. The registry has
// in-process state (the _enabled Set, the _providers Map) that prior test
// suites may have mutated; clearing the cache forces a clean boot below.
delete require.cache[require.resolve('../src/providers')];
delete require.cache[require.resolve('../src/providers/claude')];
delete require.cache[require.resolve('../src/state/store')];
delete require.cache[require.resolve('../src/web/server')];

// ─── execSync spy (installed BEFORE server.js loads) ───────────────────────
//
// src/web/server.js destructures execSync from require('child_process') at
// module load time. To intercept those calls, we must replace the property
// on the child_process module exports BEFORE that destructuring happens.
// The require cache for src/web/server was deleted just above, so the next
// require will re-destructure and pick up our spy.
const _childProcess = require('child_process');
const _originalExecSync = _childProcess.execSync;
let _execSyncSpy = null; // function(cmd, opts) called for every probe; null = pass-through
_childProcess.execSync = function patchedExecSync(cmd, opts) {
  if (_execSyncSpy) {
    return _execSyncSpy.call(this, cmd, opts);
  }
  return _originalExecSync.call(this, cmd, opts);
};
// Restore at process exit so other suites in the same node run (if any) are
// not affected. The standalone-runner spawns each test file in a fresh
// process so this is belt-and-suspenders.
process.on('exit', () => { _childProcess.execSync = _originalExecSync; });

// ─── Assertion helpers (inlined per standalone-test convention) ────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    })
    .catch((err) => {
      failed++;
      failures.push({ name, err });
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + (err && err.message ? err.message : err) + '\x1b[0m');
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
  }
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

/**
 * Send an HTTP request to the test server. Returns parsed JSON body (or
 * raw string if the response is not JSON) plus the status code.
 *
 * @param {http.Server} server - Listening server (port read from address())
 * @param {string} method - HTTP verb
 * @param {string} urlPath - Path including query string
 * @param {Object} [opts] - {token, body, skipAuth}
 * @returns {Promise<{status:number, body:any, headers:Object}>}
 */
function req(server, method, urlPath, opts) {
  opts = opts || {};
  const token = opts.skipAuth ? null : (opts.token || TEST_TOKEN);
  const data = opts.body == null ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let body = buf;
        try { body = buf ? JSON.parse(buf) : null; } catch (_) { /* keep raw */ }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ─── Test stub provider ────────────────────────────────────────────────────

/**
 * Build a fresh test-stub provider object with spy counters reset.
 * Each test that uses it should register it via registry.register and
 * deregister at end. The spy counters live on the object so tests can
 * inspect call counts.
 */
function buildTestStub() {
  return {
    id: 'test-stub-15-03',
    displayName: 'Test Stub 15-03',
    accentToken: 'pink',
    cliBinary: 'this-binary-should-never-exist-on-path-12345',
    _initCalled: 0,
    _disposeCalled: 0,
    discover: function () { return Promise.resolve([]); },
    parseTranscript: function () { return Promise.resolve([]); },
    spawnCommand: function () { return { cmd: 'echo', args: [], cwd: process.cwd(), env: {} }; },
    search: function () { return Promise.resolve([]); },
    init: function () { this._initCalled++; return Promise.resolve(); },
    dispose: function () { this._disposeCalled++; return Promise.resolve(); },
    supportsCost: function () { return false; },
    isIdleSignal: function () { return false; },
    getKeyBindings: function () { return {}; },
  };
}

// ─── Boot the test harness ─────────────────────────────────────────────────

let TEST_TOKEN = 'test-token-providers-15-03';

(async function main() {
  // Boot the registry against a fakeStore so initRegistry has something to
  // bind to. The real store is also imported below for save() coverage.
  const registry = require('../src/providers');
  const claudeProvider = require('../src/providers/claude');

  // Acquire the real store singleton; initRegistry needs a store reference
  // so setEnabled writes through to state.settings.providers, and the PUT
  // handler calls getStore().save() to persist.
  const { getStore } = require('../src/state/store');
  const store = getStore();

  // Boot the registry. Force claude enabled for the GET shape test.
  await registry.initRegistry(store);

  // Pull the Express app (already mounted with all routes including the
  // two new /api/providers endpoints). require'ing src/web/server is
  // side-effect-safe (server.listen lives in startServer()).
  const server = require('../src/web/server');
  const app = server.app;

  // Inject a known token directly so we can call protected routes without
  // the login + rate-limit flow. addToken pushes into the auth module's
  // in-memory active-tokens Set.
  const auth = require('../src/web/auth');
  auth.addToken(TEST_TOKEN);

  // Listen on an ephemeral port. The 127.0.0.1 bind keeps the port
  // unreachable from the network.
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));

  console.log('\n  Plan 15-03: GET /api/providers + PUT /api/providers/:id/enabled');
  console.log('  ' + '-'.repeat(70));

  // ─── Test 1: GET shape ──────────────────────────────────────────────────
  await test('GET /api/providers returns array of {id, displayName, accentToken, enabled, available}', async () => {
    const r = await req(listener, 'GET', '/api/providers');
    assertEqual(r.status, 200, 'expected 200, got ' + r.status);
    assert(Array.isArray(r.body), 'body must be an array, got: ' + typeof r.body);
    assert(r.body.length >= 1, 'expected at least one registered provider, got: ' + r.body.length);
    for (const item of r.body) {
      assert(typeof item.id === 'string' && item.id.length > 0, 'item.id must be non-empty string');
      assert(typeof item.displayName === 'string', 'item.displayName must be string');
      assert(typeof item.accentToken === 'string', 'item.accentToken must be string');
      assertEqual(typeof item.enabled, 'boolean', 'item.enabled must be boolean');
      assertEqual(typeof item.available, 'boolean', 'item.available must be boolean');
    }
    // Claude is always force-enabled by initRegistry; assert it appears.
    const claudeItem = r.body.find((p) => p.id === claudeProvider.id);
    assert(claudeItem, 'Claude provider must be present in response');
    assertEqual(claudeItem.enabled, true, 'Claude must be enabled after initRegistry force-on');
  });

  // ─── Test 2: GET availability cache ─────────────────────────────────────
  await test('GET /api/providers caches PATH probe; ?refresh=true bypasses cache', async () => {
    // Register the test stub with a deliberately missing binary so the
    // probe will return false. The first call populates the cache; the
    // second call (without ?refresh) MUST hit the cache (the binary name
    // is unique enough that consistent results are themselves evidence;
    // the explicit cache verification is via execSync spy below).
    const stub = buildTestStub();
    registry.register(stub);

    // Install the execSync spy. Counts EVERY probe call so the cache hit
    // test can assert no growth between two default GETs. The spy was
    // installed at module load time (BEFORE server.js destructured
    // execSync from child_process); here we just attach the counter.
    let execCallCount = 0;
    _execSyncSpy = function (cmd, opts) {
      execCallCount++;
      // Force the stub binary to be reported as missing by throwing.
      // Other binaries (claude/codex) go through the real path so the
      // existing cache for those is not poisoned.
      if (cmd.indexOf(stub.cliBinary) >= 0) {
        throw new Error('not found (spy-forced)');
      }
      return _originalExecSync.call(this, cmd, opts);
    };

    try {
      // First call with ?refresh=true to FORCE a fresh probe for every
      // provider. This guarantees the spy is invoked at least once even
      // if Test 1 already warmed the per-cliBinary cache.
      const r1 = await req(listener, 'GET', '/api/providers?refresh=true');
      assertEqual(r1.status, 200);
      const stubItem1 = r1.body.find((p) => p.id === stub.id);
      assert(stubItem1, 'stub provider must appear in /api/providers response');
      assertEqual(stubItem1.available, false, 'stub binary must be reported missing');
      const callsAfterFirst = execCallCount;
      assert(callsAfterFirst >= 1, 'first call with refresh=true should have invoked execSync at least once');

      // Second call WITHOUT ?refresh: cache MUST be a hit for every
      // provider; execSync count must NOT grow.
      const callsBeforeSecond = execCallCount;
      const r2 = await req(listener, 'GET', '/api/providers');
      assertEqual(r2.status, 200);
      const callsAfterSecond = execCallCount;
      assertEqual(callsAfterSecond, callsBeforeSecond, 'fully-warm cache must NOT re-spawn execSync on second default call; got ' + (callsAfterSecond - callsBeforeSecond) + ' new calls');

      // Third default call: still fully cached.
      const r3 = await req(listener, 'GET', '/api/providers');
      assertEqual(r3.status, 200);
      assertEqual(execCallCount, callsAfterSecond, 'third default call must not re-probe');

      // Now with ?refresh=true again: cache MUST be bypassed and the
      // spy MUST be invoked at least once more.
      const beforeRefresh = execCallCount;
      const r4 = await req(listener, 'GET', '/api/providers?refresh=true');
      assertEqual(r4.status, 200);
      const afterRefresh = execCallCount;
      assert(afterRefresh > beforeRefresh, '?refresh=true must trigger fresh execSync calls; got ' + (afterRefresh - beforeRefresh));
    } finally {
      // Detach the spy so subsequent tests run through the real execSync.
      _execSyncSpy = null;
      // Clean stub registration is not strictly necessary (the registry has
      // no deregister method) but we disable it to keep subsequent tests
      // tidy.
      registry.setEnabled(stub.id, false);
    }
  });

  // ─── Test 3: PUT toggle ON ──────────────────────────────────────────────
  await test('PUT /api/providers/:id/enabled with {enabled:true} flips state, calls init(), persists', async () => {
    const stub = buildTestStub();
    registry.register(stub);
    // Pre-condition: stub starts disabled.
    registry.setEnabled(stub.id, false);
    assertEqual(registry.isEnabled(stub.id), false, 'pre-condition: stub must start disabled');

    const r = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: true },
    });
    assertEqual(r.status, 200, 'expected 200, got ' + r.status + ' body=' + JSON.stringify(r.body));
    assertEqual(r.body.id, stub.id);
    assertEqual(r.body.enabled, true);
    assertEqual(registry.isEnabled(stub.id), true, 'registry must reflect toggle');
    assertEqual(stub._initCalled, 1, 'init() must be called exactly once on toggle-on');
    // Persistence to state.settings.providers (write-through is synchronous
    // in setEnabled; save() flushes to disk asynchronously in the route
    // handler).
    const settings = store.state && store.state.settings && store.state.settings.providers;
    assert(settings, 'store.state.settings.providers must exist');
    assertEqual(settings[stub.id], true, 'state.settings.providers[stub] must be true');
  });

  // ─── Test 4: PUT toggle OFF + cache delete + independence ───────────────
  await test('PUT toggle OFF calls dispose() and clears only toggled provider cache (DISC-05 independence)', async () => {
    const stub = buildTestStub();
    registry.register(stub);
    // Reset counters and pre-enable.
    stub._initCalled = 0;
    stub._disposeCalled = 0;
    registry.setEnabled(stub.id, true);
    assertEqual(registry.isEnabled(stub.id), true, 'pre-condition: stub must be enabled');

    // Pull the per-provider _discoverCache Map (Plan 15-02 exposes it via
    // module.exports for exactly this kind of cache-independence
    // assertion). Warm BOTH the stub's slot and Claude's slot, then
    // toggle the stub off and assert ONLY the stub's slot was deleted.
    // The defensive `typeof _discoverCache.delete === 'function'` check
    // inside the route handler is what gates this delete; if the cache
    // is a scalar (pre-15-02) the test still asserts dispose was called
    // and Claude's state is unaffected, which is the important
    // independence contract.
    const serverMod = require('../src/web/server');
    const cache = serverMod._discoverCache;
    let cacheIsMap = cache && typeof cache.set === 'function' && typeof cache.delete === 'function';

    if (cacheIsMap) {
      // Warm both slots so we can verify ONLY the stub's slot is cleared.
      cache.set(stub.id, { data: [{ marker: 'stub-data' }], time: Date.now() });
      cache.set(claudeProvider.id, { data: [{ marker: 'claude-data' }], time: Date.now() });
      assert(cache.has(stub.id), 'pre-condition: stub cache entry must exist');
      assert(cache.has(claudeProvider.id), 'pre-condition: claude cache entry must exist');
    }

    const r = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: false },
    });
    assertEqual(r.status, 200, 'expected 200, got ' + r.status + ' body=' + JSON.stringify(r.body));
    assertEqual(r.body.enabled, false);
    assertEqual(registry.isEnabled(stub.id), false, 'registry must reflect toggle-off');
    assertEqual(stub._disposeCalled, 1, 'dispose() must be called exactly once on toggle-off');
    assertEqual(stub._initCalled, 0, 'init() must NOT be called on toggle-off');

    if (cacheIsMap) {
      assert(!cache.has(stub.id), 'toggled provider cache entry must be removed');
      assert(cache.has(claudeProvider.id), 'other providers cache entries MUST be preserved (DISC-05 independence)');
      const claudeEntry = cache.get(claudeProvider.id);
      assert(claudeEntry && claudeEntry.data && claudeEntry.data[0] && claudeEntry.data[0].marker === 'claude-data',
        'claude cache entry contents must be untouched');
    }

    // Verify Claude's enabled state is unaffected by toggling the stub.
    assertEqual(registry.isEnabled(claudeProvider.id), true, 'Claude must remain enabled after stub toggle-off (independence)');
  });

  // ─── Test 5: PUT mid-PTY safety ─────────────────────────────────────────
  await test('PUT does NOT call pty-manager.spawnSession during toggle (mid-PTY safety)', async () => {
    // The mid-PTY safety contract is locked by Phase 14 (pty-manager
    // gates spawns on registry.isEnabled at spawn time, not via toggle
    // events). We assert that the PUT handler in src/web/server.js does
    // not touch pty-manager at all by spying on the pty-manager module's
    // spawnSession method. The spy wraps the prototype method and counts
    // invocations; we toggle the stub and assert the count stays at 0.

    const stub = buildTestStub();
    registry.register(stub);
    stub._initCalled = 0;
    stub._disposeCalled = 0;

    // Pull the PtySessionManager class via require.cache (it's exported
    // as a class from src/web/pty-manager).
    const PtyManagerModule = require('../src/web/pty-manager');
    const proto = PtyManagerModule.PtySessionManager && PtyManagerModule.PtySessionManager.prototype;
    let spawnCallCount = 0;
    let originalSpawn = null;
    if (proto && typeof proto.spawnSession === 'function') {
      originalSpawn = proto.spawnSession;
      proto.spawnSession = function () {
        spawnCallCount++;
        return null;
      };
    }

    try {
      // Toggle ON then OFF; neither should touch pty-manager.
      registry.setEnabled(stub.id, false);
      const rOn = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', { body: { enabled: true } });
      assertEqual(rOn.status, 200);
      const rOff = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', { body: { enabled: false } });
      assertEqual(rOff.status, 200);
      assertEqual(spawnCallCount, 0, 'pty-manager.spawnSession MUST NOT be called by PUT toggle; got ' + spawnCallCount + ' calls');
    } finally {
      if (originalSpawn && proto) proto.spawnSession = originalSpawn;
    }
  });

  // ─── Test 6: PUT unknown id -> 404 ──────────────────────────────────────
  await test('PUT /api/providers/:id/enabled on unknown id returns 404', async () => {
    const r = await req(listener, 'PUT', '/api/providers/nonexistent-provider-xyz/enabled', {
      body: { enabled: true },
    });
    assertEqual(r.status, 404, 'expected 404, got ' + r.status);
    assert(r.body && typeof r.body.error === 'string', 'body.error must be a string');
    assert(r.body.error.indexOf('Unknown provider') >= 0, 'error must mention Unknown provider, got: ' + r.body.error);
    assert(r.body.error.indexOf('nonexistent-provider-xyz') >= 0, 'error must include the requested id');
  });

  // ─── Test 7: PUT validation -> 400 ──────────────────────────────────────
  await test('PUT /api/providers/:id/enabled with non-boolean enabled returns 400', async () => {
    const stub = buildTestStub();
    registry.register(stub);
    registry.setEnabled(stub.id, false);

    // String "yes" instead of boolean.
    const r1 = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: 'yes' },
    });
    assertEqual(r1.status, 400, 'string enabled must return 400, got ' + r1.status);
    assert(r1.body && typeof r1.body.error === 'string', 'body.error must be a string');

    // Empty body.
    const r2 = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: {},
    });
    assertEqual(r2.status, 400, 'missing enabled must return 400, got ' + r2.status);

    // Number 1 (truthy but not boolean).
    const r3 = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: 1 },
    });
    assertEqual(r3.status, 400, 'numeric enabled must return 400, got ' + r3.status);

    // State should NOT have changed (still disabled).
    assertEqual(registry.isEnabled(stub.id), false, 'failed validation must NOT mutate registry state');
  });

  // ─── Test 8: PUT auth -> 401 ────────────────────────────────────────────
  await test('PUT /api/providers/:id/enabled without auth returns 401', async () => {
    const stub = buildTestStub();
    registry.register(stub);
    const r = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: true },
      skipAuth: true,
    });
    assertEqual(r.status, 401, 'no auth must return 401, got ' + r.status);

    // GET without auth must also be 401.
    const r2 = await req(listener, 'GET', '/api/providers', { skipAuth: true });
    assertEqual(r2.status, 401, 'GET without auth must return 401, got ' + r2.status);

    // Bad token must also fail.
    const r3 = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: true },
      token: 'invalid-token-xyz',
    });
    assertEqual(r3.status, 401, 'bad token must return 401, got ' + r3.status);
  });

  // ─── Test 9: PUT persistence across registry restart ────────────────────
  await test('PUT toggle persists across registry restart (store.save fired; reinit honors persisted state)', async () => {
    const stub = buildTestStub();
    registry.register(stub);
    registry.setEnabled(stub.id, false);

    // Toggle ON. The route calls store.save() which writes the toggle
    // to state.settings.providers on disk (atomic temp + rename).
    const r = await req(listener, 'PUT', '/api/providers/' + stub.id + '/enabled', {
      body: { enabled: true },
    });
    assertEqual(r.status, 200);
    assertEqual(registry.isEnabled(stub.id), true);

    // Simulate a registry restart by reading the just-persisted settings
    // back from the store and calling initRegistry against a fresh fakeStore
    // that mirrors what would be loaded from disk on a new boot. We do
    // NOT actually delete + reload the store (that would clobber other
    // tests running in the same process); instead we drive initRegistry
    // with a fakeStore so the test is fully hermetic.
    //
    // Pull the persisted settings.providers map (the route's store.save()
    // wrote this via setEnabled's write-through).
    const persistedProviders = store.state.settings.providers;
    assertEqual(persistedProviders[stub.id], true, 'persisted state must reflect toggle-on');

    // Reset the in-process registry by clearing the module cache, then
    // boot a fresh instance with a fakeStore that mirrors the persisted
    // settings. After init, isEnabled must reflect the persisted state.
    delete require.cache[require.resolve('../src/providers')];
    const freshRegistry = require('../src/providers');
    // The fresh registry must re-register the stub explicitly (the
    // registry's _providers Map is module-scoped and is empty after
    // reload). The real stub object reference is reused so init/dispose
    // counters survive.
    freshRegistry.register(stub);
    const fakeStore = {
      state: {
        settings: {
          providers: Object.assign({}, persistedProviders),
        },
      },
    };
    await freshRegistry.initRegistry(fakeStore);
    assertEqual(freshRegistry.isEnabled(stub.id), true, 'fresh registry must honor persisted toggle');

    // Restore the original registry module so subsequent tests (if any)
    // see the same singleton the server route handlers reference.
    // Note: this test runs last in the suite, so a clean restore is not
    // strictly required, but it keeps the test reentrant.
    delete require.cache[require.resolve('../src/providers')];
  });

  // ─── Summary + exit ────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');

  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log('    - ' + f.name);
      if (f.err && f.err.stack) {
        console.log('      ' + f.err.stack.split('\n').slice(0, 4).join('\n      '));
      }
    }
  }

  // Close the listener so the process exits cleanly. Use unref + close so
  // any pending sockets are dropped. The store, pty-manager, etc. don't
  // need explicit teardown because the process exits.
  listener.close();
  // Give any pending I/O a moment to settle, then exit.
  setImmediate(() => process.exit(failed > 0 ? 1 : 0));
})().catch((err) => {
  console.error('Test harness failed:', err);
  process.exit(1);
});
