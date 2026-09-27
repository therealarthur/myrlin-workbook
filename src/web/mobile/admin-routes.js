/**
 * admin-routes.js: /api/mobile-admin/* on the main Workbook server, for the
 * desktop page only (PROTOCOL.md section 11).
 *
 * WHY: the desktop's Connect app modal and Devices tab manage phones through
 * these routes, behind the existing requireAuth (desktop tokens). The mobile
 * listener never serves them, and a phone session token is never in
 * activeTokens, so every route here answers a phone 401 (critic F3).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const errors = require('./errors');
const contextMod = require('./context');
const { validatePublicUrl } = require('./endpoints');
const devicesMod = require('./devices');
const { loadP8, signProviderToken } = require('./push/apns');
const { writeFileAtomic } = require('./fs-atomic');

/** Settings fields the admin route accepts (PROTOCOL.md 11.1). */
const SETTINGS_FIELDS = ['enabled', 'host', 'port', 'legacyPairEnabled', 'publicUrls', 'detectTailscale', 'advertiseLoopback', 'qrLinkStyle'];
/** Most publicUrls entries. */
const MAX_PUBLIC_URLS = 5;
/** APNs id patterns (apns-config.json). */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
/** .p8 text bounds. */
const P8_MIN_CHARS = 100;
const P8_MAX_CHARS = 4096;
/** Highest TCP port. */
const MAX_PORT = 65535;
/** Audit page bounds. */
const AUDIT_DEFAULT_LIMIT = 100;

/**
 * Mount the admin routes (server.js edit S1).
 *
 * @param {object} app - Express app.
 * @param {object} deps - {requireAuth, getStore, broadcastSSE}.
 */
