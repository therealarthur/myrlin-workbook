/**
 * b3-swap.test.js: account swaps (PROTOCOL.md 4.11, 13; decision A10;
 * critic F18; DESIGN-SPEC 9.10 and 9.12 group H; BUILD-CONTRACT 3.7.1
 * item 6 and 3.7.2 "Accounts").
 *
 * Part one boots the sandbox fixture mode (CWM_MOBILE_ACCOUNTS_FIXTURE with
 * codexRunning true, the file e2e/seed-workspace.js writes): a Codex swap
 * answers 409 CODEX_RUNNING with the processes, "Swap anyway" (force) swaps,
 * the snapshot flips active in memory, the swap log records source phone and
 * requester phone:<deviceId>, Undo carries the previous account for 5 s and
 * is itself a swap with reason undo, and fixture mode is refused on the
 * default data folder.
 *
 * Part two boots Workbook's real apply path with fake account managers
 * (b3-kit.js): CODEX_RUNNING from the manager's writer check and force,
 * one test per row of the swap words table (swap-words.js), each asserting
 * the HTTP status, the protocol code and the exact group H sentence, plus
 * SWAP_IN_PROGRESS, SWAPS_PAUSED with its reason, idempotent
 * clientRequestId, the desktop events and the audit line.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kit = require('./b3-kit');
const words = require('../../src/web/mobile/workspace/swap-words');
const { createAccounts, UNDO_MS } = require('../../src/web/mobile/workspace/accounts');
const seedWorkspace = require('./e2e/seed-workspace');

const MINUTE = 60 * 1000;
/** Glass's renewal guard around the live token's expiry (swap.rs). */
const RENEWAL_GUARD_MS = 6 * MINUTE;

const sb = kit.sandbox();
const fixtureFile = path.join(sb.root, 'accounts-fixture.json');
fs.writeFileSync(fixtureFile, JSON.stringify(seedWorkspace.accountsFixture(Date.now())));
let env;
let uuidN = 0;
/** A fresh lowercase UUID v4 for clientRequestId. */
const rid = () => '00000000-0000-4000-8000-' + String(++uuidN).padStart(12, '0');

/**
 * POST /accounts/swap.
 *
 * @param {object} body - SwapRequest fields.
 * @returns {Promise<object>}
 */
function swap(body) {
  return env.api('POST', '/accounts/swap', Object.assign({ clientRequestId: rid(), force: false, reason: 'user' }, body));
}

// ── Part one: fixture mode ─────────────────────────────────────────────────

kit.test('fixture mode boots from the accounts fixture', async () => {
  env = await kit.bootWorkspace({ workspace: { env: Object.assign({}, process.env, { CWM_MOBILE_ACCOUNTS_FIXTURE: fixtureFile }) } });
  kit.ok(env.ws.internals.accounts.fixtureMode(), 'fixture mode on');
  const r = await env.api('GET', '/accounts');
  kit.validate(r.body, 'accounts/accounts-response.json');
  kit.eq(r.body.accounts.providers[1].activeAccountId, 'acct_morgan');
});

kit.test('fixture: CODEX_RUNNING, then Swap anyway flips active and logs the phone', async () => {
  const r = await swap({ provider: 'codex', accountId: 'acct_alt' });
  kit.eq([r.status, r.body.code], [409, 'CODEX_RUNNING']);
  kit.validate(r.body, 'common/error.json');
  kit.eq(r.body.processes, [{ pid: 4120, name: 'codex.exe', path: 'C:\\Program Files\\Codex\\codex.exe' }]);
  kit.eq(r.body.error, 'Codex is running (1). It keeps the old account until restarted. Swap anyway?');
  const t0 = Date.now();
  const ok = await swap({ provider: 'codex', accountId: 'acct_alt', force: true });
  kit.eq(ok.status, 200, JSON.stringify(ok.body));
  kit.validate(ok.body, 'accounts/swap-result.json');
  kit.eq([ok.body.ok, ok.body.alreadyActive, ok.body.activeAccountId, ok.body.previousAccountId], [true, false, 'acct_alt', 'acct_morgan']);
  kit.eq(ok.body.message, 'Switched Codex to alt. Running Codex keeps the old account until restarted.');
  kit.eq(ok.body.runningProcesses.length, 1);
  kit.eq(ok.body.undo.accountId, 'acct_morgan');
  kit.ok(ok.body.undo.expiresAtMs - t0 >= UNDO_MS && ok.body.undo.expiresAtMs - Date.now() <= UNDO_MS, 'Undo lasts 5 s');
  kit.eq(UNDO_MS, 5000);
  const snap = (await env.api('GET', '/accounts')).body.accounts;
  const cx = snap.providers[1];
  kit.eq([cx.activeAccountId, cx.accounts[0].accountId, cx.accounts[0].active], ['acct_alt', 'acct_alt', true]);
  const entry = snap.swapLog[0];
  kit.eq([entry.provider, entry.accountId, entry.source, entry.requester, entry.reason, entry.ok], ['codex', 'acct_alt', 'phone', 'phone:' + env.device.deviceId, null, true]);
});

