/**
 * b3-accounts-glass.test.js: accounts served from Myrlin Glass (PROTOCOL.md
 * 3.11, 4.11; decision A10; R01 sections 4.4 and 7; BUILD-CONTRACT 3.7.2
 * "Accounts").
 *
 * A stub Glass /v1 API on 127.0.0.1 port 0 (api.json in a sandbox Quota
 * folder named by CWM_GLASS_DIR) serves a StatusPayload fixture. The suite
 * checks the AccountsSnapshot field for field against that fixture, the
 * client rules Glass enforces (loopback Host, no Origin, the bearer from
 * api.json re read after a 401), the recommendation only at warn or worse,
 * the read only services block, the swap log merge (service swaps left out),
 * the state.json fallback with its age and the "no updates since" stall,
 * accounts.updated on a state.json change, refresh through /v1/refresh, and
 * sign in: a LoginFlow, LOGIN_IN_PROGRESS with the running flowId, status
 * polling, LOGIN_CANCEL_UNSUPPORTED, and 503 GLASS_UNAVAILABLE without Glass.
 * Every answer validates against the vendored schemas.
 *
 * Nothing here talks to the real Glass: CWM_GLASS_DIR points at a sandbox
 * folder, and a test process on a sandbox data folder never uses the real
 * Quota folder anyway (glass-client.js quotaDir).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const http = require('http');
const kit = require('./b3-kit');
const { quotaDir } = require('../../src/web/mobile/workspace/glass-client');

/** The fixture's own clock (generatedAtMs); every time in it is relative to this. */
const FIXTURE_T0 = 1790000000000;
/** Three minutes and a bit: past Glass's stall line (R01:101). */
const STALLED_AGE_MS = 4 * 60 * 1000;
/** A token Glass would mint at a start (32 random bytes in real life). */
const TOKEN_A = 'glass-token-a';
const TOKEN_B = 'glass-token-b';

const sb = kit.sandbox();
const glassDir = path.join(sb.root, 'quota');
fs.mkdirSync(glassDir, { recursive: true });
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'accounts', 'glass-status.json'), 'utf8'));

/**
 * The fixture with every time moved so generatedAtMs is `at`.
 *
 * @param {number} at - New generatedAtMs.
 * @returns {object}
 */
function shifted(at) {
  const d = at - FIXTURE_T0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === '_comment') continue;
        if (/AtMs$|^asOfMs$|^atMs$/.test(k) && Number.isFinite(x)) o[k] = x + d;
        else if (/^(resetsAt|asOf|generatedAt)$/.test(k) && typeof x === 'string') o[k] = new Date(Date.parse(x) + d).toISOString();
        else o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  return walk(JSON.parse(JSON.stringify(FIXTURE)));
}

/**
 * A stub Glass /v1 API with Glass's request rules (api.rs:1-26).
 *
 * @returns {Promise<object>}
 */
function startGlass() {
  // One fixed clock for the whole run, as a real Glass keeps its log times.
  const base = shifted(Date.now());
  const st = {
    token: TOKEN_A,
    base,
    payload: () => base,
    recommend: {},
    loginPhase: 'waitingForBrowser',
    flows: new Map(),
    seen: [],
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      st.seen.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin || null, auth: req.headers.authorization || null, body });
      const send = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.origin) return send(403, { error: 'WEB_ORIGIN_REFUSED' });
      if (req.headers.host !== '127.0.0.1:' + st.port) return send(403, { error: 'BAD_HOST' });
      if (req.headers.authorization !== 'Bearer ' + st.token) return send(401, { error: 'UNAUTHORIZED' });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/v1/status') { st.lastPayload = st.payload(); return send(200, st.lastPayload); }
      if (req.method === 'GET' && u.pathname === '/v1/recommend') {
        const p = u.searchParams.get('provider');
        return send(200, st.recommend[p] || { provider: p, best: null, reason: 'No other account is usable', runnersUp: [], current: null });
      }
      if (req.method === 'POST' && u.pathname === '/v1/refresh') return send(200, { ok: true, message: 'Refreshing usage' });
      if (req.method === 'POST' && u.pathname === '/v1/login') {
        const b = JSON.parse(body || '{}');
        for (const f of st.flows.values()) if (f.provider === b.provider && !f.done) return send(409, { error: 'LOGIN_IN_PROGRESS', message: 'Another Claude sign-in is running', flowId: f.flowId });
        const flowId = 'f_' + (st.flows.size + 1);
        st.flows.set(flowId, { flowId, provider: b.provider, done: false });
        return send(200, { flowId, message: 'Finish signing in in the browser window that opened' });
      }
      if (req.method === 'GET' && u.pathname.startsWith('/v1/login/')) {
        const f = st.flows.get(decodeURIComponent(u.pathname.slice('/v1/login/'.length)));
        if (!f) return send(404, { error: 'NOT_FOUND' });
        const done = st.loginPhase === 'done';
        if (done) f.done = true;
        return send(200, { flowId: f.flowId, provider: f.provider, phase: st.loginPhase, message: done ? 'Signed in as sam.reed' : 'Finish signing in to sam.reed in your browser', warning: false, updatedAtMs: Date.now(), done });
      }
      return send(404, { error: 'NOT_FOUND' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    st.port = server.address().port;
    st.server = server;
    resolve(st);
  }));
}

