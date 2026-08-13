#!/usr/bin/env node
/**
 * Task #33: the credential-protection regression gate.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The credential switcher's hardening arrived through several tracks: a
 * production deadlock fix, an expiry-fix spec that replaced dishonest death
 * verdicts with a suspect ladder, a write-back theft guard, a proactive
 * refresh sweep with a lineage gate, and an external-pool passive mode. Some
 * of that reached this branch through a separately-verified integration
 * branch and some through external pull requests absorbed into main. An
 * audit compared the two lineages file by file and found ZERO drift: the
 * four audited files are byte-identical to the verified branch (identical
 * blob hashes for credential-manager.js, provider-account-manager.js,
 * credential-routes.js and providers/codex/accounts.js).
 *
 * A one-time audit protects nothing. This file turns that audit's findings
 * into standing assertions, so the next absorption of an external change
 * cannot quietly drop one of them. Every protection below is pinned by
 * EXECUTED behavior wherever behavior can be executed hermetically, and by a
 * structural gate where the property is structural (for example "every
 * mutating route carries the ownership guard", which is a property of the
 * route table, not of any one request).
 *
 * WHAT IS PINNED
 *   1. Deadlock hardening: one AbortController spanning the request AND the
 *      body read, clearTimeout only in finally, the serialized-op deadline,
 *      the stalled-chain watchdog armed by default, degraded list responses.
 *   2. Proactive refresh: on by default, the window and floor, and the
 *      lineage gate that keeps the PC from stealing the Mac's token lineage.
 *   3. The write-back theft guard in the rotation sync.
 *   4. Honest verdicts: rejected only on invalid_grant, the suspect ladder
 *      escalating at three, and the six-hour dead-retry window.
 *   5. The passive-mode ownership guards, including the completeness check
 *      that no mutating credential route is missing one.
 *
 * HERMETIC: injected fetch, injected clock, tmpdir claudeDir/accountsDir,
 * zero network, zero child processes, and nothing here can see or touch the
 * real ~/.claude.
 *
 * Exits 0 green, 1 red.
 */

'use strict';

require('./_test-data-dir');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cm = require('../src/web/credential-manager');
const { createCredentialManager } = cm;

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Run one named check, recording pass/fail rather than throwing.
 * @param {string} name - Assertion name.
 * @param {Function} fn - Body; may be async.
 * @returns {Promise<void>}
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL  ' + name);
    console.log('        ' + ((err && err.message) || err));
  }
}

const UUID_A = 'aaaaaaaa-1111-2222-3333-444444440001';
const UUID_B = 'bbbbbbbb-1111-2222-3333-444444440002';
const HOUR_MS = 3600 * 1000;

/** Throwaway directories created by fixtures, removed at exit. */
const _tmpDirs = [];

/**
 * Read one src/web source file with line endings normalised to LF, because
 * this tree checks out CRLF on Windows and a structural scan keyed on "\n"
 * would otherwise silently inspect the wrong span.
 *
 * @param {string} name - File name under src/web.
 * @returns {string} Contents with LF line endings.
 */
function readSource(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'web', name), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Extract the source text of one named function from a module's source.
 * Anchored on the declaration and terminated by the first closing brace at
 * the function's own indentation, which is how every function in these two
 * modules is formatted.
 *
 * @param {string} src - Module source, LF-normalised.
 * @param {string} declaration - Exact declaration line prefix.
 * @returns {string} The function body text.
 */
function functionSource(src, declaration) {
  const start = src.indexOf(declaration);
  assert.ok(start !== -1, 'could not find: ' + declaration);
  // The indent comes from the DECLARATION string, not from the offset. These
  // functions are nested inside a factory, so their closing brace sits at
  // their own indentation; deriving it from the offset would yield the empty
  // string and scan to the module-level close, silently inspecting the whole
  // rest of the file instead of one function.
  const indent = (/^[ \t]*/.exec(declaration) || [''])[0];
  const end = src.indexOf('\n' + indent + '}\n', start);
  assert.ok(end !== -1, 'could not find the end of: ' + declaration);
  return src.slice(start, end);
}

/**
 * Build a hermetic manager over a throwaway tree, with an injected fetch and
 * a controllable clock.
 *
 * @param {object} [opts] - {fetchImpl, settings, now, externalBridgeOwner}
 * @returns {{manager: object, dir: string, setNow: Function, claudeDir: string, claudeJsonPath: string}}
 */
