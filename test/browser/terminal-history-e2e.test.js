#!/usr/bin/env node
/**
 * terminal-history-e2e.test.js - the P7 acceptance proof, end to end.
 * Created: 2026-08-13, Notion restyle phase P7 (terminal stages 3 and 4).
 *
 * WHAT THIS PROVES, AND WHY IT HAD TO BE A REAL BROWSER AND A REAL PTY
 *
 * The user's sentence is "select freeze plus copy works but you cannot drag up
 * and copy history". Everything in the unit suite is necessary and none of it
 * is sufficient, because the claim is about a gesture ending in the system
 * clipboard. So this test does the whole thing for real:
 *
 *   1. Boots the actual Workbook server in a disposable sandbox, on an
 *      ephemeral port, with USERPROFILE and every CWM_* path inside it.
 *   2. Seeds a real Claude transcript on that sandbox disk, so the mirror API
 *      has genuine conversation to serve.
 *   3. Spawns a REAL PTY running an alternate-screen child that enables mouse
 *      tracking and repaints by absolute cursor addressing, which is the
 *      measured behaviour of every agent CLI in TERMINAL-ARCHITECTURE section
 *      2, and the case where the terminal itself holds no history at all.
 *   4. Wheels up over the live terminal, with Shift, which is the guaranteed
 *      path every mainstream terminal reserves for its own scrollback.
 *   5. Drags a selection from the transcript, ACROSS the seam, into the live
 *      screen.
 *   6. Presses Ctrl+C and reads the system clipboard back.
 *   7. Asserts the clipboard contains text from BOTH sides of the seam.
 *
 * If any of that regresses, the feature is gone whatever the unit suite says.
 *
 * SAFETY
 *   - Never binds port 3456; the child asks the OS for an ephemeral port.
 *   - Never reads or writes the real profile.
 *   - Snapshots and restores the Windows clipboard around the run, the same
 *     way test/browser/terminal-interaction.test.js does, because step 6
 *     genuinely writes to it.
 *   - Kills its own PTY and its own child, and validates the sandbox path
 *     before deleting it.
 *
 * Usage: node test/browser/terminal-history-e2e.test.js
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
const FAKE_CLI_PATH = path.join(__dirname, 'fake-agent-cli.js');
const TEMP_PREFIX = 'myrlin-p7-history-';

// The seeded session. A real UUID shape, because findJsonlFile matches on the
// file name and _copyViewIdentity validates the id before it is ever sent.
const SESSION_ID = '7f3d21b8-4c6e-4a19-9f2b-11d0a7e5c400';

// Markers. TRANSCRIPT-TURN-* exists only in the seeded JSONL, and
// LIVE-SCREEN-ROW-* only in the frame the fake CLI paints, so a clipboard
// containing both provably spans the seam.
const TRANSCRIPT_MARKER = 'TRANSCRIPT-TURN-';
const LIVE_MARKER = 'LIVE-SCREEN-ROW-';

let passed = 0;
let failed = 0;

/**
 * Run one named assertion.
 *
 * @param {string} name - Assertion name.
 * @param {Function} fn - Body, may be async.
 * @returns {Promise<void>} Resolves when the check has reported.
 */
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + ((err && err.message) || String(err)));
  }
}

/**
 * Wait for an owned child to exit.
 *
 * @param {import('child_process').ChildProcess} child - Owned child.
 * @param {number} timeoutMs - Maximum wait.
 * @returns {Promise<boolean>} Whether exit was observed.
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

/**
 * Snapshot every Windows clipboard format before Chromium mutates it.
 *
 * Same guard terminal-interaction.test.js uses, for the same reason: this test
 * writes to the real clipboard and must hand it back exactly as it found it.
 *
 * @returns {Promise<import('child_process').ChildProcess>} Owned guard process.
 */
function startClipboardGuard() {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
      '-ExecutionPolicy', 'Bypass', '-File', CLIPBOARD_GUARD_PATH,
    ], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.stdin.end(); } catch (_) {}
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
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('clipboard guard exited ' + code + ': ' + stderr.trim()));
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Ask the guard to restore the clipboard and confirm it exited cleanly.
 *
 * @param {import('child_process').ChildProcess} child - Owned guard.
 * @returns {Promise<void>} Resolves once restoration is confirmed.
 */
