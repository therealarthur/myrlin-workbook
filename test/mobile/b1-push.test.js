/**
 * b1-push.test.js: the APNs sender, payload builders and notify()
 * (PROTOCOL.md 10), against a local HTTP/2 stub server.
 *
 * WHY (BUILD-CONTRACT 3.5.2): with no key nothing is sent and
 * capabilities.push is false; with a test EC key the JWT, payloads, headers
 * and collapse ids equal PROTOCOL.md 10.3 for each kind, hideSessionNames
 * changes the title, a 410 removes the registration, and activity events
 * produce start, update and end Live Activity payloads under 4 KB with the
 * priorities and throttle of 10.4, and none for a device that turned Live
 * Activities off.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createChecker } = require('./_schema-check');
const payloads = require('../../src/web/mobile/push/payloads');
const { createApnsClient } = require('../../src/web/mobile/push/apns');

const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const TEAM = 'A1B2C3D4E5';
const KEY_ID = 'TESTKEY123';
const TOKEN_A = 'a1'.repeat(32);

let h;
let hub;
let clock;
let stub;
let keyPair;
let dev;

/** A local h2c server that records requests and answers from a script. */
function startStub() {
  const requests = [];
  const script = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers, body: body ? JSON.parse(body) : null });
      const next = script.shift() || { status: 200 };
      const out = { ':status': next.status, 'apns-id': next.apnsId || crypto.randomUUID() };
      stream.respond(out);
      stream.end(next.reason ? JSON.stringify({ reason: next.reason }) : '');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, script, origin: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((r) => server.close(() => r())),
  })));
}

/** Configure the APNs key in the sandbox settings. */
function configureKey() {
  const file = path.join(H.sandbox.dir, 'mobile', 'apns', 'AuthKey_' + KEY_ID + '.p8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  h.store.updateSettings({ mobile: Object.assign({}, h.store.settings.mobile, { apns: { teamId: TEAM, keyId: KEY_ID, keyFile: file, bundleId: 'io.myrlin.workbook' } }) });
  h.rt.notifier.configure();
  h.rt.notifier._setTransport({ hosts: { production: stub.origin, sandbox: stub.origin }, delay: () => Promise.resolve() });
}

/** Register a device's push tokens. */
function register(d, extra) {
  h.rt.devices.setPush(d.deviceId, Object.assign({ apnsToken: TOKEN_A, environment: 'production', bundleId: 'io.myrlin.workbook', liveActivityPushToStartToken: null, widgetPushToken: null }, extra || {}));
}

/** Notify and return the requests the stub received for it. */
async function send(event) {
  const n = stub.requests.length;
  await h.rt.notifier.notify(event);
  return stub.requests.slice(n);
}

/** The expected collapse id, computed independently. */
function expectedCollapse(prefix, key) {
  return prefix + ':' + crypto.createHash('sha256').update(h.rt.identity.computerId + '\n' + key).digest('base64url').slice(0, 22);
}

const SID = 'cl_733b51a7-b861-4e1c-98b2-5af241fede0f';

t('setup: sandbox, stub hub, stub APNs server, a paired device', async () => {
  clock = H.fakeClock(1790000000000);
  hub = H.stubHub();
  h = await H.startSandbox({ hub, clock });
  stub = await startStub();
  keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = H.softwareDevice();
  dev = h.rt.devices.create({ publicKey: d.publicKey, name: 'Sam’s iPhone', model: 'iPhone17,2', osVersion: '26.1', appVersion: '1.0.0 (1)', scopes: ['chat'], pairedAtMs: clock.now() });
  register(dev);
});

t('without a key: nothing is sent and capabilities.push is false', async () => {
  h.rt.notifier._setTransport({ hosts: { production: stub.origin, sandbox: stub.origin } });
  const reqs = await send({ kind: 'question', sessionId: SID, sessionTitle: 'Fix sidebar jitter', provider: 'claude', promptId: 'p_Yh3kPz0qLm8vN2cR5tW9' });
  assert.strictEqual(reqs.length, 0);
  assert.strictEqual(h.rt.capabilities().push, false);
  assert.strictEqual(h.ctx.mobile.push.isConfigured(), false);
});

t('with a key: the ES256 JWT header, claims and signature', async () => {
  configureKey();
  assert.strictEqual(h.rt.capabilities().push, true);
  const reqs = await send({ kind: 'question', sessionId: SID, sessionTitle: 'Fix sidebar jitter', provider: 'claude', promptId: 'p_Yh3kPz0qLm8vN2cR5tW9' });
  assert.strictEqual(reqs.length, 1);
  const auth = reqs[0].headers.authorization;
  assert.match(auth, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [hdr, claims, sig] = auth.slice(7).split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(hdr, 'base64url')), { alg: 'ES256', kid: KEY_ID });
  assert.deepStrictEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: TEAM, iat: Math.floor(clock.now() / 1000) });
  assert.ok(crypto.verify('sha256', Buffer.from(hdr + '.' + claims), { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.strictEqual(reqs[0].headers[':path'], '/3/device/' + TOKEN_A);
});

t('question: payload, headers and collapse id equal PROTOCOL.md 10.3', async () => {
  const reqs = await send({ kind: 'question', sessionId: SID, sessionTitle: 'Fix sidebar jitter', provider: 'claude', promptId: 'p_Yh3kPz0qLm8vN2cR5tW9' });
  const r = reqs[0];
  schema.assertValid('push/alert-payload.json', r.body);
  const name = h.rt.computerName();
  assert.deepStrictEqual(r.body.aps.alert, { title: 'Fix sidebar jitter', subtitle: 'Claude on ' + name, body: 'Needs your answer.' });
  assert.strictEqual(r.body.aps.category, 'MYRLIN_QUESTION');
  assert.strictEqual(r.body.aps.sound, 'default');
  assert.strictEqual(r.body.aps['thread-id'], h.rt.identity.computerId + ':' + SID);
  assert.strictEqual(r.body.aps['interruption-level'], 'time-sensitive');
  assert.deepStrictEqual(r.body.m, { v: 1, k: 'question', cid: h.rt.identity.computerId, sid: SID, pid: 'p_Yh3kPz0qLm8vN2cR5tW9', mid: null, acc: null, prov: 'claude', ts: clock.now() });
  assert.strictEqual(r.headers['apns-push-type'], 'alert');
  assert.strictEqual(r.headers['apns-topic'], 'io.myrlin.workbook');
  assert.strictEqual(r.headers['apns-priority'], '10');
  assert.strictEqual(Number(r.headers['apns-expiration']), Math.floor(clock.now() / 1000) + 3600);
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('needs', SID));
  assert.ok(Buffer.byteLength(r.headers['apns-collapse-id']) <= 64);
});