function mountAdminRoutes(app, deps) {
  const mobile = require('./index');
  const log = (m) => console.log(m);

  /** @returns {object} the mobile runtime, built lazily when startMobile has not run */
  function runtime() {
    return mobile.getRuntime() || mobile.ensureCore({
      store: deps.getStore(),
      broadcastSSE: (type, data) => deps.broadcastSSE(type, data),
    });
  }

  /**
   * Wrap a handler: a returned value is sent as 200 JSON, a thrown MobileError
   * becomes its protocol body.
   *
   * @param {Function} fn - (req, res, rt) => value | Promise<value>.
   * @returns {Function} Express handler.
   */
  function wrap(fn) {
    return async (req, res) => {
      try {
        const r = await fn(req, res, runtime());
        if (r !== undefined && !res.headersSent) errors.sendJson(res, 200, r);
      } catch (err) {
        if (!res.headersSent) errors.sendThrown(res, err, log);
      }
    };
  }

  /**
   * The AdminStatus body (PROTOCOL.md 11.1).
   *
   * @param {object} rt - Runtime.
   * @returns {object}
   */
  function statusBody(rt) {
    const s = rt.getSettings();
    const l = rt.listener.status();
    return {
      listener: { enabled: !!s.enabled, host: s.host, port: l.running && l.port ? l.port : (s.port || contextMod.DEFAULT_SETTINGS.port), running: l.running, error: l.error },
      identity: {
        computerId: rt.identity.computerId,
        fingerprint: rt.identity.fingerprint,
        createdAtMs: rt.identity.createdAtMs,
        replacedWhilePaired: rt.identity.source === 'replaced',
      },
      endpoints: rt.endpoints.list(),
      legacyPairEnabled: !!s.legacyPairEnabled,
      screenModel: rt.screenModel(),
      push: rt.notifier.status(),
      deviceCount: rt.devices.count(),
      streamEpoch: rt.getStreamEpoch(),
      computerName: rt.computerName(),
    };
  }

  /**
   * Write settings.mobile through the store (shallow merge of the mobile object).
   *
   * @param {object} patch - Fields to set.
   */
  function writeMobileSettings(patch) {
    const store = deps.getStore();
    const current = (store.settings && store.settings.mobile) || {};
    store.updateSettings({ mobile: Object.assign({}, current, patch) });
  }

  /**
   * Validate an AdminSettingsUpdate body.
   *
   * @param {object} b - Body.
   * @returns {object} The patch to write.
   */
  function validateSettings(b) {
    const bad = (field, msg) => errors.fail('INVALID_FIELD', msg, { field });
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body', 'The request body must be an object.');
    const patch = {};
    for (const f of SETTINGS_FIELDS) if (b[f] !== undefined) patch[f] = b[f];
    for (const f of ['enabled', 'legacyPairEnabled', 'detectTailscale', 'advertiseLoopback']) {
      if (patch[f] !== undefined && typeof patch[f] !== 'boolean') throw bad(f, 'The field ' + f + ' must be true or false.');
    }
    if (patch.host !== undefined && !contextMod.isLoopbackHost(patch.host)) {
      throw bad('host', 'The phone listener binds only 127.0.0.1 or ::1. Reach it from the phone through Tailscale Serve.');
    }
    if (patch.host !== undefined) patch.host = patch.host.trim();
    if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > MAX_PORT)) throw bad('port', 'The port must be a whole number from 1 to 65535.');
    if (patch.publicUrls !== undefined) {
      if (!Array.isArray(patch.publicUrls) || patch.publicUrls.length > MAX_PUBLIC_URLS) throw bad('publicUrls', 'Give at most five addresses.');
      const out = [];
      for (const u of patch.publicUrls) {
        const v = validatePublicUrl(u);
        if (!v) throw bad('publicUrls', 'Each address must be https://, or http:// to 127.0.0.1 or localhost, with no path.');
        out.push(v);
      }
      patch.publicUrls = out;
    }
    if (patch.qrLinkStyle !== undefined && patch.qrLinkStyle !== 'scheme' && patch.qrLinkStyle !== 'universal') throw bad('qrLinkStyle', 'The link style must be scheme or universal.');
    return patch;
  }

  const base = '/api/mobile-admin';
  const auth = deps.requireAuth;

  app.get(base + '/status', auth, wrap((req, res, rt) => statusBody(rt)));

  app.put(base + '/settings', auth, wrap(async (req, res, rt) => {
    const patch = validateSettings(req.body);
    const before = rt.getSettings();
    writeMobileSettings(patch);
    const after = rt.getSettings();
    const restart = before.enabled !== after.enabled || before.host !== after.host || before.port !== after.port;
    if (restart) {
      const st = await mobile.restartListener();
      if (st && st.errorCode === 'EADDRINUSE') throw errors.fail('PORT_IN_USE', 'Port ' + after.port + ' is already in use on this computer.');
    }
    return statusBody(rt);
  }));

  app.put(base + '/apns', auth, wrap((req, res, rt) => {
    const b = req.body || {};
    const bad = (field) => errors.fail('INVALID_FIELD', 'The field ' + field + ' is not valid.', { field });
    if (typeof b.teamId !== 'string' || !APPLE_ID_RE.test(b.teamId)) throw bad('teamId');
    if (typeof b.keyId !== 'string' || !APPLE_ID_RE.test(b.keyId)) throw bad('keyId');
    if (typeof b.p8 !== 'string' || b.p8.length < P8_MIN_CHARS || b.p8.length > P8_MAX_CHARS) throw bad('p8');
    if (b.bundleId !== undefined && b.bundleId !== devicesMod.BUNDLE_ID) throw bad('bundleId');
    let key;
    try {
      key = loadP8(b.p8);
      signProviderToken({ teamId: b.teamId, keyId: b.keyId, key }, Date.now());
    } catch (_) {
      throw errors.fail('INVALID_APNS_KEY');
    }
    const keyFile = path.join(rt.ctx.dataDir, 'mobile', 'apns', 'AuthKey_' + b.keyId + '.p8');
    writeFileAtomic(keyFile, b.p8, 0o600);
    writeMobileSettings({ apns: { teamId: b.teamId, keyId: b.keyId, keyFile, bundleId: devicesMod.BUNDLE_ID } });
    rt.notifier.configure();
    return statusBody(rt);
  }));

  app.delete(base + '/apns', auth, wrap((req, res, rt) => {
    const s = rt.getSettings();
    if (s.apns && s.apns.keyFile) {
      try { fs.unlinkSync(s.apns.keyFile); } catch (_) { /* already gone */ }
    }
    writeMobileSettings({ apns: null });
    rt.notifier.configure();
    errors.sendEmpty(res, 204);
  }));

  app.post(base + '/pair-offers', auth, wrap((req, res, rt) => {
    if (!rt.listener.status().running) throw errors.fail('LISTENER_OFF');
    errors.sendJson(res, 201, rt.pairing.createOffer());
  }));

  app.delete(base + '/pair-offers/:offerId', auth, wrap((req, res, rt) => {
    rt.pairing.withdrawOffer(req.params.offerId);
    errors.sendEmpty(res, 204);
  }));

  app.get(base + '/pair-requests', auth, wrap((req, res, rt) => ({ pending: rt.pairing.listPending() })));

  app.post(base + '/pair-requests/:pairId/allow', auth, wrap((req, res, rt) => {
    const rec = rt.pairing.allow(req.params.pairId, req.body || {});
    return { device: rt.devices.toAdminDevice(rec.deviceId, { online: false }) };
  }));

  app.post(base + '/pair-requests/:pairId/deny', auth, wrap((req, res, rt) => {
    rt.pairing.deny(req.params.pairId);
    errors.sendEmpty(res, 204);
  }));

  /** @param {object} rt @param {string} id @returns {object} AdminDevice */
  function adminDevice(rt, id) {
    const hub = rt.getHub();
    const online = !!(hub && typeof hub.isDeviceConnected === 'function' && hub.isDeviceConnected(id));
    const d = rt.devices.toAdminDevice(id, { online });
    if (!d) throw errors.fail('DEVICE_UNKNOWN');
    return d;
  }

  app.get(base + '/devices', auth, wrap((req, res, rt) => ({
    devices: rt.devices.list().sort((a, b) => b.pairedAtMs - a.pairedAtMs).map((d) => adminDevice(rt, d.deviceId)),
  })));

  app.patch(base + '/devices/:deviceId', auth, wrap((req, res, rt) => {
    const id = req.params.deviceId;
    if (!rt.devices.get(id)) throw errors.fail('DEVICE_UNKNOWN');
    const b = req.body || {};
    if (b.scopes !== undefined) devicesMod.normalizeGrantScopes(b.scopes);
    if (b.name !== undefined && !devicesMod.isValidName(b.name)) throw errors.fail('INVALID_FIELD', 'The name must be 1 to 64 characters on one line.', { field: 'name' });
    if (b.name !== undefined) rt.devices.rename(id, b.name);
    if (b.scopes !== undefined) {
      const before = rt.devices.get(id).scopes.join(',');
      const after = rt.devices.setScopes(id, b.scopes);
      if (before !== after.join(',')) rt.audit.write({ deviceId: id, action: 'scopeChange', detail: 'scopes: ' + after.join(' '), ok: true });
    }
    rt.broadcastDevicesChanged();
    return adminDevice(rt, id);
  }));

  app.delete(base + '/devices/:deviceId', auth, wrap((req, res, rt) => {
    const id = req.params.deviceId;
    if (!rt.devices.get(id)) throw errors.fail('DEVICE_UNKNOWN');
    rt.revokeDevice(id, 'desktop');
    errors.sendEmpty(res, 204);
  }));

  app.post(base + '/devices/:deviceId/test-push', auth, wrap(async (req, res, rt) => {
    const r = await rt.notifier.sendTest(req.params.deviceId);
    if (r.ok) return { sent: true, apnsId: r.apnsId };
    if (r.code === 'APNS_ERROR') throw errors.fail('APNS_ERROR', 'Apple refused the notification: ' + r.reason + '.', { reason: r.reason });
    throw errors.fail(r.code);
  }));

  app.get(base + '/devices/:deviceId/audit', auth, wrap((req, res, rt) => {
    const id = req.params.deviceId;
    if (!rt.devices.get(id) && !rt.devices.tombstoneFor(id)) throw errors.fail('DEVICE_UNKNOWN');
    const limit = Number(req.query.limit) || AUDIT_DEFAULT_LIMIT;
    return { entries: rt.audit.read(id, limit) };
  }));
}

module.exports = { mountAdminRoutes, SETTINGS_FIELDS };
