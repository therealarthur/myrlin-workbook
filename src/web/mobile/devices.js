/**
 * devices.js: paired phone records at <dataDir>/mobile/devices.json.
 *
 * WHY: PROTOCOL.md 2.7. Workbook stores only each phone's public key and
 * metadata (no secret), its scopes, preferences, push registration and Live
 * Activity tokens, plus tombstones kept 365 days so a revoked phone gets a
 * signed DEVICE_REVOKED. Kept apart from workspaces.json so the legacy
 * pairedDevices list and its plaintext tokens are untouched.
 *
 * Listeners: onRevoked(fn(deviceId)) and onScopesChanged(fn(deviceId, scopes))
 * are how B2 closes sockets and drops topics (BUILD-CONTRACT 3.4.2).
 */
'use strict';

const path = require('path');
const { writeJsonAtomic, readJson } = require('./fs-atomic');
const signing = require('./signing');
const errors = require('./errors');
const { SCOPES, GRANTABLE_SCOPES } = require('./scope-table');

/** devices.json format version. */
const DEVICES_FORMAT = 1;
/** Tombstones older than this are forgotten. */
const TOMBSTONE_KEEP_MS = 365 * 24 * 60 * 60 * 1000;
/** lastSeenAtMs is persisted at most once a minute per device. */
const LAST_SEEN_WRITE_MS = 60 * 1000;
/** At most this many Live Activity tokens per device; the oldest is dropped. */
const LIVE_ACTIVITY_MAX = 4;
/** Device name bounds. */
const NAME_MAX_CHARS = 64;
/** Longest stored lastError. */
const LAST_ERROR_MAX_CHARS = 200;
/** Allowed finishedMinMinutes range. */
const FINISHED_MIN_MINUTES = 1;
const FINISHED_MAX_MINUTES = 120;
/** Hex token pattern (defs.json HexToken). */
const HEX_TOKEN_RE = /^[0-9a-fA-F]{16,512}$/;
/** Bundle id of the app (A22). */
const BUNDLE_ID = 'io.myrlin.workbook';

/** Default preferences (PROTOCOL.md 3.3). */
function defaultPreferences() {
  return {
    notifications: {
      question: true,
      approval: true,
      finished: true,
      finishedMinMinutes: 2,
      accountThresholds: true,
      agentSwaps: true,
      migrationReady: true,
    },
    privacy: { hideSessionNames: false, showMessageText: false },
    liveActivity: { enabled: true },
  };
}

/**
 * Validate a device name: 1 to 64 characters, no line breaks.
 *
 * @param {*} name - Candidate.
 * @returns {boolean}
 */
function isValidName(name) {
  return typeof name === 'string' && Array.from(name).length >= 1 && Array.from(name).length <= NAME_MAX_CHARS && !/[\r\n]/.test(name);
}

/**
 * Validate and sort a scope list for granting. Unknown scopes and pty.raw
 * answer 400 INVALID_SCOPE (PROTOCOL.md 2.6, P26).
 *
 * @param {*} scopes - Candidate list.
 * @returns {string[]} Sorted ascending by byte value, unique.
 */
function normalizeGrantScopes(scopes) {
  if (!Array.isArray(scopes)) throw errors.fail('INVALID_SCOPE', 'Scopes must be a list.');
  for (const s of scopes) {
    if (typeof s !== 'string' || !SCOPES.includes(s)) throw errors.fail('INVALID_SCOPE', 'The permission "' + String(s).slice(0, 40) + '" is not known.');
    if (!GRANTABLE_SCOPES.includes(s)) throw errors.fail('INVALID_SCOPE', 'The terminal permission is not available in this version.');
  }
  return Array.from(new Set(scopes)).sort();
}

/**
 * Validate a preferences patch: any subset, nested merge, no nulls, no unknown
 * keys, exact types (preferences-patch.json).
 *
 * @param {*} patch - Candidate.
 */
function validatePreferencesPatch(patch) {
  const bad = (field) => errors.fail('INVALID_FIELD', 'The preference ' + field + ' is not valid.', { field });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('preferences');
  const shape = defaultPreferences();
  for (const [group, value] of Object.entries(patch)) {
    if (!shape[group]) throw bad(group);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(group);
    for (const [key, v] of Object.entries(value)) {
      const field = group + '.' + key;
      if (!(key in shape[group])) throw bad(field);
      if (v === null || v === undefined) throw bad(field);
      if (key === 'finishedMinMinutes') {
        if (!Number.isInteger(v) || v < FINISHED_MIN_MINUTES || v > FINISHED_MAX_MINUTES) throw bad(field);
      } else if (typeof v !== 'boolean') {
        throw bad(field);
      }
    }
  }
}