/**
 * Write api.json as Glass does at every start.
 *
 * @param {number} port - Port.
 * @param {string} token - Bearer.
 */
function writeApiFile(port, token) {
  fs.writeFileSync(path.join(glassDir, 'api.json'), JSON.stringify({ port, token, pid: 4242, startedAtMs: Date.now(), version: '0.4.0' }));
}

/**
 * Write state.json with a given generatedAtMs.
 *
 * @param {number} at - generatedAtMs.
 */
function writeStateFile(at) {
  const p = JSON.parse(JSON.stringify(glass.base));
  p.generatedAtMs = at;
  p.generatedAt = new Date(at).toISOString();
  fs.writeFileSync(path.join(glassDir, 'state.json'), JSON.stringify(p));
}

let glass;
let env;

kit.test('a sandbox data folder never reaches the real Quota folder', async () => {
  kit.eq(quotaDir({ CWM_DATA_DIR: process.env.CWM_DATA_DIR }), null, 'isolated data folder, no CWM_GLASS_DIR');
  kit.eq(quotaDir({ CWM_DATA_DIR: process.env.CWM_DATA_DIR, CWM_GLASS_DIR: glassDir }), path.resolve(glassDir));
  kit.ok(quotaDir({}) !== null, 'the default data folder uses the real Quota folder');
});

kit.test('boot with a stub Glass API and its api.json', async () => {
  glass = await startGlass();
  writeApiFile(glass.port, TOKEN_A);
  glass.recommend.claude = { provider: 'claude', best: { id: 'acc-claude-work', email: 'morgan.hale@example.com', label: 'Work', plan: 'Max 5x', state: 'ok', active: false, worstPercent: 41, headroom: 59, latestResetMs: null, latestResetAt: null }, reason: 'Work has 59% headroom; Personal is at 80%', runnersUp: [], current: null };
  // The Codex active account is critical: a recommendation that names the active account itself is ignored.
  glass.recommend.codex = { provider: 'codex', best: { id: 'acct_morgan', email: 'morgan.hale@example.com', label: null, plan: 'Pro', state: 'ok', active: true, worstPercent: 96, headroom: 4, latestResetMs: null, latestResetAt: null }, reason: 'same', runnersUp: [], current: null };
  env = await kit.bootWorkspace({ workspace: { env: Object.assign({}, process.env, { CWM_GLASS_DIR: glassDir }) } });
  await kit.until(() => glass.seen.some((s) => s.url === '/v1/status'), 5000, 'the first Glass status read');
});

