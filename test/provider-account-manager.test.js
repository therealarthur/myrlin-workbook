#!/usr/bin/env node
/**
 * Unit tests for src/web/provider-account-manager.js (the generic account
 * switcher manager), exercised through the real Codex capability's pure
 * parse functions but with every path pointed into the test sandbox.
 *
 * Hermetic (mirrors test/credential-manager.test.js): CWM_DATA_DIR
 * sandboxed via _test-data-dir FIRST, per-fixture fake CODEX-home dirs
 * via a test capability whose authFilePath/watchDir point into the
 * sandbox, a local http stub for the usage URL, SYNTHETIC JWTs in every
 * fixture, no real network, no real ~/.codex reads or writes.
 *
 * Focus (design doc Part 8.2 plus the v1 token policy): capture,
 * auto-capture on watcher fire, dedupe, strictly-newer merge, label
 * carry-forward, the apply transaction (backup, atomic write, verify,
 * capture-before-overwrite, verify-failure restore), delete, usage 200
 * mapping + identity heal, 401-on-unexpired -> needs_login vs
 * expired -> skip-unchanged, timeout -> lastError only, and the safe-list
 * token-material leak gate. The manager must NEVER call any token
 * endpoint (there is none to stub; any unexpected fetch fails loudly).
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

const { accountsCapability } = require('../src/providers/codex/accounts');
const {
  createProviderAccountManager,
  TOKEN_STATE_OK,
  TOKEN_STATE_NEEDS_LOGIN,
} = require('../src/web/provider-account-manager');

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
 * Poll until cond() is truthy or timeout; returns the final value.
 * @param {() => *} cond - Condition to poll.
 * @param {number} [timeoutMs] - Give-up budget.
 * @returns {Promise<*>}
 */
async function waitFor(cond, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(25);
  }
}

// ─── Synthetic auth fixtures (NEVER real tokens) ───────────────────────────

const UUID_A = 'aaaaaaaa-1111-2222-3333-666666666601';
const UUID_B = 'bbbbbbbb-1111-2222-3333-666666666602';
const UUID_C = 'cccccccc-1111-2222-3333-666666666603';
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
 * Build an unsigned synthetic JWT. The `tag` claim makes each token's
 * full string unique and greppable in leak assertions.
 * @param {object} payload @returns {string}
 */
function makeJwt(payload) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(payload) + '.SYNTHSIG';
}

/**
 * Build a synthetic chatgpt-mode auth object for one account.
 * @param {string} accountId - Account uuid.
 * @param {string} tag - Distinctive token tag.
 * @param {object} [over] - Overrides: accessExpMs, lastRefresh, email, plan, mode.
 * @returns {object} auth.json-shaped fixture.
 */
function makeAuth(accountId, tag, over = {}) {
  const claim = {};
  claim[OPENAI_CLAIM] = { chatgpt_account_id: accountId, chatgpt_plan_type: over.plan || 'prolite' };
  const accessExpMs = over.accessExpMs !== undefined ? over.accessExpMs : Date.now() + 10 * DAY_MS;
  return {
    auth_mode: over.mode || 'chatgpt',
    OPENAI_API_KEY: over.mode === 'apikey' ? 'sk-SYNTH-' + tag : null,
    tokens: over.mode === 'apikey' ? undefined : {
      id_token: makeJwt({ email: over.email || (tag.toLowerCase() + '@example.com'), name: 'Fixture ' + tag, exp: Math.floor(Date.now() / 1000) + 3600, ...claim }),
      access_token: makeJwt({ exp: Math.floor(accessExpMs / 1000), tag: 'at-SYNTH-' + tag }),
      refresh_token: 'rt-SYNTH-' + tag,
      account_id: accountId,
    },
    last_refresh: over.lastRefresh !== undefined ? over.lastRefresh : new Date().toISOString(),
  };
}

