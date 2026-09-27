/**
 * context.js: validates and completes the ctx object that startMobile(ctx)
 * receives (BUILD-CONTRACT 3.4.1), and resolves the effective mobile settings
 * from the store plus environment overrides (PROTOCOL.md 1.4).
 *
 * WHY: B2 and B3 code against ctx in parallel, so its shape is checked in one
 * place, and the sandbox Workbook on the Mac is configured by environment
 * variables without touching any settings file (P21).
 */
'use strict';

const os = require('os');
const { validatePublicUrl } = require('./endpoints');

/** Defaults of settings.mobile (PROTOCOL.md 1.4). */
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 3458,
  legacyPairEnabled: false,
  publicUrls: [],
  detectTailscale: true,
  advertiseLoopback: false,
  qrLinkStyle: 'scheme',
  apns: null,
  minClientBuild: null,
});

/** Loopback bind addresses allowed in revision 0 (P25). */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);
/** Longest computer name shown. */
const NAME_MAX_CHARS = 64;
/** Highest TCP port. */
const MAX_PORT = 65535;

/**
 * Whether a bind host is loopback.
 *
 * @param {*} host - Candidate.
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  return typeof host === 'string' && LOOPBACK_HOSTS.includes(host.trim());
}

/**
 * Resolve the effective mobile settings: defaults, then settings.mobile, then
 * environment overrides. Invalid environment values are reported in
 * `envErrors` rather than thrown.
 *
 * @param {object} storeSettings - The store's settings object (may be null).
 * @param {object} [env=process.env] - Environment.
 * @returns {object} Effective settings plus {envErrors: string[], envHost: boolean}.
 */
function resolveSettings(storeSettings, env) {
  const e = env || process.env;
  const stored = (storeSettings && storeSettings.mobile && typeof storeSettings.mobile === 'object') ? storeSettings.mobile : {};
  const s = Object.assign({}, DEFAULT_SETTINGS, stored);
  s.publicUrls = Array.isArray(s.publicUrls) ? s.publicUrls.slice() : [];
  s.envErrors = [];
  s.envHost = false;
  if (e.CWM_MOBILE_ENABLED === '1') s.enabled = true;
  if (e.CWM_MOBILE_DISABLED === '1') s.enabled = false;
  if (typeof e.CWM_MOBILE_HOST === 'string' && e.CWM_MOBILE_HOST !== '') {
    s.host = e.CWM_MOBILE_HOST.trim();
    s.envHost = true;
  }
  if (typeof e.CWM_MOBILE_PORT === 'string' && e.CWM_MOBILE_PORT !== '') {
    const p = Number(e.CWM_MOBILE_PORT);
    if (Number.isInteger(p) && p >= 0 && p <= MAX_PORT) s.port = p;
    else s.envErrors.push('CWM_MOBILE_PORT is not a port number');
  }
  if (typeof e.CWM_MOBILE_PUBLIC_URLS === 'string' && e.CWM_MOBILE_PUBLIC_URLS !== '') {
    const urls = [];
    for (const raw of e.CWM_MOBILE_PUBLIC_URLS.split(',')) {
      const v = validatePublicUrl(raw);
      if (v) urls.push(v);
      else if (raw.trim()) s.envErrors.push('dropped a CWM_MOBILE_PUBLIC_URLS entry that is not https or loopback http');
    }
    s.publicUrls = urls;
  }
  if (e.CWM_MOBILE_ADVERTISE_LOOPBACK === '1') s.advertiseLoopback = true;
  s.publicUrls = s.publicUrls.map(validatePublicUrl).filter(Boolean);
  return s;
}

/**
 * The computer's display name: settings.serverName, else the OS host name
 * (never the npm package name, R02:218).
 *
 * @param {object} storeSettings - Store settings.
 * @returns {string}
 */
function computerName(storeSettings) {
  const configured = storeSettings && typeof storeSettings.serverName === 'string' ? storeSettings.serverName.trim() : '';
  const name = configured && configured !== 'myrlin-workbook' ? configured : os.hostname();
  return Array.from(name.replace(/[\r\n]/g, ' ')).slice(0, NAME_MAX_CHARS).join('') || 'Workbook';
}

/**
 * Validate and complete ctx. Missing optional members get safe defaults so
 * B1 runs alone and tests can pass a small ctx.
 *
 * @param {object} ctx - The context from buildMobileContext().
 * @returns {object} The same object, completed.
 */
function completeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('[mobile] startMobile needs a ctx object');
  if (!ctx.store || typeof ctx.store !== 'object') throw new Error('[mobile] ctx.store is required');
  if (!ctx.dataDir) ctx.dataDir = require('../../utils/data-dir').getDataDir();
  if (!ctx.packageVersion) ctx.packageVersion = require('../../../package.json').version;
  if (typeof ctx.broadcastSSE !== 'function') ctx.broadcastSSE = () => {};
  if (typeof ctx.getPtyManager !== 'function') ctx.getPtyManager = () => null;
  if (!ctx.search) ctx.search = {};
  if (!ctx.mobile || typeof ctx.mobile !== 'object') ctx.mobile = {};
  if (typeof ctx.now !== 'function') ctx.now = Date.now;
  if (typeof ctx.log !== 'function') ctx.log = (msg) => console.log(msg);
  return ctx;
}

module.exports = { DEFAULT_SETTINGS, LOOPBACK_HOSTS, isLoopbackHost, resolveSettings, computerName, completeContext };
