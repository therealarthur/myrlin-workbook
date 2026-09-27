/**
 * device-routes.js: GET /computer, GET /browse and the /devices/me routes
 * (PROTOCOL.md 4.1 to 4.3).
 *
 * WHY: the phone reads the computer's capabilities and limits, picks a
 * working directory for a new session, and manages its own record: name,
 * unpairing, push registration, Live Activity tokens and preferences.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const errors = require('./errors');
const devicesMod = require('./devices');

/** The limits of PROTOCOL.md 14 the app enforces before sending. */
const LIMITS = Object.freeze({
  sendMaxChars: 100000,
  attachmentsMax: 20,
  sendQueueMax: 10,
  uploadChunkBytes: 8 * 1024 * 1024,
  uploadMaxImageBytes: 20 * 1024 * 1024,
  uploadMaxVideoBytes: 1024 * 1024 * 1024,
  uploadQuotaBytes: 4 * 1024 * 1024 * 1024,
});
/** Browse returns at most this many entries. */
const BROWSE_MAX_ENTRIES = 500;
/** Longest path accepted (server.js sanitizeWorkingDir). */
const PATH_MAX_CHARS = 500;
/** Activity id pattern for the Live Activity routes. */
const ACTIVITY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The same rule as Workbook's sanitizeWorkingDir (server.js:204): reject
 * shell metacharacters and silly lengths.
 *
 * @param {*} dir - Candidate.
 * @returns {string|null}
 */
function sanitizeDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const trimmed = dir.trim();
  if (trimmed.length === 0 || trimmed.length > PATH_MAX_CHARS) return null;
  if (/[;&|`$(){}[\]<>!#*?\n\r]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Mount the routes.
 *
 * @param {object} router - The mobile router.
 * @param {object} rt - Runtime: {devices, auth, audit, notifier, identity, endpoints,
 *   computerName(), packageVersion, getStreamEpoch(), capabilities(), revokeDevice(id, by), now}.
 */
function mountDeviceRoutes(router, rt) {
  router.route('GET', '/computer', () => ({
    computerId: rt.identity.computerId,
    name: rt.computerName(),
    hostname: os.hostname(),
    platform: process.platform,
    workbookVersion: rt.packageVersion,
    apiVersion: errors.API_VERSION,
    apiRevision: errors.API_REVISION,
    computerPublicKey: rt.identity.publicKey,
    streamEpoch: rt.getStreamEpoch(),
    ts: rt.now(),
    capabilities: rt.capabilities(),
    endpoints: rt.endpoints.list(),
    limits: Object.assign({}, LIMITS),
  }));

  router.route('GET', '/browse', (req) => {
    const requested = req.query.path === undefined || req.query.path === '' ? os.homedir() : req.query.path;
    const clean = sanitizeDir(requested);
    if (!clean || !path.isAbsolute(clean)) throw errors.fail('PATH_NOT_ALLOWED');
    const resolved = path.resolve(clean);
    let stat;
    try { stat = fs.statSync(resolved); } catch (_) { throw errors.fail('PATH_NOT_FOUND'); }
    if (!stat.isDirectory()) throw errors.fail('PATH_NOT_FOUND');
    let dirents;
    try { dirents = fs.readdirSync(resolved, { withFileTypes: true }); } catch (_) { throw errors.fail('PATH_NOT_ALLOWED'); }
    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .slice(0, BROWSE_MAX_ENTRIES);
    const parent = path.dirname(resolved);
    return { path: resolved, parent: parent === resolved ? null : parent, entries };
  });

  router.route('GET', '/devices/me', (req, res, auth) => rt.devices.toDevice(auth.deviceId));

  router.route('PATCH', '/devices/me', (req, res, auth) => {
    const b = req.body || {};
    if (!devicesMod.isValidName(b.name)) throw errors.fail('INVALID_FIELD', 'The name must be 1 to 64 characters on one line.', { field: 'name' });
    req.noteUnknownFields(['name']);
    rt.devices.rename(auth.deviceId, b.name);
    rt.broadcastDevicesChanged();
    return rt.devices.toDevice(auth.deviceId);
  });

  router.route('DELETE', '/devices/me', (req, res, auth) => {
    rt.revokeDevice(auth.deviceId, 'phone');
    errors.sendEmpty(res, 204);
  });

  router.route('PUT', '/devices/me/push', (req, res, auth) => {
    devicesMod.validatePushRegistration(req.body);
    req.noteUnknownFields(['apnsToken', 'environment', 'bundleId', 'liveActivityPushToStartToken', 'widgetPushToken']);
    rt.devices.setPush(auth.deviceId, req.body);
    rt.broadcastDevicesChanged();
    return rt.devices.toDevice(auth.deviceId);
  });

  router.route('DELETE', '/devices/me/push', (req, res, auth) => {
    rt.devices.clearPush(auth.deviceId);
    rt.broadcastDevicesChanged();
    return rt.devices.toDevice(auth.deviceId);
  });

  router.route('PUT', '/devices/me/live-activities/:activityId', (req, res, auth) => {
    const id = req.params.activityId;
    const b = req.body || {};
    if (!ACTIVITY_ID_RE.test(id)) throw errors.fail('INVALID_FIELD', null, { field: 'activityId' });
    if (typeof b.pushToken !== 'string' || !devicesMod.HEX_TOKEN_RE.test(b.pushToken)) throw errors.fail('INVALID_FIELD', null, { field: 'pushToken' });
    if (!Number.isSafeInteger(b.startedAtMs) || b.startedAtMs < 0) throw errors.fail('INVALID_FIELD', null, { field: 'startedAtMs' });
    req.noteUnknownFields(['pushToken', 'startedAtMs']);
    rt.devices.setLiveActivity(auth.deviceId, id, { pushToken: b.pushToken, startedAtMs: b.startedAtMs });
    errors.sendEmpty(res, 204);
  });

  router.route('DELETE', '/devices/me/live-activities/:activityId', (req, res, auth) => {
    rt.devices.deleteLiveActivity(auth.deviceId, req.params.activityId);
    errors.sendEmpty(res, 204);
  });

  router.route('GET', '/devices/me/preferences', (req, res, auth) => rt.devices.getPreferences(auth.deviceId));

  router.route('PATCH', '/devices/me/preferences', (req, res, auth) => {
    const { before, after } = rt.devices.patchPreferences(auth.deviceId, req.body);
    if (before.liveActivity.enabled && !after.liveActivity.enabled && rt.notifier) {
      rt.notifier.onLiveActivityDisabled(auth.deviceId).catch(() => {});
    }
    return after;
  });
}

module.exports = { mountDeviceRoutes, sanitizeDir, LIMITS };
