/**
 * b3-accounts-workbook.test.js: accounts from Workbook's own rosters when
 * Glass is absent (PROTOCOL.md 3.11, 4.11; decision A10; R01 sections 3.2 to
 * 3.5; BUILD-CONTRACT 3.7.2 "Accounts").
 *
 * The Claude credential manager and the Codex account manager are fakes with
 * the real managers' members (test/mobile/b3-kit.js). The suite checks the
 * rules Glass applies, applied to Workbook's cached usage: a Codex window is
 * labelled by its length, never by its position (a 604800 s primary window
 * reads "Weekly", not "5h"), severity at 74, 75, 89, 90 and 100, ring
 * assignment for Claude and for a single window Codex account, account
 * states and chips, the passive headline, the refresh floors (one Claude
 * request per 30 s across accounts and per account per 60 s, Codex per
 * account per 15 s), labels through the managers with the desktop event,
 * limit pushes once per threshold per window, widgets pushes, and
 * accounts.updated at most once per 2 s.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const path = require('path');
const kit = require('./b3-kit');
const accountsMod = require('../../src/web/mobile/workspace/accounts');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Glass's floors (R01:168-173, PROTOCOL.md 4.11). */
const CLAUDE_GLOBAL_FLOOR = 30 * SECOND;
const CLAUDE_ACCOUNT_FLOOR = 60 * SECOND;
const CODEX_ACCOUNT_FLOOR = 15 * SECOND;

const sb = kit.sandbox();
const fakes = kit.fakeAccountManagers(path.join(sb.root, 'accounts'));
const clock = { t: Date.now() };
const iso = (ms) => new Date(ms).toISOString();
let env;

/**
 * A Claude roster row as credential-manager.js getSafeList() lists it.
 *
 * @param {string} id - accountUuid.
 * @param {string} email - Email.
 * @param {string|null} label - Label.
 * @param {object|null} usage - Stored usage.
 * @param {object} [extra] - Fields to override.
 * @returns {object}
 */
function claudeRow(id, email, label, usage, extra) {
  return Object.assign({ profileId: id, email, label, displayName: label || email, tokenState: 'ok', tokenDead: false, health: 'ok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', usage, lastRefreshError: null }, extra || {});
}

/**
 * A Codex roster row as provider-account-manager.js getSafeList() lists it.
 *
 * @param {string} id - accountId.
 * @param {string} email - Email.
 * @param {string|null} label - Label.
 * @param {object|null} usage - Stored usage ({five_hour, seven_day, plan_type, fetchedAt}).
 * @param {object} [extra] - Fields to override.
 * @returns {object}
 */
function codexRow(id, email, label, usage, extra) {
  return Object.assign({ accountId: id, email, label, displayName: label || email, plan: 'pro', authMode: 'chatgpt', tokenState: 'ok', health: 'ok', accessExpired: false, usage, lastError: null }, extra || {});
}

/** Rebuild the snapshot now (what the watcher tick does). */
async function rebuild(reason) {
  return env.ws.internals.accounts.rebuild(reason || 'other');
}

/** @returns {object} an account of the current snapshot by id */
function acct(snap, id) {
  return snap.providers.flatMap((p) => p.accounts).find((a) => a.accountId === id);
}

