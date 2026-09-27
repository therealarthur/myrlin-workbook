/**
 * b1-auto-allow.test.js: the sandbox helper e2e/auto-allow.js (BUILD-CONTRACT
 * 6.1) allows only pending pairs named "Myrlin E2E ...", and refuses to run
 * without CWM_DATA_DIR or against port 3457.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const signing = require('../../src/web/mobile/signing');
const auto = require('./e2e/auto-allow');

// Never bind 3458 on this PC: the listener takes an ephemeral port.
process.env.CWM_MOBILE_PORT = '0';
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const SCRIPT = path.join(__dirname, 'e2e', 'auto-allow.js');

/** Run the helper as a child and collect its exit code and output. */
function runHelper(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

t('refuses to run without CWM_DATA_DIR, on port 3457, or without a password', () => {
  assert.strictEqual(auto.resolveConfig({}, { CWM_PASSWORD: 'x' }).ok, false);
  const live = auto.resolveConfig({ port: 3457 }, { CWM_DATA_DIR: '/tmp/x', CWM_PASSWORD: 'x' });
  assert.strictEqual(live.ok, false);
  assert.match(live.reason, /3457/);
  assert.strictEqual(auto.resolveConfig({ port: 4457 }, { CWM_DATA_DIR: '/tmp/x' }).ok, false);
  assert.strictEqual(auto.resolveConfig({ port: 4457 }, { CWM_DATA_DIR: '/tmp/x', CWM_PASSWORD: 'x' }).ok, true);
});

t('allows "Myrlin E2E" pairs with the default scopes and leaves other phones pending', async () => {
  const main = await H.startMainApp();
  const token = await main.login();
  const store = require('../../src/state/store').getStore();
  H.seedSettings(store, { enabled: false, detectTailscale: false, advertiseLoopback: true, apns: null });
  const on = await main.request('PUT', '/api/mobile-admin/settings', { token, body: { enabled: true } });
  const port = on.body.listener.port;
  const pairOne = async (name) => {
    const o = (await main.request('POST', '/api/mobile-admin/pair-offers', { token })).body;
    const q = signing.parseQrLink(o.qrLink);
    const dev = H.softwareDevice(name);
    const r = await H.request(port, 'POST', '/api/m/v2/pair', { body: H.pairRequestBody(dev, { offerId: q.o, secret: q.s }) });
    assert.strictEqual(r.status, 202);
    return { dev, pairId: r.body.pairId };
  };
  const e2e = await pairOne('Myrlin E2E iPhone');
  const other = await pairOne('Someone else');
  const env = Object.assign({}, process.env, { CWM_DATA_DIR: H.sandbox.dir, CWM_PASSWORD: process.env.CWM_PASSWORD });
  const r = await runHelper(['--port', String(main.port), '--once'], env);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /allowed Myrlin E2E iPhone/);
  const s1 = await H.request(port, 'GET', '/api/m/v2/pair/' + e2e.pairId);
  assert.strictEqual(s1.body.status, 'allowed');
  assert.deepStrictEqual(s1.body.scopes, auto.DEFAULT_SCOPES.slice().sort());
  const s2 = await H.request(port, 'GET', '/api/m/v2/pair/' + other.pairId);
  assert.strictEqual(s2.body.status, 'pending');
  const refused = await runHelper(['--port', '3457', '--once'], env);
  assert.strictEqual(refused.code, 2);
  await require('../../src/web/mobile').stopMobile();
  await main.close();
});

H.run('b1-auto-allow', tests);