kit.test('fixture: Undo is a new swap with reason undo', async () => {
  const u = await swap({ provider: 'codex', accountId: 'acct_morgan', force: true, reason: 'undo' });
  kit.eq([u.status, u.body.activeAccountId], [200, 'acct_morgan']);
  const snap = (await env.api('GET', '/accounts')).body.accounts;
  kit.eq([snap.swapLog[0].accountId, snap.swapLog[0].reason], ['acct_morgan', 'undo']);
});

kit.test('fixture: Claude swaps, the already active answer, and refusals', async () => {
  const c = await swap({ provider: 'claude', accountId: 'acc-work' });
  kit.eq([c.status, c.body.message, c.body.undo.accountId], [200, 'Switched Claude to Work.', 'acc-personal']);
  const again = await swap({ provider: 'claude', accountId: 'acc-work' });
  kit.eq([again.status, again.body.alreadyActive, again.body.message, again.body.undo, again.body.previousAccountId], [200, true, 'Work is already active.', null, null]);
  const blocked = await swap({ provider: 'claude', accountId: 'acc-blocked' });
  kit.eq([blocked.status, blocked.body.code], [409, 'ACCOUNT_NOT_SWAPPABLE']);
  const signin = await swap({ provider: 'claude', accountId: 'acc-signin' });
  kit.eq([signin.status, signin.body.code, signin.body.error], [409, 'ACCOUNT_NOT_SWAPPABLE', 'sam.reed needs a new sign-in. Tap its chip to sign in again.']);
  const unknown = await swap({ provider: 'claude', accountId: 'acc-nope' });
  kit.eq([unknown.status, unknown.body.code], [404, 'ACCOUNT_NOT_FOUND']);
  const bad = await swap({ provider: 'gemini', accountId: 'x' });
  kit.eq([bad.status, bad.body.code, bad.body.field], [400, 'INVALID_FIELD', 'provider']);
});

kit.test('fixture mode is refused on the default data folder', async () => {
  const logs = [];
  const ctx = { dataDir: sb.root, mobile: {}, log: (m) => logs.push(m) };
  const a = createAccounts({ ctx, env: { CWM_MOBILE_ACCOUNTS_FIXTURE: fixtureFile, CWM_DATA_DIR: path.join(os.homedir(), '.myrlin') } });
  kit.eq(a.fixtureMode(), false);
  kit.ok(logs.some((m) => /fixture refused/.test(m)), 'logged once');
  const b = createAccounts({ ctx, env: { CWM_MOBILE_ACCOUNTS_FIXTURE: fixtureFile } });
  kit.eq(b.fixtureMode(), false, 'no CWM_DATA_DIR, no fixture');
  a.stop();
  b.stop();
});

// ── Part two: Workbook's apply paths ───────────────────────────────────────

const fakes = kit.fakeAccountManagers(path.join(sb.root, 'managers'));

