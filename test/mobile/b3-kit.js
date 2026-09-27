/**
 * b3-kit.js: shared setup for the b3-*.test.js suites (not a test itself;
 * run-all.js runs only *.test.js files).
 *
 * What: boots B1's real mobile runtime and listener with B2's chat track and
 * B3's workspace track mounted through startMobile (the production mount
 * path), pairs a device through the real routes, and hands back the pieces
 * the suites need: the HTTP client, the store, the workspace members and a
 * collector of main server SSE broadcasts and B1 push events. It reuses
 * B2's kit for the runner, schema checks, transcript writers and clients.
 *
 * Why: fourteen B3 suites share one setup; keeping it here keeps them short
 * and identical in how they sandbox (B1's harness guard runs first through
 * b2-kit, every provider home points at a fresh temp folder, no port but 0
 * is ever bound).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const kit = require('./fakes/b2-kit');
const harness = require('./_harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Boot the mobile runtime with the chat and workspace tracks.
 *
 * @param {object} [o] - {pty, chat (mountChat options), workspace (mountWorkspace options), credentialManager, codexAccountManager, search}
 * @returns {Promise<object>}
 */
async function bootWorkspace(o = {}) {
  await kit.initProviders();
  const mobileMod = require('../../src/web/mobile');
  const { getStore } = require('../../src/state/store');
  const registry = require('../../src/providers');
  const store = getStore();
  await mobileMod.stopMobile();
  mobileMod._resetForTests();
  harness.seedSettings(store, {
    enabled: true, host: '127.0.0.1', port: 0, detectTailscale: false, advertiseLoopback: true,
    legacyPairEnabled: false, publicUrls: [], qrLinkStyle: 'scheme', apns: null,
  });
  if (store._saveTimer) { clearTimeout(store._saveTimer); store._saveTimer = null; }
  store.save();
  let pm = null;
  if (o.pty) {
    const { PtySessionManager } = require('../../src/web/pty-manager');
    pm = new PtySessionManager();
  }
  const sse = [];
  const logs = [];
  const ctx = {
    app: null,
    store,
    getPtyManager: () => pm,
    registry,
    getProviderForSession: () => null,
    search: o.search || {},
    credentialManager: o.credentialManager || null,
    codexAccountManager: o.codexAccountManager || null,
    dataDir: process.env.CWM_DATA_DIR,
    packageVersion: 'test',
    broadcastSSE: (type, data) => sse.push({ type, data }),
    log: (m) => logs.push(String(m)),
    trackOptions: { chat: Object.assign({ screenModel: false }, o.chat || {}), workspace: o.workspace || {} },
    mobile: {},
  };
  const rt = mobileMod.ensureCore(ctx);
  const pushEvents = [];
  const realNotify = ctx.mobile.push.notify;
  ctx.mobile.push.notify = (e) => { pushEvents.push(e); return realNotify(e); };
  const auditEntries = [];
  const realAudit = ctx.mobile.audit.write;
  ctx.mobile.audit.write = (e) => { auditEntries.push(e); return realAudit(e); };
  const status = await mobileMod.startMobile(ctx);
  if (!rt.mounted.workspace || !ctx.mobile.workspace) throw new Error('the workspace track did not mount: ' + logs.join(' | '));
  if (!status || !status.running) throw new Error('the mobile listener did not start');
  const port = rt.listener.status().port;
  const base = 'http://127.0.0.1:' + port;
  const h = { rt, request: (method, p, ro) => harness.request(port, method, p, ro) };
  const phone = harness.softwareDevice('B3 test iPhone');
  await harness.pairDevice(h, phone, { scopes: kit.DEFAULT_SCOPES });
  const session = await harness.openSession(h, phone);
  const device = { deviceId: phone.deviceId, token: session.sessionToken };
  return {
    ctx, rt, store, pm, sse, logs, pushEvents, auditEntries, base, device,
    chat: ctx.mobile.chat,
    ws: ctx.mobile.workspace,
    api: (method, p, body, headers) => kit.api(base, method, p, body, device.token, headers),
    /** Mint another device with some scopes (B1's devices and tokens). */
    addDevice(scopes) {
      const dev = harness.softwareDevice('B3 other iPhone');
      const rec = rt.devices.create({ publicKey: dev.publicKey, name: dev.name, model: 'iPhone17,2', osVersion: '26.1', appVersion: '1.0.0 (1)', scopes: scopes.slice(), pairedAtMs: Date.now() });
      return { deviceId: rec.deviceId, token: rt.auth.mint(rec.deviceId).token };
    },
    async close() {
      try { if (ctx.mobile.workspace && ctx.mobile.workspace.stop) ctx.mobile.workspace.stop(); } catch (_) { /* ignore */ }
      try { if (ctx.mobile.chat) ctx.mobile.chat.stop(); } catch (_) { /* ignore */ }
      if (pm) { try { pm.destroyAll(); } catch (_) { /* ignore */ } }
      await mobileMod.stopMobile();
      mobileMod._resetForTests();
    },
  };
}

/**
 * Make a folder inside the sandbox (never outside the temp folder).
 *
 * @param {string} name - Folder name.
 * @returns {string}
 */
function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-' + name + '-'));
  return dir;
}

/**
 * A tracked store session in a given workspace.
 *
 * @param {object} store - Store.
 * @param {object} o - {workspaceId, provider, workingDir, resumeSessionId, name}
 * @returns {object}
 */
