/**
 * b1-pairing.test.js: the whole pairing sequence of PROTOCOL.md 2.4 over a
 * real sandbox listener, and every failure path of step 3.
 *
 * WHY (BUILD-CONTRACT 3.5.2): offer, identity, pair, challenge (signature
 * checked with the pinned key), Allow, the long poll answered with a signed
 * pair response, hello, session and an authenticated GET /computer; the
 * fifth wrong secret burns the offer; a used offer answers 410; replay and
 * expiry of the one time secret; a wrong key; the manual code.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const crypto = require('crypto');
const signing = require('../../src/web/mobile/signing');
const { createChecker } = require('./_schema-check');

const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ALL = ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage'];

let h;
let clock;

/** Fresh sandbox per test group. */
async function fresh() {
  if (h) await h.stop();
  clock = H.fakeClock(Date.now());
  h = await H.startSandbox({ clock });
  return h;
}

/** A new offer and its parsed QR fields. */
function offer() {
  const o = h.rt.pairing.createOffer();
  return { o, q: signing.parseQrLink(o.qrLink) };
}

/** POST /pair. */
function pair(body) {
  return h.request('POST', '/api/m/v2/pair', { body });
}

t('full pair: identity, pair, challenge, Allow, long poll, hello, session, GET /computer', async () => {
  await fresh();
  const { o, q } = offer();
  schema.assertValid('admin/pair-offer.json', o);
  assert.ok(o.qrLink.length <= 300);
  assert.strictEqual(q.v, '2');
  assert.strictEqual(q.o, o.offerId);

  // Step 2: identity signed with K_c, fingerprint equals the QR pk.
  const nonce = signing.randomNonce();
  const id = await h.request('GET', '/api/m/v2/identity?nonce=' + nonce);
  assert.strictEqual(id.status, 200);
  assert.strictEqual(id.headers['x-myrlin-api'], '2.0');
  assert.strictEqual(id.headers['cache-control'], 'no-store');
  schema.assertValid('handshake/identity-response.json', id.body);
  assert.strictEqual(id.body.clientNonce, nonce);
  assert.strictEqual(signing.fingerprint(id.body.computerPublicKey), q.pk);
  assert.strictEqual(signing.computerIdFromSpki(id.body.computerPublicKey), id.body.computerId);
  assert.ok(signing.verify(id.body.computerPublicKey, 'identity', id.body, id.body.sig));
  const pinned = id.body.computerPublicKey;

  // Step 3: pair.
  const dev = H.softwareDevice('Sam’s iPhone');
  const body = H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() });
  schema.assertValid('handshake/pair-request.json', body);
  const ch = await pair(body);
  assert.strictEqual(ch.status, 202, ch.text);
  schema.assertValid('handshake/pair-challenge.json', ch.body);
  assert.ok(signing.verify(pinned, 'pair-challenge', ch.body, ch.body.sig), 'challenge signature');
  assert.strictEqual(ch.body.devicePublicKey, dev.publicKey);
  assert.strictEqual(ch.body.deviceNonce, body.deviceNonce);

  // The desktop hears about it with the same match code the phone computes.
  const ev = h.sse.find((e) => e.type === 'mobile:pair-request');
  assert.ok(ev, 'SSE mobile:pair-request');
  schema.assertValid('admin/pair-request-summary.json', ev.data);
  for (const banned of ['id', 'workspaceId', 'workspace']) assert.ok(!(banned in ev.data));
  const phoneCode = signing.matchCode({ computerPublicKey: pinned, devicePublicKey: dev.publicKey, deviceNonce: body.deviceNonce, serverNonce: ch.body.serverNonce }).code;
  assert.strictEqual(ev.data.matchCode, phoneCode);
  assert.match(phoneCode, /^\d{4}$/);

  // Step 5: pending, then a long poll answered by the Allow.
  const pending = await h.request('GET', '/api/m/v2/pair/' + ch.body.pairId);
  schema.assertValid('handshake/pair-status.json', pending.body);
  assert.strictEqual(pending.body.status, 'pending');
  const poll = h.request('GET', '/api/m/v2/pair/' + ch.body.pairId + '?wait=5');
  await new Promise((r) => setTimeout(r, 100));
  h.rt.pairing.allow(ch.body.pairId, { scopes: ALL, name: null });
  const allowed = await poll;
  assert.strictEqual(allowed.status, 200);
  schema.assertValid('handshake/pair-status.json', allowed.body);
  assert.strictEqual(allowed.body.status, 'allowed');
  assert.strictEqual(allowed.body.deviceId, dev.deviceId);
  assert.strictEqual(allowed.body.deviceNonce, body.deviceNonce);
  assert.deepStrictEqual(allowed.body.scopes, ALL);
  const sigFields = Object.assign({}, allowed.body, { endpoints: allowed.body.endpoints.map((e) => e.url) });
  assert.ok(signing.verify(pinned, 'pair-response', sigFields, allowed.body.sig), 'pair response signature');
  assert.ok(h.sse.some((e) => e.type === 'mobile:pair-resolved' && e.data.status === 'allowed'));
  assert.ok(h.sse.some((e) => e.type === 'mobile:devices-changed'));

  // Section 2.8: hello, session, then a protected call.
  const s = await H.openSession(h, dev);
  schema.assertValid('handshake/session-response.json', s);
  const c = await h.request('GET', '/api/m/v2/computer', { token: s.sessionToken });
  assert.strictEqual(c.status, 200);
  schema.assertValid('resources/computer.json', c.body);
  assert.strictEqual(c.body.computerPublicKey, pinned);
  assert.ok(c.body.endpoints.some((e) => e.url === h.base), 'loopback endpoint advertises the bound port');
});

