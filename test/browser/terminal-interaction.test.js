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
    window.fixture.pane.term.modes.mouseTrackingMode === 'any'
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
  // Positioning the pointer is a distinct zero-button 1003 hover. Reset after
  // that setup move so assertions below measure only the drag gesture itself.
  await page.mouse.move(geometry.x1, geometry.y);
  await resetState(page);
  if (withShift) await page.keyboard.down('Shift');
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

    // DECSET 1003 reports movement even when no mouse button is down. Prove
    // the fixture really exercises that mode before testing selected-hover
    // suppression later.
    await resetState(page);
    const hoverGeometry = await selectionGeometry(page);
    await page.mouse.move(hoverGeometry.x1, hoverGeometry.y + 28);
    await page.mouse.move(hoverGeometry.x2, hoverGeometry.y + 28, { steps: 8 });
    await page.waitForFunction(() => window.__fixtureState &&
      window.__fixtureState.hoverMoves > 0);
    state = await getState(page);
    assert.ok(state.hoverMoves > 0, 'unselected zero-button hover must reach the 1003 TUI');

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
    await page.waitForFunction(() => window.__nativeCopyEvents.length === 1);
    const keyboardCopyDebug = await page.evaluate(() => ({
      attempts: window.__copyAttempts,
      nativeEvents: window.__nativeCopyEvents,
      selection: window.fixture.pane.term.getSelection(),
      activeClass: document.activeElement && document.activeElement.className,
    }));
    assert.strictEqual(
      keyboardCopyDebug.attempts.length,
      0,
      'selected Ctrl+C must bypass the explicit-action helper: ' +
        JSON.stringify(keyboardCopyDebug)
    );
    assert.deepStrictEqual(
      keyboardCopyDebug.nativeEvents,
      [{ trusted: true, text: keyboardCopyText, defaultPrevented: true }],
      'selected Ctrl+C must dispatch one trusted xterm copy event'
    );
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 0, 'selected Ctrl+C must not send ETX/SIGINT');
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), keyboardCopyText);
    assert.strictEqual(
      (await readSelection(page)).text,
      keyboardCopyText,
      'native keyboard copy must retain the exact selection'
    );

    // Caps Lock can make KeyboardEvent.key uppercase without adding Shift.
    // Playwright does not emulate lock-state casing, so dispatch an uppercase
    // browser event to exercise xterm's real custom key handler. The trusted
    // clipboard result is covered by the lowercase physical shortcut above;
    // this case proves uppercase cannot leak ETX or invoke the async helper.
    const uppercaseCopyText = await page.evaluate(() => {
      const textarea = document.querySelector('#fixture-terminal .xterm-helper-textarea');
      window.__lastCopyShortcutKey = null;
      textarea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
          window.__lastCopyShortcutKey = event.key;
        }
      }, { capture: true });
      window.fixture.pane.term.select(0, 1, 18);
      return window.fixture.pane.term.getSelection();
    });
    assert.ok(uppercaseCopyText, 'uppercase Ctrl+C scenario must start with a real selection');
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    await page.evaluate(() => {
      const textarea = document.querySelector('#fixture-terminal .xterm-helper-textarea');
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'C',
        code: 'KeyC',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForTimeout(100);
    assert.strictEqual(
      await page.evaluate(() => window.__lastCopyShortcutKey),
      'C',
      'the browser fixture must deliver an uppercase KeyboardEvent.key'
    );
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 0, 'uppercase selected Ctrl+C must not send ETX/SIGINT');
    assert.strictEqual(await page.evaluate(() => window.__nativeCopyEvents.length), 0,
      'an untrusted synthetic key cannot claim a native clipboard result');
    assert.strictEqual(await page.evaluate(() => window.__copyAttempts.length), 0);
    assert.strictEqual((await readSelection(page)).text, uppercaseCopyText);

    // Unselected Ctrl+C still reaches the PTY exactly once.
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    await page.keyboard.press('Control+c');
    await waitForCounter(page, 'sigintCount', 1);
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 1, 'unselected Ctrl+C must send one ETX/SIGINT');
    assert.strictEqual(await page.evaluate(() => window.__copyAttempts.length), 0);
    assert.strictEqual(await page.evaluate(() => window.__nativeCopyEvents.length), 0);

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
    assert.strictEqual(
      await page.evaluate(() => window.__focusCalls),
      0,
      'an already-active Select-mode drag must not refocus/refit the pane'
    );
    const selectModeCopyText = selection.text;
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.__nativeCopyEvents.length === 1);
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), selectModeCopyText);
    assert.strictEqual((await readSelection(page)).text, selectModeCopyText);
    assert.strictEqual((await getState(page)).sigintCount, 0);
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
    const selectedHoverGeometry = await selectionGeometry(page);
    await page.mouse.move(
      selectedHoverGeometry.x2 + 40,
      selectedHoverGeometry.y + 25,
      { steps: 6 }
    );
    await page.waitForTimeout(100);
    state = await getState(page);
    assert.strictEqual(
      state.hoverMoves,
      0,
      'zero-button hover after selection must not reach a 1003 mouse-reporting TUI'
    );
    assert.strictEqual(
      (await readSelection(page)).text,
      rightClickSelection,
      'moving the pointer toward a right-click must preserve the exact selection'
    );
    await openContextMenu(page);
    state = await getState(page);
    selection = await readSelection(page);
    assert.strictEqual(state.mouseEvents, 0, 'right-click on a selection must emit no PTY mouse event');
    assert.strictEqual(state.rightPresses, 0, 'right-click on a selection must not reach the TUI');
    assert.strictEqual(
      await page.evaluate(() => window.__focusCalls),
      0,
      'selected right-click must skip the earlier pane refocus that clears xterm selection'
    );
    assert.strictEqual(selection.text, rightClickSelection, 'right-click must preserve the exact selection');
    const copyItem = page.locator('#fixture-context-menu [data-label="Copy"]');
    assert.strictEqual(await copyItem.count(), 1, 'production terminal menu must expose Copy');
    // The action must use the contextmenu-time snapshot, not re-read a live
    // selection that a later renderer/focus change may have cleared.
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    assert.strictEqual((await readSelection(page)).hasSelection, false);
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

    // execCommand's truthy result is advisory, not proof that the platform
    // clipboard changed. Reproduce the live embedded-browser failure by making
    // execCommand report true without dispatching a copy event or touching the
    // clipboard. The modern write must still run during the same click and
    // replace the sentinel with the exact contextmenu-time snapshot.
    await page.evaluate(() => window.fixture.pane.term.select(0, 1, 18));
    const truthyNoopSelection = (await readSelection(page)).text;
    assert.ok(truthyNoopSelection, 'truthy-no-op scenario must begin with a real xterm selection');
    await resetState(page);
    const truthyNoopSentinel =
      'MYRLIN_TRUTHY_NOOP_SENTINEL_' + process.pid + '_' + Date.now();
    await page.evaluate(async (sentinel) => {
      const nativeClipboard = navigator.clipboard;
      await nativeClipboard.writeText(sentinel);
      window.__nativeClipboardForTruthyNoop = nativeClipboard;
      window.__hadOwnExecCommandForTruthyNoop =
        Object.prototype.hasOwnProperty.call(document, 'execCommand');
      window.__nativeExecCommandForTruthyNoop = document.execCommand;
      window.__modernClipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => nativeClipboard.readText(),
          writeText: (value) => {
            window.__modernClipboardWrites.push(String(value));
            return nativeClipboard.writeText(value);
          },
        },
      });
      // The command claims success but is a deliberate no-op, matching the
      // false-positive observed in the live Workbook host.
      document.execCommand = () => true;
    }, truthyNoopSentinel);
    await openContextMenu(page);
    await page.locator('#fixture-context-menu [data-label="Copy"]').click();
    await page.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result !== null);
    assert.deepStrictEqual(
      await page.evaluate(() => window.__copyAttempts),
      [{ text: truthyNoopSelection, result: true }],
      'truthy execCommand must not short-circuit the modern clipboard write'
    );
    assert.deepStrictEqual(
      await page.evaluate(() => window.__modernClipboardWrites),
      [truthyNoopSelection],
      'modern writeText must receive the exact terminal selection once'
    );
    assert.strictEqual(
      await page.evaluate(() => window.__nativeClipboardForTruthyNoop.readText()),
      truthyNoopSelection,
      'modern writeText must replace the sentinel after a truthy no-op execCommand'
    );

    // Cross the two failure modes: the legacy command claims success but
    // dispatches no copy event, while the modern write is denied. Neither
    // unverified attempt may produce a success toast or replace the sentinel.
    await resetState(page);
    const dualFailureSentinel =
      'MYRLIN_DUAL_FAILURE_SENTINEL_' + process.pid + '_' + Date.now();
    await page.evaluate(async (sentinel) => {
      const nativeClipboard = window.__nativeClipboardForTruthyNoop;
      await nativeClipboard.writeText(sentinel);
      window.__dualFailureExecCalls = 0;
      window.__dualFailureWriteCalls = 0;
      document.execCommand = (command) => {
        if (String(command).toLowerCase() === 'copy') {
          window.__dualFailureExecCalls += 1;
          return true;
        }
        return false;
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => nativeClipboard.readText(),
          writeText: () => {
            window.__dualFailureWriteCalls += 1;
            return Promise.reject(new Error('denied'));
          },
        },
      });
      window.fixture.pane.term.select(0, 1, 18);
    }, dualFailureSentinel);
    const dualFailureSelection = (await readSelection(page)).text;
    assert.ok(dualFailureSelection, 'dual-failure scenario must retain a real selection');
    await openContextMenu(page);
    await page.locator('#fixture-context-menu [data-label="Copy"]').click();
    await page.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result === false);
    assert.deepStrictEqual(
      await page.evaluate(() => window.__toast),
      { message: 'Copy failed', level: 'error' },
      'dual failure must report an honest error'
    );
    assert.strictEqual(
      await page.evaluate(() => window.__nativeClipboardForTruthyNoop.readText()),
      dualFailureSentinel,
      'dual failure must leave the platform clipboard sentinel unchanged'
    );
    assert.strictEqual(await page.evaluate(() => window.__dualFailureWriteCalls), 1);
    assert.strictEqual(
      await page.evaluate(() => window.__dualFailureExecCalls),
      2,
      'modern denial may retry legacy once, but neither truthy no-op is verified'
    );
    await page.evaluate(() => {
      if (window.__hadOwnExecCommandForTruthyNoop) {
        document.execCommand = window.__nativeExecCommandForTruthyNoop;
      } else {
        delete document.execCommand;
      }
      delete navigator.clipboard;
      delete window.__nativeClipboardForTruthyNoop;
      delete window.__nativeExecCommandForTruthyNoop;
      delete window.__hadOwnExecCommandForTruthyNoop;
      delete window.__modernClipboardWrites;
      delete window.__dualFailureExecCalls;
      delete window.__dualFailureWriteCalls;
    });

    // Embedded browsers may expose navigator.clipboard while denying its
    // programmatic write. Keyboard copy must not touch that API: Chromium's
    // trusted copy event and xterm's synchronous clipboardData path still
    // succeed, retain selection, and never emit SIGINT.
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    const denialClipboardSentinel =
      'MYRLIN_DENIAL_SENTINEL_' + process.pid + '_' + Date.now();
    await page.evaluate(async (sentinel) => {
      const nativeClipboard = navigator.clipboard;
      await nativeClipboard.writeText(sentinel);
      window.__nativeClipboardForDenial = nativeClipboard;
      window.__clipboardWriteAttempts = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => {
            window.__clipboardWriteAttempts += 1;
            return Promise.reject(new Error('denied'));
          },
        },
      });
      window.fixture.pane.term.select(0, 1, 18);
    }, denialClipboardSentinel);
    const deniedKeyboardSelection = (await readSelection(page)).text;
    assert.ok(deniedKeyboardSelection, 'denial scenario must begin with a real xterm selection');
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.__nativeCopyEvents.length === 1);
    state = await getState(page);
    assert.strictEqual(state.sigintCount, 0, 'selected Ctrl+C must never reach the PTY as SIGINT');
    assert.strictEqual(
      (await readSelection(page)).text,
      deniedKeyboardSelection,
      'native selected Ctrl+C must preserve the exact selection'
    );
    assert.deepStrictEqual(
      await page.evaluate(() => window.__nativeCopyEvents),
      [{ trusted: true, text: deniedKeyboardSelection, defaultPrevented: true }]
    );
    assert.strictEqual(
      await page.evaluate(() => window.__nativeClipboardForDenial.readText()),
      deniedKeyboardSelection,
      'trusted native copy must replace the sentinel with the exact selection'
    );
    assert.strictEqual(await page.evaluate(() => window.__clipboardWriteAttempts), 0,
      'keyboard copy must not call navigator.clipboard.writeText');
    assert.strictEqual(await page.evaluate(() => window.__copyAttempts.length), 0,
      'keyboard copy must not call the explicit-action helper');
    assert.strictEqual(await page.evaluate(() => window.__toast), null,
      'successful native copy must not show a failure toast');

    // The explicit right-click helper tries the synchronous path first, then
    // invokes the modern API in the same trusted click. If the modern API is
    // denied, the already-completed synchronous copy remains the fallback.
    await page.evaluate(() => {
      window.__copyAttempts.length = 0;
      window.__toast = null;
    });
    await openContextMenu(page);
    await page.locator('#fixture-context-menu [data-label="Copy"]').click();
    await page.waitForFunction(() => window.__copyAttempts.length === 1 &&
      window.__copyAttempts[0].result === true);
    assert.deepStrictEqual(
      await page.evaluate(() => window.__toast),
      { message: 'Copied to clipboard', level: 'success' }
    );
    assert.strictEqual(await page.evaluate(() => window.__clipboardWriteAttempts), 1,
      'menu copy must attempt the modern Clipboard API even when execCommand reports success');
    assert.strictEqual(
      await page.evaluate(() => window.__nativeClipboardForDenial.readText()),
      deniedKeyboardSelection,
      'gesture-preserving right-click Copy must write the exact selection'
    );

    // Under total denial the explicit helper remains truthful and leaves the
    // selection available.
    await page.evaluate(() => {
      window.__copyAttempts.length = 0;
      window.__toast = null;
      document.execCommand = () => false;
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
    assert.strictEqual(
      await page.evaluate(() => window.__nativeClipboardForDenial.readText()),
      deniedKeyboardSelection,
      'failed explicit copy must not overwrite the last successful native copy'
    );
    await page.evaluate(() => {
      delete navigator.clipboard;
      delete window.__nativeClipboardForDenial;
      delete window.__clipboardWriteAttempts;
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

    const uppercasePaste = 'UPPERCASE_KEYBOARD_PASTE_ONCE';
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
      const textarea = document.querySelector('#fixture-terminal .xterm-helper-textarea');
      window.__lastPasteShortcutKey = null;
      textarea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
          window.__lastPasteShortcutKey = event.key;
        }
      }, { capture: true });
    }, uppercasePaste);
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    await page.keyboard.press('Control+Shift+V');
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.strictEqual(
      await page.evaluate(() => window.__lastPasteShortcutKey),
      'V',
      'the browser fixture must deliver an uppercase paste KeyboardEvent.key'
    );
    assert.deepStrictEqual(
      state.pastePayloads,
      [uppercasePaste],
      'uppercase Ctrl+V must paste the exact platform clipboard text once'
    );

    // Embedded browsers can expose navigator.clipboard.readText while denying
    // every programmatic read. Keyboard paste must not touch that API: the
    // trusted native paste event remains available and still emits exactly once.
    const deniedReadPaste = 'SECURE_NATIVE_PASTE_WITH_READ_PERMISSION_DENIED';
    await page.evaluate(async (text) => {
      const nativeClipboard = navigator.clipboard;
      await nativeClipboard.writeText(text);
      window.__nativeClipboardForPasteDenial = nativeClipboard;
      window.__clipboardReadAttempts = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => {
            window.__clipboardReadAttempts += 1;
            return Promise.reject(new Error('clipboard-read denied'));
          },
          writeText: nativeClipboard.writeText.bind(nativeClipboard),
        },
      });
    }, deniedReadPaste);
    await page.locator('#fixture-terminal .xterm-helper-textarea').focus();
    await resetState(page);
    await page.keyboard.press('Control+v');
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(
      state.pastePayloads,
      [deniedReadPaste],
      'Ctrl+V must use native paste even when navigator.clipboard.readText rejects'
    );
    assert.strictEqual(
      await page.evaluate(() => window.__clipboardReadAttempts),
      0,
      'keyboard paste must not attempt the permission-gated Clipboard API'
    );
    await page.evaluate(() => {
      delete navigator.clipboard;
      delete window.__nativeClipboardForPasteDenial;
      delete window.__clipboardReadAttempts;
    });

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

    const afterEmptyOrphanPaste = 'PASTE_AFTER_EMPTY_ORPHAN_BEFOREINPUT';
    await resetState(page);
    await page.evaluate((text) => {
      const textarea = document.querySelector('#fixture-terminal .xterm-helper-textarea');
      textarea.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        data: '',
      }));
      window.fixture.dispatchNativePaste(text);
    }, afterEmptyOrphanPaste);
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(
      state.pastePayloads,
      [afterEmptyOrphanPaste],
      'an empty orphan beforeinput must not drop the immediately following native paste'
    );

    const orphanBeforeInputPaste = 'BEFOREINPUT_WITHOUT_COMPANION_PASTE';
    await resetState(page);
    await page.evaluate((text) => {
      const textarea = document.querySelector('#fixture-terminal .xterm-helper-textarea');
      textarea.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        data: text,
      }));
    }, orphanBeforeInputPaste);
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(
      state.pastePayloads,
      [orphanBeforeInputPaste],
      'a data-bearing orphan beforeinput must still send its own paste once'
    );
    await page.waitForTimeout(20);
    const afterDataOrphanPaste = 'PASTE_AFTER_DATA_ORPHAN_BEFOREINPUT';
    await resetState(page);
    await page.evaluate((text) => window.fixture.dispatchNativePaste(text), afterDataOrphanPaste);
    await waitForCounter(page, 'pasteCount', 1);
    state = await getState(page);
    assert.deepStrictEqual(
      state.pastePayloads,
      [afterDataOrphanPaste],
      'an orphan beforeinput latch must expire before the next paste gesture'
    );

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

    // Trusted keyboard copy must also work on a genuinely insecure origin,
    // where navigator.clipboard is unavailable.
    await dragCopyTarget(insecurePage, true);
    const insecureCopyText = (await readSelection(insecurePage)).text;
    await resetState(insecurePage);
    await insecurePage.keyboard.press('Control+c');
    await insecurePage.waitForFunction(() => window.__nativeCopyEvents.length === 1);
    state = await getState(insecurePage);
    assert.strictEqual(state.sigintCount, 0, 'insecure selected Ctrl+C must not emit SIGINT');
    assert.deepStrictEqual(
      await insecurePage.evaluate(() => window.__nativeCopyEvents),
      [{ trusted: true, text: insecureCopyText, defaultPrevented: true }],
      'insecure selected Ctrl+C must use the trusted native copy event'
    );
    assert.strictEqual(await insecurePage.evaluate(() => window.__copyAttempts.length), 0);
    assert.strictEqual((await readSelection(insecurePage)).text, insecureCopyText);
    assert.strictEqual(
      await page.evaluate(() => navigator.clipboard.readText()),
      insecureCopyText,
      'secure-origin verification must read the exact insecure native copy'
    );

    // The insecure-origin right-click action must use execCommand successfully
    // during its real click gesture, and the secure page must be able to read
    // the exact resulting clipboard contents.
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

    // The repeated live failure happened specifically after refresh: the user
    // had enabled Select mode, but a newly constructed TerminalPane silently
    // reset it to OFF. Prove the real browser persists the mode for this exact
    // terminal session and that plain-drag + Ctrl+C still work after reload.
    const persistenceToggle = page.locator('.terminal-pane-selectmode');
    await persistenceToggle.click();
    assert.strictEqual(await persistenceToggle.getAttribute('aria-pressed'), 'true');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      window.fixture && window.fixture.pane &&
      window.fixture.pane.term && window.fixture.pane.term.element
    );
    await page.waitForFunction(() => {
      const pane = window.fixture && window.fixture.pane;
      const line = pane && pane.term && pane.term.buffer.active.getLine(1);
      return !!(line && line.translateToString(true).includes('COPY_TARGET_ALPHA_BETA'));
    });
    const restoredToggle = page.locator('.terminal-pane-selectmode');
    assert.strictEqual(
      await restoredToggle.getAttribute('aria-pressed'),
      'true',
      'Select mode must remain ON for the same terminal after refresh'
    );
    await page.evaluate(() => window.fixture.pane.term.clearSelection());
    await resetState(page);
    await dragCopyTarget(page, false);
    const refreshedSelection = (await readSelection(page)).text;
    assert.ok(
      refreshedSelection.includes('OPY_TARGET_ALPHA_BETA'),
      'restored Select mode must make a plain drag select real terminal text'
    );
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.__nativeCopyEvents.length === 1);
    assert.strictEqual(
      await page.evaluate(() => navigator.clipboard.readText()),
      refreshedSelection,
      'Ctrl+C after refresh must copy the exact restored-mode selection'
    );
    await restoredToggle.click();
    assert.strictEqual(await restoredToggle.getAttribute('aria-pressed'), 'false');

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log('PASS terminal browser acceptance');
    console.log('  Shift+drag: real selection, zero PTY mouse reports');
    console.log('  Select mode: persists across refresh; real selection + native Ctrl+C; mode off restores TUI mouse events');
    console.log('  Ctrl+C: trusted native copy; uppercase safety; denied API still works; no SIGINT');
    console.log('  Clipboard: native copy writes exact text under API denial; original formats restored');
    console.log('  Right-click: hover + both button edges preserve snapshot; truthful copy toast');
    console.log('  Paste: lowercase/uppercase, denied API, native, and orphan paths send exactly once');
    console.log('  Insecure origin: native Ctrl+C/paste plus execCommand menu copy verified');
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
