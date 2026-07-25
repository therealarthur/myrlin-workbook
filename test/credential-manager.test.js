#!/usr/bin/env node
/**
 * Unit tests for src/web/credential-manager.js (credential switcher T1).
 *
 * Hermetic: fixture HOME dirs under the test sandbox (CWM_DATA_DIR via
 * _test-data-dir), a local http stub for the usage and token endpoints,
 * no real network, no real HOME writes, no corpus scans.
 *
 * Focus areas per the design (section 8) plus the CORRECTED token-state
 * model: transient refresh failures never set needs_login; only a
 * definitive invalid_grant (or an empty refresh token with an expired
 * access token) does; expired access tokens never block apply; watcher
 * recapture of the active account always resurrects it; seed import
 * ignores the old buggy tokenDead flags; the active account NEVER hits the
 * token endpoint; the safe list never leaks token material.
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
  validateAccountUuid,
  writeFileAtomic,
  displayNameFor,
  healthFor,
  DEFAULT_CRED_SETTINGS,
  TOKEN_STATE_OK,
  TOKEN_STATE_NEEDS_LOGIN,
  TOKEN_STATE_UNVERIFIED,
  REFRESH_TIMEOUT_MS,
  SUSPECT_ESCALATE_COUNT,
  DEAD_RETRY_MIN,
  PROACTIVE_REFRESH_WINDOW_MIN,
  PROACTIVE_REFRESH_FLOOR_MIN,
  POOL_OWNER_MARKER_FILE,
  EXTERNAL_BRIDGE_OWNER,
  CRED_POOL_EXTERNAL_OWNER_CODE,
} = require('../src/web/credential-manager');

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

// ─── Fixture constants (distinctive values the safe-list test greps for) ───
const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444401';
const UUID_B = 'bbbbbbbb-1111-2222-3333-444444444402';
const UUID_C = 'cccccccc-1111-2222-3333-444444444403';
const EMAIL_A = 'account.a@example.com';
const EMAIL_B = 'account.b@example.com';
const HOUR_MS = 60 * 60 * 1000;

/**
 * Build a claudeAiOauth fixture object.
 * @param {string} tag - Distinctive token tag.
 * @param {number} expiresAt - Epoch ms expiry.
 * @param {string} [refreshToken] - Explicit refresh token ('' allowed).
 * @returns {object}
 */
function makeOauth(tag, expiresAt, refreshToken) {
  return {
    accessToken: 'at-FIXTURE-' + tag,
    refreshToken: refreshToken !== undefined ? refreshToken : ('rt-FIXTURE-' + tag),
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
    organizationUuid: 'ffffffff-0000-0000-0000-000000000001',
    organizationType: 'claude_max',
    displayName: 'Fixture Person',
    organizationName: 'Fixture Org',
    organizationRole: 'admin',
  };
}

/**
 * Write the exact v1 marker shape owned by Myrlin's bridge router.
 * @param {string} accountsDir - Credential snapshot pool root.
 * @returns {string} Marker path.
 */
function writePoolOwnerMarker(accountsDir) {
  const markerPath = path.join(accountsDir, POOL_OWNER_MARKER_FILE);
  fs.writeFileSync(markerPath, JSON.stringify({
    version: 1,
    owner: EXTERNAL_BRIDGE_OWNER,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    leaseId: 'a'.repeat(32),
  }), 'utf-8');
  return markerPath;
}

let fixtureSeq = 0;

/**
 * Create an isolated fixture environment plus a manager wired to the stub
 * endpoints. Live files are written for account A unless liveUuid is null.
 *
 * @param {object} [cfg]
 * @param {object|null} [cfg.liveOauth] - Live claudeAiOauth (null = no file).
 * @param {object|null} [cfg.liveIdentity] - Live oauthAccount (null = none).
 * @param {object} [cfg.settings] - settingsProvider return value.
 * @param {object} [cfg.managerOpts] - Extra createCredentialManager opts.
 * @returns {{manager: object, claudeDir: string, claudeJsonPath: string, accountsDir: string, credPath: string}}
 */
function makeFixture(cfg = {}) {
  fixtureSeq += 1;
  const root = path.join(process.env.CWM_DATA_DIR, 'mgr-fix-' + fixtureSeq);
  const claudeDir = path.join(root, 'dot-claude');
  const claudeJsonPath = path.join(root, 'dot-claude.json');
  const accountsDir = path.join(root, 'accounts');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  const credPath = path.join(claudeDir, '.credentials.json');
  const liveOauth = cfg.liveOauth !== undefined ? cfg.liveOauth : makeOauth('LIVE-A', Date.now() + 12 * HOUR_MS);
  const liveIdentity = cfg.liveIdentity !== undefined ? cfg.liveIdentity : makeIdentity(UUID_A, EMAIL_A);
  if (liveOauth) fs.writeFileSync(credPath, serializeCredentialsFile(liveOauth), 'utf-8');
  if (liveIdentity) fs.writeFileSync(claudeJsonPath, JSON.stringify({ numStartups: 5, oauthAccount: liveIdentity }, null, 2), 'utf-8');
  const settings = cfg.settings || {};
  const manager = createCredentialManager({
    claudeDir,
    claudeJsonPath,
    accountsDir,
    settingsProvider: () => settings,
    usageUrl: stubBase + '/usage',
    tokenUrl: stubBase + '/token',
    seedDir: path.join(root, 'no-seed-here'),
    watchDebounceMs: 20,
    pollIntervalMs: 250,
    log: silentLog,
    ...(cfg.managerOpts || {}),
  });
  return { manager, claudeDir, claudeJsonPath, accountsDir, credPath };
}

// Silent logger so expected warnings do not pollute test output.
const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

// ─── Stub HTTP server for the usage and token endpoints ─────────────────────
const stub = {
  tokenMode: 'ok',
  usageMode: 'ok',
  tokenHits: 0,
  usageHits: 0,
  lastUsageAuth: null,
  tokenDelayMs: 0,
  nextAccessToken: 'at-ROTATED-1',
  nextRefreshToken: 'rt-ROTATED-1',
  expiresInSec: 43200,
  onUsageRequest: null,
};

/** Reset stub counters and modes between tests. @returns {void} */
function resetStub() {
  stub.tokenMode = 'ok';
  stub.usageMode = 'ok';
  stub.tokenHits = 0;
  stub.usageHits = 0;
  stub.lastUsageAuth = null;
  stub.tokenDelayMs = 0;
  stub.nextAccessToken = 'at-ROTATED-1';
  stub.nextRefreshToken = 'rt-ROTATED-1';
  stub.onUsageRequest = null;
}

const stubServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/token') {
    stub.tokenHits += 1;
    const finish = () => {
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      switch (stub.tokenMode) {
        case 'ok':
          return json(200, { access_token: stub.nextAccessToken, refresh_token: stub.nextRefreshToken, expires_in: stub.expiresInSec });
        case 'ok_no_refresh':
          return json(200, { access_token: stub.nextAccessToken, expires_in: stub.expiresInSec });
        case 'invalid_grant_400':
          return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        case 'invalid_grant_401':
          return json(401, { error: 'invalid_grant' });
        case '401_nobody':
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          return res.end('unauthorized');
        case '403':
          return json(403, { error: 'forbidden' });
        case '400_other':
          return json(400, { error: 'invalid_request', error_description: 'malformed body' });
        case '500':
          res.writeHead(500);
          return res.end('server exploded');
        case '429':
          res.writeHead(429);
          return res.end('slow down');
        default:
          res.writeHead(500);
          return res.end('unknown stub mode');
      }
    };
    if (stub.tokenDelayMs > 0) setTimeout(finish, stub.tokenDelayMs);
    else finish();
    return;
  }
  if (req.method === 'GET' && req.url === '/usage') {
    stub.usageHits += 1;
    stub.lastUsageAuth = req.headers['authorization'] || null;
    if (typeof stub.onUsageRequest === 'function') {
      try { stub.onUsageRequest(); } catch (_) { /* recorded by the test */ }
    }
    if (stub.usageMode === 'ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        five_hour: { utilization: 34, resets_at: '2026-07-02T21:00:00+00:00', limit_dollars: 50, used_dollars: 17, remaining_dollars: 33 },
        seven_day: { utilization: 61, resets_at: '2026-07-08T07:00:00+00:00' },
        // Per-model weekly windows: opus present, sonnet null (the usual
        // live shape). The mapper must capture the present one and omit the
        // null one rather than storing a null key.
        seven_day_opus: { utilization: 12, resets_at: '2026-07-08T07:00:00+00:00' },
        seven_day_sonnet: null,
        limits: [
          // Index 0 stays the legacy five_hour row: older assertions index it.
          { kind: 'five_hour', percent: 34, severity: 'ok', resets_at: '2026-07-02T21:00:00+00:00', is_active: true, internal_secret: 'DO-NOT-SHIP' },
          // Object scope rows: the live per-model breakdown. The nested
          // internal marker must never survive the mapper (whitelist gate).
          { kind: 'weekly_scoped', group: 'weekly', percent: 38, severity: 'ok', resets_at: '2026-07-08T07:00:00+00:00', is_active: true, scope: { model: { display_name: 'Fable', internal_model_id: 'DO-NOT-SHIP-SCOPE' } } },
          { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'ok', resets_at: '2026-07-08T07:00:00+00:00', is_active: true, scope: { model: { display_name: 'Opus' } } },
          // Legacy string scope: must still pass through as row.scope.
          { kind: 'weekly_all', group: 'weekly', percent: 61, severity: 'ok', resets_at: '2026-07-08T07:00:00+00:00', is_active: true, scope: 'account_wide' },
          // Malformed object scopes: must degrade to no model, never throw.
          { kind: 'weekly_scoped', group: 'weekly', percent: 5, scope: { model: {} } },
          { kind: 'weekly_scoped', group: 'weekly', percent: 6, scope: { model: { display_name: 42 } } },
        ],
        extra_usage: {},
        spend: {},
      }));
      return;
    }
    res.writeHead(stub.usageMode === '401' ? 401 : 500);
    res.end('usage unavailable');
    return;
  }
  res.writeHead(404);
  res.end();
});

let stubBase = '';

