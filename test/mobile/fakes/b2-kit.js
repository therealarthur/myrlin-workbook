/**
 * Shared kit for the b2-*.test.js suites.
 *
 * What: a minimal test runner (one printed line per test, non zero exit on
 * failure), schema validation through B1's test/mobile/_schema-check.js over
 * the vendored fixtures/protocol/schemas (BUILD-CONTRACT 3.1: B2 switches
 * from its private copy under fixtures/b2-protocol at the B1 merge; the
 * kit's own subset validator, check(), stays exported), a bootstrap that
 * starts B1's real mobile runtime and listener with the chat track mounted
 * through startMobile, devices paired and minted by B1's real pairing,
 * devices and token modules, HTTP and WebSocket clients for loopback
 * listeners, transcript fixture writers for both providers, and helpers to
 * run the fake CLIs in real PTYs with the VT sidecar on.
 *
 * Sandbox: the kit requires ../_harness before any Workbook module, so every
 * B2 suite passes B1's sandbox guard (a fresh CWM_DATA_DIR under the system
 * temp folder, CWM_PASSWORD set, nothing under src/ loaded first); run the
 * suites through test/mobile/run-all.js, which provides that environment.
 *
 * Why: eighteen suites share the same setup; one kit keeps them short and
 * identical in how they sandbox (CWM_DATA_DIR, CWM_CLAUDE_PROJECTS_DIR,
 * CODEX_HOME and FAKE_CLI_STATE under a fresh temp folder).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// B1's harness first: its sandbox guard runs before any Workbook module loads.
const harness = require('../_harness');
const { createChecker } = require('../_schema-check');

/** The schemas B1 vendored from the iOS repo (fixtures/protocol/SOURCE.txt). */
const SCHEMA_ROOT = path.join(__dirname, '..', 'fixtures', 'protocol', 'schemas');
/** The private copy B2 used before the B1 merge (kept; no suite reads it now). */
const PRIVATE_SCHEMA_ROOT = path.join(__dirname, '..', 'fixtures', 'b2-protocol', 'schemas');
const FAKES_BIN = path.join(__dirname, 'bin');

let schemaChecker = null;
/** @returns {object} B1's checker over SCHEMA_ROOT, built once. */
function checker() {
  if (!schemaChecker) schemaChecker = createChecker(SCHEMA_ROOT);
  return schemaChecker;
}

// ── Runner ─────────────────────────────────────────────────────────────────

const results = [];
const queue = [];

/**
 * Register a test.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
function test(name, fn) { queue.push({ name, fn }); }

/**
 * Run every registered test in order, print, clean up, exit.
 * @param {() => Promise<void>} [cleanup]
 */
async function run(cleanup) {
  const guard = setTimeout(() => { console.log('FAIL suite timeout'); process.exit(1); }, Number(process.env.B2_SUITE_TIMEOUT_MS || 300000));
  guard.unref();
  for (const t of queue) {
    const start = Date.now();
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
      console.log('  ok   ' + t.name + ' (' + (Date.now() - start) + ' ms)');
    } catch (err) {
      results.push({ name: t.name, ok: false });
      console.log('  FAIL ' + t.name + ': ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
    }
  }
  if (cleanup) { try { await cleanup(); } catch (err) { console.log('  cleanup error: ' + (err && err.message)); } }
  // node-pty on Windows closes a pseudo console asynchronously; exiting in the same tick as
  // the kill can hang the process in the ConPTY close, so give it a moment first.
  await sleep(Number(process.env.B2_EXIT_GRACE_MS || 1500));
  const failed = results.filter((r) => !r.ok).length;
  console.log((failed ? 'FAILED ' : 'passed ') + (results.length - failed) + '/' + results.length);
  process.exit(failed ? 1 : 0);
}

/**
 * Assert helper.
 * @param {*} cond
 * @param {string} msg
 */
function ok(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }

/**
 * Deep equality assertion (JSON based).
 */
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error('expected ' + y + ' got ' + x + (msg ? ' (' + msg + ')' : ''));
}

/**
 * Wait until a predicate holds.
 * @param {() => (boolean|Promise<boolean>)} pred
 * @param {number} timeoutMs
 * @param {string} label
 */