t('a used offer answers 410 PAIR_OFFER_USED (replay of the one time secret)', async () => {
  await fresh();
  const { q } = offer();
  const dev = H.softwareDevice();
  const body = H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() });
  assert.strictEqual((await pair(body)).status, 202);
  const replay = await pair(body);
  assert.strictEqual(replay.status, 410);
  assert.strictEqual(replay.body.code, 'PAIR_OFFER_USED');
  const other = H.softwareDevice();
  const r2 = await pair(H.pairRequestBody(other, { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(r2.body.code, 'PAIR_OFFER_USED');
});

t('an expired offer answers 410 PAIR_OFFER_EXPIRED', async () => {
  await fresh();
  const { q } = offer();
  clock.advance(5 * 60 * 1000 + 1);
  const r = await pair(H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(r.status, 410);
  assert.strictEqual(r.body.code, 'PAIR_OFFER_EXPIRED');
});

t('the fifth wrong secret burns the offer; the right secret then answers 410 PAIR_OFFER_BURNED', async () => {
  await fresh();
  const { q } = offer();
  const dev = H.softwareDevice();
  for (let i = 0; i < 5; i += 1) {
    const r = await pair(H.pairRequestBody(dev, { offerId: q.o, secret: signing.randomNonce(), ts: clock.now() }));
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'PAIR_SECRET_INVALID');
  }
  const r = await pair(H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(r.status, 410);
  assert.strictEqual(r.body.code, 'PAIR_OFFER_BURNED');
});

t('an unknown or withdrawn offer answers 403 PAIR_OFFER_UNKNOWN', async () => {
  await fresh();
  const r = await pair(H.pairRequestBody(H.softwareDevice(), { offerId: 'AAAAAAAA', secret: signing.randomNonce(), ts: clock.now() }));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'PAIR_OFFER_UNKNOWN');
  const { o, q } = offer();
  h.rt.pairing.withdrawOffer(o.offerId);
  const w = await pair(H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(w.body.code, 'PAIR_OFFER_UNKNOWN');
});

t('shape checks: INVALID_FIELD with field, DER signature INVALID_SIGNATURE_ENCODING, bad key INVALID_PUBLIC_KEY', async () => {
  await fresh();
  const { q } = offer();
  const dev = H.softwareDevice();
  const good = H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() });
  const noName = Object.assign({}, good, { deviceName: '' });
  let r = await pair(noName);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_FIELD');
  assert.strictEqual(r.body.field, 'deviceName');
  r = await pair(Object.assign({}, good, { ts: clock.now() - 25 * 60 * 60 * 1000 }));
  assert.strictEqual(r.body.field, 'ts');
  const der = crypto.sign('sha256', signing.signingInput('pair-request', good), dev.privateKey).toString('base64url');
  r = await pair(Object.assign({}, good, { sig: der }));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_SIGNATURE_ENCODING');
  const badKey = H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now(), devicePublicKey: dev.publicKey.slice(0, -2) + 'AA' });
  r = await pair(badKey);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_PUBLIC_KEY');
  r = await h.request('POST', '/api/m/v2/pair', { body: '{not json' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_JSON');
});

t('a wrong key (signature by another key) answers 401 SIGNATURE_INVALID and does not use the offer', async () => {
  await fresh();
  const { q } = offer();
  const dev = H.softwareDevice();
  const thief = H.softwareDevice();
  const r = await pair(H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now(), signer: thief }));
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.code, 'SIGNATURE_INVALID');
  const ok = await pair(H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(ok.status, 202, 'the offer is still usable after a bad signature');
});

