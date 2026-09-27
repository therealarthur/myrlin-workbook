/**
 * signing.js: MSF-2, the canonical signing format of mobile v2, plus the ids,
 * the match code, the manual code and the QR link that derive from it.
 *
 * WHY: the phone (CryptoKit) and Workbook (Node crypto) must build byte
 * identical signing inputs and verify each other's raw r||s P-256 signatures
 * (PROTOCOL.md 2.2). This is a port of protocol/tools/make-vectors.js from the
 * iOS repository; test/mobile/b1-signing.test.js proves it against every
 * golden vector in protocol/vectors/pairing.json.
 */
'use strict';

const crypto = require('crypto');

/** Line 1 of every signing input. */
const MSF_HEADER = 'myrlin-sig/2';

/** Fixed field lists per purpose, in signing order (PROTOCOL.md 2.2). */
const PURPOSES = Object.freeze({
  'identity': ['computerId', 'computerPublicKey', 'name', 'workbookVersion', 'apiVersion', 'apiRevision', 'clientNonce', 'ts'],
  'pair-request': ['offerId', 'secretKind', 'secret', 'devicePublicKey', 'deviceName', 'model', 'osVersion', 'appVersion', 'deviceNonce', 'ts'],
  'pair-challenge': ['pairId', 'offerId', 'computerId', 'computerPublicKey', 'devicePublicKey', 'deviceNonce', 'serverNonce', 'expiresAtMs'],
  'match-code': ['computerPublicKey', 'devicePublicKey', 'deviceNonce', 'serverNonce'],
  'pair-response': ['pairId', 'computerId', 'deviceId', 'devicePublicKey', 'deviceName', 'scopes', 'computerName', 'endpoints', 'deviceNonce', 'pairedAtMs'],
  'hello-response': ['computerId', 'deviceId', 'clientNonce', 'serverNonce', 'streamEpoch', 'endpoints', 'apiVersion', 'apiRevision', 'ts'],
  'session-request': ['computerId', 'deviceId', 'serverNonce', 'clientNonce', 'ts'],
  'revoked': ['computerId', 'deviceId', 'clientNonce', 'revokedAtMs'],
});

/** Bytes in a nonce, a QR secret and a session token (PROTOCOL.md 2.2, 2.9). */
const NONCE_BYTES = 32;
/** Characters of a base64url nonce. */
const NONCE_CHARS = 43;
/** Raw r||s signature length in bytes. */
const SIGNATURE_BYTES = 64;
/** base64url characters of a raw signature. */
const SIGNATURE_CHARS = 86;
/** SPKI DER length of an uncompressed P-256 key. */
const SPKI_BYTES = 91;
/** Characters of the fingerprint prefix used in ids. */
const ID_PREFIX_CHARS = 20;
/** Offer id: 6 random bytes. */
const OFFER_ID_BYTES = 6;
/** Pair id: 16 random bytes. */
const PAIR_ID_BYTES = 16;
/** Stream epoch: 12 random bytes. */
const EPOCH_BYTES = 12;
/** Manual code: 40 random bits. */
const MANUAL_CODE_BYTES = 5;
/** Manual code length in characters. */
const MANUAL_CODE_CHARS = 8;
/** Match code digits. */
const MATCH_CODE_MODULUS = 10000;
/** Maximum QR link length (PROTOCOL.md 2.3). */
const QR_MAX_CHARS = 300;
/** Maximum computer name length inside a QR link before encoding. */
const QR_NAME_MAX_CHARS = 32;

/** Crockford base32 alphabet (PROTOCOL.md 2.3). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * base64url without padding.
 *
 * @param {Buffer|Uint8Array} buf - Bytes.
 * @returns {string}
 */
function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * SHA-256 digest.
 *
 * @param {Buffer|string} data - Input.
 * @returns {Buffer}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Encode one field value as its MSF-2 text. Throws on anything the format
 * forbids, so a bad value can never be signed by accident.
 *
 * @param {string} name - Field name (for error messages).
 * @param {*} value - String, safe integer, boolean, null, or array of strings.
 * @returns {string}
 */
