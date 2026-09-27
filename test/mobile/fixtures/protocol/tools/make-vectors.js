#!/usr/bin/env node
/**
 * make-vectors.js: writes protocol/vectors/pairing.json, the golden test
 * vectors for the mobile v2 signing format (MSF-2, PROTOCOL.md section 2.2).
 *
 * WHY: the phone (Swift, CryptoKit) and Workbook (Node, crypto) must produce
 * byte-identical signing inputs and must verify each other's raw r||s P-256
 * signatures. Both test suites load the same file: Swift proves it builds the
 * same bytes and verifies these signatures; Node (Workbook test suite and
 * verify-vectors.js) proves the same from its side.
 *
 * The keys below are TEST ONLY. They were generated once for these vectors,
 * are published in this repository on purpose, and must never be used by a
 * real computer or phone. ECDSA signing is randomized, so each run produces
 * new signature bytes; every other value (signing inputs, hashes, ids, match
 * code, QR link) is deterministic and must not change between runs.
 *
 * Usage: node protocol/tools/make-vectors.js
 * No dependencies beyond Node 20+ built-ins. Uses no double hyphens anywhere.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── TEST ONLY keys (JWK, P-256) ─────────────────────────────────────────────
// Never use these outside tests. They exist only to make the vectors real.
const TEST_KEYS = {
  computer: {
    kty: 'EC', crv: 'P-256',
    x: 'Ku21He1DQxIaZ1h68JI2zhlIn6M61DGlL9pm_5k_oOM',
    y: 'j_y_qi0qLG_hUAdXnj7_1hUEyEqAzJg3wFHq29xR0Ok',
    d: 'mFR3OnZJ4rCzSM2_gQICarUoEWwKOEGe7tuhFbe-m9Q',
  },
  device: {
    kty: 'EC', crv: 'P-256',
    x: 'VPoBmRP-ZQDDkgTDdViZfmnwwP-3nCUO5McRbiHav6k',
    y: 'S65YFZbFqVQarBhnLfMckigf7eKGCw4yNue3-yFg-jo',
    d: 'vfw8E0RydSoqfGkCiTdnkunbgz9kvokkCFm7WcjNfeA',
  },
  attacker: {
    kty: 'EC', crv: 'P-256',
    x: 'i8lP3cqJvHDY66HtWXp6uU3im3eYRCFr_0nO7AdPLNU',
    y: '0Vq3rWMad91O62Xtbs-eGYfeEcGFh6Ju5l6lm_BIIbg',
    d: 'vx8i4PQLi-ZN23KJAcRbDBQpFu3mLH58FHEDGxR1YDU',
  },
};

// ─── MSF-2: the canonical signing format (PROTOCOL.md 2.2) ──────────────────

const MSF_HEADER = 'myrlin-sig/2';

/**
 * Fixed field lists per purpose, in signing order. PROTOCOL.md section 2.2
 * table "Purposes" is the normative copy; this table must match it exactly.
 */
const PURPOSES = {
  'identity': ['computerId', 'computerPublicKey', 'name', 'workbookVersion', 'apiVersion', 'apiRevision', 'clientNonce', 'ts'],
  'pair-request': ['offerId', 'secretKind', 'secret', 'devicePublicKey', 'deviceName', 'model', 'osVersion', 'appVersion', 'deviceNonce', 'ts'],
  'pair-challenge': ['pairId', 'offerId', 'computerId', 'computerPublicKey', 'devicePublicKey', 'deviceNonce', 'serverNonce', 'expiresAtMs'],
  'match-code': ['computerPublicKey', 'devicePublicKey', 'deviceNonce', 'serverNonce'],
  'pair-response': ['pairId', 'computerId', 'deviceId', 'devicePublicKey', 'deviceName', 'scopes', 'computerName', 'endpoints', 'deviceNonce', 'pairedAtMs'],
  'hello-response': ['computerId', 'deviceId', 'clientNonce', 'serverNonce', 'streamEpoch', 'endpoints', 'apiVersion', 'apiRevision', 'ts'],
  'session-request': ['computerId', 'deviceId', 'serverNonce', 'clientNonce', 'ts'],
  'revoked': ['computerId', 'deviceId', 'clientNonce', 'revokedAtMs'],
};

