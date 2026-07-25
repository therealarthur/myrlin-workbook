#!/usr/bin/env node
/**
 * terminal-interaction.test.js — Real Chromium/xterm copy-paste acceptance.
 * Modified: 2026-07-25
 *
 * Starts the hermetic fixture server as a child, drives checked-in xterm and
 * production TerminalPane/CWMApp methods, then stops only that child.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(__dirname, 'terminal-interaction-server.js');
const CLIPBOARD_GUARD_PATH = path.join(__dirname, 'clipboard-guard.ps1');
const SCREENSHOT_PATH = path.join(PROJECT_ROOT, 'screenshots', 'terminal-copy-paste-e2e.png');

/**
 * Wait for a child to exit without confusing kill-request state with a
 * confirmed process exit.
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
 * Start the local fixture server and resolve its printed URL.
 * @returns {Promise<{child: import('child_process').ChildProcess, url: string}>}
 *   The owned child process and loopback URL.
 */
function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH, '0'], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let settled = false;
    let stderr = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopFixtureServer(child).then(
        () => reject(error),
        (cleanupError) => reject(new AggregateError([error, cleanupError], 'fixture startup and cleanup failed'))
      );
    };
    const timeout = setTimeout(() => {
      fail(new Error('fixture server did not report its URL'));
    }, 10000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('message', (message) => {
      if (!message || message.type !== 'ready' || typeof message.url !== 'string' || settled) return;
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
        fail(new Error('fixture server reported a non-loopback URL'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: message.url });
    });
    child.once('error', (error) => fail(error));
    child.on('exit', (code) => {
      if (settled) return;
      fail(new Error('fixture server exited ' + code + ': ' + stderr));
    });
  });
}

/**
 * Stop the exact fixture child created by this test.
 * @param {import('child_process').ChildProcess} child - Owned fixture process.
 * @returns {Promise<void>}
 */
async function stopFixtureServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const gracefulExit = waitForExit(child, 3000);
  try {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
  } catch (_) {}
  if (await gracefulExit) return;

  const forcedExit = waitForExit(child, 3000);
  try { child.kill('SIGKILL'); } catch (_) {}
  if (!(await forcedExit)) {
    throw new Error('owned fixture server did not exit after forced termination');
  }
}

/**
 * Snapshot every Windows clipboard format before Chromium mutates it.
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
 * Wait until the fixture page, terminal, app prototype, and WebSocket are live.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<void>}
 */
async function waitForFixture(page) {
  await page.waitForFunction(() => (
    window.__fixtureReady === true &&
    window.fixture &&
    window.fixture.pane &&
    window.fixture.pane.connected === true &&
    window.fixture.pane.term &&
    window.fixture.pane.term.modes.mouseTrackingMode === 'drag'
  ), null, { timeout: 15000 });
}

/**
 * Fetch a fresh input-state snapshot through the page.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<object>} Fixture input state.
 */
async function getState(page) {
  return page.evaluate(() => window.fixture.refreshState());
}

/**
 * Reset counters while preserving the terminal buffer and xterm selection.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<void>}
 */
async function resetState(page) {
  await page.evaluate(() => window.fixture.resetState());
}

/**
 * Compute stable cell-center coordinates from the real xterm screen geometry.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<{x1:number, x2:number, y:number, centerX:number, centerY:number}>}
 */
async function selectionGeometry(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('#fixture-terminal .xterm-screen');
    const rect = screen.getBoundingClientRect();
    const pane = window.fixture.pane;
    const cellWidth = rect.width / pane.term.cols;
    const cellHeight = rect.height / pane.term.rows;
    return {
      x1: rect.left + cellWidth * 0.6,
      x2: rect.left + cellWidth * 28.4,
      y: rect.top + cellHeight * 1.55,
      centerX: rect.left + cellWidth * 14,
      centerY: rect.top + cellHeight * 1.55,
    };
  });
}

/**
 * Drag across the fixture's copy-target row.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {boolean} withShift - Whether to hold Shift for xterm force-select.
 * @returns {Promise<void>}
 */