function makeManager(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-credgate-'));
  _tmpDirs.push(dir);
  const claudeDir = path.join(dir, 'claude');
  const claudeJsonPath = path.join(dir, 'claude.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  let now = opts.now || Date.now();
  const manager = createCredentialManager({
    claudeDir,
    claudeJsonPath,
    accountsDir: path.join(dir, 'accounts'),
    settingsProvider: () => opts.settings || {},
    fetchImpl: opts.fetchImpl,
    clock: () => now,
    tokenUrl: 'https://token.invalid/oauth/token',
    usageUrl: 'https://usage.invalid/usage',
    refreshTimeoutMs: opts.refreshTimeoutMs || 200,
    ...(opts.opTimeoutMs ? { opTimeoutMs: opts.opTimeoutMs } : {}),
    log: { info() {}, warn() {}, error() {}, log() {} },
    ...(opts.externalBridgeOwner !== undefined ? { externalBridgeOwner: opts.externalBridgeOwner } : {}),
  });
  return {
    manager, dir, claudeDir, claudeJsonPath,
    setNow: (t) => { now = t; },
    getNow: () => now,
  };
}

/**
 * A snapshot fixture with controllable expiry and state.
 * @param {string} uuid
 * @param {object} [over]
 * @returns {object} Snapshot suitable for saveSnapshot.
 */
function snapshot(uuid, over = {}) {
  return {
    accountUuid: uuid,
    email: uuid.slice(0, 8) + '@example.com',
    label: '',
    credentials: {
      accessToken: 'at-' + uuid.slice(0, 8),
      refreshToken: 'rt-' + uuid.slice(0, 8),
      expiresAt: Date.now() + 8 * HOUR_MS,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
    identity: { accountUuid: uuid, emailAddress: uuid.slice(0, 8) + '@example.com' },
    usage: null,
    tokenState: 'ok',
    lastRefreshError: null,
    ...over,
  };
}

/**
 * Build an injected fetch that answers the token endpoint from a script and
 * always fails the usage endpoint (usage is irrelevant to these gates and a
 * usage success would only add noise).
 *
 * @param {Function} tokenAnswer - (bodyObject, callIndex) => {status, json}
 * @returns {{impl: Function, calls: Array}}
 */
function makeFetch(tokenAnswer) {
  const calls = [];
  const impl = async (url, init) => {
    const isToken = String(url).indexOf('token') !== -1;
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }
    calls.push({ url: String(url), body, isToken });
    if (!isToken) return { ok: false, status: 500, json: async () => ({}) };
    const answer = tokenAnswer(body, calls.filter((c) => c.isToken).length - 1) || { status: 500, json: {} };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.jsonThrows) throw new Error('not json');
        return answer.json;
      },
    };
  };
  return { impl, calls };
}

/**
 * Hold the event loop open for the whole run.
 *
 * Load-bearing, and subtle: the stalled-body test below awaits a promise that
 * NEVER settles, and the abort timer that rescues it is deliberately unref'd
 * in refreshInactiveToken. With nothing else referenced, Node considers the
 * loop empty and exits 0 mid-suite, which looks exactly like a pass. This
 * ticker is the only thing standing between that and a silently truncated
 * green run.
 */
let _keepAlive = null;