/** Reset the fakes to two usable Claude accounts and two Codex accounts. */
function resetFakes() {
  const now = Date.now();
  const usage = (a, b) => ({ five_hour: { utilization: a, resets_at: new Date(now + 3600e3).toISOString() }, seven_day: { utilization: b, resets_at: new Date(now + 86400e3).toISOString() }, fetchedAt: new Date(now).toISOString() });
  fakes.claude.profiles = [
    { profileId: 'acc-personal', email: 'avery.lane@example.com', label: 'Personal', tokenState: 'ok', tokenDead: false, health: 'ok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', usage: usage(8, 80) },
    { profileId: 'acc-work', email: 'morgan.hale@example.com', label: 'Work', tokenState: 'ok', tokenDead: false, health: 'ok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', usage: usage(30, 41) },
    { profileId: 'acc-dead', email: 'sam.reed@example.com', label: null, tokenState: 'needs_login', tokenDead: true, health: 'ok', usage: null },
  ];
  fakes.claude.active = 'acc-personal';
  fakes.claude.readOnly = false;
  fakes.claude.expiresAt = now + 3600e3;
  fakes.claude.applyError = null;
  fakes.claude.applyDelayMs = 0;
  fakes.claude.liveAfterApply = null;
  fakes.codex.accounts = [
    { accountId: 'acct_morgan', email: 'morgan.hale@example.com', label: null, plan: 'pro', tokenState: 'ok', health: 'ok', accessExpired: false, usage: usage(20, 50) },
    { accountId: 'acct_alt', email: 'alt.user@example.com', label: 'alt', plan: 'pro', tokenState: 'ok', health: 'ok', accessExpired: false, usage: usage(10, 10) },
  ];
  fakes.codex.active = 'acct_morgan';
  fakes.codex.running = [];
  fakes.codex.applyError = null;
  fakes.codex.liveAfterApply = null;
  fs.writeFileSync(fakes.credentialManager.claudeJsonPath, JSON.stringify({ oauthAccount: {} }));
  if (typeof fakes.credentialManager.applyCredential !== 'function') fakes.credentialManager.applyCredential = fakes.savedApply;
}

/**
 * An error as Workbook's managers throw it (credError: .code, .message).
 *
 * @param {string} code - Workbook code.
 * @param {string} [message] - Message.
 * @returns {Error}
 */
function wbError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/**
 * Assert a refused swap: status, protocol code and the exact sentence.
 *
 * @param {object} r - Response.
 * @param {number} status - HTTP status.
 * @param {string} code - Protocol code.
 * @param {string} sentence - The group H sentence with the final period.
 */
function refused(r, status, code, sentence) {
  kit.eq([r.status, r.body.code, r.body.error], [status, code, sentence]);
  kit.validate(r.body, 'common/error.json');
}

const covered = new Set();

kit.test('real: boot Workbook apply paths with fake managers', async () => {
  await env.close();
  fakes.savedApply = fakes.credentialManager.applyCredential;
  resetFakes();
  env = await kit.bootWorkspace({ credentialManager: fakes.credentialManager, codexAccountManager: fakes.codexAccountManager });
  kit.eq(env.ws.internals.accounts.fixtureMode(), false);
});

kit.test('real: CODEX_RUNNING from the writer check, then force', async () => {
  resetFakes();
  fakes.codex.running = [{ pid: 77, name: 'codex.exe', path: 'C:\\x\\codex.exe' }, { pid: 78, name: 'Codex.exe', path: 'C:\\y\\Codex.exe' }];
  const r = await swap({ provider: 'codex', accountId: 'acct_alt' });
  kit.eq([r.status, r.body.code, r.body.processes.length], [409, 'CODEX_RUNNING', 2]);
  kit.eq(r.body.error, 'Codex is running (2). It keeps the old account until restarted. Swap anyway?');
  kit.eq(fakes.codex.active, 'acct_morgan', 'nothing changed');
  const before = env.sse.length;
  const ok = await swap({ provider: 'codex', accountId: 'acct_alt', force: true });
  kit.eq(ok.status, 200, JSON.stringify(ok.body));
  kit.validate(ok.body, 'accounts/swap-result.json');
  kit.eq([ok.body.activeAccountId, ok.body.runningProcesses.length, ok.body.undo.accountId], ['acct_alt', 2, 'acct_morgan']);
  kit.ok(fakes.calls.some((c) => c[0] === 'codex.apply' && c[1] === 'acct_alt' && c[2] === true), 'applied with force');
  kit.ok(env.sse.slice(before).some((e) => e.type === 'provider-accounts:changed' && e.data.activeAccountId === 'acct_alt'), 'the desktop hears it');
  covered.add('codexOk');
});

