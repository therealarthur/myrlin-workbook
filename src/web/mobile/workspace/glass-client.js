/**
 * workspace/glass-client.js: Workbook's client of Myrlin Glass's local
 * agent API (/v1 on loopback) and reader of Glass's state.json
 * (PROTOCOL.md 4.11 sources 1 and 2; R01 sections 4.4 and 7).
 *
 * WHY: Glass is the single usage poller on the computer (R01:404) and its
 * /v1/status is already the phone's data model. The API refuses any
 * non loopback Host, any Origin header and a missing bearer (R01:284), so
 * only Workbook, on the same machine, calls it: loopback address, a
 * loopback Host header, no Origin, and the bearer from api.json, which
 * changes at every Glass start and is therefore read again after any 401.
 * When the API is down, state.json (the same payload, written at every
 * publish) is read with its age. The token is never logged.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

/** Per request timeout. */
const REQUEST_TIMEOUT_MS = 3000;
/** The API counts as available when it answered this recently (PROTOCOL.md 3.2). */
const API_FRESH_MS = 60 * 1000;
/** Largest answer body read. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Debounce of the state.json watcher. */
const WATCH_DEBOUNCE_MS = 500;
/** Poll interval when fs.watch is not available. */
const WATCH_POLL_MS = 5000;

/**
 * Glass's data folder: CWM_GLASS_DIR (tests and unusual installs), else
 * %LOCALAPPDATA%\Quota on Windows, the Application Support folder on
 * macOS, and ~/.local/share/Quota elsewhere; null (Glass off) for a
 * Workbook on a non default data folder without CWM_GLASS_DIR.
 *
 * @param {object} [env] - Environment.
 * @returns {string|null}
 */
function quotaDir(env) {
  const e = env || process.env;
  if (e.CWM_GLASS_DIR) return path.resolve(e.CWM_GLASS_DIR);
  // A Workbook on a data folder other than the default (a test process, the
  // Mac sandbox) never talks to this computer's real Glass unless
  // CWM_GLASS_DIR names one: its swaps, refreshes and sign ins are real.
  if (isolatedDataDir(e)) return null;
  if (process.platform === 'win32') return path.join(e.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Quota');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Quota');
  return path.join(os.homedir(), '.local', 'share', 'Quota');
}

/**
 * Whether this process runs on a data folder other than Workbook's default
 * (~/.myrlin, src/utils/data-dir.js): tests and sandboxes set CWM_DATA_DIR.
 * Paths compare case insensitively on Windows.
 *
 * @param {object} e - Environment.
 * @returns {boolean}
 */
function isolatedDataDir(e) {
  if (!e.CWM_DATA_DIR) return false;
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(e.CWM_DATA_DIR) !== norm(path.join(os.homedir(), '.myrlin'));
}

/**
 * Create a Glass client.
 *
 * @param {object} [o] - {env, now, log, timeoutMs}
 * @returns {object}
 */