async function stopClipboardGuard(child) {
  if (!child) return;
  const restored = waitForExit(child, 15000);
  try { child.stdin.end('RESTORE\n'); } catch (_) {}
  if (!(await restored)) {
    try { child.kill('SIGKILL'); } catch (_) {}
    await waitForExit(child, 3000);
    throw new Error('clipboard guard did not confirm restoration');
  }
}

/**
 * Write the seeded transcript into the sandbox profile.
 *
 * The Claude provider resolves an artifact by scanning
 * <home>/.claude/projects/<any>/<sessionId>.jsonl, and the child server runs
 * with USERPROFILE pointing inside the sandbox, so this is the real lookup
 * path rather than a stub.
 *
 * @param {string} profileDir - The sandbox profile root.
 * @param {number} turns - How many conversation turns to write.
 * @returns {string} The transcript path.
 */
function seedTranscript(profileDir, turns) {
  const projectDir = path.join(profileDir, '.claude', 'projects', 'C--p7-history-probe');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [];
  for (let i = 1; i <= turns; i++) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date(Date.UTC(2026, 7, 13, 9, i, 0)).toISOString(),
      message: { role: 'user', content: TRANSCRIPT_MARKER + i + ': what did we decide about the seam?' },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 7, 13, 9, i, 30)).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: TRANSCRIPT_MARKER + i + '-REPLY: the overlap is deliberate, never a heuristic join.' }],
      },
    }));
  }
  const file = path.join(projectDir, SESSION_ID + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/**
 * Start the isolated Workbook server in a sandbox.
 *
 * @param {string} sandbox - Sandbox root.
 * @returns {Promise<{child: object, url: string, profile: string}>} Owned child and URL.
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
    for (const dir of [claudeDir, emptySeed, dataDir, tempDir, appData, localAppData]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({
      version: 2, workspaces: {}, sessions: {}, activeWorkspace: null,
      settings: { credentials: { proactiveRefreshMinutes: 0 } },
    }, null, 2) + '\n', 'utf8');

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
      cwd: PROJECT_ROOT, windowsHide: true, env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let settled = false;
    let stderr = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('sandbox server did not report readiness: ' + stderr.trim()));
    }, 45000);
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('message', (message) => {
      if (settled || !message || message.type !== 'ready') return;
      const parsed = new URL(message.url);
      if (parsed.hostname !== '127.0.0.1') {
        settled = true;
        clearTimeout(timeout);
        return reject(new Error('sandbox server reported a non-loopback URL'));
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: message.url, profile });
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('sandbox server exited ' + code + ': ' + stderr.trim()));
    });
  });
}

/**
 * Stop the owned server child.
 *
 * @param {object} child - Owned child.
 * @returns {Promise<void>} Resolves when it is gone.
 */
async function stopWorkbook(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const graceful = waitForExit(child, 6000);
  try {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
  } catch (_) {}
  if (await graceful) return;
  try { child.kill('SIGKILL'); } catch (_) {}
  await waitForExit(child, 4000);
}

/**
 * Delete the sandbox, refusing anything that is not the directory we made.
 *
 * @param {string} sandbox - Sandbox root.
 * @returns {void}
 */
function removeSandbox(sandbox) {
  const base = path.basename(sandbox);
  const parent = path.dirname(sandbox);
  if (!base.startsWith(TEMP_PREFIX)) return;
  if (path.resolve(parent) !== path.resolve(os.tmpdir())) return;
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
}

/**
 * The whole proof.
 *
 * @returns {Promise<void>} Resolves when every check has reported.
 */
async function run() {
  assert.strictEqual(process.platform, 'win32',
    'the P7 end-to-end proof reads the Windows clipboard and must run on Windows');

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let child = null;
  let browser = null;
  let guard = null;

  console.log('\n  \x1b[1mP7 end to end: wheel up, select across the seam, copy everything\x1b[0m');
  console.log('  ' + '-'.repeat(74));

  try {
    guard = await startClipboardGuard();
    const started = await startWorkbook(sandbox);
    child = started.child;
    const transcriptPath = seedTranscript(started.profile, 12);
    assert.ok(fs.existsSync(transcriptPath), 'the seeded transcript must exist before the pane opens');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.route(/^https?:\/\//, (route) => {
      const target = new URL(route.request().url());
      if (target.hostname === '127.0.0.1') return route.continue();
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(started.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token);

    // ── Spawn the alternate-screen child on a REAL PTY ────────────────
    const cliPath = FAKE_CLI_PATH.replace(/\\/g, '/');
    // initTerminalGroups awaits GET /api/layout, so the token arriving does not
    // mean the pane bookkeeping exists yet. Waiting for the active group id is
    // waiting for the real readiness signal rather than for a sleep.
    await page.waitForFunction(
      () => window.cwm && Array.isArray(window.cwm._tabGroups) &&
        Array.isArray(window.cwm._tabFolders) && !!window.cwm._activeGroupId,
      { timeout: 30000 }
    );
    await page.evaluate(({ sessionId, command }) => {
      window.cwm.setViewMode('terminal');
      window.cwm.openTerminalInPane(0, sessionId, 'History probe', {
        command,
        resumeSessionId: sessionId,
      });
    }, { sessionId: SESSION_ID, command: 'node ' + cliPath });

    await page.waitForFunction(() => {
      const screen = document.querySelector('#term-pane-0 .xterm-screen');
      return !!screen && screen.textContent.indexOf('LIVE-SCREEN-ROW-1') !== -1;
    }, { timeout: 45000 });

    await check('the pane is on the ALTERNATE buffer, with bracketed paste on', async () => {
      const state = await page.evaluate(() => {
        const pane = window.cwm.terminalPanes[0];
        return {
          type: pane.term.buffer.active.type,
          tracking: pane.term.modes.mouseTrackingMode,
          bracketed: pane.term.modes.bracketedPasteMode,
          trackingActive: pane._mouseTrackingActive(),
        };
      });
      assert.strictEqual(state.type, 'alternate', 'buffer type: ' + state.type);
      assert.strictEqual(state.bracketed, true, 'the child must have asked for bracketed paste');
      // MEASURED, and recorded rather than asserted away: ConPTY's conhost
      // consumes the mouse-tracking DECSETs and does not forward them, so this
      // pane is 8.1's third row (alternate buffer, tracking off). The resolver
      // must therefore answer FALSE here, and it must answer it from the enum
      // rather than from truthiness.
      console.log('       (measured: mouseTrackingMode=' + state.tracking +
        ', resolver=' + state.trackingActive + ')');
      assert.strictEqual(state.trackingActive, state.tracking !== 'none',
        'the resolver must agree with the enum, never with truthiness');
    });

    await check('with the mouse unclaimed, a PLAIN wheel up opens the surface (8.1 row 3)', async () => {
      const box = await page.locator('#term-pane-0 .xterm-screen').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(300);
      const open = await page.evaluate(() => window.cwm.terminalPanes[0].isHistoryOpen());
      assert.strictEqual(open, true,
        'an alternate pane whose application never asked for the wheel must hand it to history');
      await page.evaluate(() => window.cwm.terminalPanes[0].closeHistory('probe-reset'));
      await page.waitForTimeout(150);
    });

    await check('the terminal itself holds NO history: this is the case P7 exists for', async () => {
      const depth = await page.evaluate(() => {
        const buf = window.cwm.terminalPanes[0].term.buffer.active;
        return { length: buf.length, baseY: buf.baseY, viewportY: buf.viewportY };
      });
      assert.strictEqual(depth.baseY, 0,
        'an alternate viewport never scrolls, so there is nothing above it (measured, section 2.3)');
    });

    // ── The gesture: Shift plus wheel up over the live terminal ───────
    await check('Shift plus wheel up opens the history surface', async () => {
      const box = await page.locator('#term-pane-0 .xterm-screen').boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -240);
      await page.keyboard.up('Shift');
      await page.waitForFunction(
        () => !!document.querySelector('#term-pane-0 .terminal-history'),
        { timeout: 5000 }
      );
      const open = await page.evaluate(() => window.cwm.terminalPanes[0].isHistoryOpen());
      assert.strictEqual(open, true, 'the surface must be open after the guaranteed gesture');
    });

    await check('the transcript arrives, and it is OLDER than anything the terminal has', async () => {
      await page.waitForFunction(
        (marker) => {
          const seg = document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="transcript"]');
          return !!seg && seg.textContent.indexOf(marker) !== -1;
        },
        TRANSCRIPT_MARKER,
        { timeout: 20000 }
      );
      const text = await page.evaluate(() => {
        const seg = document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="transcript"]');
        return seg ? seg.textContent : '';
      });
      assert.ok(text.indexOf(TRANSCRIPT_MARKER + '1:') !== -1, 'the oldest seeded turn must be reachable');
      assert.ok(text.indexOf(TRANSCRIPT_MARKER + '12-REPLY') !== -1, 'and the newest one');
    });

    await check('the live screen is the LAST segment, so there is no boundary to cross', async () => {
      const shape = await page.evaluate((marker) => {
        const doc = document.querySelector('#term-pane-0 .terminal-history-doc');
        const segs = Array.from(doc.querySelectorAll('.terminal-history-seg'));
        const live = doc.querySelector('.terminal-history-seg[data-seg="live"]');
        return {
          order: segs.map((s) => s.dataset.seg),
          lastIsLive: segs[segs.length - 1].dataset.seg === 'live',
          liveHasFrame: !!live && live.textContent.indexOf(marker) !== -1,
          ruleVisible: !doc.querySelector('.terminal-history-rule').hidden,
        };
      }, LIVE_MARKER);
      assert.deepStrictEqual(shape.order, ['deep', 'ring', 'transcript', 'live']);
      assert.strictEqual(shape.lastIsLive, true);
      assert.strictEqual(shape.liveHasFrame, true, 'the live segment must mirror the frame on screen');
      assert.strictEqual(shape.ruleVisible, true, 'the seam rule appears once there is content above it');
    });

    await check('the surface is metrically indistinguishable from the terminal', async () => {
      const metrics = await page.evaluate(() => {
        const doc = document.querySelector('#term-pane-0 .terminal-history-doc');
        // MOBILE-TERMINAL.md D3. This used to read `.xterm-screen`, which is
        // NOT where xterm 6 puts its type: the DOM renderer injects its font
        // rule onto `.xterm-rows`. The screen element reports whatever it
        // inherits from the application shell, which is the proportional UI
        // face at 14px, so this check compared the layer against the SHELL
        // and passed precisely while the whole surface rendered terminal
        // output in a UI font. The rows element is the terminal's own type.
        const rows = document.querySelector('#term-pane-0 .xterm-rows');
        const screen = document.querySelector('#term-pane-0 .xterm-screen');
        const row = document.querySelector('#term-pane-0 .xterm-rows > div');
        const layer = document.querySelector('#term-pane-0 .terminal-history');
        const container = document.querySelector('#term-pane-0 .terminal-container');
        const ds = getComputedStyle(doc);
        const ss = getComputedStyle(rows || screen);
        const rowHeight = row ? row.getBoundingClientRect().height : null;
        // The effective ground: xterm paints its rows over the container, which
        // is the element carrying --term-bg, so that is what "the terminal's
        // background" means on screen.
        return {
          docFontSize: ds.fontSize,
          screenFontSize: ss.fontSize,
          docFontFamily: ds.fontFamily,
          screenFontFamily: ss.fontFamily,
          docLineHeight: ds.lineHeight,
          rowHeight,
          layerBg: getComputedStyle(layer).backgroundColor,
          containerBg: getComputedStyle(container).backgroundColor,
          layerRect: layer.getBoundingClientRect(),
          containerRect: container.getBoundingClientRect(),
        };
      });
      assert.strictEqual(metrics.docFontSize, metrics.screenFontSize,
        'font size: ' + metrics.docFontSize + ' vs ' + metrics.screenFontSize);
      assert.strictEqual(metrics.docFontFamily, metrics.screenFontFamily,
        'font family must be the terminal\'s resolved stack');
      assert.ok(/mono|JetBrains|Cascadia|Consolas/i.test(metrics.docFontFamily),
        'and that stack has to be monospaced, or the columns do not line up: ' +
        metrics.docFontFamily);
      assert.strictEqual(metrics.layerBg, metrics.containerBg,
        'ground: ' + metrics.layerBg + ' vs ' + metrics.containerBg);
      const docLine = parseFloat(metrics.docLineHeight);
      assert.ok(Math.abs(docLine - metrics.rowHeight) < 0.5,
        'line height ' + docLine + ' must equal the live row height ' + metrics.rowHeight);
      assert.ok(Math.abs(metrics.layerRect.width - metrics.containerRect.width) < 0.5 &&
        Math.abs(metrics.layerRect.height - metrics.containerRect.height) < 0.5,
        'the surface must occupy exactly the pane body rect');
    });

    // ── The money shot: one drag from history into the live screen ────
    await check('a drag from the transcript into the live screen selects a contiguous range', async () => {
      // Put the SEAM in the middle of the viewport, so both sides of it are on
      // screen at once. Scrolling to the bottom would show only the live
      // segment, which on an agent pane is a whole frame tall.
      await page.evaluate(() => {
        const doc = document.querySelector('#term-pane-0 .terminal-history-doc');
        const rule = doc.querySelector('.terminal-history-rule');
        doc.scrollTop = Math.max(0, rule.offsetTop - Math.round(doc.clientHeight / 2));
      });
      await page.waitForTimeout(250);
      const points = await page.evaluate(() => {
        const doc = document.querySelector('#term-pane-0 .terminal-history-doc');
        const rule = doc.querySelector('.terminal-history-rule');
        const docRect = doc.getBoundingClientRect();
        const ruleRect = rule.getBoundingClientRect();
        return {
          // Well above the seam: inside the transcript.
          startX: docRect.left + 24,
          startY: Math.max(docRect.top + 10, ruleRect.top - 60),
          // Well below it: inside the live frame.
          endX: docRect.left + 240,
          endY: Math.min(docRect.bottom - 10, ruleRect.bottom + 60),
        };
      });
      await page.mouse.move(points.startX, points.startY);
      await page.mouse.down({ button: 'left' });
      await page.mouse.move(points.endX, points.endY, { steps: 14 });
      await page.mouse.up({ button: 'left' });
      await page.waitForTimeout(150);

      const selection = await page.evaluate(() => {
        const sel = document.getSelection();
        return { text: sel ? sel.toString() : '', collapsed: !sel || sel.isCollapsed };
      });
      assert.strictEqual(selection.collapsed, false, 'the drag must produce a selection');
      assert.ok(selection.text.indexOf(TRANSCRIPT_MARKER) !== -1,
        'the selection must contain conversation older than the visible frame');
      assert.ok(selection.text.indexOf(LIVE_MARKER) !== -1,
        'and it must reach into the current screen, which is the whole point');
    });

    await check('the mirror is frozen while the selection is held, and the PTY is NOT', async () => {
      const before = await page.evaluate(() => ({
        frozen: window.cwm.terminalPanes[0]._historyLayer.isFrozen(),
        live: document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="live"]').textContent,
        writeFrozen: window.cwm.terminalPanes[0]._isWriteFrozen(),
      }));
      assert.strictEqual(before.frozen, true, 'a held selection pauses the mirror');
      assert.strictEqual(before.writeFrozen, false,
        'and must NOT freeze the write pipeline: the PTY never stops (requirement A9)');

      // The fake CLI repaints its status row every 450ms, so this window
      // contains several real repaints.
      await page.waitForTimeout(1600);
      const after = await page.evaluate(() => ({
        live: document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="live"]').textContent,
        screen: document.querySelector('#term-pane-0 .xterm-screen').textContent,
        selection: document.getSelection().toString(),
      }));
      assert.strictEqual(after.live, before.live,
        'the text under the selection must not have moved');
      assert.ok(after.selection.indexOf(TRANSCRIPT_MARKER) !== -1 &&
        after.selection.indexOf(LIVE_MARKER) !== -1,
        'and the selection must have survived the output');
      assert.ok(/tick \d+/.test(after.screen), 'the live terminal underneath must still be painting');
    });

    await check('Ctrl+C puts BOTH sides of the seam on the system clipboard', async () => {
      await page.keyboard.press('Control+c');
      await page.waitForTimeout(250);
      const clip = await page.evaluate(async () => {
        try { return await navigator.clipboard.readText(); } catch (err) { return 'READ-FAILED: ' + err.message; }
      });
      assert.ok(clip.indexOf(TRANSCRIPT_MARKER) !== -1,
        'the clipboard must contain conversation history: ' + clip.slice(0, 120));
      assert.ok(clip.indexOf(LIVE_MARKER) !== -1,
        'and the current screen: ' + clip.slice(-120));
      const lines = clip.split('\n').filter((l) => l.trim() !== '');
      assert.ok(lines.length >= 3, 'a drag-up copy must be more than one line, got ' + lines.length);
    });

    await check('Ctrl+Shift+A selects the WHOLE document, including the screen', async () => {
      await page.evaluate(() => { document.getSelection().removeAllRanges(); });
      await page.evaluate(() => window.cwm.terminalPanes[0].term.focus());
      await page.keyboard.press('Control+Shift+A');
      await page.waitForTimeout(150);
      const selected = await page.evaluate(() => document.getSelection().toString());
      assert.ok(selected.indexOf(TRANSCRIPT_MARKER + '1:') !== -1,
        'select-all must reach the OLDEST loaded turn');
      assert.ok(selected.indexOf(LIVE_MARKER) !== -1, 'and the current screen');
    });

    await check('typing dismisses the surface and reaches the PTY', async () => {
      await page.evaluate(() => { document.getSelection().removeAllRanges(); });
      await page.evaluate(() => window.cwm.terminalPanes[0].term.focus());
      await page.keyboard.press('KeyZ');
      await page.waitForTimeout(300);
      const open = await page.evaluate(() => window.cwm.terminalPanes[0].isHistoryOpen());
      assert.strictEqual(open, false, 'the way out of history is to start typing');
    });

    await check('wheel down at the bottom of the document returns to live', async () => {
      await page.evaluate(() => window.cwm.terminalPanes[0].openHistory('probe'));
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const doc = document.querySelector('#term-pane-0 .terminal-history-doc');
        doc.scrollTop = doc.scrollHeight;
      });
      const box = await page.locator('#term-pane-0 .terminal-history-doc').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(250);
      const open = await page.evaluate(() => window.cwm.terminalPanes[0].isHistoryOpen());
      assert.strictEqual(open, false, 'passing the bottom pins live again');
    });

    await check('no page errors were raised during the run', async () => {
      assert.deepStrictEqual(pageErrors, []);
    });

    // Kill the probe PTY through the application's own endpoint, so the child
    // process is reaped rather than merely detached from a closed socket.
    await page.evaluate(async (sessionId) => {
      try { await window.cwm.api('POST', '/api/pty/' + encodeURIComponent(sessionId) + '/kill'); } catch (_) {}
      const pane = window.cwm.terminalPanes && window.cwm.terminalPanes[0];
      if (pane && typeof pane.dispose === 'function') pane.dispose();
    }, SESSION_ID);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    await stopWorkbook(child);
    if (guard) { try { await stopClipboardGuard(guard); } catch (err) { console.log('  clipboard restore: ' + err.message); } }
    removeSandbox(sandbox);
  }

  console.log('  ' + '-'.repeat(74));
  console.log('  [terminal-history-e2e] ' + passed + '/' + (passed + failed) + ' checks passed');
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('  \x1b[31mHARNESS FAILURE\x1b[0m ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