kit.test('GET /accounts maps Glass /v1/status field for field', async () => {
  const r = await env.api('GET', '/accounts');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'accounts/accounts-response.json');
  const snap = r.body.accounts;
  kit.eq([snap.source, snap.swapsEnabled, snap.swapsDisabledReason, snap.stalledSinceAtMs], ['glass', true, null, null]);
  kit.eq(snap.glass.apiAvailable, true);
  kit.eq(snap.providers.map((p) => p.provider), ['claude', 'codex']);
  const claude = snap.providers[0];
  kit.eq(claude.swapEffect, 'Running Claude Code sessions follow within about a second.');
  kit.eq(snap.providers[1].swapEffect, 'New Codex processes use it; running ones keep the old account until restarted.');
  kit.eq(claude.activeAccountId, 'acc-claude-personal');
  kit.eq(claude.accounts[0].accountId, 'acc-claude-personal', 'active first');
  const src = glass.lastPayload.accounts[0];
  const a = claude.accounts[0];
  kit.ok(Number.isFinite(a.lastActiveAtMs), 'the active account is active now');
  const expected = {
    provider: 'claude',
    accountId: src.id,
    email: src.email,
    label: 'Personal',
    displayName: 'Personal',
    plan: 'Max 20x',
    active: true,
    state: 'ok',
    stateDetail: null,
    staleReason: null,
    windows: src.windows.map((w, i) => ({ key: w.key, label: w.label, percent: w.percent, resetsAtMs: w.resetsAtMs, windowSeconds: w.windowSeconds, severity: w.severity, ring: ['outer', 'inner', 'none'][i] })),
    asOfMs: src.asOfMs,
    dataSource: 'statusline',
    reloginInDays: null,
    headroom: 20,
    swappable: true,
    chip: 'usable',
    lastActiveAtMs: a.lastActiveAtMs,
  };
  kit.eq(a, expected);
  const byId = (id) => snap.providers.flatMap((p) => p.accounts).find((x) => x.accountId === id);
  const blocked = byId('acc-claude-blocked');
  kit.eq([blocked.state, blocked.chip, blocked.swappable, blocked.displayName, blocked.stateDetail, blocked.headroom], ['blocked', 'blocked', false, 'robin.ash', 'This organization does not allow OAuth sign-ins', null]);
  const login = byId('acc-claude-login');
  kit.eq([login.state, login.staleReason, login.chip, login.swappable], ['stale', 'tokenExpired', 'signIn', true]);
  kit.eq(byId('acc-claude-work').reloginInDays, 12);
  const codex = snap.providers[1];
  kit.eq(codex.accounts.map((x) => x.accountId), ['acct_morgan', 'acct_alt']);
  kit.eq(codex.accounts[0].windows.map((w) => [w.label, w.ring, w.severity]), [['Weekly', 'single', 'critical']]);
  kit.eq(codex.accounts[1].displayName, 'alt');
});

kit.test('the Glass client keeps a loopback Host, no Origin, and the bearer from api.json', async () => {
  kit.ok(glass.seen.length > 0, 'Glass was called');
  for (const s of glass.seen) {
    kit.eq(s.host, '127.0.0.1:' + glass.port, 'Host is loopback');
    kit.eq(s.origin, null, 'no Origin header');
  }
  // Glass restarts: a new token in api.json; the next call gets 401, re-reads api.json and retries once.
  glass.token = TOKEN_B;
  writeApiFile(glass.port, TOKEN_B);
  const before = glass.seen.length;
  const snap = await env.ws.internals.accounts.rebuild('refresh');
  kit.eq(snap.source, 'glass');
  const calls = glass.seen.slice(before).filter((s) => s.url === '/v1/status');
  kit.eq(calls.map((s) => s.auth), ['Bearer ' + TOKEN_A, 'Bearer ' + TOKEN_B], 'one 401, then the new token');
  kit.eq(snap.glass.apiAvailable, true);
});

kit.test('a recommendation appears only at warn or worse and never names the active account', async () => {
  const snap = await env.ws.internals.accounts.rebuild('other');
  const claude = snap.providers.find((p) => p.provider === 'claude');
  kit.eq(claude.recommendation, { accountId: 'acc-claude-work', displayName: 'Work', reason: 'Work has 59% headroom; Personal is at 80%' });
  kit.eq(snap.providers.find((p) => p.provider === 'codex').recommendation, null, 'Glass named the active account');
  // Below warn: no recommendation even when Glass has one.
  const calm = JSON.parse(JSON.stringify(glass.base));
  calm.accounts[0].windows[1].percent = 50;
  calm.accounts[0].windows[1].severity = 'normal';
  glass.payload = () => calm;
  const snap2 = await env.ws.internals.accounts.rebuild('other');
  kit.eq(snap2.providers[0].recommendation, null);
  glass.payload = () => glass.base;
});

kit.test('services pass through read only, and service swaps stay out of the swap log', async () => {
  const snap = await env.ws.internals.accounts.rebuild('other');
  kit.eq(snap.services.summary, '5 parked · 3 warnings');
  kit.eq(snap.services.slots.length, 1);
  const slot = snap.services.slots[0];
  kit.eq([slot.slotId, slot.name, slot.percent, slot.severity, slot.detail], ['mac-claude-1', 'Mac Claude', 55, 'normal', 'Healthy']);
  kit.ok(snap.swapLog.every((e) => e.accountId !== 'b'), 'the slot swap is not a PC swap');
  const agent = snap.swapLog.find((e) => e.source === 'agent');
  kit.eq([agent.provider, agent.accountId, agent.accountLabel, agent.requester, agent.reason, agent.ok], ['claude', 'acc-claude-personal', 'Personal', 'claude-code', 'weekly limit', true]);
  kit.ok(snap.swapLog[0].atMs >= snap.swapLog[1].atMs, 'newest first');
});