/**
 * Create the device store.
 *
 * @param {object} opts - {dataDir, now, log}.
 * @returns {object} The store API.
 */
function createDevices(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const file = path.join(opts.dataDir, 'mobile', 'devices.json');
  const revokedListeners = new Set();
  const scopeListeners = new Set();
  const lastSeenWrites = new Map();

  let doc = readJson(file);
  if (!doc || doc.v !== DEVICES_FORMAT || !Array.isArray(doc.devices)) {
    doc = { v: DEVICES_FORMAT, devices: [], tombstones: [] };
  }
  if (!Array.isArray(doc.tombstones)) doc.tombstones = [];
  const cutoff = now() - TOMBSTONE_KEEP_MS;
  doc.tombstones = doc.tombstones.filter((t) => t && t.revokedAtMs > cutoff);
  for (const d of doc.devices) {
    d.preferences = mergePreferences(defaultPreferences(), d.preferences || {});
    if (!Array.isArray(d.liveActivities)) d.liveActivities = [];
  }

  /** Persist the document atomically. */
  function save() {
    writeJsonAtomic(file, doc);
  }

  /**
   * Nested merge of a validated preferences patch.
   *
   * @param {object} base - Current preferences.
   * @param {object} patch - Patch.
   * @returns {object}
   */
  function mergePreferences(base, patch) {
    const out = JSON.parse(JSON.stringify(base));
    for (const [group, value] of Object.entries(patch || {})) {
      if (!out[group] || !value || typeof value !== 'object') continue;
      for (const [k, v] of Object.entries(value)) {
        if (k in out[group] && v !== null && v !== undefined) out[group][k] = v;
      }
    }
    return out;
  }

  /** @param {string} deviceId @returns {object|null} the live record */
  function record(deviceId) {
    return doc.devices.find((d) => d.deviceId === deviceId) || null;
  }

  /**
   * The public Device object (PROTOCOL.md 3.3).
   *
   * @param {object} d - Record.
   * @returns {object}
   */
  function toDevice(d) {
    return {
      deviceId: d.deviceId,
      name: d.name,
      model: d.model,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      scopes: d.scopes.slice(),
      pairedAtMs: d.pairedAtMs,
      lastSeenAtMs: d.lastSeenAtMs == null ? null : d.lastSeenAtMs,
      push: {
        registered: !!(d.push && d.push.apnsToken),
        environment: d.push ? d.push.environment : null,
        updatedAtMs: d.push ? d.push.updatedAtMs : null,
        liveActivityTokens: d.liveActivities.length,
      },
    };
  }

  /**
   * The AdminDevice object (PROTOCOL.md 11.4).
   *
   * @param {object} d - Record.
   * @param {{online: boolean}} extra - Live facts.
   * @returns {object}
   */
  function toAdminDevice(d, extra) {
    const base = toDevice(d);
    base.publicKeyFingerprint = signing.fingerprint(d.publicKey);
    base.lastEndpointKind = d.lastEndpointKind || null;
    base.online = !!(extra && extra.online);
    base.push = Object.assign({}, base.push, { lastError: d.pushLastError || null });
    base.liveActivityTokens = d.liveActivities.length;
    return base;
  }

  const api = {
    file,
    defaultPreferences,

    /** @param {string} deviceId @returns {object|null} a copy of the record, with preferences and push */
    get(deviceId) {
      const d = record(deviceId);
      return d ? JSON.parse(JSON.stringify(d)) : null;
    },

    /** @returns {object[]} copies of every active record */
    list() {
      return JSON.parse(JSON.stringify(doc.devices));
    },

    /** @returns {number} active device count */
    count() {
      return doc.devices.length;
    },

    /** @param {string} deviceId @returns {object|null} the tombstone */
    tombstoneFor(deviceId) {
      return doc.tombstones.find((t) => t.deviceId === deviceId) || null;
    },

    /** @param {string} publicKey SPKI base64url @returns {boolean} an active device holds it */
    isActiveKey(publicKey) {
      return doc.devices.some((d) => d.publicKey === publicKey);
    },

    toDevice(deviceId) {
      const d = record(deviceId);
      return d ? toDevice(d) : null;
    },

    toAdminDevice(deviceId, extra) {
      const d = record(deviceId);
      return d ? toAdminDevice(d, extra) : null;
    },

    /**
     * Create a device record at the Allow step.
     *
     * @param {object} p - {publicKey, name, model, osVersion, appVersion, scopes, pairedAtMs}.
     * @returns {object} Copy of the record.
     */
    create(p) {
      const deviceId = signing.deviceIdFromSpki(p.publicKey);
      doc.devices = doc.devices.filter((d) => d.deviceId !== deviceId);
      // Re-pairing the same key after a revocation clears its tombstone.
      doc.tombstones = doc.tombstones.filter((t) => t.deviceId !== deviceId);
      const rec = {
        deviceId,
        publicKey: p.publicKey,
        name: p.name,
        model: p.model,
        osVersion: p.osVersion,
        appVersion: p.appVersion,
        scopes: normalizeGrantScopes(p.scopes),
        pairedAtMs: p.pairedAtMs,
        lastSeenAtMs: null,
        lastEndpointKind: null,
        push: null,
        pushLastError: null,
        liveActivities: [],
        preferences: defaultPreferences(),
      };
      doc.devices.push(rec);
      save();
      return JSON.parse(JSON.stringify(rec));
    },

    /**
     * Rename a device.
     *
     * @param {string} deviceId - Device.
     * @param {string} name - New name.
     */
    rename(deviceId, name) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      if (!isValidName(name)) throw errors.fail('INVALID_FIELD', 'The name must be 1 to 64 characters on one line.', { field: 'name' });
      d.name = name;
      save();
    },

    /**
     * Replace a device's scopes and tell listeners at once (PROTOCOL.md 2.9).
     *
     * @param {string} deviceId - Device.
     * @param {string[]} scopes - New scopes (validated).
     * @returns {string[]} The stored scopes.
     */
    setScopes(deviceId, scopes) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      const next = normalizeGrantScopes(scopes);
      const changed = next.join(',') !== d.scopes.join(',');
      d.scopes = next;
      save();
      if (changed) {
        for (const fn of scopeListeners) {
          try { fn(deviceId, next.slice()); } catch (err) { log('[mobile] scope listener failed: ' + err.message); }
        }
      }
      return next.slice();
    },

    /**
     * Record that a device was seen; persisted at most once a minute.
     *
     * @param {string} deviceId - Device.
     * @param {string|null} endpointKind - How it reached us.
     */
    touch(deviceId, endpointKind) {
      const d = record(deviceId);
      if (!d) return;
      const t = now();
      d.lastSeenAtMs = t;
      const kindChanged = endpointKind && d.lastEndpointKind !== endpointKind;
      if (endpointKind) d.lastEndpointKind = endpointKind;
      const last = lastSeenWrites.get(deviceId) || 0;
      if (kindChanged || t - last >= LAST_SEEN_WRITE_MS) {
        lastSeenWrites.set(deviceId, t);
        try { save(); } catch (err) { log('[mobile] devices.json write failed: ' + err.message); }
      }
    },

    /** @param {string} deviceId @returns {object} preferences */
    getPreferences(deviceId) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      return JSON.parse(JSON.stringify(d.preferences));
    },

    /**
     * Apply a preferences patch (nested merge).
     *
     * @param {string} deviceId - Device.
     * @param {object} patch - Validated patch.
     * @returns {{before: object, after: object}}
     */
    patchPreferences(deviceId, patch) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      validatePreferencesPatch(patch);
      const before = JSON.parse(JSON.stringify(d.preferences));
      d.preferences = mergePreferences(d.preferences, patch);
      save();
      return { before, after: JSON.parse(JSON.stringify(d.preferences)) };
    },

    /**
     * Replace the push registration (PROTOCOL.md 4.3.3).
     *
     * @param {string} deviceId - Device.
     * @param {object} reg - Validated PushRegistration.
     */
    setPush(deviceId, reg) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      d.push = {
        apnsToken: reg.apnsToken,
        environment: reg.environment,
        bundleId: reg.bundleId,
        liveActivityPushToStartToken: reg.liveActivityPushToStartToken || null,
        widgetPushToken: reg.widgetPushToken || null,
        updatedAtMs: now(),
      };
      d.pushLastError = null;
      save();
    },

    /**
     * Clear every push token of a device (DELETE /devices/me/push, revocation).
     *
     * @param {string} deviceId - Device.
     */
    clearPush(deviceId) {
      const d = record(deviceId);
      if (!d) return;
      d.push = null;
      d.liveActivities = [];
      save();
    },

    /**
     * Drop only the APNs alert token (APNs said BadDeviceToken or Unregistered).
     *
     * @param {string} deviceId - Device.
     * @param {string} token - The token APNs refused.
     */
    dropApnsToken(deviceId, token) {
      const d = record(deviceId);
      if (!d || !d.push) return;
      if (d.push.apnsToken === token) d.push = null;
      else if (d.push.liveActivityPushToStartToken === token) d.push.liveActivityPushToStartToken = null;
      else if (d.push.widgetPushToken === token) d.push.widgetPushToken = null;
      d.liveActivities = d.liveActivities.filter((a) => a.pushToken !== token);
      save();
    },

    /**
     * Remember the last push error for the Devices tab.
     *
     * @param {string} deviceId - Device.
     * @param {string|null} message - Short reason.
     */
    setPushError(deviceId, message) {
      const d = record(deviceId);
      if (!d) return;
      d.pushLastError = message ? String(message).slice(0, LAST_ERROR_MAX_CHARS) : null;
      try { save(); } catch (_) { /* best effort */ }
    },

    /**
     * Store a per activity update token; at most 4, the oldest dropped.
     *
     * @param {string} deviceId - Device.
     * @param {string} activityId - Activity id from the app.
     * @param {{pushToken: string, startedAtMs: number}} t - Token record.
     */
    setLiveActivity(deviceId, activityId, t) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      d.liveActivities = d.liveActivities.filter((a) => a.activityId !== activityId);
      d.liveActivities.push({ activityId, pushToken: t.pushToken, startedAtMs: t.startedAtMs, updatedAtMs: now() });
      d.liveActivities.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
      while (d.liveActivities.length > LIVE_ACTIVITY_MAX) d.liveActivities.shift();
      save();
    },

    /**
     * Remove a per activity token.
     *
     * @param {string} deviceId - Device.
     * @param {string} activityId - Activity id.
     */
    deleteLiveActivity(deviceId, activityId) {
      const d = record(deviceId);
      if (!d) throw errors.fail('DEVICE_UNKNOWN');
      d.liveActivities = d.liveActivities.filter((a) => a.activityId !== activityId);
      save();
    },

    /**
     * Revoke a device: move it to tombstones, clear its push tokens, and tell
     * every listener (PROTOCOL.md 2.11). Idempotent.
     *
     * @param {string} deviceId - Device.
     * @returns {object|null} The tombstone, or null when the device was unknown.
     */
    revoke(deviceId) {
      const d = record(deviceId);
      if (!d) return api.tombstoneFor(deviceId);
      doc.devices = doc.devices.filter((x) => x.deviceId !== deviceId);
      const tomb = { deviceId, revokedAtMs: now() };
      doc.tombstones = doc.tombstones.filter((t) => t.deviceId !== deviceId);
      doc.tombstones.push(tomb);
      save();
      for (const fn of revokedListeners) {
        try { fn(deviceId); } catch (err) { log('[mobile] revoke listener failed: ' + err.message); }
      }
      return tomb;
    },

    /** @param {Function} fn - fn(deviceId) @returns {Function} unsubscribe */
    onRevoked(fn) {
      revokedListeners.add(fn);
      return () => revokedListeners.delete(fn);
    },

    /** @param {Function} fn - fn(deviceId, scopes) @returns {Function} unsubscribe */
    onScopesChanged(fn) {
      scopeListeners.add(fn);
      return () => scopeListeners.delete(fn);
    },
  };
  return api;
}

