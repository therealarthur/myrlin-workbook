/**
 * b1-rate-limit.test.js: the limiters of PROTOCOL.md 2.12.
 *
 * WHY: limits key on an offer, a device key, a device id, a pair id or a
 * global bucket, never an address (F8), every 429 carries retryAfterMs and
 * Retry-After, and a flood of bad pair attempts never locks a paired phone's
 * hello and session out.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const signing = require('../../src/web/mobile/signing');
const { createLimiters, LIMITS } = require('../../src/web/mobile/rate-limit');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let h;
let clock;

/** Assert a 429 with retryAfterMs and Retry-After. */
function is429(r, code) {
  assert.strictEqual(r.status, 429, r.text);
  assert.strictEqual(r.body.code, code || 'RATE_LIMITED');
  assert.ok(Number.isInteger(r.body.retryAfterMs) && r.body.retryAfterMs > 0);
  assert.ok(Number(r.headers['retry-after']) >= 1);
}

t('identity: 120 per minute globally, then 429; the window slides', async () => {
  clock = H.fakeClock(Date.now());
  h = await H.startSandbox({ clock });
  for (let i = 0; i < LIMITS.identityPerMinute; i += 1) {
    const r = await h.request('GET', '/api/m/v2/identity?nonce=' + signing.randomNonce());
    assert.strictEqual(r.status, 200);
  }
  is429(await h.request('GET', '/api/m/v2/identity?nonce=' + signing.randomNonce()));
  clock.advance(60 * 1000 + 1);
  assert.strictEqual((await h.request('GET', '/api/m/v2/identity?nonce=' + signing.randomNonce())).status, 200);
});

t('pair: 30 failures in 10 minutes block every pair request, but hello and session keep working', async () => {
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  const attacker = H.softwareDevice();
  for (let i = 0; i < LIMITS.pairGlobalFailuresPer10Min; i += 1) {
    const r = await h.request('POST', '/api/m/v2/pair', { body: H.pairRequestBody(attacker, { offerId: 'AAAAAAAA', secret: signing.randomNonce(), ts: clock.now() }) });
    assert.strictEqual(r.body.code, 'PAIR_OFFER_UNKNOWN');
  }
  const offer = h.rt.pairing.createOffer();
  const q = signing.parseQrLink(offer.qrLink);
  is429(await h.request('POST', '/api/m/v2/pair', { body: H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }) }));
  const s = await H.openSession(h, dev);
  assert.ok(s.sessionToken, 'a paired phone still gets a session');
  clock.advance(10 * 60 * 1000 + 1);
  const q2 = signing.parseQrLink(h.rt.pairing.createOffer().qrLink);
  const ok = await h.request('POST', '/api/m/v2/pair', { body: H.pairRequestBody(H.softwareDevice(), { offerId: q2.o, secret: q2.s, ts: clock.now() }) });
  assert.strictEqual(ok.status, 202, 'the window slid');
});

t('pair: 10 requests per hour per device key', async () => {
  const key = H.softwareDevice();
  for (let i = 0; i < LIMITS.pairPerKeyPerHour; i += 1) {
    const o = h.rt.pairing.createOffer();
    const q = signing.parseQrLink(o.qrLink);
    const r = await h.request('POST', '/api/m/v2/pair', { body: H.pairRequestBody(key, { offerId: q.o, secret: q.s, ts: clock.now(), signer: H.softwareDevice() }) });
    assert.strictEqual(r.body.code, 'SIGNATURE_INVALID');
  }
  const o = h.rt.pairing.createOffer();
  const q = signing.parseQrLink(o.qrLink);
  is429(await h.request('POST', '/api/m/v2/pair', { body: H.pairRequestBody(key, { offerId: q.o, secret: q.s, ts: clock.now() }) }));
  await h.stop();
});

t('pairPoll: 120 per minute per pairId', async () => {
  clock = H.fakeClock(Date.now());
  h = await H.startSandbox({ clock });
  const o = h.rt.pairing.createOffer();
  const q = signing.parseQrLink(o.qrLink);
  const c = await h.request('POST', '/api/m/v2/pair', { body: H.pairRequestBody(H.softwareDevice(), { offerId: q.o, secret: q.s, ts: clock.now() }) });
  for (let i = 0; i < LIMITS.pairPollPerMinute; i += 1) assert.strictEqual((await h.request('GET', '/api/m/v2/pair/' + c.body.pairId)).status, 200);
  is429(await h.request('GET', '/api/m/v2/pair/' + c.body.pairId));
  const other = await h.request('GET', '/api/m/v2/pair/pr_AAAAAAAAAAAAAAAAAAAAAA');
  assert.strictEqual(other.status, 404, 'another pairId has its own bucket');
});

t('hello: 30 per minute per device', async () => {
  const dev = H.softwareDevice();
  await H.pairDevice(h, dev);
  for (let i = 0; i < LIMITS.helloPerDevicePerMinute; i += 1) {
    assert.strictEqual((await h.request('POST', '/api/m/v2/hello', { body: { deviceId: dev.deviceId, clientNonce: signing.randomNonce() } })).status, 200);
  }
  is429(await h.request('POST', '/api/m/v2/hello', { body: { deviceId: dev.deviceId, clientNonce: signing.randomNonce() } }));
  await h.stop();
});

t('device bucket (20/s, burst 100), send 60/min, search 30/min, upload 600/min', () => {
  const c = H.fakeClock(0);
  const lim = createLimiters({ now: c.now });
  for (let i = 0; i < LIMITS.deviceBurst; i += 1) assert.strictEqual(lim.check('device', 'd').limited, false);
  const over = lim.check('device', 'd');
  assert.strictEqual(over.limited, true);
  assert.ok(over.retryAfterMs > 0 && over.retryAfterMs <= 50);
  c.advance(1000);
  for (let i = 0; i < LIMITS.deviceRatePerSecond; i += 1) assert.strictEqual(lim.check('device', 'd').limited, false);
  assert.strictEqual(lim.check('device', 'd').limited, true);
  const lim2 = createLimiters({ now: c.now });
  for (let i = 0; i < LIMITS.sendPerMinute; i += 1) assert.strictEqual(lim2.check('send', 'x').limited, false);
  assert.strictEqual(lim2.check('send', 'x').limited, true);
  assert.strictEqual(lim2.check('send', 'y').limited, false, 'per device');
  for (let i = 0; i < LIMITS.searchPerMinute; i += 1) assert.strictEqual(lim2.check('search', 'z').limited, false);
  assert.strictEqual(lim2.check('search', 'z').limited, true);
  for (let i = 0; i < LIMITS.uploadPerMinute; i += 1) assert.strictEqual(lim2.check('upload', 'u').limited, false);
  assert.strictEqual(lim2.check('upload', 'u').limited, true);
});

H.run('b1-rate-limit', tests);