function encodeValue(name, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('MSF-2: ' + name + ' is not a safe integer');
    return String(value);
  }
  if (typeof value === 'string') {
    if (/[\n\r]/.test(value)) throw new Error('MSF-2: ' + name + ' contains a line break');
    return value;
  }
  if (Array.isArray(value)) {
    for (const el of value) {
      if (typeof el !== 'string') throw new Error('MSF-2: ' + name + ' list element is not a string');
      if (/[,\n\r]/.test(el)) throw new Error('MSF-2: ' + name + ' list element contains a comma or line break');
    }
    return value.join(',');
  }
  throw new Error('MSF-2: ' + name + ' has an unsupported type');
}

/**
 * Turn an object into the ordered [name, value] pairs of a purpose.
 *
 * @param {string} purpose - Key of PURPOSES.
 * @param {object} obj - Values by field name (missing values sign as empty).
 * @returns {Array<[string, *]>}
 */
function fieldsFor(purpose, obj) {
  const names = PURPOSES[purpose];
  if (!names) throw new Error('MSF-2: unknown purpose ' + purpose);
  return names.map((n) => [n, obj[n] === undefined ? null : obj[n]]);
}

/**
 * Build the MSF-2 signing input bytes.
 *
 * @param {string} purpose - Key of PURPOSES.
 * @param {Array<[string, *]>|object} fields - Ordered pairs, or an object.
 * @returns {Buffer} UTF-8 bytes, lines joined by LF, no trailing LF.
 */
function signingInput(purpose, fields) {
  const expected = PURPOSES[purpose];
  if (!expected) throw new Error('MSF-2: unknown purpose ' + purpose);
  const pairs = Array.isArray(fields) ? fields : fieldsFor(purpose, fields);
  const names = pairs.map((f) => f[0]);
  if (names.join('|') !== expected.join('|')) {
    throw new Error('MSF-2: ' + purpose + ' fields must be ' + expected.join(', ') + '; got ' + names.join(', '));
  }
  const lines = [MSF_HEADER, purpose];
  for (const [name, value] of pairs) lines.push(name + '=' + encodeValue(name, value));
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Whether a string is a well formed raw signature: 86 base64url characters
 * that decode to exactly 64 bytes. DER signatures fail this check.
 *
 * @param {*} sig - Candidate.
 * @returns {boolean}
 */
function isRawSignature(sig) {
  if (typeof sig !== 'string' || sig.length !== SIGNATURE_CHARS || !B64URL_RE.test(sig)) return false;
  return Buffer.from(sig, 'base64url').length === SIGNATURE_BYTES;
}

/**
 * Sign a purpose's fields with a private key (ES256, raw r||s, base64url).
 *
 * @param {crypto.KeyObject} privateKey - P-256 private key.
 * @param {string} purpose - Key of PURPOSES.
 * @param {Array<[string, *]>|object} fields - Ordered pairs or an object.
 * @returns {string} 86 character signature.
 */
function sign(privateKey, purpose, fields) {
  const input = signingInput(purpose, fields);
  const sig = crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return b64u(sig);
}

/**
 * Verify a raw signature over a purpose's fields.
 *
 * @param {crypto.KeyObject|string} publicKey - KeyObject, or SPKI DER base64url.
 * @param {string} purpose - Key of PURPOSES.
 * @param {Array<[string, *]>|object} fields - Ordered pairs or an object.
 * @param {string} sig - base64url raw signature.
 * @returns {boolean} False for a wrong signature, a malformed one, or bad fields.
 */
function verify(publicKey, purpose, fields, sig) {
  if (!isRawSignature(sig)) return false;
  let input;
  try {
    input = signingInput(purpose, fields);
  } catch (_) {
    return false;
  }
  try {
    const key = typeof publicKey === 'string'
      ? crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
      : publicKey;
    return crypto.verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  } catch (_) {
    return false;
  }
}

/**
 * Parse a public key sent as SPKI DER base64url and prove it is canonical:
 * a P-256 key whose re-export is byte identical (PROTOCOL.md 2.1).
 *
 * @param {*} text - Candidate base64url SPKI.
 * @returns {{key: crypto.KeyObject, spki: Buffer}|null} Null when not canonical.
 */
function parsePublicKey(text) {
  if (typeof text !== 'string' || !B64URL_RE.test(text) || text.length === 0) return null;
  const der = Buffer.from(text, 'base64url');
  if (der.length !== SPKI_BYTES || b64u(der) !== text) return null;
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return null;
    const details = key.asymmetricKeyDetails || {};
    if (details.namedCurve && details.namedCurve !== 'prime256v1') return null;
    const re = key.export({ type: 'spki', format: 'der' });
    if (!re.equals(der)) return null;
    return { key, spki: der };
  } catch (_) {
    return null;
  }
}