async function until(pred, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JSON Schema subset validator ─────────────────────────────────────────

const schemaCache = new Map();

function loadSchema(file) {
  const full = path.resolve(file);
  if (!schemaCache.has(full)) schemaCache.set(full, JSON.parse(fs.readFileSync(full, 'utf8')));
  return schemaCache.get(full);
}

/**
 * Resolve a $ref relative to the schema file it appears in.
 * @param {string} ref
 * @param {string} baseFile
 * @returns {{schema: object, file: string}}
 */
function resolveRef(ref, baseFile) {
  const [filePart, pointer] = ref.split('#');
  const file = filePart ? path.resolve(path.dirname(baseFile), filePart) : baseFile;
  let node = loadSchema(file);
  if (pointer) for (const seg of pointer.split('/').filter(Boolean)) node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  return { schema: node, file };
}

/**
 * Validate a value; returns a list of error strings.
 * @param {*} v
 * @param {object} s
 * @param {string} file
 * @param {string} at
 * @returns {string[]}
 */
function check(v, s, file, at) {
  if (s === true || s === undefined) return [];
  if (s === false) return [at + ': not allowed'];
  const errs = [];
  if (s.$ref) { const r = resolveRef(s.$ref, file); errs.push(...check(v, r.schema, r.file, at)); }
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(v);
    if (!types.some((x) => x === t || (x === 'number' && (t === 'integer' || t === 'number')))) return errs.concat([at + ': type ' + t + ' not ' + types.join('|')]);
  }
  if (s.const !== undefined && JSON.stringify(v) !== JSON.stringify(s.const)) errs.push(at + ': const ' + JSON.stringify(s.const));
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(at + ': not in enum ' + JSON.stringify(v));
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(at + ': pattern ' + s.pattern + ' vs ' + JSON.stringify(v).slice(0, 60));
    if (s.minLength !== undefined && v.length < s.minLength) errs.push(at + ': minLength');
    if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(at + ': maxLength');
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errs.push(at + ': minimum');
    if (s.maximum !== undefined && v > s.maximum) errs.push(at + ': maximum');
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(at + ': minItems');
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(at + ': maxItems');
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(at + ': uniqueItems');
    const pre = s.prefixItems || [];
    v.forEach((x, i) => { const sub = i < pre.length ? pre[i] : s.items; if (sub !== undefined) errs.push(...check(x, sub, file, at + '[' + i + ']')); });
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (s.required) for (const k of s.required) if (!(k in v)) errs.push(at + ': missing ' + k);
    if (s.minProperties !== undefined && Object.keys(v).length < s.minProperties) errs.push(at + ': minProperties');
    const props = s.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k] !== undefined) errs.push(...check(x, props[k], file, at + '.' + k));
      else if (s.additionalProperties === false) errs.push(at + ': extra ' + k);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') errs.push(...check(x, s.additionalProperties, file, at + '.' + k));
    }
  }
  if (s.allOf) for (const sub of s.allOf) errs.push(...check(v, sub, file, at));
  if (s.anyOf && !s.anyOf.some((sub) => check(v, sub, file, at).length === 0)) errs.push(at + ': anyOf failed');
  if (s.oneOf && s.oneOf.filter((sub) => check(v, sub, file, at).length === 0).length !== 1) errs.push(at + ': oneOf failed (' + s.oneOf.map((sub) => check(v, sub, file, at)[0] || 'ok').join(' / ').slice(0, 300) + ')');
  if (s.if && check(v, s.if, file, at).length === 0 && s.then) errs.push(...check(v, s.then, file, at));
  return errs;
}

/**
 * Assert a value validates against a schema file (relative to schemas/).
 * @param {*} value
 * @param {string} rel - for example "sessions/message-page.json"
 */
function validate(value, rel) {
  const errs = checker().validate(rel, value);
  if (errs.length) throw new Error('schema ' + rel + ': ' + errs.slice(0, 6).join('; '));
}

/**
 * Validate a stream frame against the envelope and its event or control schema.
 * @param {object} frame
 */
