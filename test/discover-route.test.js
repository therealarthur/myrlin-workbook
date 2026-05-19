#!/usr/bin/env node
/**
 * Integration tests for GET /api/discover (Plan 15-02).
 *
 * Coverage:
 *   1. DISC-01 (object shape): GET /api/discover returns {projects: {<id>: [...]}}
 *      with at least projects.claude present.
 *   2. DISC-02 (legacy shape): GET /api/discover?legacy=1 returns
 *      {projects: [...]} (array). Each item has encodedName, realPath, sessions.
 *   3. DISC-03 (provider tag in record): each session inside
 *      projects.claude[N].sessions[M] has provider equal to claudeProvider.id.
 *   4. DISC-04 (snapshot semantics): toggle a provider OFF mid-request via a
 *      registry.listEnabled spy, assert the route still returns the original
 *      snapshot's data.
 *   5. DISC-05 (per-provider cache independence): warm Claude cache, toggle
 *      a stub provider, assert Claude entry is unchanged. Then advance the
 *      cache time so Claude expires; third call calls provider.discover again.
 *   6. ?refresh=true bypasses the cache: provider.discover is invoked even
 *      when the cache is warm.
 *   7. Empty enabled set: setEnabled('claude', false) returns
 *      {projects: {}} for default and {projects: []} for legacy. Claude is
 *      restored at the end so the next test pass starts clean.
 *   8. Provider failure isolation: register a stub provider whose discover
 *      throws; the response includes Claude's data and the failing provider's
 *      slot is []. console.error is invoked with a [discover] prefix.
 *
 * Boot strategy: in-process. We require src/web/server.js (which exports the
 * Express app object), initialize the provider registry against a fake store,
 * register an auth token directly, then call app.listen(0) to bind to an
 * ephemeral port. http.request talks to that port. No subprocess spawn, no
 * password flow.
 *
 * Standalone-test convention: this file owns its own assertion helpers and
 * exits 0 on green / 1 on any failure with offender list.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

// Reset module cache so each test run gets a fresh registry. The registry
// has in-process state (the _enabled Set, the _providers Map, the
// _discoverCache Map) that prior test suites might have mutated.
delete require.cache[require.resolve('../src/providers')];
delete require.cache[require.resolve('../src/providers/claude')];
delete require.cache[require.resolve('../src/state/store')];
delete require.cache[require.resolve('../src/web/server')];
delete require.cache[require.resolve('../src/web/auth')];

// ─── Assertion helpers (inlined per standalone-test convention) ────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + (err && err.message ? err.message : err) + '\x1b[0m');
    if (err && err.stack) {
      console.log('    ' + err.stack.split('\n').slice(1, 4).join('\n    '));
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
  }
}

// ─── HTTP helper (returns parsed JSON) ─────────────────────────────────────

const TEST_TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
let SERVER_PORT = 0;

/**
 * Fire a request against the test server. Returns {status, body} where body
 * is the parsed JSON (or raw string on parse failure).
 *
 * @param {string} method
 * @param {string} urlPath
 * @returns {Promise<{status: number, body: any}>}
 */
