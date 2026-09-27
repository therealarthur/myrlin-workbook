/**
 * Shared helpers for the mobile v2 chat track (B2).
 *
 * What: small, dependency free utilities every chat module needs: the error
 * class (B1's MobileError when present, an identical local fallback when B2
 * runs alone), JSON responses, atomic JSON persistence under
 * <dataDir>/mobile/, id minting, text truncation and a prefixed logger.
 *
 * Why: BUILD-CONTRACT 3.1 requires every error body to have the PROTOCOL.md
 * 0.4 shape, every persistent file to be written atomically, and every log
 * line to carry the [mobile] prefix without leaking tokens or message text.
 * Keeping those rules in one place means each chat module cannot drift.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** REST text truncation, PROTOCOL.md 3.6. */
const TEXT_TRUNC_REST = 16384;
/** Stream text truncation, PROTOCOL.md 3.6. */
const TEXT_TRUNC_STREAM = 4096;
/** A tool input string longer than this is cut (PROTOCOL.md 3.6 toolCall.input). */
const TOOL_INPUT_STRING_MAX = 2048;
/** Suffix appended to a cut tool input string. */
const TRUNCATED_SUFFIX = '[truncated]';

/**
 * Fallback error class with the exact constructor B1's errors.js exposes
 * (BUILD-CONTRACT 3.4.2): new MobileError(status, code, message, extra).
 */
class LocalMobileError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - UPPER_SNAKE code from PROTOCOL.md 13.
   * @param {string} message - Sentence a person can read.
   * @param {object} [extra] - Extra body fields listed for the code.
   */
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

/**
 * The MobileError class to throw: B1's when the router exists, else the local one.
 * @param {object} ctx
 * @returns {Function}
 */
function errorClass(ctx) {
  const e = ctx && ctx.mobile && ctx.mobile.errors;
  return (e && typeof e.MobileError === 'function') ? e.MobileError : LocalMobileError;
}

/**
 * Build a thrower bound to a context: fail(404, 'SESSION_NOT_FOUND', '...').
 * @param {object} ctx
 * @returns {(status: number, code: string, message: string, extra?: object) => never}
 */
function failer(ctx) {
  return (status, code, message, extra) => {
    const Cls = errorClass(ctx);
    throw new Cls(status, code, message, extra);
  };
}

/**
 * Error body in the PROTOCOL.md 0.4 shape from any thrown value.
 * @param {*} err
 * @returns {{status: number, body: object}}
 */
function errorBody(err) {
  if (err && typeof err.status === 'number' && typeof err.code === 'string') {
    return { status: err.status, body: Object.assign({ error: err.message, code: err.code }, err.extra || {}) };
  }
  return { status: 500, body: { error: 'Something went wrong on the computer.', code: 'INTERNAL' } };
}

/**
 * Write a JSON response with the headers every mobile JSON answer carries.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!res.getHeader('X-Myrlin-Api')) res.setHeader('X-Myrlin-Api', '2.0');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

/**
 * Base64url without padding (PROTOCOL.md 0.1).
 * @param {Buffer} buf
 * @returns {string}
 */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode base64url (with or without padding) to a Buffer.
 * @param {string} s
 * @returns {Buffer}
 */
function fromB64url(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '==='.slice((t.length + 3) % 4), 'base64');
}

/**
 * Random id: prefix plus base64url of n random bytes.
 * @param {string} prefix
 * @param {number} bytes
 * @returns {string}
 */
function randomId(prefix, bytes) {
  return prefix + b64url(crypto.randomBytes(bytes));
}

/**
 * base64url(SHA-256(text)).
 * @param {string|Buffer} text
 * @returns {string}
 */
function sha256b64url(text) {
  return b64url(crypto.createHash('sha256').update(text).digest());
}

/**
 * The mobile state directory, <dataDir>/mobile.
 * @param {object} ctx
 * @returns {string}
 */
function mobileDir(ctx) {
  let base = ctx && ctx.dataDir;
  if (!base) {
    try { base = require('../../../utils/data-dir').getDataDir(); } catch (_) { base = process.cwd(); }
  }
  return path.join(base, 'mobile');
}

/**
 * Write JSON atomically: a temp file in the same directory, then rename.
 * @param {string} file
 * @param {*} value
 */
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Read a JSON file, returning the fallback on any failure.
 * @param {string} file
 * @param {*} fallback
 * @returns {*}
 */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/**
 * Cut a string for REST or stream delivery (UTF-16 code units, PROTOCOL.md 3.6).
 * @param {string} text
 * @param {number} max
 * @returns {{text: string, truncated: boolean, fullLength: number}}
 */
function truncateText(text, max) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return { text: s, truncated: false, fullLength: s.length };
  return { text: s.slice(0, max), truncated: true, fullLength: s.length };
}

/**
 * Deep copy a tool input with every long string cut (PROTOCOL.md 3.6).
 * @param {*} value
 * @returns {{value: *, truncated: boolean}}
 */
function truncateToolInput(value) {
  let truncated = false;
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      if (v.length > TOOL_INPUT_STRING_MAX) {
        truncated = true;
        return v.slice(0, TOOL_INPUT_STRING_MAX) + TRUNCATED_SUFFIX;
      }
      return v;
    }
    if (depth > 20 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) out[k] = walk(v[k], depth + 1);
    return out;
  };
  return { value: walk(value, 0), truncated };
}

/**
 * Log with the [mobile] prefix. Callers never pass tokens or message text.
 * @param {...*} args
 */
function log(...args) {
  try { console.log('[mobile]', ...args); } catch (_) { /* console can EPIPE */ }
}

/**
 * Warn with the [mobile] prefix.
 * @param {...*} args
 */
function warn(...args) {
  try { console.warn('[mobile]', ...args); } catch (_) { /* console can EPIPE */ }
}

/**
 * Promise that resolves after ms milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/**
 * Parse an integer query value within bounds.
 * @param {*} raw
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number|null} null when present but invalid.
 */
function intParam(raw, def, min, max) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * Read a request body as a Buffer when the router did not parse it.
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(Object.assign(new Error('too large'), { tooLarge: true })); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The JSON body of a request: B1's router parses it into req.body; a raw
 * stream is parsed here so the chat routes also run under a minimal stub.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function jsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (req.readableEnded || req.complete) return {};
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return { __invalidJson: true }; }
}

module.exports = {
  TEXT_TRUNC_REST,
  TEXT_TRUNC_STREAM,
  TOOL_INPUT_STRING_MAX,
  LocalMobileError,
  errorClass,
  failer,
  errorBody,
  sendJson,
  b64url,
  fromB64url,
  randomId,
  sha256b64url,
  mobileDir,
  atomicWriteJson,
  readJson,
  truncateText,
  truncateToolInput,
  log,
  warn,
  delay,
  intParam,
  readBody,
  jsonBody,
};
