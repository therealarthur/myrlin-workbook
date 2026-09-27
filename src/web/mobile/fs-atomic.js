/**
 * fs-atomic.js: small file helpers for the mobile store under <dataDir>/mobile/.
 *
 * WHY: BUILD-CONTRACT 3.1 requires every persistent mobile file to be written
 * atomically (temp file, then rename), so a crash mid write never leaves a
 * half written devices.json or identity.json behind. Kept in one place so
 * identity.js, devices.js and the APNs key writer share the same rule.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Owner read and write only (PROTOCOL.md 2.1, 11.2). */
const PRIVATE_FILE_MODE = 0o600;
/** Random suffix bytes for temp files. */
const TEMP_SUFFIX_BYTES = 6;

/**
 * Write text atomically: a sibling temp file, then a rename over the target.
 *
 * @param {string} file - Target path.
 * @param {string|Buffer} data - Contents.
 * @param {number} [mode=0o600] - File mode (Windows inherits the profile ACL).
 */
function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(TEMP_SUFFIX_BYTES).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data, { mode: mode || PRIVATE_FILE_MODE });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw err;
  }
}

/**
 * Write a JSON document atomically.
 *
 * @param {string} file - Target path.
 * @param {object} obj - Document.
 * @param {number} [mode] - File mode.
 */
function writeJsonAtomic(file, obj, mode) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

/**
 * Read a JSON document, or null when missing or unreadable.
 *
 * @param {string} file - Path.
 * @returns {object|null}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = { PRIVATE_FILE_MODE, writeFileAtomic, writeJsonAtomic, readJson };