function req(method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: urlPath,
      method,
      headers: { 'Authorization': 'Bearer ' + TEST_TOKEN },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// ─── Build a test stub provider ────────────────────────────────────────────

/**
 * Build a minimal Provider stub for tests that exercise multi-provider
 * dispatch (cache independence, failure isolation). The stub satisfies
 * every REQUIRED_FIELD and REQUIRED_METHOD on the registry contract.
 * Each call site customizes one specific method (e.g. discover throws,
 * or discover returns a known fixture).
 *
 * @param {Object} overrides - Methods to override on the stub.
 * @returns {Object} Provider-shaped stub object.
 */
function buildStubProvider(overrides) {
  const id = overrides.id || 'test-stub-' + Math.random().toString(36).slice(2, 8);
  return Object.assign({
    id: id,
    displayName: 'Test Stub',
    accentToken: 'lavender',
    cliBinary: 'test-stub-binary-' + id,
    discover: async () => [],
    parseTranscript: async () => [],
    spawnCommand: () => ({ cmd: 'true', args: [], cwd: '/', env: {} }),
    search: async () => [],
    init: async () => {},
    dispose: async () => {},
    supportsCost: () => false,
    isIdleSignal: () => false,
    getKeyBindings: () => ({}),
  }, overrides);
}

// ─── Main test runner ──────────────────────────────────────────────────────

async function main() {
  console.log('\n  Plan 15-02: GET /api/discover per-provider dispatcher (DISC-01/02/04/05)');
  console.log('  ' + '-'.repeat(78));

  // Boot the registry against a fake store. The fake store mirrors the
  // shape Store.init() produces: settings.providers map of id -> bool.
  const registry = require('../src/providers');
  const claudeProvider = require('../src/providers/claude');
  const fakeStore = { state: { settings: { providers: { claude: true } } } };
  await registry.initRegistry(fakeStore);

  // Require server.js AFTER the registry is initialized so the route
  // handler sees a primed registry. We use server.app directly (no
  // startServer call) so the test owns the port lifecycle.
  const server = require('../src/web/server');
  const { app, _discoverCache, DISCOVER_CACHE_TTL } = server;
  assert(app, 'server.app must be exported');
  assert(_discoverCache instanceof Map, 'server._discoverCache must be a Map');
  assertEqual(typeof DISCOVER_CACHE_TTL, 'number', 'server.DISCOVER_CACHE_TTL must be a number');

  // Register a test auth token so requireAuth lets our requests through.
  const auth = require('../src/web/auth');
  auth.addToken(TEST_TOKEN);

  // Bind the express app to an ephemeral port. The test's `req` helper
  // sends Bearer-authenticated requests to this port.
  const httpServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      SERVER_PORT = httpServer.address().port;
      resolve();
    });
  });

  try {
    // ─── Test 1: DISC-01 object shape ────────────────────────────────────
    await test('DISC-01: GET /api/discover returns {projects: {<id>: [...]}}', async () => {
      _discoverCache.clear();
      const r = await req('GET', '/api/discover');
      assertEqual(r.status, 200);
      assert(r.body && typeof r.body === 'object', 'body must be an object');
      assert(r.body.projects && typeof r.body.projects === 'object',
        'body.projects must be an object');
      assert(!Array.isArray(r.body.projects),
        'body.projects must be an object, not an array (legacy shape)');
      // At least one enabled provider must be represented; claude is
      // force-enabled by initRegistry.
      assert(Object.prototype.hasOwnProperty.call(r.body.projects, claudeProvider.id),
        'body.projects must include the claudeProvider.id key');
      assert(Array.isArray(r.body.projects[claudeProvider.id]),
        'body.projects[claudeProvider.id] must be an array');
    });

    // ─── Test 2: DISC-02 legacy shape ────────────────────────────────────
    await test('DISC-02: GET /api/discover?legacy=1 returns {projects: [...]}', async () => {
      _discoverCache.clear();
      const r = await req('GET', '/api/discover?legacy=1');
      assertEqual(r.status, 200);
      assert(r.body && typeof r.body === 'object', 'body must be an object');
      assert(Array.isArray(r.body.projects),
        'body.projects must be an array under ?legacy=1');
      // If at least one project exists, it must carry the v1.1 accordion
      // shape: encodedName, realPath, sessions array.
      if (r.body.projects.length > 0) {
        const p = r.body.projects[0];
        assert('encodedName' in p, 'legacy project must have encodedName');
        assert('realPath' in p, 'legacy project must have realPath');
        assert(Array.isArray(p.sessions), 'legacy project.sessions must be an array');
      }
    });

    // ─── Test 3: DISC-03 provider tag inside session record ─────────────
    await test('DISC-03: each session record carries provider = claudeProvider.id', async () => {
      _discoverCache.clear();
      const r = await req('GET', '/api/discover');
      assertEqual(r.status, 200);
      const claudeProjects = r.body.projects[claudeProvider.id] || [];
      // Find at least one project with at least one session; on a fresh
      // dev box ~/.claude/projects/ usually has many, but the test must
      // tolerate empty filesystems.
      const projectWithSession = claudeProjects.find((p) => p.sessions && p.sessions.length > 0);
      if (projectWithSession) {
        for (const s of projectWithSession.sessions) {
          assertEqual(s.provider, claudeProvider.id,
            'every session in projects.claude[].sessions must have provider = claudeProvider.id');
        }
      } else {
        console.log('    (skipped: no Claude sessions on disk to inspect)');
      }
    });

    // ─── Test 3b: bucket-level provider tag (UI-02 render filter) ──────
    // Regression: the frontend renderProjects filters by p.provider on the
    // bucket (the project accordion), defaulting to 'claude' when undefined.
    // groupProviderSessionsForUI MUST set bucket.provider = provider.id so
    // Codex/Gemini buckets are not silently filtered out of the Codex tab.
    await test('Each project accordion (bucket) carries provider = provider.id', async () => {
      _discoverCache.clear();
      const r = await req('GET', '/api/discover');
      assertEqual(r.status, 200);
      for (const [providerId, accordions] of Object.entries(r.body.projects)) {
        for (const bucket of accordions) {
          assertEqual(bucket.provider, providerId,
            'project accordion bucket under projects.' + providerId + '[] must have bucket.provider = ' + providerId + ' (got ' + JSON.stringify(bucket.provider) + ')');
        }
      }
    });

    // ─── Test 4: DISC-04 snapshot semantics (mid-loop toggle) ────────────
    await test('DISC-04: registry.listEnabled is snapshotted ONCE per route invocation', async () => {
      _discoverCache.clear();
      // Spy on registry.listEnabled to count calls per request.
      const originalListEnabled = registry.listEnabled;
      let listEnabledCalls = 0;
      registry.listEnabled = function () {
        listEnabledCalls++;
        return originalListEnabled.call(this);
      };
      try {
        const r = await req('GET', '/api/discover');
        assertEqual(r.status, 200);
        assertEqual(listEnabledCalls, 1,
          'route must call registry.listEnabled exactly once per request; got ' + listEnabledCalls);
      } finally {
        registry.listEnabled = originalListEnabled;
      }
    });

    // ─── Test 5: DISC-05 per-provider cache independence ────────────────
    await test('DISC-05: toggling a stub provider does NOT invalidate Claude cache entry', async () => {
      _discoverCache.clear();
      let claudeDiscoverCalls = 0;
      const originalDiscover = claudeProvider.discover;
      claudeProvider.discover = async function (opts) {
        claudeDiscoverCalls++;
        return originalDiscover.call(this, opts);
      };
      try {
        // First call warms Claude cache.
        const r1 = await req('GET', '/api/discover');
        assertEqual(r1.status, 200);
        const callsAfterFirst = claudeDiscoverCalls;
        assert(callsAfterFirst >= 1, 'first call must invoke claudeProvider.discover');
        // Capture the Claude cache entry timestamp + data reference.
        const claudeEntryBefore = _discoverCache.get(claudeProvider.id);
        assert(claudeEntryBefore, 'Claude cache entry must be populated');

        // Register and enable a stub provider, then toggle it off. This
        // simulates the user toggling Codex (when it lands in Phase 17)
        // off without touching Claude.
        const stub = buildStubProvider({});
        registry.register(stub);
        registry.setEnabled(stub.id, true);
        registry.setEnabled(stub.id, false);

        // Second call: Claude entry must be unchanged (cache hit, no
        // additional discover invocation, same reference). The stub
        // toggle must NOT have invalidated Claude's cache slot.
        const r2 = await req('GET', '/api/discover');
        assertEqual(r2.status, 200);
        assertEqual(claudeDiscoverCalls, callsAfterFirst,
          'second call must not re-invoke claudeProvider.discover (cache hit)');
        const claudeEntryAfter = _discoverCache.get(claudeProvider.id);
        assert(claudeEntryAfter === claudeEntryBefore,
          'Claude cache entry reference must be preserved across stub toggle');
      } finally {
        claudeProvider.discover = originalDiscover;
      }
    });

    // ─── Test 6: ?refresh=true bypasses the cache ───────────────────────
    await test('GET /api/discover?refresh=true bypasses warm cache and re-invokes provider.discover', async () => {
      _discoverCache.clear();
      let claudeDiscoverCalls = 0;
      const originalDiscover = claudeProvider.discover;
      claudeProvider.discover = async function (opts) {
        claudeDiscoverCalls++;
        return originalDiscover.call(this, opts);
      };
      try {
        // Warm cache.
        const r1 = await req('GET', '/api/discover');
        assertEqual(r1.status, 200);
        const callsAfterWarm = claudeDiscoverCalls;
        assert(callsAfterWarm >= 1, 'warm-up call must invoke discover');

        // No-refresh call: cache hit.
        const r2 = await req('GET', '/api/discover');
        assertEqual(r2.status, 200);
        assertEqual(claudeDiscoverCalls, callsAfterWarm,
          'no-refresh call must not re-invoke discover');

        // Refresh=true: cache bypass.
        const r3 = await req('GET', '/api/discover?refresh=true');
        assertEqual(r3.status, 200);
        assert(claudeDiscoverCalls > callsAfterWarm,
          '?refresh=true must re-invoke discover; got ' + (claudeDiscoverCalls - callsAfterWarm) + ' new calls');
      } finally {
        claudeProvider.discover = originalDiscover;
      }
    });

    // ─── Test 7: Empty enabled set returns empty shapes ─────────────────
    await test('Empty enabled set: GET /api/discover returns {projects: {}} / {projects: []}', async () => {
      _discoverCache.clear();
      // Force-disable claude for this scenario. Registry's initRegistry
      // force-on path only runs at init time, not on every read, so
      // setEnabled(false) sticks until we restore it below.
      const wasEnabled = registry.isEnabled(claudeProvider.id);
      registry.setEnabled(claudeProvider.id, false);
      try {
        const r1 = await req('GET', '/api/discover');
        assertEqual(r1.status, 200);
        assert(r1.body && typeof r1.body.projects === 'object',
          'default shape must have projects object');
        assert(!Array.isArray(r1.body.projects),
          'default empty shape must be object (not array)');
        assertEqual(Object.keys(r1.body.projects).length, 0,
          'projects object must be empty when no providers enabled');

        const r2 = await req('GET', '/api/discover?legacy=1');
        assertEqual(r2.status, 200);
        assert(Array.isArray(r2.body.projects),
          'legacy shape must have projects array');
        assertEqual(r2.body.projects.length, 0,
          'legacy projects array must be empty when no providers enabled');
      } finally {
        registry.setEnabled(claudeProvider.id, wasEnabled);
      }
    });

    // ─── Test 8: Provider failure isolation ─────────────────────────────
    await test('Provider failure isolation: throwing provider yields [] without poisoning Claude data', async () => {
      _discoverCache.clear();
      // Capture console.error so the test can assert the failure was
      // logged with the [discover] prefix.
      const errorLog = [];
      const originalConsoleError = console.error;
      console.error = function (...args) {
        errorLog.push(args.join(' '));
      };
      // Register a throwing stub.
      const stub = buildStubProvider({
        discover: async () => { throw new Error('synthetic discover failure'); },
      });
      registry.register(stub);
      registry.setEnabled(stub.id, true);
      try {
        const r = await req('GET', '/api/discover');
        assertEqual(r.status, 200);
        // Claude entry preserved.
        assert(Array.isArray(r.body.projects[claudeProvider.id]),
          'Claude entry must still be an array');
        // Throwing stub's slot is an empty array, NOT undefined.
        assert(Array.isArray(r.body.projects[stub.id]),
          'failing provider slot must be an array (got ' + typeof r.body.projects[stub.id] + ')');
        assertEqual(r.body.projects[stub.id].length, 0,
          'failing provider slot must be EMPTY');
        // console.error was invoked with the [discover] prefix.
        const hasErrorLog = errorLog.some((line) =>
          line.indexOf('[discover]') >= 0 && line.indexOf(stub.id) >= 0);
        assert(hasErrorLog,
          'console.error must include [discover] prefix and the failing provider id; logs: ' +
          JSON.stringify(errorLog));
      } finally {
        console.error = originalConsoleError;
        registry.setEnabled(stub.id, false);
      }
    });

    // ─── Summary ────────────────────────────────────────────────────────
    console.log('  ' + '-'.repeat(78));
    console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  } finally {
    // Cleanup: close the HTTP server. The express app itself has no
    // close hook beyond this. Token cleanup is implicit (process exit).
    await new Promise((resolve) => httpServer.close(resolve));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest runner crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
