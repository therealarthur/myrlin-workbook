/**
 * index.js: the mobile v2 module. startMobile(ctx), stopMobile(),
 * onProviderChange(id), plus the runtime the desktop admin routes use.
 *
 * WHY: BUILD-CONTRACT 3.4.1. startMobile fills ctx.mobile with B1's parts
 * (router, errors, auth, devices, audit, push, endpoints, identity), then
 * mounts B2's chat and B3's workspace when their folders exist, so B1 runs
 * alone. The listener is additive to the main server and off by default
 * (P29): it starts only when mobile.enabled is true or CWM_MOBILE_ENABLED=1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const errors = require('./errors');
const signing = require('./signing');
const contextMod = require('./context');
const { createLazyIdentity, identityHandler } = require('./identity');
const { createDevices } = require('./devices');
const { createAudit } = require('./audit');
const { createLimiters } = require('./rate-limit');
const { createEndpoints } = require('./endpoints');
const { createSessionTokens } = require('./session-tokens');
const { createPairing } = require('./pairing-v2');
const { createNotifier } = require('./push/notify');
const { createRouter } = require('./router');
const { createListener } = require('./listener');
const { mountDeviceRoutes } = require('./device-routes');

/** WebSocket close code for a revoked device (PROTOCOL.md 5.6). */
const CLOSE_DEVICE_REVOKED = 4401;

/** Module state: one runtime per process. */
let rt = null;
/** The stream epoch, minted once per process start (F12). */
const PROCESS_EPOCH = signing.newStreamEpoch();

/**
 * Build B1's core services once and attach them to ctx.mobile. Safe to call
 * again: later calls only refresh ctx members.
 *
 * @param {object} ctx - Context (BUILD-CONTRACT 3.4.1); may be partial for the admin routes.
 * @returns {object} The runtime.
 */
