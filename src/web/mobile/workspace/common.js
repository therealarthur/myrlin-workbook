/**
 * workspace/common.js: small helpers shared by the B3 workspace modules
 * (tree, names, settings, tabs, search, accounts, migrations).
 *
 * WHY: BUILD-CONTRACT 3.1 asks every mobile module to throw B1's MobileError
 * (so the router writes the PROTOCOL.md 0.4 body), to keep persistent state
 * under <dataDir>/mobile/ written atomically, and to log with the [mobile]
 * prefix without message text. Keeping those rules here means the B3 modules
 * cannot drift from each other, and each one reaches B2's parts (session
 * index, hub) through the same lazy, null safe accessors, so B3 still mounts
 * in a test that starts B1 alone.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const errors = require('../errors');
const fsAtomic = require('../fs-atomic');

/** Log prefix every B3 line carries (BUILD-CONTRACT 3.1). */
const LOG_PREFIX = '[mobile] workspace: ';
/** The two agent providers of the phone protocol (PROTOCOL.md 3.4.3). */
const AGENT_PROVIDERS = Object.freeze(['claude', 'codex']); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
/** Phone session id pattern (PROTOCOL.md 0.3). */
const SESSION_ID_RE = /^(cl|cx|wb)_[A-Za-z0-9._:-]{1,120}$/;
/** Base64url alphabet for minted ids. */
const B64URL_RE = /[+/=]/g;

/**
 * Throw a protocol error from B1's catalog.
 *
 * @param {string} code - UPPER_SNAKE code (PROTOCOL.md 13).
 * @param {string} [message] - Sentence a person can read.
 * @param {object} [extra] - Extra fields the catalog allows for the code.
 * @returns {never}
 */
function fail(code, message, extra) {
  throw errors.fail(code, message, extra);
}

