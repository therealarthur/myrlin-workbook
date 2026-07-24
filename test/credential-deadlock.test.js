#!/usr/bin/env node
/**
 * credential-deadlock.test.js
 * Regression and hardening tests for the 2026-07-24 production deadlock:
 * an unguarded token-endpoint BODY READ in refreshInactiveToken could pend
 * forever, wedging the credential manager's serialize() mutex and hanging
 * GET /api/credentials (account switcher and usage meter down).
 *
 * Layers under test:
 *   1. Source fix: the abort deadline spans the body read, so a stalled
 *      body settles as a TRANSIENT TIMEOUT verdict (never needs_login).
 *   2. fetchUsage lock-in: its timer already spans the body read; keep it.
 *   3. serialize()/runMacExclusive() op deadline: a never-settling op
 *      rejects CRED_OP_TIMEOUT and the chain advances.
 *   4. Batch tolerance: one wedged profile cannot block the others.
 *   5. Route degraded mode: the roster list responds within the
 *      best-effort window with degraded:true even when the chain hangs.
 *   6. Stalled-chain watchdog: force-resets a chain held past the stall
 *      threshold; cleared on stopCredentialWatcher.
 *
 * Hermetic: fixture HOME dirs under the test sandbox (CWM_DATA_DIR via
 * _test-data-dir), local HTTP stubs (one healthy, one that deliberately
 * stalls mid-body), injected fetchImpl/clock where needed. No real
 * network, no real HOME, no SSH. Every await that could hang is wrapped
 * in raceOrFail so a regression fails loudly instead of hanging the suite.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

const {
  createCredentialManager,
  serializeCredentialsFile,
  withOpDeadline,
  settleWithin,
  OP_TIMEOUT_MS,
  MAC_OP_TIMEOUT_MS,
  CHAIN_STALL_FACTOR,
  TOKEN_STATE_OK,
} = require('../src/web/credential-manager');
const { setupCredentialRoutes } = require('../src/web/credential-routes');
const { setupProviderAccountRoutes } = require('../src/web/provider-account-routes');

let passed = 0;
let failed = 0;

/**
 * Minimal async test harness: runs fn, records pass/fail, prints result.
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (may be async).
 * @returns {Promise<void>}
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

/** Sleep helper. @param {number} ms @returns {Promise<void>} */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Race a promise against a hard failure timer. Converts "hangs forever"
 * (the exact bug class this suite guards against) into a loud test
 * failure instead of a hung npm test. The guard timer is cleared once the
 * race settles so it never leaks.
 *
 * @param {Promise<*>} promise - The promise under test.
 * @param {number} ms - Give-up budget.
 * @param {string} [what] - Label for the failure message.
 * @returns {Promise<*>} The promise's own outcome, or a guard rejection.
 */
function raceOrFail(promise, ms, what) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error((what || 'operation') + ' did not settle within ' + ms + 'ms (a hang here means the deadlock regressed)'));
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

// ─── Fixture constants ──────────────────────────────────────────────────────
const UUID_A = 'aaaaaaaa-1111-2222-3333-666666666601'; // active on the fixture PC
const UUID_B = 'bbbbbbbb-1111-2222-3333-666666666602'; // wedged / stalled target
const UUID_C = 'cccccccc-1111-2222-3333-666666666603'; // healthy batch neighbor
const EMAIL_A = 'deadlock.a@example.com';
const EMAIL_B = 'deadlock.b@example.com';
const EMAIL_C = 'deadlock.c@example.com';
const HOUR_MS = 60 * 60 * 1000;

// Silent logger so expected warnings do not pollute test output.
const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Build a claudeAiOauth fixture object.
 * @param {string} tag - Distinctive token tag.
 * @param {number} expiresAt - Epoch ms expiry.
 * @param {string} [refreshToken] - Explicit refresh token ('' allowed).
 * @returns {object}
 */
function makeOauth(tag, expiresAt, refreshToken) {
  return {
    accessToken: 'at-DLFIX-' + tag,
    refreshToken: refreshToken !== undefined ? refreshToken : ('rt-DLFIX-' + tag),
    expiresAt,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  };
}

/**
 * Build an oauthAccount identity fixture.
 * @param {string} uuid @param {string} email
 * @returns {object}
 */