function ensureCore(ctx) {
  if (rt) {
    if (ctx && ctx !== rt.ctx) {
      // startMobile after a lazy admin init: adopt the full context.
      const mobile = rt.ctx.mobile;
      Object.assign(rt.ctx, ctx, { mobile });
      if (ctx.mobile && ctx.mobile !== mobile) Object.assign(mobile, ctx.mobile);
      ctx.mobile = mobile;
    }
    return rt;
  }
  contextMod.completeContext(ctx);
  const log = ctx.log;
  const now = ctx.now;
  const getSettings = () => contextMod.resolveSettings(ctx.store.settings || ctx.store.state && ctx.store.state.settings);
  const computerName = () => contextMod.computerName(ctx.store.settings || {});
  const getHub = () => ctx.mobile.hub || null;

  // K_c is read or created on first use, normally right before the listener
  // first binds (PROTOCOL.md 2.1), never on a start with the listener off.
  const identity = createLazyIdentity({ dataDir: ctx.dataDir, log, now });
  const devices = createDevices({ dataDir: ctx.dataDir, now, log });
  const audit = createAudit({ dataDir: ctx.dataDir, now, log });
  const limiters = createLimiters({ now });
  const endpoints = createEndpoints({ getSettings, log, runCli: ctx.tailscaleCli, getBoundPort: () => (rt && rt.listener ? rt.listener.status().port : null) });
  const getStreamEpoch = () => {
    const hub = getHub();
    return hub && typeof hub.epoch === 'string' ? hub.epoch : PROCESS_EPOCH;
  };
  const broadcast = (type, data) => {
    try { ctx.broadcastSSE(type, data); } catch (err) { log('[mobile] SSE ' + type + ' failed: ' + err.message); }
  };
  const auth = createSessionTokens({
    identity, devices, limiters, audit, endpoints, getStreamEpoch, computerName,
    packageVersion: ctx.packageVersion, now, log,
  });
  const pairing = createPairing({
    identity, devices, limiters, audit, endpoints, broadcastSSE: broadcast, computerName,
    packageVersion: ctx.packageVersion, getSettings, now, log,
  });
  const notifier = createNotifier({ devices, identity, computerName, getSettings, getHub, now, log });
  const router = createRouter({ auth, limiters, getSettings, log });

  rt = {
    ctx, identity, devices, audit, limiters, endpoints, auth, pairing, notifier, router,
    getSettings, computerName, getStreamEpoch, getHub, broadcast, log, now,
    packageVersion: ctx.packageVersion,
    listener: null,
    mounted: { chat: false, workspace: false },
  };
  rt.listener = createListener({ router, auth, limiters, getSettings, getHub, log });

  /**
   * Revoke a device with every effect of PROTOCOL.md 2.11, before answering.
   *
   * @param {string} deviceId - Device.
   * @param {string} by - "desktop" or "phone".
   * @returns {object|null} The tombstone.
   */
  rt.revokeDevice = function revokeDevice(deviceId, by) {
    const existed = !!devices.get(deviceId);
    const tomb = devices.revoke(deviceId); // fires devices.onRevoked (B2 cancels sends and uploads)
    auth.revokeDevice(deviceId); // drops tokens, fires auth.onTokenRevoked
    const hub = getHub();
    if (hub && typeof hub.closeDevice === 'function') {
      try { hub.closeDevice(deviceId, CLOSE_DEVICE_REVOKED, 'DEVICE_REVOKED'); } catch (err) { log('[mobile] closeDevice failed: ' + err.message); }
    }
    if (existed) {
      audit.write({ deviceId, action: 'revoke', detail: 'revoked from the ' + (by === 'phone' ? 'phone' : 'desktop'), ok: true });
      broadcast('mobile:devices-changed', {});
    }
    return tomb;
  };
  rt.broadcastDevicesChanged = () => broadcast('mobile:devices-changed', {});
  rt.capabilities = function capabilities() {
    const chat = ctx.mobile.chat || {};
    const workspace = ctx.mobile.workspace || {};
    const chatCaps = chat.capabilities || {};
    return {
      screenModel: rt.screenModel(),
      push: notifier.isConfigured(),
      glassApi: !!(workspace.accounts && typeof workspace.accounts.glassApiUp === 'function' && workspace.accounts.glassApiUp()),
      codexLinker: chatCaps.codexLinker === true,
      migrations: !!workspace.migrations,
      contentSearch: 'tailOfLargeFiles',
      branchFromMessage: Array.isArray(chatCaps.branchFromMessage) ? chatCaps.branchFromMessage.slice() : [],
    };
  };
  rt.screenModel = () => process.env.CWM_VT_SIDECAR === '1';
  rt.now = now;

  // B1's own routes.
  router.route('GET', '/identity', identityHandler({ identity, computerName, packageVersion: ctx.packageVersion, now }));
  router.route('POST', '/pair', pairing.pairHandler);
  router.route('GET', '/pair/:pairId', pairing.pairStatusHandler);
  router.route('POST', '/hello', auth.helloHandler);
  router.route('POST', '/session', auth.sessionHandler);
  mountDeviceRoutes(router, rt);

  // ctx.mobile, in the order of BUILD-CONTRACT 3.4.1.
  Object.assign(ctx.mobile, {
    router,
    errors,
    auth: {
      authenticate: auth.authenticate,
      authenticateUpgrade: auth.authenticateUpgrade,
      authenticateToken: auth.authenticateToken,
      onTokenRevoked: auth.onTokenRevoked,
    },
    devices: {
      get: devices.get,
      list: devices.list,
      toDevice: devices.toDevice,
      onRevoked: devices.onRevoked,
      onScopesChanged: devices.onScopesChanged,
    },
    audit: { write: audit.write },
    push: { notify: (event) => notifier.notify(event), isConfigured: () => notifier.isConfigured() },
    endpoints: { list: endpoints.list },
    // Getters, so holding ctx.mobile.identity creates no key file; the first
    // read loads K_c like every other reader (BUILD-CONTRACT 3.4.2 shape).
    identity: {
      get computerId() { return identity.computerId; },
      get publicKey() { return identity.publicKey; },
      get fingerprint() { return identity.fingerprint; },
      sign: (purpose, fields) => identity.sign(purpose, fields),
    },
    streamEpoch: PROCESS_EPOCH,
    getStreamEpoch,
    screenModel: rt.screenModel(),
    computerName,
    settings: getSettings,
    listener: { status: () => rt.listener.status() },
  });
  return rt;
}

