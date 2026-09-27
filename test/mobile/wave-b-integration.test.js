/**
 * wave-b-integration.test.js: the seams between B1 and B2 after the wave B
 * merge (BUILD-CONTRACT 2.1, 3.4.2, 3.4.3, 3.8).
 *
 * WHY: B1 and B2 were built in parallel against stubs of each other. Each
 * track's suites pass alone; this file proves the real parts meet: B1's
 * listener hands its authenticated upgrade to B2's hub, the hub reads B1's
 * token expiry (tokenExpiresAtMs), a listener restart closes the real hub's
 * sockets with 1012 and the hub keeps serving (hub.closeAll), stopMobile
 * sends WORKBOOK_SHUTTING_DOWN and closes 1001 (PROTOCOL.md 5.6), GET
 * /computer reports the chat track's capabilities (chat.capabilities is a
 * function), and B1's startMobile mounts the chat track itself.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const kit = require('./fakes/b2-kit');

kit.sandbox();
let env;
let mobile;

kit.test('B1 startMobile mounts the chat track on the real router', async () => {
  env = await kit.bootChat({ options: { screenModel: false } });
  mobile = require('../../src/web/mobile');
  kit.ok(env.b1.rt.mounted.chat, 'rt.mounted.chat');
  kit.ok(env.ctx.mobile.hub === env.chat.internals.hub, 'ctx.mobile.hub is the chat hub');
  kit.ok(env.b1.rt.getHub() === env.chat.internals.hub, 'B1 reaches the same hub');
  const registered = new Set(env.b1.rt.router.registered().map((r) => r.method + ' ' + r.path));
  for (const [m, p] of env.chat.routes) kit.ok(registered.has(m + ' ' + p), 'registered ' + m + ' ' + p);
});

kit.test('GET /computer reports the chat capabilities (a function on chat)', async () => {
  const r = await kit.api(env.base, 'GET', '/computer', null, env.device.token);
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(r.body.capabilities.codexLinker, true, 'codexLinker from chat.capabilities()');
  kit.eq(r.body.capabilities.screenModel, false, 'screenModel from chat.capabilities()');
  kit.validate(r.body, 'resources/computer.json');
});

kit.test('the hub takes the upgrade B1 authenticated and B1 token expiry', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  const fresh = env.b1.mintToken(env.device.deviceId);
  const expected = env.b1.rt.auth.authenticateToken(fresh).tokenExpiresAtMs;
  s.send({ type: 'auth', id: 'renew', token: fresh });
  const authed = await s.next((f) => f.topic === '$control' && f.type === 'authed');
  kit.eq(authed.data.expiresAtMs, expected, 'authed carries the expiry of the B1 token');
  s.close();
  await s.closed;
});

kit.test('a stream without a token is refused by B1 before the hub (401 AUTH_REQUIRED)', async () => {
  let refused = null;
  try { await kit.openStream(env.base, null); } catch (err) { refused = err; }
  kit.ok(refused && refused.status === 401, 'refused with 401');
  kit.eq(refused.body && refused.body.code, 'AUTH_REQUIRED');
});

kit.test('a listener restart closes the hub sockets with 1012 and the hub keeps serving', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  await mobile.restartListener();
  kit.eq((await s.closed).code, 1012);
  const base = 'http://127.0.0.1:' + env.b1.rt.listener.status().port;
  const again = await kit.openStream(base, env.device.token);
  await again.next((f) => f.type === 'ready');
  kit.ok(again.closeInfo() === null, 'a new socket is served after the restart');
  again.close();
  await again.closed;
  env.base = base;
});

kit.test('stopMobile (server shutdown) sends WORKBOOK_SHUTTING_DOWN, then closes 1001', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  await mobile.stopMobile();
  const info = await s.closed;
  kit.eq(info.code, 1001);
  const n = s.frames.find((f) => f.type === 'computer.notice' && f.data.notice.code === 'WORKBOOK_SHUTTING_DOWN');
  kit.ok(n, 'shutdown notice before the close');
  kit.validateFrame(n);
});

kit.run(async () => { if (env) await env.close(); });
