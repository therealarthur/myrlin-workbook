/**
 * b1-session.test.js: hello, session and the in memory session tokens
 * (PROTOCOL.md 2.8, 2.9), plus the /devices/me routes (4.3) and /browse.
 *
 * WHY: every connection proves the device key over a fresh server nonce; the
 * token lives 15 minutes in memory, rides only in the Authorization header,
 * at most 4 per device; a race of hellos over 5 endpoints must still let a
 * session through (8 outstanding nonces).
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const signing = require('../../src/web/mobile/signing');
const { createChecker } = require('./_schema-check');

const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

let h;
let clock;
let dev;

/** Hello for a device; returns the response. */
function hello(d, clientNonce) {
  return h.request('POST', '/api/m/v2/hello', { body: { deviceId: d.deviceId, clientNonce: clientNonce || signing.randomNonce() } });
}

/** A signed session request body. */
function sessionBody(d, helloBody, clientNonce, over) {
  const b = Object.assign({ computerId: helloBody.computerId, deviceId: d.deviceId, serverNonce: helloBody.serverNonce, clientNonce, ts: clock.now() }, over || {});
  b.sig = (over && over.signer ? over.signer : d).sign('session-request', b);
  delete b.signer;
  return b;
}

t('setup: sandbox and a paired device', async () => {
  clock = H.fakeClock(Date.now());
  h = await H.startSandbox({ clock });
  dev = H.softwareDevice();
  await H.pairDevice(h, dev);
});

t('hello is signed by K_c over its fields and the endpoint urls', async () => {
  const n = signing.randomNonce();
  const r = await hello(dev, n);
  assert.strictEqual(r.status, 200);
  schema.assertValid('handshake/hello-response.json', r.body);
  assert.strictEqual(r.body.clientNonce, n);
  assert.strictEqual(r.body.streamEpoch, h.rt.getStreamEpoch());
  const fields = Object.assign({}, r.body, { endpoints: r.body.endpoints.map((e) => e.url) });
  assert.ok(signing.verify(h.rt.identity.publicKey, 'hello-response', fields, r.body.sig));
});

t('session mints a 15 minute token; the nonce is single use (replay answers NONCE_INVALID)', async () => {
  const cn = signing.randomNonce();
  const hb = (await hello(dev, cn)).body;
  const body = sessionBody(dev, hb, cn);
  const s = await h.request('POST', '/api/m/v2/session', { body });
  assert.strictEqual(s.status, 200, s.text);
  schema.assertValid('handshake/session-response.json', s.body);
  assert.strictEqual(s.body.expiresInMs, 900000);
  assert.strictEqual(s.body.expiresAtMs, clock.now() + 900000);
  const replay = await h.request('POST', '/api/m/v2/session', { body });
  assert.strictEqual(replay.status, 401);
  assert.strictEqual(replay.body.code, 'NONCE_INVALID');
});

t('a race of hellos over 5 endpoints then a session on the first succeeds', async () => {
  const cns = Array.from({ length: 5 }, () => signing.randomNonce());
  const hellos = await Promise.all(cns.map((cn) => hello(dev, cn)));
  const s = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hellos[0].body, cns[0]) });
  assert.strictEqual(s.status, 200, s.text);
});

t('a ninth outstanding hello drops the oldest nonce', async () => {
  const cns = Array.from({ length: 9 }, () => signing.randomNonce());
  const hellos = [];
  for (const cn of cns) hellos.push((await hello(dev, cn)).body);
  const first = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hellos[0], cns[0]) });
  assert.strictEqual(first.body.code, 'NONCE_INVALID');
  const last = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hellos[8], cns[8]) });
  assert.strictEqual(last.status, 200);
});

t('a nonce older than 60 s, or a different clientNonce, answers NONCE_INVALID', async () => {
  let cn = signing.randomNonce();
  let hb = (await hello(dev, cn)).body;
  clock.advance(61 * 1000);
  let r = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hb, cn) });
  assert.strictEqual(r.body.code, 'NONCE_INVALID');
  cn = signing.randomNonce();
  hb = (await hello(dev, cn)).body;
  r = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hb, signing.randomNonce()) });
  assert.strictEqual(r.body.code, 'NONCE_INVALID');
});

