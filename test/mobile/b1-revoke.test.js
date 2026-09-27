/**
 * b1-revoke.test.js: revocation and every effect of PROTOCOL.md 2.11.
 *
 * WHY (BUILD-CONTRACT 3.5.2): revocation closes the device's stream sockets
 * with 4401 (a stub hub stands in for B2), drops its tokens (an old token
 * answers 401 DEVICE_REVOKED, an unknown one AUTH_REQUIRED), writes the
 * tombstone, deletes push tokens, tells onRevoked and onTokenRevoked
 * listeners, writes an audit line, broadcasts mobile:devices-changed, and
 * hello then answers 403 with a body whose signature verifies with K_c.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const signing = require('../../src/web/mobile/signing');
const { createChecker } = require('./_schema-check');

const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let h;
let hub;

t('desktop revoke: sockets 4401, tokens DEVICE_REVOKED, tombstone, push cleared, signed verdict', async () => {
  hub = H.stubHub();
  h = await H.startSandbox({ hub });
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  const token = (await H.openSession(h, dev)).sessionToken;
  await h.request('PUT', '/api/m/v2/devices/me/push', { token, body: { apnsToken: 'a'.repeat(64), environment: 'production', bundleId: 'io.myrlin.workbook', liveActivityPushToStartToken: null, widgetPushToken: null } });
  const s1 = await H.openStream(h, token);
  const s2 = await H.openStream(h, token);
  const revokedSeen = [];
  const tokenRevokedSeen = [];
  h.ctx.mobile.devices.onRevoked((id) => revokedSeen.push(id));
  h.ctx.mobile.auth.onTokenRevoked((id) => tokenRevokedSeen.push(id));

  h.rt.revokeDevice(dev.deviceId, 'desktop');

  for (const s of [s1, s2]) {
    const c = await s.closed;
    assert.strictEqual(c.code, 4401);
    assert.strictEqual(c.reason, 'DEVICE_REVOKED');
  }
  assert.deepStrictEqual(revokedSeen, [dev.deviceId]);
  assert.deepStrictEqual(tokenRevokedSeen, [dev.deviceId]);
  const old = await h.request('GET', '/api/m/v2/devices/me', { token });
  assert.strictEqual(old.status, 401);
  assert.strictEqual(old.body.code, 'DEVICE_REVOKED');
  const unknown = await h.request('GET', '/api/m/v2/devices/me', { token: signing.randomNonce() });
  assert.strictEqual(unknown.body.code, 'AUTH_REQUIRED');
  await assert.rejects(H.openStream(h, token), (e) => e.status === 401 && e.body.code === 'DEVICE_REVOKED');

  const doc = JSON.parse(fs.readFileSync(h.rt.devices.file, 'utf8'));
  assert.ok(!doc.devices.some((d) => d.deviceId === dev.deviceId), 'record removed');
  assert.ok(doc.tombstones.some((x) => x.deviceId === dev.deviceId), 'tombstone written');
  assert.ok(!JSON.stringify(doc).includes('a'.repeat(64)), 'push token deleted');

  const cn = signing.randomNonce();
  const hello = await h.request('POST', '/api/m/v2/hello', { body: { deviceId: dev.deviceId, clientNonce: cn } });
  assert.strictEqual(hello.status, 403);
  schema.assertValid('handshake/revoked.json', hello.body);
  assert.strictEqual(hello.body.clientNonce, cn);
  assert.ok(signing.verify(h.rt.identity.publicKey, 'revoked', hello.body, hello.body.sig), 'verdict signed by K_c');
  // A forged verdict (another key) would not verify with the pinned key.
  const forged = H.softwareDevice().sign('revoked', hello.body);
  assert.strictEqual(signing.verify(h.rt.identity.publicKey, 'revoked', hello.body, forged), false);

  const sess = { computerId: h.rt.identity.computerId, deviceId: dev.deviceId, serverNonce: signing.randomNonce(), clientNonce: cn, ts: Date.now() };
  sess.sig = dev.sign('session-request', sess);
  const sr = await h.request('POST', '/api/m/v2/session', { body: sess });
  assert.strictEqual(sr.status, 403);
  schema.assertValid('handshake/revoked.json', sr.body);

  assert.ok(h.rt.audit.read(dev.deviceId, 5).some((e) => e.action === 'revoke'));
  assert.ok(h.sse.some((e) => e.type === 'mobile:devices-changed'));
  assert.ok(hub.calls.some((c) => c.fn === 'closeDevice' && c.code === 4401 && c.deviceId === dev.deviceId));
});

t('the phone unpairs itself: DELETE /devices/me answers 204 with the same effects', async () => {
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  const token = (await H.openSession(h, dev)).sessionToken;
  const s = await H.openStream(h, token);
  const r = await h.request('DELETE', '/api/m/v2/devices/me', { token });
  assert.strictEqual(r.status, 204);
  assert.strictEqual((await s.closed).code, 4401);
  const after = await h.request('GET', '/api/m/v2/devices/me', { token });
  assert.strictEqual(after.body.code, 'DEVICE_REVOKED');
  assert.ok(h.rt.devices.tombstoneFor(dev.deviceId));
});

t('re-pairing after revocation is a normal pair with a new key; other devices are unaffected', async () => {
  const keep = H.softwareDevice();
  await H.pairDevice(h, keep);
  const keepToken = (await H.openSession(h, keep)).sessionToken;
  const gone = H.softwareDevice();
  await H.pairDevice(h, gone);
  h.rt.revokeDevice(gone.deviceId, 'desktop');
  const ok = await h.request('GET', '/api/m/v2/devices/me', { token: keepToken });
  assert.strictEqual(ok.status, 200);
  const fresh = H.softwareDevice();
  await H.pairDevice(h, fresh);
  assert.strictEqual((await h.request('GET', '/api/m/v2/devices/me', { token: (await H.openSession(h, fresh)).sessionToken })).status, 200);
  await h.stop();
});

H.run('b1-revoke', tests);