function makeIdentity(uuid, email) {
  return {
    accountUuid: uuid,
    emailAddress: email,
    organizationUuid: 'ffffffff-0000-0000-0000-000000000003',
    organizationType: 'claude_max',
    displayName: 'Deadlock Fixture',
    organizationName: 'Deadlock Org',
  };
}

// ─── Healthy stub server (usage + token both answer promptly) ───────────────
const okServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      five_hour: { utilization: 34, resets_at: '2026-07-24T21:00:00+00:00' },
      seven_day: { utilization: 61, resets_at: '2026-07-30T07:00:00+00:00' },
      limits: [],
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/token') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'at-DLROTATED', refresh_token: 'rt-DLROTATED', expires_in: 43200 }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ─── Stalling stub server: THE OUTAGE SHAPE ─────────────────────────────────
// Sends full headers plus a PARTIAL body and then never finishes the
// response, so the client's res.json() promise stays pending forever
// unless the caller's abort deadline spans the body read. Paths select the
// status line so the 401-headers-then-stall case can be tested too.
const stallSockets = new Set();
const stallServer = http.createServer((req, res) => {
  let status = 200;
  if (req.url === '/token-stall-401' || req.url === '/usage-stall-401') status = 401;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  // Partial JSON, never res.end(): the body stream never terminates.
  res.write('{"access_token":"at-NEVER-FINISHES","partial":');
  // Deliberately no end() and no further writes.
});
stallServer.on('connection', (socket) => {
  stallSockets.add(socket);
  socket.on('close', () => stallSockets.delete(socket));
});

let okBase = '';
let stallBase = '';

let fixtureSeq = 0;

/**
 * Create an isolated fixture environment plus a manager wired to the stub
 * endpoints (healthy by default; tests override tokenUrl/usageUrl to point
 * at the stalling server). Live files are written for account A.
 *
 * @param {object} [cfg]
 * @param {string} [cfg.tokenUrl] - Token endpoint override.
 * @param {string} [cfg.usageUrl] - Usage endpoint override.
 * @param {object} [cfg.settings] - settingsProvider return value.
 * @param {object} [cfg.log] - Logger override (default silent).
 * @param {object} [cfg.managerOpts] - Extra createCredentialManager opts.
 * @returns {{manager: object, claudeDir: string, claudeJsonPath: string, accountsDir: string, credPath: string}}
 */
function makeFixture(cfg = {}) {
  fixtureSeq += 1;
  const root = path.join(process.env.CWM_DATA_DIR, 'dl-fix-' + fixtureSeq);
  const claudeDir = path.join(root, 'dot-claude');
  const claudeJsonPath = path.join(root, 'dot-claude.json');
  const accountsDir = path.join(root, 'accounts');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  const credPath = path.join(claudeDir, '.credentials.json');
  fs.writeFileSync(credPath, serializeCredentialsFile(makeOauth('LIVE-A', Date.now() + 12 * HOUR_MS)), 'utf-8');
  fs.writeFileSync(claudeJsonPath, JSON.stringify({ oauthAccount: makeIdentity(UUID_A, EMAIL_A) }, null, 2), 'utf-8');
  const settings = cfg.settings || {};
  const manager = createCredentialManager({
    claudeDir,
    claudeJsonPath,
    accountsDir,
    settingsProvider: () => settings,
    usageUrl: cfg.usageUrl || (okBase + '/usage'),
    tokenUrl: cfg.tokenUrl || (okBase + '/token'),
    seedDir: path.join(root, 'no-seed-here'),
    watchDebounceMs: 20,
    pollIntervalMs: 250,
    log: cfg.log || silentLog,
    ...(cfg.managerOpts || {}),
  });
  return { manager, claudeDir, claudeJsonPath, accountsDir, credPath };
}

/**
 * Issue one HTTP request against a booted route-test server.
 * @param {import('http').Server} server - Listening app server.
 * @param {string} method @param {string} urlPath
 * @returns {Promise<{status: number, body: *, raw: string}>}
 */
function httpReq(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
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
    r.end();
  });
}

/**
 * Boot a minimal Express app with the credential routes and a fake
 * manager. Auth is a pass-through (the auth wall is covered elsewhere).
 * @param {object} managerFake - Fake manager (route-facing surface only).
 * @param {number} listBestEffortMs - Injected best-effort window.
 * @returns {Promise<import('http').Server>}
 */
