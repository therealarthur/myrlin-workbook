/**
 * b1-listener.test.js: the mobile listener's rules (PROTOCOL.md 1.1, 1.4,
 * 1.5, 2.1) over a real socket.
 *
 * WHY (BUILD-CONTRACT 3.5.2): off by default; CWM_MOBILE_ENABLED=1 starts
 * it; turning it off closes stream sockets with 1012; loopback bind only; an
 * Origin header is refused; bodies over 1 MiB answer 413; every response
 * carries X-Myrlin-Api; the log never holds a query string; http:// public
 * URLs only for loopback; Tailscale Serve detection; the identity key
 * survives a damaged file through its backup (F24).
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const signing = require('../../src/web/mobile/signing');
const { createEndpoints } = require('../../src/web/mobile/endpoints');
const { loadIdentity } = require('../../src/web/mobile/identity');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let h;

/** Run fn with environment overrides, restoring them after. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

t('with default settings the listener does not run', async () => {
  h = await H.startSandbox({ enabled: false });
  const st = h.rt.listener.status();
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.port, null);
  assert.strictEqual(h.rt.getSettings().enabled, false);
  await h.stop();
});

t('CWM_MOBILE_ENABLED=1 starts it; CWM_MOBILE_DISABLED=1 wins over it', async () => {
  await withEnv({ CWM_MOBILE_ENABLED: '1' }, async () => {
    h = await H.startSandbox({ enabled: false });
    assert.strictEqual(h.rt.listener.status().running, true);
    await h.stop();
    await withEnv({ CWM_MOBILE_DISABLED: '1' }, async () => {
      h = await H.startSandbox({ enabled: true });
      assert.strictEqual(h.rt.listener.status().running, false);
      await h.stop();
    });
  });
});

t('a non loopback CWM_MOBILE_HOST leaves the listener stopped with listener.error set', async () => {
  await withEnv({ CWM_MOBILE_HOST: '0.0.0.0' }, async () => {
    h = await H.startSandbox({ enabled: true });
    const st = h.rt.listener.status();
    assert.strictEqual(st.running, false);
    assert.match(st.error, /127\.0\.0\.1/);
    assert.ok(h.logs.some((l) => /CWM_MOBILE_HOST must be/.test(l)));
    await h.stop();
  });
});

t('CWM_MOBILE_PUBLIC_URLS drops http:// entries that are not loopback', async () => {
  await withEnv({ CWM_MOBILE_PUBLIC_URLS: 'https://box.example.com,http://192.168.1.5:3458,http://localhost:3458' }, async () => {
    h = await H.startSandbox({ enabled: true, settings: { advertiseLoopback: false } });
    const urls = h.rt.endpoints.list().map((e) => e.url);
    assert.deepStrictEqual(urls, ['https://box.example.com', 'http://localhost:3458']);
    assert.ok(h.rt.getSettings().envErrors.length === 1);
    await h.stop();
  });
});

t('Origin is refused, unknown paths 404, 405, 413, and every response carries X-Myrlin-Api', async () => {
  h = await H.startSandbox();
  const n = signing.randomNonce();
  let r = await h.request('GET', '/api/m/v2/identity?nonce=' + n, { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'WEB_ORIGIN_REFUSED');
  assert.strictEqual(r.headers['x-myrlin-api'], '2.0');
  r = await h.request('GET', '/index.html');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.headers['x-myrlin-api'], '2.0');
  r = await h.request('GET', '/ws/m/v2');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'SUBPROTOCOL_REQUIRED');
  r = await h.request('PUT', '/api/m/v2/identity');
  assert.strictEqual(r.status, 405);
  const big = Buffer.alloc(1024 * 1024 + 10, 0x20);
  r = await h.request('POST', '/api/m/v2/hello', { rawBody: big, headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.body.code, 'BODY_TOO_LARGE');
  assert.strictEqual(r.headers['x-myrlin-api'], '2.0');
  r = await h.request('GET', '/api/m/v2/identity?nonce=' + n);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-myrlin-api'], '2.0');
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined, 'no CORS headers');
  assert.strictEqual(r.headers['set-cookie'], undefined, 'no cookies');
});

t('the request log holds method and path only, never a query string', async () => {
  const secret = signing.randomNonce();
  await h.request('GET', '/api/m/v2/identity?nonce=' + secret);
  await h.request('GET', '/api/m/v2/devices/me?token=' + secret);
  const mine = h.logs.filter((l) => l.includes('/api/m/v2/'));
  assert.ok(mine.length >= 2);
  for (const l of mine) {
    assert.ok(!l.includes('?'), 'query string in log: ' + l);
    assert.ok(!l.includes(secret), 'secret in log: ' + l);
  }
});

t('minClientBuild answers 426 APP_TOO_OLD to an older build', async () => {
  const s = Object.assign({}, h.store.settings.mobile, { minClientBuild: 5 });
  h.store.updateSettings({ mobile: s });
  const old = await h.request('GET', '/api/m/v2/identity?nonce=' + signing.randomNonce(), { headers: { 'X-Myrlin-Client': 'Myrlin-iOS/1.0.0 (4)' } });
  assert.strictEqual(old.status, 426);
  assert.strictEqual(old.body.code, 'APP_TOO_OLD');
  const ok = await h.request('GET', '/api/m/v2/identity?nonce=' + signing.randomNonce(), { headers: { 'X-Myrlin-Client': 'Myrlin-iOS/1.0.0 (5)' } });
  assert.strictEqual(ok.status, 200);
  h.store.updateSettings({ mobile: Object.assign({}, s, { minClientBuild: null }) });
  await h.stop();
});

t('stream: no token 401, no hub 404, Origin 403; turning the listener off closes sockets with 1012', async () => {
  const hub = H.stubHub();
  h = await H.startSandbox({ hub });
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  const token = (await H.openSession(h, dev)).sessionToken;
  await assert.rejects(H.openStream(h, null), (e) => e.status === 401 && e.body.code === 'AUTH_REQUIRED');
  await assert.rejects(H.openStream(h, token, { Origin: 'https://evil.example' }), (e) => e.status === 403 && e.body.code === 'WEB_ORIGIN_REFUSED');
  const s = await H.openStream(h, token);
  assert.ok(hub.isDeviceConnected(dev.deviceId));
  h.store.updateSettings({ mobile: Object.assign({}, h.store.settings.mobile, { enabled: false }) });
  await h.mobile.restartListener();
  const closed = await s.closed;
  assert.strictEqual(closed.code, 1012);
  assert.ok(hub.calls.some((c) => c.fn === 'closeAll' && c.code === 1012));
  assert.strictEqual(h.rt.listener.status().running, false);
  h.store.updateSettings({ mobile: Object.assign({}, h.store.settings.mobile, { enabled: true }) });
  const st = await h.mobile.restartListener();
  assert.strictEqual(st.running, true);
  const again = await H.openStream(h, token);
  again.ws.close();
  delete h.ctx.mobile.hub;
  await assert.rejects(H.openStream(h, token), (e) => e.status === 404);
  await h.stop();
});

t('Tailscale detection advertises https://<DNSName> only when Serve proxies to the mobile port', async () => {
  const port = 3458;
  const settings = { detectTailscale: true, port, publicUrls: [], advertiseLoopback: false };
  const status = { Self: { DNSName: 'studio-1.tailnet-example.ts.net.' } };
  let serve = { Web: { 'studio-1.tailnet-example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + port } } } } };
  const ep = createEndpoints({ getSettings: () => settings, runCli: async (args) => (args[0] === 'status' ? status : serve) });
  await ep.refresh();
  assert.deepStrictEqual(ep.list(), [{ url: 'https://studio-1.tailnet-example.ts.net', kind: 'tailscale', priority: 0 }]);
  assert.strictEqual(ep.tailscaleName(), 'studio-1.tailnet-example.ts.net');
  serve = { Web: { 'x:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3457' } } } } };
  await ep.refresh();
  assert.deepStrictEqual(ep.list(), [], 'Serve on 3457 is never advertised');
  const failing = createEndpoints({ getSettings: () => settings, runCli: async () => { throw Object.assign(new Error('no cli'), { code: 'ENOENT' }); } });
  await failing.refresh();
  assert.deepStrictEqual(failing.list(), []);
});

t('the identity key restores from identity.backup.json and is replaced only when both files fail', () => {
  const dir = path.join(H.sandbox.dir, 'identity-case');
  fs.mkdirSync(path.join(dir, 'mobile'), { recursive: true });
  const logs = [];
  const a = loadIdentity({ dataDir: dir, log: (m) => logs.push(m) });
  assert.strictEqual(a.source, 'created');
  assert.ok(fs.existsSync(path.join(dir, 'mobile', 'identity.backup.json')));
  const again = loadIdentity({ dataDir: dir });
  assert.strictEqual(again.computerId, a.computerId);
  fs.writeFileSync(path.join(dir, 'mobile', 'identity.json'), '{"v":1,"privateKeyPkcs8":"broken"}');
  const restored = loadIdentity({ dataDir: dir, log: (m) => logs.push(m) });
  assert.strictEqual(restored.source, 'restored');
  assert.strictEqual(restored.computerId, a.computerId);
  const sig = restored.sign('revoked', { computerId: a.computerId, deviceId: 'd_AAAAAAAAAAAAAAAAAAAA', clientNonce: signing.randomNonce(), revokedAtMs: 1 });
  assert.strictEqual(sig.length, 86);
  fs.writeFileSync(path.join(dir, 'mobile', 'devices.json'), JSON.stringify({ v: 1, devices: [{ deviceId: 'd_x' }], tombstones: [] }));
  fs.unlinkSync(path.join(dir, 'mobile', 'identity.json'));
  fs.writeFileSync(path.join(dir, 'mobile', 'identity.backup.json'), 'garbage');
  const replaced = loadIdentity({ dataDir: dir, log: (m) => logs.push(m) });
  assert.strictEqual(replaced.source, 'replaced');
  assert.notStrictEqual(replaced.computerId, a.computerId);
  assert.ok(logs.some((l) => /NEW computer identity/.test(l)));
});

H.run('b1-listener', tests);
