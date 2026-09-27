/**
 * b1-main-server-isolation.test.js: a phone session token has no power on
 * the main Workbook server (critic F3, PROTOCOL.md 1.1).
 *
 * WHY (BUILD-CONTRACT 3.5.2): the obvious way to make legacy routes work for
 * the phone is to add its token to activeTokens, which would hand it the
 * desktop's full privilege, including /ws/terminal (a shell) and
 * POST /api/update. This proves a phone token gets 401 on /ws/terminal,
 * POST /api/update, GET /api/keys/anthropic, GET /api/pty, GET /api/workspaces,
 * GET /api/mobile-admin/status and the SSE stream, and never enters
 * activeTokens. It also enumerates the main app's router, so the guarantee
 * holds as routes are added: every requireAuth route answers a phone token
 * 401 with requireAuth's own body, the only unguarded routes are the known
 * public ones (each checked with a phone token), and the schedule routes that
 * startServer mounts later are guarded the same way.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const desktopAuth = require('../../src/web/auth');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let h;
let main;
let phoneToken;

/**
 * The main app's routes without requireAuth at d70df18, by design. Each one is
 * checked below with a phone token; a new public route fails the enumeration
 * test until someone checks it and adds it here.
 */
const PUBLIC_ROUTES = [
  'GET /api/health',
  'GET /api/server-info',
  'GET /api/events',
  'POST /api/auth/login',
  'POST /api/auth/token-login',
  'POST /api/auth/logout',
  'GET /api/auth/check',
  'POST /api/auth/pair',
];
/**
 * d70df18 registers 181 requireAuth routes on the main app; a count far below
 * that means the router enumeration itself broke, not that routes vanished.
 */
const MIN_GUARDED_ROUTES = 150;
/** requireAuth's own 401 body fields (auth.js:237-242, kept by PROTOCOL.md 11). */
const REQUIRE_AUTH_ERROR = 'UNAUTHORIZED';
const REQUIRE_AUTH_CODE = 401;

/**
 * Every (method, path) an Express app routes, with whether requireAuth guards it.
 *
 * @param {object} app - Express app.
 * @returns {Array<{method: string, path: string, guarded: boolean}>}
 */
function routesOf(app) {
  const out = [];
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    const guarded = layer.route.stack.some((l) => l.handle === desktopAuth.requireAuth);
    for (const m of Object.keys(layer.route.methods)) {
      out.push({ method: m === '_all' ? 'GET' : m.toUpperCase(), path: layer.route.path, guarded });
    }
  }
  return out;
}

/** A concrete path for a route pattern (every :param becomes "x"). */
const concretePath = (p) => String(p).replace(/:([A-Za-z0-9_]+)/g, 'x');

/** Whether a method carries a JSON body in these probes. */
const hasBody = (method) => method === 'POST' || method === 'PUT' || method === 'PATCH';

/** Try a /ws/terminal upgrade and resolve with the HTTP status. */
function terminalUpgrade(port, query, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/terminal?' + query, { headers: headers || {} });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
    ws.on('error', () => resolve(-1));
  });
}

t('setup: a paired phone with a live session token, and the main app with its PTY socket', async () => {
  h = await H.startSandbox();
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  phoneToken = (await H.openSession(h, dev)).sessionToken;
  main = await H.startMainApp({ pty: true });
  const ok = await h.request('GET', '/api/m/v2/devices/me', { token: phoneToken });
  assert.strictEqual(ok.status, 200, 'the token works on the mobile listener');
});

t('the phone token never enters activeTokens', () => {
  assert.strictEqual(desktopAuth.isValidToken(phoneToken), false);
});

