/**
 * pairing-v2.js: pair offers, POST /pair, GET /pair/:pairId (long poll), the
 * match code, pending pairs, and the desktop Allow and Deny steps.
 *
 * WHY: PROTOCOL.md 2.3 to 2.6. A 5 minute single use QR secret (or an 8
 * character manual code) proves the phone saw this computer's screen; the
 * device key signature proves possession of K_d; the desktop Allow click with
 * a 4 digit match code on both screens stops a photographed code and a man in
 * the middle. Workbook keeps only SHA-256 of the secret and of the code.
 */
'use strict';

const signing = require('./signing');
const errors = require('./errors');
const devicesMod = require('./devices');
const { LIMITS } = require('./rate-limit');

/** Offer life and desktop refresh (PROTOCOL.md 2.3). */
const OFFER_LIFE_MS = 5 * 60 * 1000;
const OFFER_REFRESH_MS = 4 * 60 * 1000;
/** Pending pair life and how long an ended pair is remembered. */
const PENDING_LIFE_MS = 120 * 1000;
const ENDED_MEMORY_MS = 10 * 60 * 1000;
/** Longest long poll in seconds. */
const MAX_WAIT_SECONDS = 25;
/** Field length bounds of PairRequest. */
const FIELD_MAX = { deviceName: 64, model: 32, osVersion: 32, appVersion: 32 };
/** Clock bound on ts (a sanity bound, not freshness). */
const TS_BOUND_MS = 24 * 60 * 60 * 1000;
/** Offer id pattern. */
const OFFER_ID_RE = /^[A-Za-z0-9_-]{8}$/;
/** Pair id pattern. */
const PAIR_ID_RE = /^pr_[A-Za-z0-9_-]{22}$/;
/** QR secret and manual code patterns. */
const QR_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const MANUAL_CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/** Fields a PairRequest may carry (unknown ones are logged once). */
const PAIR_REQUEST_FIELDS = ['offerId', 'secretKind', 'secret', 'devicePublicKey', 'deviceName', 'model', 'osVersion', 'appVersion', 'deviceNonce', 'ts', 'sig'];

/**
 * Create the pairing service.
 *
 * @param {object} deps - {identity, devices, limiters, audit, endpoints, broadcastSSE,
 *   computerName(), packageVersion, getSettings(), now, log, isListenerRunning()}.
 * @returns {object}
 */
