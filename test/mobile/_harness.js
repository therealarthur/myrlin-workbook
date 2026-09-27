/**
 * _harness.js: the shared sandbox for mobile v2 tests.
 *
 * WHY: BUILD-CONTRACT 3.2 and 3.5.1 item 14. Starts the mobile listener on
 * 127.0.0.1 port 0 with a sandboxed store, creates devices with software
 * P-256 keys, pairs them through the real routes, mints session tokens, opens
 * stream sockets, and loads the main Workbook app for isolation tests. It
 * never opens a network connection except to listeners it starts on
 * 127.0.0.1, and it points every provider home at empty fixture folders so
 * nothing reads the real ~/.claude or ~/.codex.
 *
 * Require it first in every mobile test (it requires ../_test-data-dir).
 *
 * Sandbox guard: on 2026-09-27 a hand run that loaded server.js without a
 * sandbox wrote a store backup into the live data folder, and src/web/auth.js
 * copied the live desktop password into the ignored state/config.json. So the
 * harness refuses, before any Workbook module loads, to run unless this
 * process is isolated: CWM_DATA_DIR is the fresh tmpdir of _test-data-dir
 * (never the live ~/.myrlin, never the in-repo state/), CWM_PASSWORD is set (so
 * auth.js stays on its side effect free environment path), and no module under
 * src/ was loaded before the sandbox. run-all.js adds a static preflight and a
 * sandboxed environment for every child (sandboxProblems is shared with it).
 */
'use strict';

const sandbox = require('../_test-data-dir');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

/** The Workbook repository root (test/mobile/..). */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Whether a path is a folder or lies inside it. Case insensitive on Windows,
 * where C:\Users and c:\users name the same folder.
 *
 * @param {string} child - Candidate path.
 * @param {string} parent - Folder.
 * @returns {boolean}
 */
function isInside(child, parent) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Everything that makes a test process unsafe for the store, as sentences.
 * Pure: every input is passed in, so the guard test can feed it bad cases.
 *
 * @param {object} o
 * @param {object} o.sandbox - The test/_test-data-dir export ({dir, isolated}).
 * @param {object} o.env - Environment.
 * @param {string[]} o.loadedModules - require.cache keys in load order.
 * @param {string} [o.repoRoot] - Repository root.
 * @param {string} [o.homedir] - Home folder (the live data is <home>/.myrlin).
 * @param {string} [o.tmpdir] - System temp folder.
 * @returns {string[]} Problems; empty when the process is sandboxed.
 */
function sandboxProblems(o) {
  const repoRoot = o.repoRoot || REPO_ROOT;
  const liveDir = path.join(o.homedir || os.homedir(), '.myrlin');
  const tmp = o.tmpdir || os.tmpdir();
  const problems = [];
  const sb = o.sandbox || {};
  if (sb.isolated !== true) problems.push('test/_test-data-dir.js did not isolate this process (CWM_TEST_ALLOW_PROD_DIR=1 is refused for mobile tests)');
  const raw = o.env.CWM_DATA_DIR;
  if (!raw) {
    problems.push('CWM_DATA_DIR is not set');
  } else {
    const dataDir = path.resolve(raw);
    if (sb.dir && !isInside(dataDir, sb.dir)) problems.push('CWM_DATA_DIR is neither the sandbox folder of test/_test-data-dir.js nor inside it');
    if (isInside(dataDir, liveDir) || isInside(liveDir, dataDir)) problems.push('CWM_DATA_DIR is or holds the live Workbook data folder');
    if (isInside(dataDir, path.join(repoRoot, 'state'))) problems.push('CWM_DATA_DIR is the in-repo state folder');
    if (!isInside(dataDir, tmp) || path.resolve(dataDir) === path.resolve(tmp)) problems.push('CWM_DATA_DIR is not a folder inside the system temp folder');
  }
  if (!o.env.CWM_PASSWORD) problems.push('CWM_PASSWORD is not set, so src/web/auth.js would read the live config.json and copy it into state/');
  const early = workbookModulesBeforeSandbox(o.loadedModules, repoRoot);
  if (early.length) problems.push('Workbook modules were loaded before the sandbox: ' + early.map((k) => path.relative(repoRoot, k)).join(', '));
  return problems;
}

/**
 * Modules under src/ that were loaded before test/_test-data-dir.js. The
 * require cache keeps insertion order (a module is added when it starts to
 * load), so anything under src/ ahead of the sandbox module ran without it.
 *
 * @param {string[]} keys - require.cache keys in load order.
 * @param {string} [repoRoot] - Repository root.
 * @returns {string[]} The offending absolute paths.
 */