/**
 * Validate a PushRegistration body (push-registration.json).
 *
 * @param {*} body - Candidate.
 */
function validatePushRegistration(body) {
  const bad = (field, msg) => errors.fail('INVALID_FIELD', msg || ('The field ' + field + ' is not valid.'), { field });
  if (!body || typeof body !== 'object') throw bad('body', 'The request body must be an object.');
  if (typeof body.apnsToken !== 'string' || !HEX_TOKEN_RE.test(body.apnsToken)) throw bad('apnsToken');
  if (body.environment !== 'sandbox' && body.environment !== 'production') throw bad('environment');
  if (body.bundleId !== BUNDLE_ID) throw bad('bundleId');
  for (const f of ['liveActivityPushToStartToken', 'widgetPushToken']) {
    if (body[f] !== null && body[f] !== undefined && (typeof body[f] !== 'string' || !HEX_TOKEN_RE.test(body[f]))) throw bad(f);
  }
}

module.exports = {
  createDevices,
  defaultPreferences,
  normalizeGrantScopes,
  validatePreferencesPatch,
  validatePushRegistration,
  isValidName,
  HEX_TOKEN_RE,
  BUNDLE_ID,
  LIVE_ACTIVITY_MAX,
  TOMBSTONE_KEEP_MS,
};