async function main() {
  console.log('\n  Task #33: the credential-protection regression gate');
  console.log('  ' + '-'.repeat(74));
  _keepAlive = setInterval(() => {}, 50);

  const managerSrc = readSource('credential-manager.js');
  const routesSrc = readSource('credential-routes.js');

  // ══ 1. DEADLOCK HARDENING ═══════════════════════════════════════════════

  await test('P1: one AbortController spans the request AND the body read, cleared only in finally', () => {
    const fn = functionSource(managerSrc, '  async function refreshInactiveToken(');
    const controllers = (fn.match(/new AbortController\(\)/g) || []).length;
    assert.strictEqual(controllers, 1,
      'refreshInactiveToken must build EXACTLY one AbortController, found ' + controllers);
    const clears = (fn.match(/clearTimeout\(/g) || []).length;
    assert.strictEqual(clears, 1, 'exactly one clearTimeout, found ' + clears);
    const bodyReadIdx = fn.indexOf('await res.json()');
    const finallyIdx = fn.lastIndexOf('} finally {');
    const clearIdx = fn.indexOf('clearTimeout(');
    assert.ok(bodyReadIdx !== -1, 'the body read vanished from refreshInactiveToken');
    assert.ok(finallyIdx !== -1, 'the finally block vanished from refreshInactiveToken');
    assert.ok(bodyReadIdx < finallyIdx,
      'the body read must happen BEFORE the finally that clears the deadline; this exact ordering is '
      + 'the 2026-07-24 production deadlock');
    assert.ok(clearIdx > finallyIdx,
      'clearTimeout must live INSIDE the finally, never at header arrival');
    // The same pattern in fetchUsage, which is the file's reference shape.
    const usageFn = functionSource(managerSrc, '  async function fetchUsage(');
    assert.ok(usageFn.indexOf('} finally {') !== -1 && usageFn.lastIndexOf('clearTimeout(') > usageFn.lastIndexOf('} finally {'),
      'fetchUsage lost the finally-only clearTimeout it is the reference for');
  });

  await test('P1: a stalled 401 body classifies transient, never as suspect or dead', async () => {
    // The outage shape: headers arrive, the body does not, and the deadline
    // is what ends it. The fake honours the abort signal on the BODY read,
    // which is what a real runtime does and what the single controller
    // exists to reach; a fake that ignored the signal would be testing the
    // fake, not the fix. The socket-level version of this lives in
    // credential-deadlock.test.js with a real server; this one pins the
    // CLASSIFICATION branch, that an aborted body read is a timeout even
    // when the status line alone would have read as suspect.
    const impl = async (url, init) => ({
      ok: false,
      status: 401,
      json: () => new Promise((_, reject) => {
        const signal = init && init.signal;
        const fail = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (!signal) return;
        if (signal.aborted) return fail();
        signal.addEventListener('abort', fail, { once: true });
      }),
    });
    const h = makeManager({ fetchImpl: impl, refreshTimeoutMs: 120 });
    const r = await h.manager.refreshInactiveToken('rt-stalled');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.verdict, 'transient',
      'a stalled body is a timeout, never evidence the credential is dead; got ' + r.verdict);
    assert.strictEqual(r.kind, 'timeout', 'the timeout kind was lost');
    assert.ok(String(r.detail || '').indexOf('rt-stalled') === -1, 'token material reached the detail string');
    // And the mutex still advances afterwards, which is the actual outage.
    h.manager.saveSnapshot(snapshot(UUID_A));
    assert.ok(h.manager.readSnapshot(UUID_A), 'the serialized chain did not advance after the stall');
    h.manager.stopCredentialWatcher();
  });

  await test('P1: the op deadline, the watchdog factor, and the watchdog armed by default', () => {
    assert.strictEqual(cm.OP_TIMEOUT_MS, 60000, 'the serialized-op deadline moved');
    assert.strictEqual(cm.MAC_OP_TIMEOUT_MS, 120000, 'the Mac-op deadline moved');
    assert.strictEqual(cm.CHAIN_STALL_FACTOR, 3, 'the stalled-chain factor moved');
    const h = makeManager({});
    assert.strictEqual(typeof h.manager._hasChainWatchdog, 'function', 'the watchdog probe vanished');
    assert.strictEqual(h.manager._hasChainWatchdog(), true,
      'the stalled-chain watchdog must be armed at construction, not only by startCredentialWatcher');
    h.manager.stopCredentialWatcher();
  });

  await test('P1: a wedged operation rejects with a typed retryable CRED_OP_TIMEOUT', async () => {
    // opTimeoutMs is injectable precisely so this can be hermetic; a real
    // 60-second deadline is not something a test suite can wait out.
    const h = makeManager({ opTimeoutMs: 40 });
    let threw = null;
    try {
      await h.manager._serialize(() => new Promise(() => {}), 'wedged-on-purpose');
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'a wedged op must reject rather than hang forever');
    assert.strictEqual(threw.code, 'CRED_OP_TIMEOUT', 'wrong error code: ' + threw.code);
    assert.strictEqual(threw.status, 503, 'CRED_OP_TIMEOUT must be a retryable 503, got ' + threw.status);
    h.manager.stopCredentialWatcher();
  });

  await test('P1: the roster list degrades rather than hanging behind a wedged chain', () => {
    assert.strictEqual(typeof cm.settleWithin, 'function', 'settleWithin vanished from the manager exports');
    assert.ok(routesSrc.indexOf('const completed = await settleWithin(bestEffort, bestEffortMs);') !== -1,
      'GET /api/credentials no longer races its side effects against a deadline');
    assert.ok(routesSrc.indexOf("return sendList(res, { degraded: !completed });") !== -1,
      'the degraded flag no longer reaches the client');
    assert.ok(routesSrc.indexOf('if (listOpts.degraded) payload.degraded = true;') !== -1,
      'sendList stopped emitting the degraded marker');
  });

  // ══ 2. PROACTIVE REFRESH ════════════════════════════════════════════════

  await test('P2: on by default, with the documented window and floor', () => {
    const h = makeManager({});
    const s = h.manager.getSettings();
    assert.strictEqual(s.proactiveRefreshMinutes, 20,
      'the proactive sweep must ship ON: refresh tokens are one-time-use and the first holder to rotate wins');
    assert.strictEqual(cm.PROACTIVE_REFRESH_WINDOW_MIN, 30, 'the just-in-time window moved');
    assert.strictEqual(cm.PROACTIVE_REFRESH_FLOOR_MIN, 10, 'the cadence floor moved');
    h.manager.stopCredentialWatcher();
  });

  await test('P2: the sweep rotates a token about to lapse and leaves a distant one alone', async () => {
    const now = Date.now();
    const fetchFake = makeFetch(() => ({
      status: 200,
      json: { access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 28800 },
    }));
    const h = makeManager({ fetchImpl: fetchFake.impl, now });
    // A: lapses in 5 minutes, inside the 30-minute window.
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: now + 5 * 60000 } }));
    // B: lapses in 45 minutes, outside it.
    h.manager.saveSnapshot(snapshot(UUID_B, { credentials: { accessToken: 'at-b', refreshToken: 'rt-b', expiresAt: now + 45 * 60000 } }));
    const out = await h.manager.proactiveRefreshSweep();
    assert.strictEqual(out.refreshed, 1, 'expected exactly one rotation, got ' + out.refreshed);
    assert.strictEqual(out.skipped, 1, 'expected exactly one skip, got ' + out.skipped);
    const sent = fetchFake.calls.filter((c) => c.isToken).map((c) => c.body.refresh_token);
    assert.deepStrictEqual(sent, ['rt-a'], 'the wrong account was rotated: ' + JSON.stringify(sent));
    assert.strictEqual(h.manager.readSnapshot(UUID_A).credentials.refreshToken, 'rt-fresh',
      'the rotated pair was not persisted');
    h.manager.stopCredentialWatcher();
  });

  await test('P2: the lineage gate keeps the sweep off the Mac-active account', async () => {
    const now = Date.now();
    const fetchFake = makeFetch(() => ({
      status: 200,
      json: { access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 28800 },
    }));
    const h = makeManager({ fetchImpl: fetchFake.impl, now });
    // BOTH lapse inside the window, so the ONLY thing that can separate them
    // is the lineage gate.
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: now + 5 * 60000 } }));
    h.manager.saveSnapshot(snapshot(UUID_B, { credentials: { accessToken: 'at-b', refreshToken: 'rt-b', expiresAt: now + 5 * 60000 } }));
    h.manager.setMacActiveHint(UUID_A);
    const out = await h.manager.proactiveRefreshSweep();
    const sent = fetchFake.calls.filter((c) => c.isToken).map((c) => c.body.refresh_token);
    assert.deepStrictEqual(sent, ['rt-b'],
      'the PC rotated the Mac-active account and would have logged the Mac out within ~12h; sent ' + JSON.stringify(sent));
    assert.strictEqual(out.refreshed, 1);
    assert.strictEqual(h.manager.readSnapshot(UUID_A).credentials.refreshToken, 'rt-a',
      'the Mac-active account was mutated');
    h.manager.stopCredentialWatcher();
  });

  await test('P2: usage polling never reaches the token endpoint for the Mac-active account', async () => {
    const now = Date.now();
    const fetchFake = makeFetch(() => ({ status: 200, json: { access_token: 'x', refresh_token: 'y', expires_in: 1 } }));
    const h = makeManager({ fetchImpl: fetchFake.impl, now });
    // Expired access token: without the gate this is exactly the path that
    // calls refreshInactiveToken.
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: now - HOUR_MS } }));
    h.manager.setMacActiveHint(UUID_A);
    await h.manager.updateSnapshotUsage(UUID_A, { force: true });
    assert.strictEqual(fetchFake.calls.filter((c) => c.isToken).length, 0,
      'the usage path refreshed the Mac-active account, stealing its token lineage');
    assert.strictEqual(h.manager.readSnapshot(UUID_A).tokenState, 'ok',
      'the Mac-active account must never be marked dead by the read-only policy');
    h.manager.stopCredentialWatcher();
  });

  // ══ 3. THE WRITE-BACK THEFT GUARD ═══════════════════════════════════════

  await test('P3: a live token belonging to another snapshot is never grafted onto the active one', async () => {
    const h = makeManager({});
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: Date.now() + HOUR_MS } }));
    h.manager.saveSnapshot(snapshot(UUID_B, { credentials: { accessToken: 'at-B', refreshToken: 'rt-B', expiresAt: Date.now() + HOUR_MS } }));
    // The identity file names A, but the live token file holds B's token:
    // a still-running CLI session from the PREVIOUS account rotated into it.
    fs.writeFileSync(path.join(h.claudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-B', refreshToken: 'rt-B-rotated', expiresAt: Date.now() + 99 * HOUR_MS },
    }));
    fs.writeFileSync(h.claudeJsonPath, JSON.stringify({ oauthAccount: { accountUuid: UUID_A, emailAddress: 'a@example.com' } }));

    const beforeA = JSON.stringify(h.manager.readSnapshot(UUID_A));
    const beforeB = JSON.stringify(h.manager.readSnapshot(UUID_B));
    const synced = await h.manager.syncActiveTokenToProfile();
    assert.strictEqual(synced, null, 'the theft guard let the adoption through');
    assert.strictEqual(JSON.stringify(h.manager.readSnapshot(UUID_A)), beforeA, 'snapshot A was mutated');
    assert.strictEqual(JSON.stringify(h.manager.readSnapshot(UUID_B)), beforeB, 'snapshot B was mutated');
    h.manager.stopCredentialWatcher();
  });

  await test('P3: the ordinary case still adopts, so the guard is not just refusing everything', async () => {
    const h = makeManager({});
    const base = Date.now();
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: base + HOUR_MS } }));
    fs.writeFileSync(path.join(h.claudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-A2', refreshToken: 'rt-A2', expiresAt: base + 9 * HOUR_MS },
    }));
    fs.writeFileSync(h.claudeJsonPath, JSON.stringify({ oauthAccount: { accountUuid: UUID_A, emailAddress: 'a@example.com' } }));
    const synced = await h.manager.syncActiveTokenToProfile();
    assert.strictEqual(synced, UUID_A, 'a legitimate rotation was refused');
    assert.strictEqual(h.manager.readSnapshot(UUID_A).credentials.accessToken, 'at-A2',
      'the strictly-newer rotation was not written back');
    h.manager.stopCredentialWatcher();
  });

  await test('P3: the guard reports uuid prefixes and never token material', () => {
    const fn = functionSource(managerSrc, '  function _syncActiveTokenToProfileUnlocked(');
    assert.ok(fn.indexOf('write-back guard') !== -1, 'the guard vanished from the rotation sync');
    assert.ok(fn.indexOf('s.credentials.accessToken === liveToken') !== -1,
      'the guard no longer compares the live token against the other snapshots');
    const warnIdx = fn.indexOf('log.warn');
    const warnLine = fn.slice(warnIdx, fn.indexOf(';', warnIdx));
    assert.ok(warnLine.indexOf('slice(0, 8)') !== -1, 'the diagnostic stopped truncating uuids');
    assert.ok(warnLine.indexOf('liveToken') === -1 && warnLine.indexOf('accessToken') === -1,
      'token material reached a log line');
  });

  // ══ 4. HONEST VERDICTS ══════════════════════════════════════════════════

  await test('P4: only invalid_grant is a death verdict', async () => {
    const cases = [
      { label: '400 invalid_grant', status: 400, json: { error: 'invalid_grant' }, verdict: 'rejected' },
      { label: '401 invalid_grant', status: 401, json: { error: 'invalid_grant' }, verdict: 'rejected' },
      { label: '400 other error', status: 400, json: { error: 'invalid_request' }, verdict: 'protocol' },
      { label: '401 unparseable body', status: 401, jsonThrows: true, verdict: 'suspect' },
      { label: '403 WAF', status: 403, json: { error: 'forbidden' }, verdict: 'suspect' },
      { label: '429 rate limit', status: 429, json: {}, verdict: 'transient' },
      { label: '500 server error', status: 500, json: {}, verdict: 'transient' },
      { label: '503 server error', status: 503, json: {}, verdict: 'transient' },
    ];
    for (const c of cases) {
      const fetchFake = makeFetch(() => c);
      const h = makeManager({ fetchImpl: fetchFake.impl });
      const r = await h.manager.refreshInactiveToken('rt-x');
      assert.strictEqual(r.verdict, c.verdict, c.label + ': expected ' + c.verdict + ', got ' + r.verdict);
      h.manager.stopCredentialWatcher();
    }
    // A network error, which is not a status at all.
    const h2 = makeManager({ fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    const rNet = await h2.manager.refreshInactiveToken('rt-x');
    assert.strictEqual(rNet.verdict, 'transient', 'a network error must never be a death verdict');
    h2.manager.stopCredentialWatcher();
    // No stored refresh token at all IS definitive.
    const h3 = makeManager({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    const rNone = await h3.manager.refreshInactiveToken('');
    assert.strictEqual(rNone.verdict, 'rejected');
    assert.strictEqual(rNone.kind, 'no_refresh_token');
    h3.manager.stopCredentialWatcher();
  });

  await test('P4: the suspect ladder escalates at three consecutive suspects and not before', async () => {
    assert.strictEqual(cm.SUSPECT_ESCALATE_COUNT, 3, 'the escalation threshold moved');
    const now = Date.now();
    const fetchFake = makeFetch(() => ({ status: 403, json: { error: 'forbidden' } }));
    const h = makeManager({ fetchImpl: fetchFake.impl, now });
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: now - HOUR_MS } }));

    await h.manager.updateSnapshotUsage(UUID_A, { force: true });
    let snap = h.manager.readSnapshot(UUID_A);
    assert.strictEqual(snap.tokenState, 'ok', 'one 403 must not kill the row');
    assert.strictEqual(snap.lastRefreshError.kind, 'auth_suspect', 'the suspect evidence was not recorded');

    await h.manager.updateSnapshotUsage(UUID_A, { force: true });
    snap = h.manager.readSnapshot(UUID_A);
    assert.strictEqual(snap.tokenState, 'ok', 'two 403s must not kill the row either');

    await h.manager.updateSnapshotUsage(UUID_A, { force: true });
    snap = h.manager.readSnapshot(UUID_A);
    assert.strictEqual(snap.tokenState, 'needs_login', 'the third consecutive suspect must escalate');
    assert.ok(snap.lastRefreshError, 'the evidence must be PRESERVED on escalation, never nulled');
    h.manager.stopCredentialWatcher();
  });

  await test('P4: a definitive rejection preserves its evidence rather than nulling it', async () => {
    const now = Date.now();
    const fetchFake = makeFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }));
    const h = makeManager({ fetchImpl: fetchFake.impl, now });
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: now - HOUR_MS } }));
    await h.manager.updateSnapshotUsage(UUID_A, { force: true });
    const snap = h.manager.readSnapshot(UUID_A);
    assert.strictEqual(snap.tokenState, 'needs_login');
    assert.ok(snap.lastRefreshError, 'lastRefreshError was nulled, which is the diagnosability bug this replaced');
    assert.ok(snap.lastRefreshError.at, 'the rejection carries no timestamp, so the dead-retry window cannot work');
    h.manager.stopCredentialWatcher();
  });

  await test('P4: a dead row retries after six hours and not before', async () => {
    assert.strictEqual(cm.DEAD_RETRY_MIN, 6 * 60 * 60 * 1000, 'the dead-retry window moved');
    const now = Date.now();
    const fetchFake = makeFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }));
    const h = makeManager({ fetchImpl: fetchFake.impl, now });
    h.manager.saveSnapshot(snapshot(UUID_A, { credentials: { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: now - HOUR_MS } }));
    await h.manager.updateSnapshotUsage(UUID_A, { force: true });
    const afterFirst = fetchFake.calls.filter((c) => c.isToken).length;
    assert.strictEqual(afterFirst, 1);

    // Non-forced, one hour later: the evidence is fresh, so no round trip.
    h.setNow(now + HOUR_MS);
    await h.manager.updateSnapshotUsage(UUID_A, {});
    assert.strictEqual(fetchFake.calls.filter((c) => c.isToken).length, afterFirst,
      'a known-dead row with fresh evidence must not spend a round trip');

    // Seven hours later: past DEAD_RETRY_MIN, so it self-retries.
    h.setNow(now + 7 * HOUR_MS);
    await h.manager.updateSnapshotUsage(UUID_A, {});
    assert.strictEqual(fetchFake.calls.filter((c) => c.isToken).length, afterFirst + 1,
      'a dead row must self-retry once its evidence is older than six hours');
    h.manager.stopCredentialWatcher();
  });

  // ══ 5. PASSIVE MODE, THE OWNERSHIP GUARDS ═══════════════════════════════

  await test('P5: passive mode refuses every credential-pool write with a typed conflict', () => {
    const h = makeManager({ externalBridgeOwner: true });
    assert.strictEqual(h.manager.isCredentialPoolReadOnly(), true);
    let threw = null;
    try { h.manager.assertCredentialPoolWritable('unit test'); } catch (err) { threw = err; }
    assert.ok(threw, 'assertCredentialPoolWritable let a write through in passive mode');
    assert.strictEqual(threw.code, 'CRED_POOL_EXTERNAL_OWNER', 'wrong code: ' + threw.code);
    assert.strictEqual(threw.status, 409, 'the ownership conflict must be a 409, got ' + threw.status);
    let threwSave = null;
    try { h.manager.saveSnapshot(snapshot(UUID_A)); } catch (err) { threwSave = err; }
    assert.ok(threwSave && threwSave.code === 'CRED_POOL_EXTERNAL_OWNER', 'saveSnapshot wrote in passive mode');
    h.manager.stopCredentialWatcher();
  });

  await test('P5: passive mode never reaches the token endpoint', async () => {
    const fetchFake = makeFetch(() => ({ status: 200, json: { access_token: 'x', refresh_token: 'y', expires_in: 1 } }));
    const h = makeManager({ fetchImpl: fetchFake.impl, externalBridgeOwner: true });
    let threw = null;
    try { await h.manager.refreshInactiveToken('rt-x'); } catch (err) { threw = err; }
    assert.ok(threw && threw.code === 'CRED_POOL_EXTERNAL_OWNER',
      'a refresh was attempted while another process owns the pool');
    assert.strictEqual(fetchFake.calls.length, 0, 'passive mode spent a network call');
    h.manager.stopCredentialWatcher();
  });

  await test('P5: the rotation write-back is inert in passive mode', async () => {
    const h = makeManager({ externalBridgeOwner: true });
    fs.writeFileSync(path.join(h.claudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-live', refreshToken: 'rt-live', expiresAt: Date.now() + HOUR_MS },
    }));
    fs.writeFileSync(h.claudeJsonPath, JSON.stringify({ oauthAccount: { accountUuid: UUID_A, emailAddress: 'a@example.com' } }));
    const synced = await h.manager.syncActiveTokenToProfile();
    assert.strictEqual(synced, null, 'the write-back captured an account while the pool was externally owned');
    assert.strictEqual(h.manager.readSnapshot(UUID_A), null, 'a snapshot was written in passive mode');
    h.manager.stopCredentialWatcher();
  });

  await test('P5: EVERY mutating credential route carries the ownership guard', () => {
    // Completeness, not spot checks: enumerate the route table and require a
    // guard on every verb that mutates. A new mutating route added without
    // one fails here, which is the whole point of a gate.
    const routeRe = /app\.(post|put|delete|patch)\('([^']+)'[\s\S]*?\{/g;
    const bodies = routesSrc.split(/app\.(?=(?:get|post|put|delete|patch)\()/);
    const mutating = [];
    for (const body of bodies) {
      const m = /^(post|put|delete|patch)\('([^']+)'/.exec(body);
      if (!m) continue;
      mutating.push({ verb: m[1], route: m[2], body });
    }
    assert.ok(mutating.length >= 7,
      'expected at least seven mutating credential routes, found ' + mutating.length
      + '; the enumeration is probably broken rather than the routes gone');
    const unguarded = mutating
      .filter((r) => r.body.indexOf('rejectExternalOwnerMutation(res') === -1)
      .map((r) => r.verb.toUpperCase() + ' ' + r.route);
    assert.deepStrictEqual(unguarded, [],
      'these mutating routes have no ownership guard: ' + unguarded.join(', '));
    void routeRe;
  });

  await test('P5: the guard names the operation and propagates the manager status and code verbatim', () => {
    // The guard does NOT hardcode 409 or the code; it asks the manager and
    // maps whatever the manager threw. That is the better shape (one owner
    // of the verdict), so what has to be pinned is the DELEGATION and the
    // propagation, not a literal in the routes file.
    const guard = functionSource(routesSrc, '  function rejectExternalOwnerMutation(');
    assert.ok(guard.indexOf('manager.assertCredentialPoolWritable(operation)') !== -1,
      'the guard no longer asks the manager, or no longer names the refused operation');
    assert.ok(guard.indexOf('return mapError(res, err)') !== -1,
      'the guard no longer maps the manager verdict onto the response');
    assert.ok(guard.indexOf("typeof manager.assertCredentialPoolWritable !== 'function'") !== -1,
      'the guard lost its tolerance for older injected manager fakes');
    const mapErr = functionSource(routesSrc, '  function mapError(');
    assert.ok(mapErr.indexOf('Number.isInteger(err.status) ? err.status : 500') !== -1,
      'mapError stopped propagating the manager status, so the 409 would become a 500');
    assert.ok(mapErr.indexOf("typeof err.code === 'string') ? err.code : 'CRED_INTERNAL'") !== -1,
      'mapError stopped propagating the typed code');
    // And the manager end of that contract, proved by construction above:
    // 409 + CRED_POOL_EXTERNAL_OWNER. The end-to-end HTTP assertion lives in
    // credential-routes.test.js, which this file requires to stay registered.
    const routeTestSrc = fs.readFileSync(path.join(__dirname, 'credential-routes.test.js'), 'utf8');
    assert.ok(routeTestSrc.indexOf('CRED_POOL_EXTERNAL_OWNER') !== -1,
      'the route-level passive-mode assertions vanished from credential-routes.test.js');
    assert.ok(/409/.test(routeTestSrc), 'the route-level 409 assertion vanished');
  });

  await test('P5: the read paths stay readable while another process owns the pool', () => {
    assert.ok(routesSrc.indexOf('if (credentialPoolIsReadOnly()) {\n        return sendList(res);') !== -1,
      'GET /api/credentials no longer short-circuits its side effects in passive mode');
    const usageFn = functionSource(readSource('credential-manager.js'), '  async function _updateSnapshotUsageUnlocked(');
    assert.ok(usageFn.indexOf('if (isCredentialPoolReadOnly()) return snap;') !== -1,
      'the usage path no longer serves the cached projection in passive mode');
  });

  // ══ 6. THE AUDIT ITSELF: the verified tests still run ════════════════════

  await test('the tests that verify these protections are still registered in the suite', () => {
    const runSrc = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const f of [
      'credential-manager.test.js',
      'credential-deadlock.test.js',
      'credential-routes.test.js',
      'credential-expiry-ui.test.js',
      'provider-account-manager.test.js',
      'provider-account-routes.test.js',
      'codex-accounts-capability.test.js',
      'mac-bridge.test.js',
    ]) {
      assert.ok(runSrc.indexOf("'" + f + "'") !== -1, f + ' is no longer registered in npm test');
      assert.ok(fs.existsSync(path.join(__dirname, f)), f + ' is registered but missing from disk');
    }
  });

  // ─── Results ───────────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(74));
  console.log('  [credential-protections-gate] ' + passed + '/' + (passed + failed) + ' tests passed');
  if (failed > 0) {
    console.log('\n  Offenders:');
    for (const f of failures) console.log('   - ' + f.name + ': ' + ((f.err && f.err.message) || f.err));
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { cleanup(); process.exit(code); })
  .catch((err) => { console.error(err); cleanup(); process.exit(1); });

/**
 * Remove every throwaway fixture directory.
 * @returns {void}
 */
function cleanup() {
  if (_keepAlive) { clearInterval(_keepAlive); _keepAlive = null; }
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}