/**
 * base64url(SHA-256(SPKI DER)), 43 characters.
 *
 * @param {Buffer|string} spki - DER bytes or their base64url text.
 * @returns {string}
 */
function fingerprint(spki) {
  const der = typeof spki === 'string' ? Buffer.from(spki, 'base64url') : spki;
  return b64u(sha256(der));
}

/**
 * An id from a key: prefix plus the first 20 fingerprint characters.
 *
 * @param {string} prefix - "c_" or "d_".
 * @param {Buffer|string} spki - DER bytes or base64url text.
 * @returns {string}
 */
function idFromSpki(prefix, spki) {
  return prefix + fingerprint(spki).slice(0, ID_PREFIX_CHARS);
}

/** @param {Buffer|string} spki @returns {string} computerId */
function computerIdFromSpki(spki) { return idFromSpki('c_', spki); }
/** @param {Buffer|string} spki @returns {string} deviceId */
function deviceIdFromSpki(spki) { return idFromSpki('d_', spki); }

/**
 * The four digit match code (PROTOCOL.md 2.5).
 *
 * @param {object|Array} fields - computerPublicKey, devicePublicKey, deviceNonce, serverNonce.
 * @returns {{input: Buffer, sha256Hex: string, uint32: number, code: string}}
 */
function matchCode(fields) {
  const input = signingInput('match-code', fields);
  const h = sha256(input);
  const n = h.readUInt32BE(0);
  return { input, sha256Hex: h.toString('hex'), uint32: n, code: String(n % MATCH_CODE_MODULUS).padStart(4, '0') };
}

/**
 * Encode 5 bytes (40 bits) as 8 Crockford base32 characters.
 *
 * @param {Buffer} buf5 - Five bytes.
 * @returns {string}
 */
function manualCodeFromBytes(buf5) {
  let bits = 0n;
  for (const b of buf5) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = MANUAL_CODE_CHARS - 1; i >= 0; i -= 1) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/**
 * Normalize what a person typed into the 8 character canonical code:
 * uppercase, no spaces or hyphens, O to 0, I and L to 1.
 *
 * @param {string} typed - Raw input.
 * @returns {string}
 */
