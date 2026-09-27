/**
 * b1-scope.test.js: the route to scope table (PROTOCOL.md 2.10, critic F3).
 *
 * WHY (BUILD-CONTRACT 3.5.2): the set of routes registered on the mobile
 * listener (B2 and B3 by their route lists when they are not mounted) equals
 * scope-table.js, scope-table.js equals the hand transcription in
 * fixtures/route-table.json, every non public route answers 401 without a
 * token and 403 SCOPE_REQUIRED for a device without the scope, and a desktop
 * token gets 401 on every mobile route.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const path = require('path');
const table = require('../../src/web/mobile/scope-table');
const { createRouter } = require('../../src/web/mobile/router');
const desktopAuth = require('../../src/web/auth');

const fixture = require(path.join(__dirname, 'fixtures', 'route-table.json'));
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/** Normalize a route for comparison. */
const key = (r) => [r.method, r.path, r.scope, r.limiter, r.upgrade === true].join(' ');

/** Fill path params with plausible values. */
function concrete(p) {
  return table.API_PREFIX + p
    .replace(':sessionId', 'cl_733b51a7-b861-4e1c-98b2-5af241fede0f')
    .replace(':messageId', 'm1').replace(':partIndex', '0')
    .replace(':clientMessageId', '00000000-0000-4000-8000-000000000000')
    .replace(':promptId', 'p_AAAAAAAAAAAAAAAAAAAA')
    .replace(':projectId', 'unassigned').replace(':folderId', 'g1')
    .replace(':provider', 'claude').replace(':uploadId', 'u_AAAAAAAAAAAAAAAAAAAAAA')
    .replace(':flowId', 'f1').replace(':accountId', 'a1')
    .replace(':migrationId', 'mg_AAAAAAAAAAAAAAAAAAAAAA').replace(':turnNumber', '1')
    .replace(':activityId', 'act1').replace(':pairId', 'pr_AAAAAAAAAAAAAAAAAAAAAA');
}

let h;

t('scope-table.js equals the hand transcription of PROTOCOL.md 2.10', () => {
  assert.strictEqual(fixture.routes.length, fixture.count);
  const a = table.ROUTES.map(key).sort();
  const b = fixture.routes.map(key).sort();
  assert.deepStrictEqual(a, b);
  assert.strictEqual(new Set(a).size, a.length, 'no duplicate routes');
});

t('the registered routes equal the table (tracks not mounted counted by their route lists)', async () => {
  h = await H.startSandbox();
  const registered = new Set(h.rt.router.registered().map((r) => r.method + ' ' + r.path));
  const rest = table.ROUTES.filter((r) => !r.upgrade);
  for (const r of rest) {
    const k = r.method + ' ' + r.path;
    const ownerMounted = r.owner === 'B1' || (r.owner === 'B2' && h.rt.mounted.chat) || (r.owner === 'B3' && h.rt.mounted.workspace);
    if (ownerMounted) assert.ok(registered.has(k), 'missing handler for ' + k);
    else assert.ok(!registered.has(k), k + ' registered although its track is not mounted');
  }
  for (const k of registered) assert.ok(rest.some((r) => r.method + ' ' + r.path === k), 'registered route outside the table: ' + k);
  const b1 = rest.filter((r) => r.owner === 'B1').map((r) => r.method + ' ' + r.path).sort();
  assert.deepStrictEqual(b1, Array.from(registered).filter((k) => b1.includes(k)).sort());
});

t('registering a route outside the table, or twice, throws at startup', () => {
  const router = createRouter({ auth: {}, limiters: {}, getSettings: () => ({}) });
  assert.throws(() => router.route('GET', '/api/update', () => {}), /not in scope-table/);
  assert.throws(() => router.route('POST', '/computer', () => {}), /not in scope-table/);
  router.route('GET', '/computer', () => {});
  assert.throws(() => router.route('GET', '/computer', () => {}), /registered twice/);
  assert.throws(() => router.route('GET', '/ws/m/v2', () => {}), /not in scope-table|stream upgrade/);
});

t('every non public route answers 401 AUTH_REQUIRED without a token', async () => {
  for (const r of table.ROUTES.filter((x) => x.scope !== 'public' && !x.upgrade)) {
    const res = await h.request(r.method, concrete(r.path), { body: r.method === 'GET' ? undefined : {} });
    assert.strictEqual(res.status, 401, r.method + ' ' + r.path + ' answered ' + res.status);
    assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    assert.strictEqual(res.headers['x-myrlin-api'], '2.0');
  }
});

t('every scoped route answers 403 SCOPE_REQUIRED (with the scope) for a device without it', async () => {
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev, { scopes: [] });
  const token = (await H.openSession(h, dev)).sessionToken;
  for (const r of table.ROUTES.filter((x) => x.scope !== 'public' && x.scope !== 'none' && !x.upgrade)) {
    const res = await h.request(r.method, concrete(r.path), { token, body: r.method === 'GET' ? undefined : {} });
    assert.strictEqual(res.status, 403, r.method + ' ' + r.path + ' answered ' + res.status + ' ' + res.text);
    assert.strictEqual(res.body.code, 'SCOPE_REQUIRED');
    assert.strictEqual(res.body.scope, r.scope);
  }
  // Routes with scope none work for any authenticated device.
  const me = await h.request('GET', '/api/m/v2/devices/me', { token });
  assert.strictEqual(me.status, 200);
  const c = await h.request('GET', '/api/m/v2/computer', { token });
  assert.strictEqual(c.status, 200);
});

t('a device with the scope passes the scope check (unmounted routes answer 404, never 401 or 403)', async () => {
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  const token = (await H.openSession(h, dev)).sessionToken;
  for (const r of table.ROUTES.filter((x) => x.scope !== 'public' && x.scope !== 'none' && !x.upgrade && x.owner !== 'B1')) {
    const res = await h.request(r.method, concrete(r.path), { token, body: r.method === 'GET' ? undefined : {} });
    assert.ok(res.status !== 401 && res.status !== 403, r.method + ' ' + r.path + ' answered ' + res.status);
  }
});

t('a desktop token (activeTokens) gets 401 on every mobile route and on the stream', async () => {
  const desktopToken = desktopAuth.generateToken();
  desktopAuth.addToken(desktopToken);
  assert.ok(desktopAuth.isValidToken(desktopToken));
  for (const r of table.ROUTES.filter((x) => x.scope !== 'public' && !x.upgrade)) {
    const res = await h.request(r.method, concrete(r.path), { token: desktopToken, body: r.method === 'GET' ? undefined : {} });
    assert.strictEqual(res.status, 401, r.method + ' ' + r.path);
  }
  await assert.rejects(H.openStream(h, desktopToken), (e) => e.status === 401);
  desktopAuth.removeToken(desktopToken);
});

t('unknown paths answer 404 NOT_FOUND and wrong methods 405 METHOD_NOT_ALLOWED', async () => {
  let r = await h.request('GET', '/api/m/v2/nope');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'NOT_FOUND');
  r = await h.request('GET', '/api/update');
  assert.strictEqual(r.status, 404);
  r = await h.request('GET', '/');
  assert.strictEqual(r.status, 404);
  r = await h.request('DELETE', '/api/m/v2/identity');
  assert.strictEqual(r.status, 405);
  assert.strictEqual(r.body.code, 'METHOD_NOT_ALLOWED');
  assert.ok(/GET/.test(r.headers.allow));
  await h.stop();
});

H.run('b1-scope', tests);
