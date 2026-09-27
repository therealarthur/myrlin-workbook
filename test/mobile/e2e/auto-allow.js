#!/usr/bin/env node
/**
 * auto-allow.js: sandbox only helper that plays the person at the desktop and
 * allows pending phone pairs whose device name starts with "Myrlin E2E".
 *
 * WHY: BUILD-CONTRACT section 6.1. The iOS end to end run pairs the simulator
 * with the sandbox Workbook on the Mac with nobody at the desktop. This logs
 * in to the sandbox main server with its password and, every 500 ms, allows
 * matching pending pairs with the default scopes through the same admin route
 * the Allow dialog uses. It refuses to run against a real Workbook: it needs
 * CWM_DATA_DIR and a port other than 3457 (or 3456).
 *
 * Usage (mac.sh wb-start e2e): see the USAGE constant below, which the script
 * also prints when it refuses to run. The flags stay in that code string
 * because the repository's text rules keep two hyphen flags out of comments.
 */
'use strict';

const fs = require('fs');
const http = require('http');

/** Command line usage, printed with every refusal. */
const USAGE = [
  'usage: CWM_DATA_DIR=... CWM_PASSWORD=... node test/mobile/e2e/auto-allow.js [--port 4457] [--prefix "Myrlin E2E"] [--once]',
  '       --password-file <path> reads the password from a file instead of CWM_PASSWORD',
].join('\n');

/** Poll interval (section 6.1). */
const POLL_MS = 500;
/** Default sandbox main server port (section 6.1). */
const DEFAULT_PORT = 4457;
/** Ports of a real Workbook, never touched. */
const LIVE_PORTS = new Set([3456, 3457]);
/** The six v1 scopes granted by default at Allow. */
const DEFAULT_SCOPES = ['chat', 'sessions.manage', 'accounts.read', 'accounts.swap', 'media.upload', 'search'];
/** Default device name prefix. */
const DEFAULT_PREFIX = 'Myrlin E2E';

/**
 * Parse argv flags.
 *
 * @param {string[]} argv - Arguments.
 * @returns {object}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--prefix') out.prefix = argv[++i];
    else if (a === '--password-file') out.passwordFile = argv[++i];
  }
  return out;
}

/**
 * One JSON request to the sandbox main server on 127.0.0.1.
 *
 * @param {number} port - Port.
 * @param {string} method - Method.
 * @param {string} p - Path.
 * @param {object} [body] - Body.
 * @param {string} [token] - Bearer token.
 * @returns {Promise<{status: number, body: *}>}
 */
function call(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Check the guard rails and resolve the configuration.
 *
 * @param {object} args - Parsed flags.
 * @param {object} env - Environment.
 * @returns {{ok: boolean, reason?: string, port?: number, password?: string, prefix?: string}}
 */
function resolveConfig(args, env) {
  if (!env.CWM_DATA_DIR) return { ok: false, reason: 'refusing to run: CWM_DATA_DIR is not set (sandbox only)' };
  const port = Number.isInteger(args.port) ? args.port : Number(env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, reason: 'refusing to run: no valid port' };
  if (LIVE_PORTS.has(port)) return { ok: false, reason: 'refusing to run: port ' + port + ' belongs to a real Workbook' };
  let password = env.CWM_PASSWORD || '';
  if (args.passwordFile) {
    try { password = fs.readFileSync(args.passwordFile, 'utf8').trim(); } catch (_) { return { ok: false, reason: 'refusing to run: cannot read the password file' }; }
  }
  if (!password) return { ok: false, reason: 'refusing to run: no sandbox password (CWM_PASSWORD or --password-file)' };
  return { ok: true, port, password, prefix: args.prefix || DEFAULT_PREFIX };
}

/**
 * Allow matching pending pairs once.
 *
 * @param {object} cfg - Resolved config.
 * @param {object} state - {token}.
 * @returns {Promise<number>} How many pairs were allowed.
 */
async function tick(cfg, state) {
  if (!state.token) {
    const login = await call(cfg.port, 'POST', '/api/auth/login', { password: cfg.password });
    if (!login.body || !login.body.token) throw new Error('login failed (' + login.status + ')');
    state.token = login.body.token;
  }
  const list = await call(cfg.port, 'GET', '/api/mobile-admin/pair-requests', undefined, state.token);
  if (list.status === 401) { state.token = null; return 0; }
  let allowed = 0;
  for (const p of (list.body && list.body.pending) || []) {
    if (typeof p.deviceName !== 'string' || !p.deviceName.startsWith(cfg.prefix)) continue;
    const r = await call(cfg.port, 'POST', '/api/mobile-admin/pair-requests/' + encodeURIComponent(p.pairId) + '/allow', { scopes: DEFAULT_SCOPES, name: null }, state.token);
    if (r.status === 200) {
      allowed += 1;
      console.log('[auto-allow] allowed ' + p.deviceName + ' (match code ' + p.matchCode + ')');
    } else {
      console.log('[auto-allow] allow answered ' + r.status + ' for ' + p.pairId);
    }
  }
  return allowed;
}

/** Entry point. */
async function main() {
  const cfg = resolveConfig(parseArgs(process.argv.slice(2)), process.env);
  if (!cfg.ok) {
    console.error('[auto-allow] ' + cfg.reason);
    console.error(USAGE);
    process.exit(2);
  }
  const state = { token: null };
  const args = parseArgs(process.argv.slice(2));
  if (args.once) {
    const n = await tick(cfg, state);
    console.log('[auto-allow] done, allowed ' + n);
    return;
  }
  console.log('[auto-allow] watching 127.0.0.1:' + cfg.port + ' for devices named "' + cfg.prefix + '..."');
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    try { await tick(cfg, state); } catch (err) { state.token = null; console.log('[auto-allow] ' + err.message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[auto-allow] ' + err.message); process.exit(1); });
}

module.exports = { resolveConfig, parseArgs, tick, DEFAULT_SCOPES, USAGE };