/**
 * Send a JSON body with a status other than 200 (the router sends 200 for a
 * returned value; 201 and 202 answers are written here).
 *
 * @param {object} res - Response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function sendStatus(res, status, body) {
  errors.sendJson(res, status, body);
}

/**
 * base64url without padding of some bytes.
 *
 * @param {Buffer} buf - Bytes.
 * @returns {string}
 */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(B64URL_RE, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

/**
 * A random id: prefix plus base64url of n random bytes.
 *
 * @param {string} prefix - For example "tg_".
 * @param {number} bytes - Random byte count.
 * @param {number} [chars] - Cut the base64url text to this many characters.
 * @returns {string}
 */
function randomId(prefix, bytes, chars) {
  const text = b64url(crypto.randomBytes(bytes));
  return prefix + (chars ? text.slice(0, chars) : text);
}

/**
 * First 8 hex characters of SHA-256 of a string (stable short hashes).
 *
 * @param {string} text - Input.
 * @returns {string}
 */
function sha8(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

/**
 * The mobile state folder of a context (<dataDir>/mobile).
 *
 * @param {object} ctx - Mobile context.
 * @returns {string}
 */
function mobileDir(ctx) {
  const base = (ctx && ctx.dataDir) || require('../../../utils/data-dir').getDataDir();
  return path.join(base, 'mobile');
}

/**
 * Write JSON atomically (temp file then rename, BUILD-CONTRACT 3.1).
 *
 * @param {string} file - Target.
 * @param {object} value - Document.
 */
function writeJson(file, value) {
  fsAtomic.writeJsonAtomic(file, value);
}

/**
 * Read JSON, or a fallback when missing or unreadable.
 *
 * @param {string} file - Path.
 * @param {*} fallback - Value when missing.
 * @returns {*}
 */
function readJson(file, fallback) {
  const v = fsAtomic.readJson(file);
  return v === null || v === undefined ? fallback : v;
}

/**
 * A prefixed logger. Callers pass short facts only, never message text,
 * tokens or file contents (BUILD-CONTRACT 3.1).
 *
 * @param {object} ctx - Mobile context (ctx.log when set).
 * @returns {(msg: string) => void}
 */
function logger(ctx) {
  return (msg) => {
    const line = LOG_PREFIX + msg;
    try {
      if (ctx && typeof ctx.log === 'function') ctx.log(line);
      else console.log(line);
    } catch (_) { /* logging never throws into a route */ }
  };
}

/**
 * Lazy accessors for the other tracks' parts. B2 mounts before B3
 * (BUILD-CONTRACT 3.4.1), but every access still checks, so B3 degrades
 * instead of throwing when a part is missing.
 *
 * @param {object} ctx - Mobile context.
 * @returns {{chat: Function, hub: Function, index: Function, push: Function, audit: Function}}
 */
function parts(ctx) {
  const m = () => (ctx && ctx.mobile) || {};
  return {
    chat: () => m().chat || null,
    hub: () => m().hub || null,
    index: () => {
      const c = m().chat;
      return c && c.internals && c.internals.index ? c.internals.index : null;
    },
    push: () => m().push || null,
    audit: () => m().audit || null,
  };
}

/**
 * Publish on a stream topic when the hub exists; never throws.
 *
 * @param {object} ctx - Mobile context.
 * @param {string} topic - Topic.
 * @param {string} type - Event type.
 * @param {object} data - Event body.
 * @returns {number|null} The seq, or null without a hub.
 */
function publish(ctx, topic, type, data) {
  const hub = ctx && ctx.mobile && ctx.mobile.hub;
  if (!hub || typeof hub.publish !== 'function') return null;
  try {
    return hub.publish(topic, type, data);
  } catch (err) {
    logger(ctx)('publish ' + type + ' failed: ' + (err && err.message));
    return null;
  }
}

/**
 * The topic's current seq and the epoch, for snapshot routes (PROTOCOL.md 4.7).
 *
 * @param {object} ctx - Mobile context.
 * @param {string} topic - Topic.
 * @returns {{streamEpoch: string, streamSeq: number}}
 */
function snapshotSeq(ctx, topic) {
  const m = (ctx && ctx.mobile) || {};
  const hub = m.hub;
  let epoch = hub && typeof hub.epoch === 'string' ? hub.epoch : null;
  if (!epoch && typeof m.getStreamEpoch === 'function') epoch = m.getStreamEpoch();
  if (!epoch) epoch = m.streamEpoch || 'e_AAAAAAAAAAAAAAAA';
  let seq = 0;
  try { if (hub && typeof hub.currentSeq === 'function') seq = hub.currentSeq(topic) || 0; } catch (_) { seq = 0; }
  return { streamEpoch: epoch, streamSeq: seq };
}

/**
 * Write an audit line through B1 when present (PROTOCOL.md 11.4).
 *
 * @param {object} ctx - Mobile context.
 * @param {object} entry - {deviceId, action, sessionId, detail, ok}.
 */
function audit(ctx, entry) {
  const a = ctx && ctx.mobile && ctx.mobile.audit;
  if (!a || typeof a.write !== 'function') return;
  try { a.write(entry); } catch (_) { /* audit never breaks a route */ }
}

/**
 * Call B1's push notify when present; never throws, never awaits the send.
 *
 * @param {object} ctx - Mobile context.
 * @param {object} event - A notify event (BUILD-CONTRACT 3.4.2).
 */
function notify(ctx, event) {
  const p = ctx && ctx.mobile && ctx.mobile.push;
  if (!p || typeof p.notify !== 'function') return;
  try {
    const r = p.notify(event);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* push never breaks a route */ }
}

/**
 * Broadcast a main server SSE event (PROTOCOL.md 11.3 table).
 *
 * @param {object} ctx - Mobile context.
 * @param {string} type - Event type.
 * @param {object} data - Payload (never with id, workspaceId or workspace).
 */
function broadcast(ctx, type, data) {
  if (!ctx || typeof ctx.broadcastSSE !== 'function') return;
  try { ctx.broadcastSSE(type, data); } catch (err) { logger(ctx)('SSE ' + type + ' failed: ' + (err && err.message)); }
}

/**
 * Whether a value is a phone session id (PROTOCOL.md 0.3).
 *
 * @param {*} v - Candidate.
 * @returns {boolean}
 */
function isSessionId(v) {
  return typeof v === 'string' && SESSION_ID_RE.test(v);
}

/**
 * A string without line breaks, trimmed, or null when it is not one.
 *
 * @param {*} v - Candidate.
 * @returns {string|null}
 */
function oneLine(v) {
  if (typeof v !== 'string') return null;
  if (/[\r\n]/.test(v)) return null;
  return v.trim();
}

/**
 * Milliseconds of a date like value, or null.
 *
 * @param {*} v - Number, Date or ISO string.
 * @returns {number|null}
 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Deep copy of a JSON value.
 *
 * @param {*} v - Value.
 * @returns {*}
 */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * Path comparison key: separators unified, trailing separator dropped, case
 * folded on Windows (the same rule as live-sessions.js normalizeCwd).
 *
 * @param {*} p - Path.
 * @returns {string|null}
 */
function normalizePath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  try {
    return require('../../../providers/claude/live-sessions').normalizeCwd(p);
  } catch (_) {
    let s = p.trim().replace(/[\\/]+/g, '/');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  }
}

module.exports = {
  AGENT_PROVIDERS,
  SESSION_ID_RE,
  fail,
  sendStatus,
  b64url,
  randomId,
  sha8,
  mobileDir,
  writeJson,
  readJson,
  logger,
  parts,
  publish,
  snapshotSeq,
  audit,
  notify,
  broadcast,
  isSessionId,
  oneLine,
  toMs,
  clone,
  normalizePath,
};