function validateFrame(frame) {
  validate(frame, 'stream/envelope.json');
  if (frame.topic === '$control') validate(frame, 'stream/control.json');
  else {
    const f = path.join(SCHEMA_ROOT, 'stream', 'events', frame.type + '.json');
    if (fs.existsSync(f)) validate(frame, 'stream/events/' + frame.type + '.json');
  }
}

// ── Sandbox and bootstrap ──────────────────────────────────────────────────

/**
 * Fresh sandbox folders and the environment that points every provider at them.
 * @returns {{root: string, projects: string, codexHome: string, state: string, home: string}}
 */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-sandbox-'));
  const s = { root, projects: path.join(root, 'claude', 'projects'), codexHome: path.join(root, 'codex'), state: path.join(root, 'state'), home: path.join(root, 'home'), work: path.join(root, 'work') };
  for (const d of [s.projects, s.codexHome, s.state, s.home, s.work]) fs.mkdirSync(d, { recursive: true });
  process.env.CWM_CLAUDE_PROJECTS_DIR = s.projects;
  process.env.CODEX_HOME = s.codexHome;
  process.env.FAKE_CLI_STATE = s.state;
  process.env.FAKE_CLAUDE_THINK_MS = process.env.FAKE_CLAUDE_THINK_MS || '400';
  process.env.FAKE_CODEX_THINK_MS = process.env.FAKE_CODEX_THINK_MS || '400';
  process.env.CWM_CODEX_STATE_DB = process.env.CWM_CODEX_STATE_DB || '1';
  for (const k of Object.keys(process.env)) if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$|^ANTHROPIC_/.test(k)) delete process.env[k];
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  process.env[pathKey] = FAKES_BIN + sep + process.env[pathKey];
  return s;
}

/** The scopes a test device gets unless a test names others (PROTOCOL.md 2.6). */
const DEFAULT_SCOPES = ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage'];

/**
 * Start B1's real mobile runtime with the chat track mounted, on a loopback
 * listener at port 0, with the sandboxed store.
 *
 * The chat track mounts through B1's startMobile (index.js mountOtherTracks)
 * with the test's options passed as ctx.trackOptions.chat, so the suites run
 * the production mount path, B1's router (scope table, authentication,
 * limiters, body parsing, error bodies), B1's upgrade authentication, and
 * B1's devices and tokens. The first device pairs through the real pair,
 * hello and session routes; addDevice creates further records with B1's
 * devices.create and mints with its token module, as the Allow step does.
 *
 * @param {object} [o] - {pty: boolean, options: mountChat options}
 * @returns {Promise<object>}
 */
