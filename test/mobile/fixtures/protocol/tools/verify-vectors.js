#!/usr/bin/env node
/**
 * verify-vectors.js: re-verifies every golden vector in
 * protocol/vectors/pairing.json with an implementation written separately
 * from make-vectors.js, so a bug in one cannot hide in the other.
 *
 * Checks, for every vector:
 *   1. The MSF-2 signing input rebuilt from "fields" equals signingInputB64u,
 *      signingInputUtf8 and signingInputLength byte for byte.
 *   2. sha256Hex equals SHA-256 of those bytes.
 *   3. The field names follow the purpose table in order.
 *   4. The raw r||s signature verifies with the "verifyWith" key exactly when
 *      expectValid is true.
 * Plus: SPKI encodings and ids derive from the JWKs, SPKI is canonical
 * (re-export equals input), the match code recomputes (and differs under a
 * man in the middle), the manual code alphabet and normalization, and the QR
 * links parse back to the published values within the 300 character budget.
 *
 * Usage: node protocol/tools/verify-vectors.js [path/to/pairing.json]
 * Exit code 0 when every check passes, 1 otherwise.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'vectors', 'pairing.json');
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

let failures = 0;
let checks = 0;
function check(ok, label) {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${label}`);
  }
}

// Independent MSF-2 encoder (PROTOCOL.md 2.2).
function field(name, value) {
  let text;
  if (value === null) text = '';
  else if (value === true) text = 'true';
  else if (value === false) text = 'false';
  else if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error('bad integer ' + name);
    text = value.toString(10);
  } else if (typeof value === 'string') {
    if (value.includes('\n') || value.includes('\r')) throw new Error('line break in ' + name);
    text = value;
  } else if (Array.isArray(value)) {
    value.forEach((el) => {
      if (typeof el !== 'string' || /[,\r\n]/.test(el)) throw new Error('bad list element in ' + name);
    });
    text = value.join(',');
  } else {
    throw new Error('bad type for ' + name);
  }
  return name + '=' + text;
}

function msf2(purpose, fields) {
  const lines = ['myrlin-sig/2', purpose].concat(fields.map(([n, v]) => field(n, v)));
  return Buffer.from(lines.join('\n'), 'utf8');
}

const EXPECTED_PURPOSES = {
  'identity': 'computerId computerPublicKey name workbookVersion apiVersion apiRevision clientNonce ts',
  'pair-request': 'offerId secretKind secret devicePublicKey deviceName model osVersion appVersion deviceNonce ts',
  'pair-challenge': 'pairId offerId computerId computerPublicKey devicePublicKey deviceNonce serverNonce expiresAtMs',
  'match-code': 'computerPublicKey devicePublicKey deviceNonce serverNonce',
  'pair-response': 'pairId computerId deviceId devicePublicKey deviceName scopes computerName endpoints deviceNonce pairedAtMs',
  'hello-response': 'computerId deviceId clientNonce serverNonce streamEpoch endpoints apiVersion apiRevision ts',
  'session-request': 'computerId deviceId serverNonce clientNonce ts',
  'revoked': 'computerId deviceId clientNonce revokedAtMs',
};

// Purpose table in the file must match the independent copy.
for (const [purpose, names] of Object.entries(EXPECTED_PURPOSES)) {
  check(doc.purposes[purpose] && doc.purposes[purpose].join(' ') === names, `purpose table ${purpose}`);
}
check(Object.keys(doc.purposes).length === Object.keys(EXPECTED_PURPOSES).length, 'purpose count');

// Keys: SPKI from JWK, canonical re-export, fingerprint and ids.
const spkiOf = {};
for (const [name, key] of Object.entries(doc.keys)) {
  check(key.testOnly === true, `key ${name} is marked testOnly`);
  const priv = crypto.createPrivateKey({ key: key.jwk, format: 'jwk' });
  const spki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  spkiOf[name] = spki;
  check(spki.toString('base64url') === key.spkiDerB64u, `key ${name} SPKI matches JWK`);
  check(spki.length === 91, `key ${name} SPKI is 91 bytes`);
  const reparsed = crypto.createPublicKey({ key: Buffer.from(key.spkiDerB64u, 'base64url'), format: 'der', type: 'spki' })
    .export({ type: 'spki', format: 'der' });
  check(reparsed.equals(spki), `key ${name} SPKI is canonical`);
  const fp = crypto.createHash('sha256').update(spki).digest('base64url');
  check(fp === key.fingerprint && fp.length === 43, `key ${name} fingerprint`);
  if (key.computerId) check(key.computerId === 'c_' + fp.slice(0, 20), 'computerId derivation');
  if (key.deviceId) check(key.deviceId === 'd_' + fp.slice(0, 20), 'deviceId derivation');
  // The 20 character prefix must equal base64url of the first 15 hash bytes.
  const first15 = crypto.createHash('sha256').update(spki).digest().subarray(0, 15).toString('base64url');
  check(first15 === fp.slice(0, 20), `key ${name} id prefix equals base64url(first 15 bytes)`);
}

// Signature vectors.
for (const v of doc.vectors) {
  const names = v.fields.map((f) => f[0]).join(' ');
  check(names === EXPECTED_PURPOSES[v.purpose], `${v.name} field order`);
  const input = msf2(v.purpose, v.fields);
  check(input.toString('base64url') === v.signingInputB64u, `${v.name} signing input bytes`);
  check(input.toString('utf8') === v.signingInputUtf8, `${v.name} signing input text`);
  check(input.length === v.signingInputLength, `${v.name} signing input length`);
  check(crypto.createHash('sha256').update(input).digest('hex') === v.sha256Hex, `${v.name} sha256`);
  const sig = Buffer.from(v.signature, 'base64url');
  check(sig.length === 64 && v.signature.length === 86, `${v.name} signature is 64 raw bytes`);
  const key = crypto.createPublicKey({ key: spkiOf[v.verifyWith], format: 'der', type: 'spki' });
  const ok = crypto.verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig);
  check(ok === v.expectValid, `${v.name} verifies=${ok}, expected ${v.expectValid}`);
}
check(doc.vectors.filter((v) => v.expectValid).length >= 8, 'at least eight positive vectors');
check(doc.vectors.filter((v) => !v.expectValid).length >= 2, 'at least two negative vectors');

// Match code.
const mcInput = msf2('match-code', doc.matchCode.fields);
check(mcInput.toString('base64url') === doc.matchCode.signingInputB64u, 'match code input bytes');
const mcHash = crypto.createHash('sha256').update(mcInput).digest();
check(mcHash.toString('hex') === doc.matchCode.sha256Hex, 'match code sha256');
const n = mcHash.readUInt32BE(0);
check(n === doc.matchCode.uint32, 'match code uint32');
check(String(n % 10000).padStart(4, '0') === doc.matchCode.code && /^\d{4}$/.test(doc.matchCode.code), 'match code digits');
check(doc.matchCode.mitmCode !== doc.matchCode.code, 'match code changes under a substituted key');

// Manual code.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
check(doc.manualCode.alphabet === ALPHABET, 'manual code alphabet');
check(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(doc.manualCode.code), 'manual code shape');
let bits = BigInt('0x' + doc.manualCode.bytesHex);
let code = '';
for (let i = 7; i >= 0; i -= 1) code += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
check(code === doc.manualCode.code, 'manual code from bytes');
check(doc.manualCode.display === code.slice(0, 4) + '-' + code.slice(4), 'manual code display form');
for (const t of doc.manualCode.normalizes) {
  const norm = t.typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  check(norm === t.normalized, `manual code normalizes "${t.typed}"`);
}

// QR links.
for (const style of ['scheme', 'universal']) {
  const q = doc.qr[style];
  check(q.link.length === q.lengthChars && q.lengthChars <= doc.qr.maxLengthChars, `QR ${style} length within budget`);
  check(q.link.startsWith(style === 'scheme' ? 'myrlin://pair#' : 'https://myrlin.io/p#'), `QR ${style} prefix`);
  const frag = q.link.slice(q.link.indexOf('#') + 1);
  const parsed = {};
  frag.split('&').forEach((pair) => {
    const i = pair.indexOf('=');
    const k = pair.slice(0, i);
    const val = pair.slice(i + 1);
    parsed[k] = k === 'e' ? val.split(',').map(decodeURIComponent) : decodeURIComponent(val);
  });
  check(parsed.v === '2', `QR ${style} version`);
  check(parsed.o === doc.values.offerId, `QR ${style} offer id`);
  check(parsed.s === doc.values.qrSecret, `QR ${style} secret`);
  check(parsed.pk === doc.keys.computer.fingerprint, `QR ${style} key fingerprint`);
  check(parsed.n === doc.values.computerName, `QR ${style} name`);
  check(JSON.stringify(parsed.e) === JSON.stringify(doc.values.endpoints), `QR ${style} endpoints`);
  check(JSON.stringify(parsed) === JSON.stringify(q.parsed), `QR ${style} parsed copy`);
}

console.log(`${checks - failures}/${checks} checks passed in ${path.relative(process.cwd(), file)}`);
process.exit(failures === 0 ? 0 : 1);
