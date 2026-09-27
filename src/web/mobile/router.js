/**
 * router.js: route(method, path, handler) for the mobile listener, and the
 * dispatcher that runs every request through the scope table.
 *
 * WHY (critic F3): one middleware owns authentication, scopes and limiters
 * for every phone route. A route that is not in scope-table.js cannot be
 * registered (it throws at startup), and every request is authenticated
 * against the phone's in memory session tokens, never the desktop's
 * activeTokens set. Handlers receive (req, res, auth) where auth is
 * {deviceId, scopes, device} for authenticated routes and null for public
 * ones, may return a value (sent as 200 JSON) or a promise, and may throw a
 * MobileError, which becomes its protocol body.
 */
'use strict';

const { URL } = require('url');
const errors = require('./errors');
const table = require('./scope-table');

/** Request body limit (PROTOCOL.md 1.1). */
const BODY_LIMIT_BYTES = 1024 * 1024;
/** Upload chunk body limit (PROTOCOL.md 14). */
const CHUNK_LIMIT_BYTES = 16 * 1024 * 1024;
/** Methods whose body is parsed as JSON. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Read a request body up to a limit.
 *
 * @param {object} req - Request.
 * @param {number} limit - Byte limit.
 * @returns {Promise<Buffer>} Rejects with a MobileError BODY_TOO_LARGE.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(errors.fail('BODY_TOO_LARGE'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.resume();
        reject(errors.fail('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/**
 * Parse the X-Myrlin-Client build number, "Myrlin-iOS/1.0.0 (12)".
 *
 * @param {object} req - Request.
 * @returns {number|null}
 */