kit.test('a new agent swap in the Glass log sends a swap push and an AGENT_SWAP notice', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  const pushesBefore = env.pushEvents.length;
  const next = JSON.parse(JSON.stringify(glass.base));
  next.swapLog.unshift({ atMs: Date.now(), source: 'agent', requester: 'codex-cli', reason: 'limit reached', provider: 'codex', from: 'morgan.hale@example.com', to: 'alt', ok: true, message: 'Switched Codex to alt.', fromId: 'acct_morgan', toId: 'acct_alt' });
  glass.payload = () => next;
  await env.ws.internals.accounts.rebuild('other');
  const pushes = env.pushEvents.slice(pushesBefore).filter((e) => e.kind === 'swap');
  kit.eq(pushes, [{ kind: 'swap', provider: 'codex', accountId: 'acct_alt', accountDisplayName: 'alt', agent: 'codex-cli', reason: 'limit reached' }]);
  const notice = await s.next((f) => f.type === 'computer.notice' && f.data.notice.code === 'AGENT_SWAP', 3000);
  kit.validateFrame(notice);
  kit.eq(notice.data.notice.message, 'Switched Codex to alt by codex-cli: limit reached');
  // The same log again: nothing new.
  await env.ws.internals.accounts.rebuild('other');
  kit.eq(env.pushEvents.slice(pushesBefore).filter((e) => e.kind === 'swap').length, 1);
  glass.payload = () => glass.base;
  s.close();
});

kit.test('a monitor only Glass (the Mac) pauses swaps with the protocol sentence (F30)', async () => {
  const mac = JSON.parse(JSON.stringify(glass.base));
  mac.swapsEnabled = false;
  mac.swapsDisabledReason = 'This Mac is monitor-only. Account switching and sign-in are disabled until a credential owner is enabled.';
  glass.payload = () => mac;
  const snap = await env.ws.internals.accounts.rebuild('other');
  kit.eq([snap.swapsEnabled, snap.swapsDisabledReason], [false, 'Swaps are not available on this computer.']);
  // Any other Glass reason is passed through verbatim.
  mac.swapsDisabledReason = 'Claude Code keeps its login in Windows Credential Manager on this PC, so Claude swaps are off';
  const snap2 = await env.ws.internals.accounts.rebuild('other');
  kit.eq(snap2.swapsDisabledReason, mac.swapsDisabledReason);
  glass.payload = () => glass.base;
  await env.ws.internals.accounts.rebuild('other');
});

kit.test('GET /computer reports capabilities.glassApi', async () => {
  const r = await env.api('GET', '/computer');
  kit.eq(r.status, 200);
  kit.eq(r.body.capabilities.glassApi, true);
});

kit.test('POST /accounts/refresh goes through Glass /v1/refresh', async () => {
  const before = glass.seen.length;
  const r = await env.api('POST', '/accounts/refresh', { provider: 'claude' });
  kit.eq(r.status, 202, JSON.stringify(r.body));
  kit.validate(r.body, 'accounts/refresh-result.json');
  kit.eq(r.body, { ok: true, message: 'Refreshing usage.' });
  const call = glass.seen.slice(before).find((s) => s.url === '/v1/refresh');
  kit.ok(call && JSON.parse(call.body).provider === 'claude', 'Glass asked to refresh Claude');
  const bad = await env.api('POST', '/accounts/refresh', { provider: 'gemini' });
  kit.eq([bad.status, bad.body.code, bad.body.field], [400, 'INVALID_FIELD', 'provider']);
});