function workbookModulesBeforeSandbox(keys, repoRoot) {
  const root = repoRoot || REPO_ROOT;
  const sandboxFile = path.join(root, 'test', '_test-data-dir.js');
  const srcDir = path.join(root, 'src');
  const idx = keys.findIndex((k) => isInside(k, sandboxFile));
  const before = idx < 0 ? keys : keys.slice(0, idx);
  return before.filter((k) => isInside(k, srcDir));
}

/**
 * Throw, before any Workbook module loads, when this process is not sandboxed.
 * The message names every problem so the fix is obvious.
 */
function assertSandboxed() {
  const problems = sandboxProblems({ sandbox, env: process.env, loadedModules: Object.keys(require.cache) });
  if (problems.length) {
    throw new Error('[mobile tests] refusing to run outside a sandbox: ' + problems.join('; ') +
      '. Require ./_harness (or ../_test-data-dir) before anything under src/.');
  }
}

// The guard runs here, ahead of the first Workbook require below.
assertSandboxed();

// Sandbox every provider home and the credential switcher before any
// Workbook module loads (the orchestrator's rules for any server a test starts).
const FIXTURE_HOME = path.join(sandbox.dir, 'fixture-home');
for (const d of ['.claude/projects', '.codex', 'quota']) fs.mkdirSync(path.join(FIXTURE_HOME, d), { recursive: true });
process.env.CWM_CRED_EXTERNAL_BRIDGE_OWNER = '1';
process.env.CWM_CRED_DISABLE_MAC = '1';
process.env.CWM_CLAUDE_PROJECTS_DIR = path.join(FIXTURE_HOME, '.claude', 'projects');
process.env.CWM_CLAUDE_DIR = path.join(FIXTURE_HOME, '.claude');
process.env.CWM_CLAUDE_JSON = path.join(FIXTURE_HOME, '.claude.json');
process.env.CODEX_HOME = path.join(FIXTURE_HOME, '.codex');
delete process.env.CWM_MOBILE_ENABLED;
delete process.env.CWM_MOBILE_DISABLED;
delete process.env.CWM_MOBILE_HOST;
delete process.env.CWM_MOBILE_PORT;
delete process.env.CWM_MOBILE_PUBLIC_URLS;
delete process.env.CWM_MOBILE_ADVERTISE_LOOPBACK;

const signing = require('../../src/web/mobile/signing');

/** The schemas and vectors vendored from the iOS repo. */
const PROTOCOL_DIR = path.join(__dirname, 'fixtures', 'protocol');

/**
 * A controllable clock.
 *
 * @param {number} [start] - Start time.
 * @returns {{now: Function, advance: Function, set: Function}}
 */
function fakeClock(start) {
  let t = start || Date.now();
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(v) { t = v; return t; },
  };
}

/**
 * Seed the store's settings for a sandbox: credential refresh off, and the
 * mobile settings given.
 *
 * @param {object} store - Workbook store.
 * @param {object} mobileSettings - settings.mobile.
 */
function seedSettings(store, mobileSettings) {
  const cs = Object.assign({}, store.settings.credentialSwitcher || {}, { proactiveRefreshMinutes: 0 });
  store.updateSettings({ credentialSwitcher: cs, mobile: mobileSettings });
}

/**
 * Start a mobile sandbox: the B1 runtime plus the listener on 127.0.0.1:0.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] - Start the listener.
 * @param {object} [opts.settings] - Extra settings.mobile.
 * @param {object} [opts.clock] - fakeClock().
 * @param {object} [opts.hub] - A stub hub to place at ctx.mobile.hub.
 * @param {string} [opts.dataDir] - The mobile data dir (default: the process sandbox);
 *   a fresh folder inside the sandbox lets a test see which files a start writes.
 * @param {boolean} [opts.tracks=false] - Mount B2 and B3 when their folders exist.
 *   Off by default: a B1 test runs B1 alone with stubs of the other tracks
 *   (BUILD-CONTRACT 2.1), so a stub hub given as opts.hub stays in place.
 * @returns {Promise<object>} The harness handle.
 */
async function startSandbox(opts) {
  const o = opts || {};
  const mobile = require('../../src/web/mobile');
  await mobile.stopMobile();
  mobile._resetForTests();
  const { getStore } = require('../../src/state/store');
  const store = getStore();
  seedSettings(store, Object.assign({
    enabled: o.enabled !== false,
    host: '127.0.0.1',
    port: 0,
    detectTailscale: false,
    advertiseLoopback: true,
    legacyPairEnabled: false,
    publicUrls: [],
    qrLinkStyle: 'scheme',
    apns: null,
  }, o.settings || {}));
  const sse = [];
  const logs = [];
  const ctx = {
    store,
    dataDir: o.dataDir || sandbox.dir,
    packageVersion: '9.9.9-test',
    broadcastSSE: (type, data) => sse.push({ type, data }),
    now: o.clock ? o.clock.now : Date.now,
    log: (m) => logs.push(String(m)),
    mountTracks: o.tracks === true,
    mobile: {},
  };
  if (o.hub) ctx.mobile.hub = o.hub;
  await mobile.startMobile(ctx);
  const rt = mobile.getRuntime();
  const st = rt.listener.status();
  const h = {
    mobile, rt, ctx, store, sse, logs,
    port: st.port,
    get base() { return 'http://127.0.0.1:' + rt.listener.status().port; },
    request: (method, p, ro) => request(rt.listener.status().port, method, p, ro),
    async stop() {
      await mobile.stopMobile();
      mobile._resetForTests();
    },
  };
  return h;
}

