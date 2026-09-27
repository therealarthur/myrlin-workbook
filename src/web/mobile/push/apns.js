/**
 * push/apns.js: the APNs HTTP/2 client with ES256 token authentication.
 *
 * WHY: PROTOCOL.md 10.1 (A18). Workbook sends pushes to Apple itself, so no
 * Myrlin cloud sits in between. One HTTP/2 connection per host, kept open; a
 * JWT signed with the .p8 key and re-signed every 50 minutes (APNs rejects a
 * token older than an hour); 400 BadDeviceToken and 410 Unregistered delete
 * the registration; 429 and 5xx retry after 1 s, 5 s and 30 s; 403
 * ExpiredProviderToken re-signs and retries once.
 *
 * Everything that touches the network or the clock is injectable, so tests
 * run against a local HTTP/2 stub server.
 */
'use strict';

const http2 = require('http2');
const crypto = require('crypto');

/** Production and sandbox hosts. */
const HOSTS = Object.freeze({
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
});
/** Re-sign the provider token after this long. */
const JWT_REFRESH_MS = 50 * 60 * 1000;
/** Retry delays for 429 and 5xx. */
const RETRY_DELAYS_MS = Object.freeze([1000, 5000, 30000]);
/** Per request timeout. */
const REQUEST_TIMEOUT_MS = 10000;
/** Milliseconds per second. */
const MS_PER_SECOND = 1000;
/** HTTP statuses. */
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_FORBIDDEN = 403;
const STATUS_GONE = 410;
const STATUS_TOO_MANY = 429;
const STATUS_SERVER_ERROR = 500;

/**
 * base64url of a JSON value.
 *
 * @param {object} obj - Value.
 * @returns {string}
 */
function b64uJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * Sign an APNs provider token (ES256 JWT).
 *
 * @param {{teamId: string, keyId: string, key: crypto.KeyObject}} cfg - Key config.
 * @param {number} nowMs - Clock.
 * @returns {string} The JWT.
 */
function signProviderToken(cfg, nowMs) {
  const header = b64uJson({ alg: 'ES256', kid: cfg.keyId });
  const claims = b64uJson({ iss: cfg.teamId, iat: Math.floor(nowMs / MS_PER_SECOND) });
  const data = header + '.' + claims;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  return data + '.' + sig.toString('base64url');
}

/**
 * Load a .p8 key (PKCS8 PEM text) and prove it is a P-256 key.
 *
 * @param {string} text - The .p8 file's text.
 * @returns {crypto.KeyObject} Throws when it does not load.
 */
function loadP8(text) {
  const key = crypto.createPrivateKey({ key: String(text), format: 'pem' });
  if (key.asymmetricKeyType !== 'ec') throw new Error('not an EC key');
  const details = key.asymmetricKeyDetails || {};
  if (details.namedCurve && details.namedCurve !== 'prime256v1') throw new Error('not a P-256 key');
  return key;
}

/**
 * Create an APNs client.
 *
 * @param {object} opts
 * @param {{teamId: string, keyId: string, key: crypto.KeyObject}} opts.config - Key config.
 * @param {object} [opts.hosts] - {production, sandbox} origins (tests use a stub).
 * @param {Function} [opts.now] - Clock.
 * @param {Function} [opts.delay] - delay(ms) => Promise (tests shorten it).
 * @param {object} [opts.connectOptions] - Extra http2.connect options.
 * @returns {object} {send, close, providerToken}
 */
