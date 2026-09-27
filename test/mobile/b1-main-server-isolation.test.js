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
 * activeTokens.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const WebSocket = require('ws');
const desktopAuth = require('../../src/web/auth');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let h;
let main;
let phoneToken;

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
