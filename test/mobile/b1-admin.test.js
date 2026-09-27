/**
 * b1-admin.test.js: /api/mobile-admin/* on the main server (PROTOCOL.md 11).
 *
 * WHY (BUILD-CONTRACT 3.5.2): status and settings (loopback only host,
 * https or loopback public URLs, turning the listener on and off, 409
 * LISTENER_OFF), pair offers, pending requests, Allow with pty.raw refused,
 * devices with scope edits, test push errors, the APNs key upload, audit
 * lines, and the main server SSE events the desktop page handles.
 */
'use strict';

const H = require('./_harness');
// Never bind 3458 on this PC: the listener takes an ephemeral port (P21 override).
process.env.CWM_MOBILE_PORT = '0';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const signing = require('../../src/web/mobile/signing');
const { createChecker } = require('./_schema-check');

const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let main;
let token;
let store;
let sseLines = [];
let sseReq = null;
const A = '/api/mobile-admin';

/** Admin call with the desktop token. */
const admin = (method, p, body) => main.request(method, A + p, { token, body });

/** Open the desktop SSE stream and collect its data lines. */
function openSse() {
  return new Promise((resolve) => {
    sseReq = http.get({ host: '127.0.0.1', port: main.port, path: '/api/events?token=' + token }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { sseLines.push(JSON.parse(line.slice(6))); } catch (_) { /* ignore */ } }
      });
      resolve();
    });
  });
}

