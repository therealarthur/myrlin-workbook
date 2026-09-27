#!/usr/bin/env node
/**
 * desktop-layout-browser.js: a browser proof that the desktop page never
 * overwrites a phone's tab edit (PROTOCOL.md 4.8.1; decision A11;
 * BUILD-CONTRACT S8 and S17 to S20, 3.7.2 "Tabs").
 *
 * What: starts a sandbox Workbook in this process (startServer on an
 * ephemeral port, the mobile listener on another), opens the real desktop
 * page in headless Chromium, and drives three cases while reading the page's
 * own state (window.cwm) and layout.json on disk:
 *   A. the phone renames a tab group while the page is idle: the page hears
 *      layout:updated, reloads the layout and shows the phone's name;
 *   B. the person renames a tab group on the page (double click, type,
 *      Enter) and, inside the page's 500 ms save debounce, the phone renames
 *      another group: the page's save carries its older baseRevision, the
 *      server re-applies the phone's operation (merged: true), and both
 *      names survive on disk and on the page;
 *   C. the same with the phone creating a whole group: it survives too;
 *   D. the page's event stream is down, so it never hears of a phone
 *      rename, and then it saves a change of its own from its old revision:
 *      the server rebases that save and the phone's rename survives;
 * then reloads the page and checks the merged layout is what loads.
 *
 * Why: the unit tests prove the store and the page's source; this proves the
 * running page and server together, as a person would meet them.
 *
 * Sandbox only: the process first loads test/mobile/_harness.js (a fresh
 * CWM_DATA_DIR under the system temp folder, a random CWM_PASSWORD, and the
 * guard that refuses anything else), then points HOME, USERPROFILE,
 * LOCALAPPDATA, the Claude projects folder, CODEX_HOME and the Glass folder
 * at empty folders beside it, sets CWM_CRED_EXTERNAL_BRIDGE_OWNER=1 and
 * credentialSwitcher.proactiveRefreshMinutes 0, and refuses ports 3456 to
 * 3458. Point TEMP and TMP at a scratch folder to keep everything there.
 *
 * Usage: PLAYWRIGHT_MODULE=<path to the playwright package> [CHROMIUM_EXECUTABLE=<chrome>]
 *   node test/mobile/e2e/desktop-layout-browser.js
 * Exit code 0 when every case holds; 1 otherwise. Not a *.test.js file:
 * Playwright is not a Workbook dependency, so run-all.js never runs it.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const harness = require('../_harness');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

/** The repository root. */
const REPO = path.resolve(__dirname, '..', '..', '..');
/** Ports this proof must never bind or call (the live Workbook's). */
const FORBIDDEN_PORTS = new Set([3456, 3457, 3458]);
/** Longest wait for the page to reflect a change. */
const PAGE_WAIT_MS = 15000;
/** The page's save debounce (app.js saveTerminalLayout). */
const SAVE_DEBOUNCE_MS = 500;
/** Scopes of the proof's phone (PROTOCOL.md 2.10). */
const PHONE_SCOPES = ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage'];

/**
 * A free loopback port.
 *
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/**
 * JSON over loopback HTTP.
 *
 * @param {number} port - Port.
 * @param {string} method - Method.
 * @param {string} p - Path.
 * @param {object|null} body - Body.
 * @param {string|null} token - Bearer.
 * @returns {Promise<{status: number, body: *}>}
 */