function createApnsClient(opts) {
  const now = opts.now || Date.now;
  const hosts = Object.assign({}, HOSTS, opts.hosts || {});
  const delay = opts.delay || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }));
  const sessions = new Map();
  let jwt = null;
  let jwtAt = 0;

  /** @param {boolean} [force] @returns {string} a provider token no older than 50 minutes */
  function providerToken(force) {
    const t = now();
    if (force || !jwt || t - jwtAt >= JWT_REFRESH_MS) {
      jwt = signProviderToken(opts.config, t);
      jwtAt = t;
    }
    return jwt;
  }

  /** @param {string} origin @returns {http2.ClientHttp2Session} a live session to the host */
  function sessionFor(origin) {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin, opts.connectOptions || {});
    s.on('error', () => { sessions.delete(origin); });
    s.on('close', () => { if (sessions.get(origin) === s) sessions.delete(origin); });
    s.on('goaway', () => { sessions.delete(origin); });
    if (s.unref) s.unref();
    sessions.set(origin, s);
    return s;
  }

  /**
   * One HTTP/2 request.
   *
   * @param {object} n - Notification (see send).
   * @param {string} token - Provider token.
   * @returns {Promise<{status: number, apnsId: string|null, reason: string|null}>}
   */
  function requestOnce(n, token) {
    return new Promise((resolve) => {
      let s;
      try {
        s = sessionFor(n.environment === 'sandbox' ? hosts.sandbox : hosts.production);
      } catch (err) {
        resolve({ status: 0, apnsId: null, reason: 'ConnectFailed' });
        return;
      }
      const headers = {
        ':method': 'POST',
        ':path': '/3/device/' + n.deviceToken,
        'authorization': 'bearer ' + token,
        'apns-push-type': n.pushType,
        'apns-topic': n.topic,
        'apns-priority': String(n.priority),
        'apns-expiration': String(n.expiration),
        'content-type': 'application/json',
      };
      if (n.collapseId) headers['apns-collapse-id'] = n.collapseId;
      let req;
      try {
        req = s.request(headers);
      } catch (err) {
        sessions.delete(n.environment === 'sandbox' ? hosts.sandbox : hosts.production);
        resolve({ status: 0, apnsId: null, reason: 'ConnectFailed' });
        return;
      }
      let status = 0;
      let apnsId = null;
      const chunks = [];
      const timer = setTimeout(() => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (_) { /* ignore */ }
        resolve({ status: 0, apnsId: null, reason: 'Timeout' });
      }, REQUEST_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      req.on('response', (h) => {
        status = Number(h[':status']) || 0;
        apnsId = h['apns-id'] || null;
      });
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        clearTimeout(timer);
        let reason = null;
        if (chunks.length) {
          try { reason = JSON.parse(Buffer.concat(chunks).toString('utf8')).reason || null; } catch (_) { reason = null; }
        }
        resolve({ status, apnsId, reason });
      });
      req.on('error', () => {
        clearTimeout(timer);
        resolve({ status: 0, apnsId: null, reason: 'StreamError' });
      });
      req.end(JSON.stringify(n.payload));
    });
  }

  /**
   * Send one notification with the retry rules of PROTOCOL.md 10.1.
   *
   * @param {object} n - {deviceToken, environment, pushType, topic, priority, expiration (seconds), collapseId, payload}.
   * @returns {Promise<{ok: boolean, status: number, apnsId: string|null, reason: string|null, removeToken: boolean, attempts: number}>}
   */
  async function send(n) {
    let attempts = 0;
    let resigned = false;
    let retryIndex = 0;
    for (;;) {
      attempts += 1;
      const r = await requestOnce(n, providerToken(false));
      if (r.status === STATUS_OK) return { ok: true, status: r.status, apnsId: r.apnsId, reason: null, removeToken: false, attempts };
      if ((r.status === STATUS_BAD_REQUEST && r.reason === 'BadDeviceToken') || r.status === STATUS_GONE) {
        return { ok: false, status: r.status, apnsId: r.apnsId, reason: r.reason, removeToken: true, attempts };
      }
      if (r.status === STATUS_FORBIDDEN && r.reason === 'ExpiredProviderToken' && !resigned) {
        resigned = true;
        providerToken(true);
        continue;
      }
      if ((r.status === STATUS_TOO_MANY || r.status >= STATUS_SERVER_ERROR || r.status === 0) && retryIndex < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[retryIndex]);
        retryIndex += 1;
        continue;
      }
      return { ok: false, status: r.status, apnsId: r.apnsId, reason: r.reason || ('HTTP ' + r.status), removeToken: false, attempts };
    }
  }

  /** Close every HTTP/2 session. */
  function close() {
    for (const s of sessions.values()) {
      try { s.close(); } catch (_) { /* ignore */ }
    }
    sessions.clear();
  }

  return { send, close, providerToken };
}

module.exports = { createApnsClient, signProviderToken, loadP8, HOSTS, JWT_REFRESH_MS, RETRY_DELAYS_MS };