kit.test('words row claudeOk: "Switched Claude to {name}."', async () => {
  resetFakes();
  const before = env.sse.length;
  const r = await swap({ provider: 'claude', accountId: 'acc-work' });
  kit.eq([r.status, r.body.message, r.body.previousAccountId, r.body.undo.accountId], [200, 'Switched Claude to Work.', 'acc-personal', 'acc-personal']);
  kit.ok(env.sse.slice(before).some((e) => e.type === 'credentials:changed' && e.data.activeProfileId === 'acc-work'), 'the desktop hears it');
  kit.ok(env.auditEntries.some((e) => e.action === 'swap' && e.ok === true), 'audit line');
  const log = (await env.api('GET', '/accounts')).body.accounts.swapLog[0];
  kit.eq([log.source, log.requester, log.accountId, log.ok], ['phone', 'phone:' + env.device.deviceId, 'acc-work', true]);
  covered.add('claudeOk');
});

kit.test('words row alreadyLive: "{name} is already active."', async () => {
  resetFakes();
  const r = await swap({ provider: 'claude', accountId: 'acc-personal' });
  kit.eq([r.status, r.body.alreadyActive, r.body.message, r.body.undo], [200, true, 'Personal is already active.', null]);
  covered.add('alreadyLive');
});

kit.test('words row workbookOffline: 502 SWAP_FAILED', async () => {
  resetFakes();
  fakes.credentialManager.applyCredential = undefined;
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 502, 'SWAP_FAILED', 'Workbook offline, the switch did not happen.');
  covered.add('workbookOffline');
});

kit.test('words row timeout: 504 SWAP_TIMEOUT', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('TIMEOUT', 'timeout');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 504, 'SWAP_TIMEOUT', 'Workbook did not answer in time; the switch may still finish, refresh to check.');
  covered.add('timeout');
});

kit.test('words row passive: 409 SWAPS_PAUSED with its reason', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('CRED_POOL_EXTERNAL_OWNER', 'another owner');
  const r = await swap({ provider: 'claude', accountId: 'acc-work' });
  refused(r, 409, 'SWAPS_PAUSED', 'Workbook is in passive mode, swaps paused.');
  kit.eq(r.body.reason, 'Workbook is in passive mode, swaps paused');
  // Passive seen in the snapshot first: the same row, with the headline reason.
  resetFakes();
  fakes.claude.readOnly = true;
  const p = await swap({ provider: 'claude', accountId: 'acc-work' });
  refused(p, 409, 'SWAPS_PAUSED', 'Workbook is in passive mode, swaps paused.');
  kit.eq(p.body.reason, 'Workbook passive, switching paused');
  covered.add('passive');
});

kit.test('words row deadToken: 409 ACCOUNT_NOT_SWAPPABLE', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('CRED_TOKEN_DEAD', 'needs /login');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 409, 'ACCOUNT_NOT_SWAPPABLE', 'Work needs a new sign-in. Tap its chip to sign in again.');
  resetFakes();
  refused(await swap({ provider: 'claude', accountId: 'acc-dead' }), 409, 'ACCOUNT_NOT_SWAPPABLE', 'sam.reed needs a new sign-in. Tap its chip to sign in again.');
  covered.add('deadToken');
});

kit.test('words row renewalGuard: 409 SWAP_REFUSED with retryAfterMs', async () => {
  resetFakes();
  fakes.claude.expiresAt = Date.now() + 2 * MINUTE;
  const r = await swap({ provider: 'claude', accountId: 'acc-work' });
  refused(r, 409, 'SWAP_REFUSED', 'Claude Code is renewing its login, try again in 8 min.');
  kit.ok(r.body.retryAfterMs > 7 * MINUTE && r.body.retryAfterMs <= RENEWAL_GUARD_MS + 2 * MINUTE, String(r.body.retryAfterMs));
  kit.ok(!fakes.calls.some((c) => c[0] === 'claude.apply' && c[1] === 'acc-work' && fakes.claude.active === 'acc-work'), 'no apply');
  covered.add('renewalGuard');
});

kit.test('words row credentialManager: 409 SWAP_REFUSED', async () => {
  resetFakes();
  fs.writeFileSync(fakes.credentialManager.claudeJsonPath, JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
  const r = await swap({ provider: 'claude', accountId: 'acc-work' });
  kit.eq([r.status, r.body.code], [409, 'SWAP_REFUSED']);
  kit.ok(/^Claude Code keeps its login in Windows Credential Manager on .+, so Claude swaps are off\.$/.test(r.body.error), r.body.error);
  covered.add('credentialManager');
});

kit.test('words row filesBusy: 409 SWAP_REFUSED (unreadable files, or the live file busy)', async () => {
  resetFakes();
  fs.writeFileSync(fakes.credentialManager.claudeJsonPath, '{"half": ');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 409, 'SWAP_REFUSED', 'Claude Code is updating its login files, try again in a moment.');
  resetFakes();
  fakes.claude.applyError = wbError('CRED_LIVE_BUSY', 'busy');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 409, 'SWAP_REFUSED', 'Claude Code is updating its login files, try again in a moment.');
  covered.add('filesBusy');
});