function request(port, method, p, body, token) {
  if (FORBIDDEN_PORTS.has(port)) return Promise.reject(new Error('refusing port ' + port));
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Wait until a predicate holds.
 *
 * @param {Function} pred - Async predicate.
 * @param {number} ms - Timeout.
 * @param {string} label - What is awaited.
 * @returns {Promise<void>}
 */
async function until(pred, ms, label) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Assert.
 *
 * @param {*} cond - Condition.
 * @param {string} msg - Message.
 */
function check(cond, msg) {
  if (!cond) throw new Error('failed: ' + msg);
  console.log('  ok   ' + msg);
}

/** Run the proof. */
async function main() {
  const pwPath = process.env.PLAYWRIGHT_MODULE;
  if (!pwPath) { console.error('Set PLAYWRIGHT_MODULE to the playwright package folder.'); process.exit(2); }
  const { chromium } = require(pwPath);
  const dataDir = process.env.CWM_DATA_DIR;
  const root = path.dirname(dataDir);
  const made = [];
  const sandboxDir = (name) => { const d = path.join(root, path.basename(dataDir) + '-' + name); fs.mkdirSync(d, { recursive: true }); made.push(d); return d; };
  const home = sandboxDir('home');
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: sandboxDir('localappdata'),
    APPDATA: sandboxDir('appdata'),
    CWM_CLAUDE_PROJECTS_DIR: sandboxDir('claude-projects'),
    CODEX_HOME: sandboxDir('codex'),
    CWM_GLASS_DIR: sandboxDir('quota'),
    CWM_CRED_EXTERNAL_BRIDGE_OWNER: '1',
    CWM_NO_OPEN: '1',
    CWM_MOBILE_ENABLED: '1',
    CWM_MOBILE_HOST: '127.0.0.1',
  });
  delete process.env.CWM_VT_SIDECAR;
  const mainPort = await freePort();
  const mobilePort = await freePort();
  if (FORBIDDEN_PORTS.has(mainPort) || FORBIDDEN_PORTS.has(mobilePort)) throw new Error('an ephemeral port collided with 3456 to 3458; run again');
  process.env.CWM_MOBILE_PORT = String(mobilePort);
  fs.writeFileSync(path.join(dataDir, 'layout.json'), JSON.stringify({ tabGroups: [{ id: 'tg_main', name: 'Main', panes: [] }, { id: 'tg_research', name: 'Research', panes: [] }], tabFolders: [], activeGroupId: 'tg_main' }));
  const { getStore } = require(path.join(REPO, 'src', 'state', 'store'));
  getStore().updateSettings({ credentialSwitcher: { proactiveRefreshMinutes: 0 } });
  const serverMod = require(path.join(REPO, 'src', 'web', 'server'));
  const server = serverMod.startServer(mainPort, '127.0.0.1');
  let browser = null;
  const pageErrors = [];
  try {
    await until(() => server.listening, 10000, 'the main server');
    const mobile = require(path.join(REPO, 'src', 'web', 'mobile'));
    await until(() => { const rt = mobile.getRuntime(); return !!(rt && rt.listener.status().running && rt.ctx.mobile.workspace); }, 15000, 'the mobile listener');
    const rt = mobile.getRuntime();
    console.log('sandbox Workbook on 127.0.0.1:' + mainPort + ', phone listener on ' + rt.listener.status().port + ', data ' + dataDir);
    const login = await request(mainPort, 'POST', '/api/auth/login', { password: process.env.CWM_PASSWORD }, null);
    if (!login.body || !login.body.token) throw new Error('desktop login failed: ' + login.status);
    const desktopToken = login.body.token;
    const dev = harness.softwareDevice('Browser proof iPhone');
    const rec = rt.devices.create({ publicKey: dev.publicKey, name: dev.name, model: 'iPhone17,2', osVersion: '26.1', appVersion: '1.0.0 (1)', scopes: PHONE_SCOPES.slice(), pairedAtMs: Date.now() });
    const phoneToken = rt.auth.mint(rec.deviceId).token;
    const phonePort = rt.listener.status().port;
    const phone = (ops, baseRevision) => request(phonePort, 'PATCH', '/api/m/v2/tabs', { baseRevision, ops }, phoneToken);
    const disk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'layout.json'), 'utf8'));
    const names = (layout) => (layout.tabGroups || []).map((g) => g.name);

    // CHROMIUM_EXECUTABLE picks an installed browser build when the
    // Playwright package expects a newer one than the machine has.
    browser = await chromium.launch(Object.assign({ headless: true }, process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}));
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript((t) => { try { localStorage.setItem('cwm_token', t); localStorage.setItem('cwm_viewMode', 'terminal'); } catch (_) { /* first paint */ } }, desktopToken);
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('http://127.0.0.1:' + mainPort + '/');
    await page.waitForFunction(() => window.cwm && Array.isArray(window.cwm._tabGroups) && window.cwm._tabGroups.length === 2 && typeof window.cwm._layoutRevision === 'number', null, { timeout: PAGE_WAIT_MS });
    const pageState = () => page.evaluate(() => ({ revision: window.cwm._layoutRevision, names: window.cwm._tabGroups.map((g) => g.name), tabs: Array.from(document.querySelectorAll('.terminal-group-tab .terminal-group-tab-name')).map((e) => e.textContent.trim()) }));
    // What the page saw of the stream, for a failed wait (diagnostics only).
    await page.evaluate(() => {
      window.__b3Events = [];
      const orig = window.cwm.handleSSEEvent.bind(window.cwm);
      window.cwm.handleSSEEvent = (d) => { try { window.__b3Events.push(d && d.type); } catch (_) { /* diagnostics */ } return orig(d); };
    });
    const diag = async () => JSON.stringify(await page.evaluate(() => ({ revision: window.cwm._layoutRevision, timer: !!window.cwm._layoutSaveTimer, inFlight: window.cwm._layoutSaveInFlight || 0, pending: window.cwm._layoutPendingRemote, events: (window.__b3Events || []).slice(-10), sse: !!window.cwm.eventSource })));
    const untilPage = async (pred, label) => { try { await until(pred, PAGE_WAIT_MS, label); } catch (err) { throw new Error(err.message + ' ' + (await diag())); } };
    await page.waitForFunction(() => window.cwm.eventSource && window.cwm.eventSource.readyState === 1, null, { timeout: PAGE_WAIT_MS });
    const r0 = (await pageState()).revision;
    check(r0 === (disk().revision || 0), 'the page loaded the layout with its revision (' + r0 + ')');

    // A. A phone edit while the page is idle.
    const a = await phone([{ op: 'renameGroup', groupId: 'tg_main', name: 'Phone A' }], r0);
    check(a.status === 200 && a.body.tabs.revision === r0 + 1, 'the phone renamed Main (revision ' + (a.body && a.body.tabs && a.body.tabs.revision) + ')');
    await untilPage(async () => { const s = await pageState(); return s.names.includes('Phone A') && s.tabs.includes('Phone A') && s.revision === r0 + 1; }, 'the page to show the phone rename');
    check(true, 'A: the page applied layout:updated without a reload and shows "Phone A"');

    // B. A desktop rename, and inside its save debounce a phone rename of the other group.
    const base = (await pageState()).revision;
    await page.dblclick('.terminal-group-tab[data-group-id="tg_research"]');
    await page.waitForSelector('.inline-rename-input', { timeout: PAGE_WAIT_MS });
    await page.fill('.inline-rename-input', 'Desk B');
    await page.keyboard.press('Enter');
    const b = await phone([{ op: 'renameGroup', groupId: 'tg_main', name: 'Phone B' }], base);
    check(b.status === 200, 'the phone renamed Main again inside the page\'s ' + SAVE_DEBOUNCE_MS + ' ms save window');
    await until(async () => { const d = disk(); return names(d).includes('Desk B') && names(d).includes('Phone B'); }, PAGE_WAIT_MS, 'both renames on disk');
    const dB = disk();
    check(names(dB).join(',') === 'Phone B,Desk B', 'B: layout.json keeps both: ' + names(dB).join(', '));
    await untilPage(async () => { const st = await pageState(); return st.revision === disk().revision && st.names.includes('Phone B') && st.names.includes('Desk B'); }, 'the page to hold the merged layout');
    const sB = await pageState();
    check(sB.tabs.includes('Phone B') && sB.tabs.includes('Desk B'), 'B: the page shows both names and holds the server revision (' + sB.revision + ')');

    // C. The phone creates a group while a desktop save is pending.
    await page.dblclick('.terminal-group-tab[data-group-id="tg_research"]');
    await page.waitForSelector('.inline-rename-input', { timeout: PAGE_WAIT_MS });
    await page.fill('.inline-rename-input', 'Desk C');
    await page.keyboard.press('Enter');
    const c = await phone([{ op: 'createGroup', tempId: 't1', name: 'Phone C', folderId: null, afterGroupId: null }], (await pageState()).revision);
    check(c.status === 200 && c.body.tempIds && /^tg_/.test(c.body.tempIds.t1), 'the phone created a group inside the save window');
    await until(async () => { const d = disk(); return names(d).includes('Desk C') && names(d).includes('Phone C'); }, PAGE_WAIT_MS, 'the new group and the rename on disk');
    await untilPage(async () => { const st = await pageState(); return st.names.includes('Phone C') && st.names.includes('Desk C') && st.revision === disk().revision; }, 'the page to show the new group');
    check(names(disk()).join(',') === 'Phone B,Desk C,Phone C', 'C: the phone\'s new group survived the desktop save: ' + names(disk()).join(', '));

    // D. The worst case: the page misses the phone's event entirely (its
    // stream is down), then saves a change of its own from an old revision.
    await page.evaluate(() => { clearTimeout(window.cwm.sseRetryTimeout); window.cwm.disconnectSSE(); });
    const d = await phone([{ op: 'renameGroup', groupId: 'tg_main', name: 'Phone D' }], disk().revision);
    check(d.status === 200, 'the phone renamed Main while the page event stream was down');
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS * 2));
    check(!(await pageState()).names.includes('Phone D'), 'the page did not hear about it');
    await page.dblclick('.terminal-group-tab[data-group-id="tg_research"]');
    await page.waitForSelector('.inline-rename-input', { timeout: PAGE_WAIT_MS });
    await page.fill('.inline-rename-input', 'Desk D');
    await page.keyboard.press('Enter');
    await untilPage(async () => { const st = await pageState(); return st.names.includes('Phone D') && st.names.includes('Desk D') && st.revision === disk().revision; }, 'the page to take the merged answer of its own save');
    check(names(disk()).join(',') === 'Phone D,Desk D,Phone C', 'D: its stale save was rebased, the phone edit survived: ' + names(disk()).join(', '));
    await page.evaluate(() => window.cwm.connectSSE());

    // Reload: the merged layout is what the page loads.
    await page.reload();
    await page.waitForFunction(() => window.cwm && Array.isArray(window.cwm._tabGroups) && window.cwm._tabGroups.length === 3, null, { timeout: PAGE_WAIT_MS });
    const sR = await pageState();
    check(sR.names.join(',') === 'Phone D,Desk D,Phone C' && sR.revision === disk().revision, 'after a reload the page loads the merged layout (revision ' + sR.revision + ')');
    const tabs = (await request(phonePort, 'GET', '/api/m/v2/tabs', null, phoneToken)).body.tabs;
    check(tabs.groups.map((g) => g.name).join(',') === 'Phone D,Desk D,Phone C' && tabs.revision === sR.revision, 'the phone reads the same tabs and revision');
    check(pageErrors.length === 0, 'no page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
    if (process.env.B3_BROWSER_SHOT) {
      await page.screenshot({ path: process.env.B3_BROWSER_SHOT, clip: { x: 0, y: 0, width: 1280, height: 200 } });
      console.log('  screenshot ' + process.env.B3_BROWSER_SHOT + ' (1280 x 200)');
    }
    console.log('PROOF HOLDS: the desktop never overwrote a phone tab edit');
  } finally {
    try { if (browser) await browser.close(); } catch (_) { /* closed */ }
    try { await stopMobileModule(); } catch (_) { /* stopped */ }
    await new Promise((r) => server.close(() => r()));
    // The data folder is removed by test/_test-data-dir.js at exit; the
    // sibling folders made here are removed now.
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  }

  /** Stop the mobile module (listener and background work). */
  async function stopMobileModule() {
    await require(path.join(REPO, 'src', 'web', 'mobile')).stopMobile();
  }
}

main().then(() => process.exit(0), (err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
