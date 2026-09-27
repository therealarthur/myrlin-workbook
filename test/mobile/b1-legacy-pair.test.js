/**
 * b1-legacy-pair.test.js: the v1 pair route is switched off behind a setting
 * (A4, critic F20, PROTOCOL.md 2.13, BUILD-CONTRACT S11).
 *
 * WHY: v1 tokens carry full desktop privilege, so POST /api/auth/pair and
 * GET /api/auth/pairing-code answer 410 LEGACY_PAIR_DISABLED unless
 * settings.mobile.legacyPairEnabled is true. The code stays (code
 * preservation), and with the setting on, the W1 fix holds: an invalid token
 * answers 403, not the old always 429, and a real limit sets Retry-After.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let main;
let desktop;
let store;

t('setup: the main app and a desktop token', async () => {
  main = await H.startMainApp();
  desktop = await main.login();
  store = require('../../src/state/store').getStore();
  H.seedSettings(store, { legacyPairEnabled: false, detectTailscale: false });
});

t('POST /api/auth/pair answers 410 LEGACY_PAIR_DISABLED by default', async () => {
  const r = await main.request('POST', '/api/auth/pair', { body: { pairingToken: 'a'.repeat(64) } });
  assert.strictEqual(r.status, 410);
  assert.deepStrictEqual(r.body, { error: 'Pairing moved to the Myrlin app. Update the app and scan again.', code: 'LEGACY_PAIR_DISABLED' });
});

t('GET /api/auth/pairing-code follows the same setting', async () => {
  const r = await main.request('GET', '/api/auth/pairing-code', { token: desktop });
  assert.strictEqual(r.status, 410);
  assert.strictEqual(r.body.code, 'LEGACY_PAIR_DISABLED');
});

t('with the setting on, an invalid token answers 403 (not 429), and a real limit sets Retry-After', async () => {
  H.seedSettings(store, Object.assign({}, store.settings.mobile, { legacyPairEnabled: true }));
  const code = await main.request('GET', '/api/auth/pairing-code', { token: desktop });
  assert.strictEqual(code.status, 200);
  assert.ok(code.body.pairingToken);
  const first = await main.request('POST', '/api/auth/pair', { body: { pairingToken: 'b'.repeat(64) } });
  assert.strictEqual(first.status, 403, 'W1: the limiter object is no longer read as a boolean');
  let limited = null;
  for (let i = 0; i < 10 && !limited; i += 1) {
    const r = await main.request('POST', '/api/auth/pair', { body: { pairingToken: 'c'.repeat(64) } });
    if (r.status === 429) limited = r;
    else assert.strictEqual(r.status, 403);
  }
  assert.ok(limited, 'the per address limit still applies to the legacy route');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  H.seedSettings(store, Object.assign({}, store.settings.mobile, { legacyPairEnabled: false }));
  await main.close();
});

H.run('b1-legacy-pair', tests);
