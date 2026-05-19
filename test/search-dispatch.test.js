#!/usr/bin/env node
/**
 * Integration tests for GET /api/search dispatcher (Plan 16-01).
 *
 * Coverage:
 *   1. SRCH-01: dispatcher calls every enabled provider's .search() exactly once
 *   2. SRCH-01: results merged in one ranked list (descending timestamp)
 *   3. SRCH-02: each result carries its provider field (provider tags itself)
 *   4. SRCH-03: partial=true when one provider self-reports timedOut: true
 *   5. SRCH-03: partial=true when racedSearch hard timeout fires (provider sleeps past grace)
 *   6. SRCH-03: partial=true when a provider rejects; other providers' results preserved
 *   7. SRCH-04: per-provider time budget = floor(SEARCH_TOTAL_BUDGET_MS / enabled.length)
 *   8. SRCH-06: no per-provider Worker spawn (active-handle proxy assertion)
 *   9. Legacy alias: response.timedOut === response.partial
 *  10. Empty enabled set: response is {results: [], partial: false, timedOutProviders: []}
 *  11. Input validation preserved: q < 2 chars OR missing q returns 400
 *
 * Boot strategy: in-process Express on an ephemeral port. Mirrors
 * test/discover-route.test.js exactly so future maintainers find the
 * same shape across dispatcher tests.
 *
 * Plan 16-01 (Phase 16). Requirements SRCH-01..04, SRCH-06.
 */

'use strict';

const http = require('http');
const path = require('path');
const worker_threads = require('worker_threads');

// Sandbox CWM_DATA_DIR into a tmpdir; see test/_test-data-dir.js.
require('./_test-data-dir');

// Reset module cache for the modules that hold provider-registry / server
// state, so the test boots from a clean slate even when run after other
// in-process tests in the same suite.
delete require.cache[require.resolve('../src/providers')];
delete require.cache[require.resolve('../src/providers/claude')];
delete require.cache[require.resolve('../src/state/store')];
delete require.cache[require.resolve('../src/web/server')];
delete require.cache[require.resolve('../src/web/auth')];

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Run a single named test inside the suite. Captures pass/fail counts and
 * the first three lines of any thrown error's stack so the runner output
 * is informative without being noisy.
 *
 * @param {string} name - Short test description.
 * @param {function():Promise<void>} fn - Async test body that throws on failure.
 */
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
    if (err && err.stack) console.log('    ' + err.stack.split('\n').slice(1, 4).join('\n    '));
  }
}

/**
 * Lightweight assertion helper. Throws on falsy condition with the supplied
 * message (or a generic one).
 */
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

/**
 * Strict-equality assertion with a default message that surfaces both
 * actual and expected for quick diagnosis.
 */
