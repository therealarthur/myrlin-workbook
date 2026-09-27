/**
 * session-tokens.js: hello nonces, POST /hello, POST /session, the 15 minute
 * in memory session tokens, and authenticate(req) / authenticateUpgrade(req).
 *
 * WHY: PROTOCOL.md 2.8 and 2.9. Every connection proves the device key with a
 * signature over a fresh server nonce and gets a token that lives only in
 * memory. Critic F3: these tokens NEVER enter the desktop activeTokens set
 * (src/web/auth.js), so no route on the main server accepts them. Tokens are
 * held by their SHA-256, so even a heap dump shows no usable token.
 */
'use strict';

const crypto = require('crypto');
const signing = require('./signing');
const errors = require('./errors');

/** Token life (PROTOCOL.md 2.9). */
const TOKEN_LIFE_MS = 15 * 60 * 1000;
/** Live tokens per device; a fifth drops the oldest. */
const TOKENS_PER_DEVICE = 4;
/** Outstanding hello nonces per device, and their life. */
const NONCES_PER_DEVICE = 8;
const NONCE_LIFE_MS = 60 * 1000;
/** Expired tokens are remembered this long to answer SESSION_EXPIRED. */
const EXPIRED_MEMORY_MS = 60 * 60 * 1000;
/** Clock bound for request ts values (a sanity bound, not freshness). */
const TS_BOUND_MS = 24 * 60 * 60 * 1000;
/** Pattern of a deviceId. */
const DEVICE_ID_RE = /^d_[A-Za-z0-9_-]{20}$/;
/** Pattern of a computerId. */
const COMPUTER_ID_RE = /^c_[A-Za-z0-9_-]{20}$/;

/**
 * SHA-256 of a token, hex.
 *
 * @param {string} token - Token.
 * @returns {string}
 */
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Pull the bearer token from an Authorization header.
 *
 * @param {object} req - Request.
 * @returns {string|null}
 */
function bearerOf(req) {
  const h = req.headers && req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/.exec(h);
  return m ? m[1] : null;
}

/**
 * How the phone reached us, from the Host the proxy forwarded.
 *
 * @param {object} req - Request.
 * @returns {string} tailscale, loopback or custom.
 */
function endpointKindOf(req) {
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').toLowerCase().replace(/:\d+$/, '');
  if (host.endsWith('.ts.net')) return 'tailscale';
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host === '') return 'loopback';
  return 'custom';
}

/**
 * Create the token service.
 *
 * @param {object} deps - {identity, devices, limiters, audit, endpoints, getStreamEpoch, packageVersion, now, log}.
 * @returns {object} The auth API (authenticate, authenticateUpgrade, handlers, onTokenRevoked, ...).
 */
