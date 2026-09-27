/**
 * b1-examples.test.js: every JSON example of PROTOCOL.md sections 2 to 11,
 * with placeholders replaced by concrete values (fixtures/examples/), validates
 * against the vendored schemas (BUILD-CONTRACT 3.5.1 item 14).
 *
 * WHY: the document, the schemas and the code must agree (DoD item 7). An
 * example the schema rejects is a bug in one of them, found before an agent
 * builds against the wrong one. fixtures/examples/index.json names each
 * file's schema, its PROTOCOL.md line and any hand substitution.
 *
 * The examples are the fenced blocks and the inline examples of the text
 * (hello, the Allow and APNs bodies, the 5.4 event shapes and the rest). The
 * Apple payloads and the provider token of section 10 have no wire schema, so
 * they are compared with the code that builds them (payloads.js, apns.js).
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createChecker } = require('./_schema-check');
const payloads = require('../../src/web/mobile/push/payloads');
const { signProviderToken } = require('../../src/web/mobile/push/apns');

const DIR = path.join(__dirname, 'fixtures', 'examples');
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
/** 64 fenced blocks plus 63 inline examples (entries marked inline). */
const EXPECTED_FENCED = 64;
const EXPECTED_INLINE = 63;
/** Read one example by file name. */
const example = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/** Collect every string value of a JSON value. */
function strings(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

t('the index lists every example (fenced and inline), each file exists, and every file is listed', () => {
  assert.strictEqual(index.examples.filter((e) => !e.inline).length, EXPECTED_FENCED);
  assert.strictEqual(index.examples.filter((e) => e.inline).length, EXPECTED_INLINE);
  const listed = new Set(index.examples.map((e) => e.file));
  for (const e of index.examples) assert.ok(fs.existsSync(path.join(DIR, e.file)), e.file);
  for (const f of fs.readdirSync(DIR)) if (f !== 'index.json') assert.ok(listed.has(f), 'unlisted ' + f);
});

for (const e of index.examples) {
  t(e.file + (e.schema ? ' validates against ' + e.schema : ' parses (file format, no wire schema)'), () => {
    const value = JSON.parse(fs.readFileSync(path.join(DIR, e.file), 'utf8'));
    if (e.schema) schema.assertValid(e.schema, e.at ? value[e.at] : value);
    for (const s of strings(value, [])) {
      assert.ok(!/^<[^>]+>$/.test(s), 'placeholder left: ' + s);
      assert.ok(!/^(cl|cx|wb|pr|mg|u|d|c|p|e|t)_\.\.\.$/.test(s), 'truncated id left: ' + s);
    }
  });
}

t('the signed handshake examples carry 86 character signatures and vector keys', () => {
  const v = JSON.parse(fs.readFileSync(path.join(H.PROTOCOL_DIR, 'vectors', 'pairing.json'), 'utf8'));
  const idr = JSON.parse(fs.readFileSync(path.join(DIR, index.examples.find((e) => e.schema === 'handshake/identity-response.json').file), 'utf8'));
  assert.strictEqual(idr.computerPublicKey, v.keys.computer.spkiDerB64u);
  assert.strictEqual(idr.sig.length, 86);
});

/** Find the one index entry for a PROTOCOL.md line and file label. */
function entryFor(line, label) {
  const e = index.examples.find((x) => x.protocolLine === line && x.file.includes(label));
  assert.ok(e, 'no example for line ' + line + ' ' + label);
  return example(e.file);
}

t('the inline hello, Allow and APNs examples are the bodies the routes take', () => {
  const v = JSON.parse(fs.readFileSync(path.join(H.PROTOCOL_DIR, 'vectors', 'pairing.json'), 'utf8'));
  const hello = entryFor(480, 'hello-request');
  assert.strictEqual(hello.deviceId, v.keys.device.deviceId);
  assert.strictEqual(hello.clientNonce.length, 43);
  const allow = entryFor(2597, 'allow-request');
  assert.deepStrictEqual(allow.scopes.slice().sort(), ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage']);
  const apns = entryFor(2579, 'apns-config');
  assert.ok(/^[A-Z0-9]{10}$/.test(apns.teamId) && /^[A-Z0-9]{10}$/.test(apns.keyId));
  // The p8 body is the TEST ONLY vector key: with its armour it loads as the admin route loads it.
  const armour = (label) => '-'.repeat(5) + label + ' PRIVATE KEY' + '-'.repeat(5);
  const pem = armour('BEGIN') + '\n' + apns.p8.match(/.{1,64}/g).join('\n') + '\n' + armour('END') + '\n';
  const key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  assert.strictEqual(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

t('10.1 provider token: the header and claims examples are what apns.js signs', () => {
  const header = entryFor(2478, 'jwt-header');
  const claims = entryFor(2478, 'jwt-claims');
  const v = JSON.parse(fs.readFileSync(path.join(H.PROTOCOL_DIR, 'vectors', 'pairing.json'), 'utf8'));
  const key = crypto.createPrivateKey({ key: v.keys.computer.jwk, format: 'jwk' });
  const jwt = signProviderToken({ teamId: claims.iss, keyId: header.kid, key }, claims.iat * 1000);
  const [h, c, sig] = jwt.split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), header);
  assert.deepStrictEqual(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')), claims);
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: crypto.createPublicKey(key), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

t('10.3 and 10.4: the background, Live Activity and widgets examples are what payloads.js builds', () => {
  const prefs = example('L777-resources_preferences.json');
  const bg = entryFor(2539, 'background-payload');
  const built = payloads.buildResolved({ sessionId: bg.m.sid, promptId: bg.m.pid }, { computerId: bg.m.cid, badge: bg.aps.badge, nowMs: bg.m.ts });
  assert.deepStrictEqual(built.payload, bg);
  assert.strictEqual(built.pushType, 'background');
  for (const kind of ['update', 'end', 'start']) {
    const ex = entryFor(2549, 'liveactivity-' + kind);
    const cs = ex.aps['content-state'];
    const sessions = kind === 'end' ? [] : cs.sessions;
    const b = payloads.buildActivity(kind, { sessions, needsYouChanged: false }, { computerId: kind === 'start' ? ex.aps.attributes.computerId : 'c_ff392dwfMAEdmqePZGay', computerName: cs.computerName, prefs, nowMs: cs.updatedAtMs });
    assert.deepStrictEqual(b.payload, ex, kind);
    assert.strictEqual(b.pushType, 'liveactivity');
    assert.ok(Buffer.byteLength(JSON.stringify(ex)) < payloads.ACTIVITY_MAX_BYTES);
  }
  const w = payloads.buildWidgets({ nowMs: 0 });
  assert.deepStrictEqual(w.payload, entryFor(2550, 'widgets-payload'));
  assert.strictEqual(w.pushType, 'widgets');
});

t('the section 5.4 event examples carry the topic of section 5.2 for their type', () => {
  const topics = { 'message.add': /^session:/, 'message.update': /^session:/, 'prompt.open': /^session:/, 'send.update': /^session:/, 'sessions.changed': /^sessions$/, 'tabs.updated': /^tabs$/, 'accounts.updated': /^accounts$/, 'migration.progress': /^migrations$/, 'upload.progress': /^device$/, 'computer.notice': /^computer$/ };
  const events = index.examples.filter((e) => e.schema && e.schema.startsWith('stream/events/'));
  assert.strictEqual(events.length, Object.keys(topics).length);
  for (const e of events) {
    const value = example(e.file);
    assert.match(value.topic, topics[value.type], e.file);
  }
});

H.run('b1-examples', tests);