function clientBuild(req) {
  const h = req.headers && req.headers['x-myrlin-client'];
  const m = typeof h === 'string' ? /\((\d+)\)\s*$/.exec(h) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Create a router.
 *
 * @param {object} deps - {auth, limiters, getSettings, log}.
 * @returns {object} {route, dispatch, registered, handlerFor, hasHandler}.
 */
function createRouter(deps) {
  const log = deps.log || (() => {});
  /** "METHOD path" -> handler */
  const handlers = new Map();
  const loggedUnknownFields = new Set();

  /**
   * Register a handler for a table route. Throws when (method, path) is not
   * in the scope table or is registered twice.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Table path (relative to /api/m/v2).
   * @param {Function} handler - handler(req, res, auth).
   */
  function route(method, path, handler) {
    const m = String(method).toUpperCase();
    const entry = table.find(m, path);
    if (!entry) throw new Error('[mobile] route ' + m + ' ' + path + ' is not in scope-table.js (PROTOCOL.md 2.10)');
    if (entry.upgrade) throw new Error('[mobile] the stream upgrade is not a REST route; register it with the listener');
    if (typeof handler !== 'function') throw new Error('[mobile] route ' + m + ' ' + path + ' needs a handler function');
    const key = m + ' ' + path;
    if (handlers.has(key)) throw new Error('[mobile] route ' + key + ' is registered twice');
    handlers.set(key, handler);
  }

  /**
   * Log unknown request fields once per route (PROTOCOL.md 0.1), names only.
   *
   * @param {object} entry - Table entry.
   * @param {object} body - Parsed body.
   * @param {string[]} [known] - Known fields, when the handler declared them.
   */
  function noteUnknownFields(entry, body, known) {
    if (!known || !body || typeof body !== 'object') return;
    const unknown = Object.keys(body).filter((k) => !known.includes(k));
    const key = entry.method + ' ' + entry.path;
    if (unknown.length && !loggedUnknownFields.has(key)) {
      loggedUnknownFields.add(key);
      log('[mobile] ignoring unknown fields on ' + key + ': ' + unknown.join(', '));
    }
  }

  /**
   * Handle one REST request whose path starts with the API prefix.
   *
   * @param {object} req - http.IncomingMessage.
   * @param {object} res - http.ServerResponse.
   * @param {URL} url - Parsed URL.
   * @returns {Promise<void>}
   */
  async function dispatch(req, res, url) {
    const relPath = url.pathname.slice(table.API_PREFIX.length) || '/';
    const matches = table.matchPath(relPath).filter((m) => !m.entry.upgrade);
    if (!matches.length) throw errors.fail('NOT_FOUND');
    const hit = matches.find((m) => m.entry.method === req.method);
    if (!hit) {
      res.setHeader('Allow', Array.from(new Set(matches.map((m) => m.entry.method))).join(', '));
      throw errors.fail('METHOD_NOT_ALLOWED');
    }
    const entry = hit.entry;

    const s = deps.getSettings();
    if (Number.isInteger(s.minClientBuild)) {
      const build = clientBuild(req);
      if (build !== null && build < s.minClientBuild) throw errors.fail('APP_TOO_OLD');
    }

    // Authenticate, check the scope and spend the limiter BEFORE reading a
    // body, so an unauthenticated client never gets further than a 401.
    let auth = null;
    if (entry.scope !== 'public') {
      auth = deps.auth.authenticate(req);
      if (entry.scope !== 'none' && !auth.scopes.includes(entry.scope)) {
        throw errors.fail('SCOPE_REQUIRED', 'This iPhone is not allowed to do that on this computer.', { scope: entry.scope });
      }
      const state = deps.limiters.check(entry.limiter, auth.deviceId);
      if (state.limited) throw errors.fail('RATE_LIMITED', null, { retryAfterMs: state.retryAfterMs });
    } else {
      const key = entry.limiter === 'pairPoll' ? 'pair:' + (hit.params.pairId || '') : 'global';
      const state = deps.limiters.check(entry.limiter, key);
      if (state.limited) throw errors.fail('RATE_LIMITED', null, { retryAfterMs: state.retryAfterMs });
    }

    req.params = hit.params;
    req.query = Object.fromEntries(url.searchParams.entries());
    req.routeEntry = entry;
    const isChunk = entry.limiter === 'upload';
    if (BODY_METHODS.has(req.method) && !isChunk) {
      const raw = await readBody(req, BODY_LIMIT_BYTES);
      if (raw.length === 0) {
        req.body = {};
      } else {
        try {
          req.body = JSON.parse(raw.toString('utf8'));
        } catch (_) {
          throw errors.fail('INVALID_JSON');
        }
      }
    } else if (!isChunk) {
      req.body = {};
    } else {
      // Upload chunks stream to their handler (B2); the listener enforces the
      // declared length limit here and B2 checks the bytes it writes.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > CHUNK_LIMIT_BYTES) throw errors.fail('BODY_TOO_LARGE');
      req.body = null;
      req.chunkLimitBytes = CHUNK_LIMIT_BYTES;
    }
    req.noteUnknownFields = (known) => noteUnknownFields(entry, req.body, known);

    const handler = handlers.get(entry.method + ' ' + entry.path);
    if (!handler) throw errors.fail('NOT_FOUND', 'This computer does not serve that route yet.');
    const result = await handler(req, res, auth);
    if (result !== undefined && !res.headersSent && !res.writableEnded) {
      errors.sendJson(res, 200, result);
    }
  }

  return {
    route,
    dispatch,
    readBody,
    /** @returns {Array<{method: string, path: string}>} registered routes */
    registered() {
      return Array.from(handlers.keys()).map((k) => {
        const i = k.indexOf(' ');
        return { method: k.slice(0, i), path: k.slice(i + 1) };
      });
    },
    /** @returns {boolean} whether a handler exists */
    hasHandler(method, path) {
      return handlers.has(String(method).toUpperCase() + ' ' + path);
    },
    table,
  };
}

/**
 * Parse a request URL safely.
 *
 * @param {object} req - Request.
 * @returns {URL|null}
 */
function parseUrl(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1');
  } catch (_) {
    return null;
  }
}

module.exports = { createRouter, parseUrl, readBody, clientBuild, BODY_LIMIT_BYTES, CHUNK_LIMIT_BYTES };