kit.test('sign in: a LoginFlow, LOGIN_IN_PROGRESS with the running flow, polling, no cancel', async () => {
  const r = await env.api('POST', '/accounts/login', { clientRequestId: '11111111-1111-4111-8111-111111111111', provider: 'claude', accountId: 'acc-claude-login' });
  kit.eq(r.status, 202, JSON.stringify(r.body));
  kit.validate(r.body, 'accounts/login-flow.json');
  kit.eq([r.body.provider, r.body.phase, r.body.done], ['claude', 'waitingForBrowser', false]);
  const call = glass.seen.find((s) => s.url === '/v1/login');
  kit.eq(JSON.parse(call.body), { provider: 'claude', email: 'sam.reed@example.com' }, 'the re-login names the account email');
  const again = await env.api('POST', '/accounts/login', { clientRequestId: '22222222-2222-4222-8222-222222222222', provider: 'claude', accountId: null });
  kit.eq([again.status, again.body.code, again.body.flowId], [409, 'LOGIN_IN_PROGRESS', r.body.flowId]);
  kit.validate(again.body, 'common/error.json');
  const repeat = await env.api('POST', '/accounts/login', { clientRequestId: '11111111-1111-4111-8111-111111111111', provider: 'claude', accountId: 'acc-claude-login' });
  kit.eq([repeat.status, repeat.body.flowId], [202, r.body.flowId], 'a repeated clientRequestId returns the first result');
  const st = await env.api('GET', '/accounts/login/' + r.body.flowId);
  kit.eq(st.status, 200);
  kit.validate(st.body, 'accounts/login-flow.json');
  kit.ok(/on /.test(st.body.message) && /\.$/.test(st.body.message), 'the waiting line names the computer: ' + st.body.message);
  const cancel = await env.api('POST', '/accounts/login/' + r.body.flowId + '/cancel');
  kit.eq([cancel.status, cancel.body.code], [409, 'LOGIN_CANCEL_UNSUPPORTED']);
  kit.ok(/to cancel\.$/.test(cancel.body.error), cancel.body.error);
  glass.loginPhase = 'done';
  const fin = await env.api('GET', '/accounts/login/' + r.body.flowId);
  kit.eq([fin.body.phase, fin.body.done, fin.body.message], ['done', true, 'Signed in as sam.reed.']);
  const late = await env.api('POST', '/accounts/login/' + r.body.flowId + '/cancel');
  kit.eq([late.status, late.body.code], [409, 'LOGIN_TOO_LATE']);
  const unknown = await env.api('GET', '/accounts/login/f_nope');
  kit.eq([unknown.status, unknown.body.code], [404, 'LOGIN_FLOW_NOT_FOUND']);
  // Glass itself runs a Codex sign in this phone does not know: 409 with Glass's flow id.
  glass.flows.set('f_glass', { flowId: 'f_glass', provider: 'codex', done: false });
  const cx = await env.api('POST', '/accounts/login', { clientRequestId: '33333333-3333-4333-8333-333333333333', provider: 'codex', accountId: null });
  kit.eq([cx.status, cx.body.code, cx.body.flowId], [409, 'LOGIN_IN_PROGRESS', 'f_glass']);
});

kit.test('state.json is the fallback when the API is down, with its age and the stall line', async () => {
  const old = Date.now() - STALLED_AGE_MS;
  writeStateFile(old);
  await new Promise((r) => glass.server.close(r));
  const snap = await env.ws.internals.accounts.rebuild('other');
  kit.eq(snap.source, 'glass');
  kit.ok(Number.isFinite(snap.glass.stateFileAgeMs) && snap.glass.stateFileAgeMs >= 0, 'state.json age');
  kit.eq(snap.stalledSinceAtMs, old, 'no updates since generatedAtMs');
  kit.eq(snap.providers[0].accounts[0].accountId, 'acc-claude-personal');
  const r = await env.api('GET', '/accounts');
  kit.validate(r.body, 'accounts/accounts-response.json');
});

kit.test('a state.json change publishes accounts.updated, throttled', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  s.send({ type: 'subscribe', id: 'a1', epoch: null, topics: [{ topic: 'accounts', sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const fresh = JSON.parse(JSON.stringify(glass.base));
  fresh.generatedAtMs = Date.now();
  fresh.accounts[4].windows[0].percent = 97;
  fs.writeFileSync(path.join(glassDir, 'state.json'), JSON.stringify(fresh));
  await env.ws.internals.accounts.rebuild('refresh');
  const ev = await s.next((f) => f.type === 'accounts.updated', 6000);
  kit.validateFrame(ev);
  const cx = ev.data.accounts.providers.find((p) => p.provider === 'codex');
  kit.eq(cx.accounts[0].windows[0].percent, 97);
  kit.ok(['refresh', 'other'].includes(ev.data.reason), ev.data.reason);
  s.close();
});

kit.test('without Glass, sign in answers 503 GLASS_UNAVAILABLE', async () => {
  fs.rmSync(path.join(glassDir, 'api.json'), { force: true });
  const r = await env.api('POST', '/accounts/login', { clientRequestId: '44444444-4444-4444-8444-444444444444', provider: 'codex', accountId: null });
  // The Codex flow Glass reported is still known to this Workbook only when the phone started it; this one was Glass's own.
  kit.eq([r.status, r.body.code], [503, 'GLASS_UNAVAILABLE']);
  kit.ok(/^Sign in from Myrlin Glass on .+\.$/.test(r.body.error), r.body.error);
  kit.ok(r.headers['retry-after'] !== undefined, 'every 503 carries Retry-After');
});

kit.run(async () => {
  if (env) await env.close();
  try { if (glass && glass.server.listening) glass.server.close(); } catch (_) { /* closed */ }
});
