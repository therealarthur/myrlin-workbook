/**
 * b1-signing.test.js: signing.js against every golden vector in the vendored
 * protocol/vectors/pairing.json, byte for byte (BUILD-CONTRACT 3.5.2).
 *
 * WHY: the phone and Workbook must build identical MSF-2 signing inputs and
 * verify each other's signatures. This proves Workbook's side: signing inputs
 * match signingInputB64u exactly, the signatures verify (and the two negative
 * vectors fail), ids and the match code recompute, both QR links parse, and a
 * signature Workbook makes is accepted by the independent verifier logic of
 * protocol/tools/verify-vectors.js.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const signing = require('../../src/web/mobile/signing');

const VECTORS_FILE = path.join(H.PROTOCOL_DIR, 'vectors', 'pairing.json');
const doc = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8'));

/** SPKI of a vector key. */
function spkiOf(name) {
  return Buffer.from(doc.keys[name].spkiDerB64u, 'base64url');
}

/**
 * The independent verifier of protocol/tools/verify-vectors.js, restated: it
 * rebuilds the input its own way and verifies with Node's raw P1363 decoding.
 */
function independentVerify(spkiB64u, purpose, fields, sig) {
  const lines = ['myrlin-sig/2', purpose].concat(fields.map(([n, v]) => {
    let text;
    if (v === null) text = '';
    else if (v === true || v === false) text = String(v);
    else if (Array.isArray(v)) text = v.join(',');
    else text = String(v);
    return n + '=' + text;
  }));
  const key = crypto.createPublicKey({ key: Buffer.from(spkiB64u, 'base64url'), format: 'der', type: 'spki' });
  return crypto.verify('sha256', Buffer.from(lines.join('\n'), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
}

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('the vendored vectors file is the byte copy verify-vectors.js accepts', () => {
  const r = spawnSync(process.execPath, [path.join(H.PROTOCOL_DIR, 'tools', 'verify-vectors.js'), VECTORS_FILE], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /131\/131 checks passed/);
});

t('the purpose table equals the vectors table', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(signing.PURPOSES)), doc.purposes);
});

for (const v of doc.vectors) {
  t('vector ' + v.name + ': signing input is byte identical', () => {
    const input = signing.signingInput(v.purpose, v.fields);
    assert.strictEqual(input.toString('base64url'), v.signingInputB64u);
    assert.strictEqual(input.toString('utf8'), v.signingInputUtf8);
    assert.strictEqual(input.length, v.signingInputLength);
    assert.strictEqual(signing.sha256(input).toString('hex'), v.sha256Hex);
    // The object form builds the same bytes.
    const obj = Object.fromEntries(v.fields);
    assert.ok(signing.signingInput(v.purpose, obj).equals(input));
  });
  t('vector ' + v.name + ': signature verifies exactly when expectValid (' + v.expectValid + ')', () => {
    assert.strictEqual(signing.isRawSignature(v.signature), true);
    assert.strictEqual(signing.verify(doc.keys[v.verifyWith].spkiDerB64u, v.purpose, v.fields, v.signature), v.expectValid);
  });
}

t('the two negative vectors exist and fail', () => {
  const neg = doc.vectors.filter((v) => !v.expectValid);
  assert.strictEqual(neg.length, 2);
  for (const v of neg) assert.strictEqual(signing.verify(doc.keys[v.verifyWith].spkiDerB64u, v.purpose, v.fields, v.signature), false);
});

t('computerId, deviceId and fingerprints recompute from the SPKI', () => {
  assert.strictEqual(signing.computerIdFromSpki(spkiOf('computer')), doc.keys.computer.computerId);
  assert.strictEqual(signing.deviceIdFromSpki(spkiOf('device')), doc.keys.device.deviceId);
  for (const k of Object.keys(doc.keys)) assert.strictEqual(signing.fingerprint(spkiOf(k)), doc.keys[k].fingerprint);
});

t('parsePublicKey accepts the canonical vector keys and refuses non canonical ones', () => {
  for (const k of Object.keys(doc.keys)) assert.ok(signing.parsePublicKey(doc.keys[k].spkiDerB64u));
  assert.strictEqual(signing.parsePublicKey(doc.keys.device.spkiDerB64u + 'A'), null);
  assert.strictEqual(signing.parsePublicKey('not-a-key'), null);
  // A compressed point is not canonical.
  const key = crypto.createPublicKey({ key: spkiOf('device'), format: 'der', type: 'spki' });
  const jwk = key.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const yOdd = Buffer.from(jwk.y, 'base64url')[31] & 1;
  const compressedSpki = Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([2 + yOdd]), x]);
  assert.strictEqual(signing.parsePublicKey(compressedSpki.toString('base64url')), null);
  // Another curve is refused.
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
  assert.strictEqual(signing.parsePublicKey(other.toString('base64url')), null);
});

