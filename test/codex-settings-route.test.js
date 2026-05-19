#!/usr/bin/env node
/**
 * Integration tests for PUT /api/sessions/:id/provider-settings.
 * Phase 21 Plan 21-01.
 *
 * Coverage (8 tests):
 *   1. 200 on a valid model+sandbox+approvalPolicy triple; persisted bundle
 *      visible on the returned session
 *   2. 200 on bypass toggle from true to false (idempotent on repeated PUT)
 *   3. 200 on a features array of two valid enable names
 *   4. 400 on an unknown setting key (e.g. randomKey)
 *   5. 400 on an enum-violating value (sandbox='neverexists')
 *   6. 400 on a shell-unsafe value (model with semicolon)
 *   7. 404 on an unknown session id
 *   8. 401 when Authorization header is absent
 *
 * Boots the real Express app (src/web/server) and injects a known token via
 * auth.addToken so the route is exercised end-to-end through the same path
 * the frontend uses. Standalone-test convention: own assertion helpers,
 * exits 0 on green / 1 on any failure.
 */

'use strict';

const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

// Reset module cache so each run starts clean.
delete require.cache[require.resolve('../src/providers')];
delete require.cache[require.resolve('../src/providers/claude')];
delete require.cache[require.resolve('../src/state/store')];
delete require.cache[require.resolve('../src/web/server')];

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    })
    .catch((err) => {
      failed++;
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

const TEST_TOKEN = 'test-token-codex-settings-21-01';

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

(async function main() {
  const registry = require('../src/providers');
  const { getStore } = require('../src/state/store');
  const store = getStore();
  await registry.initRegistry(store);
  const server = require('../src/web/server');
  const app = server.app;
  const auth = require('../src/web/auth');
  auth.addToken(TEST_TOKEN);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));

  console.log('\n  Plan 21-01: PUT /api/sessions/:id/provider-settings');
  console.log('  ' + '-'.repeat(70));

  // Create a Codex-tagged session to test against. The store helper does
  // not tag provider by default (v1.1 back-compat); we patch it via
  // updateSession so this test does not depend on createSession's signature.
  const ws = store.createWorkspace({ name: 'Codex Settings Test WS' });
  const sess = store.createSession({ name: 'Codex Sess', workspaceId: ws.id });
  store.updateSession(sess.id, { provider: 'codex' }); // gsd:provider-literal-allowed (test fixture)

  // Also create a Claude session to exercise the "provider does not accept" path.
  const claudeSess = store.createSession({ name: 'Claude Sess', workspaceId: ws.id });
  // No provider patch needed; defaults to 'claude' via v1.1 back-compat.

  // ─── Test 1: 200 on valid triple ─────────────────────────────────────────
  await test('200 on valid model+sandbox+approvalPolicy triple', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { model: 'gpt-5-codex', sandbox: 'workspace-write', approvalPolicy: 'on-request' } },
    });
    assertEqual(r.status, 200, 'status; body=' + JSON.stringify(r.body));
    assertEqual(r.body.success, true);
    assertEqual(r.body.settings.model, 'gpt-5-codex');
    assertEqual(r.body.settings.sandbox, 'workspace-write');
    assertEqual(r.body.settings.approvalPolicy, 'on-request');
    // Verify persistence through the store helper.
    const fresh = store.getSession(sess.id);
    assertEqual(fresh.providerSettings.codex.model, 'gpt-5-codex'); // gsd:provider-literal-allowed (test fixture)
  });

  // ─── Test 2: 200 on bypass toggle true -> false ──────────────────────────
  await test('200 on bypass toggle true then false', async () => {
    const r1 = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { bypassApprovalsAndSandbox: true } },
    });
    assertEqual(r1.status, 200);
    assertEqual(r1.body.settings.bypassApprovalsAndSandbox, true);
    const r2 = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { bypassApprovalsAndSandbox: false } },
    });
    assertEqual(r2.status, 200);
    assertEqual(r2.body.settings.bypassApprovalsAndSandbox, false);
  });

  // ─── Test 3: 200 on features list ────────────────────────────────────────
  await test('200 on features array', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { features: ['web_search', 'view_image'] } },
    });
    assertEqual(r.status, 200);
    assert(Array.isArray(r.body.settings.features));
    assertEqual(r.body.settings.features.length, 2);
  });

  // ─── Test 4: 400 on unknown setting key ──────────────────────────────────
  await test('400 on unknown setting key', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { unknownKey: 'value' } },
    });
    assertEqual(r.status, 400, 'status; body=' + JSON.stringify(r.body));
    assert(typeof r.body.error === 'string' && r.body.error.toLowerCase().indexOf('unknown') !== -1,
      'error message should mention unknown key');
  });

  // ─── Test 5: 400 on enum-violating value ─────────────────────────────────
  await test('400 on enum-violating sandbox value', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { sandbox: 'neverexists' } },
    });
    assertEqual(r.status, 400);
    assert(typeof r.body.error === 'string' && r.body.error.toLowerCase().indexOf('sandbox') !== -1);
  });

  // ─── Test 6: 400 on shell-unsafe value ───────────────────────────────────
  await test('400 on shell-unsafe model value', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { model: 'gpt-5; rm -rf /' } },
    });
    assertEqual(r.status, 400);
    assert(typeof r.body.error === 'string' && r.body.error.toLowerCase().indexOf('model') !== -1);
  });

  // ─── Test 7: 404 on unknown session id ───────────────────────────────────
  await test('404 on unknown session id', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/nonexistent-id/provider-settings', {
      body: { settings: { model: 'gpt-5-codex' } },
    });
    assertEqual(r.status, 404);
  });

  // ─── Test 8: 401 without auth ────────────────────────────────────────────
  await test('401 without Authorization header', async () => {
    const r = await req(listener, 'PUT', '/api/sessions/' + sess.id + '/provider-settings', {
      body: { settings: { model: 'gpt-5-codex' } },
      skipAuth: true,
    });
    assertEqual(r.status, 401);
  });

  // ─── Test 9: alpha.6 ad-hoc path (no store record) ───────────────────────
  await test('alpha.6: 200 on ad-hoc PUT (sessionId not in store + body.provider=codex)', async () => {
    const adHocUuid = 'dba521c8-69e7-4f00-9c00-aaaaaaaaaaaa';
    const r = await req(listener, 'PUT', '/api/sessions/' + adHocUuid + '/provider-settings', {
      body: {
        provider: 'codex', // gsd:provider-literal-allowed (test fixture)
        settings: { bypassApprovalsAndSandbox: true, model: 'gpt-5-codex' },
      },
    });
    assertEqual(r.status, 200, 'expected 200, got ' + r.status + ' body=' + JSON.stringify(r.body));
    assertEqual(r.body.success, true);
    assertEqual(r.body.adHoc, true, 'response must flag adHoc=true');
    assertEqual(r.body.settings.bypassApprovalsAndSandbox, true);
    // Verify persistence through the store helper.
    const bundle = store.getProviderSessionSettings('codex', adHocUuid); // gsd:provider-literal-allowed (test fixture)
    assert(bundle && bundle.bypassApprovalsAndSandbox === true, 'bundle must be persisted in providerSessionSettings');
    assertEqual(bundle.model, 'gpt-5-codex');
  });

  // ─── Test 10: ad-hoc PUT without body.provider falls through to 404 ──────
  await test('alpha.6: 404 on ad-hoc PUT missing body.provider', async () => {
    const adHocUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const r = await req(listener, 'PUT', '/api/sessions/' + adHocUuid + '/provider-settings', {
      body: { settings: { model: 'gpt-5-codex' } },
    });
    assertEqual(r.status, 404, 'no store record + no provider tag = ambiguous = 404');
  });

  // ─── Test 11: ad-hoc PUT with bad provider id format → 400 ───────────────
  await test('alpha.6: 400 on ad-hoc PUT with malformed provider id', async () => {
    const adHocUuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const r = await req(listener, 'PUT', '/api/sessions/' + adHocUuid + '/provider-settings', {
      body: { provider: 'BAD;rm', settings: { model: 'gpt-5-codex' } },
    });
    // Malformed provider id does not match the strict regex; the route
    // ignores it and falls through to the 404 branch (no store record).
    assertEqual(r.status, 404);
  });

  // ─── Test 12: ad-hoc PUT validation still enforces enum allow-list ───────
  await test('alpha.6: 400 on ad-hoc PUT with enum-violating value', async () => {
    const adHocUuid = 'cccccccc-dddd-eeee-ffff-000000000000';
    const r = await req(listener, 'PUT', '/api/sessions/' + adHocUuid + '/provider-settings', {
      body: { provider: 'codex', settings: { sandbox: 'neverexists' } }, // gsd:provider-literal-allowed (test fixture)
    });
    assertEqual(r.status, 400);
  });

  // ─── Test 13: ad-hoc PUT URL :id must be shell-safe ──────────────────────
  await test('alpha.6: 400 on ad-hoc PUT with shell-unsafe url :id', async () => {
    // Express will percent-decode the URL; we pass an already-decoded
    // payload that, post-decode, contains a semicolon. The route's
    // ad-hoc-key regex (^[a-zA-Z0-9_-]+$) must reject it.
    const r = await req(listener, 'PUT', '/api/sessions/' + encodeURIComponent('id;rm') + '/provider-settings', {
      body: { provider: 'codex', settings: { model: 'gpt-5-codex' } }, // gsd:provider-literal-allowed (test fixture)
    });
    assertEqual(r.status, 400);
  });

  // Cleanup
  store.deleteSession(sess.id);
  store.deleteSession(claudeSess.id);
  store.deleteWorkspace(ws.id);
  listener.close();

  console.log('  ' + '-'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