async function bootChat(o = {}) {
  await initProviders();
  const mobileMod = require('../../../src/web/mobile');
  const { TOKEN_LIFE_MS } = require('../../../src/web/mobile/session-tokens');
  const { getStore } = require('../../../src/state/store');
  const registry = require('../../../src/providers');
  const store = getStore();
  await mobileMod.stopMobile();
  mobileMod._resetForTests();
  harness.seedSettings(store, {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    detectTailscale: false,
    advertiseLoopback: true,
    legacyPairEnabled: false,
    publicUrls: [],
    qrLinkStyle: 'scheme',
    apns: null,
  });
  // updateSettings schedules a debounced async save. The store's sync save()
  // (createSession and friends) writes the same <file>.<pid>.tmp, so a sync
  // save during that async one fails its rename (EPERM on Windows) and the
  // store emits an unhandled 'error'. Write the seeded settings now instead.
  if (store._saveTimer) { clearTimeout(store._saveTimer); store._saveTimer = null; }
  store.save();
  let pm = null;
  if (o.pty) {
    const { PtySessionManager } = require('../../../src/web/pty-manager');
    pm = new PtySessionManager();
  }
  // B1's clock. mintToken moves it back for one call so a token can be minted
  // with a shorter life than B1's fixed 15 minutes (the 4001 test).
  let skewMs = 0;
  const logs = [];
  const sse = [];
  const ctx = {
    app: null,
    store,
    getPtyManager: () => pm,
    registry,
    getProviderForSession: () => null,
    dataDir: process.env.CWM_DATA_DIR,
    packageVersion: 'test',
    broadcastSSE: (type, data) => sse.push({ type, data }),
    now: () => Date.now() + skewMs,
    log: (m) => logs.push(String(m)),
    trackOptions: { chat: o.options || {} },
    mobile: {},
  };
  const rt = mobileMod.ensureCore(ctx);
  // Record what B2 hands B1's push and audit, then call the real ones.
  const pushEvents = [];
  const auditEntries = [];
  const realNotify = ctx.mobile.push.notify;
  ctx.mobile.push.notify = (e) => { pushEvents.push(e); return realNotify(e); };
  const realAudit = ctx.mobile.audit.write;
  ctx.mobile.audit.write = (e) => { auditEntries.push(Object.assign({ ts: Date.now() }, e)); return realAudit(e); };
  const status = await mobileMod.startMobile(ctx);
  if (!rt.mounted.chat || !ctx.mobile.chat) throw new Error('the chat track did not mount: ' + logs.join(' | '));
  if (!status || !status.running) throw new Error('the mobile listener did not start: ' + JSON.stringify(status));
  const chat = ctx.mobile.chat;
  const port = rt.listener.status().port;
  const base = 'http://127.0.0.1:' + port;
  const h = { rt, request: (method, p, ro) => harness.request(port, method, p, ro) };

  const b1 = {
    rt,
    mobile: ctx.mobile,
    pushEvents,
    auditEntries,
    logs,
    sse,
    /**
     * Mint a session token with B1's token module.
     * @param {string} deviceId
     * @param {number} [lifeMs] - shorter than 15 minutes for expiry tests
     * @returns {string}
     */
    mintToken(deviceId, lifeMs) {
      skewMs = Number.isFinite(lifeMs) ? lifeMs - TOKEN_LIFE_MS : 0;
      try { return rt.auth.mint(deviceId).token; } finally { skewMs = 0; }
    },
    /**
     * A device record created as the Allow step creates it, with a live token.
     * @param {string[]|null} [scopes]
     * @param {number} [lifeMs]
     * @returns {{deviceId: string, token: string}}
     */
    addDevice(scopes, lifeMs) {
      const dev = harness.softwareDevice('B2 test iPhone');
      const rec = rt.devices.create({
        publicKey: dev.publicKey, name: dev.name, model: 'iPhone17,2', osVersion: '26.1', appVersion: '1.0.0 (1)',
        scopes: (scopes || DEFAULT_SCOPES).slice(), pairedAtMs: Date.now(),
      });
      return { deviceId: rec.deviceId, token: this.mintToken(rec.deviceId, lifeMs) };
    },
    /** Change a device's scopes through B1 (fires devices.onScopesChanged). */
    setScopes(deviceId, scopes) { return rt.devices.setScopes(deviceId, scopes); },
    /** Revoke a device through B1 with every effect of PROTOCOL.md 2.11. */
    revoke(deviceId) { return rt.revokeDevice(deviceId, 'desktop'); },
  };

  // The first device pairs through the real routes: offer, pair, Allow, hello, session.
  const phone = harness.softwareDevice('B2 test iPhone');
  await harness.pairDevice(h, phone, { scopes: DEFAULT_SCOPES });
  const session = await harness.openSession(h, phone);
  const device = { deviceId: phone.deviceId, token: session.sessionToken };
  const listener = { port, base, close: async () => { await mobileMod.stopMobile(); } };

  return {
    ctx, chat, b1, pm, store, listener, device, base,
    async close() {
      try { chat.stop(); } catch (_) {}
      if (pm) { try { pm.destroyAll(); } catch (_) {} }
      await mobileMod.stopMobile();
      mobileMod._resetForTests();
    },
  };
}

/**
 * Register the real Claude and Codex providers (server.js does this at boot).
 * @returns {Promise<void>}
 */
async function initProviders() {
  const registry = require('../../../src/providers');
  const { getStore } = require('../../../src/state/store');
  await registry.initRegistry(getStore(), {});
}

// ── Clients ───────────────────────────────────────────────────────────────