t('approval and plan share the needs collapse id; words and categories', async () => {
  let r = (await send({ kind: 'approval', sessionId: SID, sessionTitle: 'Fix sidebar jitter', provider: 'codex', promptId: 'p_BBBBBBBBBBBBBBBBBBBB' }))[0];
  assert.strictEqual(r.body.aps.alert.body, 'Needs your approval.');
  assert.strictEqual(r.body.aps.alert.subtitle, 'Codex on ' + h.rt.computerName());
  assert.strictEqual(r.body.aps.category, 'MYRLIN_APPROVAL');
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('needs', SID));
  r = (await send({ kind: 'plan', sessionId: SID, sessionTitle: 'Fix sidebar jitter', provider: 'claude', promptId: 'p_CCCCCCCCCCCCCCCCCCCC' }))[0];
  assert.strictEqual(r.body.aps.category, 'MYRLIN_APPROVAL');
  assert.strictEqual(r.body.m.k, 'plan');
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('needs', SID));
  assert.strictEqual(r.body.aps.badge, 3, 'badge counts distinct open question, approval and plan prompts');
});

t('hideSessionNames titles "A session on <computer>"; showMessageText shows the question cut to 178', async () => {
  h.rt.devices.patchPreferences(dev.deviceId, { privacy: { hideSessionNames: true } });
  let r = (await send({ kind: 'question', sessionId: SID, sessionTitle: 'Secret project', provider: 'claude', promptId: 'p_DDDDDDDDDDDDDDDDDDDD' }))[0];
  assert.strictEqual(r.body.aps.alert.title, 'A session on ' + h.rt.computerName());
  h.rt.devices.patchPreferences(dev.deviceId, { privacy: { hideSessionNames: false, showMessageText: true } });
  r = (await send({ kind: 'question', sessionId: SID, sessionTitle: 'x', provider: 'claude', promptId: 'p_EEEEEEEEEEEEEEEEEEEE', detailText: 'Q'.repeat(300) }))[0];
  assert.strictEqual(Array.from(r.body.aps.alert.body).length, 178);
  h.rt.devices.patchPreferences(dev.deviceId, { privacy: { showMessageText: false }, notifications: { question: false } });
  assert.strictEqual((await send({ kind: 'question', sessionId: SID, sessionTitle: 'x', provider: 'claude', promptId: 'p_FFFFFFFFFFFFFFFFFFFF' })).length, 0, 'preference off');
  h.rt.devices.patchPreferences(dev.deviceId, { notifications: { question: true } });
});