async function dragCopyTarget(page, withShift) {
  const geometry = await selectionGeometry(page);
  if (withShift) await page.keyboard.down('Shift');
  await page.mouse.move(geometry.x1, geometry.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(geometry.x2, geometry.y, { steps: 10 });
  await page.mouse.up({ button: 'left' });
  if (withShift) await page.keyboard.up('Shift');
  await page.waitForTimeout(100);
}

/**
 * Read selection text and selection presence from the production pane.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<{hasSelection:boolean, text:string}>}
 */
async function readSelection(page) {
  return page.evaluate(() => ({
    hasSelection: window.fixture.pane.term.hasSelection(),
    text: window.fixture.pane.term.getSelection(),
  }));
}

/**
 * Open the production terminal context-menu descriptors at the copy target.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<void>}
 */
async function openContextMenu(page) {
  const geometry = await selectionGeometry(page);
  await page.mouse.click(geometry.centerX, geometry.centerY, { button: 'right' });
  await page.locator('#fixture-context-menu').waitFor({ state: 'visible' });
}

/**
 * Wait for a fixture counter to equal an expected value.
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {string} key - State key.
 * @param {number} expected - Expected value.
 * @returns {Promise<void>}
 */
async function waitForCounter(page, key, expected) {
  await page.waitForFunction(
    ({ stateKey, value }) => window.__fixtureState && window.__fixtureState[stateKey] === value,
    { stateKey: key, value: expected },
    { timeout: 5000 }
  );
}

/**
 * Execute the full acceptance matrix in real Chromium.
 * @returns {Promise<void>}
 */
async function run() {
  assert.strictEqual(
    process.platform,
    'win32',
    'terminal browser acceptance requires Windows clipboard semantics'
  );
  let clipboardGuard = null;
  let child = null;
  let browser = null;
  try {
    clipboardGuard = await startClipboardGuard();
    const started = await startFixtureServer();
    child = started.child;
    const url = started.url;
    browser = await chromium.launch({
      headless: true,
      args: ['--host-resolver-rules=MAP insecure.test 127.0.0.1'],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForFixture(page);
    assert.strictEqual(
      await page.evaluate(() => navigator.platform.startsWith('Win')),
      true,
      'this acceptance run is intentionally Windows-specific'
    );

    // Mouse mode OFF path: plain drag belongs to the TUI and never creates an
    // xterm selection.
    await resetState(page);
    await dragCopyTarget(page, false);
    let selection = await readSelection(page);
    let state = await getState(page);
    assert.strictEqual(selection.hasSelection, false, 'plain drag must not select while Select mode is off');
    assert.ok(state.mouseEvents > 0, 'plain drag must reach the mouse-reporting TUI');

    // Native xterm force selection: Shift+drag selects and emits no PTY mouse
    // reports.
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    await resetState(page);
    await dragCopyTarget(page, true);
    selection = await readSelection(page);
    state = await getState(page);
    assert.strictEqual(selection.hasSelection, true, 'Shift+drag must create a real xterm selection');
    assert.ok(
      selection.text.includes('OPY_TARGET_ALPHA_BETA'),
      'Shift+drag selected the wrong terminal row: ' + JSON.stringify(selection.text)
    );
    assert.strictEqual(state.mouseEvents, 0, 'Shift+drag must not emit PTY mouse reports');

    // Selected Ctrl+C copies exactly once and never becomes SIGINT.
    const keyboardCopyText = selection.text;
    const beforeKeyboardCopy = await page.evaluate(() => ({
      selection: window.fixture.pane.term.getSelection(),
      activeClass: document.activeElement && document.activeElement.className,
    }));
    assert.strictEqual(
      beforeKeyboardCopy.activeClass,
      'xterm-helper-textarea',
      'Shift+drag must leave the xterm textarea focused: ' + JSON.stringify(beforeKeyboardCopy)
    );
    await resetState(page);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(300);
    const keyboardCopyDebug = await page.evaluate(() => ({
      attempts: window.__copyAttempts,
      selection: window.fixture.pane.term.getSelection(),
      activeClass: document.activeElement && document.activeElement.className,
      helperSource: TerminalPane.copyTextToClipboard.toString().slice(0, 160),
    }));
    assert.strictEqual(
      keyboardCopyDebug.attempts.length,
      1,
      'selected Ctrl+C did not reach the copy helper: ' + JSON.stringify(keyboardCopyDebug)
    );
    assert.notStrictEqual(keyboardCopyDebug.attempts[0].result, null);
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 0, 'selected Ctrl+C must not send ETX/SIGINT');
    assert.deepStrictEqual(
      await page.evaluate(() => window.__copyAttempts),
      [{ text: keyboardCopyText, result: true }],
      'selected Ctrl+C must attempt one successful copy with the exact selection'
    );
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), keyboardCopyText);
    assert.strictEqual(
      (await readSelection(page)).hasSelection,
      false,
      'a confirmed keyboard copy must clear the copied selection'
    );

    // Unselected Ctrl+C still reaches the PTY exactly once.
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    await page.keyboard.press('Control+c');
    await waitForCounter(page, 'sigintCount', 1);
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 1, 'unselected Ctrl+C must send one ETX/SIGINT');
    assert.strictEqual(await page.evaluate(() => window.__copyAttempts.length), 0);

    // Select mode converts a plain drag into a genuine selection, then turning
    // it off restores TUI mouse delivery.
    const selectModeButton = page.locator('.terminal-pane-selectmode');
    await selectModeButton.click();
    assert.strictEqual(await selectModeButton.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    await resetState(page);
    await dragCopyTarget(page, false);
    selection = await readSelection(page);
    state = await getState(page);
    assert.strictEqual(selection.hasSelection, true, 'Select mode plain drag must create a real selection');
    assert.ok(
      selection.text.includes('OPY_TARGET_ALPHA_BETA'),
      'Select mode selected the wrong terminal row: ' + JSON.stringify(selection.text)
    );
    assert.strictEqual(state.mouseEvents, 0, 'Select mode drag must not reach the TUI');
    await selectModeButton.click();
    assert.strictEqual(await selectModeButton.getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    await resetState(page);
    const geometry = await selectionGeometry(page);
    await page.mouse.click(geometry.centerX, geometry.centerY);
    await page.waitForFunction(() => window.__fixtureState && window.__fixtureState.leftPresses > 0);

    // Right-click over a genuine selection must neither report to the TUI nor
    // alter the text before the production Copy action reads it.
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    await dragCopyTarget(page, true);
    const rightClickSelection = (await readSelection(page)).text;
    await resetState(page);
    await openContextMenu(page);
    state = await getState(page);
    selection = await readSelection(page);
    assert.strictEqual(state.mouseEvents, 0, 'right-click on a selection must emit no PTY mouse event');
    assert.strictEqual(state.rightPresses, 0, 'right-click on a selection must not reach the TUI');
    assert.strictEqual(selection.text, rightClickSelection, 'right-click must preserve the exact selection');
    const copyItem = page.locator('#fixture-context-menu [data-label="Copy"]');
    assert.strictEqual(await copyItem.count(), 1, 'production terminal menu must expose Copy');
    await copyItem.click();
    await page.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result !== null);
    assert.deepStrictEqual(
      await page.evaluate(() => window.__copyAttempts),
      [{ text: rightClickSelection, result: true }]
    );
    assert.deepStrictEqual(
      await page.evaluate(() => window.__toast),
      { message: 'Copied to clipboard', level: 'success' }
    );
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), rightClickSelection);

    // Clipboard denial through selected Ctrl+C must still consume the key,
    // keep the recoverable selection, leave the native OS clipboard untouched,
    // and surface a truthful error.
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    const denialClipboardSentinel =
      'MYRLIN_DENIAL_SENTINEL_' + process.pid + '_' + Date.now();
    await page.evaluate(async (sentinel) => {
      const nativeClipboard = navigator.clipboard;
      await nativeClipboard.writeText(sentinel);
      window.__nativeClipboardForDenial = nativeClipboard;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });
      document.execCommand = () => false;
      window.fixture.pane.term.select(0, 1, 18);
    }, denialClipboardSentinel);
    const deniedKeyboardSelection = (await readSelection(page)).text;
    assert.ok(deniedKeyboardSelection, 'denial scenario must begin with a real xterm selection');
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result === false && window.__toast !== null);
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 0, 'failed selected Ctrl+C must never reach the PTY as SIGINT');
    assert.strictEqual(
      (await readSelection(page)).text,
      deniedKeyboardSelection,
      'failed selected Ctrl+C must preserve the exact selection'
    );
    assert.deepStrictEqual(
      await page.evaluate(() => window.__toast),
      { message: 'Copy was blocked by the browser. Selection kept.', level: 'error' }
    );
    assert.strictEqual(
      await page.evaluate(() => window.__nativeClipboardForDenial.readText()),
      denialClipboardSentinel,
      'failed selected Ctrl+C must prevent Chromium/xterm native copy from changing the OS clipboard'
    );

    // The production right-click wrapper must remain truthful under the same
    // denial and leave the selection available.
    await page.evaluate(() => {
      window.__copyAttempts.length = 0;
      window.__toast = null;
    });
    await openContextMenu(page);
    await page.locator('#fixture-context-menu [data-label="Copy"]').click();
    await page.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result === false);
    assert.deepStrictEqual(
      await page.evaluate(() => window.__toast),
      { message: 'Copy failed', level: 'error' }
    );
    assert.strictEqual((await readSelection(page)).text, deniedKeyboardSelection);
    await page.evaluate(() => {
      delete navigator.clipboard;
      delete window.__nativeClipboardForDenial;
    });

    // Reload to restore the native Clipboard API, then prove the secure
    // keyboard path and the same-target native fallback each emit once.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFixture(page);
    const securePaste = 'SECURE_PASTE_LINE_1\nSECURE_PASTE_LINE_2';
    await page.evaluate((text) => navigator.clipboard.writeText(text), securePaste);
    const secureClipboardText = await page.evaluate(() => navigator.clipboard.readText());
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    await page.keyboard.press('Control+v');
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(
      state.pastePayloads,
      [secureClipboardText],
      'secure Ctrl+V must paste the exact platform clipboard text once'
    );

    const secureMenuPaste = 'SECURE_CONTEXT_MENU_PASTE_ONCE';
    await page.evaluate((text) => navigator.clipboard.writeText(text), secureMenuPaste);
    await resetState(page);
    await openContextMenu(page);
    const securePasteItem = page.locator('#fixture-context-menu [data-label="Paste"]');
    assert.strictEqual(await securePasteItem.count(), 1, 'secure terminal menu must expose Paste');
    await securePasteItem.click();
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(
      state.pastePayloads,
      [secureMenuPaste],
      'secure context-menu Paste must send the clipboard text exactly once'
    );

    const nativePaste = 'NATIVE_INSECURE_FALLBACK_ONCE';
    await resetState(page);
    await page.evaluate((text) => window.fixture.dispatchNativePaste(text), nativePaste);
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(state.pastePayloads, [nativePaste], 'native paste must emit one bracketed frame');

    // Use a hostname that resolves to this exact loopback listener but is not
    // a potentially trustworthy origin. This exercises the real browser
    // Ctrl+V fallback with navigator.clipboard unavailable.
    const parsedUrl = new URL(url);
    const insecureUrl = 'http://insecure.test:' + parsedUrl.port + '/';
    const insecurePaste = 'REAL_INSECURE_ORIGIN_PASTE_ONCE';
    await page.evaluate((text) => navigator.clipboard.writeText(text), insecurePaste);
    const insecureClipboardText = await page.evaluate(() => navigator.clipboard.readText());
    const insecurePage = await context.newPage();
    await insecurePage.goto(insecureUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForFixture(insecurePage);
    const insecureCapabilities = await insecurePage.evaluate(() => ({
      secure: window.isSecureContext,
      clipboardRead: typeof (navigator.clipboard && navigator.clipboard.readText),
      hostname: location.hostname,
    }));
    assert.deepStrictEqual(insecureCapabilities, {
      secure: false,
      clipboardRead: 'undefined',
      hostname: 'insecure.test',
    });

    // The insecure context-menu path must not claim it pasted. It labels the
    // native fallback, emits no payload, explains Ctrl+V, and focuses xterm.
    await insecurePage.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(insecurePage);
    await openContextMenu(insecurePage);
    const insecurePasteItem = insecurePage.locator('#fixture-context-menu [data-label="Paste (Ctrl+V)"]');
    assert.strictEqual(await insecurePasteItem.count(), 1, 'insecure terminal menu must label the native fallback');
    await insecurePasteItem.click();
    state = await getState(insecurePage);
    assert.strictEqual(state.pasteCount, 0, 'insecure context-menu guidance must not claim or emit a paste');
    assert.deepStrictEqual(
      await insecurePage.evaluate(() => window.__toast),
      {
        message: 'Clipboard needs HTTPS or localhost. Press Ctrl+V (Cmd+V on Mac) to paste',
        level: 'info',
      }
    );
    assert.strictEqual(
      await insecurePage.evaluate(() => document.activeElement && document.activeElement.className),
      'xterm-helper-textarea',
      'insecure context-menu guidance must focus the terminal for native Ctrl+V'
    );
    await insecurePage.keyboard.press('Control+v');
    await waitForCounter(insecurePage, 'pasteCount', 1);
    state = await getState(insecurePage);
    assert.deepStrictEqual(
      state.pastePayloads,
      [insecureClipboardText],
      'real insecure-origin Ctrl+V must paste the platform clipboard text once'
    );

    // The insecure-origin right-click action must use execCommand successfully
    // during its real click gesture, and the secure page must be able to read
    // the exact resulting clipboard contents.
    await dragCopyTarget(insecurePage, true);
    const insecureCopyText = (await readSelection(insecurePage)).text;
    await resetState(insecurePage);
    await openContextMenu(insecurePage);
    await insecurePage.locator('#fixture-context-menu [data-label="Copy"]').click();
    await insecurePage.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result !== null);
    assert.deepStrictEqual(
      await insecurePage.evaluate(() => window.__copyAttempts),
      [{ text: insecureCopyText, result: true }],
      'insecure-origin Copy must succeed through the fallback exactly once'
    );
    assert.strictEqual(
      await page.evaluate(() => navigator.clipboard.readText()),
      insecureCopyText,
      'secure-origin verification must read the exact insecure fallback copy'
    );
    await insecurePage.close();

    // Alternate screen has no normal-buffer history. Returning to the normal
    // buffer with 140 lines restores ordinary xterm scrollback.
    await page.evaluate(() => window.fixture.setMode('alt'));
    await page.waitForTimeout(150);
    const altBuffer = await page.evaluate(() => ({
      type: window.fixture.pane.term.buffer.active.type,
      baseY: window.fixture.pane.term.buffer.active.baseY,
      viewportY: window.fixture.pane.term.buffer.active.viewportY,
    }));
    assert.deepStrictEqual(altBuffer, { type: 'alternate', baseY: 0, viewportY: 0 });
    await page.evaluate(() => window.fixture.setMode('normal'));
    await page.waitForFunction(() => window.fixture.pane.term.buffer.active.type === 'normal' &&
      window.fixture.pane.term.buffer.active.baseY > 0);
    const beforeWheel = await page.evaluate(() => {
      window.fixture.pane.term.scrollToBottom();
      return window.fixture.pane.term.buffer.active.viewportY;
    });
    const normalGeometry = await selectionGeometry(page);
    await page.mouse.move(normalGeometry.centerX, normalGeometry.centerY);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(250);
    const afterWheel = await page.evaluate(() => window.fixture.pane.term.buffer.active.viewportY);
    assert.ok(afterWheel < beforeWheel, 'normal-buffer wheel must move into scrollback');

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log('PASS terminal browser acceptance');
    console.log('  Shift+drag: real selection, zero PTY mouse reports');
    console.log('  Select mode: real selection; mode off restores TUI mouse events');
    console.log('  Ctrl+C: success clears; denial retains selection; neither sends SIGINT');
    console.log('  Clipboard: denial leaves native contents unchanged; original formats restored');
    console.log('  Right-click: preserved selection, zero TUI events, truthful copy toast');
    console.log('  Paste: secure key/menu and native fallback each sent exactly once');
    console.log('  Insecure origin: guided menu + native paste; execCommand copy verified');
    console.log('  Scroll: normal buffer scrolls; alternate-screen limitation confirmed');
    console.log('  Screenshot: ' + SCREENSHOT_PATH);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      try {
        await stopFixtureServer(child);
      } finally {
        await stopClipboardGuard(clipboardGuard);
      }
    }
  }
}

run().catch((error) => {
  console.error('FAIL terminal browser acceptance');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