(async function main() {
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  stubBase = 'http://127.0.0.1:' + stubServer.address().port;

  console.log('\n  credential-manager unit tests');
  console.log('  ' + '─'.repeat(70));

  // ─── Pure helpers ─────────────────────────────────────────────────────

  await test('serializeCredentialsFile round-trips with metadata intact', () => {
    const oauth = makeOauth('RT', 1751500000000);
    const text = serializeCredentialsFile(oauth);
    const back = JSON.parse(text).claudeAiOauth;
    assertEqual(back.accessToken, oauth.accessToken);
    assertEqual(back.refreshToken, oauth.refreshToken);
    assertEqual(back.expiresAt, 1751500000000);
    assert(typeof back.expiresAt === 'number', 'expiresAt stays numeric');
    assertEqual(back.subscriptionType, 'max');
    assertEqual(back.rateLimitTier, 'default_claude_max_20x');
    assertEqual(back.scopes[0], 'user:inference');
  });

  await test('displayNameFor fallback chain: label, email, uuid8 unnamed', () => {
    assertEqual(displayNameFor({ label: 'Personal', email: EMAIL_A, accountUuid: UUID_A }), 'Personal');
    assertEqual(displayNameFor({ label: '', email: EMAIL_A, accountUuid: UUID_A }), EMAIL_A);
    assertEqual(displayNameFor({ label: '', email: '', accountUuid: UUID_A }), UUID_A.slice(0, 8) + ' unnamed');
    assert(displayNameFor({}) !== '', 'never empty');
  });

  await test('validateAccountUuid rejects junk and path separators', () => {
    assert(validateAccountUuid(UUID_A), 'real uuid accepted');
    assert(validateAccountUuid('ABCDEF12'), '8 hex chars accepted');
    assert(!validateAccountUuid('..\\evil'), 'backslash rejected');
    assert(!validateAccountUuid('../evil'), 'dotdot slash rejected');
    assert(!validateAccountUuid('a/b'), 'slash rejected');
    assert(!validateAccountUuid('abc'), 'too short rejected');
    assert(!validateAccountUuid('f'.repeat(65)), 'too long rejected');
    assert(!validateAccountUuid('zzzzzzzz'), 'non-hex rejected');
    assert(!validateAccountUuid(''), 'empty rejected');
    assert(!validateAccountUuid(null), 'null rejected');
  });

  await test('writeFileAtomic retries EPERM renames then succeeds (3 attempts)', () => {
    const dir = path.join(process.env.CWM_DATA_DIR, 'atomic-test');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'out.json');
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = function (src, dest) {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRename.call(fs, src, dest);
    };
    try {
      writeFileAtomic(target, '{"ok":true}');
    } finally {
      fs.renameSync = realRename;
    }
    assertEqual(calls, 3, 'exactly 3 rename attempts');
    assertEqual(fs.readFileSync(target, 'utf-8'), '{"ok":true}');
  });

  // ─── Snapshot store ───────────────────────────────────────────────────

  await test('snapshot save/read round-trip with carry-forward semantics', async () => {
    const fx = makeFixture();
    const snap = fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      label: 'Work',
      credentials: makeOauth('B1', Date.now() + HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    assertEqual(snap.label, 'Work');
    const read = fx.manager.readSnapshot(UUID_B);
    assertEqual(read.email, EMAIL_B);
    assertEqual(read.tokenState, TOKEN_STATE_OK);
    assertEqual(read.credentials.accessToken, 'at-FIXTURE-B1');
    // Re-save without a label: the existing label survives (preserveLabel).
    fx.manager.saveSnapshot({ accountUuid: UUID_B, credentials: makeOauth('B2', Date.now() + 2 * HOUR_MS) });
    const read2 = fx.manager.readSnapshot(UUID_B);
    assertEqual(read2.label, 'Work', 'label carried forward');
    assertEqual(read2.credentials.accessToken, 'at-FIXTURE-B2', 'credentials updated');
    assertEqual(read2.tokenState, TOKEN_STATE_OK, 'tokenState carried forward');
  });

  await test('bridge marker alone does not change the default-off credential behavior', async () => {
    const fx = makeFixture();
    writePoolOwnerMarker(fx.accountsDir);
    const state = fx.manager.getCredentialPoolState();
    assertEqual(state.configured, false, 'external ownership remains opt-in');
    assertEqual(state.readOnly, false, 'marker presence alone does not enable passive mode');
    assertEqual(state.marker.valid, true, 'router marker shape is recognized');
    assertEqual(state.marker.owner, EXTERNAL_BRIDGE_OWNER);
    const captured = await fx.manager.captureCurrent({ label: 'Default still writable' });
    assertEqual(captured.accountUuid, UUID_A, 'legacy capture behavior is preserved when the flag is off');
    const priorEnv = process.env.CWM_CRED_EXTERNAL_BRIDGE_OWNER;
    try {
      process.env.CWM_CRED_EXTERNAL_BRIDGE_OWNER = '1';
      assertEqual(fx.manager.isCredentialPoolReadOnly(), true, 'strict env opt-in enables passive mode');
    } finally {
      if (priorEnv === undefined) delete process.env.CWM_CRED_EXTERNAL_BRIDGE_OWNER;
      else process.env.CWM_CRED_EXTERNAL_BRIDGE_OWNER = priorEnv;
    }
  });

  await test('external bridge ownership is fail-closed across refresh, sync, seed, snapshot, and live-file writes', async () => {
    resetStub();
    const settings = { externalBridgeOwner: false };
    const fx = makeFixture({ settings });
    const cachedUsage = {
      five_hour: { utilization: 17, resets_at: '2026-07-25T00:00:00Z' },
      seven_day: { utilization: 29, resets_at: '2026-07-31T00:00:00Z' },
      fetchedAt: '2026-07-24T00:00:00.000Z',
    };
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      label: 'Externally owned',
      credentials: makeOauth('PASSIVE-B', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      usage: cachedUsage,
      tokenState: TOKEN_STATE_OK,
    });
    const markerPath = writePoolOwnerMarker(fx.accountsDir);
    const snapshotFile = path.join(fx.accountsDir, UUID_B + '.json');
    const snapshotBefore = fs.readFileSync(snapshotFile, 'utf-8');
    const liveCredBefore = fs.readFileSync(fx.credPath, 'utf-8');
    const liveIdentityBefore = fs.readFileSync(fx.claudeJsonPath, 'utf-8');
    settings.externalBridgeOwner = true;

    const state = fx.manager.getCredentialPoolState();
    assertEqual(state.readOnly, true);
    assertEqual(state.marker.path, markerPath);
    assertEqual(state.marker.valid, true);
    assertEqual(state.marker.owner, EXTERNAL_BRIDGE_OWNER);
    assertEqual(state.marker.pid, process.pid);
    fs.unlinkSync(markerPath);
    assertEqual(fx.manager.getCredentialPoolState().readOnly, true,
      'configured ownership stays fail-closed when the marker is absent');
    fs.writeFileSync(markerPath, '{"owner":"unexpected"}', 'utf-8');
    const malformedState = fx.manager.getCredentialPoolState();
    assertEqual(malformedState.readOnly, true, 'malformed marker cannot reopen writes');
    assertEqual(malformedState.marker.valid, false);
    writePoolOwnerMarker(fx.accountsDir);

    const list = fx.manager.getSafeList();
    const row = list.profiles.find((p) => p.profileId === UUID_B);
    assert(row && row.usage, 'cached read-only usage remains visible');
    assertEqual(row.usage.five_hour.utilization, 17);
    const usageResult = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(usageResult.usage.five_hour.utilization, 17, 'usage refresh degrades to cached data');
    assertEqual(stub.usageHits, 0, 'passive usage never calls the usage endpoint');
    assertEqual(stub.tokenHits, 0, 'passive usage never calls the token endpoint');

    assertEqual(await fx.manager.syncActiveTokenToProfile(), null, 'PC sync is a no-op');
    const macSync = await fx.manager.syncBackFromMac(
      UUID_B,
      serializeCredentialsFile(makeOauth('MAC-NEWER', Date.now() + 12 * HOUR_MS)),
    );
    assertEqual(macSync.synced, false, 'Mac sync-back is a no-op');
    assert(macSync.reason && macSync.reason.indexOf('read-only') !== -1, 'Mac sync-back reports passive mode');
    const seed = await fx.manager.seedFromClaudeSwap();
    assertEqual(seed.readOnly, true, 'seed is explicitly skipped');
    assert(!fs.existsSync(path.join(fx.accountsDir, '.seeded')), 'passive seed writes no sentinel');

    const blocked = [
      () => fx.manager.saveSnapshot({ accountUuid: UUID_C }),
      () => fx.manager.captureCurrent({}),
      () => fx.manager.setLabel(UUID_B, 'blocked'),
      () => fx.manager.deleteSnapshot(UUID_B),
      () => fx.manager.applyCredential(UUID_B),
      () => fx.manager.refreshInactiveToken('rt-FIXTURE-BLOCKED'),
      () => fx.manager.backupLiveFile(fx.credPath),
    ];
    for (const invoke of blocked) {
      let err = null;
      try { await invoke(); } catch (caught) { err = caught; }
      assert(err, 'mutation must throw a typed conflict');
      assertEqual(err.status, 409);
      assertEqual(err.code, CRED_POOL_EXTERNAL_OWNER_CODE);
      assert(err.message.indexOf(EXTERNAL_BRIDGE_OWNER) !== -1, 'conflict names the bridge owner');
    }

    fx.manager.startCredentialWatcher();
    await sleep(50);
    fx.manager.stopCredentialWatcher();
    assertEqual(fs.readFileSync(snapshotFile, 'utf-8'), snapshotBefore, 'snapshot bytes stay unchanged');
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), liveCredBefore, 'live credential bytes stay unchanged');
    assertEqual(fs.readFileSync(fx.claudeJsonPath, 'utf-8'), liveIdentityBefore, 'live identity bytes stay unchanged');
    assert(!fs.existsSync(fx.manager.backupsDir), 'no credential backup file was written');
    assertEqual(stub.tokenHits, 0, 'direct token refresh was blocked before network');
  });

  await test('legacy tokenDead files normalize to unverified, never needs_login', async () => {
    const fx = makeFixture();
    // Write a legacy-schema snapshot directly (as an older build would have).
    const legacy = {
      accountUuid: UUID_B,
      email: EMAIL_B,
      label: 'Old',
      savedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credentials: makeOauth('LEG', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      usage: null,
      tokenDead: true,
    };
    fs.writeFileSync(path.join(fx.accountsDir, UUID_B + '.json'), JSON.stringify(legacy), 'utf-8');
    const read = fx.manager.readSnapshot(UUID_B);
    assertEqual(read.tokenState, TOKEN_STATE_UNVERIFIED, 'legacy dead flag distrusted, mapped to unverified');
    assertEqual(read.tokenDead, undefined, 'legacy field dropped from the schema');
  });

  await test('setLabel trims, caps at 60, empty clears; VALIDATION beyond cap', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    await fx.manager.setLabel(UUID_A, '  Padded Name  ');
    assertEqual(fx.manager.readSnapshot(UUID_A).label, 'Padded Name');
    let threw = null;
    try { await fx.manager.setLabel(UUID_A, 'x'.repeat(61)); } catch (err) { threw = err; }
    assert(threw && threw.code === 'VALIDATION' && threw.status === 400, '61 chars rejected with VALIDATION 400');
    await fx.manager.setLabel(UUID_A, 'x'.repeat(60)); // exactly 60 is fine
    await fx.manager.setLabel(UUID_A, '');
    assertEqual(fx.manager.readSnapshot(UUID_A).label, '', 'empty clears');
    assertEqual(displayNameFor(fx.manager.readSnapshot(UUID_A)), EMAIL_A, 'display falls back to email');
  });

  await test('label survives rotation write-back untouched', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({ label: 'Keep Me' });
    // Simulate the CLI rotating tokens: newer pair in the live file.
    fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('LIVE-A2', Date.now() + 24 * HOUR_MS)), 'utf-8');
    await fx.manager.syncActiveTokenToProfile();
    const snap = fx.manager.readSnapshot(UUID_A);
    assertEqual(snap.credentials.accessToken, 'at-FIXTURE-LIVE-A2', 'rotated pair written back');
    assertEqual(snap.label, 'Keep Me', 'label untouched by write-back');
  });

  await test('captureCurrent throws CRED_LIVE_STATE_UNREADABLE when live state missing', async () => {
    const fx = makeFixture({ liveOauth: null });
    let threw = null;
    try { await fx.manager.captureCurrent({}); } catch (err) { threw = err; }
    assert(threw && threw.code === 'CRED_LIVE_STATE_UNREADABLE' && threw.status === 500);
  });

  // ─── Rotation write-back watcher (design Decision 3) ──────────────────

  await test('watcher writes a NEWER rotated pair back into the snapshot', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    fx.manager.startCredentialWatcher();
    try {
      fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('LIVE-NEW', Date.now() + 30 * HOUR_MS)), 'utf-8');
      const updated = await waitFor(() => {
        const s = fx.manager.readSnapshot(UUID_A);
        return s && s.credentials.accessToken === 'at-FIXTURE-LIVE-NEW' ? s : null;
      });
      assert(updated, 'snapshot picked up the rotated pair');
      assert(updated.updatedAt, 'updatedAt refreshed');
    } finally {
      fx.manager.stopCredentialWatcher();
    }
  });

  await test('watcher does NOT overwrite with an OLDER pair', async () => {
    const fx = makeFixture();
    // Capture with a far-future expiry, then write an older live pair.
    fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('FRESH', Date.now() + 48 * HOUR_MS)), 'utf-8');
    await fx.manager.captureCurrent({});
    fx.manager.startCredentialWatcher();
    try {
      fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('STALE', Date.now() + HOUR_MS)), 'utf-8');
      await sleep(500);
      const snap = fx.manager.readSnapshot(UUID_A);
      assertEqual(snap.credentials.accessToken, 'at-FIXTURE-FRESH', 'older pair rejected');
    } finally {
      fx.manager.stopCredentialWatcher();
    }
  });

  await test('watcher auto-captures an unknown active accountUuid', async () => {
    const fx = makeFixture();
    fx.manager.startCredentialWatcher();
    try {
      // No snapshot exists yet; the initial sync plus the change event
      // should self-register the active account.
      fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('LIVE-A', Date.now() + 12 * HOUR_MS)), 'utf-8');
      const snap = await waitFor(() => fx.manager.readSnapshot(UUID_A));
      assert(snap, 'active account auto-captured');
      assertEqual(snap.tokenState, TOKEN_STATE_OK);
      assertEqual(snap.email, EMAIL_A);
    } finally {
      fx.manager.stopCredentialWatcher();
    }
  });

  await test('watcher survives a malformed live file (no crash, no write)', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    const before = fs.readFileSync(path.join(fx.accountsDir, UUID_A + '.json'), 'utf-8');
    fx.manager.startCredentialWatcher();
    try {
      fs.writeFileSync(fx.credPath, '{not json at all', 'utf-8');
      await sleep(500);
      const after = fs.readFileSync(path.join(fx.accountsDir, UUID_A + '.json'), 'utf-8');
      assertEqual(after, before, 'snapshot untouched by malformed live file');
    } finally {
      fx.manager.stopCredentialWatcher();
    }
  });

  await test('self-write guard: watcher ignores events inside the guard window', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    fx.manager.startCredentialWatcher();
    try {
      fx.manager._armSelfWriteGuard(10000);
      fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('GUARDED', Date.now() + 40 * HOUR_MS)), 'utf-8');
      await sleep(500);
      const snap = fx.manager.readSnapshot(UUID_A);
      assertEqual(snap.credentials.accessToken, 'at-FIXTURE-LIVE-A', 'guarded event ignored');
    } finally {
      fx.manager.stopCredentialWatcher();
    }
  });

  await test('stopCredentialWatcher stops updates', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    fx.manager.startCredentialWatcher();
    await sleep(50);
    fx.manager.stopCredentialWatcher();
    fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('AFTER-STOP', Date.now() + 40 * HOUR_MS)), 'utf-8');
    await sleep(500);
    const snap = fx.manager.readSnapshot(UUID_A);
    assertEqual(snap.credentials.accessToken, 'at-FIXTURE-LIVE-A', 'no update after stop');
  });

  await test('recapture of the active account RESURRECTS needs_login to ok (mandatory)', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    // Simulate a (wrong or stale) dead verdict on the active account.
    fx.manager.saveSnapshot({ accountUuid: UUID_A, tokenState: TOKEN_STATE_NEEDS_LOGIN });
    assertEqual(fx.manager.readSnapshot(UUID_A).tokenState, TOKEN_STATE_NEEDS_LOGIN);
    await fx.manager.syncActiveTokenToProfile();
    const snap = fx.manager.readSnapshot(UUID_A);
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'live login is definitive proof; state resurrected');
    assertEqual(snap.lastRefreshError, null, 'stale error cleared');
  });

  // ─── Usage and token policy (corrected state model) ───────────────────

  await test('fresh usage cache means zero network calls', async () => {
    resetStub();
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    fx.manager.saveSnapshot({
      accountUuid: UUID_A,
      usage: { five_hour: { utilization: 10, resets_at: null }, seven_day: null, fetchedAt: new Date().toISOString() },
    });
    await fx.manager.updateSnapshotUsage(UUID_A, { force: false });
    assertEqual(stub.tokenHits, 0, 'no token calls');
    assertEqual(stub.usageHits, 0, 'no usage calls');
  });

  await test('ACTIVE account: read-only live token, token endpoint NEVER called', async () => {
    resetStub();
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    // Make the STORED snapshot expired so a buggy implementation would be
    // tempted to refresh; the live file holds the fresh token.
    fx.manager.saveSnapshot({ accountUuid: UUID_A, credentials: makeOauth('STORED-OLD', Date.now() - HOUR_MS) });
    const snap = await fx.manager.updateSnapshotUsage(UUID_A, { force: true });
    assertEqual(stub.tokenHits, 0, 'active account must NEVER hit the token endpoint');
    assertEqual(stub.usageHits, 1, 'one read-only usage call');
    assertEqual(stub.lastUsageAuth, 'Bearer at-FIXTURE-LIVE-A', 'live token used, not the stored one');
    assertEqual(snap.usage.five_hour.utilization, 34);
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'usage success is positive evidence');
  });

  await test('usage mapper: model scope objects, string scope, seven_day_opus, malformed scope', async () => {
    resetStub();
    const fx = makeFixture();
    await fx.manager.captureCurrent({});
    const snap = await fx.manager.updateSnapshotUsage(UUID_A, { force: true });
    const limits = snap.usage.limits;
    assert(Array.isArray(limits) && limits.length === 6, 'all stub limit rows mapped');

    // Object scope with model.display_name lands as row.model.
    const fable = limits.find((l) => l.model === 'Fable');
    assert(fable, 'weekly_scoped object scope yields row.model = display_name');
    assertEqual(fable.kind, 'weekly_scoped');
    assertEqual(fable.percent, 38);
    assertEqual(fable.resets_at, '2026-07-08T07:00:00+00:00');
    assert(fable.scope === undefined, 'raw scope object is never stored');
    assert(JSON.stringify(limits).indexOf('DO-NOT-SHIP-SCOPE') === -1,
      'nested scope internals never survive the mapper');
    const opus = limits.find((l) => l.model === 'Opus');
    assert(opus && opus.percent === 12, 'second model row mapped independently');

    // String scope still passes through untouched (legacy shape).
    const stringScoped = limits.find((l) => l.scope === 'account_wide');
    assert(stringScoped, 'string scope still stored as row.scope');
    assert(stringScoped.model === undefined, 'string scope never fabricates a model');

    // Malformed object scopes degrade to no model field, without throwing.
    const malformed = limits.filter((l) => l.kind === 'weekly_scoped' && l.model === undefined);
    assertEqual(malformed.length, 2, 'both malformed scopes mapped without a model');

    // Top-level per-model weekly windows: present opus captured, null sonnet omitted.
    assert(snap.usage.seven_day_opus, 'seven_day_opus captured when present');
    assertEqual(snap.usage.seven_day_opus.utilization, 12);
    assertEqual(snap.usage.seven_day_opus.resets_at, '2026-07-08T07:00:00+00:00');
    assert(!('seven_day_sonnet' in snap.usage), 'null seven_day_sonnet is omitted, not stored as null');

    // Pre-existing windows unchanged by the additive mapper work.
    assertEqual(snap.usage.five_hour.utilization, 34);
    assertEqual(snap.usage.seven_day.utilization, 61);
  });

  await test('inactive expired: refresh, rotated pair persisted BEFORE the usage call', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-OLD', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    let onDiskAtUsageTime = null;
    stub.onUsageRequest = () => {
      onDiskAtUsageTime = fs.readFileSync(path.join(fx.accountsDir, UUID_B + '.json'), 'utf-8');
    };
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(stub.tokenHits, 1, 'one refresh call');
    assertEqual(stub.usageHits, 1, 'one usage call');
    assert(onDiskAtUsageTime && onDiskAtUsageTime.indexOf('rt-ROTATED-1') !== -1,
      'rotated refresh token was on disk BEFORE the usage request');
    assertEqual(snap.credentials.accessToken, 'at-ROTATED-1');
    assertEqual(snap.credentials.refreshToken, 'rt-ROTATED-1');
    assert(snap.credentials.expiresAt > Date.now(), 'absolute epoch-ms expiry in the future');
    assertEqual(snap.credentials.subscriptionType, 'max', 'metadata carried across rotation');
    assertEqual(snap.tokenState, TOKEN_STATE_OK);
    assertEqual(snap.usage.seven_day.utilization, 61);
    assert(!snap.usage.limits[0].internal_secret, 'limits sanitized to the whitelisted fields');
  });

  await test('refresh response without refresh_token keeps the old one', async () => {
    resetStub();
    stub.tokenMode = 'ok_no_refresh';
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-KEEP', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.credentials.accessToken, 'at-ROTATED-1', 'new access token adopted');
    assertEqual(snap.credentials.refreshToken, 'rt-FIXTURE-B-KEEP', 'old refresh token kept');
  });

  await test('TRANSIENT refresh failures never set needs_login (500, 429, network, timeout)', async () => {
    // 500 and 429 against the stub.
    for (const mode of ['500', '429']) {
      resetStub();
      stub.tokenMode = mode;
      const fx = makeFixture();
      fx.manager.saveSnapshot({
        accountUuid: UUID_B,
        email: EMAIL_B,
        credentials: makeOauth('B-T' + mode, Date.now() - HOUR_MS),
        identity: makeIdentity(UUID_B, EMAIL_B),
        tokenState: TOKEN_STATE_OK,
      });
      const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
      assertEqual(snap.tokenState, TOKEN_STATE_OK, 'HTTP ' + mode + ' keeps prior state');
      assertEqual(snap.lastRefreshError.kind, 'server', 'HTTP ' + mode + ' recorded as server kind');
      assertEqual(snap.credentials.accessToken, 'at-FIXTURE-B-T' + mode, 'stored pair untouched');
      assertEqual(stub.usageHits, 0, 'no usage call without a fresh token');
    }
    // Network error: connection refused (nothing listens on port 1).
    {
      resetStub();
      const fx = makeFixture({ managerOpts: { tokenUrl: 'http://127.0.0.1:1/token' } });
      fx.manager.saveSnapshot({
        accountUuid: UUID_B,
        email: EMAIL_B,
        credentials: makeOauth('B-NET', Date.now() - HOUR_MS),
        identity: makeIdentity(UUID_B, EMAIL_B),
        tokenState: TOKEN_STATE_OK,
      });
      const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
      assertEqual(snap.tokenState, TOKEN_STATE_OK, 'network error keeps prior state');
      assertEqual(snap.lastRefreshError.kind, 'network');
    }
    // Timeout: stub delays past a tiny injected refresh timeout.
    {
      resetStub();
      stub.tokenDelayMs = 600;
      const fx = makeFixture({ managerOpts: { refreshTimeoutMs: 100 } });
      fx.manager.saveSnapshot({
        accountUuid: UUID_B,
        email: EMAIL_B,
        credentials: makeOauth('B-TMO', Date.now() - HOUR_MS),
        identity: makeIdentity(UUID_B, EMAIL_B),
        tokenState: TOKEN_STATE_OK,
      });
      const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
      assertEqual(snap.tokenState, TOKEN_STATE_OK, 'timeout keeps prior state');
      assertEqual(snap.lastRefreshError.kind, 'timeout');
      stub.tokenDelayMs = 0;
    }
    assertEqual(REFRESH_TIMEOUT_MS, 15000, 'default refresh timeout is 15s, not 5s');
  });

  await test('ONLY invalid_grant is a one-shot death verdict, WITH evidence preserved', async () => {
    for (const mode of ['invalid_grant_400', 'invalid_grant_401']) {
      resetStub();
      stub.tokenMode = mode;
      const fx = makeFixture();
      fx.manager.saveSnapshot({
        accountUuid: UUID_B,
        email: EMAIL_B,
        credentials: makeOauth('B-DEAD', Date.now() - HOUR_MS),
        identity: makeIdentity(UUID_B, EMAIL_B),
        tokenState: TOKEN_STATE_OK,
      });
      const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
      assertEqual(snap.tokenState, TOKEN_STATE_NEEDS_LOGIN, mode + ' is a definitive death verdict');
      assertEqual(stub.usageHits, 0, 'no usage call for a dead token');
      // Expiry-fix spec Phase 1 item 2: the old code wrote null here and
      // erased the diagnosability story. Evidence must now survive.
      assert(snap.lastRefreshError, mode + ': lastRefreshError must NEVER be null on a rejection');
      assertEqual(snap.lastRefreshError.kind, 'auth', mode + ': rejection kind is auth');
      assertEqual(snap.lastRefreshError.status, mode === 'invalid_grant_400' ? 400 : 401);
      assert(Number.isFinite(Date.parse(snap.lastRefreshError.at)), 'evidence carries a parseable timestamp');
      assertEqual(snap.lastRefreshError.detail, 'invalid_grant');
    }
  });

  await test('SUSPECT responses (403, bodyless 401) climb the ladder: needs_login only on the 3rd consecutive', async () => {
    for (const mode of ['403', '401_nobody']) {
      resetStub();
      stub.tokenMode = mode;
      const fx = makeFixture();
      fx.manager.saveSnapshot({
        accountUuid: UUID_B,
        email: EMAIL_B,
        credentials: makeOauth('B-SUS', Date.now() - HOUR_MS),
        identity: makeIdentity(UUID_B, EMAIL_B),
        tokenState: TOKEN_STATE_OK,
      });
      // Rungs 1 and 2: prior state kept, auth_suspect evidence recorded.
      for (let rung = 1; rung < SUSPECT_ESCALATE_COUNT; rung++) {
        const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
        assertEqual(snap.tokenState, TOKEN_STATE_OK, mode + ' rung ' + rung + ': a suspect never nukes the row');
        assertEqual(snap.lastRefreshError.kind, 'auth_suspect', mode + ' rung ' + rung + ': suspect evidence recorded');
        assertEqual(snap.lastRefreshError.count, rung, mode + ' rung ' + rung + ': consecutive counter');
        assertEqual(snap.lastRefreshError.status, mode === '403' ? 403 : 401);
        // Health mapping (spec item 5): ok + auth_suspect renders amber.
        const row = fx.manager.getSafeList().profiles.find((p) => p.profileId === UUID_B);
        assertEqual(row.health, 'needs-attention', mode + ' rung ' + rung + ': amber, not healthy, not red');
        assertEqual(row.tokenDead, false, mode + ' rung ' + rung + ': not dead yet');
      }
      // Rung 3: escalation to needs_login, with the full story preserved.
      const dead = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
      assertEqual(dead.tokenState, TOKEN_STATE_NEEDS_LOGIN, mode + ': 3rd consecutive suspect escalates');
      assertEqual(dead.lastRefreshError.kind, 'auth');
      assertEqual(dead.lastRefreshError.count, SUSPECT_ESCALATE_COUNT);
      assert(dead.lastRefreshError.detail.indexOf('escalated') !== -1, 'escalation story preserved');
      assertEqual(stub.tokenHits, SUSPECT_ESCALATE_COUNT, mode + ': one token call per rung');
      assertEqual(stub.usageHits, 0, 'no usage call rode a failed refresh');
    }
  });

  await test('a successful refresh RESETS the suspect ladder (only consecutive suspects escalate)', async () => {
    resetStub();
    stub.tokenMode = '403';
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-LAD', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    await fx.manager.updateSnapshotUsage(UUID_B, { force: true }); // suspect 1
    assertEqual(fx.manager.readSnapshot(UUID_B).lastRefreshError.count, 1);
    stub.tokenMode = 'ok';
    const healed = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(healed.tokenState, TOKEN_STATE_OK, 'refresh success heals');
    assertEqual(healed.lastRefreshError, null, 'success clears the evidence, resetting the counter');
    // Re-expire the stored pair and go suspect again: the counter must
    // restart at 1, proving the earlier rung did not survive the success.
    fx.manager.saveSnapshot({ accountUuid: UUID_B, credentials: makeOauth('B-LAD2', Date.now() - HOUR_MS) });
    stub.tokenMode = '403';
    const again = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(again.tokenState, TOKEN_STATE_OK, 'still ok: this is rung 1 of a NEW ladder');
    assertEqual(again.lastRefreshError.count, 1, 'counter restarted after the healthy refresh');
  });

  await test('non-invalid_grant 400 is a PROTOCOL bug: state kept, error recorded', async () => {
    resetStub();
    stub.tokenMode = '400_other';
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-PROTO', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'our request bug never kills the token');
    assertEqual(snap.lastRefreshError.kind, 'protocol');
    assertEqual(snap.lastRefreshError.status, 400);
  });

  await test('empty refreshToken with an expired access token = needs_login WITHOUT network', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-NORT', Date.now() - HOUR_MS, ''),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.tokenState, TOKEN_STATE_NEEDS_LOGIN);
    assertEqual(stub.tokenHits, 0, 'zero network calls');
    assertEqual(stub.usageHits, 0, 'zero network calls');
  });

  await test('usage success CLEARS needs_login (unexpired access token, no refresh call)', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-ALIVE', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(stub.tokenHits, 0, 'unexpired token needs no refresh');
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'usage success resurrects the account');
    assertEqual(snap.usage.five_hour.utilization, 34);
  });

  await test('usage FAILURE keeps the prior cache and never changes tokenState', async () => {
    resetStub();
    stub.usageMode = '401';
    const fx = makeFixture();
    const priorUsage = { five_hour: { utilization: 5, resets_at: null }, seven_day: null, fetchedAt: new Date(Date.now() - HOUR_MS).toISOString() };
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-U401', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
      usage: priorUsage,
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'a usage 401 says NOTHING about the refresh token');
    assertEqual(snap.usage.five_hour.utilization, 5, 'prior cache kept');
  });

  // ─── Apply transaction ────────────────────────────────────────────────

  await test('applyCredential happy path: identity first, tokens last, backups, verify', async () => {
    resetStub();
    const fx = makeFixture();
    await fx.manager.captureCurrent({ label: 'A' });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      label: 'B',
      credentials: makeOauth('B-APPLY', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const realRename = fs.renameSync;
    const renameTargets = [];
    fs.renameSync = function (src, dest) { renameTargets.push(dest); return realRename.call(fs, src, dest); };
    let result;
    try {
      result = await fx.manager.applyCredential(UUID_B);
    } finally {
      fs.renameSync = realRename;
    }
    assertEqual(result.applied, true);
    assertEqual(result.alreadyActive, false);
    assertEqual(result.email, EMAIL_B);
    const idxIdentity = renameTargets.indexOf(fx.claudeJsonPath);
    const idxTokens = renameTargets.indexOf(fx.credPath);
    assert(idxIdentity !== -1 && idxTokens !== -1, 'both live files written');
    assert(idxIdentity < idxTokens, 'IDENTITY FIRST, TOKENS LAST (load-bearing order)');
    const liveCred = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8')).claudeAiOauth;
    assertEqual(liveCred.accessToken, 'at-FIXTURE-B-APPLY');
    const liveIdentity = JSON.parse(fs.readFileSync(fx.claudeJsonPath, 'utf-8')).oauthAccount;
    assertEqual(liveIdentity.accountUuid, UUID_B, 'verify target is live');
    assert(JSON.parse(fs.readFileSync(fx.claudeJsonPath, 'utf-8')).numStartups === 5, 'surgical edit: other keys survive');
    const backups = fs.readdirSync(fx.manager.backupsDir);
    assert(backups.some((f) => f.startsWith('.credentials.json.')), 'token backup exists');
    assert(backups.some((f) => f.startsWith(path.basename(fx.claudeJsonPath) + '.')), 'identity backup exists');
    assertEqual(stub.tokenHits, 0, 'unexpired target: zero network');
    // Step 1 sync-back captured the outgoing account's freshest pair.
    assert(fx.manager.readSnapshot(UUID_A), 'outgoing account snapshot exists');
    // alreadyActive no-op afterwards.
    const credBytes = fs.readFileSync(fx.credPath, 'utf-8');
    const again = await fx.manager.applyCredential(UUID_B);
    assertEqual(again.alreadyActive, true);
    assertEqual(again.applied, false);
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), credBytes, 'no-op touched nothing');
  });

  await test('expired access token does NOT block apply: inline verification refresh runs', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-EXPIRED', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const result = await fx.manager.applyCredential(UUID_B);
    assertEqual(result.applied, true);
    assert(!result.warning, 'clean verification carries no warning');
    assertEqual(stub.tokenHits, 1, 'inline verification refresh ran');
    const liveCred = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8')).claudeAiOauth;
    assertEqual(liveCred.accessToken, 'at-ROTATED-1', 'FRESH pair applied, not the expired one');
    const snap = fx.manager.readSnapshot(UUID_B);
    assertEqual(snap.credentials.refreshToken, 'rt-ROTATED-1', 'rotated pair persisted to the snapshot');
  });

  await test('transient verification failure applies anyway WITH a warning', async () => {
    resetStub();
    stub.tokenMode = '500';
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-TRANS', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const result = await fx.manager.applyCredential(UUID_B);
    assertEqual(result.applied, true, 'NEVER block on transience');
    assert(result.warning && result.warning.indexOf('/login') !== -1, 'warning explains the recovery path');
    const liveCred = JSON.parse(fs.readFileSync(fx.credPath, 'utf-8')).claudeAiOauth;
    assertEqual(liveCred.accessToken, 'at-FIXTURE-B-TRANS', 'stored (expired) pair applied as-is');
    assertEqual(fx.manager.readSnapshot(UUID_B).tokenState, TOKEN_STATE_OK, 'state kept');
  });

  await test('invalid_grant at verification blocks apply with CRED_TOKEN_DEAD (409)', async () => {
    resetStub();
    stub.tokenMode = 'invalid_grant_400';
    const fx = makeFixture();
    const credBefore = fs.readFileSync(fx.credPath, 'utf-8');
    const jsonBefore = fs.readFileSync(fx.claudeJsonPath, 'utf-8');
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-IG', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    let threw = null;
    try { await fx.manager.applyCredential(UUID_B); } catch (err) { threw = err; }
    assert(threw && threw.code === 'CRED_TOKEN_DEAD' && threw.status === 409);
    assertEqual(fx.manager.readSnapshot(UUID_B).tokenState, TOKEN_STATE_NEEDS_LOGIN, 'definitive verdict persisted');
    assertEqual(fs.readFileSync(fx.credPath, 'utf-8'), credBefore, 'live token file untouched');
    assertEqual(fs.readFileSync(fx.claudeJsonPath, 'utf-8'), jsonBefore, 'live identity file untouched');
  });

  await test('a CONFIRMED needs_login state blocks apply without any network call', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-DEADSTATE', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
    });
    let threw = null;
    try { await fx.manager.applyCredential(UUID_B); } catch (err) { threw = err; }
    assert(threw && threw.code === 'CRED_TOKEN_DEAD' && threw.status === 409);
    assertEqual(stub.tokenHits, 0, 'no network on a confirmed dead state');
  });

  await test('apply rollback: failed token write restores the identity file byte for byte', async () => {
    resetStub();
    const fx = makeFixture({ liveOauth: null });
    // Live credential file replaced by a DIRECTORY: rename over it fails on
    // Windows and POSIX alike, forcing the step-4 failure path.
    fs.mkdirSync(fx.credPath, { recursive: true });
    const jsonBefore = fs.readFileSync(fx.claudeJsonPath, 'utf-8');
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-RB', Date.now() + 6 * HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    let threw = null;
    try { await fx.manager.applyCredential(UUID_B); } catch (err) { threw = err; }
    assert(threw && threw.code === 'CRED_APPLY_FAILED' && threw.status === 500, 'CRED_APPLY_FAILED thrown, got ' + (threw && threw.code));
    assert(threw.message.indexOf('restored') !== -1, 'message says the identity was restored');
    assertEqual(fs.readFileSync(fx.claudeJsonPath, 'utf-8'), jsonBefore, 'identity byte-restored from backup');
  });

  await test('apply error taxonomy: VALIDATION, CRED_NOT_FOUND, CRED_INCOMPLETE', async () => {
    const fx = makeFixture();
    let e1 = null;
    try { await fx.manager.applyCredential('..\\evil'); } catch (err) { e1 = err; }
    assert(e1 && e1.code === 'VALIDATION' && e1.status === 400);
    let e2 = null;
    try { await fx.manager.applyCredential(UUID_C); } catch (err) { e2 = err; }
    assert(e2 && e2.code === 'CRED_NOT_FOUND' && e2.status === 404);
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-HALF', Date.now() + HOUR_MS),
      identity: null,
      tokenState: TOKEN_STATE_OK,
    });
    let e3 = null;
    try { await fx.manager.applyCredential(UUID_B); } catch (err) { e3 = err; }
    assert(e3 && e3.code === 'CRED_INCOMPLETE' && e3.status === 422);
  });

  // ─── Seed, backups, safe list ─────────────────────────────────────────

  await test('seedFromClaudeSwap imports as UNVERIFIED and ignores old tokenDead flags', async () => {
    const fx = makeFixture();
    const seedRoot = path.join(process.env.CWM_DATA_DIR, 'seed-fix-' + fixtureSeq);
    const pcDir = path.join(seedRoot, 'profiles', 'pc');
    fs.mkdirSync(pcDir, { recursive: true });
    const mkProfile = (uuid, email, label, tokenDead) => JSON.stringify({
      email,
      label,
      capturedAt: '2026-06-23T00:00:00Z',
      credentialsFileText: serializeCredentialsFile(makeOauth('SEED-' + label, Date.now() - 24 * HOUR_MS)),
      oauthAccountJson: JSON.stringify(makeIdentity(uuid, email)),
      usageCache: null,
      tokenDead,
    });
    fs.writeFileSync(path.join(pcDir, 'dead@example.com.json'), mkProfile(UUID_B, EMAIL_B, 'DeadOne', true), 'utf-8');
    fs.writeFileSync(path.join(pcDir, 'live@example.com.json'), mkProfile(UUID_C, 'live@example.com', 'LiveOne', false), 'utf-8');
    fs.writeFileSync(path.join(pcDir, 'garbage.json'), '{{{not json', 'utf-8');
    const result = await fx.manager.seedFromClaudeSwap(seedRoot);
    assertEqual(result.imported, 2, 'both parseable profiles imported');
    assertEqual(result.skipped, 1, 'garbage skipped');
    const dead = fx.manager.readSnapshot(UUID_B);
    const live = fx.manager.readSnapshot(UUID_C);
    assertEqual(dead.tokenState, TOKEN_STATE_UNVERIFIED, 'old tokenDead:true IGNORED (buggy source)');
    assertEqual(live.tokenState, TOKEN_STATE_UNVERIFIED, 'imports arrive unverified');
    assertEqual(dead.label, 'DeadOne', 'label carried');
    assertEqual(dead.email, EMAIL_B);
    // Second call: no-op because the one-time sentinel is now present.
    const again = await fx.manager.seedFromClaudeSwap(seedRoot);
    assertEqual(again.imported, 0, 'seed never runs twice');
  });

  await test('REGRESSION: seed imports even when the active account self-captured first (boot ordering); sentinel makes it one-time and delete-proof', async () => {
    const fx = makeFixture(); // live files for account A are on disk
    // Reproduce the real boot ordering: startCredentialWatcher's initial
    // sync self-captures the ACTIVE account into the store BEFORE any HTTP
    // request can trigger the seed. The old snapshot-count guard saw a
    // non-empty store here and skipped the import forever, so the dropdown
    // only ever showed the active account.
    await fx.manager.syncActiveTokenToProfile();
    assertEqual(fx.manager.listSnapshots().length, 1, 'active account self-captured at boot');
    const seedRoot = path.join(process.env.CWM_DATA_DIR, 'seed-boot-' + fixtureSeq);
    const pcDir = path.join(seedRoot, 'profiles', 'pc');
    fs.mkdirSync(pcDir, { recursive: true });
    const mkProfile = (uuid, email, label) => JSON.stringify({
      email,
      label,
      capturedAt: '2026-06-23T00:00:00Z',
      credentialsFileText: serializeCredentialsFile(makeOauth('BOOT-' + label, Date.now() + HOUR_MS)),
      oauthAccountJson: JSON.stringify(makeIdentity(uuid, email)),
      usageCache: null,
      tokenDead: true, // must still be ignored on this path
    });
    fs.writeFileSync(path.join(pcDir, 'b@example.com.json'), mkProfile(UUID_B, EMAIL_B, 'SeedB'), 'utf-8');
    fs.writeFileSync(path.join(pcDir, 'c@example.com.json'), mkProfile(UUID_C, 'c@example.com', 'SeedC'), 'utf-8');
    const result = await fx.manager.seedFromClaudeSwap(seedRoot);
    assertEqual(result.imported, 2, 'BOTH pc profiles imported despite the pre-existing active snapshot');
    assertEqual(fx.manager.listSnapshots().length, 3, 'roster = active account plus both seeded accounts');
    assertEqual(fx.manager.readSnapshot(UUID_A).tokenState, TOKEN_STATE_OK, 'self-captured active snapshot untouched');
    assertEqual(fx.manager.readSnapshot(UUID_B).tokenState, TOKEN_STATE_UNVERIFIED, 'seeded B lands unverified');
    assertEqual(fx.manager.readSnapshot(UUID_C).tokenState, TOKEN_STATE_UNVERIFIED, 'seeded C lands unverified');
    assert(fs.existsSync(path.join(fx.accountsDir, '.seeded')), 'sentinel written after the first import');
    // Sentinel gating: a second call is a no-op regardless of store content.
    const again = await fx.manager.seedFromClaudeSwap(seedRoot);
    assertEqual(again.imported, 0, 'sentinel present: seed does not re-import');
    // Deleting an imported account must NEVER resurrect it via the seed
    // (the old count-based guard re-imported the moment the store emptied).
    await fx.manager.deleteSnapshot(UUID_B);
    const afterDelete = await fx.manager.seedFromClaudeSwap(seedRoot);
    assertEqual(afterDelete.imported, 0, 'deleted account is NOT re-imported');
    assertEqual(fx.manager.readSnapshot(UUID_B), null, 'B stays deleted');
    assertEqual(fx.manager.listSnapshots().length, 2, 'roster after delete: active plus remaining seed');
  });

  await test('backup prune keeps backupKeep per basename, never the just-created file', async () => {
    const fx = makeFixture({ settings: { backupKeep: 3 } });
    let lastBackup = null;
    for (let i = 1; i <= 5; i += 1) {
      fs.writeFileSync(fx.credPath, serializeCredentialsFile(makeOauth('BK' + i, Date.now() + i * HOUR_MS)), 'utf-8');
      lastBackup = fx.manager.backupLiveFile(fx.credPath);
      await sleep(30); // distinct mtimes for deterministic prune ordering
    }
    assert(lastBackup && fs.existsSync(lastBackup), 'just-created backup survives the prune');
    const backups = fs.readdirSync(fx.manager.backupsDir).filter((f) => f.startsWith('.credentials.json.'));
    assert(backups.length <= 3, 'kept at most backupKeep (3), got ' + backups.length);
    const newest = JSON.parse(fs.readFileSync(lastBackup, 'utf-8')).claudeAiOauth;
    assertEqual(newest.accessToken, 'at-FIXTURE-BK5', 'newest content preserved');
  });

  await test('getSafeList never leaks token material and maps health correctly', async () => {
    const fx = makeFixture();
    await fx.manager.captureCurrent({ label: 'Active One' });
    // Expired but ok: must render HEALTHY (expiry is normal and self-healing).
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('SAFE-EXP', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    fx.manager.saveSnapshot({
      accountUuid: UUID_C,
      email: 'c@example.com',
      credentials: makeOauth('SAFE-DEAD', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_C, 'c@example.com'),
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
    });
    const list = fx.manager.getSafeList();
    const raw = JSON.stringify(list);
    assert(raw.indexOf('at-FIXTURE') === -1, 'no access token values leak');
    assert(raw.indexOf('rt-FIXTURE') === -1, 'no refresh token values leak');
    assert(raw.indexOf('accessToken') === -1, 'no accessToken key leaks');
    assert(raw.indexOf('refreshToken') === -1, 'no refreshToken key leaks');
    assertEqual(list.activeProfileId, UUID_A);
    const rowA = list.profiles.find((p) => p.profileId === UUID_A);
    const rowB = list.profiles.find((p) => p.profileId === UUID_B);
    const rowC = list.profiles.find((p) => p.profileId === UUID_C);
    assert(rowA.isActive, 'active row flagged');
    assertEqual(rowA.displayName, 'Active One');
    assertEqual(rowB.health, 'healthy', 'expired-but-refreshable renders healthy, NEVER amber');
    assertEqual(rowB.tokenDead, false, 'derived tokenDead false for ok');
    assertEqual(rowC.health, 'needs-re-login');
    assertEqual(rowC.tokenDead, true, 'derived tokenDead true only for needs_login');
    assertEqual(rowC.tokenState, TOKEN_STATE_NEEDS_LOGIN);
    assertEqual(rowB.subscriptionType, 'max');
    assertEqual(rowB.organizationType, 'claude_max');
    // An UNVERIFIED row maps to needs-attention (selectable, dimmed).
    fx.manager.saveSnapshot({ accountUuid: UUID_C, tokenState: TOKEN_STATE_UNVERIFIED });
    const list2 = fx.manager.getSafeList();
    assertEqual(list2.profiles.find((p) => p.profileId === UUID_C).health, 'needs-attention');
  });

  // ─── Mac bridge support: syncBackFromMac + mac-state cache ────────────────

  await test('syncBackFromMac adopts ONLY strictly-newer credentials and resurrects tokenState', async () => {
    const fx = makeFixture();
    const storedExp = Date.now() + HOUR_MS;
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('MACBASE', storedExp),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_NEEDS_LOGIN, // presumed dead; the Mac proves otherwise
    });
    // Strictly newer: adopted, metadata merged, state resurrected.
    const newer = JSON.stringify({ claudeAiOauth: { accessToken: 'at-FIXTURE-MACNEW', refreshToken: 'rt-FIXTURE-MACNEW', expiresAt: storedExp + HOUR_MS } });
    const r1 = await fx.manager.syncBackFromMac(UUID_B, newer);
    assertEqual(r1.synced, true, 'strictly newer expiresAt adopted');
    assertEqual(r1.resurrected, true, 'live Mac login resurrects needs_login');
    const snap1 = fx.manager.readSnapshot(UUID_B);
    assertEqual(snap1.credentials.accessToken, 'at-FIXTURE-MACNEW');
    assertEqual(snap1.tokenState, TOKEN_STATE_OK);
    assertEqual(snap1.credentials.subscriptionType, 'max', 'lean Mac copy cannot drop stored metadata (merge, not replace)');
    // Equal expiresAt: NOT adopted (strictly newer only).
    const equal = JSON.stringify({ claudeAiOauth: { accessToken: 'at-FIXTURE-MACEQ', refreshToken: 'rt-x', expiresAt: storedExp + HOUR_MS } });
    const r2 = await fx.manager.syncBackFromMac(UUID_B, equal);
    assertEqual(r2.synced, false, 'equal expiresAt never regresses/overwrites');
    assertEqual(fx.manager.readSnapshot(UUID_B).credentials.accessToken, 'at-FIXTURE-MACNEW');
    // Older: NOT adopted.
    const older = JSON.stringify({ claudeAiOauth: { accessToken: 'at-FIXTURE-MACOLD', refreshToken: 'rt-y', expiresAt: storedExp - HOUR_MS } });
    const r3 = await fx.manager.syncBackFromMac(UUID_B, older);
    assertEqual(r3.synced, false, 'stale Mac copy never regresses a fresher snapshot');
    // Unparseable text: structured no-op, never a throw.
    const r4 = await fx.manager.syncBackFromMac(UUID_B, 'not json');
    assertEqual(r4.synced, false);
    assert(r4.reason, 'reason reported for unparseable text');
    // Unknown account: never fabricates a snapshot from Mac-side data.
    const r5 = await fx.manager.syncBackFromMac(UUID_C, newer);
    assertEqual(r5.synced, false);
    assertEqual(fx.manager.readSnapshot(UUID_C), null, 'no snapshot fabricated');
  });

  await test('setMacState whitelists fields (defense in depth) and getMacState serves the cache', async () => {
    const fx = makeFixture();
    assertEqual(fx.manager.getMacState(), null, 'null until the first sweep');
    // Hostile input: secret-bearing fields must be dropped by the whitelist
    // even if a future caller passed a raw inventory object by mistake.
    const stored = fx.manager.setMacState({
      checkedAt: '2026-07-03T10:00:00.000Z',
      reachable: true,
      activeName: 'work-laptop',
      activeProfileId: UUID_B,
      profiles: [
        { name: 'work-laptop', profileId: UUID_B, liveCredText: 'SECRET' },
        { name: 'stray', profileId: 'not-a-uuid!' },
        'garbage-entry',
      ],
      liveCredText: 'at-FIXTURE-SECRET',
      credentials: { accessToken: 'at-FIXTURE-SECRET' },
    });
    const raw = JSON.stringify(stored);
    assert(raw.indexOf('SECRET') === -1, 'no secret value survives the whitelist');
    assert(raw.indexOf('liveCredText') === -1, 'liveCredText key stripped');
    assert(raw.indexOf('accessToken') === -1, 'accessToken key stripped');
    assertEqual(stored.activeProfileId, UUID_B);
    assertEqual(stored.profiles.length, 2, 'non-object entries dropped');
    assertEqual(stored.profiles[0].profileId, UUID_B);
    assertEqual(stored.profiles[1].profileId, null, 'invalid uuid normalized to null');
    assertEqual(fx.manager.getMacState(), stored, 'cache served as stored');
    // Invalid activeProfileId normalized to null; clear works.
    const bad = fx.manager.setMacState({ reachable: false, activeProfileId: '../etc/passwd' });
    assertEqual(bad.activeProfileId, null);
    assert(bad.checkedAt, 'missing checkedAt stamped');
    fx.manager.setMacState(null);
    assertEqual(fx.manager.getMacState(), null, 'cache cleared');
  });

  await test('Mac-active lineage hint: set/get, settingsPatcher persistence, restart survival, junk rejection', async () => {
    // Mutable settings object doubling as the "store": the patcher writes
    // into it, exactly like the server's store.updateSettings wiring.
    const settings = {};
    const patches = [];
    const fx = makeFixture({
      settings,
      managerOpts: {
        settingsPatcher: (patch) => { patches.push(patch); Object.assign(settings, patch); },
      },
    });
    assertEqual(fx.manager.getMacActiveHint(), null, 'no hint by default');
    assertEqual(fx.manager.setMacActiveHint(UUID_B), UUID_B);
    assertEqual(fx.manager.getMacActiveHint(), UUID_B);
    assertEqual(patches.length, 1, 'hint persisted through the patcher');
    assertEqual(patches[0].macActiveProfileId, UUID_B);
    // "Restart": a NEW manager over the same settings reads the persisted hint.
    const fx2 = makeFixture({ settings });
    assertEqual(fx2.manager.getMacActiveHint(), UUID_B, 'hint survives a manager restart via settings');
    // Junk normalizes to null (never a path-unsafe value near uuids).
    assertEqual(fx.manager.setMacActiveHint('../etc/passwd'), null);
    assertEqual(fx.manager.getMacActiveHint(), null);
    assertEqual(patches[patches.length - 1].macActiveProfileId, null);
    // A manager WITHOUT a patcher still works session-only.
    const fx3 = makeFixture();
    fx3.manager.setMacActiveHint(UUID_C);
    assertEqual(fx3.manager.getMacActiveHint(), UUID_C, 'memory-only hint without a patcher');
  });

  await test('LINEAGE GATE PROOF: a Mac-active EXPIRED account triggers ZERO token-endpoint calls', async () => {
    resetStub();
    const fx = makeFixture(); // live PC account is A; B is inactive here
    // Expired inactive snapshot: WITHOUT the hint this is exactly the shape
    // that triggers refreshInactiveToken (proven by the contrast below).
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('MACEXP', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    fx.manager.setMacActiveHint(UUID_B);
    // Phase 1: no refresher registered (Mac offline scenario). The gate
    // must skip the round entirely: no token call, no usage call, and the
    // account must NOT be marked dead (the Mac owns its lineage).
    const snap1 = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(stub.tokenHits, 0, 'ZERO token-endpoint calls for the Mac-active account');
    assertEqual(stub.usageHits, 0, 'expired stored token is never used for usage either');
    assertEqual(snap1.tokenState, TOKEN_STATE_OK, 'never marked dead by the gate');
    assertEqual(snap1.credentials.accessToken, 'at-FIXTURE-MACEXP', 'credentials untouched');
    // Phase 2: refresher registered (Mac reachable). The pre-pull adopts
    // the Mac's fresh rotation via syncBackFromMac; usage is then fetched
    // READ-ONLY with the adopted token; the token endpoint stays silent.
    let refresherCalls = 0;
    const freshText = JSON.stringify({ claudeAiOauth: {
      accessToken: 'at-FIXTURE-MACFRESH',
      refreshToken: 'rt-FIXTURE-MACFRESH',
      expiresAt: Date.now() + 6 * HOUR_MS,
    } });
    fx.manager.setMacStateRefresher(async () => {
      refresherCalls += 1;
      await fx.manager.syncBackFromMac(UUID_B, freshText);
    });
    const snap2 = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(refresherCalls, 1, 'expired Mac-active account pulls fresh Mac state first');
    assertEqual(stub.tokenHits, 0, 'STILL zero token-endpoint calls after the Mac pull');
    assertEqual(stub.usageHits, 1, 'usage fetched read-only with the adopted token');
    assertEqual(stub.lastUsageAuth, 'Bearer at-FIXTURE-MACFRESH', 'the ADOPTED Mac token was used');
    assert(snap2.usage, 'usage stored');
    assertEqual(snap2.credentials.refreshToken, 'rt-FIXTURE-MACFRESH', 'Mac rotation adopted, not re-rotated');
    // Fresh token now: the refresher must NOT fire again (no pointless SSH).
    await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(refresherCalls, 1, 'unexpired Mac-active account skips the pre-pull');
    assertEqual(stub.tokenHits, 0, 'still zero');
    // CONTRAST: clear the hint and expire the snapshot again; the exact
    // same shape now DOES refresh, proving the gate (not the fixture) is
    // what prevented the token calls above.
    fx.manager.setMacActiveHint(null);
    fx.manager.saveSnapshot({ accountUuid: UUID_B, credentials: makeOauth('MACEXP2', Date.now() - HOUR_MS) });
    await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(stub.tokenHits, 1, 'without the hint the same expired shape refreshes (contrast)');
  });

  // ─── Expiry-fix spec (2026-07-16): honest states, dead-retry, proactive
  //     sweep, write-back theft guard ─────────────────────────────────────

  await test('expiry-fix constants and defaults: ladder 3, dead-retry 6h, window 30, floor 10, proactive ON by default', () => {
    assertEqual(SUSPECT_ESCALATE_COUNT, 3, 'suspect ladder escalates on the 3rd consecutive');
    assertEqual(DEAD_RETRY_MIN, 6 * 60 * 60 * 1000, 'dead-retry window is 6h in ms');
    assertEqual(PROACTIVE_REFRESH_WINDOW_MIN, 30, 'proactive refresh window is 30 minutes');
    assertEqual(PROACTIVE_REFRESH_FLOOR_MIN, 10, 'proactive interval floor is 10 minutes');
    assertEqual(DEFAULT_CRED_SETTINGS.proactiveRefreshMinutes, 20, 'proactive refresh is ON by default (non-zero)');
    assertEqual(healthFor(TOKEN_STATE_OK), 'healthy');
    assertEqual(healthFor(TOKEN_STATE_OK, { kind: 'auth_suspect' }), 'needs-attention', 'ok + auth_suspect renders amber');
    assertEqual(healthFor(TOKEN_STATE_OK, { kind: 'timeout' }), 'healthy', 'transient evidence never turns a row amber');
    assertEqual(healthFor(TOKEN_STATE_NEEDS_LOGIN, { kind: 'auth' }), 'needs-re-login');
    assertEqual(healthFor(TOKEN_STATE_UNVERIFIED), 'needs-attention');
  });

  await test('no-refresh-token rejection records kind no_refresh_token (never null)', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-NORT2', Date.now() - HOUR_MS, ''),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_OK,
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    assertEqual(snap.tokenState, TOKEN_STATE_NEEDS_LOGIN);
    assert(snap.lastRefreshError, 'evidence must be recorded, not nulled');
    assertEqual(snap.lastRefreshError.kind, 'no_refresh_token');
    assertEqual(stub.tokenHits, 0, 'zero network calls');
  });

  await test('dead-retry: needs_login with STALE evidence retries WITHOUT force and heals', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-STALE', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
      lastRefreshError: {
        at: new Date(Date.now() - DEAD_RETRY_MIN - 60000).toISOString(),
        kind: 'auth', status: 400, detail: 'invalid_grant',
      },
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: false });
    assertEqual(stub.tokenHits, 1, 'stale evidence means the dead row IS retried without force');
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'a WAF false positive self-heals on the retry');
    assertEqual(snap.credentials.accessToken, 'at-ROTATED-1', 'rotated pair adopted');
  });

  await test('dead-retry: FRESH rejection evidence still skips the round trip (no hammering)', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-FRESH', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
      lastRefreshError: {
        at: new Date(Date.now() - HOUR_MS).toISOString(),
        kind: 'auth', status: 400, detail: 'invalid_grant',
      },
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: false });
    assertEqual(stub.tokenHits, 0, 'fresh evidence: no pointless round trip');
    assertEqual(snap.tokenState, TOKEN_STATE_NEEDS_LOGIN, 'row stays dead until the window lapses');
  });

  await test('dead-retry: legacy nulled evidence (the old bug) retries immediately', async () => {
    resetStub();
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B,
      email: EMAIL_B,
      credentials: makeOauth('B-LEGACY', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B),
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
      lastRefreshError: null, // exactly what the old nulling bug left behind
    });
    const snap = await fx.manager.updateSnapshotUsage(UUID_B, { force: false });
    assertEqual(stub.tokenHits, 1, 'no timestamp means the retry window cannot hold the row back');
    assertEqual(snap.tokenState, TOKEN_STATE_OK, 'legacy dead rows self-heal on the first sweep');
  });

  await test('proactiveRefreshSweep refreshes ONLY inactive, non-Mac, ok rows near expiry (persist before use)', async () => {
    resetStub();
    const UUID_D = 'dddddddd-1111-2222-3333-444444444404';
    const UUID_E = 'eeeeeeee-1111-2222-3333-444444444405';
    const UUID_F = 'ffffffff-1111-2222-3333-444444444406';
    const fx = makeFixture(); // live PC account is A
    // A: PC-ACTIVE. Snapshot deliberately near expiry so ONLY the active
    // gate (not the window gate) can be what skips it.
    await fx.manager.captureCurrent({});
    fx.manager.saveSnapshot({ accountUuid: UUID_A, credentials: makeOauth('A-NEAR', Date.now() + 60000) });
    // B: inactive, ok, 10 minutes from expiry: THE one candidate.
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: EMAIL_B,
      credentials: makeOauth('B-NEAR', Date.now() + 10 * 60000),
      identity: makeIdentity(UUID_B, EMAIL_B), tokenState: TOKEN_STATE_OK,
    });
    // C: inactive, ok, 5 hours out: outside the 30-minute window.
    fx.manager.saveSnapshot({
      accountUuid: UUID_C, email: 'c@example.com',
      credentials: makeOauth('C-FAR', Date.now() + 5 * HOUR_MS),
      identity: makeIdentity(UUID_C, 'c@example.com'), tokenState: TOKEN_STATE_OK,
    });
    // D: needs_login: the dead-retry path owns it, never this sweep.
    fx.manager.saveSnapshot({
      accountUuid: UUID_D, email: 'd@example.com',
      credentials: makeOauth('D-DEAD', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_D, 'd@example.com'), tokenState: TOKEN_STATE_NEEDS_LOGIN,
      lastRefreshError: { at: new Date().toISOString(), kind: 'auth', status: 400, detail: 'invalid_grant' },
    });
    // E: Mac-active lineage: the Mac owns the pair; never rotated from here.
    fx.manager.saveSnapshot({
      accountUuid: UUID_E, email: 'e@example.com',
      credentials: makeOauth('E-MAC', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_E, 'e@example.com'), tokenState: TOKEN_STATE_OK,
    });
    fx.manager.setMacActiveHint(UUID_E);
    // F: recent auth_suspect backoff: do not hammer a strange endpoint.
    fx.manager.saveSnapshot({
      accountUuid: UUID_F, email: 'f@example.com',
      credentials: makeOauth('F-SUS', Date.now() + 5 * 60000),
      identity: makeIdentity(UUID_F, 'f@example.com'), tokenState: TOKEN_STATE_OK,
      lastRefreshError: { at: new Date(Date.now() - 60000).toISOString(), kind: 'auth_suspect', count: 1, status: 403, detail: 'HTTP 403 from token endpoint' },
    });
    // Persist-before-use probe: at the moment the usage endpoint is hit,
    // the ROTATED pair must already be on disk.
    let tokenOnDiskAtUsageTime = null;
    stub.onUsageRequest = () => {
      const onDisk = fx.manager.readSnapshot(UUID_B);
      tokenOnDiskAtUsageTime = onDisk && onDisk.credentials ? onDisk.credentials.accessToken : null;
    };
    const result = await fx.manager.proactiveRefreshSweep();
    assertEqual(result.scanned, 6, 'whole roster scanned');
    assertEqual(result.refreshed, 1, 'exactly one candidate refreshed');
    assertEqual(result.skipped, 5, 'active, far, dead, Mac-active, and suspect rows all skipped');
    assertEqual(stub.tokenHits, 1, 'exactly one token-endpoint call');
    assertEqual(tokenOnDiskAtUsageTime, 'at-ROTATED-1', 'rotated pair persisted BEFORE the usage call');
    const b = fx.manager.readSnapshot(UUID_B);
    assertEqual(b.credentials.accessToken, 'at-ROTATED-1', 'B rotated');
    assertEqual(b.credentials.refreshToken, 'rt-ROTATED-1', 'B refresh token rotated');
    assert(b.usage, 'freebie usage cached with the fresh token');
    assertEqual(fx.manager.readSnapshot(UUID_A).credentials.accessToken, 'at-FIXTURE-A-NEAR', 'ACTIVE row untouched');
    assertEqual(fx.manager.readSnapshot(UUID_C).credentials.accessToken, 'at-FIXTURE-C-FAR', 'far-from-expiry row untouched');
    assertEqual(fx.manager.readSnapshot(UUID_D).credentials.accessToken, 'at-FIXTURE-D-DEAD', 'dead row untouched');
    assertEqual(fx.manager.readSnapshot(UUID_E).credentials.accessToken, 'at-FIXTURE-E-MAC', 'Mac-active row untouched');
    assertEqual(fx.manager.readSnapshot(UUID_F).credentials.accessToken, 'at-FIXTURE-F-SUS', 'suspect-backoff row untouched');
  });

  await test('proactiveRefreshSweep classifies failures honestly (invalid_grant kills WITH evidence)', async () => {
    resetStub();
    stub.tokenMode = 'invalid_grant_400';
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: EMAIL_B,
      credentials: makeOauth('B-SWDEAD', Date.now() + 5 * 60000),
      identity: makeIdentity(UUID_B, EMAIL_B), tokenState: TOKEN_STATE_OK,
    });
    const result = await fx.manager.proactiveRefreshSweep();
    assertEqual(result.rejected, 1, 'rejection counted');
    const b = fx.manager.readSnapshot(UUID_B);
    assertEqual(b.tokenState, TOKEN_STATE_NEEDS_LOGIN, 'definitive rejection marks the row');
    assertEqual(b.lastRefreshError.kind, 'auth', 'evidence preserved by the sweep too');
    // A 403 on the sweep only climbs the ladder, exactly like the usage path.
    resetStub();
    stub.tokenMode = '403';
    fx.manager.saveSnapshot({
      accountUuid: UUID_C, email: 'c@example.com',
      credentials: makeOauth('C-SWSUS', Date.now() + 5 * 60000),
      identity: makeIdentity(UUID_C, 'c@example.com'), tokenState: TOKEN_STATE_OK,
    });
    const result2 = await fx.manager.proactiveRefreshSweep();
    assertEqual(result2.suspect, 1, 'suspect counted');
    const c = fx.manager.readSnapshot(UUID_C);
    assertEqual(c.tokenState, TOKEN_STATE_OK, 'one 403 never nukes a row, sweep included');
    assertEqual(c.lastRefreshError.kind, 'auth_suspect');
  });

  await test('write-back guard: live token owned by a DIFFERENT snapshot is never adopted', async () => {
    resetStub();
    // Live pair: account A's identity, but the TOKEN is account B's stored
    // token (a still-running post-switch CLI wrote its rotated old-account
    // pair into the live file). Adoption must be refused entirely.
    const theftOauth = makeOauth('THEFT', Date.now() + 12 * HOUR_MS);
    const fx = makeFixture({ liveOauth: theftOauth, liveIdentity: makeIdentity(UUID_A, EMAIL_A) });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: EMAIL_B,
      credentials: { ...makeOauth('B-OWNER', Date.now() + HOUR_MS), accessToken: theftOauth.accessToken },
      identity: makeIdentity(UUID_B, EMAIL_B), tokenState: TOKEN_STATE_OK,
    });
    // A's snapshot: older expiry (a naive merge WOULD adopt) and a dead
    // state (a naive sync WOULD resurrect). Both must stay untouched.
    fx.manager.saveSnapshot({
      accountUuid: UUID_A, email: EMAIL_A,
      credentials: makeOauth('A-OWN', Date.now() + HOUR_MS),
      identity: makeIdentity(UUID_A, EMAIL_A), tokenState: TOKEN_STATE_NEEDS_LOGIN,
      lastRefreshError: { at: new Date().toISOString(), kind: 'auth', status: 400, detail: 'invalid_grant' },
    });
    const synced = await fx.manager.syncActiveTokenToProfile();
    assertEqual(synced, null, 'guard reports nothing synced');
    const a = fx.manager.readSnapshot(UUID_A);
    assertEqual(a.credentials.accessToken, 'at-FIXTURE-A-OWN', 'A never adopts B\'s token');
    assertEqual(a.tokenState, TOKEN_STATE_NEEDS_LOGIN, 'no resurrection on stolen evidence');
    const b = fx.manager.readSnapshot(UUID_B);
    assertEqual(b.credentials.accessToken, theftOauth.accessToken, 'B (the real owner) intact');
    assertEqual(b.tokenState, TOKEN_STATE_OK, 'B state intact');
  });

  await test('write-back guard: auto-capture of an unknown identity is ALSO refused when the token is owned elsewhere', async () => {
    resetStub();
    const UUID_NEW = 'abcd1234-9999-8888-7777-666666666607';
    const theftOauth = makeOauth('THEFT2', Date.now() + 12 * HOUR_MS);
    const fx = makeFixture({ liveOauth: theftOauth, liveIdentity: makeIdentity(UUID_NEW, 'new@example.com') });
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: EMAIL_B,
      credentials: { ...makeOauth('B-OWNER2', Date.now() + HOUR_MS), accessToken: theftOauth.accessToken },
      identity: makeIdentity(UUID_B, EMAIL_B), tokenState: TOKEN_STATE_OK,
    });
    const synced = await fx.manager.syncActiveTokenToProfile();
    assertEqual(synced, null, 'nothing synced');
    assertEqual(fx.manager.readSnapshot(UUID_NEW), null, 'no snapshot fabricated around a stolen token');
  });

  await test('write-back guard does NOT false-trip on legitimate syncs (own token, unique token)', async () => {
    resetStub();
    const fx = makeFixture(); // live is A with at-FIXTURE-LIVE-A, expiring +12h
    // Another saved account with a DIFFERENT token must not interfere.
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: EMAIL_B,
      credentials: makeOauth('B-BYSTANDER', Date.now() + HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B), tokenState: TOKEN_STATE_OK,
    });
    // A exists with an OLDER pair: the live pair is a legitimate rotation.
    fx.manager.saveSnapshot({
      accountUuid: UUID_A, email: EMAIL_A,
      credentials: makeOauth('A-OLD', Date.now() + HOUR_MS),
      identity: makeIdentity(UUID_A, EMAIL_A), tokenState: TOKEN_STATE_NEEDS_LOGIN,
    });
    const synced = await fx.manager.syncActiveTokenToProfile();
    assertEqual(synced, UUID_A, 'legitimate sync goes through');
    const a = fx.manager.readSnapshot(UUID_A);
    assertEqual(a.credentials.accessToken, 'at-FIXTURE-LIVE-A', 'fresh live rotation adopted');
    assertEqual(a.tokenState, TOKEN_STATE_OK, 'live login resurrects as before');
    // Second sync: live token now equals A's OWN stored token; still fine.
    const again = await fx.manager.syncActiveTokenToProfile();
    assertEqual(again, UUID_A, 'same-account token match never trips the guard');
  });

  await test('getSafeList forwards suspect evidence fields but NEVER the detail or token material', async () => {
    resetStub();
    stub.tokenMode = '403';
    const fx = makeFixture();
    fx.manager.saveSnapshot({
      accountUuid: UUID_B, email: EMAIL_B,
      credentials: makeOauth('B-SAFE', Date.now() - HOUR_MS),
      identity: makeIdentity(UUID_B, EMAIL_B), tokenState: TOKEN_STATE_OK,
    });
    await fx.manager.updateSnapshotUsage(UUID_B, { force: true });
    const list = fx.manager.getSafeList();
    const raw = JSON.stringify(list);
    assert(raw.indexOf('at-FIXTURE') === -1, 'no access token values leak');
    assert(raw.indexOf('rt-FIXTURE') === -1, 'no refresh token values leak');
    assert(raw.indexOf('accessToken') === -1, 'no accessToken key leaks');
    assert(raw.indexOf('refreshToken') === -1, 'no refreshToken key leaks');
    const row = list.profiles.find((p) => p.profileId === UUID_B);
    assertEqual(row.health, 'needs-attention', 'suspect row surfaces amber to the UI');
    assertEqual(row.lastRefreshError.kind, 'auth_suspect', 'kind forwarded for the frontend copy');
    assertEqual(row.lastRefreshError.status, 403, 'status forwarded');
    assertEqual(row.lastRefreshError.detail, undefined, 'detail stays server-side (defense in depth)');
  });

  stubServer.close();
  console.log('  ' + '─'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL: ' + ((err && err.stack) || err));
  process.exit(1);
});