function bootCredRouteApp(managerFake, listBestEffortMs) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  setupCredentialRoutes(app, {
    requireAuth: (req, res, next) => next(),
    getStore: () => ({ settings: {}, updateSettings: () => {} }),
    broadcast: () => {},
    structuredError: (res, status, code, message, retryable) => res.status(status).json({ error: message, code, retryable: !!retryable }),
    manager: managerFake,
    listBestEffortMs,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Boot a minimal Express app with the provider-account routes and a fake
 * manager map (one provider, id 'prov-1').
 * @param {object} managerFake - Fake provider manager.
 * @param {number} listBestEffortMs - Injected best-effort window.
 * @returns {Promise<import('http').Server>}
 */
function bootProviderRouteApp(managerFake, listBestEffortMs) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  setupProviderAccountRoutes(app, {
    requireAuth: (req, res, next) => next(),
    broadcast: () => {},
    structuredError: (res, status, code, message, retryable) => res.status(status).json({ error: message, code, retryable: !!retryable }),
    managers: new Map([['prov-1', managerFake]]),
    listBestEffortMs,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Build a fake Claude-route manager whose surface covers exactly what the
 * GET list route touches. Overrides let a test wedge specific calls.
 * @param {object} [overrides]
 * @returns {object}
 */
function makeFakeManager(overrides = {}) {
  return {
    getSettings: () => ({ mac: { enabled: false, host: '', user: '' }, usageCacheMinutes: 10 }),
    getSafeList: () => ({
      activeProfileId: UUID_A,
      profiles: [{ profileId: UUID_A, email: EMAIL_A, displayName: 'Fake A', isActive: true, usage: null }],
    }),
    seedFromClaudeSwap: () => Promise.resolve({ imported: 0, skipped: 0 }),
    syncActiveTokenToProfile: () => Promise.resolve(null),
    getActiveAccountUuid: () => UUID_A,
    ...overrides,
  };
}

(async function main() {
  await new Promise((resolve) => okServer.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => stallServer.listen(0, '127.0.0.1', resolve));
  okBase = 'http://127.0.0.1:' + okServer.address().port;
  stallBase = 'http://127.0.0.1:' + stallServer.address().port;

  console.log('\n  credential-deadlock hardening tests');
  console.log('  ' + '─'.repeat(70));

  // ─── Layer 1: the source fix in refreshInactiveToken ──────────────────

  await test('OUTAGE REGRESSION: stalled token body settles as transient timeout within deadline plus epsilon', async () => {
    const fx = makeFixture({ tokenUrl: stallBase + '/token-stall-200', managerOpts: { refreshTimeoutMs: 300 } });
    const t0 = Date.now();
    // Against the pre-fix code this promise NEVER settles (the timer was
    // cleared at headers, leaving res.json() unguarded), so raceOrFail
    // fails the test; that is the non-vacuous regression guard.
    const r = await raceOrFail(fx.manager.refreshInactiveToken('rt-DLFIX-STALL'), 4000, 'refreshInactiveToken (stalled 200 body)');
    const elapsed = Date.now() - t0;
    assertEqual(r.ok, false, 'stalled body is not a success');
    assertEqual(r.verdict, 'transient', 'timeout is transient, never a death verdict');
    assertEqual(r.kind, 'timeout', 'classified as timeout');
    assert(elapsed < 2500, 'settled within the 300ms deadline plus epsilon, took ' + elapsed + 'ms');
    assert(!String(r.detail || '').includes('rt-DLFIX-STALL'), 'detail never carries token material');
  });

  await test('stalled 401 body is transient timeout, never the suspect ladder or needs_login', async () => {
    const fx = makeFixture({ tokenUrl: stallBase + '/token-stall-401', managerOpts: { refreshTimeoutMs: 300 } });
    const r = await raceOrFail(fx.manager.refreshInactiveToken('rt-DLFIX-STALL-401'), 4000, 'refreshInactiveToken (stalled 401 body)');
    assertEqual(r.ok, false);
    // A 401 whose body never arrived is NOT bodyless-401 suspect evidence:
    // OUR deadline killed the read, so nothing about the token was learned.
    assertEqual(r.verdict, 'transient', 'stalled 401 must not classify as suspect');
    assertEqual(r.kind, 'timeout');
  });

  await test('end to end: stalled token body no longer wedges the mutex (usage update settles, later ops run)', async () => {
    const fx = makeFixture({ tokenUrl: stallBase + '/token-stall-200', managerOpts: { refreshTimeoutMs: 300 } });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-EXPIRED', Date.now() - HOUR_MS, 'rt-DLFIX-B'),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const snap = await raceOrFail(fx.manager.updateSnapshotUsage(UUID_B, { force: true }), 4000, 'updateSnapshotUsage over a stalled refresh');
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'timeout keeps the prior tokenState');
    assert(snap.lastRefreshError && snap.lastRefreshError.kind === 'timeout', 'timeout evidence recorded');
    // The mutex advanced: a later serialized op completes immediately.
    const relabeled = await raceOrFail(fx.manager.setLabel(UUID_B, 'Still Alive'), 2000, 'setLabel after the stalled refresh');
    assertEqual(relabeled.label, 'Still Alive', 'chain advanced past the stalled op');
  });

  // ─── Layer 2: fetchUsage lock-in ──────────────────────────────────────

  await test('fetchUsage lock-in: abort spans the body read (stalled usage body resolves null in time)', async () => {
    const fx = makeFixture({ usageUrl: stallBase + '/usage-stall-200', settings: { httpTimeoutSec: 1 } });
    const t0 = Date.now();
    // If anyone "optimizes" fetchUsage's clearTimeout up to header arrival
    // (the refreshInactiveToken bug), this promise never settles and
    // raceOrFail fails the test.
    const usage = await raceOrFail(fx.manager.fetchUsage('at-DLFIX-LOCKIN'), 4000, 'fetchUsage (stalled body)');
    const elapsed = Date.now() - t0;
    assertEqual(usage, null, 'stalled usage degrades to null');
    assert(elapsed < 3000, 'settled within the 1s timeout plus epsilon, took ' + elapsed + 'ms');
  });

  // ─── Layer 3: serialize()/runMacExclusive() op deadline ───────────────

  await test('serialize deadline: stuck op rejects CRED_OP_TIMEOUT and the next queued op still runs', async () => {
    const fx = makeFixture({ managerOpts: { opTimeoutMs: 150 } });
    const stuck = fx.manager._serialize(() => new Promise(() => {}), 'stuck-test-op');
    const next = fx.manager._serialize(() => 'ran-after-the-wedge', 'follow-up');
    const err = await raceOrFail(stuck.then(() => null, (e) => e), 4000, 'stuck serialized op');
    assert(err, 'the stuck caller received a rejection, not a hang');
    assertEqual(err.code, 'CRED_OP_TIMEOUT', 'typed timeout code');
    assertEqual(err.status, 503, 'maps to HTTP 503');
    assertEqual(err.retryable, true, 'marked retryable');
    assert(String(err.message).includes('stuck-test-op'), 'label rides into the error for diagnosability');
    assertEqual(await raceOrFail(next, 4000, 'op queued behind the wedge'), 'ran-after-the-wedge', 'the chain advanced');
  });

  await test('mac chain deadline: runMacExclusive gets its own (roomier) deadline and advances too', async () => {
    const fx = makeFixture({ managerOpts: { macOpTimeoutMs: 150 } });
    const stuck = fx.manager.runMacExclusive(() => new Promise(() => {}), 'mac-stuck-test');
    const next = fx.manager.runMacExclusive(() => 'mac-ran-after');
    const err = await raceOrFail(stuck.then(() => null, (e) => e), 4000, 'stuck mac op');
    assert(err && err.code === 'CRED_OP_TIMEOUT', 'mac op rejected with CRED_OP_TIMEOUT');
    assert(String(err.message).includes('mac-stuck-test'), 'mac label rides into the error');
    assertEqual(await raceOrFail(next, 4000, 'mac op queued behind the wedge'), 'mac-ran-after', 'the mac chain advanced');
  });

  await test('deadline defaults are sane (60s op, 120s mac, 3x stall factor) and errors pass through unchanged', async () => {
    assertEqual(OP_TIMEOUT_MS, 60000, 'op deadline is 60s');
    assertEqual(MAC_OP_TIMEOUT_MS, 120000, 'mac deadline is 120s');
    assertEqual(CHAIN_STALL_FACTOR, 3, 'watchdog stall factor is 3x');
    // withOpDeadline must not rewrap a fast op's own rejection.
    const boom = new Error('own-failure');
    boom.code = 'OWN_CODE';
    const got = await withOpDeadline(() => Promise.reject(boom), 1000, 'passthrough').then(() => null, (e) => e);
    assertEqual(got, boom, 'the op\'s own rejection object passes through untouched');
    // And a fast resolution passes through as-is.
    assertEqual(await withOpDeadline(() => 'quick', 1000, 'quick-op'), 'quick');
  });

  // ─── Layer 4: batch tolerance ─────────────────────────────────────────

  await test('batch: one wedged profile rejects CRED_OP_TIMEOUT while the others still refresh', async () => {
    const fx = makeFixture({
      managerOpts: {
        opTimeoutMs: 250,
        // A hostile fetch that ignores the abort signal entirely for the
        // wedged profile's refresh (worst case: even layer 1 cannot save
        // us), and delegates everything else to the real local stubs.
        fetchImpl: (url, o) => {
          if (o && typeof o.body === 'string' && o.body.indexOf('rt-DLFIX-WEDGE') !== -1) {
            return new Promise(() => {}); // never settles, ignores abort
          }
          return globalThis.fetch(url, o);
        },
      },
    });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-WEDGE', Date.now() - HOUR_MS, 'rt-DLFIX-WEDGE'),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    fx.manager.saveSnapshot({
      accountUuid: UUID_C,
      email: EMAIL_C,
      credentials: makeOauth('C-HEALTHY', Date.now() + HOUR_MS),
      identity: makeIdentity(UUID_C, EMAIL_C),
      tokenState: TOKEN_STATE_OK,
    });
    // Mirror the POST /api/credentials/refresh-usage batch loop exactly:
    // sequential awaits, per-profile try/catch, failure never aborts it.
    const outcomes = {};
    for (const snap of fx.manager.listSnapshots()) {
      try {
        await raceOrFail(fx.manager.updateSnapshotUsage(snap.accountUuid, { force: false }), 4000, 'batch item ' + snap.accountUuid);
        outcomes[snap.accountUuid] = 'ok';
      } catch (err) {
        outcomes[snap.accountUuid] = (err && err.code) || 'error';
      }
    }
    assertEqual(outcomes[UUID_B], 'CRED_OP_TIMEOUT', 'the wedged profile rejected with the typed timeout');
    assertEqual(outcomes[UUID_C], 'ok', 'the healthy profile was not blocked');
    const snapC = fx.manager.readSnapshot(UUID_C);
    assert(snapC.usage && snapC.usage.five_hour && snapC.usage.five_hour.utilization === 34, 'the healthy profile actually got fresh usage');
    const snapB = fx.manager.readSnapshot(UUID_B);
    assertEqual(snapB.tokenState, TOKEN_STATE_OK, 'the wedged profile keeps its prior tokenState (a wedge is not death evidence)');
  });

  // ─── Layer 5: route degraded mode ─────────────────────────────────────

  await test('GET /api/credentials responds degraded:true with a usable roster while the chain is wedged', async () => {
    const fake = makeFakeManager({
      seedFromClaudeSwap: () => new Promise(() => {}), // wedged chain stand-in
    });
    const server = await bootCredRouteApp(fake, 250);
    try {
      const t0 = Date.now();
      const resp = await raceOrFail(httpReq(server, 'GET', '/api/credentials'), 4000, 'GET /api/credentials with a wedged manager');
      const elapsed = Date.now() - t0;
      assertEqual(resp.status, 200, 'the list still answers 200');
      assert(elapsed < 2000, 'answered within the best-effort window plus epsilon, took ' + elapsed + 'ms');
      assert(Array.isArray(resp.body.profiles) && resp.body.profiles.length === 1, 'the roster is present and usable');
      assertEqual(resp.body.degraded, true, 'degraded flag set so the frontend can show a stale indicator');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test('GET /api/credentials omits degraded when the serialized pass completes in time', async () => {
    const server = await bootCredRouteApp(makeFakeManager(), 250);
    try {
      const resp = await raceOrFail(httpReq(server, 'GET', '/api/credentials'), 4000, 'GET /api/credentials healthy');
      assertEqual(resp.status, 200);
      assertEqual(resp.body.degraded, undefined, 'no degraded flag on a healthy pass');
      assert(Array.isArray(resp.body.profiles), 'roster present');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test('provider list route serves degraded:true with a usable roster while its chain is wedged', async () => {
    const fake = {
      providerId: 'prov-1',
      displayName: 'Prov One',
      getSafeList: () => ({
        providerId: 'prov-1',
        displayName: 'Prov One',
        installed: true,
        activeAccountId: null,
        activeAuthMode: null,
        loginHint: '',
        accounts: [],
      }),
      syncActiveAuthToSnapshot: () => new Promise(() => {}), // wedged
    };
    const server = await bootProviderRouteApp(fake, 250);
    try {
      const t0 = Date.now();
      const resp = await raceOrFail(httpReq(server, 'GET', '/api/provider-accounts/prov-1'), 4000, 'GET provider list with a wedged manager');
      const elapsed = Date.now() - t0;
      assertEqual(resp.status, 200, 'the provider list still answers 200');
      assert(elapsed < 2000, 'answered within the best-effort window plus epsilon, took ' + elapsed + 'ms');
      assert(Array.isArray(resp.body.accounts), 'the accounts roster is present');
      assertEqual(resp.body.degraded, true, 'degraded flag set');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // ─── Layer 6: stalled-chain watchdog ──────────────────────────────────

  await test('watchdog: force-resets a chain stalled past 3x the deadline (injected clock) and logs loudly', async () => {
    let now = 1_000_000_000_000;
    const errors = [];
    const fx = makeFixture({
      log: { log: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) },
      managerOpts: {
        clock: () => now,
        watchdogIntervalMs: 25,
        // Default 60s op deadline: its REAL timer cannot fire during this
        // test, so only the watchdog (driven by the fake clock) can free
        // the chain. This isolates layer 3 from layer 2.
      },
    });
    const wedged = fx.manager._serialize(() => new Promise(() => {}), 'wedged-forever');
    wedged.catch(() => {}); // observed; it may reject at real 60s after exit
    await sleep(30); // let the op take the chain and stamp its start time
    now += (OP_TIMEOUT_MS * CHAIN_STALL_FACTOR) + 60000; // fake time leaps past the stall threshold
    await sleep(120); // several real watchdog ticks at 25ms
    const revived = await raceOrFail(fx.manager._serialize(() => 'revived', 'post-reset'), 2000, 'op after the watchdog reset');
    assertEqual(revived, 'revived', 'the chain was reset and serves ops again');
    assert(errors.some((m) => m.includes('STALLED') && m.includes('wedged-forever')), 'the reset was logged loudly with the op label');
  });

  await test('watchdog: cleared on stopCredentialWatcher and re-armed by startCredentialWatcher', async () => {
    const fx = makeFixture({});
    assertEqual(fx.manager._hasChainWatchdog(), true, 'watchdog is ON by default from construction');
    fx.manager.stopCredentialWatcher();
    assertEqual(fx.manager._hasChainWatchdog(), false, 'stopCredentialWatcher clears the watchdog (no leaked interval)');
    fx.manager.startCredentialWatcher();
    try {
      assertEqual(fx.manager._hasChainWatchdog(), true, 'startCredentialWatcher re-arms it');
    } finally {
      fx.manager.stopCredentialWatcher();
    }
    assertEqual(fx.manager._hasChainWatchdog(), false, 'idempotent stop leaves it cleared');
  });

  // ─── settleWithin helper contract ─────────────────────────────────────

  await test('settleWithin: true for settled work (including rejections), false for pending work', async () => {
    assertEqual(await settleWithin(Promise.resolve('x'), 200), true, 'resolved work settles');
    assertEqual(await settleWithin(Promise.reject(new Error('observed')), 200), true, 'rejected work counts as settled and is observed');
    assertEqual(await settleWithin(new Promise(() => {}), 100), false, 'pending work reports false at the deadline');
  });

  // ─── Teardown ─────────────────────────────────────────────────────────
  for (const socket of stallSockets) {
    try { socket.destroy(); } catch (_) { /* best effort */ }
  }
  await new Promise((r) => stallServer.close(r));
  await new Promise((r) => okServer.close(r));

  console.log('  ' + '─'.repeat(70));
  console.log('  ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + ((err && err.stack) || err));
  process.exit(1);
});