t('finished: only when the device has no open stream socket and the turn was long enough', async () => {
  const ev = { kind: 'finished', sessionId: SID, sessionTitle: 'Fix sidebar jitter', provider: 'claude', durationMs: 14 * 60 * 1000, status: 'completed' };
  let r = (await send(ev))[0];
  assert.ok(r, 'sent while not connected');
  assert.strictEqual(r.body.aps.alert.body, 'Finished after 14 minutes.');
  assert.strictEqual(r.body.aps.category, 'MYRLIN_FINISHED');
  assert.strictEqual(r.headers['apns-priority'], '5');
  assert.strictEqual(r.body.aps['interruption-level'], 'active');
  assert.strictEqual(Number(r.headers['apns-expiration']), Math.floor(clock.now() / 1000) + 6 * 3600);
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('done', SID));
  assert.strictEqual((await send(Object.assign({}, ev, { durationMs: 60 * 1000 }))).length, 0, 'shorter than finishedMinMinutes');
  r = (await send(Object.assign({}, ev, { status: 'failed', errorWords: 'the API answered overloaded.' })))[0];
  assert.strictEqual(r.body.aps.alert.body, 'Claude stopped: the API answered overloaded.');
  hub.isDeviceConnected = () => true;
  assert.strictEqual((await send(ev)).length, 0, 'not sent while a socket is open');
  hub.isDeviceConnected = () => false;
});

t('limit, swap and migration words, collapse ids and priorities', async () => {
  const resets = clock.now() + (39 * 3600 + 5 * 60) * 1000;
  let r = (await send({ kind: 'limit', provider: 'claude', accountId: 'acc1', accountDisplayName: 'Personal', windowKey: 'seven_day', windowLabel: 'Weekly', percent: 90, resetsAtMs: resets, limited: false }))[0];
  schema.assertValid('push/alert-payload.json', r.body);
  assert.deepStrictEqual(r.body.aps.alert, { title: 'Claude usage', subtitle: 'Personal on ' + h.rt.computerName(), body: 'Weekly limit at 90%, resets in 1d 15h.' });
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('limit', 'claude:seven_day'));
  assert.strictEqual(r.body.m.acc, 'acc1');
  r = (await send({ kind: 'limit', provider: 'codex', accountId: 'acc2', accountDisplayName: 'Work', windowKey: 'primary', windowLabel: 'Weekly', percent: 100, resetsAtMs: clock.now() + (4 * 86400 + 14 * 3600) * 1000, limited: true }))[0];
  assert.strictEqual(r.body.aps.alert.body, 'Weekly limit reached, resets in 4d 14h.');
  assert.strictEqual(r.body.aps.alert.title, 'Codex usage');
  r = (await send({ kind: 'swap', provider: 'claude', accountId: 'acc3', accountDisplayName: 'Work', agent: 'claude-code', reason: 'weekly limit' }))[0];
  assert.deepStrictEqual(r.body.aps.alert, { title: 'Claude account switched', subtitle: 'on ' + h.rt.computerName(), body: 'claude-code switched Claude to Work: weekly limit.' });
  assert.strictEqual(r.body.aps.category, 'MYRLIN_SWAP');
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('swap', 'claude'));
  const mid = 'mg_AAAAAAAAAAAAAAAAAAAAAA';
  r = (await send({ kind: 'migration', migrationId: mid, targetSessionId: SID, targetTitle: 'Takeover', state: 'awaitingApproval', claimsFailed: 3 }))[0];
  assert.strictEqual(r.body.aps.alert.body, 'Takeover report ready: 3 claims did not hold.');
  assert.strictEqual(r.body.aps.category, 'MYRLIN_MIGRATION');
  assert.strictEqual(r.body.m.mid, mid);
  assert.strictEqual(r.headers['apns-collapse-id'], expectedCollapse('mg', mid));
  r = (await send({ kind: 'migration', migrationId: mid, targetSessionId: SID, targetTitle: 'Takeover', state: 'failed', failedStepLabel: 'Packing the history' }))[0];
  assert.strictEqual(r.body.aps.alert.body, 'Migration stopped: Packing the history failed.');
});