function createSessionTokens(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  /** deviceId -> [{serverNonce, clientNonce, expiresAt}] */
  const nonces = new Map();
  /** hash -> {deviceId, issuedAt, expiresAt} */
  const tokens = new Map();
  /** hash -> forgetAt (tokens of revoked devices, section 2.9) */
  const revoked = new Map();
  const revokedListeners = new Set();

  /** Forget expired nonces, old expired tokens and stale revoked hashes. */
  function sweep() {
    const t = now();
    for (const [id, list] of nonces) {
      const live = list.filter((n) => n.expiresAt > t);
      if (live.length) nonces.set(id, live); else nonces.delete(id);
    }
    for (const [h, rec] of tokens) if (rec.expiresAt + EXPIRED_MEMORY_MS < t) tokens.delete(h);
    for (const [h, forgetAt] of revoked) if (forgetAt < t) revoked.delete(h);
  }

  /** @param {string} deviceId @returns {string[]} hashes of its tokens, oldest first */
  function tokensOf(deviceId) {
    return Array.from(tokens.entries())
      .filter(([, r]) => r.deviceId === deviceId)
      .sort((a, b) => a[1].issuedAt - b[1].issuedAt)
      .map(([h]) => h);
  }

  /**
   * Resolve a raw token to its device, or throw the protocol 401.
   *
   * @param {string|null} token - Raw token.
   * @returns {{deviceId: string, scopes: string[], device: object, tokenExpiresAtMs: number}}
   */
  function authenticateToken(token) {
    sweep();
    if (!token) throw errors.fail('AUTH_REQUIRED');
    const h = tokenHash(token);
    if (revoked.has(h)) throw errors.fail('DEVICE_REVOKED');
    const rec = tokens.get(h);
    if (!rec) throw errors.fail('AUTH_REQUIRED');
    if (rec.expiresAt <= now()) throw errors.fail('SESSION_EXPIRED');
    // Scopes are read from the record on every request (PROTOCOL.md 2.9).
    const device = deps.devices.get(rec.deviceId);
    if (!device) {
      if (deps.devices.tombstoneFor(rec.deviceId)) throw errors.fail('DEVICE_REVOKED');
      throw errors.fail('AUTH_REQUIRED');
    }
    return { deviceId: rec.deviceId, scopes: device.scopes.slice(), device, tokenExpiresAtMs: rec.expiresAt };
  }

  /**
   * Authenticate a REST request by its Authorization header.
   *
   * @param {object} req - Request.
   * @returns {{deviceId, scopes, device, tokenExpiresAtMs}}
   */
  function authenticate(req) {
    const auth = authenticateToken(bearerOf(req));
    deps.devices.touch(auth.deviceId, endpointKindOf(req));
    return auth;
  }

  /**
   * Authenticate a WebSocket upgrade (the token rides in the header too).
   *
   * @param {object} req - Upgrade request.
   * @returns {{deviceId: string, scopes: string[], tokenExpiresAtMs: number}}
   */
  function authenticateUpgrade(req) {
    const auth = authenticate(req);
    return { deviceId: auth.deviceId, scopes: auth.scopes, tokenExpiresAtMs: auth.tokenExpiresAtMs };
  }

  /**
   * Mint a token for a device; the fifth live one drops the oldest.
   *
   * @param {string} deviceId - Device.
   * @returns {{token: string, expiresAt: number}}
   */
  function mint(deviceId) {
    sweep();
    const token = signing.randomNonce();
    const issuedAt = now();
    const expiresAt = issuedAt + TOKEN_LIFE_MS;
    tokens.set(tokenHash(token), { deviceId, issuedAt, expiresAt });
    const live = tokensOf(deviceId).filter((h) => tokens.get(h).expiresAt > issuedAt);
    while (live.length > TOKENS_PER_DEVICE) tokens.delete(live.shift());
    return { token, expiresAt };
  }

  /**
   * Drop every token of a device and remember their hashes until they would
   * have expired, so the phone hears DEVICE_REVOKED (PROTOCOL.md 2.9).
   *
   * @param {string} deviceId - Device.
   */
  function revokeDevice(deviceId) {
    for (const h of tokensOf(deviceId)) {
      const rec = tokens.get(h);
      revoked.set(h, Math.max(rec.expiresAt, now()) + NONCE_LIFE_MS);
      tokens.delete(h);
    }
    nonces.delete(deviceId);
    for (const fn of revokedListeners) {
      try { fn(deviceId); } catch (err) { log('[mobile] token revoke listener failed: ' + err.message); }
    }
  }

  /**
   * The signed revocation verdict (PROTOCOL.md 2.11).
   *
   * @param {string} deviceId - Device.
   * @param {object} tomb - Tombstone.
   * @param {string} clientNonce - Echo of the hello or session clientNonce.
   * @returns {object} The 403 body.
   */
  function revokedBody(deviceId, tomb, clientNonce) {
    const fields = { computerId: deps.identity.computerId, deviceId, clientNonce, revokedAtMs: tomb.revokedAtMs };
    return {
      error: 'This iPhone was removed from ' + deps.computerName() + '.',
      code: 'DEVICE_REVOKED',
      computerId: fields.computerId,
      deviceId,
      clientNonce,
      revokedAtMs: tomb.revokedAtMs,
      sig: deps.identity.sign('revoked', fields),
    };
  }

  /** Throw a 429 when a limiter says so. */
  function limited(state) {
    if (state.limited) throw errors.fail('RATE_LIMITED', null, { retryAfterMs: state.retryAfterMs });
  }

  /**
   * POST /hello (public).
   *
   * @param {object} req - Request with parsed body.
   * @param {object} res - Response.
   */
  function helloHandler(req, res) {
    const b = req.body || {};
    if (typeof b.deviceId !== 'string' || !DEVICE_ID_RE.test(b.deviceId)) throw errors.fail('INVALID_FIELD', null, { field: 'deviceId' });
    if (!signing.isNonce(b.clientNonce)) throw errors.fail('INVALID_FIELD', null, { field: 'clientNonce' });
    limited(deps.limiters.helloGlobal.hit('global'));
    limited(deps.limiters.helloPerDevice.hit(b.deviceId));
    const device = deps.devices.get(b.deviceId);
    if (!device) {
      const tomb = deps.devices.tombstoneFor(b.deviceId);
      if (tomb) {
        errors.sendJson(res, 403, revokedBody(b.deviceId, tomb, b.clientNonce));
        return undefined;
      }
      throw errors.fail('DEVICE_UNKNOWN');
    }
    sweep();
    const serverNonce = signing.randomNonce();
    const list = nonces.get(b.deviceId) || [];
    list.push({ serverNonce, clientNonce: b.clientNonce, expiresAt: now() + NONCE_LIFE_MS });
    while (list.length > NONCES_PER_DEVICE) list.shift();
    nonces.set(b.deviceId, list);
    const endpoints = deps.endpoints.list();
    const body = {
      computerId: deps.identity.computerId,
      deviceId: b.deviceId,
      clientNonce: b.clientNonce,
      serverNonce,
      streamEpoch: deps.getStreamEpoch(),
      endpoints,
      apiVersion: errors.API_VERSION,
      apiRevision: errors.API_REVISION,
      workbookVersion: deps.packageVersion,
      ts: now(),
    };
    body.sig = deps.identity.sign('hello-response', Object.assign({}, body, { endpoints: endpoints.map((e) => e.url) }));
    return body;
  }

  /**
   * POST /session (public). Checks in the order of PROTOCOL.md 2.8.
   *
   * @param {object} req - Request with parsed body.
   * @param {object} res - Response.
   */
  function sessionHandler(req, res) {
    const b = req.body || {};
    const field = (f) => errors.fail('INVALID_FIELD', null, { field: f });
    if (typeof b.computerId !== 'string' || !COMPUTER_ID_RE.test(b.computerId)) throw field('computerId');
    if (typeof b.deviceId !== 'string' || !DEVICE_ID_RE.test(b.deviceId)) throw field('deviceId');
    if (!signing.isNonce(b.serverNonce)) throw field('serverNonce');
    if (!signing.isNonce(b.clientNonce)) throw field('clientNonce');
    if (!Number.isSafeInteger(b.ts)) throw field('ts');
    if (typeof b.sig !== 'string') throw field('sig');
    if (!signing.isRawSignature(b.sig)) throw errors.fail('INVALID_SIGNATURE_ENCODING');
    if (b.computerId !== deps.identity.computerId) throw errors.fail('WRONG_COMPUTER');
    limited(deps.limiters.sessionBlocked(b.deviceId));
    limited(deps.limiters.sessionPerDevice.hit(b.deviceId));
    const device = deps.devices.get(b.deviceId);
    if (!device) {
      const tomb = deps.devices.tombstoneFor(b.deviceId);
      if (tomb) {
        errors.sendJson(res, 403, revokedBody(b.deviceId, tomb, b.clientNonce));
        return undefined;
      }
      throw errors.fail('DEVICE_UNKNOWN');
    }
    sweep();
    // The nonce is consumed whether or not the signature verifies.
    const list = nonces.get(b.deviceId) || [];
    const idx = list.findIndex((n) => signing.safeEqual(n.serverNonce, b.serverNonce));
    const entry = idx >= 0 ? list.splice(idx, 1)[0] : null;
    if (list.length) nonces.set(b.deviceId, list); else nonces.delete(b.deviceId);
    if (!entry || entry.expiresAt <= now() || entry.clientNonce !== b.clientNonce) throw errors.fail('NONCE_INVALID');
    const ok = signing.verify(device.publicKey, 'session-request', b, b.sig);
    if (!ok) {
      const blocked = deps.limiters.recordSessionSigFailure(b.deviceId);
      if (blocked) deps.audit.write({ deviceId: b.deviceId, action: 'sessionSignatureFailed', detail: 'session route blocked for 10 minutes', ok: false });
      throw errors.fail('SIGNATURE_INVALID');
    }
    if (Math.abs(b.ts - now()) > TS_BOUND_MS) throw field('ts');
    const { token, expiresAt } = mint(b.deviceId);
    deps.devices.touch(b.deviceId, endpointKindOf(req));
    const fresh = deps.devices.get(b.deviceId);
    return {
      sessionToken: token,
      expiresAtMs: expiresAt,
      expiresInMs: TOKEN_LIFE_MS,
      scopes: fresh.scopes.slice(),
      device: deps.devices.toDevice(b.deviceId),
      streamEpoch: deps.getStreamEpoch(),
    };
  }

  return {
    authenticate,
    authenticateUpgrade,
    authenticateToken,
    bearerOf,
    mint,
    revokeDevice,
    revokedBody,
    helloHandler,
    sessionHandler,
    endpointKindOf,
    /** @param {Function} fn - fn(deviceId) @returns {Function} unsubscribe */
    onTokenRevoked(fn) {
      revokedListeners.add(fn);
      return () => revokedListeners.delete(fn);
    },
    /** Drop every token (listener stop keeps them; a process restart loses them). */
    clear() {
      tokens.clear();
      nonces.clear();
    },
    /** For tests: how many live tokens a device holds. */
    liveTokenCount(deviceId) {
      const t = now();
      return tokensOf(deviceId).filter((h) => tokens.get(h).expiresAt > t).length;
    },
  };
}

module.exports = { createSessionTokens, tokenHash, bearerOf, endpointKindOf, TOKEN_LIFE_MS, TOKENS_PER_DEVICE, NONCES_PER_DEVICE, NONCE_LIFE_MS, TS_BOUND_MS };