// ─── Usage endpoint stub ────────────────────────────────────────────────────
// mode 'ok' answers stub.body with stub.status; mode 'hang' never answers
// (drives the timeout classification). Hanging sockets are collected and
// destroyed at teardown so the process can exit.
const stub = { hits: 0, status: 200, mode: 'ok', body: null, lastHeaders: null, hanging: [] };
const stubServer = http.createServer((req, res) => {
  stub.hits += 1;
  stub.lastHeaders = req.headers;
  if (stub.mode === 'hang') {
    stub.hanging.push(res);
    return; // never respond; the manager's AbortController must fire
  }
  res.writeHead(stub.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stub.body || {}));
});

/**
 * Build one canonical wham/usage response body.
 * @param {object} [over] - Overrides: email, plan, usedPrimary.
 * @returns {object}
 */
function usageBody(over = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    email: over.email || 'healed@example.com',
    plan_type: over.plan || 'pro',
    rate_limit: {
      primary_window: { used_percent: over.usedPrimary !== undefined ? over.usedPrimary : 33, limit_window_seconds: 18000, reset_at: nowSec + 1800 },
      secondary_window: { used_percent: 66, limit_window_seconds: 604800, reset_at: nowSec + 86400 },
    },
  };
}

let fixtureSeq = 0;
let stubBase = '';
const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Create an isolated fixture: a fake provider home dir inside the sandbox,
 * a capability derived from the REAL Codex capability but pointed at that
 * dir plus the local usage stub, and a manager over it. The live auth
 * file is written for `liveAuth` unless null.
 *
 * @param {object} [cfg]
 * @param {object|null} [cfg.liveAuth] - Live auth object (null = no file).
 * @param {object} [cfg.settings] - settingsProvider return value.
 * @param {object} [cfg.managerOpts] - Extra createProviderAccountManager opts.
 * @param {Function} [cfg.serializeAuth] - Capability serializeAuth override
 *   (the verify-failure test sabotages the write through this).
 * @returns {{manager: object, capability: object, root: string, authPath: string, accountsDir: string}}
 */