t('resolved: a background push with the new badge', async () => {
  const before = h.rt.notifier._badge();
  const r = (await send({ kind: 'resolved', sessionId: SID, promptId: 'p_Yh3kPz0qLm8vN2cR5tW9' }))[0];
  assert.strictEqual(r.headers['apns-push-type'], 'background');
  assert.strictEqual(r.headers['apns-priority'], '5');
  assert.strictEqual(r.body.aps['content-available'], 1);
  assert.strictEqual(r.body.aps.badge, before - 1);
  assert.strictEqual(r.body.m.k, 'resolved');
  schema.assertValid('push/alert-payload.json', r.body);
});

t('APNs answers: 410 removes the registration; 403 ExpiredProviderToken re-signs once; 5xx retries 3 times', async () => {
  stub.script.push({ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 });
  let reqs = await send({ kind: 'swap', provider: 'claude', accountDisplayName: 'Work', agent: 'claude-code' });
  assert.strictEqual(reqs.length, 2);
  assert.notStrictEqual(reqs[0].headers.authorization, reqs[1].headers.authorization, 're-signed');
  stub.script.push({ status: 500 }, { status: 503 }, { status: 429 }, { status: 500 });
  reqs = await send({ kind: 'swap', provider: 'claude', accountDisplayName: 'Work', agent: 'claude-code' });
  assert.strictEqual(reqs.length, 4, 'one try plus 3 retries, then dropped');
  assert.match(h.rt.devices.get(dev.deviceId).pushLastError, /APNs/);
  stub.script.push({ status: 410, reason: 'Unregistered' });
  reqs = await send({ kind: 'swap', provider: 'claude', accountDisplayName: 'Work', agent: 'claude-code' });
  assert.strictEqual(reqs.length, 1);
  assert.strictEqual(h.rt.devices.get(dev.deviceId).push, null, 'registration removed');
  register(dev);
  stub.script.push({ status: 400, reason: 'BadDeviceToken' });
  await send({ kind: 'swap', provider: 'claude', accountDisplayName: 'Work', agent: 'claude-code' });
  assert.strictEqual(h.rt.devices.get(dev.deviceId).push, null);
  register(dev);
});

t('five failures in ten minutes publish APNS_FAILING and set push.lastError', async () => {
  for (let i = 0; i < 5; i += 1) {
    stub.script.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    await send({ kind: 'swap', provider: 'claude', accountDisplayName: 'Work', agent: 'claude-code' });
  }
  assert.match(h.rt.notifier.status().lastError, /APNs is failing/);
  assert.ok(hub.calls.some((c) => c.fn === 'publish' && c.type === 'computer.notice'));
});