/**
 * One HTTP request to 127.0.0.1.
 *
 * @param {number} port - Port.
 * @param {string} method - Method.
 * @param {string} p - Path with query.
 * @param {object} [ro] - {token, body, headers, rawBody}.
 * @returns {Promise<{status: number, headers: object, body: *, text: string}>}
 */
function request(port, method, p, ro) {
  const r = ro || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, r.headers || {});
    let payload = null;
    if (r.rawBody !== undefined) payload = r.rawBody;
    else if (r.body !== undefined) {
      payload = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    if (payload) headers['Content-Length'] = payload.length;
    if (r.token) headers.Authorization = 'Bearer ' + r.token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
        resolve({ status: res.statusCode, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A phone with a software P-256 key (the app's DeviceKeyProvider stand in).
 *
 * @param {string} [name] - Device name.
 * @returns {object} {privateKey, publicKey, deviceId, name, sign(purpose, fields)}
 */
function softwareDevice(name) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = signing.b64u(spki);
  return {
    privateKey,
    publicKey,
    deviceId: signing.deviceIdFromSpki(spki),
    name: name || 'Test’s iPhone',
    sign(purpose, fields) { return signing.sign(privateKey, purpose, fields); },
  };
}

/**
 * Build a signed PairRequest body.
 *
 * @param {object} dev - softwareDevice().
 * @param {object} p - {offerId, secretKind, secret, ts?, deviceNonce?}.
 * @returns {object}
 */
function pairRequestBody(dev, p) {
  const body = {
    offerId: p.secretKind === 'code' ? null : p.offerId,
    secretKind: p.secretKind || 'qr',
    secret: p.secret,
    devicePublicKey: p.devicePublicKey || dev.publicKey,
    deviceName: dev.name,
    model: 'iPhone17,2',
    osVersion: '26.1',
    appVersion: '1.0.0 (1)',
    deviceNonce: p.deviceNonce || signing.randomNonce(),
    ts: p.ts || Date.now(),
  };
  body.sig = (p.signer || dev).sign('pair-request', body);
  return body;
}

/**
 * Pair a device through the real routes, with the desktop Allow done through
 * the runtime (the admin route is covered by b1-admin).
 *
 * @param {object} h - Harness.
 * @param {object} dev - softwareDevice().
 * @param {object} [o] - {scopes}.
 * @returns {Promise<object>} {offer, challenge, allowed}
 */
async function pairDevice(h, dev, o) {
  const offer = h.rt.pairing.createOffer();
  const q = signing.parseQrLink(offer.qrLink);
  const r = await h.request('POST', '/api/m/v2/pair', { body: pairRequestBody(dev, { offerId: q.o, secret: q.s }) });
  if (r.status !== 202) throw new Error('pair answered ' + r.status + ' ' + r.text);
  h.rt.pairing.allow(r.body.pairId, { scopes: (o && o.scopes) || ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage'], name: null });
  const s = await h.request('GET', '/api/m/v2/pair/' + r.body.pairId);
  if (s.body.status !== 'allowed') throw new Error('pair status ' + JSON.stringify(s.body));
  return { offer, challenge: r.body, allowed: s.body };
}

/**
 * Run hello and session for a paired device.
 *
 * @param {object} h - Harness.
 * @param {object} dev - softwareDevice().
 * @returns {Promise<object>} The SessionResponse (sessionToken inside).
 */
async function openSession(h, dev) {
  const clientNonce = signing.randomNonce();
  const hello = await h.request('POST', '/api/m/v2/hello', { body: { deviceId: dev.deviceId, clientNonce } });
  if (hello.status !== 200) throw new Error('hello answered ' + hello.status + ' ' + hello.text);
  const req = { computerId: hello.body.computerId, deviceId: dev.deviceId, serverNonce: hello.body.serverNonce, clientNonce, ts: Date.now() };
  req.sig = dev.sign('session-request', req);
  const s = await h.request('POST', '/api/m/v2/session', { body: req });
  if (s.status !== 200) throw new Error('session answered ' + s.status + ' ' + s.text);
  return s.body;
}

/**
 * A stub of B2's hub: accepts upgrades with ws, tracks sockets per device.
 *
 * @returns {object} {handleUpgrade, closeDevice, closeAll, isDeviceConnected, publish, epoch, calls, sockets}
 */
function stubHub() {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map();
  const calls = [];
  return {
    epoch: 'e_' + signing.b64u(crypto.randomBytes(12)),
    calls,
    sockets,
    handleUpgrade(req, socket, head, auth) {
      calls.push({ fn: 'handleUpgrade', deviceId: auth && auth.deviceId });
      wss.handleUpgrade(req, socket, head, (ws) => {
        const list = sockets.get(auth.deviceId) || [];
        list.push(ws);
        sockets.set(auth.deviceId, list);
        ws.on('close', () => {
          const l = sockets.get(auth.deviceId) || [];
          sockets.set(auth.deviceId, l.filter((x) => x !== ws));
        });
      });
    },
    closeDevice(deviceId, code, reason) {
      calls.push({ fn: 'closeDevice', deviceId, code, reason });
      for (const ws of sockets.get(deviceId) || []) ws.close(code, reason);
    },
    closeAll(code, reason) {
      calls.push({ fn: 'closeAll', code, reason });
      for (const list of sockets.values()) for (const ws of list) ws.close(code, reason);
    },
    isDeviceConnected(deviceId) {
      return (sockets.get(deviceId) || []).some((ws) => ws.readyState === 1);
    },
    publish(topic, type) {
      calls.push({ fn: 'publish', topic, type });
      return 1;
    },
  };
}

/**
 * Open a stream socket as the phone would.
 *
 * @param {object} h - Harness.
 * @param {string} token - Session token.
 * @param {object} [headers] - Extra headers.
 * @returns {Promise<{ws: object, closed: Promise<{code: number, reason: string}>}>}
 */
function openStream(h, token, headers) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + h.rt.listener.status().port + '/ws/m/v2', 'myrlin.v2', {
      headers: Object.assign(token ? { Authorization: 'Bearer ' + token } : {}, headers || {}),
    });
    const closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: String(reason) })));
    ws.on('open', () => resolve({ ws, closed }));
    ws.on('unexpected-response', (req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const err = new Error('upgrade refused ' + res.statusCode);
        err.status = res.statusCode;
        try { err.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { err.body = null; }
        reject(err);
      });
    });
    ws.on('error', (e) => { if (!e.status) reject(e); });
  });
}

