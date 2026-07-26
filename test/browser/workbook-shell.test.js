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
const SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-e2e.png');
const LIGHT_SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-focused-light.png');
const MOBILE_SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-focused-mobile.png');
const TABLET_SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'workbook-shell-focused-tablet.png');
const TEMP_PREFIX = 'myrlin-workbook-shell-';
const FETCH_HEAD_PATH = path.join(PROJECT_ROOT, '.git', 'FETCH_HEAD');
const LEGACY_CONFIG_PATH = path.join(PROJECT_ROOT, 'state', 'config.json');

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
    assert.match(shell.terminalScript, /^terminal\.js\?v=20260725-copymode2-/);
    assert.match(shell.appScript, /^app\.js\?v=20260725-copytruth-/);
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
    assert.strictEqual(hermeticState.version.body.version, '1.3.0-alpha.2');
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
        previewTabsVisible: labels('.tasks-tab[data-shell-maturity="preview"]'),
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
    assert.deepStrictEqual(focusedDesktop.previewTabsVisible, [], 'Git/Files previews must not look finished');
    assert.strictEqual(focusedDesktop.headerHeight, 58, 'focused desktop header must stay compact');
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
      'Recent activity',
      'opening More from the keyboard must focus its first enabled command'
    );
    await page.keyboard.press('Tab');
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'Costs',
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
      'Recent activity',
      'Costs',
      'System resources',
      'Project notes (choose a project)',
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
      await page.locator('#context-menu-items [data-action="Project notes (choose a project)"]').isDisabled(),
      true,
      'Project notes must remain contextual until a project is selected'
    );
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
      { shell: 'focused', overflow: false, headerHeight: 58 },
      'tablet shell must remain compact and overflow-free'
    );
    await page.screenshot({ path: TABLET_SCREENSHOT_PATH, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.cwm.setViewMode('terminal'));
    await page.waitForTimeout(150);
    const mobileLayout = await page.evaluate(() => {
      const visible = (element) => !!element && getComputedStyle(element).display !== 'none';
      return {
        tabs: Array.from(document.querySelectorAll('#mobile-tab-bar .mobile-tab'))
          .filter(visible)
          .map(tab => tab.textContent.trim()),
        emptyPaneVisible: visible(document.getElementById('term-pane-0')),
        emptyStateVisible: visible(document.getElementById('workbench-empty-state')),
        emptyToolbarVisible: visible(document.querySelector('#term-pane-0 .terminal-mobile-toolbar')),
        startHeight: Math.round(document.getElementById('workbench-start-btn').getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.deepStrictEqual(
      mobileLayout.tabs,
      ['Sessions', 'Workbench', 'Tasks', 'More'],
      'mobile hierarchy must match the focused desktop hierarchy'
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

    // Drive the real mobile More and nested Appearance sheets. Routes reached
    // through More keep that bottom destination selected and never leak the
    // terminal flex layout into a secondary panel.
    await page.locator('#mobile-more-tab').click();
    const actionSheet = page.locator('#action-sheet-overlay');
    await actionSheet.waitFor({ state: 'visible' });
    assert.strictEqual(await page.locator('#action-sheet').getAttribute('role'), 'dialog');
    assert.strictEqual(
      await page.evaluate(() => Array.from(document.activeElement?.childNodes || [])
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join('')
        .trim()),
      'Recent activity',
      'mobile More must focus its first command'
    );
    await page.locator('#action-sheet-items .action-sheet-item', {
      hasText: 'System resources',
    }).click();
    await page.waitForFunction(() => document.documentElement.dataset.viewMode === 'resources');
    await actionSheet.waitFor({ state: 'hidden' });
    const mobileMoreDestination = await page.evaluate(() => ({
      moreActive: document.getElementById('mobile-more-tab').classList.contains('active'),
      moreCurrent: document.getElementById('mobile-more-tab').getAttribute('aria-current'),
      terminalHidden: document.getElementById('terminal-grid').hidden,
      terminalDisplay: getComputedStyle(document.getElementById('terminal-grid')).display,
      resourcesVisible: getComputedStyle(document.getElementById('resources-panel')).display !== 'none',
    }));
    assert.deepStrictEqual(mobileMoreDestination, {
      moreActive: true,
      moreCurrent: 'page',
      terminalHidden: true,
      terminalDisplay: 'none',
      resourcesVisible: true,
    });

    await page.locator('#mobile-more-tab').click();
    await actionSheet.waitFor({ state: 'visible' });
    await page.locator('#action-sheet-items .action-sheet-item', { hasText: 'Appearance' }).click();
    await page.waitForFunction(() => (
      document.getElementById('action-sheet-header').textContent === 'Appearance'
    ));
    const appearanceSheet = await page.evaluate(() => ({
      header: document.getElementById('action-sheet-header').textContent,
      first: Array.from(
        document.querySelector('#action-sheet-items .action-sheet-item')?.childNodes || []
      ).filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join('').trim(),
      active: Array.from(document.activeElement?.childNodes || [])
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join('').trim(),
      scrollTop: document.getElementById('action-sheet').scrollTop,
    }));
    assert.deepStrictEqual(appearanceSheet, {
      header: 'Appearance',
      first: 'System',
      active: 'System',
      scrollTop: 0,
    });
    await page.keyboard.press('Escape');
    await actionSheet.waitFor({ state: 'hidden' });
    assert.strictEqual(
      await page.evaluate(() => document.activeElement?.id),
      'mobile-more-tab',
      'closing a nested mobile sheet must restore focus to More'
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

    // Exercise the listener installed by the real CWMApp._bindEvents rather
    // than the lightweight terminal fixture's mirrored listener.
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('cwm:copy-unavailable', {
        bubbles: true,
        detail: { reason: 'failed', containerId: 'shell-proof', sessionId: 'shell-proof' },
      }));
    });
    const copyFailureToast = page.locator('#toast-container .toast-error .toast-message').last();
    await copyFailureToast.waitFor({ state: 'visible' });
    assert.strictEqual(
      await copyFailureToast.textContent(),
      'Copy was blocked by the browser. Selection kept.',
      'production app listener must render truthful Ctrl+C copy failure feedback'
    );
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
    console.log('  Production copy-failure event listener rendered the truthful error');
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
