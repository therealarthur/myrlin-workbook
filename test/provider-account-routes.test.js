#!/usr/bin/env node
/**
 * Integration tests for src/web/provider-account-routes.js.
 *
 * Real Express app + a real generic manager over a sandboxed fixture
 * capability (design doc Part 8.3): 401 without bearer on all six routes,
 * unknown provider 404, the full route surface (list, refresh-usage,
 * apply, capture, label, delete), SSE broadcast type + payload key
 * discipline (accountId/providerId, NEVER a bare `id` key that
 * broadcastSSE would misfile as a workspace id), and the response
 * token-material leak gate.
 *
 * Hermetic: CWM_DATA_DIR sandboxed FIRST, fixture home dirs inside it,
 * a local http stub for the usage URL, SYNTHETIC JWTs only. Nothing
 * touches the real ~/.codex, ~/.myrlin, or ~/.claude, and src/web/server
 * is never loaded (no real capability paths in play).
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

const express = require('express');
const { accountsCapability } = require('../src/providers/codex/accounts');
const { createProviderAccountManager } = require('../src/web/provider-account-manager');
const { setupProviderAccountRoutes, EVENT_CHANGED, EVENT_USAGE } = require('../src/web/provider-account-routes');

let passed = 0;
let failed = 0;

/**
 * Minimal async test harness: runs fn, records pass/fail, prints result.
 * @param {string} name @param {Function} fn @returns {Promise<void>}
 */
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    })
    .catch((err) => {
      failed += 1;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + ((err && err.message) || err) + '\x1b[0m');
    });
}

/** Assert a condition. @param {*} cond @param {string} [msg] */
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

/** Assert strict equality. @param {*} a @param {*} e @param {string} [msg] */
function assertEqual(a, e, msg) {
  if (a !== e) throw new Error(msg || ('Expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)));
}

// ─── Synthetic fixtures (NEVER real tokens) ────────────────────────────────

const UUID_A = 'aaaaaaaa-1111-2222-3333-777777777701'; // active in the fixture home
const UUID_B = 'bbbbbbbb-1111-2222-3333-777777777702'; // apply target
const UUID_C = 'cccccccc-1111-2222-3333-777777777703'; // delete target
const DAY_MS = 24 * 60 * 60 * 1000;
const OPENAI_CLAIM = 'https://api.openai.com/auth';

/**
 * base64url-encode a JSON object (JWT segment form, no padding).
 * @param {object} obj @returns {string}
 */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an unsigned synthetic JWT.
 * @param {object} payload @returns {string}
 */
function makeJwt(payload) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(payload) + '.SYNTHSIG';
}

/**
 * Build a synthetic chatgpt-mode auth object for one account.
 * @param {string} accountId @param {string} tag @param {object} [over]
 * @returns {object}
 */
function makeAuth(accountId, tag, over = {}) {
  const claim = {};
  claim[OPENAI_CLAIM] = { chatgpt_account_id: accountId, chatgpt_plan_type: 'prolite' };
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeJwt({ email: tag.toLowerCase() + '@example.com', name: 'Route ' + tag, exp: Math.floor(Date.now() / 1000) + 3600, ...claim }),
      access_token: makeJwt({ exp: Math.floor((Date.now() + 10 * DAY_MS) / 1000), tag: 'at-SYNTH-' + tag }),
      refresh_token: 'rt-SYNTH-' + tag,
      account_id: accountId,
    },
    last_refresh: over.lastRefresh || new Date().toISOString(),
  };
}

// ─── Fixture home + capability + manager + app ─────────────────────────────

const fixtureRoot = path.join(process.env.CWM_DATA_DIR, 'acct-route-fixtures');
const homeDir = path.join(fixtureRoot, 'provider-home');
const accountsDir = path.join(fixtureRoot, 'accounts');
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(accountsDir, { recursive: true });
const authPath = path.join(homeDir, accountsCapability.watchFileName);
fs.writeFileSync(authPath, JSON.stringify(makeAuth(UUID_A, 'LIVE-A')), 'utf-8');

const stub = { hits: 0, status: 200 };
const stubServer = http.createServer((req, res) => {
  stub.hits += 1;
  const nowSec = Math.floor(Date.now() / 1000);
  res.writeHead(stub.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    email: 'live-a@example.com',
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: nowSec + 1800 },
      secondary_window: { used_percent: 77, limit_window_seconds: 604800, reset_at: nowSec + 86400 },
    },
  }));
});

const TEST_TOKEN = 'test-token-provider-account-routes';

/**
 * Bearer auth middleware for the test app (mirrors the production
 * requireAuth contract: 401 without the exact token).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 * @returns {void}
 */
