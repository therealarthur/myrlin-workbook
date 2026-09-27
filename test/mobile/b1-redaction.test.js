/**
 * b1-redaction.test.js: W3. Settings that leave the process never carry the
 * Anthropic key, anything under mobile.apns, or any key named like a secret,
 * and the request log never prints a query string (S4 to S6).
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { redactSettings } = require('../../src/web/mobile/redact');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const SECRET = 'sk-ant-test-' + 'x'.repeat(24);

t('redactSettings redacts the API key, mobile.apns and secret named keys, and copies', () => {
  const input = {
    anthropicApiKey: SECRET,
    serverName: 'STUDIO-PC',
    theme: 'light',
    mobile: { enabled: true, apns: { teamId: 'A1B2C3D4E5', keyId: 'ABC123DEFG', keyFile: 'C:/x/AuthKey.p8' }, port: 3458 },
    tunnelToken: 'tok',
    nested: { dbPassword: 'pw', clientSecret: 's', plain: 1, list: [{ apiKey: 'k' }] },
    emptyKey: null,
  };
  const before = JSON.stringify(input);
  const out = redactSettings(input);
  assert.strictEqual(JSON.stringify(input), before, 'the input is not modified');
  assert.strictEqual(out.anthropicApiKey, '[redacted]');
  assert.strictEqual(out.mobile.apns, '[redacted]');
  assert.strictEqual(out.mobile.enabled, true);
  assert.strictEqual(out.mobile.port, 3458);
  assert.strictEqual(out.tunnelToken, '[redacted]');
  assert.strictEqual(out.nested.dbPassword, '[redacted]');
  assert.strictEqual(out.nested.clientSecret, '[redacted]');
  assert.strictEqual(out.nested.plain, 1);
  assert.strictEqual(out.nested.list[0].apiKey, '[redacted]');
  assert.strictEqual(out.emptyKey, null);
  assert.strictEqual(out.serverName, 'STUDIO-PC');
  assert.ok(!JSON.stringify(out).includes(SECRET));
  assert.ok(!JSON.stringify(out).includes('AuthKey.p8'));
});

t('GET /api/mobile/sync carries a redacted settings object', async () => {
  const main = await H.startMainApp();
  const token = await main.login();
  const store = require('../../src/state/store').getStore();
  store.updateSettings({ anthropicApiKey: SECRET, mobile: Object.assign({}, store.settings.mobile, { apns: { teamId: 'A1B2C3D4E5', keyId: 'ABC123DEFG', keyFile: 'C:/k/AuthKey_ABC123DEFG.p8' } }) });
  const r = await main.request('GET', '/api/mobile/sync', { token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.settings.anthropicApiKey, '[redacted]');
  assert.strictEqual(r.body.settings.mobile.apns, '[redacted]');
  assert.ok(!r.text.includes(SECRET));
  assert.ok(!r.text.includes('AuthKey_ABC123DEFG'));
  assert.strictEqual(store.settings.anthropicApiKey, SECRET, 'the store keeps the real value');

  // S4: the request logger prints the path, never the query string.
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await main.request('GET', '/api/health?token=' + SECRET);
    await main.request('GET', '/api/mobile/sync?token=' + SECRET, { token });
  } finally {
    console.log = orig;
  }
  const req = lines.filter((l) => l.startsWith('[REQ]'));
  assert.ok(req.length >= 2, 'request lines logged');
  for (const l of req) assert.ok(!l.includes('?') && !l.includes(SECRET), 'logged: ' + l);
  store.updateSettings({ anthropicApiKey: null });
  await main.close();
});

t('settings:updated is broadcast through redactSettings (server.js S6)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'web', 'server.js'), 'utf8');
  const start = src.indexOf('function attachStoreEvents()');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/eventName === 'settings:updated' \? require\('\.\/mobile\/redact'\)\.redactSettings\(data\) : data/.test(body), 'S6 edit present in attachStoreEvents');
  assert.ok(/settings: require\('\.\/mobile\/redact'\)\.redactSettings\(state\.settings \|\| \{\}\)/.test(src), 'S5 edit present');
});

H.run('b1-redaction', tests);