for (const [method, p] of [
  ['POST', '/api/update'],
  ['GET', '/api/keys/anthropic'],
  ['GET', '/api/pty'],
  ['GET', '/api/workspaces'],
  ['GET', '/api/mobile-admin/status'],
  ['GET', '/api/mobile-admin/devices'],
  ['POST', '/api/mobile-admin/pair-offers'],
  ['GET', '/api/mobile/sync'],
  ['GET', '/api/devices'],
]) {
  t('phone token gets 401 on ' + method + ' ' + p, async () => {
    const r = await main.request(method, p, { token: phoneToken, body: method === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 401, method + ' ' + p + ' answered ' + r.status);
  });
}

t('phone token gets 401 on the /ws/terminal upgrade (query and header forms)', async () => {
  assert.strictEqual(await terminalUpgrade(main.port, 'token=' + phoneToken + '&sessionId=x'), 401);
  assert.strictEqual(await terminalUpgrade(main.port, 'sessionId=x', { Authorization: 'Bearer ' + phoneToken }), 401);
});

t('phone token gets 401 on the SSE stream /api/events', async () => {
  const r = await main.request('GET', '/api/events?token=' + phoneToken);
  assert.strictEqual(r.status, 401);
});

t('the main app has no public route beyond the known, checked ones (enumerated from its router)', () => {
  // routesOf reads only the top level stack, so a nested router (app.use(path,
  // router)) would hide its routes from every check below. None exists at
  // d70df18; a new one fails here until the enumeration walks into it.
  const nested = main.app.router.stack.filter((l) => !l.route && l.handle && Array.isArray(l.handle.stack));
  assert.deepStrictEqual(nested.map((l) => l.name), [], 'a nested router on the main app');
  const routes = routesOf(main.app);
  const open = routes.filter((r) => !r.guarded).map((r) => r.method + ' ' + r.path).sort();
  assert.deepStrictEqual(open, PUBLIC_ROUTES.slice().sort());
  for (const r of routes) assert.strictEqual(typeof r.path, 'string', 'a route with a non string path cannot be probed: ' + r.path);
});

t('every requireAuth route of the main app answers a phone token 401 with requireAuth\'s own body', async () => {
  const guarded = routesOf(main.app).filter((r) => r.guarded);
  assert.ok(guarded.length >= MIN_GUARDED_ROUTES, 'only ' + guarded.length + ' guarded routes found');
  const wrong = [];
  for (const r of guarded) {
    const res = await main.request(r.method, concretePath(r.path), { token: phoneToken, body: hasBody(r.method) ? {} : undefined });
    const ok = res.status === 401 && res.body && res.body.error === REQUIRE_AUTH_ERROR && res.body.code === REQUIRE_AUTH_CODE;
    if (!ok) wrong.push(r.method + ' ' + r.path + ' answered ' + res.status + ' ' + res.text.slice(0, 80));
  }
  assert.deepStrictEqual(wrong, []);
});

t('the public routes give a phone token nothing', async () => {
  const bearer = { Authorization: 'Bearer ' + phoneToken };
  let r = await main.request('GET', '/api/auth/check', { headers: bearer });
  assert.deepStrictEqual(r.body, { authenticated: false });
  r = await main.request('POST', '/api/auth/login', { body: { password: phoneToken } });
  assert.ok(r.status === 401 || r.status === 403, 'login with a phone token as the password answered ' + r.status);
  assert.ok(!r.body || !r.body.token);
  r = await main.request('POST', '/api/auth/token-login', { body: { token: phoneToken } });
  assert.strictEqual(r.status, 403);
  assert.ok(!r.body || !r.body.token);
  r = await main.request('POST', '/api/auth/pair', { headers: bearer, body: {} });
  assert.strictEqual(r.status, 410);
  assert.strictEqual(r.body.code, 'LEGACY_PAIR_DISABLED');
  r = await main.request('GET', '/api/events', { headers: bearer });
  assert.strictEqual(r.status, 401);
  for (const p of ['/api/health', '/api/server-info']) {
    const withToken = await main.request('GET', p, { headers: bearer });
    const without = await main.request('GET', p);
    assert.strictEqual(withToken.status, without.status, p);
    assert.deepStrictEqual(Object.keys(withToken.body || {}).sort(), Object.keys(without.body || {}).sort(), p + ' answers a phone token exactly as it answers nobody');
  }
  // Desktop logout touches only activeTokens: the phone session is a separate set.
  r = await main.request('POST', '/api/auth/logout', { headers: bearer });
  assert.strictEqual(r.status, 200);
  const still = await h.request('GET', '/api/m/v2/devices/me', { token: phoneToken });
  assert.strictEqual(still.status, 200);
  assert.strictEqual(desktopAuth.isValidToken(phoneToken), false);
});

t('the schedule routes startServer mounts require desktop auth too, and never reach their handlers', async () => {
  const express = require('express');
  const { mountScheduleRoutes } = require('../../src/web/scheduler-routes');
  const touched = [];
  const trap = new Proxy({}, { get(_, prop) { touched.push(String(prop)); throw new Error('a schedule handler ran for a phone token'); } });
  const app = express();
  app.use(express.json());
  mountScheduleRoutes(app, { requireAuth: desktopAuth.requireAuth, scheduler: trap, store: trap });
  const routes = routesOf(app);
  assert.ok(routes.length > 0);
  assert.deepStrictEqual(routes.filter((r) => !r.guarded), []);
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    for (const r of routes) {
      const res = await H.request(server.address().port, r.method, concretePath(r.path), { token: phoneToken, body: hasBody(r.method) ? {} : undefined });
      assert.strictEqual(res.status, 401, r.method + ' ' + r.path);
      assert.strictEqual(res.body.error, REQUIRE_AUTH_ERROR);
    }
  } finally {
    await new Promise((res) => server.close(() => res()));
  }
  assert.deepStrictEqual(touched, []);
});

t('a desktop login token works on the main server but not on the mobile listener', async () => {
  const desktop = await main.login();
  const ok = await main.request('GET', '/api/mobile-admin/status', { token: desktop });
  assert.strictEqual(ok.status, 200);
  const no = await h.request('GET', '/api/m/v2/computer', { token: desktop });
  assert.strictEqual(no.status, 401);
  await main.close();
  await h.stop();
});

H.run('b1-main-server-isolation', tests);