/** Most 429 answers api() waits out before it returns one. */
const RATE_LIMIT_RETRIES = 40;
/** Longest single wait api() accepts from a retryAfterMs. */
const RATE_LIMIT_WAIT_MAX_MS = 5000;

/**
 * JSON HTTP request to the listener, as the phone's client makes it: a 429
 * RATE_LIMITED answer is waited out for its retryAfterMs and the request is
 * sent again (PROTOCOL.md 2.12). B1's real limiters run under the B2 suites
 * since the wave B merge (the device bucket holds 100 requests, then 20 a
 * second), and a suite that pages a 200 MB transcript back to its first
 * message sends a few hundred requests in a row.
 * @param {string} base
 * @param {string} method
 * @param {string} p - path under /api/m/v2
 * @param {object|Buffer|null} body
 * @param {string|null} token
 * @param {object} [headers]
 * @returns {Promise<{status: number, body: *, headers: object, raw: Buffer}>}
 */
async function api(base, method, p, body, token, headers) {
  let r = await apiOnce(base, method, p, body, token, headers);
  for (let i = 0; i < RATE_LIMIT_RETRIES && r.status === 429 && r.body && r.body.code === 'RATE_LIMITED'; i++) {
    await sleep(Math.min(RATE_LIMIT_WAIT_MAX_MS, Math.max(10, Number(r.body.retryAfterMs) || 100)));
    r = await apiOnce(base, method, p, body, token, headers);
  }
  return r;
}

/**
 * One JSON HTTP request to the listener (no retry).
 * @param {string} base
 * @param {string} method
 * @param {string} p - path under /api/m/v2
 * @param {object|Buffer|null} body
 * @param {string|null} token
 * @param {object} [headers]
 * @returns {Promise<{status: number, body: *, headers: object, raw: Buffer}>}
 */
function apiOnce(base, method, p, body, token, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/m/v2' + p, base);
    const h = Object.assign({}, headers || {});
    let payload = null;
    if (Buffer.isBuffer(body)) { payload = body; h['Content-Type'] = h['Content-Type'] || 'application/octet-stream'; }
    else if (body !== null && body !== undefined) { payload = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; }
    if (payload) h['Content-Length'] = payload.length;
    if (token) h.Authorization = 'Bearer ' + token;
    const req = http.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = raw.length && /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw.toString('utf8')) : null; } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Open a stream socket and collect frames.
 * @param {string} base
 * @param {string} token
 * @param {object} [o] - {protocol, origin}
 * @returns {Promise<{ws: object, frames: object[], send: Function, next: Function, close: Function, closed: Promise}>}
 */
function openStream(base, token, o = {}) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (o.origin) headers.Origin = o.origin;
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/m/v2', o.protocol === null ? undefined : (o.protocol || 'myrlin.v2'), { headers });
    const frames = [];
    let closeInfo = null;
    const closed = new Promise((r) => ws.on('close', (code, reason) => { closeInfo = { code, reason: String(reason) }; r(closeInfo); }));
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch (_) {} });
    ws.on('unexpected-response', (req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => reject(Object.assign(new Error('upgrade refused ' + res.statusCode), { status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { return null; } })() })));
    });
    ws.on('error', (e) => { if (!frames.length) reject(e); });
    ws.on('open', () => resolve({
      ws, frames, closed,
      closeInfo: () => closeInfo,
      send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
      /** Wait for a frame matching a predicate (searching from index). */
      async next(pred, timeoutMs, from) {
        const start = Date.now();
        let i = from || 0;
        for (;;) {
          for (; i < frames.length; i++) if (pred(frames[i])) return frames[i];
          if (Date.now() - start > (timeoutMs || 5000)) throw new Error('no matching frame');
          await sleep(20);
        }
      },
      close: () => { try { ws.close(); } catch (_) {} },
    }));
  });
}

// ── Transcript fixtures ────────────────────────────────────────────────────

/**
 * Write a Claude transcript with n simple exchanges.
 * @param {string} projects
 * @param {string} cwd
 * @param {string} sessionId
 * @param {Array<object>} records - raw records, or use claudeExchange()
 * @returns {string} file path
 */