/**
 * Encode one field value as its MSF-2 text. Throws on anything the format
 * forbids, so a bad value can never be signed by accident.
 * @param {string} name - field name (for error messages)
 * @param {*} value - string, safe integer, boolean, null, or array of strings
 * @returns {string}
 */
function encodeValue(name, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`MSF-2: ${name} is not a safe integer`);
    return String(value);
  }
  if (typeof value === 'string') {
    if (/[\n\r]/.test(value)) throw new Error(`MSF-2: ${name} contains a line break`);
    return value;
  }
  if (Array.isArray(value)) {
    for (const el of value) {
      if (typeof el !== 'string') throw new Error(`MSF-2: ${name} list element is not a string`);
      if (/[,\n\r]/.test(el)) throw new Error(`MSF-2: ${name} list element contains a comma or line break`);
    }
    return value.join(',');
  }
  throw new Error(`MSF-2: ${name} has an unsupported type`);
}

/**
 * Build the MSF-2 signing input bytes.
 * @param {string} purpose - key of PURPOSES
 * @param {Array<[string, *]>} fields - ordered [name, value] pairs
 * @returns {Buffer} UTF-8 bytes, lines joined by LF, no trailing LF
 */
function signingInput(purpose, fields) {
  const expected = PURPOSES[purpose];
  if (!expected) throw new Error(`MSF-2: unknown purpose ${purpose}`);
  const names = fields.map((f) => f[0]);
  if (names.join('|') !== expected.join('|')) {
    throw new Error(`MSF-2: ${purpose} fields must be ${expected.join(', ')}; got ${names.join(', ')}`);
  }
  const lines = [MSF_HEADER, purpose];
  for (const [name, value] of fields) lines.push(`${name}=${encodeValue(name, value)}`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ─── Key helpers ────────────────────────────────────────────────────────────

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function privateKeyFromJwk(jwk) {
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/** SPKI DER bytes of the public half of a JWK private key. */
function spkiDer(jwk) {
  const pub = crypto.createPublicKey(privateKeyFromJwk(jwk));
  return pub.export({ type: 'spki', format: 'der' });
}

/** base64url(SHA-256(SPKI DER)), 43 characters: the key fingerprint. */
function fingerprint(spki) {
  return b64u(sha256(spki));
}

/** "c_" or "d_" plus the first 20 characters of the fingerprint (15 bytes). */
function idFromSpki(prefix, spki) {
  return prefix + fingerprint(spki).slice(0, 20);
}

/**
 * Raw r||s (IEEE P1363) ECDSA P-256 SHA-256 signature, base64url.
 * ECDSA is randomized, so this re-signs (at most 64 times) until the text
 * holds no two consecutive hyphens: the repository bans that sequence in
 * every file, and any valid signature is as good as another.
 */
function sign(jwk, input) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const sig = crypto.sign('sha256', input, { key: privateKeyFromJwk(jwk), dsaEncoding: 'ieee-p1363' });
    if (sig.length !== 64) throw new Error('signature is not 64 bytes');
    const text = b64u(sig);
    if (!text.includes('-'.repeat(2))) return text;
  }
  throw new Error('could not produce a signature without a double hyphen');
}

function verify(spki, input, sigB64u) {
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64u, 'base64url'));
}

/** 4 digit match code (PROTOCOL.md 2.5). */
function matchCode(fields) {
  const input = signingInput('match-code', fields);
  const h = sha256(input);
  const n = h.readUInt32BE(0);
  return { input, sha256Hex: h.toString('hex'), uint32: n, code: String(n % 10000).padStart(4, '0') };
}

/** Deterministic byte ranges used as nonces and secrets in the vectors. */
function bytesFrom(start, count) {
  return Buffer.from(Array.from({ length: count }, (_, i) => (start + i) & 0xff));
}

// ─── Manual code (Crockford base32, PROTOCOL.md 2.3) ────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encode 5 bytes (40 bits) as 8 Crockford base32 characters. */
function manualCodeFromBytes(buf5) {
  let bits = 0n;
  for (const b of buf5) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i -= 1) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/** Normalize what a person typed into the 8 character canonical form. */