/** Wait until the SSE stream carried an event of a type. */
async function sawEvent(type, pred) {
  for (let i = 0; i < 50; i += 1) {
    const e = sseLines.find((x) => x.type === type && (!pred || pred(x.data)));
    if (e) return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no SSE ' + type);
}

t('setup: main app, desktop login, SSE stream', async () => {
  main = await H.startMainApp();
  token = await main.login();
  store = require('../../src/state/store').getStore();
  H.seedSettings(store, { enabled: false, detectTailscale: false, advertiseLoopback: true, legacyPairEnabled: false, publicUrls: [], qrLinkStyle: 'scheme', apns: null });
  await openSse();
});

t('status: listener off by default; pair offers answer 409 LISTENER_OFF', async () => {
  const s = await admin('GET', '/status');
  assert.strictEqual(s.status, 200);
  schema.assertValid('admin/status.json', s.body);
  assert.strictEqual(s.body.listener.enabled, false);
  assert.strictEqual(s.body.listener.running, false);
  assert.strictEqual(s.body.push.configured, false);
  const o = await admin('POST', '/pair-offers');
  assert.strictEqual(o.status, 409);
  assert.strictEqual(o.body.code, 'LISTENER_OFF');
});

t('settings: host must be loopback, public URLs https or loopback http, port in range, style enum', async () => {
  for (const [body, field] of [
    [{ host: '0.0.0.0' }, 'host'],
    [{ host: '192.168.1.179' }, 'host'],
    [{ publicUrls: ['http://192.168.1.5:3458'] }, 'publicUrls'],
    [{ publicUrls: ['https://x.example.com/path'] }, 'publicUrls'],
    [{ port: 0 }, 'port'],
    [{ port: 70000 }, 'port'],
    [{ qrLinkStyle: 'qr' }, 'qrLinkStyle'],
    [{ enabled: 'yes' }, 'enabled'],
  ]) {
    const r = await admin('PUT', '/settings', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(r.body.code, 'INVALID_FIELD');
    assert.strictEqual(r.body.field, field);
  }
  const ok = await admin('PUT', '/settings', { publicUrls: ['https://studio-1.tailnet-example.ts.net', 'http://127.0.0.1:3458'], qrLinkStyle: 'universal' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body.endpoints.slice(0, 2).map((e) => e.kind), ['tailscale', 'loopback']);
  await admin('PUT', '/settings', { publicUrls: [], qrLinkStyle: 'scheme' });
});

t('turning the listener on answers the running status; a pair offer is created and withdrawn', async () => {
  const on = await admin('PUT', '/settings', { enabled: true });
  assert.strictEqual(on.status, 200);
  schema.assertValid('admin/status.json', on.body);
  assert.strictEqual(on.body.listener.running, true);
  assert.ok(on.body.listener.port > 0);
  const o = await admin('POST', '/pair-offers');
  assert.strictEqual(o.status, 201);
  schema.assertValid('admin/pair-offer.json', o.body);
  assert.ok(o.body.qrLink.startsWith('myrlin://pair#'));
  assert.ok(o.body.qrLink.length <= 300);
  const q = signing.parseQrLink(o.body.qrLink);
  assert.strictEqual(q.pk, on.body.identity.fingerprint);
  const w = await admin('DELETE', '/pair-offers/' + o.body.offerId);
  assert.strictEqual(w.status, 204);
});

let dev;
let pairId;

t('a pair request reaches the desktop SSE and GET /pair-requests; Allow refuses pty.raw and unknown scopes', async () => {
  const port = (await admin('GET', '/status')).body.listener.port;
  const o = (await admin('POST', '/pair-offers')).body;
  const q = signing.parseQrLink(o.qrLink);
  dev = H.softwareDevice('Sam’s iPhone');
  const r = await H.request(port, 'POST', '/api/m/v2/pair', { body: H.pairRequestBody(dev, { offerId: q.o, secret: q.s }) });
  assert.strictEqual(r.status, 202, r.text);
  pairId = r.body.pairId;
  const ev = await sawEvent('mobile:pair-request', (d) => d.pairId === pairId);
  schema.assertValid('admin/pair-request-summary.json', ev.data);
  const list = await admin('GET', '/pair-requests');
  schema.assertValid('admin/pair-requests.json', list.body);
  assert.ok(list.body.pending.some((p) => p.pairId === pairId));
  let a = await admin('POST', '/pair-requests/' + pairId + '/allow', { scopes: ['chat', 'pty.raw'], name: null });
  assert.strictEqual(a.status, 400);
  assert.strictEqual(a.body.code, 'INVALID_SCOPE');
  a = await admin('POST', '/pair-requests/' + pairId + '/allow', { scopes: ['chat', 'terminal'], name: null });
  assert.strictEqual(a.body.code, 'INVALID_SCOPE');
  a = await admin('POST', '/pair-requests/pr_AAAAAAAAAAAAAAAAAAAAAA/allow', { scopes: ['chat'], name: null });
  assert.strictEqual(a.status, 404);
  assert.strictEqual(a.body.code, 'PAIR_UNKNOWN');
});

t('Allow creates the device (AdminDevice), resolves the pair, and broadcasts both events', async () => {
  const body = { scopes: ['chat', 'sessions.manage', 'accounts.read', 'accounts.swap', 'media.upload', 'search'], name: null };
  schema.assertValid('admin/allow-request.json', body);
  const a = await admin('POST', '/pair-requests/' + pairId + '/allow', body);
  assert.strictEqual(a.status, 200, a.text);
  schema.assertValid('admin/admin-device.json', a.body.device);
  assert.strictEqual(a.body.device.deviceId, dev.deviceId);
  await sawEvent('mobile:pair-resolved', (d) => d.pairId === pairId && d.status === 'allowed');
  await sawEvent('mobile:devices-changed');
  const again = await admin('POST', '/pair-requests/' + pairId + '/allow', body);
  assert.strictEqual(again.status, 404);
});

t('devices: list, scope PATCH (pty.raw refused), audit, test push without a key', async () => {
  const l = await admin('GET', '/devices');
  schema.assertValid('admin/admin-devices.json', l.body);
  assert.strictEqual(l.body.devices.length, 1);
  let p = await admin('PATCH', '/devices/' + dev.deviceId, { scopes: ['chat', 'pty.raw'] });
  assert.strictEqual(p.status, 400);
  assert.strictEqual(p.body.code, 'INVALID_SCOPE');
  assert.ok(!store.settings.mobile.apns);
  p = await admin('PATCH', '/devices/' + dev.deviceId, { scopes: ['chat', 'search'], name: 'Desk phone' });
  assert.strictEqual(p.status, 200);
  schema.assertValid('admin/admin-device.json', p.body);
  assert.deepStrictEqual(p.body.scopes, ['chat', 'search']);
  assert.strictEqual(p.body.name, 'Desk phone');
  const audit = await admin('GET', '/devices/' + dev.deviceId + '/audit?limit=10');
  schema.assertValid('admin/audit.json', audit.body);
  assert.deepStrictEqual(audit.body.entries.map((e) => e.action), ['scopeChange', 'pair']);
  const tp = await admin('POST', '/devices/' + dev.deviceId + '/test-push');
  assert.strictEqual(tp.status, 503);
  assert.strictEqual(tp.body.code, 'PUSH_NOT_CONFIGURED');
  const unknown = await admin('PATCH', '/devices/d_AAAAAAAAAAAAAAAAAAAA', { name: 'x' });
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(unknown.body.code, 'DEVICE_UNKNOWN');
});

t('APNs key: invalid key 400, valid key stored 0600 and never returned, test push 409 without registration, DELETE', async () => {
  const bad = await admin('PUT', '/apns', { teamId: 'A1B2C3D4E5', keyId: 'ABC123DEFG', p8: 'x'.repeat(200), bundleId: 'io.myrlin.workbook' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.code, 'INVALID_APNS_KEY');
  const badId = await admin('PUT', '/apns', { teamId: 'short', keyId: 'ABC123DEFG', p8: 'x'.repeat(200) });
  assert.strictEqual(badId.body.field, 'teamId');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const body = { teamId: 'A1B2C3D4E5', keyId: 'ABC123DEFG', p8: privateKey, bundleId: 'io.myrlin.workbook' };
  schema.assertValid('admin/apns-config.json', body);
  const ok = await admin('PUT', '/apns', body);
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.body.push.configured, true);
  assert.strictEqual(ok.body.push.keyId, 'ABC123DEFG');
  assert.ok(!ok.text.includes('PRIVATE KEY'), 'the key never comes back');
  const keyFile = store.settings.mobile.apns.keyFile;
  assert.ok(fs.existsSync(keyFile));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  const sync = await main.request('GET', '/api/mobile/sync', { token });
  assert.strictEqual(sync.body.settings.mobile.apns, '[redacted]');
  const tp = await admin('POST', '/devices/' + dev.deviceId + '/test-push');
  assert.strictEqual(tp.status, 409);
  assert.strictEqual(tp.body.code, 'PUSH_NOT_REGISTERED');
  const del = await admin('DELETE', '/apns');
  assert.strictEqual(del.status, 204);
  assert.ok(!fs.existsSync(keyFile));
  assert.strictEqual((await admin('GET', '/status')).body.push.configured, false);
});

t('deny answers 204; revoke answers 204 and broadcasts; turning off answers LISTENER_OFF again', async () => {
  const port = (await admin('GET', '/status')).body.listener.port;
  const o = (await admin('POST', '/pair-offers')).body;
  const q = signing.parseQrLink(o.qrLink);
  const r = await H.request(port, 'POST', '/api/m/v2/pair', { body: H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s }) });
  const d = await admin('POST', '/pair-requests/' + r.body.pairId + '/deny');
  assert.strictEqual(d.status, 204);
  await sawEvent('mobile:pair-resolved', (x) => x.pairId === r.body.pairId && x.status === 'denied');
  const rv = await admin('DELETE', '/devices/' + dev.deviceId);
  assert.strictEqual(rv.status, 204);
  assert.strictEqual((await admin('GET', '/devices')).body.devices.length, 0);
  const off = await admin('PUT', '/settings', { enabled: false });
  assert.strictEqual(off.body.listener.running, false);
  assert.strictEqual((await admin('POST', '/pair-offers')).body.code, 'LISTENER_OFF');
  if (sseReq) sseReq.destroy();
  await require('../../src/web/mobile').stopMobile();
  await main.close();
});

H.run('b1-admin', tests);
