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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    await page.goto(started.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
      urlHasToken: new URL(location.href).searchParams.has('token'),
      storedToken: !!localStorage.getItem('cwm_token'),
    }));

    assert.strictEqual(shell.title, "myrlin's workbook");
    assert.strictEqual(shell.loginHidden, true, 'startup token must reveal the application shell');
    assert.strictEqual(shell.appHidden, false, 'application shell must be visible after startup auth');
    assert.strictEqual(shell.terminalScript, 'terminal.js?v=20260725-copymode2');
    assert.strictEqual(shell.appScript, 'app.js?v=20260725-copytruth');
    assert.strictEqual(shell.terminalClass, 'function', 'production TerminalPane must load');
    assert.strictEqual(shell.selectInterceptor, 'function', 'Select-mode interceptor must be present');
    assert.strictEqual(shell.urlHasToken, false, 'startup token must be stripped from the address bar');
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

    await page.evaluate(() => window.cwm.setViewMode('terminal'));
    await page.waitForTimeout(250);
    assert.strictEqual(
      await page.locator('#terminal-grid').isVisible(),
      true,
      'terminal view must render inside the authenticated Workbook shell'
    );

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

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log('PASS full Workbook shell acceptance');
    console.log('  One-use startup auth succeeded and token was removed from the URL');
    console.log('  Application/terminal views rendered with versioned copy assets');
    console.log('  Production copy-failure event listener rendered the truthful error');
    console.log('  External browser traffic was blocked; Git fetch and tunnel probes stayed inert');
    console.log('  No real profile, credential, session, or provider state was used');
    console.log('  Screenshot: ' + SCREENSHOT_PATH);
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