/**
 * Mount B2 and B3 when their folders exist (BUILD-CONTRACT 3.4.1).
 *
 * @param {object} ctx - Context.
 */
function mountOtherTracks(ctx) {
  const tryMount = (dir, fnName, flag) => {
    if (rt.mounted[flag]) return;
    const file = path.join(__dirname, dir, 'index.js');
    if (!fs.existsSync(file)) return;
    try {
      const mod = require(file);
      if (typeof mod[fnName] === 'function') {
        const r = mod[fnName](ctx.mobile.router, ctx);
        if (r && typeof r.catch === 'function') r.catch((err) => rt.log('[mobile] ' + fnName + ' failed: ' + (err && err.message)));
        rt.mounted[flag] = true;
      }
    } catch (err) {
      rt.log('[mobile] ' + fnName + ' failed: ' + (err && err.message));
    }
  };
  tryMount('chat', 'mountChat', 'chat');
  tryMount('workspace', 'mountWorkspace', 'workspace');
}

/**
 * Start the mobile module: core services, other tracks, then the listener
 * when enabled. Never throws into startServer (S3 wraps it too).
 *
 * @param {object} ctx - buildMobileContext().
 * @returns {Promise<object>} The listener status.
 */
function startMobile(ctx) {
  const runtime = ensureCore(ctx);
  mountOtherTracks(runtime.ctx);
  const s = runtime.getSettings();
  for (const e of s.envErrors) runtime.log('[mobile] ' + e);
  if (s.envHost && !contextMod.isLoopbackHost(s.host)) {
    runtime.log('[mobile] CWM_MOBILE_HOST must be 127.0.0.1 or ::1; the phone listener stays stopped');
  }
  if (!s.enabled) return Promise.resolve(runtime.listener.status());
  runtime.identity.ensure(); // first start of the listener creates K_c (PROTOCOL.md 2.1)
  runtime.endpoints.start();
  return runtime.listener.start();
}

/**
 * Stop the listener and background work. The core stays (admin routes keep
 * working; the listener can start again).
 *
 * @returns {Promise<void>}
 */
function stopMobile() {
  if (!rt) return Promise.resolve();
  rt.endpoints.stop();
  rt.pairing.close();
  rt.notifier.close();
  return rt.listener.stop();
}

/**
 * Restart only the mobile listener after a settings change: sockets close
 * with 1012, then it listens again when enabled (PROTOCOL.md 1.4).
 *
 * @returns {Promise<object>} Listener status (with errorCode on a bind failure).
 */
async function restartListener() {
  if (!rt) throw new Error('[mobile] not initialized');
  await rt.listener.stop();
  const s = rt.getSettings();
  if (!s.enabled) {
    rt.endpoints.stop();
    return rt.listener.status();
  }
  rt.identity.ensure(); // first start of the listener creates K_c (PROTOCOL.md 2.1)
  rt.endpoints.start();
  return rt.listener.start();
}

/**
 * A provider's discovery changed; forward to B2 and B3 when present.
 *
 * @param {string} providerId - Provider.
 */
function onProviderChange(providerId) {
  if (!rt) return;
  const m = rt.ctx.mobile;
  for (const part of [m.chat, m.workspace]) {
    if (part && typeof part.onProviderChange === 'function') {
      try { part.onProviderChange(providerId); } catch (err) { rt.log('[mobile] onProviderChange failed: ' + err.message); }
    }
  }
}

/** @returns {object|null} the runtime, if built */
function getRuntime() {
  return rt;
}

/** For tests: forget the runtime (after stopMobile) so a new ctx can start. */
function _resetForTests() {
  rt = null;
}

module.exports = {
  startMobile,
  stopMobile,
  onProviderChange,
  ensureCore,
  getRuntime,
  restartListener,
  PROCESS_EPOCH,
  CLOSE_DEVICE_REVOKED,
  _resetForTests,
};