function tracked(store, o) {
  const s = store.createSession({ name: o.name || 'Session', workspaceId: o.workspaceId, workingDir: o.workingDir || '', command: o.command || o.provider || 'claude', resumeSessionId: o.resumeSessionId || null }); // gsd:provider-literal-allowed (test fixture)
  store.updateSession(s.id, { provider: o.provider || 'claude' }); // gsd:provider-literal-allowed (test fixture)
  return store.getSession(s.id);
}

/**
 * Wait for a stream frame on an open socket.
 *
 * @param {object} s - kit.openStream() handle.
 * @param {Function} pred - Predicate.
 * @param {number} [ms] - Timeout.
 * @param {number} [from] - Start index.
 * @returns {Promise<object>}
 */
function frame(s, pred, ms, from) {
  return s.next(pred, ms || 5000, from || 0);
}

/** An hour, for token expiry defaults in the fake managers. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Fake Claude and Codex account managers with exactly the members the
 * accounts service calls on the real ones (credential-manager.js and
 * provider-account-manager.js: getSafeList, isCredentialPoolReadOnly,
 * applyCredential and applyAccount, the live identity readers, setLabel,
 * updateSnapshotUsage, claudeDir and claudeJsonPath). Their state is plain
 * data the suites edit; every call is recorded in `calls`.
 *
 * @param {string} root - A sandbox folder for the fake Claude files.
 * @returns {{credentialManager: object, codexAccountManager: object, claude: object, codex: object, calls: Array}}
 */
function fakeAccountManagers(root) {
  const claudeDir = path.join(root, 'claude-home');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{}');
  const claudeJsonPath = path.join(root, 'claude.json');
  fs.writeFileSync(claudeJsonPath, JSON.stringify({ oauthAccount: {} }));
  const calls = [];
  const claude = { profiles: [], active: null, readOnly: false, expiresAt: Date.now() + HOUR_MS, applyError: null, applyDelayMs: 0, liveAfterApply: null };
  const codex = { accounts: [], active: null, running: [], applyError: null, liveAfterApply: null };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const credentialManager = {
    claudeDir,
    claudeJsonPath,
    getSafeList: () => ({ activeProfileId: claude.active, profiles: claude.profiles.map((p) => Object.assign({}, p, { isActive: p.profileId === claude.active })), mac: null }),
    isCredentialPoolReadOnly: () => claude.readOnly,
    readActiveCredential: () => ({ credText: 'redacted', oauth: { expiresAt: claude.expiresAt } }),
    getActiveAccountUuid: () => claude.active,
    getActiveEmail: () => { const p = claude.profiles.find((x) => x.profileId === claude.active); return p ? p.email : null; },
    async applyCredential(id) {
      calls.push(['claude.apply', id]);
      if (claude.applyDelayMs) await pause(claude.applyDelayMs);
      if (claude.applyError) throw claude.applyError;
      if (id === claude.active) return { applied: false, alreadyActive: true, email: '' };
      claude.active = claude.liveAfterApply || id;
      const p = claude.profiles.find((x) => x.profileId === id);
      return { applied: true, alreadyActive: false, email: p ? p.email : '' };
    },
    async setLabel(id, label) {
      calls.push(['claude.label', id, label]);
      const p = claude.profiles.find((x) => x.profileId === id);
      if (!p) throw Object.assign(new Error('not found'), { code: 'CRED_NOT_FOUND' });
      p.label = label || null;
      return p;
    },
    async updateSnapshotUsage(id, o) { calls.push(['claude.usage', id, !!(o && o.force)]); return null; },
  };
  const codexAccountManager = {
    providerId: 'codex', // gsd:provider-literal-allowed (test fixture)
    getSafeList: () => ({ providerId: 'codex', activeAccountId: codex.active, accounts: codex.accounts.map((a) => Object.assign({}, a, { isActive: a.accountId === codex.active })) }), // gsd:provider-literal-allowed (test fixture)
    getActiveAccountId: () => codex.active,
    async applyAccount(id, o) {
      calls.push(['codex.apply', id, !!(o && o.force)]);
      if (codex.applyError) throw codex.applyError;
      if (id === codex.active) return { applied: false, alreadyActive: true, runningProcesses: codex.running, processCheck: 'ok' };
      if (codex.running.length && !(o && o.force)) throw Object.assign(new Error('Codex is running'), { code: 'CODEX_RUNNING', processes: codex.running });
      codex.active = codex.liveAfterApply || id;
      const a = codex.accounts.find((x) => x.accountId === id);
      return { applied: true, alreadyActive: false, email: a ? a.email : '', runningProcesses: codex.running, processCheck: 'ok' };
    },
    async setLabel(id, label) {
      calls.push(['codex.label', id, label]);
      const a = codex.accounts.find((x) => x.accountId === id);
      if (!a) throw Object.assign(new Error('not found'), { code: 'ACCT_NOT_FOUND' });
      a.label = label || null;
      return a;
    },
    async updateSnapshotUsage(id, o) { calls.push(['codex.usage', id, !!(o && o.force)]); return null; },
  };
  return { credentialManager, codexAccountManager, claude, codex, calls };
}

module.exports = Object.assign({}, kit, { bootWorkspace, tmpDir, tracked, frame, harness, fakeAccountManagers });