kit.test('boot on Workbook rosters (no Glass)', async () => {
  const t = clock.t;
  fakes.claude.profiles = [
    claudeRow('cl-personal', 'avery.lane@example.com', 'Personal', { five_hour: { utilization: 8, resets_at: iso(t + 2 * HOUR) }, seven_day: { utilization: 74, resets_at: iso(t + 3 * DAY) }, fetchedAt: iso(t - MINUTE) }),
    claudeRow('cl-work', 'morgan.hale@example.com', null, { limits: [{ kind: 'session', percent: 30, resets_at: iso(t + HOUR) }, { kind: 'weekly_all', percent: 41, resets_at: iso(t + 4 * DAY) }, { kind: 'weekly_scoped', model: 'Fable', percent: 5, resets_at: iso(t + 4 * DAY) }], fetchedAt: iso(t - MINUTE) }, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }),
    claudeRow('cl-dead', 'sam.reed@example.com', null, null, { tokenDead: true, tokenState: 'needs_login' }),
    claudeRow('cl-old', 'robin.ash@example.com', null, { five_hour: { utilization: 1, resets_at: iso(t + HOUR) }, seven_day: { utilization: 2, resets_at: iso(t + DAY) }, fetchedAt: iso(t - 2 * HOUR) }),
  ];
  fakes.claude.active = 'cl-personal';
  fakes.codex.accounts = [
    // A Pro account: the endpoint's primary window is the weekly one, which Workbook's cache files under five_hour.
    codexRow('cx-pro', 'morgan.hale@example.com', null, { five_hour: { utilization: 96, resets_at: iso(t + 5 * DAY) }, seven_day: null, plan_type: 'pro', fetchedAt: iso(t - MINUTE) }),
    // A Plus account with both windows.
    codexRow('cx-plus', 'alt.user@example.com', 'alt', { five_hour: { utilization: 20, resets_at: iso(t + 3 * HOUR) }, seven_day: { utilization: 60, resets_at: iso(t + 6 * DAY) }, plan_type: 'plus', fetchedAt: iso(t - MINUTE) }, { plan: 'plus' }),
    codexRow('cx-expired', 'old.user@example.com', null, null, { accessExpired: true }),
  ];
  fakes.codex.active = 'cx-pro';
  env = await kit.bootWorkspace({ credentialManager: fakes.credentialManager, codexAccountManager: fakes.codexAccountManager, workspace: { now: () => clock.t } });
});

kit.test('the snapshot comes from the rosters and validates', async () => {
  const r = await env.api('GET', '/accounts');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'accounts/accounts-response.json');
  const s = r.body.accounts;
  kit.eq([s.source, s.swapsEnabled, s.stalledSinceAtMs, s.services, s.glass], ['workbook', true, null, null, { apiAvailable: false, stateFileAgeMs: null }]);
  kit.eq(s.providers.map((p) => [p.provider, p.activeAccountId, p.recommendation]), [['claude', 'cl-personal', null], ['codex', 'cx-pro', null]]);
  kit.eq(s.providers[0].accounts[0].accountId, 'cl-personal', 'active first');
  const p = acct(s, 'cl-personal');
  kit.eq([p.displayName, p.plan, p.dataSource, p.state, p.chip, p.headroom], ['Personal', 'Max 20x', 'workbookCache', 'ok', 'usable', 26]);
  kit.eq(acct(s, 'cl-work').displayName, 'morgan.hale', 'no label: the email local part');
  kit.eq(acct(s, 'cl-work').plan, 'Max 5x');
});

kit.test('a Codex 604800 s primary window reads "Weekly", never "5h" (A10)', async () => {
  const s = env.ws.accounts.snapshot();
  const pro = acct(s, 'cx-pro');
  kit.eq(pro.windows.map((w) => [w.key, w.label, w.windowSeconds, w.ring, w.severity]), [['codex:604800', 'Weekly', 604800, 'single', 'critical']]);
  const plus = acct(s, 'cx-plus');
  kit.eq(plus.windows.map((w) => [w.label, w.windowSeconds, w.ring]), [['5h', 18000, 'outer'], ['Weekly', 604800, 'inner']]);
  // Explicit lengths win, and other lengths are named in days, hours or minutes.
  const w = env.ws.internals.accounts._internal.codexWindows({ five_hour: { utilization: 5, resets_at: iso(clock.t + HOUR), limit_window_seconds: 2 * DAY / SECOND }, seven_day: null, fetchedAt: iso(clock.t) }, null);
  kit.eq(w.map((x) => x.label), ['2d']);
  kit.eq([accountsMod.labelForSeconds(18000), accountsMod.labelForSeconds(604800), accountsMod.labelForSeconds(7200), accountsMod.labelForSeconds(1800)], ['5h', 'Weekly', '2h', '30m']);
});

kit.test('severity at 74, 75, 89, 90 and 100', async () => {
  kit.eq([74, 75, 89, 90, 99, 100].map((p) => accountsMod.severityOf(p)), ['normal', 'warn', 'warn', 'critical', 'critical', 'limited']);
  kit.eq(accountsMod.severityOf(40, true), 'limited', 'the provider says not allowed');
  const personal = acct(env.ws.accounts.snapshot(), 'cl-personal');
  kit.eq(personal.windows.map((w) => w.severity), ['normal', 'normal']);
});