t('session errors: WRONG_COMPUTER, DEVICE_UNKNOWN, INVALID_SIGNATURE_ENCODING, SIGNATURE_INVALID, ts bound', async () => {
  let cn = signing.randomNonce();
  let hb = (await hello(dev, cn)).body;
  let r = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hb, cn, { computerId: 'c_AAAAAAAAAAAAAAAAAAAA' }) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'WRONG_COMPUTER');
  const stranger = H.softwareDevice();
  r = await hello(stranger);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'DEVICE_UNKNOWN');
  r = await h.request('POST', '/api/m/v2/session', { body: sessionBody(stranger, hb, cn) });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'DEVICE_UNKNOWN');
  const bad = sessionBody(dev, hb, cn);
  bad.sig = bad.sig.slice(0, 80);
  r = await h.request('POST', '/api/m/v2/session', { body: bad });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_SIGNATURE_ENCODING');
  r = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hb, cn, { signer: stranger }) });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.code, 'SIGNATURE_INVALID');
  cn = signing.randomNonce();
  hb = (await hello(dev, cn)).body;
  r = await h.request('POST', '/api/m/v2/session', { body: sessionBody(dev, hb, cn, { ts: clock.now() - 25 * 3600 * 1000 }) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.field, 'ts');
});

t('tokens: header only, SESSION_EXPIRED after 15 minutes, AUTH_REQUIRED when unknown, at most 4 live', async () => {
  const s = await H.openSession(h, dev);
  const ok = await h.request('GET', '/api/m/v2/devices/me', { token: s.sessionToken });
  assert.strictEqual(ok.status, 200);
  schema.assertValid('resources/device.json', ok.body);
  const q = await h.request('GET', '/api/m/v2/devices/me?token=' + s.sessionToken);
  assert.strictEqual(q.status, 401);
  assert.strictEqual(q.body.code, 'AUTH_REQUIRED');
  const none = await h.request('GET', '/api/m/v2/devices/me');
  assert.strictEqual(none.body.code, 'AUTH_REQUIRED');
  const unknown = await h.request('GET', '/api/m/v2/devices/me', { token: signing.randomNonce() });
  assert.strictEqual(unknown.body.code, 'AUTH_REQUIRED');
  clock.advance(15 * 60 * 1000);
  const expired = await h.request('GET', '/api/m/v2/devices/me', { token: s.sessionToken });
  assert.strictEqual(expired.status, 401);
  assert.strictEqual(expired.body.code, 'SESSION_EXPIRED');
  const tokens = [];
  for (let i = 0; i < 5; i += 1) tokens.push((await H.openSession(h, dev)).sessionToken);
  assert.strictEqual(h.rt.auth.liveTokenCount(dev.deviceId), 4);
  const oldest = await h.request('GET', '/api/m/v2/devices/me', { token: tokens[0] });
  assert.strictEqual(oldest.body.code, 'AUTH_REQUIRED');
  const newest = await h.request('GET', '/api/m/v2/devices/me', { token: tokens[4] });
  assert.strictEqual(newest.status, 200);
});

t('ten signature failures in ten minutes block the session route (429) and write an audit line', async () => {
  const victim = H.softwareDevice();
  await H.pairDevice(h, victim);
  const thief = H.softwareDevice();
  let last;
  for (let i = 0; i < 10; i += 1) {
    const cn = signing.randomNonce();
    const hb = (await hello(victim, cn)).body;
    last = await h.request('POST', '/api/m/v2/session', { body: sessionBody(victim, hb, cn, { signer: thief }) });
    assert.strictEqual(last.body.code, 'SIGNATURE_INVALID');
  }
  const cn = signing.randomNonce();
  const hb = (await hello(victim, cn)).body;
  const blocked = await h.request('POST', '/api/m/v2/session', { body: sessionBody(victim, hb, cn) });
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.body.retryAfterMs > 0);
  assert.ok(h.rt.audit.read(victim.deviceId, 10).some((e) => e.action === 'sessionSignatureFailed'));
  clock.advance(10 * 60 * 1000 + 1);
  const cn2 = signing.randomNonce();
  const hb2 = (await hello(victim, cn2)).body;
  const after = await h.request('POST', '/api/m/v2/session', { body: sessionBody(victim, hb2, cn2) });
  assert.strictEqual(after.status, 200, 'the block lifts after 10 minutes');
});