t('Live Activity: start by push to start, update priorities and throttle, end, under 4 KB', async () => {
  register(dev, { liveActivityPushToStartToken: 'b2'.repeat(32) });
  const sessions = [
    { sessionId: SID, title: 'Working one', provider: 'claude', state: 'working', enteredAtMs: clock.now() - 5000 },
    { sessionId: 'cx_1', title: 'Waiting one', provider: 'codex', state: 'needsApproval', enteredAtMs: clock.now() - 1000 },
    { sessionId: 'cl_idle', title: 'Idle', provider: 'claude', state: 'idle', enteredAtMs: clock.now() },
  ];
  let reqs = await send({ kind: 'activity', computerName: 'X', sessions, urgentSessionId: 'cx_1', needsYouChanged: true });
  assert.strictEqual(reqs.length, 1);
  let r = reqs[0];
  assert.strictEqual(r.headers[':path'], '/3/device/' + 'b2'.repeat(32));
  assert.strictEqual(r.headers['apns-push-type'], 'liveactivity');
  assert.strictEqual(r.headers['apns-topic'], 'io.myrlin.workbook.push-type.liveactivity');
  assert.strictEqual(r.body.aps.event, 'start');
  assert.strictEqual(r.body.aps['attributes-type'], 'MyrlinActivityAttributes');
  assert.deepStrictEqual(r.body.aps.attributes, { computerId: h.rt.identity.computerId });
  const cs = r.body.aps['content-state'];
  assert.deepStrictEqual(cs.sessions.map((s) => s.sessionId), ['cx_1', SID], 'waiting first, idle dropped');
  assert.strictEqual(cs.urgentSessionId, 'cx_1');
  assert.strictEqual(r.body.aps['stale-date'], Math.floor(clock.now() / 1000) + 900);
  h.rt.devices.setLiveActivity(dev.deviceId, 'act1', { pushToken: 'c3'.repeat(32), startedAtMs: clock.now() });
  reqs = await send({ kind: 'activity', sessions, needsYouChanged: false });
  r = reqs[0];
  assert.strictEqual(r.body.aps.event, 'update');
  assert.strictEqual(r.headers['apns-priority'], '5');
  assert.strictEqual(r.headers[':path'], '/3/device/' + 'c3'.repeat(32));
  reqs = await send({ kind: 'activity', sessions, needsYouChanged: false });
  assert.strictEqual(reqs.length, 0, 'a second priority 5 update within 15 s waits');
  reqs = await send({ kind: 'activity', sessions, needsYouChanged: true });
  assert.strictEqual(reqs[0].headers['apns-priority'], '10', 'a session starting to need you is sent at once');
  const long = sessions.map((s) => Object.assign({}, s, { title: 'T'.repeat(3000) }));
  const built = payloads.buildActivity('update', { sessions: long }, { computerId: h.rt.identity.computerId, computerName: 'X', prefs: {}, nowMs: clock.now() });
  assert.ok(Buffer.byteLength(JSON.stringify(built.payload)) < 4096, 'under 4 KB');
  reqs = await send({ kind: 'activity', sessions: [], needsYouChanged: false });
  assert.strictEqual(reqs[0].body.aps.event, 'end');
  assert.strictEqual(reqs[0].body.aps['dismissal-date'], Math.floor(clock.now() / 1000) + 900);
  h.rt.devices.patchPreferences(dev.deviceId, { liveActivity: { enabled: false } });
  assert.strictEqual((await send({ kind: 'activity', sessions, needsYouChanged: true })).length, 0, 'none when liveActivity.enabled is false');
  h.rt.devices.patchPreferences(dev.deviceId, { liveActivity: { enabled: true } });
});

t('widgets: content-changed push at most once per 15 minutes per device', async () => {
  register(dev, { widgetPushToken: 'd4'.repeat(32) });
  let reqs = await send({ kind: 'widgets' });
  assert.strictEqual(reqs.length, 1);
  assert.deepStrictEqual(reqs[0].body, { aps: { 'content-changed': true } });
  assert.strictEqual(reqs[0].headers['apns-push-type'], 'widgets');
  assert.strictEqual(reqs[0].headers['apns-topic'], 'io.myrlin.workbook.push-type.widgets');
  reqs = await send({ kind: 'widgets' });
  assert.strictEqual(reqs.length, 0);
  clock.advance(15 * 60 * 1000);
  assert.strictEqual((await send({ kind: 'widgets' })).length, 1);
});

t('test push, and the provider token is re-signed after 50 minutes', async () => {
  const r = await h.rt.notifier.sendTest(dev.deviceId);
  assert.strictEqual(r.ok, true);
  assert.ok(r.apnsId);
  const last = stub.requests[stub.requests.length - 1];
  assert.strictEqual(last.body.aps.alert.title, 'Test from ' + h.rt.computerName() + '.');
  const c = H.fakeClock(1790000000000);
  const client = createApnsClient({ config: { teamId: TEAM, keyId: KEY_ID, key: keyPair.privateKey }, now: c.now });
  const a = client.providerToken();
  c.advance(49 * 60 * 1000);
  assert.strictEqual(client.providerToken(), a, 'reused within 50 minutes');
  c.advance(60 * 1000);
  assert.notStrictEqual(client.providerToken(), a, 're-signed at 50 minutes');
  client.close();
  h.rt.notifier.close();
  await stub.close();
  await h.stop();
});

H.run('b1-push', tests);