function createGlassClient(o) {
  const opts = o || {};
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  let api = null;
  let lastOkAtMs = 0;
  let loggedDown = false;

  /** @returns {string|null} the Quota folder, or null when Glass is off for this process */
  function dir() { return quotaDir(env); }

  /**
   * Read api.json ({port, token, pid, startedAtMs, version}); null when absent.
   *
   * @returns {object|null}
   */
  function readApiFile() {
    if (!dir()) return null;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir(), 'api.json'), 'utf8'));
      if (a && Number.isInteger(a.port) && a.port > 0 && typeof a.token === 'string' && a.token) return a;
    } catch (_) { /* absent or unreadable */ }
    return null;
  }

  /**
   * One HTTP request to Glass. Resolves {status, body}; rejects on a
   * transport failure or timeout.
   *
   * @param {object} a - api.json contents.
   * @param {string} method - Method.
   * @param {string} p - Path under /v1.
   * @param {object|null} body - JSON body.
   * @returns {Promise<{status: number, body: *}>}
   */
  function once(a, method, p, body) {
    return new Promise((resolve, reject) => {
      const payload = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = {
        Host: '127.0.0.1:' + a.port,
        Authorization: 'Bearer ' + a.token,
        Accept: 'application/json',
      };
      if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
      const req = http.request({ host: '127.0.0.1', port: a.port, method, path: p, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => { req.destroy(Object.assign(new Error('Glass did not answer in time'), { code: 'TIMEOUT' })); });
      req.on('error', (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * A request with the api.json re-read rule: a 401 reads api.json again
   * (the token changes at every Glass start) and retries once.
   *
   * @param {string} method - Method.
   * @param {string} p - Path.
   * @param {object|null} [body] - JSON body.
   * @returns {Promise<{status: number, body: *}|null>} null when Glass is not installed or not running.
   */
  async function request(method, p, body) {
    if (!api) api = readApiFile();
    if (!api) return null;
    try {
      let r = await once(api, method, p, body);
      if (r.status === 401) {
        api = readApiFile();
        if (!api) return null;
        r = await once(api, method, p, body);
      }
      if (r.status >= 200 && r.status < 500) {
        lastOkAtMs = now();
        loggedDown = false;
      }
      return r;
    } catch (err) {
      api = null; // the port may have changed; read api.json next time
      if (!loggedDown) { loggedDown = true; log('Glass API not reachable: ' + ((err && err.code) || 'error')); }
      return null;
    }
  }

  /**
   * GET /v1/status, or null.
   *
   * @returns {Promise<object|null>}
   */
  async function status() {
    const r = await request('GET', '/v1/status', null);
    return r && r.status === 200 && r.body && Array.isArray(r.body.accounts) ? r.body : null;
  }

  /**
   * GET /v1/recommend?provider=, or null.
   *
   * @param {string} provider - claude or codex.
   * @returns {Promise<object|null>}
   */
  async function recommend(provider) {
    const r = await request('GET', '/v1/recommend?provider=' + encodeURIComponent(provider), null);
    return r && r.status === 200 && r.body ? r.body : null;
  }

  /**
   * POST /v1/refresh {provider?}.
   *
   * @param {string|null} provider - Provider or null for both.
   * @returns {Promise<object|null>}
   */
  async function refresh(provider) {
    const r = await request('POST', '/v1/refresh', provider ? { provider } : {});
    return r ? { status: r.status, body: r.body } : null;
  }

  /**
   * POST /v1/login {provider, email?}.
   *
   * @param {string} provider - Provider.
   * @param {string|null} email - Re-login target, or null for a new account.
   * @returns {Promise<{status: number, body: *}|null>}
   */
  async function login(provider, email) {
    return request('POST', '/v1/login', email ? { provider, email } : { provider });
  }

  /**
   * GET /v1/login/<flowId>.
   *
   * @param {string} flowId - Flow id.
   * @returns {Promise<{status: number, body: *}|null>}
   */
  async function loginStatus(flowId) {
    return request('GET', '/v1/login/' + encodeURIComponent(flowId), null);
  }

  /**
   * state.json: the StatusPayload Glass writes at every publish, with its
   * age. Null when absent.
   *
   * @returns {{payload: object, ageMs: number}|null}
   */
  function readStateFile() {
    if (!dir()) return null;
    const file = path.join(dir(), 'state.json');
    try {
      const st = fs.statSync(file);
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!payload || !Array.isArray(payload.accounts)) return null;
      return { payload, ageMs: Math.max(0, now() - st.mtimeMs) };
    } catch (_) {
      return null;
    }
  }

  /**
   * Age of state.json in ms, or null when absent.
   *
   * @returns {number|null}
   */
  function stateFileAgeMs() {
    if (!dir()) return null;
    try { return Math.max(0, now() - fs.statSync(path.join(dir(), 'state.json')).mtimeMs); } catch (_) { return null; }
  }

  /**
   * Watch state.json and call fn (debounced) when it changes. Falls back to
   * a poll of its modification time.
   *
   * @param {Function} fn - Callback.
   * @returns {Function} Stop.
   */
  function watchStateFile(fn) {
    if (!dir()) return () => {};
    const folder = dir();
    const stateFile = path.join(folder, 'state.json');
    let timer = null;
    let watcher = null;
    let poll = null;
    let stopped = false;
    let lastMtime = -1;
    const fire = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => { timer = null; try { fn(); } catch (_) { /* theirs */ } }, WATCH_DEBOUNCE_MS);
      if (timer.unref) timer.unref();
    };

    /** Poll only while no directory watcher exists, then retry attaching it. */
    function startFallback() {
      if (stopped || poll) return;
      poll = setInterval(() => {
        let m = -1;
        try { m = fs.statSync(stateFile).mtimeMs; } catch (_) { /* absent */ }
        if (m !== lastMtime) { lastMtime = m; fire(); }
        attachWatcher();
      }, WATCH_POLL_MS);
      if (poll.unref) poll.unref();
    }

    /** Watch the directory so an atomic replacement of state.json stays visible. */
    function attachWatcher() {
      if (stopped || watcher) return;
      try {
        watcher = fs.watch(folder, (ev, name) => { if (!name || String(name) === 'state.json') fire(); });
        watcher.on('error', () => {
          if (watcher) { try { watcher.close(); } catch (_) { /* already closed */ } }
          watcher = null;
          startFallback();
        });
        if (poll) { clearInterval(poll); poll = null; }
      } catch (_) {
        watcher = null;
        startFallback();
      }
    }

    attachWatcher();
    return () => {
      stopped = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (watcher) { try { watcher.close(); } catch (_) {} }
    };
  }

  return {
    dir,
    readApiFile,
    request,
    status,
    recommend,
    refresh,
    login,
    loginStatus,
    readStateFile,
    stateFileAgeMs,
    watchStateFile,
    /** Glass answered within the last 60 s (capabilities.glassApi). */
    apiUp: () => lastOkAtMs > 0 && now() - lastOkAtMs < API_FRESH_MS,
    installed: () => !!readApiFile(),
  };
}

module.exports = { createGlassClient, quotaDir, API_FRESH_MS };