t('the manual code pairs (normalized form), a wrong code answers PAIR_SECRET_INVALID', async () => {
  await fresh();
  const { o } = offer();
  const code = signing.normalizeManualCode(o.manualCode.toLowerCase());
  assert.strictEqual(code.length, 8);
  const dev = H.softwareDevice();
  const wrong = await pair(H.pairRequestBody(dev, { secretKind: 'code', secret: code === '00000000' ? '11111111' : '00000000', ts: clock.now() }));
  assert.strictEqual(wrong.status, 403);
  assert.strictEqual(wrong.body.code, 'PAIR_SECRET_INVALID');
  const r = await pair(H.pairRequestBody(dev, { secretKind: 'code', secret: code, ts: clock.now() }));
  assert.strictEqual(r.status, 202, r.text);
  assert.strictEqual(r.body.offerId, o.offerId, 'the challenge names the offer the code matched');
  const again = await pair(H.pairRequestBody(H.softwareDevice(), { secretKind: 'code', secret: code, ts: clock.now() }));
  assert.strictEqual(again.body.code, 'PAIR_SECRET_INVALID', 'a used code no longer matches a live offer');
});

t('an already paired key answers 409 DEVICE_ALREADY_PAIRED', async () => {
  await fresh();
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  const { q } = offer();
  const r = await pair(H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'DEVICE_ALREADY_PAIRED');
});

t('a fourth pending pair answers 429 PAIR_BUSY with retryAfterMs and Retry-After', async () => {
  await fresh();
  for (let i = 0; i < 3; i += 1) {
    const { q } = offer();
    assert.strictEqual((await pair(H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }))).status, 202);
  }
  const { q } = offer();
  const r = await pair(H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.code, 'PAIR_BUSY');
  assert.ok(r.body.retryAfterMs > 0);
  assert.ok(Number(r.headers['retry-after']) >= 1);
  schema.assertValid('admin/pair-requests.json', { pending: h.rt.pairing.listPending() });
});

t('deny answers the long poll with denied; expiry with expired; allow after expiry answers PAIR_EXPIRED', async () => {
  await fresh();
  let { q } = offer();
  const a = await pair(H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }));
  const poll = h.request('GET', '/api/m/v2/pair/' + a.body.pairId + '?wait=5');
  await new Promise((r) => setTimeout(r, 50));
  h.rt.pairing.deny(a.body.pairId);
  const denied = await poll;
  assert.deepStrictEqual(denied.body, { pairId: a.body.pairId, status: 'denied' });
  ({ q } = offer());
  const b = await pair(H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }));
  clock.advance(121 * 1000);
  const expired = await h.request('GET', '/api/m/v2/pair/' + b.body.pairId);
  assert.deepStrictEqual(expired.body, { pairId: b.body.pairId, status: 'expired' });
  assert.throws(() => h.rt.pairing.allow(b.body.pairId, { scopes: ALL, name: null }), (e) => e.code === 'PAIR_EXPIRED' && e.status === 410);
});

t('pair status: unknown pairId 404 PAIR_UNKNOWN, wait over 25 answers INVALID_FIELD', async () => {
  await fresh();
  const r = await h.request('GET', '/api/m/v2/pair/pr_AAAAAAAAAAAAAAAAAAAAAA');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'PAIR_UNKNOWN');
  const w = await h.request('GET', '/api/m/v2/pair/pr_AAAAAAAAAAAAAAAAAAAAAA?wait=26');
  assert.strictEqual(w.status, 400);
  assert.strictEqual(w.body.field, 'wait');
});

t('Allow refuses pty.raw and unknown scopes with 400 INVALID_SCOPE and creates no device', async () => {
  await fresh();
  const { q } = offer();
  const dev = H.softwareDevice();
  const a = await pair(H.pairRequestBody(dev, { offerId: q.o, secret: q.s, ts: clock.now() }));
  assert.throws(() => h.rt.pairing.allow(a.body.pairId, { scopes: ALL.concat(['pty.raw']), name: null }), (e) => e.code === 'INVALID_SCOPE' && e.status === 400);
  assert.throws(() => h.rt.pairing.allow(a.body.pairId, { scopes: ['chat', 'root'], name: null }), (e) => e.code === 'INVALID_SCOPE');
  assert.strictEqual(h.rt.devices.get(dev.deviceId), null);
  for (const d of h.rt.devices.list()) assert.ok(!d.scopes.includes('pty.raw'));
});

t('identity requires a 43 character nonce', async () => {
  await fresh();
  const r = await h.request('GET', '/api/m/v2/identity');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.field, 'nonce');
  await h.stop();
  h = null;
});

H.run('b1-pairing', tests);