kit.test('rings: Claude session outer, weekly inner, scoped weeklies none', async () => {
  const work = acct(env.ws.accounts.snapshot(), 'cl-work');
  kit.eq(work.windows.map((w) => [w.key, w.label, w.ring]), [['session', 'Session', 'outer'], ['weekly', 'Weekly', 'inner'], ['weekly:Fable', 'Weekly Fable', 'none']]);
  kit.eq(work.headroom, 59, 'headroom is 100 minus the worst ring window');
});

kit.test('states and chips follow Glass (R01:158-162)', async () => {
  const s = env.ws.accounts.snapshot();
  const dead = acct(s, 'cl-dead');
  kit.eq([dead.state, dead.chip, dead.swappable, dead.windows, dead.headroom], ['needsLogin', 'signIn', false, [], null]);
  const old = acct(s, 'cl-old');
  kit.eq([old.state, old.staleReason, old.chip, old.swappable], ['stale', 'usageOld', 'usable', true]);
  const expired = acct(s, 'cx-expired');
  kit.eq([expired.state, expired.staleReason, expired.chip], ['stale', 'tokenExpired', 'signIn']);
});

kit.test('a passive credential pool pauses swaps with Glass words', async () => {
  fakes.claude.readOnly = true;
  const s = await rebuild();
  kit.eq([s.swapsEnabled, s.swapsDisabledReason], [false, 'Workbook passive, switching paused']);
  fakes.claude.readOnly = false;
  kit.eq((await rebuild()).swapsEnabled, true);
});

kit.test('refresh floors: Claude 30 s across accounts and 60 s per account, Codex 15 s per account', async () => {
  fakes.calls.length = 0;
  const a = await env.api('POST', '/accounts/refresh', { provider: 'claude' });
  kit.eq([a.status, a.body.message], [202, 'Refreshing usage.']);
  kit.validate(a.body, 'accounts/refresh-result.json');
  kit.eq(fakes.calls.filter((c) => c[0] === 'claude.usage'), [['claude.usage', 'cl-personal', true]], 'one Claude request, the active account first');
  const b = await env.api('POST', '/accounts/refresh', { provider: 'claude' });
  kit.eq([b.status, b.body.message], [202, 'Refreshed recently. Numbers update within a minute.']);
  clock.t += CLAUDE_GLOBAL_FLOOR;
  await env.api('POST', '/accounts/refresh', { provider: 'claude' });
  const second = fakes.calls.filter((c) => c[0] === 'claude.usage').map((c) => c[1]);
  kit.eq(second.length, 2, 'one more after the global floor');
  kit.ok(second[1] !== 'cl-personal', 'the refreshed account waits for its own 60 s floor: ' + second.join(','));
  kit.ok(!second.includes('cl-dead'), 'a dead login is never polled');
  clock.t += CLAUDE_ACCOUNT_FLOOR;
  fakes.calls.length = 0;
  const c = await env.api('POST', '/accounts/refresh', { provider: 'codex' });
  kit.eq(c.status, 202);
  kit.eq(fakes.calls.filter((x) => x[0] === 'codex.usage').map((x) => x[1]).sort(), ['cx-expired', 'cx-plus', 'cx-pro']);
  const d = await env.api('POST', '/accounts/refresh', { provider: 'codex' });
  kit.eq(d.body.message, 'Refreshed recently. Numbers update within a minute.');
  clock.t += CODEX_ACCOUNT_FLOOR;
  fakes.calls.length = 0;
  await env.api('POST', '/accounts/refresh', { provider: 'codex' });
  kit.eq(fakes.calls.filter((x) => x[0] === 'codex.usage').length, 3, 'after 15 s every Codex account again');
});

