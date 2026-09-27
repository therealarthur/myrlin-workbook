/**
 * push/notify.js: notify(event) applies each device's preferences, the
 * dormancy rule and the Live Activity and widget rules, then fans the push
 * out to every registered device.
 *
 * WHY: BUILD-CONTRACT 3.4.2. B2 and B3 call notify() with plain events and
 * never build payloads. Without an APNs key the sender is dormant: nothing is
 * sent and capabilities.push is false (PROTOCOL.md 10, A18).
 */
'use strict';

const fs = require('fs');
const payloads = require('./payloads');
const apnsMod = require('./apns');

/** Live Activity low priority throttle per device (PROTOCOL.md 10.4). */
const ACTIVITY_LOW_PRIORITY_GAP_MS = 15 * 1000;
/** Widget push throttle per device. */
const WIDGET_GAP_MS = 15 * 60 * 1000;
/** Five failures in ten minutes publish APNS_FAILING. */
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 5;

/**
 * Create the notifier.
 *
 * @param {object} deps - {devices, identity, computerName(), getSettings(), getHub(), now, log}.
 * @returns {object} {notify, isConfigured, configure, sendTest, status, close, _setTransport}.
 */
function createNotifier(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  let client = null;
  let clientKey = null;
  let transport = {};
  let lastError = null;
  const failures = [];
  let noticeAt = 0;
  /** Open needs-you prompts, for the badge: "sessionId:promptId". */
  const openPrompts = new Set();
  /** deviceId -> {lowAt, pending, timer, active: boolean} */
  const activityState = new Map();
  /** deviceId -> last widget push time */
  const widgetAt = new Map();

  /**
   * The loaded APNs config, or null when dormant.
   *
   * @returns {{teamId, keyId, key, bundleId}|null}
   */
  function loadConfig() {
    const apns = deps.getSettings().apns;
    if (!apns || !apns.keyFile || !apns.teamId || !apns.keyId) return null;
    try {
      const key = apnsMod.loadP8(fs.readFileSync(apns.keyFile, 'utf8'));
      return { teamId: apns.teamId, keyId: apns.keyId, key, bundleId: apns.bundleId || payloads.BUNDLE_ID, keyFile: apns.keyFile };
    } catch (err) {
      lastError = 'The APNs key file could not be loaded.';
      return null;
    }
  }

  /** @returns {object|null} a client for the current config */
  function getClient() {
    const cfg = loadConfig();
    if (!cfg) {
      if (client) { client.close(); client = null; clientKey = null; }
      return null;
    }
    const key = cfg.teamId + '|' + cfg.keyId + '|' + cfg.keyFile;
    if (!client || clientKey !== key) {
      if (client) client.close();
      client = apnsMod.createApnsClient(Object.assign({ config: cfg, now }, transport));
      clientKey = key;
    }
    return client;
  }

  /** Record a delivery failure; five in ten minutes publish a notice. */
  function recordFailure(reason) {
    const t = now();
    failures.push(t);
    while (failures.length && failures[0] < t - FAILURE_WINDOW_MS) failures.shift();
    if (failures.length >= FAILURE_THRESHOLD) {
      lastError = 'APNs is failing: ' + String(reason || 'unknown').slice(0, 120);
      if (t - noticeAt > FAILURE_WINDOW_MS) {
        noticeAt = t;
        const hub = deps.getHub && deps.getHub();
        if (hub && typeof hub.publish === 'function') {
          try {
            hub.publish('computer', 'computer.notice', { notice: {
              noticeId: 'apns-' + t, level: 'warn', code: 'APNS_FAILING',
              message: 'Notifications from ' + deps.computerName() + ' are failing.',
              sessionId: null, accountId: null, createdAtMs: t, expiresAtMs: null,
            } });
          } catch (_) { /* best effort */ }
        }
      }
    }
  }

  /**
   * Send one built push to one device token, handling token removal.
   *
   * @param {object} device - Device record.
   * @param {string} deviceToken - Hex token.
   * @param {object} built - From payloads.*.
   * @returns {Promise<object|null>}
   */
  async function deliver(device, deviceToken, built) {
    const c = getClient();
    if (!c || !deviceToken) return null;
    const r = await c.send({
      deviceToken,
      environment: device.push && device.push.environment === 'sandbox' ? 'sandbox' : 'production',
      pushType: built.pushType,
      topic: built.topic,
      priority: built.priority,
      expiration: built.expiration,
      collapseId: built.collapseId,
      payload: built.payload,
    });
    if (r.removeToken) {
      deps.devices.dropApnsToken(device.deviceId, deviceToken);
      deps.devices.setPushError(device.deviceId, 'Apple said the token is no longer valid (' + (r.reason || r.status) + ').');
    } else if (!r.ok) {
      deps.devices.setPushError(device.deviceId, 'APNs: ' + (r.reason || ('HTTP ' + r.status)));
      recordFailure(r.reason);
    } else if (device.pushLastError) {
      deps.devices.setPushError(device.deviceId, null);
    }
    return r;
  }

  /** @param {object} d @returns {object} env for payload builders */
  function envFor(d) {
    return { computerId: deps.identity.computerId, computerName: deps.computerName(), prefs: d.preferences, badge: openPrompts.size, nowMs: now() };
  }

  /**
   * Live Activity handling for one device (PROTOCOL.md 10.4).
   *
   * @param {object} d - Device record.
   * @param {object} event - Activity event.
   * @param {boolean} [flush] - Sending a throttled pending update.
   * @returns {Promise<void>}
   */
  async function activityFor(d, event, flush) {
    if (!d.preferences || !d.preferences.liveActivity || d.preferences.liveActivity.enabled === false) return;
    const st = activityState.get(d.deviceId) || { lowAt: 0, pending: null, timer: null };
    activityState.set(d.deviceId, st);
    const env = envFor(d);
    const list = payloads.activitySessions(event.sessions, d.preferences, env.computerName);
    const newest = d.liveActivities && d.liveActivities.length ? d.liveActivities[d.liveActivities.length - 1] : null;
    if (!list.length) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; st.pending = null; }
      if (newest) await deliver(d, newest.pushToken, payloads.buildActivity('end', event, env));
      return;
    }
    if (!newest) {
      const startToken = d.push && d.push.liveActivityPushToStartToken;
      if (startToken) await deliver(d, startToken, payloads.buildActivity('start', Object.assign({}, event, { needsYouChanged: true }), env));
      return;
    }
    const high = !!event.needsYouChanged;
    const t = now();
    if (!high && !flush && t - st.lowAt < ACTIVITY_LOW_PRIORITY_GAP_MS) {
      st.pending = event;
      if (!st.timer) {
        st.timer = setTimeout(() => {
          st.timer = null;
          const pending = st.pending;
          st.pending = null;
          const fresh = deps.devices.get(d.deviceId);
          if (pending && fresh) activityFor(fresh, pending, true).catch(() => {});
        }, ACTIVITY_LOW_PRIORITY_GAP_MS - (t - st.lowAt));
        if (st.timer.unref) st.timer.unref();
      }
      return;
    }
    if (!high) st.lowAt = t;
    await deliver(d, newest.pushToken, payloads.buildActivity('update', event, env));
  }

  /**
   * Notify every eligible device of an event (BUILD-CONTRACT 3.4.2 shapes).
   *
   * @param {object} event - {kind, ...}.
   * @returns {Promise<void>}
   */
  async function notify(event) {
    if (!event || !event.kind) return;
    if (payloads.NEEDS_YOU.has(event.kind) && event.sessionId) openPrompts.add(event.sessionId + ':' + (event.promptId || ''));
    if (event.kind === 'resolved') openPrompts.delete(event.sessionId + ':' + (event.promptId || ''));
    if (!getClient()) return; // dormant: nothing is sent without a key
    const hub = deps.getHub && deps.getHub();
    const sends = [];
    for (const d of deps.devices.list()) {
      try {
        if (event.kind === 'activity') {
          sends.push(activityFor(d, event));
          continue;
        }
        if (event.kind === 'widgets') {
          const token = d.push && d.push.widgetPushToken;
          const last = widgetAt.get(d.deviceId) || 0;
          if (!token || now() - last < WIDGET_GAP_MS) continue;
          widgetAt.set(d.deviceId, now());
          sends.push(deliver(d, token, payloads.buildWidgets({ nowMs: now() })));
          continue;
        }
        if (!d.push || !d.push.apnsToken) continue;
        if (event.kind === 'resolved') {
          sends.push(deliver(d, d.push.apnsToken, payloads.buildResolved(event, envFor(d))));
          continue;
        }
        if (event.kind === 'finished') {
          // Only to devices with no open stream socket; true when B2 is absent.
          const connected = hub && typeof hub.isDeviceConnected === 'function' ? hub.isDeviceConnected(d.deviceId) : true;
          if (connected) continue;
        }
        const built = payloads.buildAlert(event, envFor(d));
        if (built) sends.push(deliver(d, d.push.apnsToken, built));
      } catch (err) {
        log('[mobile] push fan out failed: ' + err.message);
      }
    }
    await Promise.all(sends.map((p) => Promise.resolve(p).catch((err) => log('[mobile] push failed: ' + err.message))));
  }

  /**
   * Send "Test from <computer>." to one device (admin test push).
   *
   * @param {string} deviceId - Device.
   * @returns {Promise<{ok: boolean, apnsId?: string, reason?: string, code?: string}>}
   */
  async function sendTest(deviceId) {
    const d = deps.devices.get(deviceId);
    if (!d) return { ok: false, code: 'DEVICE_UNKNOWN' };
    if (!getClient()) return { ok: false, code: 'PUSH_NOT_CONFIGURED' };
    if (!d.push || !d.push.apnsToken) return { ok: false, code: 'PUSH_NOT_REGISTERED' };
    const built = payloads.buildAlert({ kind: 'test' }, envFor(d));
    const r = await deliver(d, d.push.apnsToken, built);
    if (r && r.ok) return { ok: true, apnsId: r.apnsId || '' };
    return { ok: false, code: 'APNS_ERROR', reason: (r && (r.reason || ('HTTP ' + r.status))) || 'unknown' };
  }

  /**
   * When a device turns Live Activities off, end its running activity.
   *
   * @param {string} deviceId - Device.
   * @returns {Promise<void>}
   */
  async function onLiveActivityDisabled(deviceId) {
    const d = deps.devices.get(deviceId);
    if (!d || !getClient()) return;
    const newest = d.liveActivities && d.liveActivities.length ? d.liveActivities[d.liveActivities.length - 1] : null;
    if (newest) await deliver(d, newest.pushToken, payloads.buildActivity('end', { sessions: [] }, envFor(d)));
  }

  return {
    notify,
    sendTest,
    onLiveActivityDisabled,
    /** @returns {boolean} true when an APNs key is configured and loads */
    isConfigured() { return loadConfig() !== null; },
    /** Drop the cached client so a new key takes effect. */
    configure() { if (client) client.close(); client = null; clientKey = null; lastError = null; },
    /** @returns {{configured: boolean, keyId: string|null, lastError: string|null}} */
    status() {
      const apns = deps.getSettings().apns;
      const configured = loadConfig() !== null;
      return { configured, keyId: apns && apns.keyId ? apns.keyId : null, lastError: configured ? lastError : (apns ? lastError : null) };
    },
    /** Close the HTTP/2 sessions and timers. */
    close() {
      if (client) client.close();
      client = null;
      for (const st of activityState.values()) if (st.timer) clearTimeout(st.timer);
    },
    /** For tests: {hosts, delay, connectOptions}. */
    _setTransport(t) { transport = t || {}; if (client) client.close(); client = null; clientKey = null; },
    /** For tests: the current badge count. */
    _badge() { return openPrompts.size; },
  };
}

module.exports = { createNotifier, ACTIVITY_LOW_PRIORITY_GAP_MS, WIDGET_GAP_MS };
