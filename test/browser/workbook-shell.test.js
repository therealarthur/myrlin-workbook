#!/usr/bin/env node
/**
 * workbook-shell.test.js - Full Workbook SPA restart and visual smoke test.
 * Created: 2026-07-25
 *
 * Launches the lane build with isolated state and profile directories, signs
 * in through a one-use startup token, inspects the rendered application, and
 * stops only the child it created.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(__dirname, 'workbook-shell-server.js');
const CLIPBOARD_GUARD_PATH = path.join(__dirname, 'clipboard-guard.ps1');
const SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-e2e.png');
const LIGHT_SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-focused-light.png');
const MOBILE_SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-focused-mobile.png');
const TABLET_SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-focused-tablet.png');
const TEMP_PREFIX = 'myrlin-workbook-shell-';
const FETCH_HEAD_PATH = path.join(PROJECT_ROOT, '.git', 'FETCH_HEAD');
const LEGACY_CONFIG_PATH = path.join(PROJECT_ROOT, 'state', 'config.json');
const EXPECTED_VERSION = require(path.join(PROJECT_ROOT, 'package.json')).version;

/**
 * Remove startup-token values before an error reaches logs.
 * @param {string} value - Potentially sensitive diagnostic text.
 * @returns {string} Redacted diagnostic.
 */
function redactToken(value) {
  return String(value || '').replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * Wait until an owned child has actually exited.
 * @param {import('child_process').ChildProcess} child - Owned child process.
 * @param {number} timeoutMs - Maximum wait.
 * @returns {Promise<boolean>} Whether exit was observed.
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/**
 * Fingerprint file metadata without reading potentially sensitive contents.
 * @param {string} filePath - File to inspect.
 * @returns {null|{size:number,mtimeMs:number}} Stable metadata.
 */
function metadataFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Start the isolated full application and capture its one-use URL.
 * @param {string} sandbox - Validated temporary sandbox root.
 * @returns {Promise<{child: import('child_process').ChildProcess, url: string}>}
 */
function startWorkbook(sandbox) {
  return new Promise((resolve, reject) => {
    const profile = path.join(sandbox, 'profile');
    const dataDir = path.join(sandbox, 'data');
    const claudeDir = path.join(profile, '.claude');
    const emptySeed = path.join(sandbox, 'empty-seed');
    const tempDir = path.join(sandbox, 'temp');
    const appData = path.join(profile, 'AppData', 'Roaming');
    const localAppData = path.join(profile, 'AppData', 'Local');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(emptySeed, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(localAppData, { recursive: true });
    // Defense in depth: even without the production hermetic switch, this
    // first-choice config prevents fallback to the clone's ignored state file.
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n', 'utf8');

    // Use an allowlisted environment instead of inheriting tokens, credentials,
    // or caller-specific homes. USERPROFILE and all application paths point
    // inside the validated disposable sandbox.
    const childEnv = {
      CWM_DATA_DIR: dataDir,
      CWM_CLAUDE_DIR: claudeDir,
      CWM_CLAUDE_JSON: path.join(profile, '.claude.json'),
      CWM_CRED_SEED_DIR: emptySeed,
      CWM_CRED_EXTERNAL_BRIDGE_OWNER: '1',
      CWM_CRED_DISABLE_MAC: '1',
      CWM_TEST_HERMETIC_UI: '1',
      CWM_NO_OPEN: '1',
      CWM_PASSWORD: crypto.randomUUID(),
      USERPROFILE: profile,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: tempDir,
      TMP: tempDir,
      NODE_ENV: 'test',
    };
    for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT']) {
      if (typeof process.env[name] === 'string') childEnv[name] = process.env[name];
    }

    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopWorkbook(child).then(
        () => reject(error),
        (cleanupError) => reject(new AggregateError([error, cleanupError], 'Workbook startup and cleanup failed'))
      );
    };
    const timeout = setTimeout(() => {
      fail(new Error(
        'full Workbook server did not report readiness: ' +
        redactToken((stdout + '\n' + stderr).trim())
      ));
    }, 30000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('message', (message) => {
      if (!message || message.type !== 'ready' || typeof message.url !== 'string' || settled) return;
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
          !parsed.searchParams.has('token')) {
        fail(new Error('full Workbook server reported an invalid startup URL'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: message.url });
    });
    child.once('error', (error) => fail(error));
    child.on('exit', (code) => {
      if (settled) return;
      fail(new Error(
        'full Workbook server exited ' + code + ': ' +
        redactToken((stdout + '\n' + stderr).trim())
      ));
    });
  });
}

/**
 * Stop the exact full-app child launched by this test.
 * @param {import('child_process').ChildProcess} child - Owned server child.
 * @returns {Promise<void>}
 */
async function stopWorkbook(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const gracefulExit = waitForExit(child, 5000);
  try {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
  } catch (_) {}
  if (await gracefulExit) return;

  const forcedExit = waitForExit(child, 5000);
  try { child.kill('SIGKILL'); } catch (_) {}
  if (!(await forcedExit)) {
    throw new Error('owned full Workbook server did not exit after forced termination');
  }
}

/**
 * Snapshot every Windows clipboard format before the full-shell copy
 * regression mutates it.
 * @returns {Promise<import('child_process').ChildProcess>} Owned guard process.
 */
function startClipboardGuard() {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      CLIPBOARD_GUARD_PATH,
    ], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      try { child.stdin.end(); } catch (_) {}
      if (!(await waitForExit(child, 3000))) {
        try { child.kill('SIGKILL'); } catch (_) {}
        await waitForExit(child, 3000);
      }
      reject(new Error('clipboard guard did not become ready'));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (!stdout.includes('CLIPBOARD_GUARD_READY')) return;
      settled = true;
      clearTimeout(timeout);
      resolve(child);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('clipboard guard exited ' + code + ': ' + stderr.trim()));
    });
  });
}

/**
 * Ask the clipboard guard to restore its complete snapshot and confirm exit.
 * @param {import('child_process').ChildProcess} child - Owned guard process.
 * @returns {Promise<void>}
 */
async function stopClipboardGuard(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('clipboard guard exited before restoration was requested');
  }

  const restored = waitForExit(child, 15000);
  try { child.stdin.end('RESTORE\n'); } catch (_) {}
  if (!(await restored)) {
    try { child.kill('SIGKILL'); } catch (_) {}
    await waitForExit(child, 3000);
    throw new Error('clipboard guard did not confirm clipboard restoration');
  }
  if (child.exitCode !== 0) {
    throw new Error('clipboard guard failed while restoring the clipboard');
  }
}

/**
 * Delete only the validated temporary directory created by this test.
 * @param {string} sandbox - Candidate sandbox root.
 */