function normalizeManualCode(typed) {
  return String(typed || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/**
 * Display form of a manual code, XXXX-XXXX.
 *
 * @param {string} code - 8 characters.
 * @returns {string}
 */
function displayManualCode(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/**
 * Build a QR link (PROTOCOL.md 2.3). Values are percent encoded with
 * encodeURIComponent; endpoint URLs are joined with a literal comma.
 *
 * @param {'scheme'|'universal'} style - Link form.
 * @param {{offerId: string, secret: string, fingerprint: string, name: string, endpoints: string[]}} v - Values.
 * @returns {string}
 */
function buildQrLink(style, v) {
  const base = style === 'universal' ? 'https://myrlin.io/p#' : 'myrlin://pair#';
  const enc = encodeURIComponent;
  const parts = [
    'v=2',
    'o=' + enc(v.offerId),
    's=' + enc(v.secret),
    'pk=' + enc(v.fingerprint),
    'n=' + enc(v.name),
    'e=' + v.endpoints.map(enc).join(','),
  ];
  return base + parts.join('&');
}

/**
 * Build a QR link that fits the 300 character budget: drop endpoints from the
 * end, then shorten the name, until it fits (PROTOCOL.md 2.3).
 *
 * @param {'scheme'|'universal'} style - Link form.
 * @param {object} v - As buildQrLink; name is cut to 32 characters first.
 * @returns {string}
 */
function buildFittingQrLink(style, v) {
  let endpoints = v.endpoints.slice();
  let name = Array.from(String(v.name || '')).slice(0, QR_NAME_MAX_CHARS).join('');
  let link = buildQrLink(style, Object.assign({}, v, { endpoints, name }));
  while (link.length > QR_MAX_CHARS && endpoints.length > 0) {
    endpoints = endpoints.slice(0, -1);
    link = buildQrLink(style, Object.assign({}, v, { endpoints, name }));
  }
  while (link.length > QR_MAX_CHARS && name.length > 1) {
    name = Array.from(name).slice(0, -1).join('');
    link = buildQrLink(style, Object.assign({}, v, { endpoints, name }));
  }
  return link;
}

/**
 * Parse a QR link's fragment into its fields (PROTOCOL.md 2.3 parser rules).
 *
 * @param {string} link - The link.
 * @returns {object} Fields; `e` is an array of endpoint URLs.
 */
function parseQrLink(link) {
  const hash = link.indexOf('#');
  const frag = hash >= 0 ? link.slice(hash + 1) : '';
  const out = {};
  for (const pair of frag.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : '';
    out[k] = k === 'e' ? (v === '' ? [] : v.split(',').map(decodeURIComponent)) : decodeURIComponent(v);
  }
  return out;
}

/** @returns {string} 32 random bytes, base64url (a nonce, secret or token). */
function randomNonce() { return b64u(crypto.randomBytes(NONCE_BYTES)); }
/** @returns {string} An offer id, 8 base64url characters. */
function newOfferId() { return b64u(crypto.randomBytes(OFFER_ID_BYTES)); }
/** @returns {string} A pair id, pr_ plus 22 characters. */
function newPairId() { return 'pr_' + b64u(crypto.randomBytes(PAIR_ID_BYTES)); }
/** @returns {string} A stream epoch, e_ plus 16 characters. */
function newStreamEpoch() { return 'e_' + b64u(crypto.randomBytes(EPOCH_BYTES)); }
/** @returns {string} A fresh 8 character manual code. */
function newManualCode() { return manualCodeFromBytes(crypto.randomBytes(MANUAL_CODE_BYTES)); }

/**
 * Whether a string looks like a 43 character base64url nonce.
 *
 * @param {*} v - Candidate.
 * @returns {boolean}
 */
function isNonce(v) {
  return typeof v === 'string' && v.length === NONCE_CHARS && B64URL_RE.test(v);
}

/**
 * Constant time comparison of two equal length buffers or strings.
 *
 * @param {Buffer|string} a - First.
 * @param {Buffer|string} b - Second.
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = {
  MSF_HEADER,
  PURPOSES,
  CROCKFORD,
  NONCE_CHARS,
  SIGNATURE_CHARS,
  QR_MAX_CHARS,
  b64u,
  sha256,
  encodeValue,
  fieldsFor,
  signingInput,
  isRawSignature,
  sign,
  verify,
  parsePublicKey,
  fingerprint,
  idFromSpki,
  computerIdFromSpki,
  deviceIdFromSpki,
  matchCode,
  manualCodeFromBytes,
  normalizeManualCode,
  displayManualCode,
  buildQrLink,
  buildFittingQrLink,
  parseQrLink,
  randomNonce,
  newOfferId,
  newPairId,
  newStreamEpoch,
  newManualCode,
  isNonce,
  safeEqual,
};