function assertEqual(a, e, msg) {
  if (a !== e) throw new Error(msg || ('Expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)));
}

const TEST_TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
let SERVER_PORT = 0;

/**
 * Issue an in-process HTTP request against the booted server. Returns
 * {status, body} where body is JSON-parsed when possible (else raw string).
 */
function req(method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method,
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

/**
 * Build a Provider stub. Every required method is present; overrides
 * customize specific methods. Mirrors test/discover-route.test.js
 * buildStubProvider exactly so future maintainers find the same shape
 * across dispatcher tests.
 *
 * @param {Object} overrides - Partial Provider overrides; id is auto-generated if absent.
 * @returns {Object} A Provider-shaped object suitable for registry.register.
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
    search: async () => ({ results: [], timedOut: false, searchedFiles: 0 }),
    init: async () => {},
    dispose: async () => {},
    supportsCost: () => false,
    isIdleSignal: () => false,
    getKeyBindings: () => ({}),
  }, overrides);
}

async function main() {
  console.log('\n  Plan 16-01: GET /api/search Promise.allSettled dispatcher (SRCH-01..04, SRCH-06)');
  console.log('  ' + '-'.repeat(78));

  const registry = require('../src/providers');
  const claudeProvider = require('../src/providers/claude');
  const fakeStore = { state: { settings: { providers: { claude: true } } } };
  await registry.initRegistry(fakeStore);
  void claudeProvider; // referenced to ensure require path is wired

  const server = require('../src/web/server');
  const { app, SEARCH_TOTAL_BUDGET_MS, SEARCH_TIMEOUT_GRACE_MS, racedSearch } = server;
  assert(app, 'server.app must be exported');
  assertEqual(typeof SEARCH_TOTAL_BUDGET_MS, 'number');
  assertEqual(typeof SEARCH_TIMEOUT_GRACE_MS, 'number');
  assertEqual(typeof racedSearch, 'function');

  const auth = require('../src/web/auth');
  auth.addToken(TEST_TOKEN);

  const httpServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      SERVER_PORT = httpServer.address().port;
      resolve();
    });
  });

  try {
    // ── Test 1: SRCH-01 dispatcher calls every enabled provider exactly once ──
    await test('SRCH-01: dispatcher invokes every enabled provider .search() exactly once', async () => {
      const stubA = buildStubProvider({ id: 'stub-a-' + Date.now() });
      const stubB = buildStubProvider({ id: 'stub-b-' + Date.now() });
      let aCalls = 0, bCalls = 0;
      stubA.search = async () => { aCalls++; return { results: [], timedOut: false, searchedFiles: 0 }; };
      stubB.search = async () => { bCalls++; return { results: [], timedOut: false, searchedFiles: 0 }; };
      registry.register(stubA); registry.register(stubB);
      registry.setEnabled(stubA.id, true); registry.setEnabled(stubB.id, true);
      try {
        const r = await req('GET', '/api/search?q=hello&limit=10');
        assertEqual(r.status, 200);
        assertEqual(aCalls, 1, 'stub A search called once');
        assertEqual(bCalls, 1, 'stub B search called once');
      } finally {
        registry.setEnabled(stubA.id, false);
        registry.setEnabled(stubB.id, false);
      }
    });

    // ── Test 2: SRCH-01 results merged + sorted by descending timestamp ──
    await test('SRCH-01: results merged across providers; sorted desc by timestamp', async () => {
      const older = '2026-04-01T00:00:00Z';
      const newer = '2026-05-01T00:00:00Z';
      const stubA = buildStubProvider({ id: 'sort-a-' + Date.now() });
      const stubB = buildStubProvider({ id: 'sort-b-' + Date.now() });
      stubA.search = async () => ({ results: [{ provider: stubA.id, sessionId: 'a1', timestamp: older, snippet: 'old', role: 'user' }], timedOut: false, searchedFiles: 1 });
      stubB.search = async () => ({ results: [{ provider: stubB.id, sessionId: 'b1', timestamp: newer, snippet: 'new', role: 'user' }], timedOut: false, searchedFiles: 1 });
      registry.register(stubA); registry.register(stubB);
      registry.setEnabled(stubA.id, true); registry.setEnabled(stubB.id, true);
      // Disable Claude so the merge contains exactly the two stub results (deterministic).
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed (test fixture; toggle restored in finally)
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        assertEqual(r.body.results.length, 2);
        assertEqual(r.body.results[0].timestamp, newer, 'newest first');
        assertEqual(r.body.results[1].timestamp, older);
      } finally {
        registry.setEnabled(stubA.id, false);
        registry.setEnabled(stubB.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed (restore)
      }
    });

    // ── Test 3: SRCH-02 each result carries its provider field ──
    await test('SRCH-02: each result carries its provider field set by source', async () => {
      const stubA = buildStubProvider({ id: 'tag-a-' + Date.now() });
      const stubB = buildStubProvider({ id: 'tag-b-' + Date.now() });
      stubA.search = async () => ({ results: [{ provider: stubA.id, sessionId: 'a1', timestamp: '2026-05-01T00:00:00Z', snippet: 'x', role: 'user' }], timedOut: false, searchedFiles: 1 });
      stubB.search = async () => ({ results: [{ provider: stubB.id, sessionId: 'b1', timestamp: '2026-05-02T00:00:00Z', snippet: 'y', role: 'user' }], timedOut: false, searchedFiles: 1 });
      registry.register(stubA); registry.register(stubB);
      registry.setEnabled(stubA.id, true); registry.setEnabled(stubB.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed (test fixture)
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        const ids = new Set(r.body.results.map((x) => x.provider));
        assert(ids.has(stubA.id), 'stub A provider tag present');
        assert(ids.has(stubB.id), 'stub B provider tag present');
        for (const result of r.body.results) {
          assert(typeof result.provider === 'string' && result.provider.length > 0, 'every result has provider');
        }
      } finally {
        registry.setEnabled(stubA.id, false);
        registry.setEnabled(stubB.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 4: SRCH-03 partial=true when provider self-reports timedOut ──
    await test('SRCH-03: provider self-reports timedOut: true means partial: true and timedOutProviders includes id', async () => {
      const stubSlow = buildStubProvider({ id: 'self-slow-' + Date.now() });
      stubSlow.search = async () => ({ results: [{ provider: stubSlow.id, sessionId: 's1', timestamp: '2026-05-01T00:00:00Z', snippet: 'partial result', role: 'user' }], timedOut: true, searchedFiles: 1 });
      const stubFast = buildStubProvider({ id: 'fast-' + Date.now() });
      stubFast.search = async () => ({ results: [{ provider: stubFast.id, sessionId: 'f1', timestamp: '2026-05-02T00:00:00Z', snippet: 'fast', role: 'user' }], timedOut: false, searchedFiles: 1 });
      registry.register(stubSlow); registry.register(stubFast);
      registry.setEnabled(stubSlow.id, true); registry.setEnabled(stubFast.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        assertEqual(r.body.partial, true);
        assert(r.body.timedOutProviders.includes(stubSlow.id), 'slow stub in timedOutProviders');
        assertEqual(r.body.results.length, 2, 'both stubs results merged (slow stub returned partial data)');
      } finally {
        registry.setEnabled(stubSlow.id, false);
        registry.setEnabled(stubFast.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 5: SRCH-03 racedSearch hard timeout fires ──
    await test('SRCH-03: racedSearch hard timeout (provider sleeps past grace) means partial: true', async () => {
      // With 2 enabled providers, each gets floor(5000/2)=2500ms; we make
      // our slow stub sleep > 2500ms + 100ms grace. Test runs in ~2.7s.
      const stubVerySlow = buildStubProvider({ id: 'race-slow-' + Date.now() });
      stubVerySlow.search = async () => {
        await new Promise((r) => setTimeout(r, 2700)); // exceeds 2500 + 100 grace
        return { results: [{ provider: stubVerySlow.id, sessionId: 'never', timestamp: '2026-05-01T00:00:00Z', snippet: 'never seen', role: 'user' }], timedOut: false, searchedFiles: 1 };
      };
      const stubFast = buildStubProvider({ id: 'race-fast-' + Date.now() });
      stubFast.search = async () => ({ results: [{ provider: stubFast.id, sessionId: 'f1', timestamp: '2026-05-02T00:00:00Z', snippet: 'fast', role: 'user' }], timedOut: false, searchedFiles: 1 });
      registry.register(stubVerySlow); registry.register(stubFast);
      registry.setEnabled(stubVerySlow.id, true); registry.setEnabled(stubFast.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        assertEqual(r.body.partial, true);
        assert(r.body.timedOutProviders.includes(stubVerySlow.id), 'slow stub timed out');
        // Fast stub's result should still be in the merged list.
        const fastResult = r.body.results.find((x) => x.provider === stubFast.id);
        assert(fastResult, 'fast stub result preserved');
      } finally {
        registry.setEnabled(stubVerySlow.id, false);
        registry.setEnabled(stubFast.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 6: SRCH-03 provider rejects → partial=true, others preserved ──
    await test('SRCH-03: provider rejects means console.error logged, partial=true, others merged', async () => {
      const origConsoleError = console.error;
      let errorLogged = false;
      console.error = (msg) => { if (typeof msg === 'string' && msg.includes('[search]')) errorLogged = true; };
      const stubBoom = buildStubProvider({ id: 'boom-' + Date.now() });
      stubBoom.search = async () => { throw new Error('provider exploded'); };
      const stubOK = buildStubProvider({ id: 'ok-' + Date.now() });
      stubOK.search = async () => ({ results: [{ provider: stubOK.id, sessionId: 'ok1', timestamp: '2026-05-02T00:00:00Z', snippet: 'fine', role: 'user' }], timedOut: false, searchedFiles: 1 });
      registry.register(stubBoom); registry.register(stubOK);
      registry.setEnabled(stubBoom.id, true); registry.setEnabled(stubOK.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        assertEqual(r.body.partial, true);
        assert(r.body.timedOutProviders.includes(stubBoom.id), 'boom stub in timedOutProviders');
        assert(errorLogged, 'console.error invoked with [search] prefix');
        const okResult = r.body.results.find((x) => x.provider === stubOK.id);
        assert(okResult, 'ok stub result preserved');
      } finally {
        console.error = origConsoleError;
        registry.setEnabled(stubBoom.id, false);
        registry.setEnabled(stubOK.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 7: SRCH-04 per-provider budget split ──
    await test('SRCH-04: per-provider budget = floor(SEARCH_TOTAL_BUDGET_MS / enabled.length)', async () => {
      let receivedBudget1 = null;
      const stubBudget1 = buildStubProvider({ id: 'budget1-' + Date.now() });
      stubBudget1.search = async (args) => { receivedBudget1 = args.timeBudgetMs; return { results: [], timedOut: false, searchedFiles: 0 }; };
      registry.register(stubBudget1);
      // Single enabled provider (Claude force-disabled): full budget.
      registry.setEnabled(stubBudget1.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      try {
        await req('GET', '/api/search?q=any&limit=10');
        assertEqual(receivedBudget1, SEARCH_TOTAL_BUDGET_MS, 'single provider receives full budget');
      } finally {
        registry.setEnabled(stubBudget1.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }

      // Two enabled providers: half budget each.
      let received1 = null, received2 = null;
      const stubA = buildStubProvider({ id: 'budgetA-' + Date.now() });
      stubA.search = async (args) => { received1 = args.timeBudgetMs; return { results: [], timedOut: false, searchedFiles: 0 }; };
      const stubB = buildStubProvider({ id: 'budgetB-' + Date.now() });
      stubB.search = async (args) => { received2 = args.timeBudgetMs; return { results: [], timedOut: false, searchedFiles: 0 }; };
      registry.register(stubA); registry.register(stubB);
      registry.setEnabled(stubA.id, true); registry.setEnabled(stubB.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      try {
        await req('GET', '/api/search?q=any&limit=10');
        assertEqual(received1, Math.floor(SEARCH_TOTAL_BUDGET_MS / 2));
        assertEqual(received2, Math.floor(SEARCH_TOTAL_BUDGET_MS / 2));
      } finally {
        registry.setEnabled(stubA.id, false);
        registry.setEnabled(stubB.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 8: SRCH-06 no Worker spawn ──
    // We use process._getActiveHandles() as a coarse proxy: a per-provider
    // worker spawn would add N persistent handles. Monkey-patching the
    // worker_threads.Worker constructor is brittle (the registry's
    // require('worker_threads') is a separate module-cache entry) so the
    // handle-count proxy is the practical assertion. The dispatcher should
    // not allocate any worker_threads.Worker; the only Worker in the
    // process is the cost-worker (one), which already exists from boot.
    await test('SRCH-06: search call does not spawn additional worker_threads.Worker', async () => {
      const handlesBefore = process._getActiveHandles ? process._getActiveHandles().length : 0;
      await req('GET', '/api/search?q=any&limit=10');
      await req('GET', '/api/search?q=any&limit=10');
      const handlesAfter = process._getActiveHandles ? process._getActiveHandles().length : 0;
      // Allow some delta (transient timers, sockets) but no large additions
      // that would indicate per-provider worker spawn. Practical check:
      // delta < 10 across two searches; the search path should not allocate
      // more than a handful of transient handles.
      assert(Math.abs(handlesAfter - handlesBefore) < 10, 'no excessive handle growth across two searches');
      // Reference worker_threads to keep the import live (so a future
      // refactor that introduces a worker can be caught by extending this
      // test with a Worker-constructor spy).
      void worker_threads;
    });

    // ── Test 9: legacy alias timedOut === partial ──
    await test('Legacy alias: response.timedOut === response.partial', async () => {
      const stubBoom = buildStubProvider({ id: 'legacy-' + Date.now() });
      stubBoom.search = async () => { throw new Error('boom'); };
      registry.register(stubBoom);
      registry.setEnabled(stubBoom.id, true);
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      // Silence the expected console.error so the suite output stays clean.
      const origConsoleError = console.error;
      console.error = () => {};
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        assertEqual(r.body.timedOut, r.body.partial);
        assertEqual(r.body.partial, true);
      } finally {
        console.error = origConsoleError;
        registry.setEnabled(stubBoom.id, false);
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 10: empty enabled set ──
    await test('Empty enabled set: response.results is empty array, partial=false', async () => {
      // Disable Claude; no other enabled providers.
      registry.setEnabled('claude', false); // gsd:provider-literal-allowed
      try {
        const r = await req('GET', '/api/search?q=any&limit=10');
        assertEqual(r.status, 200);
        assertEqual(r.body.results.length, 0);
        assertEqual(r.body.partial, false);
        assertEqual(r.body.timedOutProviders.length, 0);
        assertEqual(r.body.timedOut, false);
      } finally {
        registry.setEnabled('claude', true); // gsd:provider-literal-allowed
      }
    });

    // ── Test 11: input validation preserved ──
    await test('Input validation: q < 2 chars or missing returns 400 with error message', async () => {
      const r1 = await req('GET', '/api/search?q=a');
      assertEqual(r1.status, 400);
      assert(r1.body && typeof r1.body.error === 'string', 'error message present');
      const r2 = await req('GET', '/api/search');
      assertEqual(r2.status, 400);
      const r3 = await req('GET', '/api/search?q=ok');
      assertEqual(r3.status, 200, '2-char query should pass');
    });

  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  console.log('  ' + '-'.repeat(78));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    for (const f of failures) {
      console.log('    ✗ ' + f.name + ': ' + (f.err && f.err.message ? f.err.message : f.err));
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