function makeFixture(cfg = {}) {
  fixtureSeq += 1;
  const root = path.join(process.env.CWM_DATA_DIR, 'acct-fix-' + fixtureSeq);
  const home = path.join(root, 'provider-home');
  const accountsDir = path.join(root, 'accounts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  const authPath = path.join(home, accountsCapability.watchFileName);
  const liveAuth = cfg.liveAuth !== undefined ? cfg.liveAuth : makeAuth(UUID_A, 'LIVE-A');
  if (liveAuth) fs.writeFileSync(authPath, JSON.stringify(liveAuth), 'utf-8');
  const capability = {
    ...accountsCapability,
    authFilePath: () => authPath,
    watchDir: () => home,
    usage: { ...accountsCapability.usage, url: () => stubBase + '/usage' },
    ...(cfg.serializeAuth ? { serializeAuth: cfg.serializeAuth } : {}),
  };
  const manager = createProviderAccountManager(capability, {
    accountsDir,
    settingsProvider: () => (cfg.settings || {}),
    log: silentLog,
    ...(cfg.managerOpts || {}),
  });
  return { manager, capability, root, authPath, accountsDir };
}

(async function main() {
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  stubBase = 'http://127.0.0.1:' + stubServer.address().port;

  console.log('\n  provider-account-manager tests');
  console.log('  ' + '─'.repeat(70));

  // ─── Capture ──────────────────────────────────────────────────────────
  await test('captureCurrent snapshots the live login with tokenState ok', async () => {
    const { manager } = makeFixture({});
    const snap = await manager.captureCurrent({ label: 'Personal' });
    assertEqual(snap.accountId, UUID_A);
    assertEqual(snap.label, 'Personal');
    assertEqual(snap.email, 'live-a@example.com');
    assertEqual(snap.plan, 'prolite');
    assertEqual(snap.tokenState, TOKEN_STATE_OK);
    assert(snap.auth && snap.auth.tokens && snap.auth.tokens.refresh_token === 'rt-SYNTH-LIVE-A', 'full auth payload stored verbatim');
    const onDisk = manager.readSnapshot(UUID_A);
    assert(onDisk, 'snapshot persisted');
  });

  await test('captureCurrent: missing auth file -> 500 ACCT_LIVE_STATE_UNREADABLE', async () => {
    const { manager } = makeFixture({ liveAuth: null });
    try {
      await manager.captureCurrent({});
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.status, 500);
      assertEqual(err.code, 'ACCT_LIVE_STATE_UNREADABLE');
    }
  });

  await test('captureCurrent: apikey mode -> 422 ACCT_NO_IDENTITY', async () => {
    const { manager } = makeFixture({ liveAuth: makeAuth(UUID_A, 'KEYED', { mode: 'apikey' }) });
    try {
      await manager.captureCurrent({});
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.status, 422);
      assertEqual(err.code, 'ACCT_NO_IDENTITY');
    }
  });

  await test('captureCurrent: label over 60 chars -> 400 VALIDATION', async () => {
    const { manager } = makeFixture({});
    try {
      await manager.captureCurrent({ label: 'x'.repeat(61) });
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.status, 400);
      assertEqual(err.code, 'VALIDATION');
    }
  });

  // ─── Sync / auto-capture / dedupe / strictly-newer merge ──────────────
  await test('syncActiveAuthToSnapshot auto-captures an unknown live account', async () => {
    const { manager } = makeFixture({});
    const id = await manager.syncActiveAuthToSnapshot();
    assertEqual(id, UUID_A);
    const snap = manager.readSnapshot(UUID_A);
    assert(snap, 'auto-captured');
    assertEqual(snap.tokenState, TOKEN_STATE_OK);
  });

  await test('sync dedupes by accountId: repeated fires keep ONE snapshot', async () => {
    const { manager } = makeFixture({});
    await manager.syncActiveAuthToSnapshot();
    await manager.syncActiveAuthToSnapshot();
    await manager.syncActiveAuthToSnapshot();
    assertEqual(manager.listSnapshots().length, 1, 'no duplicates');
  });

  await test('sync merges ONLY strictly-newer live auth (never regresses)', async () => {
    const { manager, authPath } = makeFixture({
      liveAuth: makeAuth(UUID_A, 'FRESH', { lastRefresh: '2026-07-02T00:00:00.000Z' }),
    });
    await manager.syncActiveAuthToSnapshot();
    const fresh = manager.readSnapshot(UUID_A);
    assertEqual(fresh.auth.tokens.refresh_token, 'rt-SYNTH-FRESH');
    // Regress the live file to an OLDER last_refresh: must NOT be adopted.
    fs.writeFileSync(authPath, JSON.stringify(makeAuth(UUID_A, 'STALE', { lastRefresh: '2026-07-01T00:00:00.000Z' })), 'utf-8');
    await manager.syncActiveAuthToSnapshot();
    assertEqual(manager.readSnapshot(UUID_A).auth.tokens.refresh_token, 'rt-SYNTH-FRESH', 'stale live file never regresses the snapshot');
    // A strictly NEWER live file IS adopted, and identity rides along.
    fs.writeFileSync(authPath, JSON.stringify(makeAuth(UUID_A, 'NEWEST', { lastRefresh: '2026-07-03T00:00:00.000Z', plan: 'pro' })), 'utf-8');
    await manager.syncActiveAuthToSnapshot();
    const newest = manager.readSnapshot(UUID_A);
    assertEqual(newest.auth.tokens.refresh_token, 'rt-SYNTH-NEWEST', 'newer live file adopted');
    assertEqual(newest.plan, 'pro', 'identity fields healed with the fresher auth');
  });

  await test('sync resurrects a needs_login snapshot on live recapture', async () => {
    const { manager } = makeFixture({});
    await manager.syncActiveAuthToSnapshot();
    // Force the dead state, then re-sync: a live login is definitive.
    manager.saveSnapshot({ accountId: UUID_A, tokenState: TOKEN_STATE_NEEDS_LOGIN });
    await manager.syncActiveAuthToSnapshot();
    assertEqual(manager.readSnapshot(UUID_A).tokenState, TOKEN_STATE_OK, 'resurrected');
  });

  await test('sync skips silently on apikey mode and on a malformed file', async () => {
    const { manager, authPath } = makeFixture({ liveAuth: makeAuth(UUID_A, 'K', { mode: 'apikey' }) });
    assertEqual(await manager.syncActiveAuthToSnapshot(), null, 'apikey skipped');
    fs.writeFileSync(authPath, '{"tokens": {"acc', 'utf-8'); // torn mid-write
    assertEqual(await manager.syncActiveAuthToSnapshot(), null, 'malformed skipped, no crash');
    assertEqual(manager.listSnapshots().length, 0, 'nothing captured');
  });

  await test('label carry-forward: sync merges never clobber a user label', async () => {
    const { manager, authPath } = makeFixture({ liveAuth: makeAuth(UUID_A, 'L1', { lastRefresh: '2026-07-01T00:00:00.000Z' }) });
    await manager.syncActiveAuthToSnapshot();
    await manager.setLabel(UUID_A, 'My Main');
    fs.writeFileSync(authPath, JSON.stringify(makeAuth(UUID_A, 'L2', { lastRefresh: '2026-07-02T00:00:00.000Z' })), 'utf-8');
    await manager.syncActiveAuthToSnapshot();
    const snap = manager.readSnapshot(UUID_A);
    assertEqual(snap.label, 'My Main', 'label survived the merge');
    assertEqual(snap.auth.tokens.refresh_token, 'rt-SYNTH-L2', 'auth still adopted');
  });

  // ─── Watcher ──────────────────────────────────────────────────────────
  await test('watcher auto-captures within the debounce after a login write', async () => {
    const { manager, authPath } = makeFixture({ liveAuth: null, managerOpts: { watchDebounceMs: 50, pollIntervalMs: 60000 } });
    manager.startWatcher();
    try {
      await sleep(50); // let the initial no-file sync settle
      fs.writeFileSync(authPath, JSON.stringify(makeAuth(UUID_B, 'LOGIN-B')), 'utf-8');
      const snap = await waitFor(() => manager.readSnapshot(UUID_B), 3000);
      assert(snap, 'login auto-captured by the watcher');
      assertEqual(snap.tokenState, TOKEN_STATE_OK);
    } finally {
      manager.stopWatcher();
    }
  });

  await test('watcher self-write guard suppresses echoes of our own apply', async () => {
    const { manager, authPath } = makeFixture({ liveAuth: null, managerOpts: { watchDebounceMs: 50, pollIntervalMs: 60000 } });
    manager.startWatcher();
    try {
      await sleep(50);
      manager._armSelfWriteGuard(5000);
      fs.writeFileSync(authPath, JSON.stringify(makeAuth(UUID_C, 'ECHO')), 'utf-8');
      await sleep(400); // debounce (50ms) plus generous margin
      assertEqual(manager.readSnapshot(UUID_C), null, 'guarded write not captured');
    } finally {
      manager.stopWatcher();
    }
  });

  // ─── Apply transaction ────────────────────────────────────────────────
  await test('apply happy path: capture-before-overwrite, backup, swap, verify', async () => {
    const { manager, authPath } = makeFixture({});
    // Live is A (NOT yet captured); stored target is B.
    manager.saveSnapshot({ accountId: UUID_B, email: 'b@example.com', auth: makeAuth(UUID_B, 'TARGET-B'), tokenState: TOKEN_STATE_OK });
    const result = await manager.applyAccount(UUID_B);
    assertEqual(result.applied, true);
    assertEqual(result.alreadyActive, false);
    assertEqual(result.email, 'b@example.com');
    assert(!result.warning, 'unexpired token applies without a warning');
    // Live file now holds B's full auth payload.
    const live = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    assertEqual(live.tokens.refresh_token, 'rt-SYNTH-TARGET-B', 'live auth swapped to the target');
    assertEqual(manager.getActiveAccountId(), UUID_B);
    // Capture-before-overwrite: the replaced account A was auto-captured.
    assert(manager.readSnapshot(UUID_A), 'previous live account captured before overwrite');
    // A timestamped backup of the pre-swap file exists.
    const backups = fs.readdirSync(manager.backupsDir).filter((f) => f.endsWith('.bak'));
    assert(backups.length >= 1, 'backup written');
    const backupText = fs.readFileSync(path.join(manager.backupsDir, backups[0]), 'utf-8');
    assert(backupText.indexOf('rt-SYNTH-LIVE-A') !== -1, 'backup holds the pre-swap auth');
  });

  await test('apply alreadyActive is a no-op (no writes, no backup)', async () => {
    const { manager } = makeFixture({});
    await manager.syncActiveAuthToSnapshot();
    const result = await manager.applyAccount(UUID_A);
    assertEqual(result.applied, false);
    assertEqual(result.alreadyActive, true);
    assert(!fs.existsSync(manager.backupsDir) || fs.readdirSync(manager.backupsDir).length === 0, 'no backup for a no-op');
  });

  await test('apply blocks needs_login with 409 ACCT_TOKEN_DEAD', async () => {
    const { manager } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'DEAD-B'), tokenState: TOKEN_STATE_NEEDS_LOGIN });
    try {
      await manager.applyAccount(UUID_B);
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.status, 409);
      assertEqual(err.code, 'ACCT_TOKEN_DEAD');
    }
  });

  await test('apply errors: 400 VALIDATION, 404 ACCT_NOT_FOUND, 422 ACCT_INCOMPLETE', async () => {
    const { manager } = makeFixture({});
    try { await manager.applyAccount('not$valid'); throw new Error('no'); } catch (err) { assertEqual(err.code, 'VALIDATION'); }
    try { await manager.applyAccount('abcdef00-0000-0000-0000-000000000000'); throw new Error('no'); } catch (err) { assertEqual(err.code, 'ACCT_NOT_FOUND'); }
    manager.saveSnapshot({ accountId: UUID_C, auth: null, tokenState: TOKEN_STATE_OK });
    try { await manager.applyAccount(UUID_C); throw new Error('no'); } catch (err) { assertEqual(err.code, 'ACCT_INCOMPLETE'); }
  });

  await test('apply with an expired stored access token proceeds WITH a warning', async () => {
    const { manager, authPath } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'EXP-B', { accessExpMs: Date.now() - DAY_MS }), tokenState: TOKEN_STATE_OK });
    const result = await manager.applyAccount(UUID_B);
    assertEqual(result.applied, true, 'expired access token never blocks (the CLI refreshes on next use)');
    assert(result.warning && result.warning.indexOf('access window') !== -1, 'warning surfaced');
    assertEqual(JSON.parse(fs.readFileSync(authPath, 'utf-8')).tokens.refresh_token, 'rt-SYNTH-EXP-B');
  });

  await test('apply verify-failure restores the backup and throws ACCT_VERIFY_FAILED', async () => {
    // Sabotaged capability: the serializer writes a DIFFERENT account's
    // auth, so post-apply verification must fail and roll back.
    const { manager, authPath } = makeFixture({
      serializeAuth: () => JSON.stringify(makeAuth(UUID_C, 'WRONG')),
    });
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'SAB-B'), tokenState: TOKEN_STATE_OK });
    try {
      await manager.applyAccount(UUID_B);
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.code, 'ACCT_VERIFY_FAILED');
      assertEqual(err.status, 500);
    }
    const live = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    assertEqual(live.tokens.refresh_token, 'rt-SYNTH-LIVE-A', 'live file restored from the backup');
    assertEqual(manager.getActiveAccountId(), UUID_A, 'still the original account');
  });

  // ─── Delete ───────────────────────────────────────────────────────────
  await test('deleteSnapshot removes the snapshot file ONLY; live untouched; second delete 404s', async () => {
    const { manager, authPath, accountsDir } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'DEL-B'), tokenState: TOKEN_STATE_OK });
    const before = fs.readFileSync(authPath, 'utf-8');
    const r = await manager.deleteSnapshot(UUID_B);
    assertEqual(r.deleted, true);
    assert(!fs.existsSync(path.join(accountsDir, UUID_B + '.json')), 'snapshot file removed');
    assertEqual(fs.readFileSync(authPath, 'utf-8'), before, 'live auth file byte-identical');
    try {
      await manager.deleteSnapshot(UUID_B);
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.status, 404);
      assertEqual(err.code, 'ACCT_NOT_FOUND');
    }
  });

  // ─── Usage ────────────────────────────────────────────────────────────
  await test('usage 200 stores mapped windows and heals email/plan from the response', async () => {
    const { manager } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, email: 'old@example.com', plan: 'prolite', auth: makeAuth(UUID_B, 'USE-B'), tokenState: TOKEN_STATE_OK });
    stub.mode = 'ok'; stub.status = 200; stub.body = usageBody({ email: 'healed@example.com', plan: 'pro', usedPrimary: 42 });
    const snap = await manager.updateSnapshotUsage(UUID_B, { force: true });
    assert(snap.usage, 'usage stored');
    assertEqual(snap.usage.five_hour.utilization, 42);
    assert(typeof snap.usage.five_hour.resets_at === 'string' && snap.usage.five_hour.resets_at.endsWith('Z'), 'epoch seconds converted to ISO');
    assertEqual(snap.email, 'healed@example.com', 'email healed');
    assertEqual(snap.plan, 'pro', 'plan healed');
    assertEqual(snap.tokenState, TOKEN_STATE_OK);
    assertEqual(snap.lastError, null);
  });

  await test('usage cache: a fresh fetch is served with ZERO network calls', async () => {
    const { manager } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'CACHE-B'), tokenState: TOKEN_STATE_OK });
    stub.mode = 'ok'; stub.status = 200; stub.body = usageBody({});
    await manager.updateSnapshotUsage(UUID_B, { force: true });
    const hitsAfterFirst = stub.hits;
    await manager.updateSnapshotUsage(UUID_B, { force: false });
    assertEqual(stub.hits, hitsAfterFirst, 'second call served from cache');
  });

  await test('ACTIVE account fetches usage with the LIVE token, read-only', async () => {
    const { manager } = makeFixture({});
    await manager.syncActiveAuthToSnapshot();
    // Age the stored copy so live-vs-stored is distinguishable.
    manager.saveSnapshot({ accountId: UUID_A, auth: makeAuth(UUID_A, 'STALE-COPY', { lastRefresh: '2020-01-01T00:00:00Z' }) });
    stub.mode = 'ok'; stub.status = 200; stub.body = usageBody({});
    await manager.updateSnapshotUsage(UUID_A, { force: true });
    assert(stub.lastHeaders && String(stub.lastHeaders.authorization || '').indexOf('at-SYNTH-LIVE-A') !== -1
      ? true
      : decodeAuthTag(stub.lastHeaders) === 'at-SYNTH-LIVE-A',
      'Authorization used the LIVE file token, not the stale stored copy');
  });

  await test('usage 401 on an UNEXPIRED token -> needs_login (definitive)', async () => {
    const { manager } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'REJ-B'), tokenState: TOKEN_STATE_OK });
    stub.mode = 'ok'; stub.status = 401; stub.body = { detail: 'unauthorized' };
    const snap = await manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.tokenState, TOKEN_STATE_NEEDS_LOGIN, 'unexpired 401 is definitive');
    assert(snap.lastError && snap.lastError.kind === 'auth' && snap.lastError.status === 401, 'auth failure recorded');
  });

  await test('EXPIRED access token: usage round skipped entirely, state unchanged', async () => {
    const { manager } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'OLD-B', { accessExpMs: Date.now() - DAY_MS }), tokenState: TOKEN_STATE_OK });
    stub.mode = 'ok'; stub.status = 401; stub.body = {};
    const hitsBefore = stub.hits;
    const snap = await manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(stub.hits, hitsBefore, 'NO network call for an expired token (v1: no refresh, ever)');
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'expiry alone never changes tokenState');
    assertEqual(snap.usage, null, 'row keeps its (absent) usage');
  });

  await test('usage timeout -> lastError only, tokenState unchanged', async () => {
    const { manager } = makeFixture({ settings: { httpTimeoutSec: 1 } });
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'SLOW-B'), tokenState: TOKEN_STATE_OK });
    stub.mode = 'hang';
    const snap = await manager.updateSnapshotUsage(UUID_B, { force: true });
    stub.mode = 'ok';
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'transient failure is never a death verdict');
    assert(snap.lastError && snap.lastError.kind === 'transient', 'transient failure recorded');
  });

  await test('usage 5xx -> lastError only, prior usage cache kept', async () => {
    const { manager } = makeFixture({});
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'FIVEHUN-B'), tokenState: TOKEN_STATE_OK });
    stub.mode = 'ok'; stub.status = 200; stub.body = usageBody({ usedPrimary: 55 });
    await manager.updateSnapshotUsage(UUID_B, { force: true });
    stub.status = 503; stub.body = { error: 'down' };
    const snap = await manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.tokenState, TOKEN_STATE_OK);
    assertEqual(snap.usage.five_hour.utilization, 55, 'prior cache survives a 5xx');
    assert(snap.lastError && snap.lastError.status === 503, '5xx recorded as transient');
    stub.status = 200;
  });

  // ─── Safe list + leak gate ────────────────────────────────────────────
  await test('getSafeList shape: active flags, accessExpired, installed, sorted', async () => {
    const { manager } = makeFixture({});
    await manager.syncActiveAuthToSnapshot();
    manager.saveSnapshot({ accountId: UUID_B, email: 'b@example.com', label: 'Bee', auth: makeAuth(UUID_B, 'LIST-B', { accessExpMs: Date.now() - DAY_MS }), tokenState: TOKEN_STATE_OK });
    const list = manager.getSafeList();
    assertEqual(list.activeAccountId, UUID_A);
    assertEqual(list.activeAuthMode, 'chatgpt');
    assertEqual(list.installed, true);
    assert(typeof list.loginHint === 'string' && list.loginHint.length > 0, 'loginHint rides along');
    assertEqual(list.accounts.length, 2);
    assertEqual(list.accounts[0].accountId, UUID_A, 'active row sorts first');
    assertEqual(list.accounts[0].isActive, true);
    assertEqual(list.accounts[0].accessExpired, false);
    const rowB = list.accounts.find((a) => a.accountId === UUID_B);
    assertEqual(rowB.displayName, 'Bee');
    assertEqual(rowB.accessExpired, true, 'expired stored token surfaced as a derived flag');
    assertEqual(rowB.health, 'healthy');
  });

  await test('LEAK GATE: the safe list never contains token material', async () => {
    const { manager } = makeFixture({});
    await manager.syncActiveAuthToSnapshot();
    manager.saveSnapshot({ accountId: UUID_B, auth: makeAuth(UUID_B, 'LEAK-B'), tokenState: TOKEN_STATE_OK });
    stub.mode = 'ok'; stub.status = 200; stub.body = usageBody({});
    await manager.updateSnapshotUsage(UUID_B, { force: true });
    const raw = JSON.stringify(manager.getSafeList());
    assert(raw.indexOf('access_token') === -1, 'access_token key leaked');
    assert(raw.indexOf('refresh_token') === -1, 'refresh_token key leaked');
    assert(raw.indexOf('id_token') === -1, 'id_token key leaked');
    assert(raw.indexOf('rt-SYNTH') === -1, 'refresh token VALUE leaked');
    assert(raw.indexOf('SYNTHSIG') === -1, 'JWT material leaked');
    assert(raw.indexOf('"auth"') === -1, 'raw auth object leaked');
    assert(raw.indexOf('OPENAI_API_KEY') === -1, 'api key field leaked');
  });

  await test('getSafeList on a machine with no auth file: installed false, empty roster', async () => {
    const { manager } = makeFixture({ liveAuth: null });
    const list = manager.getSafeList();
    assertEqual(list.installed, false);
    assertEqual(list.activeAccountId, null);
    assertEqual(list.accounts.length, 0);
  });

  // ─── Teardown ─────────────────────────────────────────────────────────
  for (const res of stub.hanging) {
    try { res.destroy(); } catch (_) { /* best effort */ }
  }
  stubServer.close();

  console.log('  ' + '─'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + ((err && err.stack) || err));
  process.exit(1);
});

/**
 * Decode the `tag` claim from a Bearer JWT in captured stub headers, so
 * live-vs-stored token assertions do not depend on full-string equality.
 * @param {object|null} headers - Captured request headers.
 * @returns {string|null} The tag claim, or null.
 */
function decodeAuthTag(headers) {
  try {
    const bearer = String((headers && headers.authorization) || '');
    const token = bearer.replace(/^Bearer\s+/i, '');
    const seg = token.split('.')[1] || '';
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    return (JSON.parse(json) || {}).tag || null;
  } catch (_) {
    return null;
  }
}
