/**
 * identity.js: the computer identity key K_c and GET /api/m/v2/identity.
 *
 * WHY: the phone pins this key from the QR code and verifies every hello
 * against it, so the key must survive restarts and a damaged file (F24).
 * PROTOCOL.md 2.1: created once at <dataDir>/mobile/identity.json, copied to
 * identity.backup.json (never rewritten), restored from the backup when the
 * main file is missing or unreadable, and replaced only when both fail.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const signing = require('./signing');
const { writeJsonAtomic, readJson } = require('./fs-atomic');
const errors = require('./errors');

/** identity.json format version. */
const IDENTITY_FORMAT = 1;

/**
 * Load one identity document and prove it is self consistent: the private key
 * loads, and its public key, fingerprint and computerId match the file.
 *
 * @param {object|null} doc - Parsed file.
 * @returns {object|null} {privateKey, publicKey, doc} or null.
 */
function validateDoc(doc) {
  if (!doc || doc.v !== IDENTITY_FORMAT || typeof doc.privateKeyPkcs8 !== 'string') return null;
  try {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(doc.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' });
    const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const publicKeySpki = signing.b64u(spki);
    if (publicKeySpki !== doc.publicKeySpki) return null;
    if (signing.fingerprint(spki) !== doc.fingerprint) return null;
    if (signing.computerIdFromSpki(spki) !== doc.computerId) return null;
    return { privateKey, doc };
  } catch (_) {
    return null;
  }
}

/**
 * Create a new identity document.
 *
 * @param {number} nowMs - Creation time.
 * @returns {object} Document.
 */
function createDoc(nowMs) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return {
    v: IDENTITY_FORMAT,
    createdAtMs: nowMs,
    privateKeyPkcs8: signing.b64u(pkcs8),
    publicKeySpki: signing.b64u(spki),
    fingerprint: signing.fingerprint(spki),
    computerId: signing.computerIdFromSpki(spki),
  };
}

/**
 * Load, restore or create K_c.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - Workbook data dir.
 * @param {Function} [opts.log] - Logger.
 * @param {Function} [opts.now] - Clock.
 * @returns {object} Identity: {computerId, publicKey, fingerprint, createdAtMs, sign, verify, source}.
 */
function loadIdentity(opts) {
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const dir = path.join(opts.dataDir, 'mobile');
  const mainFile = path.join(dir, 'identity.json');
  const backupFile = path.join(dir, 'identity.backup.json');

  let source = 'loaded';
  let loaded = validateDoc(readJson(mainFile));
  if (!loaded) {
    const fromBackup = validateDoc(readJson(backupFile));
    if (fromBackup) {
      writeJsonAtomic(mainFile, fromBackup.doc);
      loaded = fromBackup;
      source = 'restored';
      log('[mobile] identity.json was missing or damaged; restored the computer key from identity.backup.json');
    }
  }
  if (!loaded) {
    const doc = createDoc(now());
    writeJsonAtomic(mainFile, doc);
    // The backup is written once at creation and never rewritten (F24).
    writeJsonAtomic(backupFile, doc);
    loaded = { privateKey: crypto.createPrivateKey({ key: Buffer.from(doc.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' }), doc };
    source = 'created';
    const devicesFile = path.join(dir, 'devices.json');
    const devicesDoc = readJson(devicesFile);
    if (devicesDoc && Array.isArray(devicesDoc.devices) && devicesDoc.devices.length > 0) {
      source = 'replaced';
      log('[mobile] WARNING: a NEW computer identity key was created while phones are paired. Every paired phone must scan again.');
    } else {
      log('[mobile] created the computer identity key ' + doc.computerId);
    }
  }
  if (!fs.existsSync(backupFile)) {
    // A store from before the backup existed: write it now, once.
    try { writeJsonAtomic(backupFile, loaded.doc); } catch (_) { /* best effort */ }
  }

  const { privateKey, doc } = loaded;
  const publicKeyObject = crypto.createPublicKey(privateKey);
  return {
    computerId: doc.computerId,
    publicKey: doc.publicKeySpki,
    fingerprint: doc.fingerprint,
    createdAtMs: doc.createdAtMs,
    source,
    /** Sign a purpose's fields with K_c. */
    sign(purpose, fields) {
      return signing.sign(privateKey, purpose, fields);
    },
    /** Verify a signature made by K_c (tests and self checks). */
    verify(purpose, fields, sig) {
      return signing.verify(publicKeyObject, purpose, fields, sig);
    },
  };
}

/**
 * GET /identity handler factory (PROTOCOL.md 2.4 step 2).
 *
 * @param {object} deps - {identity, computerName(), packageVersion, now}.
 * @returns {Function} Route handler.
 */
function identityHandler(deps) {
  return function getIdentity(req) {
    const nonce = req.query.nonce;
    if (!signing.isNonce(nonce)) throw errors.fail('INVALID_FIELD', 'The nonce query parameter must be 43 base64url characters.', { field: 'nonce' });
    const body = {
      computerId: deps.identity.computerId,
      computerPublicKey: deps.identity.publicKey,
      name: deps.computerName(),
      workbookVersion: deps.packageVersion,
      apiVersion: errors.API_VERSION,
      apiRevision: errors.API_REVISION,
      clientNonce: nonce,
      ts: deps.now(),
    };
    body.sig = deps.identity.sign('identity', body);
    return body;
  };
}

module.exports = { loadIdentity, identityHandler, validateDoc, createDoc };