/**
 * Load the main Workbook app (server.js) inside this sandboxed process and
 * listen on 127.0.0.1:0. startServer is NOT called: no scheduler, watchers or
 * credential refresh run.
 *
 * @param {object} [o] - {pty: boolean} attach the PTY WebSocket server too.
 * @returns {Promise<object>} {server, app, port, close, login()}
 */
async function startMainApp(o) {
  const serverMod = require('../../src/web/server');
  const httpServer = http.createServer(serverMod.app);
  let ptyManager = null;
  if (o && o.pty) {
    const { attachPtyWebSocket } = require('../../src/web/pty-server');
    ({ ptyManager } = attachPtyWebSocket(httpServer));
  }
  await new Promise((res, rej) => httpServer.listen(0, '127.0.0.1', (e) => (e ? rej(e) : res())));
  const port = httpServer.address().port;
  return {
    serverMod,
    app: serverMod.app,
    httpServer,
    port,
    request: (method, p, ro) => request(port, method, p, ro),
    async login() {
      const r = await request(port, 'POST', '/api/auth/login', { body: { password: process.env.CWM_PASSWORD } });
      if (!r.body || !r.body.token) throw new Error('login failed ' + r.status + ' ' + r.text);
      return r.body.token;
    },
    close() {
      try { if (ptyManager) ptyManager.destroyAll(); } catch (_) { /* ignore */ }
      return new Promise((res) => httpServer.close(() => res()));
    },
  };
}

/**
 * A minimal sequential test runner in the style of the existing suite.
 *
 * @param {string} title - Suite title.
 * @param {Array<[string, Function]>} tests - [name, async fn].
 */
async function run(title, tests) {
  console.log('  ' + title);
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('    ok   ' + name);
    } catch (err) {
      failed += 1;
      console.log('    FAIL ' + name + ': ' + ((err && err.stack) || err));
    }
  }
  console.log('  ' + (tests.length - failed) + '/' + tests.length + ' passed');
  try { await require('../../src/web/mobile').stopMobile(); } catch (_) { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}

module.exports = {
  sandbox,
  REPO_ROOT,
  isInside,
  sandboxProblems,
  workbookModulesBeforeSandbox,
  PROTOCOL_DIR,
  FIXTURE_HOME,
  fakeClock,
  seedSettings,
  startSandbox,
  request,
  softwareDevice,
  pairRequestBody,
  pairDevice,
  openSession,
  stubHub,
  openStream,
  startMainApp,
  run,
};