kit.test('words row identityMismatch: 502 SWAP_FAILED', async () => {
  resetFakes();
  fakes.claude.liveAfterApply = 'acc-personal';
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 502, 'SWAP_FAILED', 'Workbook switched Claude to Work, but the live login is still avery.lane@example.com. Check Workbook before switching again.');
  covered.add('identityMismatch');
});

kit.test('words row liveFileUnreadable: 409 SWAP_REFUSED', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('CRED_LIVE_UNPARSEABLE', 'unparseable');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 409, 'SWAP_REFUSED', "Claude Code's live login file could not be read, so Workbook changed nothing. Try again in a moment.");
  covered.add('liveFileUnreadable');
});

kit.test('words row notFound: 404 ACCOUNT_NOT_FOUND', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('CRED_NOT_FOUND', 'gone');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 404, 'ACCOUNT_NOT_FOUND', 'Workbook no longer has Work, refresh and try again.');
  covered.add('notFound');
});

kit.test('words row incompleteCopy: 409 ACCOUNT_NOT_SWAPPABLE', async () => {
  resetFakes();
  fakes.codex.applyError = wbError('ACCT_INCOMPLETE', 'incomplete');
  refused(await swap({ provider: 'codex', accountId: 'acct_alt' }), 409, 'ACCOUNT_NOT_SWAPPABLE', "Workbook's copy of alt is incomplete. Tap its chip to sign in again.");
  covered.add('incompleteCopy');
});

kit.test('words row busyTimeout: 504 SWAP_TIMEOUT', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('CRED_OP_TIMEOUT', 'busy');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 504, 'SWAP_TIMEOUT', 'Workbook was busy and timed out, try again in a moment.');
  covered.add('busyTimeout');
});

kit.test('words row anythingElse: 502 SWAP_FAILED quoting Workbook', async () => {
  resetFakes();
  fakes.claude.applyError = wbError('CRED_INTERNAL', 'the disk refused the write.');
  refused(await swap({ provider: 'claude', accountId: 'acc-work' }), 502, 'SWAP_FAILED', 'Switching Claude failed: the disk refused the write.');
  const log = (await env.api('GET', '/accounts')).body.accounts.swapLog[0];
  kit.eq([log.accountId, log.ok], ['acc-work', false], 'a failed swap is logged with ok false');
  covered.add('anythingElse');
});

kit.test('every row of the words table has its test', async () => {
  kit.eq(words.ROWS.map((r) => r.key).filter((k) => !covered.has(k)), []);
});

kit.test('SWAP_IN_PROGRESS while a swap runs; a repeated clientRequestId returns the first result', async () => {
  resetFakes();
  fakes.claude.applyDelayMs = 300;
  const id = rid();
  const first = env.api('POST', '/accounts/swap', { clientRequestId: id, provider: 'claude', accountId: 'acc-work', force: false, reason: 'user' });
  await kit.sleep(50);
  const second = await swap({ provider: 'codex', accountId: 'acct_alt' });
  kit.eq([second.status, second.body.code], [409, 'SWAP_IN_PROGRESS']);
  const a = await first;
  kit.eq(a.status, 200);
  const n = fakes.calls.filter((c) => c[0] === 'claude.apply').length;
  const again = await env.api('POST', '/accounts/swap', { clientRequestId: id, provider: 'claude', accountId: 'acc-work', force: false, reason: 'user' });
  kit.eq([again.status, again.body.message, again.body.activeAccountId], [200, a.body.message, 'acc-work']);
  kit.eq(fakes.calls.filter((c) => c[0] === 'claude.apply').length, n, 'no second apply');
});

kit.test('no Undo when the previous account cannot be swapped back to', async () => {
  resetFakes();
  fakes.claude.active = 'acc-dead';
  const r = await swap({ provider: 'claude', accountId: 'acc-work' });
  kit.eq([r.status, r.body.previousAccountId, r.body.undo], [200, 'acc-dead', null]);
});

kit.run(async () => { if (env) await env.close(); });