t('/devices/me: rename, preferences nested merge, push registration, Live Activity tokens', async () => {
  const s = (await H.openSession(h, dev)).sessionToken;
  let r = await h.request('PATCH', '/api/m/v2/devices/me', { token: s, body: { name: 'Work phone' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, 'Work phone');
  r = await h.request('PATCH', '/api/m/v2/devices/me', { token: s, body: { name: 'two\nlines' } });
  assert.strictEqual(r.body.field, 'name');
  r = await h.request('GET', '/api/m/v2/devices/me/preferences', { token: s });
  schema.assertValid('resources/preferences.json', r.body);
  assert.strictEqual(r.body.notifications.finishedMinMinutes, 2);
  r = await h.request('PATCH', '/api/m/v2/devices/me/preferences', { token: s, body: { privacy: { hideSessionNames: true }, notifications: { finishedMinMinutes: 5 } } });
  assert.strictEqual(r.status, 200);
  schema.assertValid('resources/preferences.json', r.body);
  assert.strictEqual(r.body.privacy.hideSessionNames, true);
  assert.strictEqual(r.body.privacy.showMessageText, false);
  assert.strictEqual(r.body.notifications.question, true);
  r = await h.request('PATCH', '/api/m/v2/devices/me/preferences', { token: s, body: { privacy: { hideSessionNames: null } } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_FIELD');
  const reg = { apnsToken: 'a'.repeat(64), environment: 'sandbox', bundleId: 'io.myrlin.workbook', liveActivityPushToStartToken: 'b'.repeat(64), widgetPushToken: null };
  schema.assertValid('resources/push-registration.json', reg);
  r = await h.request('PUT', '/api/m/v2/devices/me/push', { token: s, body: reg });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.push.registered, true);
  assert.strictEqual(r.body.push.environment, 'sandbox');
  for (let i = 0; i < 5; i += 1) {
    r = await h.request('PUT', '/api/m/v2/devices/me/live-activities/act-' + i, { token: s, body: { pushToken: 'c'.repeat(64), startedAtMs: clock.now() } });
    assert.strictEqual(r.status, 204);
    clock.advance(1);
  }
  r = await h.request('GET', '/api/m/v2/devices/me', { token: s });
  assert.strictEqual(r.body.push.liveActivityTokens, 4, 'at most 4, the oldest dropped');
  r = await h.request('DELETE', '/api/m/v2/devices/me/live-activities/act-4', { token: s });
  assert.strictEqual(r.status, 204);
  r = await h.request('DELETE', '/api/m/v2/devices/me/push', { token: s });
  assert.strictEqual(r.body.push.registered, false);
  assert.strictEqual(r.body.push.liveActivityTokens, 0);
  r = await h.request('PUT', '/api/m/v2/devices/me/push', { token: s, body: Object.assign({}, reg, { bundleId: 'io.other.app' }) });
  assert.strictEqual(r.body.field, 'bundleId');
});

t('/browse lists directories, and a scope edit applies at once to the next request', async () => {
  const s = (await H.openSession(h, dev)).sessionToken;
  const r = await h.request('GET', '/api/m/v2/browse?path=' + encodeURIComponent(H.FIXTURE_HOME), { token: s });
  assert.strictEqual(r.status, 200, r.text);
  schema.assertValid('resources/browse.json', r.body);
  assert.ok(r.body.entries.some((e) => e.name === '.claude'));
  const missing = await h.request('GET', '/api/m/v2/browse?path=' + encodeURIComponent(H.FIXTURE_HOME + '/nope'), { token: s });
  assert.strictEqual(missing.body.code, 'PATH_NOT_FOUND');
  const evil = await h.request('GET', '/api/m/v2/browse?path=' + encodeURIComponent('C:/x;rm'), { token: s });
  assert.strictEqual(evil.body.code, 'PATH_NOT_ALLOWED');
  h.rt.devices.setScopes(dev.deviceId, ['chat']);
  const denied = await h.request('GET', '/api/m/v2/browse', { token: s });
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.body.code, 'SCOPE_REQUIRED');
  assert.strictEqual(denied.body.scope, 'sessions.manage');
  await h.stop();
});

H.run('b1-session', tests);