function createPairing(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  /** offerId -> offer */
  const offers = new Map();
  /** pairId -> pair */
  const pairs = new Map();

  /** Expire offers and pairs lazily. */
  function sweep() {
    const t = now();
    for (const [id, o] of offers) if (o.expiresAt + ENDED_MEMORY_MS < t) offers.delete(id);
    for (const [, p] of pairs) {
      if (p.status === 'pending' && p.expiresAt <= t) resolvePair(p, 'expired');
    }
    for (const [id, p] of pairs) if (p.status !== 'pending' && p.endedAt + ENDED_MEMORY_MS < t) pairs.delete(id);
  }

  /**
   * The PairRequestSummary shown in the Allow dialog. Never carries a field
   * named id, workspaceId or workspace (PROTOCOL.md 11.3 SSE rule).
   *
   * @param {object} p - Pair.
   * @returns {object}
   */
  function summary(p) {
    return {
      pairId: p.pairId,
      deviceName: p.deviceName,
      model: p.model,
      osVersion: p.osVersion,
      appVersion: p.appVersion,
      deviceKeyFingerprint: signing.fingerprint(p.devicePublicKey),
      matchCode: p.matchCode,
      secretKind: p.secretKind,
      requestedAtMs: p.requestedAt,
      expiresAtMs: p.expiresAt,
    };
  }

  /**
   * End a pending pair and wake its long polls.
   *
   * @param {object} p - Pair.
   * @param {string} status - allowed, denied or expired.
   */
  function resolvePair(p, status) {
    if (p.status !== 'pending') return;
    p.status = status;
    p.endedAt = now();
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    const waiters = p.waiters.splice(0);
    for (const w of waiters) {
      try { w(); } catch (_) { /* a closed poll */ }
    }
    try { deps.broadcastSSE('mobile:pair-resolved', { pairId: p.pairId, status }); } catch (_) { /* best effort */ }
  }

  /**
   * Create a pair offer (desktop Connect app, PROTOCOL.md 2.3 and 11.3).
   *
   * @returns {object} The PairOffer response body.
   */
  function createOffer() {
    sweep();
    const t = now();
    const offerId = signing.newOfferId();
    const secret = signing.randomNonce();
    const code = signing.newManualCode();
    offers.set(offerId, {
      offerId,
      secretHash: signing.sha256(secret),
      codeHash: signing.sha256(code),
      createdAt: t,
      expiresAt: t + OFFER_LIFE_MS,
      used: false,
      burned: false,
      withdrawn: false,
      failures: 0,
    });
    const endpoints = deps.endpoints.list().map((e) => e.url);
    const values = { offerId, secret, fingerprint: deps.identity.fingerprint, name: deps.computerName(), endpoints };
    const schemeLink = signing.buildFittingQrLink('scheme', values);
    const universalLink = signing.buildFittingQrLink('universal', values);
    const style = deps.getSettings().qrLinkStyle === 'universal' ? 'universal' : 'scheme';
    return {
      offerId,
      qrLink: style === 'universal' ? universalLink : schemeLink,
      schemeLink,
      universalLink,
      manualCode: signing.displayManualCode(code),
      computerName: deps.computerName(),
      tailscaleName: deps.endpoints.tailscaleName(),
      expiresAtMs: t + OFFER_LIFE_MS,
      refreshAtMs: t + OFFER_REFRESH_MS,
    };
  }

  /**
   * Withdraw an offer (the modal closed). Idempotent.
   *
   * @param {string} offerId - Offer.
   */
  function withdrawOffer(offerId) {
    const o = offers.get(offerId);
    if (o) o.withdrawn = true;
  }

  /** Throw a 429 when a limiter says so. */
  function limited(state, code) {
    if (state.limited) throw errors.fail(code || 'RATE_LIMITED', null, { retryAfterMs: state.retryAfterMs });
  }

  /**
   * Validate the PairRequest shape (check 1).
   *
   * @param {object} b - Body.
   */
  function validateShape(b) {
    const field = (f) => errors.fail('INVALID_FIELD', 'The field ' + f + ' is missing or invalid.', { field: f });
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw field('body');
    if (b.secretKind !== 'qr' && b.secretKind !== 'code') throw field('secretKind');
    if (b.secretKind === 'qr') {
      if (typeof b.offerId !== 'string' || !OFFER_ID_RE.test(b.offerId)) throw field('offerId');
      if (typeof b.secret !== 'string' || !QR_SECRET_RE.test(b.secret)) throw field('secret');
    } else {
      if (b.offerId !== null) throw field('offerId');
      if (typeof b.secret !== 'string' || !MANUAL_CODE_RE.test(b.secret)) throw field('secret');
    }
    if (typeof b.devicePublicKey !== 'string' || b.devicePublicKey.length === 0) throw field('devicePublicKey');
    for (const [f, max] of Object.entries(FIELD_MAX)) {
      const v = b[f];
      if (typeof v !== 'string' || v.length === 0 || Array.from(v).length > max || /[\r\n]/.test(v)) throw field(f);
    }
    if (!signing.isNonce(b.deviceNonce)) throw field('deviceNonce');
    if (!Number.isSafeInteger(b.ts) || Math.abs(b.ts - now()) > TS_BOUND_MS) throw field('ts');
    if (typeof b.sig !== 'string') throw field('sig');
    if (!signing.isRawSignature(b.sig)) throw errors.fail('INVALID_SIGNATURE_ENCODING');
  }

  /**
   * Count a failure of checks 3 to 5 against the global bucket and rethrow.
   *
   * @param {Error} err - The failure.
   */
  function countFailure(err) {
    deps.limiters.pairGlobalFailures.record('global');
    throw err;
  }

  /**
   * POST /pair (public). Checks in the order of PROTOCOL.md 2.4 step 3.
   *
   * @param {object} req - Request with parsed body.
   * @param {object} res - Response.
   */
  function pairHandler(req, res) {
    const b = req.body;
    // 1. Shape and field lengths.
    validateShape(b);
    if (req.noteUnknownFields) req.noteUnknownFields(PAIR_REQUEST_FIELDS);
    sweep();
    // 2. Global pair limiter: 30 failures in 10 minutes block every request.
    limited(deps.limiters.pairGlobalFailures.peek('global'));
    // 3. The offer and its secret.
    let offer;
    if (b.secretKind === 'qr') {
      offer = offers.get(b.offerId);
      if (!offer || offer.withdrawn) countFailure(errors.fail('PAIR_OFFER_UNKNOWN'));
      if (offer.expiresAt <= now()) countFailure(errors.fail('PAIR_OFFER_EXPIRED'));
      if (offer.used) countFailure(errors.fail('PAIR_OFFER_USED'));
      if (offer.burned) countFailure(errors.fail('PAIR_OFFER_BURNED'));
      if (!signing.safeEqual(signing.sha256(b.secret), offer.secretHash)) {
        offer.failures += 1;
        if (offer.failures >= LIMITS.pairOfferFailuresBurn) offer.burned = true;
        countFailure(errors.fail('PAIR_SECRET_INVALID'));
      }
    } else {
      const codeHash = signing.sha256(b.secret);
      let match = null;
      for (const o of offers.values()) {
        // Constant time per offer; every live offer is compared.
        const eq = signing.safeEqual(codeHash, o.codeHash);
        if (eq && !match && !o.withdrawn && !o.used && !o.burned && o.expiresAt > now()) match = o;
      }
      if (!match) countFailure(errors.fail('PAIR_SECRET_INVALID'));
      offer = match;
    }
    // 4. Canonical public key, then the per key limiter.
    const parsed = signing.parsePublicKey(b.devicePublicKey);
    if (!parsed) countFailure(errors.fail('INVALID_PUBLIC_KEY'));
    limited(deps.limiters.pairPerKey.hit(b.devicePublicKey));
    // 5. Signature over pair-request with the submitted key.
    if (!signing.verify(parsed.key, 'pair-request', b, b.sig)) countFailure(errors.fail('SIGNATURE_INVALID'));
    // 6. Not already paired and active.
    if (deps.devices.isActiveKey(b.devicePublicKey)) throw errors.fail('DEVICE_ALREADY_PAIRED');
    // 7. At most 3 pending pairs.
    const pending = Array.from(pairs.values()).filter((p) => p.status === 'pending');
    if (pending.length >= LIMITS.pairPendingMax) {
      const soonest = Math.min(...pending.map((p) => p.expiresAt));
      throw errors.fail('PAIR_BUSY', null, { retryAfterMs: Math.max(1, soonest - now()) });
    }

    offer.used = true;
    const t = now();
    const serverNonce = signing.randomNonce();
    const pair = {
      pairId: signing.newPairId(),
      offerId: offer.offerId,
      secretKind: b.secretKind,
      devicePublicKey: b.devicePublicKey,
      deviceName: b.deviceName,
      model: b.model,
      osVersion: b.osVersion,
      appVersion: b.appVersion,
      deviceNonce: b.deviceNonce,
      serverNonce,
      requestedAt: t,
      expiresAt: t + PENDING_LIFE_MS,
      status: 'pending',
      endedAt: null,
      waiters: [],
      response: null,
      timer: null,
    };
    pair.matchCode = signing.matchCode({
      computerPublicKey: deps.identity.publicKey,
      devicePublicKey: pair.devicePublicKey,
      deviceNonce: pair.deviceNonce,
      serverNonce,
    }).code;
    pair.timer = setTimeout(() => resolvePair(pair, 'expired'), PENDING_LIFE_MS + 5);
    if (pair.timer.unref) pair.timer.unref();
    pairs.set(pair.pairId, pair);
    try { deps.broadcastSSE('mobile:pair-request', summary(pair)); } catch (err) { log('[mobile] SSE pair-request failed: ' + err.message); }

    const challenge = {
      pairId: pair.pairId,
      offerId: offer.offerId,
      computerId: deps.identity.computerId,
      computerPublicKey: deps.identity.publicKey,
      devicePublicKey: pair.devicePublicKey,
      deviceNonce: pair.deviceNonce,
      serverNonce,
      expiresAtMs: pair.expiresAt,
    };
    challenge.sig = deps.identity.sign('pair-challenge', challenge);
    challenge.status = 'pending';
    errors.sendJson(res, 202, challenge);
    return undefined;
  }

  /**
   * The PairStatus body of a pair.
   *
   * @param {object} p - Pair.
   * @returns {object}
   */
  function statusBody(p) {
    if (p.status === 'pending') return { pairId: p.pairId, status: 'pending', expiresAtMs: p.expiresAt };
    if (p.status === 'allowed') return p.response;
    return { pairId: p.pairId, status: p.status };
  }

  /**
   * GET /pair/:pairId?wait= (public long poll, PROTOCOL.md 2.4 step 5).
   *
   * @param {object} req - Request.
   * @param {object} res - Response.
   * @returns {Promise<object|undefined>}
   */
  function pairStatusHandler(req, res) {
    const pairId = req.params.pairId;
    let wait = 0;
    if (req.query.wait !== undefined) {
      wait = Number(req.query.wait);
      if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) throw errors.fail('INVALID_FIELD', 'wait must be a whole number of seconds from 0 to 25.', { field: 'wait' });
    }
    sweep();
    const p = PAIR_ID_RE.test(pairId) ? pairs.get(pairId) : null;
    if (!p) throw errors.fail('PAIR_UNKNOWN');
    if (p.status !== 'pending' || wait === 0) return statusBody(p);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const i = p.waiters.indexOf(finish);
        if (i >= 0) p.waiters.splice(i, 1);
        if (!res.writableEnded && !res.destroyed) {
          if (p.status === 'pending' && p.expiresAt <= now()) resolvePair(p, 'expired');
          errors.sendJson(res, 200, statusBody(p));
        }
        resolve(undefined);
      };
      const timer = setTimeout(finish, Math.min(wait * 1000, Math.max(0, p.expiresAt - now()) + 5));
      p.waiters.push(finish);
      res.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); const i = p.waiters.indexOf(finish); if (i >= 0) p.waiters.splice(i, 1); resolve(undefined); } });
    });
  }

  /** @returns {object[]} pending pair summaries, oldest first */
  function listPending() {
    sweep();
    return Array.from(pairs.values()).filter((p) => p.status === 'pending').sort((a, b) => a.requestedAt - b.requestedAt).map(summary);
  }

  /**
   * Find a pair that can still be decided.
   *
   * @param {string} pairId - Pair.
   * @returns {object}
   */
  function pendingPair(pairId) {
    sweep();
    const p = pairs.get(pairId);
    if (!p) throw errors.fail('PAIR_UNKNOWN');
    if (p.status === 'expired') throw errors.fail('PAIR_EXPIRED');
    if (p.status !== 'pending') throw errors.fail('PAIR_UNKNOWN', 'That pairing request was already decided.');
    return p;
  }

  /**
   * Allow a pending pair: create the device, answer the phone's long poll with
   * the signed pair response, broadcast the change (PROTOCOL.md 2.6).
   *
   * @param {string} pairId - Pair.
   * @param {{scopes: string[], name: string|null}} body - AllowRequest.
   * @returns {object} The device record copy.
   */
  function allow(pairId, body) {
    const scopes = devicesMod.normalizeGrantScopes(body && body.scopes);
    const name = body && body.name != null ? body.name : null;
    if (name !== null && !devicesMod.isValidName(name)) throw errors.fail('INVALID_FIELD', 'The name must be 1 to 64 characters on one line.', { field: 'name' });
    const p = pendingPair(pairId);
    if (deps.devices.isActiveKey(p.devicePublicKey)) throw errors.fail('DEVICE_ALREADY_PAIRED');
    const pairedAtMs = now();
    const rec = deps.devices.create({
      publicKey: p.devicePublicKey,
      name: name || p.deviceName,
      model: p.model,
      osVersion: p.osVersion,
      appVersion: p.appVersion,
      scopes,
      pairedAtMs,
    });
    const endpoints = deps.endpoints.list();
    const fields = {
      pairId: p.pairId,
      computerId: deps.identity.computerId,
      deviceId: rec.deviceId,
      devicePublicKey: p.devicePublicKey,
      deviceName: rec.name,
      scopes: rec.scopes,
      computerName: deps.computerName(),
      endpoints: endpoints.map((e) => e.url),
      deviceNonce: p.deviceNonce,
      pairedAtMs,
    };
    p.response = {
      pairId: p.pairId,
      status: 'allowed',
      computerId: fields.computerId,
      computerName: fields.computerName,
      workbookVersion: deps.packageVersion,
      apiVersion: errors.API_VERSION,
      apiRevision: errors.API_REVISION,
      deviceId: rec.deviceId,
      devicePublicKey: p.devicePublicKey,
      deviceName: rec.name,
      scopes: rec.scopes,
      endpoints,
      deviceNonce: p.deviceNonce,
      pairedAtMs,
      sig: deps.identity.sign('pair-response', fields),
    };
    resolvePair(p, 'allowed');
    deps.audit.write({ deviceId: rec.deviceId, action: 'pair', detail: 'allowed on the desktop (' + p.secretKind + ')', ok: true });
    try { deps.broadcastSSE('mobile:devices-changed', {}); } catch (_) { /* best effort */ }
    return rec;
  }

  /**
   * Deny a pending pair.
   *
   * @param {string} pairId - Pair.
   */
  function deny(pairId) {
    const p = pendingPair(pairId);
    resolvePair(p, 'denied');
  }

  /** Wake every long poll (listener stop) and clear timers. */
  function close() {
    for (const p of pairs.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      const waiters = p.waiters.splice(0);
      for (const w of waiters) { try { w(); } catch (_) { /* ignore */ } }
    }
  }

  return {
    createOffer,
    withdrawOffer,
    pairHandler,
    pairStatusHandler,
    listPending,
    allow,
    deny,
    close,
    /** For tests: the stored offer record. */
    _offer(offerId) { return offers.get(offerId) || null; },
    /** For tests: the stored pair record. */
    _pair(pairId) { return pairs.get(pairId) || null; },
    OFFER_LIFE_MS,
    PENDING_LIFE_MS,
  };
}

module.exports = { createPairing, OFFER_LIFE_MS, OFFER_REFRESH_MS, PENDING_LIFE_MS, MAX_WAIT_SECONDS };