function writeClaude(projects, cwd, sessionId, records) {
  const dir = path.join(projects, String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(Object.assign({ sessionId, cwd }, r))).join('\n') + '\n');
  return file;
}

let tsBase = Date.parse('2026-09-20T10:00:00Z');
const iso = () => { tsBase += 1000; return new Date(tsBase).toISOString(); };

/**
 * Records of one Claude exchange: prompt, thinking + text (same message id), turn end.
 * @param {string} text
 * @param {object} [o] - {tool: true}
 * @returns {object[]}
 */
function claudeExchange(text, o = {}) {
  const u = crypto.randomUUID();
  const mid = 'msg_' + crypto.randomBytes(8).toString('hex');
  const out = [{ type: 'user', uuid: u, timestamp: iso(), message: { role: 'user', content: text } }];
  out.push({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: iso(), requestId: 'req_1', message: { id: mid, role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } });
  if (o.tool) {
    const tid = 'toolu_' + crypto.randomBytes(6).toString('hex');
    out.push({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: iso(), requestId: 'req_1', message: { id: mid, role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: 'npm test' } }] } });
    out.push({ type: 'user', uuid: crypto.randomUUID(), timestamp: iso(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'ok', is_error: false }] } });
  }
  out.push({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: iso(), requestId: 'req_2', message: { id: mid + 'b', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Reply to ' + text }], usage: { input_tokens: 5, output_tokens: 3 } } });
  out.push({ type: 'system', subtype: 'stop_hook_summary', uuid: crypto.randomUUID(), timestamp: iso() });
  out.push({ type: 'system', subtype: 'turn_duration', durationMs: 1234, uuid: crypto.randomUUID(), timestamp: iso() });
  out.push({ type: 'attachment', uuid: crypto.randomUUID(), timestamp: iso(), attachment: { type: 'noise' } });
  return out;
}

/**
 * Write a Codex rollout.
 * @param {string} codexHome
 * @param {string} threadId
 * @param {object[]} records - {type, payload}
 * @param {object} [meta] - session_meta payload extras
 * @returns {string}
 */
function writeCodex(codexHome, threadId, records, meta) {
  const dir = path.join(codexHome, 'sessions', '2026', '09', '20');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-09-20T10-00-00-' + threadId + '.jsonl');
  const all = [{ type: 'session_meta', payload: Object.assign({ id: threadId, cwd: 'C:\\work', originator: 'codex_cli_rs', cli_version: '0.153.4' }, meta || {}) }].concat(records);
  fs.writeFileSync(file, all.map((r) => JSON.stringify(Object.assign({ timestamp: iso() }, r))).join('\n') + '\n');
  return file;
}

/**
 * Records of one Codex exchange.
 * @param {string} text
 * @returns {object[]}
 */
function codexExchange(text) {
  const turn = crypto.randomUUID();
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }), call_id: 'c_' + turn.slice(0, 6) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c_' + turn.slice(0, 6), output: JSON.stringify({ output: 'a b', metadata: { exit_code: 0 } }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply to ' + text }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, duration_ms: 2000 } },
  ];
}

/**
 * A tracked store session (creates a workspace when needed).
 * @param {object} store
 * @param {object} o - {provider, workingDir, resumeSessionId, name, command}
 * @returns {object} store session
 */
function trackedSession(store, o) {
  let ws = store.getAllWorkspacesList()[0];
  if (!ws) ws = store.createWorkspace({ name: 'Test' });
  const s = store.createSession({ name: o.name || 'Test session', workspaceId: ws.id, workingDir: o.workingDir || '', command: o.command || o.provider || 'claude', resumeSessionId: o.resumeSessionId || null });
  store.updateSession(s.id, { provider: o.provider || 'claude' });
  return store.getSession(s.id);
}

module.exports = {
  test, run, ok, eq, until, sleep, initProviders, validate, validateFrame, check, sandbox, bootChat, api, apiOnce, openStream,
  writeClaude, claudeExchange, writeCodex, codexExchange, trackedSession, SCHEMA_ROOT, FAKES_BIN,
  PRIVATE_SCHEMA_ROOT, DEFAULT_SCOPES,
};
