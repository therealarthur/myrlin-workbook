/**
 * endpoints.js: the endpoint list the computer advertises, and Tailscale
 * Serve detection (PROTOCOL.md 1.5).
 *
 * WHY: the phone races these URLs, and the list is signed inside hello, so it
 * may refresh its stored endpoints after every connection. Order: each
 * mobile.publicUrls entry, then the detected Tailscale Serve URL, then
 * loopback when advertiseLoopback is on; duplicates removed; at most 5. An
 * http:// endpoint is only ever loopback (P25), so a token never crosses a
 * network in clear text.
 */
'use strict';

const { execFile } = require('child_process');

/** Maximum endpoints advertised. */
const MAX_ENDPOINTS = 5;
/** Tailscale CLI timeout per call. */
const CLI_TIMEOUT_MS = 3000;
/** Re-detect Tailscale this often while the listener runs. */
const DETECT_EVERY_MS = 5 * 60 * 1000;
/** Largest CLI output accepted. */
const CLI_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Validate one advertised URL: https:// anything, or http:// to loopback
 * only; scheme plus host plus optional port, no path.
 *
 * @param {*} url - Candidate.
 * @returns {string|null} The normalized URL, or null when refused.
 */
function validatePublicUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/$/, '');
  const m = /^(https?):\/\/([^/\s?#]+)$/.exec(trimmed);
  if (!m) return null;
  const scheme = m[1];
  const hostPort = m[2];
  const host = hostPort.replace(/:\d+$/, '').toLowerCase();
  if (scheme === 'http' && host !== '127.0.0.1' && host !== 'localhost') return null;
  return scheme + '://' + hostPort;
}

/**
 * The kind of an endpoint URL.
 *
 * @param {string} url - Endpoint URL.
 * @returns {string}
 */
function kindOf(url) {
  const host = url.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase();
  if (host.endsWith('.ts.net')) return 'tailscale';
  if (host === '127.0.0.1' || host === 'localhost') return 'loopback';
  return 'custom';
}

/**
 * Whether a serve status document proxies to 127.0.0.1:<port>.
 *
 * @param {*} doc - Parsed `tailscale serve status` JSON.
 * @param {number} port - Mobile listener port.
 * @returns {boolean}
 */
function serveProxiesTo(doc, port) {
  const wanted = new RegExp('^(?:https?://)?(?:127\\.0\\.0\\.1|localhost):' + port + '/?$');
  let found = false;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Proxy' && typeof v === 'string' && wanted.test(v.trim())) { found = true; return; }
      if (v && typeof v === 'object') walk(v);
    }
  })(doc);
  return found;
}

/**
 * Run a CLI and parse its JSON output.
 *
 * @param {string} cmd - Binary.
 * @param {string[]} args - Arguments.
 * @returns {Promise<object>}
 */
function runJsonCli(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: CLI_MAX_BUFFER }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

/**
 * Create the endpoint service.
 *
 * @param {object} deps - {getSettings(), getBoundPort?(), log, runCli?(args)}.
 * @returns {object} {list(), refresh(), start(), stop(), tailscaleName()}.
 */
function createEndpoints(deps) {
  const log = deps.log || (() => {});
  const runCli = deps.runCli || ((args) => runJsonCli('tailscale', args));
  let detected = null;
  let timer = null;
  let loggedFailure = false;

  /** @returns {number} the port the listener is bound to, else the configured one */
  function port() {
    const bound = deps.getBoundPort ? deps.getBoundPort() : null;
    return bound || deps.getSettings().port;
  }

  /**
   * Detect the Tailscale Serve URL once. Failures keep the previous value and
   * are logged once (PROTOCOL.md 1.5).
   *
   * @returns {Promise<string|null>}
   */
  async function refresh() {
    const s = deps.getSettings();
    if (!s.detectTailscale) {
      detected = null;
      return null;
    }
    try {
      const status = await runCli(['status', '--json']);
      const dns = status && status.Self && typeof status.Self.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
      if (!dns) {
        detected = null;
        return null;
      }
      const serve = await runCli(['serve', 'status', '--json']);
      detected = serveProxiesTo(serve, port()) ? 'https://' + dns.toLowerCase() : null;
      loggedFailure = false;
    } catch (err) {
      if (!loggedFailure) {
        log('[mobile] Tailscale detection failed (' + ((err && err.code) || 'error') + '); keeping the previous endpoint list');
        loggedFailure = true;
      }
    }
    return detected;
  }

  /**
   * The endpoint list, highest priority first.
   *
   * @returns {Array<{url: string, kind: string, priority: number}>}
   */
  function list() {
    const s = deps.getSettings();
    const urls = [];
    for (const u of s.publicUrls || []) {
      const v = validatePublicUrl(u);
      if (v) urls.push(v);
    }
    if (detected) urls.push(detected);
    if (s.advertiseLoopback) urls.push('http://127.0.0.1:' + port());
    const seen = new Set();
    const out = [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, kind: kindOf(url), priority: out.length });
      if (out.length >= MAX_ENDPOINTS) break;
    }
    return out;
  }

  return {
    list,
    refresh,
    /** Start periodic detection. */
    start() {
      refresh().catch(() => {});
      if (!timer) {
        timer = setInterval(() => { refresh().catch(() => {}); }, DETECT_EVERY_MS);
        if (timer.unref) timer.unref();
      }
    },
    /** Stop periodic detection. */
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** @returns {string|null} host of the first tailscale endpoint */
    tailscaleName() {
      const t = list().find((e) => e.kind === 'tailscale');
      return t ? t.url.replace(/^https?:\/\//, '').replace(/:\d+$/, '') : null;
    },
    /** For tests: set the detected URL directly. */
    _setDetected(url) { detected = url; },
  };
}

module.exports = { createEndpoints, validatePublicUrl, kindOf, serveProxiesTo, MAX_ENDPOINTS };