function normalizeManualCode(typed) {
  return typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

// ─── QR link (PROTOCOL.md 2.3) ──────────────────────────────────────────────

function buildQrLink(style, { offerId, secret, fingerprint: pk, name, endpoints }) {
  const base = style === 'universal' ? 'https://myrlin.io/p#' : 'myrlin://pair#';
  const enc = encodeURIComponent;
  const parts = [
    'v=2',
    `o=${enc(offerId)}`,
    `s=${enc(secret)}`,
    `pk=${enc(pk)}`,
    `n=${enc(name)}`,
    `e=${endpoints.map(enc).join(',')}`,
  ];
  return base + parts.join('&');
}

function parseQrLink(link) {
  const hash = link.indexOf('#');
  const frag = link.slice(hash + 1);
  const out = {};
  for (const pair of frag.split('&')) {
    const eq = pair.indexOf('=');
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    out[k] = k === 'e' ? (v === '' ? [] : v.split(',').map(decodeURIComponent)) : decodeURIComponent(v);
  }
  return out;
}

// ─── Build the vectors ──────────────────────────────────────────────────────

function main() {
  const computerSpki = spkiDer(TEST_KEYS.computer);
  const deviceSpki = spkiDer(TEST_KEYS.device);
  const attackerSpki = spkiDer(TEST_KEYS.attacker);

  const computerPublicKey = b64u(computerSpki);
  const devicePublicKey = b64u(deviceSpki);
  const computerId = idFromSpki('c_', computerSpki);
  const deviceId = idFromSpki('d_', deviceSpki);

  const offerId = b64u(bytesFrom(0xa0, 6));
  const qrSecret = b64u(bytesFrom(0x00, 32));
  const deviceNonce = b64u(bytesFrom(0x20, 32));
  const serverNonce = b64u(bytesFrom(0x40, 32));
  const clientNonce = b64u(bytesFrom(0x60, 32));
  const pairId = 'pr_' + b64u(bytesFrom(0x80, 16));
  const streamEpoch = 'e_' + b64u(bytesFrom(0x90, 12));
  const manualCode = manualCodeFromBytes(bytesFrom(0xb0, 5));

  const ts = 1790000000000;
  const endpoints = ['https://studio-1.tailnet-example.ts.net', 'http://127.0.0.1:3458'];
  const scopes = ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage'];
  const deviceName = 'Sam’s iPhone';
  const computerName = 'STUDIO-PC';

  const specs = [
    {
      name: 'identity-response',
      purpose: 'identity',
      signer: 'computer',
      fields: [
        ['computerId', computerId], ['computerPublicKey', computerPublicKey], ['name', computerName],
        ['workbookVersion', '1.4.0-alpha.1'], ['apiVersion', 2], ['apiRevision', 0],
        ['clientNonce', clientNonce], ['ts', ts],
      ],
    },
    {
      name: 'pair-request-qr',
      purpose: 'pair-request',
      signer: 'device',
      fields: [
        ['offerId', offerId], ['secretKind', 'qr'], ['secret', qrSecret], ['devicePublicKey', devicePublicKey],
        ['deviceName', deviceName], ['model', 'iPhone17,2'], ['osVersion', '26.1'], ['appVersion', '1.0.0 (1)'],
        ['deviceNonce', deviceNonce], ['ts', ts + 1000],
      ],
    },
    {
      name: 'pair-request-code',
      purpose: 'pair-request',
      signer: 'device',
      fields: [
        ['offerId', null], ['secretKind', 'code'], ['secret', manualCode], ['devicePublicKey', devicePublicKey],
        ['deviceName', deviceName], ['model', 'iPhone17,2'], ['osVersion', '26.1'], ['appVersion', '1.0.0 (1)'],
        ['deviceNonce', deviceNonce], ['ts', ts + 1000],
      ],
    },
    {
      name: 'pair-challenge',
      purpose: 'pair-challenge',
      signer: 'computer',
      fields: [
        ['pairId', pairId], ['offerId', offerId], ['computerId', computerId], ['computerPublicKey', computerPublicKey],
        ['devicePublicKey', devicePublicKey], ['deviceNonce', deviceNonce], ['serverNonce', serverNonce],
        ['expiresAtMs', ts + 121000],
      ],
    },
    {
      name: 'pair-response',
      purpose: 'pair-response',
      signer: 'computer',
      fields: [
        ['pairId', pairId], ['computerId', computerId], ['deviceId', deviceId], ['devicePublicKey', devicePublicKey],
        ['deviceName', deviceName], ['scopes', scopes], ['computerName', computerName], ['endpoints', endpoints],
        ['deviceNonce', deviceNonce], ['pairedAtMs', ts + 15000],
      ],
    },
    {
      name: 'hello-response',
      purpose: 'hello-response',
      signer: 'computer',
      fields: [
        ['computerId', computerId], ['deviceId', deviceId], ['clientNonce', clientNonce], ['serverNonce', serverNonce],
        ['streamEpoch', streamEpoch], ['endpoints', endpoints], ['apiVersion', 2], ['apiRevision', 0], ['ts', ts + 60000],
      ],
    },
    {
      name: 'session-request',
      purpose: 'session-request',
      signer: 'device',
      fields: [
        ['computerId', computerId], ['deviceId', deviceId], ['serverNonce', serverNonce],
        ['clientNonce', clientNonce], ['ts', ts + 60500],
      ],
    },
    {
      name: 'revoked',
      purpose: 'revoked',
      signer: 'computer',
      fields: [
        ['computerId', computerId], ['deviceId', deviceId], ['clientNonce', clientNonce], ['revokedAtMs', ts + 86400000],
      ],
    },
  ];

  const pubOf = { computer: computerSpki, device: deviceSpki, attacker: attackerSpki };
  const vectors = [];
  for (const spec of specs) {
    const input = signingInput(spec.purpose, spec.fields);
    const signature = sign(TEST_KEYS[spec.signer], input);
    if (!verify(pubOf[spec.signer], input, signature)) throw new Error(`self check failed for ${spec.name}`);
    vectors.push({
      name: spec.name,
      purpose: spec.purpose,
      signer: spec.signer,
      verifyWith: spec.signer,
      expectValid: true,
      fields: spec.fields,
      signingInputUtf8: input.toString('utf8'),
      signingInputB64u: b64u(input),
      signingInputLength: input.length,
      sha256Hex: sha256(input).toString('hex'),
      signature,
    });
  }

  // Negative vectors: the verifier must reject each of these.
  const sessionSpec = specs.find((s) => s.name === 'session-request');
  const sessionVector = vectors.find((v) => v.name === 'session-request');
  const tamperedFields = sessionSpec.fields.map(([k, v]) => [k, k === 'ts' ? v + 1 : v]);
  const tamperedInput = signingInput('session-request', tamperedFields);
  vectors.push({
    name: 'session-request-tampered-ts',
    purpose: 'session-request',
    signer: 'device',
    verifyWith: 'device',
    expectValid: false,
    note: 'Fields changed after signing (ts plus 1); the signature from session-request must not verify.',
    fields: tamperedFields,
    signingInputUtf8: tamperedInput.toString('utf8'),
    signingInputB64u: b64u(tamperedInput),
    signingInputLength: tamperedInput.length,
    sha256Hex: sha256(tamperedInput).toString('hex'),
    signature: sessionVector.signature,
  });

  const helloSpec = specs.find((s) => s.name === 'hello-response');
  const helloInput = signingInput('hello-response', helloSpec.fields);
  const forged = sign(TEST_KEYS.attacker, helloInput);
  vectors.push({
    name: 'hello-response-wrong-key',
    purpose: 'hello-response',
    signer: 'attacker',
    verifyWith: 'computer',
    expectValid: false,
    note: 'Signed by a key that is not the pinned computer key; the phone must reject it.',
    fields: helloSpec.fields,
    signingInputUtf8: helloInput.toString('utf8'),
    signingInputB64u: b64u(helloInput),
    signingInputLength: helloInput.length,
    sha256Hex: sha256(helloInput).toString('hex'),
    signature: forged,
  });

  const mcFields = [
    ['computerPublicKey', computerPublicKey], ['devicePublicKey', devicePublicKey],
    ['deviceNonce', deviceNonce], ['serverNonce', serverNonce],
  ];
  const mc = matchCode(mcFields);
  // A man in the middle substitutes its own key toward the phone: the codes differ.
  const mcAttack = matchCode([
    ['computerPublicKey', b64u(attackerSpki)], ['devicePublicKey', devicePublicKey],
    ['deviceNonce', deviceNonce], ['serverNonce', serverNonce],
  ]);

  const qrInputs = { offerId, secret: qrSecret, fingerprint: fingerprint(computerSpki), name: computerName, endpoints };
  const qrScheme = buildQrLink('scheme', qrInputs);
  const qrUniversal = buildQrLink('universal', qrInputs);

  const out = {
    testOnly: true,
    warning: 'TEST ONLY. Every key in this file is public and must never be used by a real computer or phone.',
    format: MSF_HEADER,
    spec: 'docs/plans/PROTOCOL.md section 2',
    generator: 'protocol/tools/make-vectors.js',
    verifier: 'protocol/tools/verify-vectors.js',
    notes: [
      'ECDSA signatures are randomized: signature bytes change on every run of the generator; every other value is deterministic.',
      'Signatures are raw r||s (IEEE P1363), 64 bytes, base64url without padding.',
      'Public keys are SPKI DER, base64url without padding (91 bytes for P-256 uncompressed).',
      'Field values in "fields" are typed JSON: strings, integers, booleans, null, or arrays of strings.',
    ],
    purposes: PURPOSES,
    keys: {
      computer: {
        testOnly: true,
        jwk: TEST_KEYS.computer,
        spkiDerB64u: computerPublicKey,
        fingerprint: fingerprint(computerSpki),
        computerId,
      },
      device: {
        testOnly: true,
        jwk: TEST_KEYS.device,
        spkiDerB64u: devicePublicKey,
        fingerprint: fingerprint(deviceSpki),
        deviceId,
      },
      attacker: {
        testOnly: true,
        jwk: TEST_KEYS.attacker,
        spkiDerB64u: b64u(attackerSpki),
        fingerprint: fingerprint(attackerSpki),
      },
    },
    values: {
      offerId, qrSecret, deviceNonce, serverNonce, clientNonce, pairId, streamEpoch, manualCode,
      ts, endpoints, scopes, deviceName, computerName,
    },
    vectors,
    matchCode: {
      purpose: 'match-code',
      fields: mcFields,
      signingInputUtf8: mc.input.toString('utf8'),
      signingInputB64u: b64u(mc.input),
      sha256Hex: mc.sha256Hex,
      uint32: mc.uint32,
      code: mc.code,
      mitmCode: mcAttack.code,
      mitmNote: 'The code the phone would show if a man in the middle replaced the computer key with the attacker key. It differs from "code".',
    },
    manualCode: {
      bytesHex: bytesFrom(0xb0, 5).toString('hex'),
      code: manualCode,
      display: manualCode.slice(0, 4) + '-' + manualCode.slice(4),
      alphabet: CROCKFORD,
      normalizes: [
        { typed: manualCode.slice(0, 4).toLowerCase() + ' ' + manualCode.slice(4).toLowerCase(), normalized: manualCode },
        { typed: manualCode.slice(0, 4) + '-' + manualCode.slice(4), normalized: manualCode },
        { typed: 'o1il-OOOO', normalized: normalizeManualCode('o1il-OOOO') },
      ],
    },
    qr: {
      scheme: { link: qrScheme, lengthChars: qrScheme.length, parsed: parseQrLink(qrScheme) },
      universal: { link: qrUniversal, lengthChars: qrUniversal.length, parsed: parseQrLink(qrUniversal) },
      maxLengthChars: 300,
    },
  };

  const dest = path.join(__dirname, '..', 'vectors', 'pairing.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), dest)}: ${vectors.length} vectors, match code ${mc.code}, QR ${qrScheme.length} chars`);
}

module.exports = {
  MSF_HEADER, PURPOSES, encodeValue, signingInput, fingerprint, idFromSpki, sign, verify,
  matchCode, manualCodeFromBytes, normalizeManualCode, buildQrLink, parseQrLink, CROCKFORD,
};

if (require.main === module) main();