function removeSandbox(sandbox) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(sandbox);
  assert.strictEqual(path.dirname(resolved), tempRoot, 'sandbox escaped the OS temp directory');
  assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX), 'sandbox prefix validation failed');
  fs.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Run the authenticated full-SPA visual smoke test.
 * @returns {Promise<void>}
 */
async function run() {
  assert.strictEqual(
    process.platform,
    'win32',
    'full Workbook shell acceptance must run on Windows before creating state or starting services'
  );
  const fetchHeadBefore = metadataFingerprint(FETCH_HEAD_PATH);
  const legacyConfigBefore = metadataFingerprint(LEGACY_CONFIG_PATH);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let child = null;
  let browser = null;
  try {
    const started = await startWorkbook(sandbox);
    child = started.child;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const blockedExternalRequests = [];
    await context.route(/^https?:\/\//, (route) => {
      const target = new URL(route.request().url());
      if (target.hostname === '127.0.0.1') return route.continue();
      blockedExternalRequests.push(target.origin + target.pathname);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const startupUrl = new URL(started.url);
    startupUrl.searchParams.set('qa', 'focused-shell');
    await page.goto(startupUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token);

    const shell = await page.evaluate(() => ({
      title: document.title,
      loginHidden: document.getElementById('login-screen').hidden,
      appHidden: document.getElementById('app').hidden,
      terminalScript: document.querySelector('script[src^="terminal.js"]')?.getAttribute('src') || '',
      appScript: document.querySelector('script[src^="app.js"]')?.getAttribute('src') || '',
      terminalClass: typeof TerminalPane,
      selectInterceptor: typeof TerminalPane !== 'undefined' &&
        typeof TerminalPane.prototype._installSelectModeInterceptor,
      themeRegistry: typeof MyrlinThemeRegistry,
      shellMode: document.documentElement.dataset.uiShell,
      themeChoice: document.documentElement.dataset.themeChoice,
      resolvedTheme: document.documentElement.dataset.theme,
      urlHasToken: new URL(location.href).searchParams.has('token'),
      preservedQuery: new URL(location.href).searchParams.get('qa'),
      storedToken: !!localStorage.getItem('cwm_token'),
    }));

    assert.strictEqual(shell.title, "myrlin's workbook");
    assert.strictEqual(shell.loginHidden, true, 'startup token must reveal the application shell');
    assert.strictEqual(shell.appHidden, false, 'application shell must be visible after startup auth');
    // SANCTIONED EDIT SE-11, orchestrator authorisation for Notion restyle
    // phase P1.6. BUILD-CONTRACT 5.4 names three test files in the cachebuster
    // set and gate G10 checks four; this is the fifth, and DECISIONS.md finding
    // F1 recorded that these two assertions were ALREADY STALE on this branch
    // before the restyle touched anything. They still pinned
    // ?v=20260727-copy-native8, from before the Select v3 and mobile-select
    // cachebusters landed, so npm run test:workbook-shell could not pass. They
    // are brought to the current values as part of the same atomic bump rather
    // than left broken, which is why a bump is a FIVE-file change, not four.
    // Notion restyle phase P5 carries the same edit forward: terminal.js moves
    // to -p5 for the terminalSurface read and the paste path, app.js is
    // untouched and keeps -p4r. Gate G10b watches exactly these two lines and
    // was PASS after P1.6; leaving them stale would hand the next phase a
    // warning that costs more to diagnose than it does to keep current.
    assert.strictEqual(shell.terminalScript, 'terminal.js?v=20260819-mobile-term');
    // app.js moved to -p10 with the concurrent mobile track. Carried here by
    // P5 rather than left stale: gate G10b watches these two lines, this file
    // is the FIFTH file of the atomic bump SE-11 records, and a red browser
    // lane costs the next reader more to diagnose than the token costs to
    // track. Neither value is this phase's to choose; both simply follow
    // index.html.
    assert.strictEqual(shell.appScript, 'app.js?v=20260819-mobile-term');
    assert.strictEqual(shell.terminalClass, 'function', 'production TerminalPane must load');
    assert.strictEqual(shell.selectInterceptor, 'function', 'Select-mode interceptor must be present');
    assert.strictEqual(shell.themeRegistry, 'object', 'canonical theme registry must load before the app');
    assert.strictEqual(shell.shellMode, 'focused', 'focused hierarchy must be the default');
    assert.strictEqual(shell.themeChoice, 'system', 'new profiles should follow system appearance');
    assert.strictEqual(shell.resolvedTheme, 'mocha', 'dark system appearance should resolve to Mocha');
    assert.strictEqual(shell.urlHasToken, false, 'startup token must be stripped from the address bar');
    assert.strictEqual(shell.preservedQuery, 'focused-shell', 'token cleanup must preserve benign query switches');
    assert.strictEqual(shell.storedToken, true, 'authenticated UI must retain its device token');

    const hermeticState = await page.evaluate(async () => {
      const token = localStorage.getItem('cwm_token');
      const headers = { Authorization: 'Bearer ' + token };
      const read = async (url) => {
        const response = await fetch(url, { headers });
        return { status: response.status, body: await response.json() };
      };
      const post = async (url) => {
        const response = await fetch(url, { method: 'POST', headers });
        return { status: response.status, body: await response.json() };
      };
      return {
        version: await read('/api/version'),
        selfUpdate: await post('/api/update'),
        quickTunnels: await read('/api/tunnels'),
        namedTunnel: await read('/api/tunnel/named'),
      };
    });
    assert.strictEqual(hermeticState.version.status, 200);
    assert.strictEqual(hermeticState.version.body.version, EXPECTED_VERSION);
    assert.strictEqual(hermeticState.version.body.updateAvailable, false);
    assert.strictEqual(hermeticState.version.body.commitsBehind, 0);
    assert.strictEqual(hermeticState.selfUpdate.status, 503);
    assert.match(hermeticState.selfUpdate.body.error, /disabled in hermetic UI tests/);
    assert.deepStrictEqual(
      hermeticState.quickTunnels,
      { status: 200, body: { cloudflaredAvailable: false, tunnels: [] } },
      'hermetic mode must not probe or launch cloudflared'
    );
    assert.strictEqual(hermeticState.namedTunnel.status, 200);
    assert.strictEqual(hermeticState.namedTunnel.body.configured, false);
    assert.strictEqual(hermeticState.namedTunnel.body.disabled, true);

    const focusedDesktop = await page.evaluate(() => {
      const visible = (element) => !!element &&
        getComputedStyle(element).display !== 'none' &&
        getComputedStyle(element).visibility !== 'hidden';
      const labels = (selector) => Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map(element => element.textContent.trim().replace(/\s+/g, ' '));
      const header = document.querySelector('.app-header');
      return {
        primaryLabels: labels('.view-tab[data-shell-tier="primary"]'),
        visibleViewTabs: labels('.view-tab'),
        moreVisible: visible(document.getElementById('focused-more-btn')),
        moreInsideTablist: !!document.querySelector('[role="tablist"] #focused-more-btn'),
        moreExpanded: document.getElementById('focused-more-btn').getAttribute('aria-expanded'),
        sidebarViewToggleVisible: visible(document.getElementById('sidebar-view-toggle')),
        discoveredListHidden: document.getElementById('projects-list').hidden,
        discoveredSearchHidden: document.getElementById('projects-search-bar').hidden,
        emptyStateVisible: visible(document.getElementById('workbench-empty-state')),
        startButtonVisible: visible(document.getElementById('workbench-start-btn')),
        browseSessionsLabel: document.getElementById('workbench-projects-btn').textContent.trim(),
        emptyFrameContent: getComputedStyle(
          document.querySelector('.terminal-pane-empty .terminal-container'),
          '::after'
        ).content,
        retiredTabsVisible: labels('.tasks-tab[data-shell-maturity="retired"]'),
        headerHeight: Math.round(header.getBoundingClientRect().height),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.deepStrictEqual(
      focusedDesktop.primaryLabels,
      ['Workbench', 'Sessions', 'Tasks'],
      'focused shell must expose exactly three primary destinations'
    );
    assert.deepStrictEqual(
      focusedDesktop.visibleViewTabs,
      ['Workbench', 'Sessions', 'Tasks'],
      'secondary and contextual routes must not compete in the top nav'
    );
    assert.strictEqual(focusedDesktop.moreVisible, true, 'More must expose secondary routes');
    assert.strictEqual(focusedDesktop.moreInsideTablist, false, 'menu controls must not be nested in the view tablist');
    assert.strictEqual(focusedDesktop.moreExpanded, 'false', 'closed More must announce its collapsed state');
    assert.strictEqual(focusedDesktop.sidebarViewToggleVisible, false, 'duplicate sidebar task navigation must be hidden');
    assert.strictEqual(focusedDesktop.discoveredListHidden, true, 'Discovered should be collapsed by default');
    assert.strictEqual(focusedDesktop.discoveredSearchHidden, true, 'collapsed Discovered must hide its search controls too');
    assert.strictEqual(focusedDesktop.emptyStateVisible, true, 'empty Workbench must offer a start state');
    assert.strictEqual(focusedDesktop.startButtonVisible, true, 'empty Workbench must offer Start session');
    assert.strictEqual(focusedDesktop.browseSessionsLabel, 'Browse sessions', 'secondary CTA must describe its actual route');
    assert.ok(
      focusedDesktop.emptyFrameContent === 'none' ||
        focusedDesktop.emptyFrameContent === 'normal',
      'legacy dashed empty-state copy must be removed'
    );
    assert.deepStrictEqual(focusedDesktop.retiredTabsVisible, [], 'retired Git/Files tabs must stay hidden');
    // SANCTIONED TEST EDIT SE-16 (BUILD-CONTRACT 5.4). Notion restyle P2 cut
    // the topbar from 58px to 44px: `--app-topbar-height: 44px` in styles.css
    // feeds `--focused-header-height` in focused-shell.css. The pin is
    // RETARGETED to the new measured truth, not deleted; a header that grows
    // back to 58 is still a regression this line catches.
    assert.strictEqual(focusedDesktop.headerHeight, 44, 'focused desktop header must stay compact');
    assert.strictEqual(focusedDesktop.horizontalOverflow, false, 'desktop shell must not overflow horizontally');

    await page.evaluate(() => window.cwm.setViewMode('terminal'));
    await page.waitForTimeout(250);
    assert.strictEqual(
      await page.locator('#terminal-grid').isVisible(),
      true,
      'terminal view must render inside the authenticated Workbook shell'
    );

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

    await page.setViewportSize({ width: 1600, height: 900 });
    const scaledDenseGrid = await page.evaluate(() => {
      const prior = window.cwm.terminalPanes.slice();
      for (let i = 0; i < 5; i++) {
        window.cwm.terminalPanes[i] = { safeFit() {} };
      }
      window.cwm.updateTerminalGridLayout();
      const main = document.querySelector('.main-content');
      const grid = document.getElementById('terminal-grid');
      const style = getComputedStyle(grid);
      const result = {
        mainWidth: Math.round(main.getBoundingClientRect().width),
        columns: style.gridTemplateColumns.split(/\s+/).length,
        rows: style.gridTemplateRows.split(/\s+/).length,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
      prior.forEach((pane, index) => { window.cwm.terminalPanes[index] = pane; });
      window.cwm.updateTerminalGridLayout();
      return result;
    });
    assert.ok(scaledDenseGrid.mainWidth < 1400, 'scaled QA fixture must exercise the canvas query');
    assert.deepStrictEqual(
      {
        columns: scaledDenseGrid.columns,
        rows: scaledDenseGrid.rows,
        overflow: scaledDenseGrid.overflow,
      },
      { columns: 2, rows: 3, overflow: false },
      'five terminals must use the real 1334px canvas, not the 1600px outer viewport'
    );
    await page.setViewportSize({ width: 1440, height: 900 });

    // Exercise the focused shell through rendered controls, not direct route
    // calls. Secondary destinations must remain reachable behind one menu.
    const moreButton = page.locator('#focused-more-btn');
    await moreButton.focus();
    const moreFocusRing = await moreButton.evaluate((button) => {
      const style = getComputedStyle(button);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    assert.deepStrictEqual(
      moreFocusRing,
      { style: 'solid', width: '2px' },
      'the sole secondary-route control must retain a visible keyboard focus ring'
    );
    await page.keyboard.press('Enter');
    const moreMenu = page.locator('#context-menu');
    await moreMenu.waitFor({ state: 'visible' });
    assert.strictEqual(
      await moreButton.getAttribute('aria-expanded'),
      'true',
      'More must announce its open state'
    );
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'Session attention',
      'opening More from the keyboard must focus its first enabled command'
    );
    await page.keyboard.press('Tab');
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'Recent activity',
      'Tab must remain inside the open More menu'
    );
    await page.keyboard.press('Escape');
    await moreMenu.waitFor({ state: 'hidden' });
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.id),
      'focused-more-btn',
      'Escape must close More and restore focus to its trigger'
    );
    assert.strictEqual(await moreButton.getAttribute('aria-expanded'), 'false');

    await page.keyboard.press('Enter');
    await moreMenu.waitFor({ state: 'visible' });
    const moreLabels = await page.locator('#context-menu-items > .ctx-item-wrapper > .context-menu-item')
      .allTextContents();
    for (const expected of [
      'Session attention',
      'Recent activity',
      'Costs',
      'System resources',
      'Project notes',
      'Quick switcher',
      'All sessions',
      'Settings',
      'Appearance',
    ]) {
      assert.ok(
        moreLabels.some(label => label.replace(/\s+/g, ' ').trim().includes(expected)),
        `More menu must expose ${expected}`
      );
    }
    assert.strictEqual(
      await page.locator('#context-menu-items [data-action="Project notes"]').isEnabled(),
      true,
      'Project notes must remain reachable so its explicit project picker can establish context'
    );
    await page.locator('#context-menu-items [data-action="Project notes"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'docs');
    assert.strictEqual(await page.locator('#docs-panel').isVisible(), true);
    assert.strictEqual(await page.locator('#docs-workspace-select').isVisible(), true);
    assert.strictEqual(await page.locator('#docs-workspace-select').inputValue(), '');
    assert.deepStrictEqual(
      await page.locator('#docs-workspace-select option').allTextContents(),
      ['Choose a project'],
      'empty Project Notes must expose an honest project-context picker'
    );

    await page.locator('#focused-more-btn').click();
    await page.locator('#context-menu-items [data-action="Recent activity"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'recent');
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.id),
      'focused-more-btn',
      'activating a More command must not strand focus inside the hidden menu'
    );

    await page.locator('#focused-more-btn').click();
    await page.locator('#context-menu-items [data-action="Costs"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'costs');
    assert.strictEqual(await page.locator('#costs-panel').isVisible(), true);

    await page.locator('#focused-more-btn').click();
    await page.locator('#context-menu-items [data-action="System resources"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'resources');
    assert.strictEqual(await page.locator('#resources-panel').isVisible(), true);

    // A stale preference for a demoted preview cannot reopen Git/Files.
    const sanitizedTasksTab = await page.evaluate(() => {
      localStorage.setItem('cwm_tasksTab', 'git');
      window.cwm.setViewMode('tasks');
      window.cwm._switchTasksTab('git');
      return {
        active: window.cwm._activeTasksTab,
        stored: localStorage.getItem('cwm_tasksTab'),
      };
    });
    assert.deepStrictEqual(
      sanitizedTasksTab,
      { active: 'worktree', stored: 'worktree' },
      'hidden task previews must sanitize stale persisted state'
    );

    await page.evaluate(() => window.cwm.setViewMode('terminal'));
    await page.locator('#workbench-start-btn').click();
    await page.locator('#launcher-overlay').waitFor({ state: 'visible' });
    await page.locator('#launcher-close').click();
    await page.locator('#launcher-overlay').waitFor({ state: 'hidden' });
    await page.locator('#workbench-projects-btn').click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'workspace');
    await page.evaluate(() => window.cwm.setViewMode('terminal'));

    // Appearance choices are conceptual aliases while legacy IDs continue to
    // power CSS and terminal palettes.
    const lightTheme = await page.evaluate(() => {
      window.cwm.setTheme('myrlin-light');
      return {
        choice: document.documentElement.dataset.themeChoice,
        resolved: document.documentElement.dataset.theme,
        stored: localStorage.getItem('cwm_theme'),
        meta: document.querySelector('meta[name="theme-color"]').content,
      };
    });
    assert.strictEqual(lightTheme.choice, 'myrlin-light');
    assert.strictEqual(lightTheme.resolved, 'latte');
    assert.strictEqual(lightTheme.stored, 'latte');
    assert.ok(lightTheme.meta, 'theme-color metadata must track the resolved theme');
    await page.waitForTimeout(400);
    await page.screenshot({ path: LIGHT_SCREENSHOT_PATH, fullPage: true });

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.evaluate(() => window.cwm.setTheme('system'));
    await page.waitForTimeout(100);
    const tabletLayout = await page.evaluate(() => ({
      shell: document.documentElement.dataset.uiShell,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      headerHeight: Math.round(document.querySelector('.app-header').getBoundingClientRect().height),
    }));
    assert.deepStrictEqual(
      tabletLayout,
      // SE-16, the same 58 to 44 retarget as the desktop assertion above: one
      // token drives both, so both move together or neither does.
      { shell: 'focused', overflow: false, headerHeight: 44 },
      'tablet shell must remain compact and overflow-free'
    );
    await page.screenshot({ path: TABLET_SCREENSHOT_PATH, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.cwm.setViewMode('terminal'));
    await page.waitForTimeout(150);
    const mobileLayout = await page.evaluate(() => {
      const visible = (element) => !!element && getComputedStyle(element).display !== 'none';
      return {
        // SE-16: the label SPAN rather than the tab's textContent, because
        // the Attention tab now also contains a count badge and a naive
        // textContent read would compare "Attention 0" against "Attention".
        tabs: Array.from(document.querySelectorAll('#mobile-tab-bar .mobile-tab'))
          .filter(visible)
          .map(tab => {
            const label = tab.querySelector('span:not(.mobile-tab-badge)');
            return (label ? label.textContent : tab.textContent).trim();
          }),
        emptyPaneVisible: visible(document.getElementById('term-pane-0')),
        emptyStateVisible: visible(document.getElementById('workbench-empty-state')),
        emptyToolbarVisible: visible(document.querySelector('#term-pane-0 .terminal-mobile-toolbar')),
        startHeight: Math.round(document.getElementById('workbench-start-btn').getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    // SANCTIONED TEST EDIT SE-16 (BUILD-CONTRACT 5.4), the IA half.
    // MOBILE-EXPERIENCE A.2 and DESIGN-SPEC 14.1 replace the four-tab bar
    // with five destinations: the More TAB is dissolved into Home > Workspace
    // and per-surface overflow sheets, and Tasks moves to a Home row. This is
    // the same retarget A.6 row 1 prescribes for focused-shell.test.js, which
    // P10 already took as SE-8; this browser lane carried a second copy of
    // the same expectation and was missed.
    assert.deepStrictEqual(
      mobileLayout.tabs,
      ['Home', 'Sessions', 'Terminal', 'Attention', 'Search'],
      'mobile hierarchy must be the five-tab Notion IA'
    );
    assert.strictEqual(mobileLayout.emptyPaneVisible, true, 'empty mobile Workbench must not be blank');
    assert.strictEqual(mobileLayout.emptyStateVisible, true, 'mobile start state must be visible');
    assert.strictEqual(mobileLayout.emptyToolbarVisible, false, 'terminal controls must wait for a live session');
    assert.ok(mobileLayout.startHeight >= 44, 'mobile primary target must be at least 44px tall');
    assert.strictEqual(mobileLayout.overflow, false, 'mobile shell must not overflow horizontally');

    const mobileHoleLayout = await page.evaluate(() => {
      const prior = window.cwm.terminalPanes[1];
      window.cwm.terminalPanes[1] = { safeFit() {} };
      window.cwm.updateTerminalGridLayout();
      const slotZero = document.getElementById('term-pane-0');
      const result = {
        hidden: slotZero.hidden,
        display: getComputedStyle(slotZero).display,
      };
      window.cwm.terminalPanes[1] = prior;
      window.cwm.updateTerminalGridLayout();
      return result;
    });
    assert.deepStrictEqual(
      mobileHoleLayout,
      { hidden: true, display: 'none' },
      'an occupied later slot must not resurrect the hidden slot-zero empty state'
    );
    await page.screenshot({ path: MOBILE_SCREENSHOT_PATH, fullPage: true });

    // SANCTIONED TEST EDIT SE-16 (BUILD-CONTRACT 5.4), the routing half.
    //
    // WHAT THIS BLOCK USED TO ASSERT, AND WHY IT CANNOT ANY MORE.
    // `#mobile-more-tab` was one of four BOTTOM TABS and its sheet was the
    // only route to fourteen features. MOBILE-EXPERIENCE A.2 dissolves that
    // tab: every one of the fourteen now has its own row on Home > Workspace
    // or its own destination, and the id survives on the "All commands" row
    // at the foot of that section (DECISIONS 15.4.1 explains why the id had
    // to survive at all: gate G1 permits additions only).
    //
    // The block is REWRITTEN to the new contract rather than deleted, and it
    // now proves three things the old one could not:
    //   1. System resources is reached from its OWN Home row, not from a
    //      sheet, which is the "zero orphans" claim made concrete.
    //   2. Home stays the selected bottom destination while a Home
    //      destination is showing, which is what `isMoreDestination` used to
    //      do for the More tab and what HOME_DESTINATION_MODES does now.
    //   3. The full command catalogue is still reachable, from the row that
    //      inherited the id, because code preservation keeps `showMoreMenu`
    //      and its four pinned labels alive for the classic shell (SE-9).
    const actionSheet = page.locator('#action-sheet-overlay');

    // (1) Home > Workspace > System resources, by its own route marker.
    await page.evaluate(() => window.cwm.setViewMode('home'));
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'home');
    await page.locator('#mobile-home-body [data-mw-route="resources"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'resources');
    const mobileHomeDestination = await page.evaluate(() => {
      const homeTab = document.querySelector('#mobile-tab-bar .mobile-tab[data-view="home"]');
      return {
        homeActive: homeTab.classList.contains('active'),
        homeCurrent: homeTab.getAttribute('aria-current'),
        terminalHidden: document.getElementById('terminal-grid').hidden,
        terminalDisplay: getComputedStyle(document.getElementById('terminal-grid')).display,
        resourcesVisible: getComputedStyle(document.getElementById('resources-panel')).display !== 'none',
      };
    });
    assert.deepStrictEqual(mobileHomeDestination, {
      homeActive: true,
      homeCurrent: 'page',
      terminalHidden: true,
      terminalDisplay: 'none',
      resourcesVisible: true,
    }, 'a Home destination keeps Home selected and never leaks the terminal layout');

    // (2) The All-commands row still opens the full catalogue, and the sheet
    //     still focuses its first command.
    await page.evaluate(() => window.cwm.setViewMode('home'));
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'home');
    const allCommands = page.locator('#mobile-more-tab');
    assert.strictEqual(
      (await allCommands.getAttribute('data-mw-route')),
      'more-menu',
      'the dissolved More tab survives as the All-commands ROW, not as a tab'
    );
    assert.strictEqual(
      await page.evaluate(() => !!document.querySelector('#mobile-tab-bar #mobile-more-tab')),
      false,
      'and it is no longer inside the bottom tab bar'
    );
    await allCommands.click();
    await actionSheet.waitFor({ state: 'visible' });
    assert.strictEqual(await page.locator('#action-sheet').getAttribute('role'), 'dialog');
    await page.waitForFunction(() =>
      document.activeElement?.matches('.action-sheet-item:not([disabled])')
    );
    assert.strictEqual(
      await page.evaluate(() =>
        document.activeElement?.querySelector('.as-label')?.textContent?.trim() || ''
      ),
      'Session attention',
      'the command catalogue must focus its first command'
    );

    // (3) Appearance is still reachable from that catalogue on a phone. The
    //     standalone dialog stays wired for the desktop (A.3.6), which is
    //     what the rest of this block exercises.
    await page.locator('#action-sheet-items .action-sheet-item', { hasText: 'Appearance' }).click();
    await actionSheet.waitFor({ state: 'hidden' });
    const appearanceOverlay = page.locator('#appearance-overlay');
    await appearanceOverlay.waitFor({ state: 'visible' });
    const appearanceDialog = await page.evaluate(() => ({
      title: document.getElementById('appearance-title').textContent.trim(),
      densityChoices: Array.from(document.querySelectorAll('[data-density-choice]'))
        .map(button => ({
          id: button.dataset.densityChoice,
          label: button.querySelector('.density-choice-label')?.textContent.trim(),
          pressed: button.getAttribute('aria-pressed'),
        })),
      featuredChoices: Array.from(
        document.querySelectorAll('.theme-gallery-featured [data-theme-choice]')
      ).map(button => ({
        id: button.dataset.themeChoice,
        label: button.querySelector('.theme-gallery-swatch + span')?.textContent.trim(),
        pressed: button.getAttribute('aria-pressed'),
      })),
      selected: document.querySelector(
        '#appearance-dialog [data-theme-choice][aria-pressed="true"]'
      )?.dataset.themeChoice,
      activeDensity: document.activeElement?.dataset.densityChoice || null,
    }));
    assert.deepStrictEqual(appearanceDialog, {
      title: 'Appearance',
      densityChoices: [
        { id: 'quiet', label: 'Quiet', pressed: 'true' },
        { id: 'informative', label: 'Informative', pressed: 'false' },
      ],
      featuredChoices: [
        { id: 'system', label: 'System', pressed: 'true' },
        { id: 'myrlin-dark', label: 'Myrlin Dark', pressed: 'false' },
        { id: 'myrlin-light', label: 'Myrlin Light', pressed: 'false' },
      ],
      selected: 'system',
      activeDensity: 'quiet',
    });
    await page.keyboard.press('Escape');
    await appearanceOverlay.waitFor({ state: 'hidden' });
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.id),
      'mobile-more-tab',
      // SE-16: the id is unchanged, so the focus-return contract is
      // unchanged; what moved is where that id LIVES. It is now the
      // All-commands row on Home > Workspace rather than a bottom tab.
      'closing mobile Appearance must restore focus to the row that opened it'
    );
    await page.evaluate(() => window.cwm.setViewMode('terminal'));

    // The legacy desktop tab density remains available without a separate
    // build or route tree; streamlined labels/mobile navigation stay shared.
    const classicPage = await context.newPage();
    classicPage.on('pageerror', (error) => pageErrors.push('classic: ' + error.message));
    const origin = new URL(page.url()).origin;
    await classicPage.goto(origin + '/?ui=classic', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await classicPage.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    const classicShell = await classicPage.evaluate(() => ({
      mode: document.documentElement.dataset.uiShell,
      visibleTabs: Array.from(document.querySelectorAll('.view-tab'))
        .filter(tab => getComputedStyle(tab).display !== 'none').length,
      focusedMoreVisible: getComputedStyle(document.getElementById('focused-more-btn')).display !== 'none',
    }));
    assert.deepStrictEqual(
      classicShell,
      { mode: 'classic', visibleTabs: 7, focusedMoreVisible: false },
      '?ui=classic must restore the legacy desktop tab density'
    );
    await classicPage.reload({ waitUntil: 'domcontentloaded' });
    await classicPage.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    assert.strictEqual(
      await classicPage.evaluate(() => document.documentElement.dataset.uiShell),
      'classic',
      'classic density query must survive reloads'
    );
    await classicPage.close();

    // Exercise explicit terminal Copy through the complete Workbook shell:
    // real xterm selection, production pane contextmenu capture, production
    // #context-menu renderer, and the real menu-item click ordering. The
    // isolated terminal never connects to a provider process.
    //
    // Chromium/WebView builds can report document.execCommand('copy') === true
    // without changing the platform clipboard. That return value is therefore
    // only a legacy attempt, not proof of success. Keep a working modern
    // writeText path available and delay its promise so the assertions can
    // prove the success toast waits for a real write.
    const clipboardGuard = await startClipboardGuard();
    let copyInstrumentationInstalled = false;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const copyMarker =
        'FULL_SHELL_COPY_TARGET_' + process.pid + '_' + Date.now();
      const copySentinel =
        'FULL_SHELL_COPY_SENTINEL_' + process.pid + '_' + Date.now();

      const copyGeometry = await page.evaluate(async (marker) => {
        window.cwm.setViewMode('terminal');
        if (window.cwm.els.toastContainer) {
          window.cwm.els.toastContainer.replaceChildren();
        }

        const originalConnect = TerminalPane.prototype.connect;
        TerminalPane.prototype.connect = function hermeticCopyConnect() {
          this.connected = true;
        };
        try {
          window.cwm.openTerminalInPane(
            0,
            'full-shell-copy-fixture',
            'Copy regression',
            { provider: 'claude' }
          );
          await new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const poll = () => {
              const pane = window.cwm.terminalPanes[0];
              // mount() opens xterm before its double-rAF invokes connect().
              // Keep the prototype stub installed until that deferred call has
              // actually run; restoring it at element creation would let the
              // fixture connect to the shell server and wipe the test buffer.
              if (pane && pane.term && pane.term.element && pane.connected) {
                resolve();
                return;
              }
              if (Date.now() >= deadline) {
                reject(new Error('hermetic terminal did not mount'));
                return;
              }
              requestAnimationFrame(poll);
            };
            poll();
          });
        } finally {
          TerminalPane.prototype.connect = originalConnect;
        }

        const pane = window.cwm.terminalPanes[0];
        window.__fullShellCopyPane = pane;
        await new Promise((resolve) => pane.term.write('\r\n' + marker, resolve));
        await new Promise((resolve) => setTimeout(resolve, 50));

        const buffer = pane.term.buffer.active;
        let row = -1;
        let column = -1;
        const lastRow = buffer.baseY + pane.term.rows;
        for (let index = 0; index < lastRow; index++) {
          const line = buffer.getLine(index);
          const text = line ? line.translateToString(true) : '';
          const markerColumn = text.indexOf(marker);
          if (markerColumn !== -1) {
            row = index;
            column = markerColumn;
            break;
          }
        }
        if (row < 0 || column < 0) {
          throw new Error('copy marker was not rendered into xterm');
        }

        pane.term.select(column, row, marker.length);
        pane.focus();
        const selection = pane.getCopySelection();
        const screen = pane.term.element.querySelector('.xterm-screen');
        const rect = screen.getBoundingClientRect();
        const cellWidth = rect.width / pane.term.cols;
        const cellHeight = rect.height / pane.term.rows;
        return {
          x: rect.left + cellWidth * (column + marker.length / 2),
          y: rect.top + cellHeight * (row - buffer.viewportY + 0.5),
          selection,
          selectionPosition: pane.term.getSelectionPosition(),
          activeClass: document.activeElement && document.activeElement.className,
          directBodyTextareas: document.querySelectorAll(':scope > body > textarea').length,
        };
      }, copyMarker);

      assert.deepStrictEqual(
        {
          hasSelection: copyGeometry.selection.hasSelection,
          text: copyGeometry.selection.text,
          source: copyGeometry.selection.source,
        },
        { hasSelection: true, text: copyMarker, source: 'xterm' },
        'full-shell copy regression must begin with the exact highlighted xterm text'
      );
      assert.strictEqual(
        copyGeometry.activeClass,
        'xterm-helper-textarea',
        'the highlighted terminal must own keyboard focus before right-click'
      );

      await page.evaluate(async ({ marker, sentinel }) => {
        const nativeClipboard = navigator.clipboard;
        await nativeClipboard.writeText(sentinel);
        const state = {
          marker,
          sentinel,
          nativeClipboard,
          navigatorClipboardDescriptor:
            Object.getOwnPropertyDescriptor(navigator, 'clipboard') || null,
          documentExecDescriptor:
            Object.getOwnPropertyDescriptor(document, 'execCommand') || null,
          nativeExecCommand: document.execCommand,
          execCalls: [],
          writeCalls: [],
          nativeWriteSettled: false,
          releaseWrite: null,
          released: false,
          copyEvents: [],
        };
        state.copyListener = (event) => {
          state.copyEvents.push({
            trusted: event.isTrusted,
            targetTag: event.target && event.target.tagName,
            defaultPrevented: event.defaultPrevented,
          });
        };
        document.addEventListener('copy', state.copyListener, true);

        document.execCommand = function truthyNoOpExecCommand(command) {
          if (String(command).toLowerCase() !== 'copy') {
            return state.nativeExecCommand.apply(document, arguments);
          }
          const active = document.activeElement;
          state.execCalls.push({
            activeTag: active && active.tagName,
            value: active && typeof active.value === 'string' ? active.value : null,
            selectionStart:
              active && typeof active.selectionStart === 'number'
                ? active.selectionStart
                : null,
            selectionEnd:
              active && typeof active.selectionEnd === 'number'
                ? active.selectionEnd
                : null,
            directBodyTextareas:
              document.querySelectorAll(':scope > body > textarea').length,
          });
          // Deliberately return true without dispatching a copy event or
          // changing the platform clipboard.
          return true;
        };

        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            readText: nativeClipboard.readText.bind(nativeClipboard),
            writeText(value) {
              const text = String(value);
              state.writeCalls.push(text);
              return nativeClipboard.writeText(text).then(() => {
                state.nativeWriteSettled = true;
                return new Promise((resolve) => {
                  state.releaseWrite = () => {
                    state.released = true;
                    resolve();
                  };
                });
              });
            },
          },
        });
        window.__fullShellCopyQa = state;
      }, { marker: copyMarker, sentinel: copySentinel });
      copyInstrumentationInstalled = true;

      assert.strictEqual(
        await page.evaluate(() =>
          window.__fullShellCopyQa.nativeClipboard.readText()
        ),
        copySentinel,
        'copy regression must seed a distinct clipboard sentinel'
      );

      await page.mouse.click(copyGeometry.x, copyGeometry.y, { button: 'right' });
      const productionContextMenu = page.locator('#context-menu');
      await productionContextMenu.waitFor({ state: 'visible' });
      const productionCopyItem =
        page.locator('#context-menu-items [data-action="Copy"]');
      assert.strictEqual(
        await productionCopyItem.count(),
        1,
        'production terminal context menu must expose Copy for highlighted text'
      );
      await productionCopyItem.click();

      await page.waitForFunction(() => {
        const state = window.__fullShellCopyQa;
        return state && state.execCalls.length === 1 &&
          state.writeCalls.length === 1 &&
          state.nativeWriteSettled &&
          typeof state.releaseWrite === 'function';
      }, null, { timeout: 5000 });

      const pendingCopy = await page.evaluate(() => {
        const state = window.__fullShellCopyQa;
        return {
          execCalls: state.execCalls,
          writeCalls: state.writeCalls,
          copyEvents: state.copyEvents,
          released: state.released,
          menuHidden: document.getElementById('context-menu').hidden,
          successToasts: Array.from(
            document.querySelectorAll('#toast-container .toast-success .toast-message')
          ).map((element) => element.textContent.trim()),
          errorToasts: Array.from(
            document.querySelectorAll('#toast-container .toast-error .toast-message')
          ).map((element) => element.textContent.trim()),
          directBodyTextareas:
            document.querySelectorAll(':scope > body > textarea').length,
        };
      });
      assert.deepStrictEqual(
        pendingCopy.execCalls,
        [{
          activeTag: 'TEXTAREA',
          value: copyMarker,
          selectionStart: 0,
          selectionEnd: copyMarker.length,
          directBodyTextareas: copyGeometry.directBodyTextareas + 1,
        }],
        'legacy attempt must select the exact scratch textarea payload once'
      );
      assert.deepStrictEqual(
        pendingCopy.writeCalls,
        [copyMarker],
        'truthy legacy result must not suppress the authoritative modern write'
      );
      assert.deepStrictEqual(
        pendingCopy.copyEvents,
        [],
        'truthy no-op execCommand must not manufacture a native copy event'
      );
      assert.strictEqual(
        pendingCopy.released,
        false,
        'modern write must remain pending until the test releases it'
      );
      assert.strictEqual(
        pendingCopy.menuHidden,
        true,
        'production renderer must close the menu after Copy is activated'
      );
      assert.deepStrictEqual(
        pendingCopy.successToasts,
        [],
        'success toast must wait for the authoritative clipboard write'
      );
      assert.deepStrictEqual(
        pendingCopy.errorToasts,
        [],
        'a pending clipboard write must not show a false failure'
      );
      assert.strictEqual(
        pendingCopy.directBodyTextareas,
        copyGeometry.directBodyTextareas,
        'temporary copy textarea must be removed before the async write settles'
      );

      // Focus and the contextmenu-time selection must be restored immediately,
      // not after a slow Clipboard API promise. Otherwise Ctrl+C is stranded on
      // <body> for the entire permission prompt.
      const pendingOwner = await page.evaluate(() => {
        const pane = window.__fullShellCopyPane;
        return {
          activeClass: document.activeElement && document.activeElement.className,
          selection: pane.getCopySelection(),
        };
      });
      assert.strictEqual(
        pendingOwner.activeClass,
        'xterm-helper-textarea',
        'Copy must return focus to xterm before the modern write settles'
      );
      assert.strictEqual(
        pendingOwner.selection.text,
        copyMarker,
        'Copy must restore the exact selection before the modern write settles'
      );

      const pendingCtrlCSentinel =
        'FULL_SHELL_PENDING_CTRL_C_' + process.pid + '_' + Date.now();
      await page.evaluate(
        ({ sentinel }) =>
          window.__fullShellCopyQa.nativeClipboard.writeText(sentinel),
        { sentinel: pendingCtrlCSentinel }
      );
      await page.keyboard.press('Control+c');
      await page.waitForFunction(async (marker) => (
        await window.__fullShellCopyQa.nativeClipboard.readText()
      ) === marker, copyMarker);
      assert.deepStrictEqual(
        await page.evaluate(async () => ({
          clipboard: await window.__fullShellCopyQa.nativeClipboard.readText(),
          selection: window.__fullShellCopyPane.getCopySelection().text,
          modernWriteCalls: window.__fullShellCopyQa.writeCalls.slice(),
        })),
        {
          clipboard: copyMarker,
          selection: copyMarker,
          modernWriteCalls: [copyMarker],
        },
        'Ctrl+C must work immediately while the explicit write promise is still pending'
      );

      // A user can create another selection while a permission prompt is open.
      // Promise settlement must not restore the stale contextmenu snapshot over
      // that newer selection.
      const newerSelection = await page.evaluate((marker) => {
        const pane = window.__fullShellCopyPane;
        const position = pane.term.getSelectionPosition();
        const length = Math.max(1, Math.floor(marker.length / 2));
        pane.term.select(position.start.x, position.start.y, length);
        return pane.getCopySelection().text;
      }, copyMarker);
      assert.ok(
        newerSelection && newerSelection !== copyMarker,
        'the pending-write race must install a distinct newer selection'
      );

      await page.evaluate(() => window.__fullShellCopyQa.releaseWrite());
      await page.waitForFunction(() => (
        Array.from(
          document.querySelectorAll('#toast-container .toast-success .toast-message')
        ).some((element) => element.textContent.trim() === 'Copied to clipboard')
      ));

      const completedCopy = await page.evaluate(async () => {
        const pane = window.__fullShellCopyPane;
        return {
          clipboard: await window.__fullShellCopyQa.nativeClipboard.readText(),
          successToasts: Array.from(
            document.querySelectorAll('#toast-container .toast-success .toast-message')
          ).map((element) => element.textContent.trim()),
          errorToasts: Array.from(
            document.querySelectorAll('#toast-container .toast-error .toast-message')
          ).map((element) => element.textContent.trim()),
          menuHidden: document.getElementById('context-menu').hidden,
          activeClass: document.activeElement && document.activeElement.className,
          selection: pane.getCopySelection(),
          selectionPosition: pane.term.getSelectionPosition(),
          directBodyTextareas:
            document.querySelectorAll(':scope > body > textarea').length,
        };
      });
      assert.strictEqual(
        completedCopy.clipboard,
        copyMarker,
        'production right-click Copy must replace the sentinel with exact text'
      );
      assert.deepStrictEqual(
        completedCopy.successToasts,
        ['Copied to clipboard'],
        'successful copy must produce exactly one truthful success toast'
      );
      assert.deepStrictEqual(
        completedCopy.errorToasts,
        [],
        'successful copy must not also report a failure'
      );
      assert.strictEqual(completedCopy.menuHidden, true);
      assert.strictEqual(
        completedCopy.activeClass,
        'xterm-helper-textarea',
        'Copy must return focus to the owning terminal'
      );
      assert.strictEqual(
        completedCopy.selection.text,
        newerSelection,
        'clipboard settlement must preserve the newer highlighted text: ' +
          JSON.stringify({
            initial: copyGeometry.selectionPosition,
            completed: completedCopy.selectionPosition,
          })
      );
      assert.strictEqual(
        completedCopy.directBodyTextareas,
        copyGeometry.directBodyTextareas,
        'completed copy must leave no scratch textarea behind'
      );

      // The context-menu button must not strand focus on <body>. Seed another
      // sentinel, press the real keyboard shortcut without re-focusing xterm,
      // and prove the retained selection uses Chromium's trusted native copy
      // path rather than calling the explicit helper a second time.
      const postMenuCtrlCSentinel =
        'FULL_SHELL_POST_MENU_CTRL_C_' + process.pid + '_' + Date.now();
      await page.evaluate(
        ({ sentinel }) =>
          window.__fullShellCopyQa.nativeClipboard.writeText(sentinel),
        { sentinel: postMenuCtrlCSentinel }
      );
      await page.keyboard.press('Control+c');
      await page.waitForFunction(async (marker) => (
        await window.__fullShellCopyQa.nativeClipboard.readText()
      ) === marker, newerSelection);
      const postMenuCtrlC = await page.evaluate(async () => {
        const pane = window.cwm.terminalPanes[0];
        return {
          clipboard: await window.__fullShellCopyQa.nativeClipboard.readText(),
          selection: pane.getCopySelection(),
          modernWriteCalls: window.__fullShellCopyQa.writeCalls.slice(),
        };
      });
      assert.strictEqual(
        postMenuCtrlC.clipboard,
        newerSelection,
        'Ctrl+C after settlement must copy the newer retained selection'
      );
      assert.strictEqual(
        postMenuCtrlC.selection.text,
        newerSelection,
        'native Ctrl+C must leave the xterm selection visible'
      );
      assert.deepStrictEqual(
        postMenuCtrlC.modernWriteCalls,
        [copyMarker],
        'keyboard Ctrl+C must not re-enter the explicit async clipboard helper'
      );
    } finally {
      try {
        if (copyInstrumentationInstalled) {
          await page.evaluate(() => {
            const state = window.__fullShellCopyQa;
            if (!state) return;
            document.removeEventListener('copy', state.copyListener, true);
            if (state.documentExecDescriptor) {
              Object.defineProperty(
                document,
                'execCommand',
                state.documentExecDescriptor
              );
            } else {
              delete document.execCommand;
            }
            if (state.navigatorClipboardDescriptor) {
              Object.defineProperty(
                navigator,
                'clipboard',
                state.navigatorClipboardDescriptor
              );
            } else {
              delete navigator.clipboard;
            }
            delete window.__fullShellCopyQa;
            delete window.__fullShellCopyPane;
          });
        }
      } finally {
        await stopClipboardGuard(clipboardGuard);
      }
    }

    assert.deepStrictEqual(pageErrors, [], 'full Workbook page raised browser errors');
    const unexpectedExternalRequests = blockedExternalRequests.filter((requestUrl) => (
      !requestUrl.startsWith('https://fonts.googleapis.com/') &&
      !requestUrl.startsWith('https://fonts.gstatic.com/')
    ));
    assert.deepStrictEqual(
      unexpectedExternalRequests,
      [],
      'full Workbook attempted an unexpected external browser request'
    );

    console.log('PASS full Workbook shell acceptance');
    console.log('  One-use startup auth succeeded and token was removed from the URL');
    console.log('  Focused desktop, tablet, mobile, light, and classic-density layouts rendered');
    console.log('  Secondary views routed through More; preview task tabs remained gated');
    console.log('  External browser traffic was blocked; Git fetch and tunnel probes stayed inert');
    console.log('  No real profile, credential, session, or provider state was used');
    console.log('  Screenshots: ' + [
      SCREENSHOT_PATH,
      LIGHT_SCREENSHOT_PATH,
      TABLET_SCREENSHOT_PATH,
      MOBILE_SCREENSHOT_PATH,
    ].join(', '));
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      let workbookStopped = !child;
      try {
        await stopWorkbook(child);
        workbookStopped = true;
      } finally {
        try {
          assert.deepStrictEqual(
            metadataFingerprint(FETCH_HEAD_PATH),
            fetchHeadBefore,
            'hermetic full-shell test changed .git/FETCH_HEAD'
          );
          assert.deepStrictEqual(
            metadataFingerprint(LEGACY_CONFIG_PATH),
            legacyConfigBefore,
            'hermetic full-shell test touched the clone-local legacy config'
          );
        } finally {
          if (workbookStopped || child.exitCode !== null || child.signalCode !== null) {
            removeSandbox(sandbox);
          }
        }
      }
    }
  }
}

run().catch((error) => {
  console.error('FAIL full Workbook shell acceptance');
  console.error(redactToken(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