function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  if (header === 'Bearer ' + TEST_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Issue one HTTP request against the booted app; parses JSON bodies but
 * always keeps the raw text for the token-leak assertions.
 * @param {import('http').Server} server @param {string} method
 * @param {string} urlPath @param {{body?: object, skipAuth?: boolean}} [opts]
 * @returns {Promise<{status: number, body: *, raw: string}>}
 */
function req(server, method, urlPath, opts) {
  opts = opts || {};
  const data = opts.body == null ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (!opts.skipAuth) headers['Authorization'] = 'Bearer ' + TEST_TOKEN;
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
        resolve({ status: res.statusCode, body, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/**
 * Assert a raw response body contains no token material: neither the
 * distinctive synthetic values nor the credential key names.
 * @param {string} raw @param {string} where @returns {void}
 */
function assertNoTokenMaterial(raw, where) {
  assert(raw.indexOf('rt-SYNTH') === -1, where + ': refresh token VALUE leaked');
  assert(raw.indexOf('SYNTHSIG') === -1, where + ': JWT material leaked');
  assert(raw.indexOf('access_token') === -1, where + ': access_token key leaked');
  assert(raw.indexOf('refresh_token') === -1, where + ': refresh_token key leaked');
  assert(raw.indexOf('id_token') === -1, where + ': id_token key leaked');
  assert(raw.indexOf('OPENAI_API_KEY') === -1, where + ': api key field leaked');
}

(async function main() {
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  const stubBase = 'http://127.0.0.1:' + stubServer.address().port;

  const capability = {
    ...accountsCapability,
    authFilePath: () => authPath,
    watchDir: () => homeDir,
    usage: { ...accountsCapability.usage, url: () => stubBase + '/usage' },
  };
  const manager = createProviderAccountManager(capability, {
    accountsDir,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const providerId = capability.providerId;
  const base = '/api/provider-accounts/' + providerId;

  const events = [];
  const app = express();
  app.use(express.json());
  setupProviderAccountRoutes(app, {
    requireAuth,
    broadcast: (type, data) => events.push({ type, data }),
    structuredError: (res, statusCode, errorCode, message, retryable = false) =>
      res.status(statusCode).json({ error: errorCode, code: statusCode, message, retryable: !!retryable }),
    managers: new Map([[providerId, manager]]),
  });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));

  console.log('\n  provider-account-routes integration tests');
  console.log('  ' + '─'.repeat(70));

  // ─── Auth wall ────────────────────────────────────────────────────────
  await test('401 without a bearer token on ALL SIX routes', async () => {
    const cases = [
      ['GET', base],
      ['POST', base + '/refresh-usage'],
      ['POST', base + '/apply'],
      ['POST', base + '/capture'],
      ['PUT', base + '/' + UUID_A + '/label'],
      ['DELETE', base + '/' + UUID_A],
    ];
    for (const [method, url] of cases) {
      const r = await req(listener, method, url, { body: {}, skipAuth: true });
      assertEqual(r.status, 401, method + ' ' + url + ' must 401 without auth, got ' + r.status);
    }
  });

  // ─── Unknown provider ─────────────────────────────────────────────────
  await test('unknown provider id -> 404 PROVIDER_ACCOUNTS_UNSUPPORTED on every route', async () => {
    const cases = [
      ['GET', '/api/provider-accounts/notaprovider'],
      ['POST', '/api/provider-accounts/notaprovider/refresh-usage'],
      ['POST', '/api/provider-accounts/notaprovider/apply'],
      ['POST', '/api/provider-accounts/notaprovider/capture'],
      ['PUT', '/api/provider-accounts/notaprovider/' + UUID_A + '/label'],
      ['DELETE', '/api/provider-accounts/notaprovider/' + UUID_A],
    ];
    for (const [method, url] of cases) {
      const r = await req(listener, method, url, { body: {} });
      assertEqual(r.status, 404, method + ' ' + url + ' -> ' + r.status);
      assertEqual(r.body.error, 'PROVIDER_ACCOUNTS_UNSUPPORTED');
    }
  });

  // ─── GET list ─────────────────────────────────────────────────────────
  await test('GET list self-captures the live account and serializes ONLY safe fields', async () => {
    const r = await req(listener, 'GET', base);
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertNoTokenMaterial(r.raw, 'GET list');
    assertEqual(r.body.providerId, providerId);
    assertEqual(r.body.installed, true);
    assertEqual(r.body.activeAccountId, UUID_A, 'active account detected from the fixture auth');
    assertEqual(r.body.activeAuthMode, 'chatgpt');
    const rowA = r.body.accounts.find((a) => a.accountId === UUID_A);
    assert(rowA, 'active account self-captured on first list (guarded sync)');
    assertEqual(rowA.isActive, true);
    assertEqual(rowA.email, 'live-a@example.com');
    assertEqual(rowA.health, 'healthy');
    assertEqual(rowA.accessExpired, false);
    assert(typeof r.body.loginHint === 'string' && r.body.loginHint.length > 0, 'loginHint present');
  });

  // ─── Capture ──────────────────────────────────────────────────────────
  await test('POST capture applies an optional label and broadcasts changed {captured}', async () => {
    const evBefore = events.length;
    const r = await req(listener, 'POST', base + '/capture', { body: { label: 'Primary' } });
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertNoTokenMaterial(r.raw, 'capture');
    const rowA = r.body.accounts.find((a) => a.accountId === UUID_A);
    assertEqual(rowA.label, 'Primary');
    assertEqual(rowA.displayName, 'Primary');
    const ev = events.slice(evBefore).find((e) => e.type === EVENT_CHANGED && e.data.captured === true);
    assert(ev, EVENT_CHANGED + ' broadcast with captured:true');
    assertEqual(ev.data.providerId, providerId, 'payload carries providerId');
    assertEqual(ev.data.accountId, UUID_A, 'payload carries accountId');
    assert(!('id' in ev.data), 'payload NEVER carries a bare id key');
  });

  // ─── Label ────────────────────────────────────────────────────────────
  await test('PUT label: set, clear, cap at 60, 404 unknown, broadcast discipline', async () => {
    const evBefore = events.length;
    const r1 = await req(listener, 'PUT', base + '/' + UUID_A + '/label', { body: { label: 'Renamed' } });
    assertEqual(r1.status, 200);
    assertEqual(r1.body.accounts.find((a) => a.accountId === UUID_A).displayName, 'Renamed');
    const renamedEv = events.slice(evBefore).find((e) => e.type === EVENT_CHANGED && e.data.renamed === true);
    assert(renamedEv, 'changed broadcast with renamed:true');
    assertEqual(renamedEv.data.accountId, UUID_A);
    assert(!('id' in renamedEv.data), 'no bare id key');
    const r2 = await req(listener, 'PUT', base + '/' + UUID_A + '/label', { body: { label: '' } });
    assertEqual(r2.status, 200);
    assertEqual(r2.body.accounts.find((a) => a.accountId === UUID_A).displayName, 'live-a@example.com', 'clear falls back to email');
    const r3 = await req(listener, 'PUT', base + '/' + UUID_A + '/label', { body: { label: 'x'.repeat(61) } });
    assertEqual(r3.status, 400);
    assertEqual(r3.body.error, 'VALIDATION');
    const r4 = await req(listener, 'PUT', base + '/' + UUID_B + '/label', { body: { label: 'nope' } });
    assertEqual(r4.status, 404);
    assertEqual(r4.body.error, 'ACCT_NOT_FOUND');
  });

  // ─── Apply ────────────────────────────────────────────────────────────
  await test('POST apply swaps the live auth file, verifies, and broadcasts changed', async () => {
    manager.saveSnapshot({ accountId: UUID_B, email: 'route-b@example.com', auth: makeAuth(UUID_B, 'TARGET-B'), tokenState: 'ok' });
    const evBefore = events.length;
    const r = await req(listener, 'POST', base + '/apply', { body: { accountId: UUID_B } });
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertNoTokenMaterial(r.raw, 'apply');
    assertEqual(r.body.applied, true);
    assertEqual(r.body.alreadyActive, false);
    assertEqual(r.body.activeAccountId, UUID_B);
    assertEqual(r.body.email, 'route-b@example.com');
    assert(typeof r.body.restartNote === 'string' && r.body.restartNote.indexOf('restarted') !== -1, 'restart note present');
    const live = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    assertEqual(live.tokens.refresh_token, 'rt-SYNTH-TARGET-B', 'live auth file swapped to the target');
    const ev = events.slice(evBefore).find((e) => e.type === EVENT_CHANGED && e.data.activeAccountId === UUID_B);
    assert(ev, 'changed broadcast after the apply');
    assertEqual(ev.data.providerId, providerId);
    assert(typeof ev.data.appliedAt === 'string', 'appliedAt stamped');
    assert(!('id' in ev.data), 'no bare id key');
    // Applying the already-active account is a 200 no-op with NO broadcast.
    const evBefore2 = events.length;
    const again = await req(listener, 'POST', base + '/apply', { body: { accountId: UUID_B } });
    assertEqual(again.status, 200);
    assertEqual(again.body.alreadyActive, true);
    assertEqual(again.body.applied, false);
    assertEqual(events.length, evBefore2, 'alreadyActive broadcasts nothing (no state changed)');
  });

  await test('apply error taxonomy: 400 VALIDATION, 404 ACCT_NOT_FOUND, 409 ACCT_TOKEN_DEAD', async () => {
    const bad = await req(listener, 'POST', base + '/apply', { body: {} });
    assertEqual(bad.status, 400);
    assertEqual(bad.body.error, 'VALIDATION');
    const missing = await req(listener, 'POST', base + '/apply', { body: { accountId: 'abcdef00-0000-0000-0000-000000000000' } });
    assertEqual(missing.status, 404);
    assertEqual(missing.body.error, 'ACCT_NOT_FOUND');
    manager.saveSnapshot({ accountId: UUID_C, email: 'dead@example.com', auth: makeAuth(UUID_C, 'DEAD-C'), tokenState: 'needs_login' });
    const dead = await req(listener, 'POST', base + '/apply', { body: { accountId: UUID_C } });
    assertEqual(dead.status, 409);
    assertEqual(dead.body.error, 'ACCT_TOKEN_DEAD');
    assert(typeof dead.body.message === 'string' && typeof dead.body.retryable === 'boolean', 'structuredError shape');
  });

  // ─── Refresh usage ────────────────────────────────────────────────────
  await test('POST refresh-usage hits the stub, stores usage, broadcasts usage rows', async () => {
    const evBefore = events.length;
    const r = await req(listener, 'POST', base + '/refresh-usage', { body: { accountId: UUID_B } });
    assertEqual(r.status, 200, 'body=' + r.raw);
    assertNoTokenMaterial(r.raw, 'refresh-usage');
    const rowB = r.body.accounts.find((a) => a.accountId === UUID_B);
    assert(rowB.usage, 'usage present after refresh');
    assertEqual(rowB.usage.five_hour.utilization, 42);
    assertEqual(rowB.usage.seven_day.utilization, 77);
    assert(rowB.usage.fetchedAt, 'fetchedAt stamped');
    assert(stub.hits >= 1, 'stub usage endpoint hit');
    const ev = events.slice(evBefore).find((e) => e.type === EVENT_USAGE);
    assert(ev, EVENT_USAGE + ' broadcast');
    assertEqual(ev.data.providerId, providerId);
    assert(Array.isArray(ev.data.accounts), 'payload carries safe rows');
    assertNoTokenMaterial(JSON.stringify(ev.data), EVENT_USAGE + ' SSE payload');
    const rBad = await req(listener, 'POST', base + '/refresh-usage', { body: { accountId: 42 } });
    assertEqual(rBad.status, 400);
    const r404 = await req(listener, 'POST', base + '/refresh-usage', { body: { accountId: 'abcdef00-0000-0000-0000-00000000ffff' } });
    assertEqual(r404.status, 404);
  });

  await test('POST refresh-usage {} sweeps without failing on per-account errors', async () => {
    const r = await req(listener, 'POST', base + '/refresh-usage', { body: {} });
    assertEqual(r.status, 200, 'sweep never fails the batch: ' + r.raw);
    assert(Array.isArray(r.body.accounts), 'safe list returned');
  });

  // ─── Delete ───────────────────────────────────────────────────────────
  await test('DELETE removes the snapshot file only; live untouched; second delete 404s', async () => {
    const evBefore = events.length;
    const liveBefore = fs.readFileSync(authPath, 'utf-8');
    const r = await req(listener, 'DELETE', base + '/' + UUID_C);
    assertEqual(r.status, 200, 'body=' + r.raw);
    assert(!fs.existsSync(path.join(accountsDir, UUID_C + '.json')), 'snapshot file removed');
    assertEqual(fs.readFileSync(authPath, 'utf-8'), liveBefore, 'live auth file byte-identical');
    const ev = events.slice(evBefore).find((e) => e.type === EVENT_CHANGED && e.data.deleted === true && e.data.accountId === UUID_C);
    assert(ev, 'changed broadcast with deleted:true');
    assertEqual(ev.data.providerId, providerId);
    assert(!('id' in ev.data), 'no bare id key');
    const again = await req(listener, 'DELETE', base + '/' + UUID_C);
    assertEqual(again.status, 404);
    assertEqual(again.body.error, 'ACCT_NOT_FOUND');
  });

  // ─── Full-stream sweeps ───────────────────────────────────────────────
  await test('no broadcast ever carried token material or a bare id key', async () => {
    assertNoTokenMaterial(JSON.stringify(events), 'entire broadcast stream');
    for (const e of events) {
      assert(!('id' in (e.data || {})), 'broadcast ' + e.type + ' carried a bare id key');
    }
  });

  // Cleanup
  listener.close();
  stubServer.close();

  console.log('  ' + '─'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + ((err && err.stack) || err));
  process.exit(1);
});