kit.test('labels go through the managers, answer the Account and tell the desktop', async () => {
  const before = env.sse.length;
  const r = await env.api('PUT', '/accounts/claude/cl-work/label', { label: '  Work  ' });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'accounts/account.json');
  kit.eq([r.body.label, r.body.displayName], ['Work', 'Work']);
  kit.ok(fakes.calls.some((c) => c[0] === 'claude.label' && c[1] === 'cl-work' && c[2] === 'Work'), 'credential manager setLabel');
  kit.ok(env.sse.slice(before).some((e) => e.type === 'credentials:changed' && e.data.renamed === true && e.data.profileId === 'cl-work'), 'desktop credentials:changed');
  const cx = await env.api('PUT', '/accounts/codex/cx-plus/label', { label: '' });
  kit.eq([cx.status, cx.body.label, cx.body.displayName], [200, null, 'alt.user'], 'an empty label resets');
  kit.ok(env.sse.slice(before).some((e) => e.type === 'provider-accounts:changed' && e.data.renamed === true && e.data.accountId === 'cx-plus'), 'desktop provider-accounts:changed');
  const long = await env.api('PUT', '/accounts/claude/cl-work/label', { label: 'x'.repeat(61) });
  kit.eq([long.status, long.body.code, long.body.field], [400, 'INVALID_FIELD', 'label']);
  const unknown = await env.api('PUT', '/accounts/claude/nope/label', { label: 'X' });
  kit.eq([unknown.status, unknown.body.code], [404, 'ACCOUNT_NOT_FOUND']);
  const badProvider = await env.api('PUT', '/accounts/gemini/x/label', { label: 'X' });
  kit.eq([badProvider.status, badProvider.body.code], [404, 'ACCOUNT_NOT_FOUND']);
});

kit.test('limit pushes: once per window per threshold; widgets pushes on change', async () => {
  const pushesAt = env.pushEvents.length;
  const setWeekly = (pc) => { fakes.claude.profiles[0].usage = { five_hour: { utilization: 8, resets_at: iso(clock.t + 2 * HOUR) }, seven_day: { utilization: pc, resets_at: iso(clock.t + 3 * DAY) }, fetchedAt: iso(clock.t) }; };
  setWeekly(76);
  await rebuild('refresh');
  setWeekly(78);
  await rebuild('refresh');
  setWeekly(91);
  await rebuild('refresh');
  setWeekly(100);
  await rebuild('refresh');
  const limits = env.pushEvents.slice(pushesAt).filter((e) => e.kind === 'limit');
  kit.eq(limits.map((e) => [e.provider, e.accountId, e.windowKey, e.windowLabel, e.percent, e.limited]), [
    ['claude', 'cl-personal', 'weekly', 'Weekly', 76, false],
    ['claude', 'cl-personal', 'weekly', 'Weekly', 91, false],
    ['claude', 'cl-personal', 'weekly', 'Weekly', 100, true],
  ]);
  kit.eq(limits[0].accountDisplayName, 'Personal');
  kit.ok(env.pushEvents.slice(pushesAt).some((e) => e.kind === 'widgets'), 'a widgets push after a percent change');
  // An inactive account crossing a threshold sends nothing.
  const n = env.pushEvents.length;
  fakes.claude.profiles[1].usage = { five_hour: { utilization: 99, resets_at: iso(clock.t + HOUR) }, seven_day: null, fetchedAt: iso(clock.t) };
  await rebuild('refresh');
  kit.eq(env.pushEvents.slice(n).filter((e) => e.kind === 'limit').length, 0);
});

kit.test('accounts.updated is published at most once per 2 s', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  s.send({ type: 'subscribe', id: 'a1', epoch: null, topics: [{ topic: 'accounts', sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const start = s.frames.length;
  for (const pc of [40, 41, 42]) {
    fakes.codex.accounts[1].usage.seven_day.utilization = pc;
    await rebuild('refresh');
  }
  const first = await s.next((f) => f.type === 'accounts.updated', 5000, start);
  kit.validateFrame(first);
  kit.eq(acct(first.data.accounts, 'cx-plus').windows[1].percent, 42, 'the latest wins');
  await kit.sleep(2500);
  kit.eq(s.frames.slice(start).filter((f) => f.type === 'accounts.updated').length, 1, 'three changes, one event');
  s.close();
});

kit.run(async () => { if (env) await env.close(); });