t('the match code and its intermediates recompute, and differ under a man in the middle', () => {
  const mc = signing.matchCode(doc.matchCode.fields);
  assert.strictEqual(mc.input.toString('base64url'), doc.matchCode.signingInputB64u);
  assert.strictEqual(mc.sha256Hex, doc.matchCode.sha256Hex);
  assert.strictEqual(mc.uint32, doc.matchCode.uint32);
  assert.strictEqual(mc.code, doc.matchCode.code);
  const attacked = signing.matchCode(doc.matchCode.fields.map(([k, v]) => [k, k === 'computerPublicKey' ? doc.keys.attacker.spkiDerB64u : v]));
  assert.strictEqual(attacked.code, doc.matchCode.mitmCode);
  assert.notStrictEqual(attacked.code, mc.code);
});

t('the manual code encodes, displays and normalizes like the vectors', () => {
  assert.strictEqual(signing.CROCKFORD, doc.manualCode.alphabet);
  assert.strictEqual(signing.manualCodeFromBytes(Buffer.from(doc.manualCode.bytesHex, 'hex')), doc.manualCode.code);
  assert.strictEqual(signing.displayManualCode(doc.manualCode.code), doc.manualCode.display);
  for (const n of doc.manualCode.normalizes) assert.strictEqual(signing.normalizeManualCode(n.typed), n.normalized);
  for (let i = 0; i < 50; i += 1) assert.match(signing.newManualCode(), /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
});

t('both QR links build byte identical and parse back', () => {
  const values = {
    offerId: doc.values.offerId, secret: doc.values.qrSecret, fingerprint: doc.keys.computer.fingerprint,
    name: doc.values.computerName, endpoints: doc.values.endpoints,
  };
  for (const style of ['scheme', 'universal']) {
    const link = signing.buildQrLink(style, values);
    assert.strictEqual(link, doc.qr[style].link);
    assert.strictEqual(link.length, doc.qr[style].lengthChars);
    assert.deepStrictEqual(signing.parseQrLink(link), doc.qr[style].parsed);
    assert.strictEqual(signing.buildFittingQrLink(style, values), link);
  }
});

t('buildFittingQrLink drops endpoints, then shortens the name, to fit 300 characters', () => {
  const long = Array.from({ length: 5 }, (_, i) => 'https://very-long-machine-name-number-' + i + '.tailnet-example.ts.net');
  const link = signing.buildFittingQrLink('scheme', {
    offerId: doc.values.offerId, secret: doc.values.qrSecret, fingerprint: doc.keys.computer.fingerprint,
    name: 'A computer name that is much longer than thirty two characters', endpoints: long,
  });
  assert.ok(link.length <= 300, 'length ' + link.length);
  const p = signing.parseQrLink(link);
  assert.ok(p.e.length < 5);
  assert.ok(Array.from(p.n).length <= 32);
  assert.strictEqual(p.v, '2');
});

t('Workbook signs its own inputs and the independent verifier accepts them', () => {
  const jwk = doc.keys.computer.jwk;
  const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  for (const v of doc.vectors.filter((x) => x.signer === 'computer' && x.expectValid)) {
    const sig = signing.sign(priv, v.purpose, v.fields);
    assert.strictEqual(sig.length, 86);
    assert.ok(independentVerify(doc.keys.computer.spkiDerB64u, v.purpose, v.fields, sig), v.name);
  }
  // And a fresh key's signature is refused under the pinned computer key.
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const hello = doc.vectors.find((x) => x.name === 'hello-response');
  assert.strictEqual(independentVerify(doc.keys.computer.spkiDerB64u, 'hello-response', hello.fields, signing.sign(other, 'hello-response', hello.fields)), false);
});

t('encodeValue refuses line breaks, commas in lists and unsafe integers', () => {
  assert.throws(() => signing.encodeValue('x', 'a\nb'));
  assert.throws(() => signing.encodeValue('x', ['a,b']));
  assert.throws(() => signing.encodeValue('x', 2 ** 60));
  assert.strictEqual(signing.encodeValue('x', null), '');
  assert.strictEqual(signing.encodeValue('x', false), 'false');
  assert.strictEqual(signing.encodeValue('x', []), '');
});

t('DER encoded signatures are not raw signatures', () => {
  const priv = crypto.createPrivateKey({ key: doc.keys.device.jwk, format: 'jwk' });
  const der = crypto.sign('sha256', Buffer.from('x'), priv).toString('base64url');
  assert.strictEqual(signing.isRawSignature(der), false);
});

H.run('b1-signing', tests);
