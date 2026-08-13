#!/usr/bin/env node
/**
 * notion-shell.spec.js - the Notion restyle's screenshot and metric harness.
 * Created: 2026-08-13 (phase P0, work package P0.5).
 *
 * WHAT IT IS FOR
 *
 * Every phase gate in BUILD-CONTRACT.md 5.1 block 4 requires screenshots at
 * 1280x800 and 390x844 in both chrome themes, and decision D5 says nothing
 * deploys live until the user has seen them. Run in P0 it captures the BEFORE
 * pictures: the application exactly as it is, before a single token moves. Run
 * in any later phase it captures that phase's AFTER pictures against the same
 * matrix, so any two phases are directly comparable.
 *
 * It also records computed metrics (topbar height, sidebar width, body ink, body
 * font) into a manifest, which is what turns "it looks about right" into the
 * numeric per-phase checks in 5.2: 44px topbar, 240px sidebar, body ink never
 * #000000, font stack starting with ui-sans-serif.
 *
 * WHY IT IS A PLAIN NODE SCRIPT AND NOT A PLAYWRIGHT-RUNNER SPEC
 *
 * The contract names this file `notion-shell.spec.js` and suggests
 * `npx playwright test`. The repository has no playwright.config.*, so that
 * command would default testDir to the repository root and testMatch to
 * **\/*.@(spec|test).?(c|m)[jt]s?(x)`, sweeping up all 79 Node test files in
 * test/ and running them as Playwright specs. The file name is kept, the runner
 * is the one every other harness in test/browser/ already uses. See
 * DECISIONS.md 5.2.
 *
 * SAFETY
 *
 *   - Never binds port 3456. The child asks the OS for an ephemeral port.
 *   - Never reads or writes the real profile: USERPROFILE, APPDATA, LOCALAPPDATA,
 *     TEMP and every CWM_* path point inside a disposable sandbox that is
 *     validated before it is deleted.
 *   - Seeds the sandbox store with proactiveRefreshMinutes: 0 and runs with
 *     CWM_CRED_EXTERNAL_BRIDGE_OWNER=1, so no credential refresh, rotation or
 *     Mac bridge call can happen while a screenshot run is in flight.
 *   - Blocks every non-loopback request.
 *   - Asserts every captured PNG is at most 2000px on both axes before any of
 *     them can be read into a model context. An oversized image poisons a
 *     session; see the global image-size rule.
 *
 * Usage:
 *   node test/browser/notion-shell.spec.js                  # writes to screenshots/notion-restyle/baseline
 *   node test/browser/notion-shell.spec.js --label p2       # writes to screenshots/notion-restyle/p2
 *   node test/browser/notion-shell.spec.js --out <dir>      # explicit directory
 *   NOTION_SHOT_DIR=<dir> node test/browser/notion-shell.spec.js
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
const TEMP_PREFIX = 'myrlin-notion-shell-';
const FETCH_HEAD_PATH = path.join(PROJECT_ROOT, '.git', 'FETCH_HEAD');
const LEGACY_CONFIG_PATH = path.join(PROJECT_ROOT, 'state', 'config.json');

// No captured PNG may exceed this on either axis. The API rejects larger
// images and passing one mid-turn poisons the whole session.
const ABSOLUTE_MAX_DIM = 2000;

// A screenshot smaller than this is a blank or failed capture, not a picture.
const MIN_PNG_BYTES = 1024;

/**
 * The capture matrix. Editing these three arrays changes every phase's picture
 * set at once, which is the point: P0's before pictures and P4's after pictures
 * must be the same shots or they cannot be compared.
 */
const VIEWPORTS = [
  { id: 'desktop', width: 1280, height: 800 },
  { id: 'phone', width: 390, height: 844 },
];

// In P0 the app has no chrome theme: `data-chrome` arrives in P1.4. Each entry
// therefore names both a future chrome id and the appearance choice that is its
// closest current analogue, and the harness uses whichever exists at run time.
// From P1 the same matrix captures the real Notion light and dark chrome with
// no edit here.
const CHROMES = [
  { id: 'light', chrome: 'light', appearance: 'myrlin-light' },
  { id: 'dark', chrome: 'dark', appearance: 'myrlin-dark' },
];

const ROUTES = [
  { id: 'workbench', mode: 'terminal' },
  { id: 'sessions', mode: 'workspace' },
];

/**
 * OPT-IN REGION SHOTS, added by the P4 remainder.
 *
 * The two standard routes are deliberately frozen: P0's before pictures and any
 * later phase's after pictures must be the same shots or they cannot be
 * compared, so nothing is ever added to ROUTES. But four of the regions the
 * restyle changes are not reachable from either of them (the side peek needs a
 * selected session, and Docs, Costs and Settings are their own views), which
 * means those regions were being shipped without anybody looking at them.
 *
 * `--regions` captures them into a `regions/` subdirectory, desktop only, both
 * chromes, and records them under a SEPARATE manifest key. The default run is
 * byte-for-byte what it was, so comparability is untouched and this costs
 * nothing unless it is asked for.
 *
 * Each entry is a plain in-page recipe rather than a selector click, because
 * `window.cwm` is the same API the standard route loop already drives and a
 * click would depend on markup this harness is supposed to outlive.
 */
const REGION_ROUTES = [
  {
    id: 'peek',
    // Deliberately NOT window.cwm.selectSession(). That method awaits a
    // showConfirmModal("Start Session?") whenever the session it opens is
    // stopped, and every seeded fixture session is stopped, so awaiting it
    // inside page.evaluate hangs until the harness tears the browser down and
    // reports "Target page has been closed" from four frames away. Setting the
    // selection and calling the two renderers directly reaches the same DOM
    // state with no dialog in the way.
    apply: async (page) => {
      await page.evaluate(() => {
        window.cwm.setViewMode('workspace');
        const roster = window.cwm.state.sessions || [];
        const first = Array.isArray(roster) ? roster[0] : Object.values(roster)[0];
        if (!first) return;
        window.cwm.state.selectedSession = first;
        window.cwm.renderSessionDetail();
        window.cwm.renderSessions();
      });
    },
  },
  {
    // THE TERMINAL REGION, added by P5. The other three regions are reachable
    // by switching a view; this one needs a LIVE PTY, because a terminal pane
    // with nothing attached is a drop slot and shows none of what P5 changed:
    // the terminal ground, its padding, the ANSI palette, the cell metrics of
    // the new face, or the scrollbar.
    //
    // It spawns a real cmd.exe inside the harness sandbox, which is safe by
    // construction: the child server already runs with USERPROFILE, APPDATA,
    // TEMP and every CWM_* path inside the disposable temp directory, and the
    // shell name is validated against pty-server.js's ALLOWED_SHELL_NAMES
    // before it reaches a spawn. The pane is closed again after the capture so
    // the following region never inherits a live PTY.
    id: 'terminal',
    apply: async (page) => {
      await page.evaluate(() => {
        window.cwm.setViewMode('terminal');
        window.cwm.openTerminalInPane(0, 'p5-agent-probe', 'Shell', {});
      });
      // The default spawn is the provider CLI, which is the pane P5's
      // acceptance criterion actually cares about ("a full agent session, a
      // coloured git diff and an npm test run are all legible in both chrome
      // themes"): it exercises the whole ANSI palette rather than a prompt.
      // The first launch in a cold sandbox profile is slow, so the wait is
      // generous and the failure mode is an empty surface rather than a
      // missing picture.
      await waitForPaintedTerminal(page, 45000);
    },
    cleanup: killProbePane,
  },
  {
    // THE TWO AXES, proved in one picture (DESIGN-SPEC 10.1). The chrome is
    // Notion LIGHT and the terminal palette is Mocha, which is a dark palette.
    // If the projection worked, the pane is a dark terminal on a light page
    // with no chrome token bleeding into it and no palette token bleeding out.
    // If the two axes were still coupled, this shot is impossible to take.
    id: 'terminal-mocha-on-light',
    chromeOnly: 'light',
    apply: async (page) => {
      await page.evaluate(() => {
        window.cwm.setChrome('light');
        window.cwm.setTheme('mocha');
        window.cwm.setViewMode('terminal');
        // A BARE SHELL here rather than the agent CLI, deliberately. This shot
        // has one job, proving the two axes are independent, and it should not
        // depend on a CLI's cold-start time to do it. `cmd` paints its banner
        // and prompt in a few hundred milliseconds, and a prompt is enough to
        // show the terminal ground, the ink and the new face.
        window.cwm.openTerminalInPane(0, 'p5-shell-probe-mocha', 'Shell', { command: 'cmd' });
      });
      await waitForPaintedTerminal(page, 20000);
    },
    cleanup: async (page) => {
      await killProbePane(page);
      // Leave the palette as this chrome pass found it, so the regions after
      // this one are captured under the same theme as every previous phase.
      await page.evaluate(() => window.cwm.setTheme('myrlin-light'));
    },
  },
  { id: 'docs', apply: async (page) => page.evaluate(() => window.cwm.setViewMode('docs')) },
  { id: 'costs', apply: async (page) => page.evaluate(() => window.cwm.setViewMode('costs')) },
  {
    id: 'settings',
    apply: async (page) => {
      await page.evaluate(() => {
        window.cwm.setViewMode('workspace');
        window.cwm.openSettings();
      });
    },
  },
];

/**
 * Wait until the pane in slot 0 has actually painted rows.
 *
 * xterm renders through the DOM renderer in this application (no WebGL addon
 * is loaded), so rendered rows are real text nodes and this is a true "has it
 * painted" test rather than a sleep. A timeout resolves rather than throws:
 * an empty terminal surface is still a picture of the surface, and losing the
 * whole capture run because one CLI was slow to boot would be worse.
 *
 * @param {import('@playwright/test').Page} page - Live page.
 * @param {number} timeoutMs - How long to wait for the first painted row.
 * @returns {Promise<void>} Resolves either way.
 */
async function waitForPaintedTerminal(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const screen = document.querySelector('#term-pane-0 .xterm-screen');
      return !!screen && screen.textContent.trim().length > 0;
    },
    { timeout: timeoutMs }
  ).catch(() => { /* captured empty rather than not at all */ });
  // One extra frame so a half-drawn first paint is not what gets photographed.
  await page.waitForTimeout(600);
}

/**
 * Kill the probe PTY and drop its pane.
 *
 * The kill matters more than the dispose. dispose() closes the CLIENT socket;
 * the PTY on the server side survives it, and a capture run that opened three
 * probe panes would leave three live child processes behind for the harness's
 * shutdown to reap. This asks the application's own endpoint to end them,
 * which is the same path the close button uses.
 *
 * @param {import('@playwright/test').Page} page - Live page.
 * @returns {Promise<void>} Resolves when the pane is gone.
 */
async function killProbePane(page) {
  await page.evaluate(async () => {
    const pane = window.cwm.terminalPanes && window.cwm.terminalPanes[0];
    const sessionId = pane && pane.sessionId;
    if (sessionId) {
      try {
        await window.cwm.api('POST', '/api/pty/' + encodeURIComponent(sessionId) + '/kill');
      } catch (_) { /* an already-dead session is the outcome we wanted */ }
    }
    if (pane && typeof pane.dispose === 'function') pane.dispose();
    if (window.cwm.terminalPanes) window.cwm.terminalPanes[0] = null;
  });
}

/**
 * Remove startup-token values before an error reaches logs.
 *
 * @param {string} value - Potentially sensitive diagnostic text.
 * @returns {string} Redacted diagnostic.
 */
function redactToken(value) {
  return String(value || '').replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * Resolve the output directory from --out, --label, NOTION_SHOT_DIR, or the
 * default baseline location.
 *
 * screenshots/ is git-ignored, so these files persist on disk across phases and
 * sessions without ever entering the repository. A scratchpad path would be
 * deleted with the session and the comparison corpus would be gone by P2.
 *
 * @param {string[]} argv - Process arguments.
 * @returns {string} Absolute output directory.
 */
function resolveOutputDir(argv) {
  const outIndex = argv.indexOf('--out');
  if (outIndex !== -1 && argv[outIndex + 1]) return path.resolve(argv[outIndex + 1]);
  if (process.env.NOTION_SHOT_DIR) return path.resolve(process.env.NOTION_SHOT_DIR);
  const labelIndex = argv.indexOf('--label');
  const label = labelIndex !== -1 && argv[labelIndex + 1] ? argv[labelIndex + 1] : 'baseline';
  assert.match(label, /^[a-z0-9][a-z0-9._-]*$/i, 'screenshot label must be a simple file-safe name');
  return path.join(PROJECT_ROOT, 'screenshots', 'notion-restyle', label);
}

/**
 * Wait until an owned child has actually exited.
 *
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
 *
 * @param {string} filePath - File to inspect.
 * @returns {null|{size: number, mtimeMs: number}} Stable metadata.
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
 * Read a PNG's pixel dimensions straight out of its IHDR chunk.
 *
 * Deliberately dependency-free: the guard must work even if an image toolchain
 * is missing, because the consequence of not checking is a dead session.
 *
 * @param {string} filePath - PNG on disk.
 * @returns {{width: number, height: number, bytes: number}} Image dimensions and size.
 */
function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.ok(buffer.length >= 24, 'file is too small to be a PNG: ' + filePath);
  assert.ok(
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'file is not a PNG: ' + filePath
  );
  assert.strictEqual(buffer.toString('ascii', 12, 16), 'IHDR', 'PNG has no leading IHDR chunk: ' + filePath);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

/**
 * Build the deterministic store fixture the screenshots are taken against.
 *
 * Everything here is invented. No real project path, session id or account is
 * referenced, and every session is `stopped` with a null pid so nothing is
 * probed, resumed or spawned. Timestamps are fixed rather than relative so a
 * capture taken in P4 is comparable with one taken in P0 down to the sort order.
 *
 * The shape follows Store.createWorkspace and Store.createSession exactly; the
 * store merges it over DEFAULT_STATE on load.
 *
 * @returns {object} A v2 state document.
 */
function buildFixture() {
  const WS_A = '11111111-1111-4111-8111-111111111111';
  const WS_B = '22222222-2222-4222-8222-222222222222';
  const at = (iso) => iso;
  const session = (id, name, workspaceId, overrides) => Object.assign({
    id,
    name,
    workspaceId,
    workingDir: 'C:/Users/example/projects/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    topic: '',
    command: 'claude',
    provider: 'claude',
    resumeSessionId: null,
    status: 'stopped',
    pid: null,
    tags: [],
    initialPrompt: null,
    flags: [],
    createdAt: at('2026-08-01T09:00:00.000Z'),
    lastActive: at('2026-08-12T17:30:00.000Z'),
    logs: [],
  }, overrides || {});

  const sessions = {
    'aaaaaaa1-0000-4000-8000-000000000001': session(
      'aaaaaaa1-0000-4000-8000-000000000001', 'Token foundation', WS_A,
      { topic: 'Author the Notion :root block', tags: ['restyle', 'tokens'], lastActive: at('2026-08-12T18:05:00.000Z') }
    ),
    'aaaaaaa1-0000-4000-8000-000000000002': session(
      'aaaaaaa1-0000-4000-8000-000000000002', 'Terminal surface', WS_A,
      { topic: 'terminalSurface projection', tags: ['terminal'], lastActive: at('2026-08-12T16:40:00.000Z') }
    ),
    'aaaaaaa1-0000-4000-8000-000000000003': session(
      'aaaaaaa1-0000-4000-8000-000000000003', 'Codex parity', WS_A,
      {
        topic: 'SQLite-first discovery', command: 'codex', provider: 'codex',
        tags: ['provider'], lastActive: at('2026-08-12T15:10:00.000Z'),
      }
    ),
    'bbbbbbb2-0000-4000-8000-000000000004': session(
      'bbbbbbb2-0000-4000-8000-000000000004', 'Mobile viewport', WS_B,
      { topic: 'Keyboard geometry', tags: ['mobile'], lastActive: at('2026-08-11T11:20:00.000Z') }
    ),
    'bbbbbbb2-0000-4000-8000-000000000005': session(
      'bbbbbbb2-0000-4000-8000-000000000005', 'Docs column', WS_B,
      { topic: '', tags: [], lastActive: at('2026-08-10T08:00:00.000Z') }
    ),
  };

  return {
    version: 2,
    activeWorkspace: WS_A,
    workspaces: {
      [WS_A]: {
        id: WS_A, name: 'Notion restyle', description: 'Chrome, tokens and terminal',
        color: 'mauve', icon: null,
        sessions: Object.keys(sessions).filter((id) => sessions[id].workspaceId === WS_A),
        createdAt: at('2026-08-01T09:00:00.000Z'), lastActive: at('2026-08-12T18:05:00.000Z'),
        autoSummary: true,
      },
      [WS_B]: {
        id: WS_B, name: 'Mobile client', description: 'Phone interaction architecture',
        color: 'teal', icon: null,
        sessions: Object.keys(sessions).filter((id) => sessions[id].workspaceId === WS_B),
        createdAt: at('2026-08-02T09:00:00.000Z'), lastActive: at('2026-08-11T11:20:00.000Z'),
        autoSummary: true,
      },
    },
    sessions,
    recentSessions: [
      'bbbbbbb2-0000-4000-8000-000000000004',
      'aaaaaaa1-0000-4000-8000-000000000003',
      'aaaaaaa1-0000-4000-8000-000000000001',
    ],
    settings: {
      providers: { claude: true, codex: true },
      credentialSwitcher: { proactiveRefreshMinutes: 0, externalBridgeOwner: true },
    },
  };
}

/**
 * Start the isolated application and capture its one-use URL.
 *
 * @param {string} sandbox - Validated temporary sandbox root.
 * @returns {Promise<{child: import('child_process').ChildProcess, url: string}>} Owned child and URL.
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
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n', 'utf8');

    // Seed the sandbox store. Two jobs at once:
    //
    // 1. Turn the credential switcher's proactive refresh sweep off before the
    //    server boots. server.js reads proactiveRefreshMinutes once at startup
    //    and does not even create the interval when it is 0, so a screenshot
    //    run can never rotate a token.
    // 2. Give the shell something to draw. An empty profile screenshots empty
    //    states, which proves nothing about the surfaces this restyle actually
    //    changes: rows, chips, status dots, provider identity and the sessions
    //    table. The fixture is fully deterministic (fixed ids, fixed names, no
    //    timestamps that move) so two phases produce comparable pictures.
    fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify(buildFixture(), null, 2) + '\n', 'utf8');

    // Allow-listed environment: no inherited tokens, credentials or real homes.
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
        'screenshot harness server did not report readiness: ' +
        redactToken((stdout + '\n' + stderr).trim())
      ));
    }, 30000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('message', (message) => {
      if (!message || message.type !== 'ready' || typeof message.url !== 'string' || settled) return;
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.searchParams.has('token')) {
        fail(new Error('screenshot harness server reported an invalid startup URL'));
        return;
      }
      // Belt and braces on the one port that must never be touched: 3456 serves
      // a different checkout on this machine.
      if (parsed.port === '3456') {
        fail(new Error('refusing to drive port 3456: it serves the live checkout'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: message.url });
    });
    child.once('error', (error) => fail(error));
    child.on('exit', (code) => {
      if (settled) return;
      fail(new Error('screenshot harness server exited ' + code + ': ' + redactToken((stdout + '\n' + stderr).trim())));
    });
  });
}

/**
 * Stop the exact child this harness launched.
 *
 * @param {import('child_process').ChildProcess} child - Owned server child.
 * @returns {Promise<void>} Resolves once the child is gone.
 */
async function stopWorkbook(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForExit(child, 5000);
  try {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
  } catch (_) { /* the child may already be gone */ }
  if (await gracefulExit) return;
  const forcedExit = waitForExit(child, 5000);
  try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
  if (!(await forcedExit)) {
    throw new Error('owned screenshot harness server did not exit after forced termination');
  }
}

/**
 * Delete only the validated temporary directory this harness created.
 *
 * @param {string} sandbox - Candidate sandbox root.
 * @returns {void}
 */
function removeSandbox(sandbox) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(sandbox);
  assert.strictEqual(path.dirname(resolved), tempRoot, 'sandbox escaped the OS temp directory');
  assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX), 'sandbox prefix validation failed');
  fs.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Apply a chrome theme. Prefers the real chrome switch that P1.4 introduces and
 * falls back to the appearance choice, which is its closest analogue while the
 * app still themes itself with the 13 terminal palettes.
 *
 * @param {import('@playwright/test').Page} page - Live page.
 * @param {{chrome: string, appearance: string}} entry - Chrome matrix entry.
 * @returns {Promise<{applied: string, chromeAttr: string|null, themeAttr: string}>} What actually took effect.
 */
async function applyChrome(page, entry) {
  return page.evaluate(({ chrome, appearance }) => {
    let applied = 'appearance';
    if (window.cwm && typeof window.cwm.setChrome === 'function') {
      window.cwm.setChrome(chrome);
      applied = 'chrome';
    }
    if (window.cwm && typeof window.cwm.setTheme === 'function') {
      window.cwm.setTheme(appearance);
    }
    return {
      applied,
      chromeAttr: document.documentElement.dataset.chrome || null,
      themeAttr: document.documentElement.dataset.theme || '',
    };
  }, entry);
}

/**
 * Read the layout metrics every later phase gate asserts against.
 *
 * @param {import('@playwright/test').Page} page - Live page.
 * @returns {Promise<object>} Computed metrics.
 */
function readMetrics(page) {
  return page.evaluate(() => {
    const round = (value) => (typeof value === 'number' ? Math.round(value) : null);
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { width: round(box.width), height: round(box.height) };
    };
    const bodyStyle = getComputedStyle(document.body);

    // BUILD-CONTRACT 5.2, phase P2: "the count of elements carrying a shadow on
    // the default screen is in single digits; the sidebar, tables, panels and
    // terminal panes carry none". Counted rather than asserted by eye. Only
    // rendered elements count, so anything hidden or zero-sized is skipped.
    const shadowed = [];
    for (const el of document.querySelectorAll('*')) {
      if (!el.getClientRects().length) continue;
      const shadow = getComputedStyle(el).boxShadow;
      if (shadow && shadow !== 'none') {
        shadowed.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''));
      }
    }

    const sidebarEl = document.querySelector('#sidebar');
    const sidebarStyle = sidebarEl ? getComputedStyle(sidebarEl) : null;

    return {
      header: rect('.app-header'),
      sidebar: rect('#sidebar'),
      bodyColor: bodyStyle.color,
      bodyBackground: bodyStyle.backgroundColor,
      fontFamily: bodyStyle.fontFamily,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      radiusLiteralSample: getComputedStyle(document.querySelector('.btn') || document.body).borderRadius,
      shellMode: document.documentElement.dataset.uiShell || null,
      density: document.documentElement.dataset.density || null,
      viewMode: document.documentElement.dataset.viewMode || null,
      shadowedElementCount: shadowed.length,
      shadowedElements: shadowed,
      // The sidebar's right edge must be an INSET SHADOW, not a border
      // (BUILD-CONTRACT 1.9 C6). Reported as a number so a border creeping back
      // in is a visible diff rather than something someone has to notice.
      sidebarBorderRightWidth: sidebarStyle ? sidebarStyle.borderRightWidth : null,
      sidebarBoxShadow: sidebarStyle ? sidebarStyle.boxShadow : null,
    };
  });
}

/**
 * Probe for horizontal overflow at the four widths the P2 gate names, without
 * capturing a screenshot at any of them.
 *
 * The capture matrix is deliberately frozen at two viewports so any two phases
 * are directly comparable (P0.5). This walks the extra widths, reads the
 * document metric, and restores the caller's viewport before returning.
 *
 * @param {import('@playwright/test').Page} page - Live page.
 * @param {{width: number, height: number}} restore - Viewport to return to.
 * @returns {Promise<Array<{width: number, overflow: boolean, scrollWidth: number}>>} One row per width.
 */
async function probeHorizontalOverflow(page, restore) {
  const WIDTHS = [320, 768, 1024, 1440];
  const rows = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    rows.push(await page.evaluate((w) => ({
      width: w,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }), width));
  }
  await page.setViewportSize(restore);
  await page.waitForTimeout(250);
  return rows;
}

/**
 * Capture the whole matrix and verify every picture.
 *
 * @returns {Promise<void>} Resolves when the run is complete.
 */
async function run() {
  assert.strictEqual(
    process.platform,
    'win32',
    'the screenshot harness must run on Windows before creating state or starting services'
  );

  const outputDir = resolveOutputDir(process.argv.slice(2));
  fs.mkdirSync(outputDir, { recursive: true });

  const fetchHeadBefore = metadataFingerprint(FETCH_HEAD_PATH);
  const legacyConfigBefore = metadataFingerprint(LEGACY_CONFIG_PATH);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));

  let child = null;
  let browser = null;
  const manifest = {
    capturedAt: new Date().toISOString(),
    label: path.basename(outputDir),
    outputDir: outputDir.replace(/\\/g, '/'),
    viewports: VIEWPORTS,
    chromes: CHROMES,
    routes: ROUTES,
    shots: [],
    metrics: {},
  };

  try {
    const started = await startWorkbook(sandbox);
    child = started.child;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
      deviceScaleFactor: 1, // 1280x800 in CSS pixels must be 1280x800 in the PNG
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

    await page.goto(started.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token);

    const shell = await page.evaluate(() => ({
      title: document.title,
      loginHidden: document.getElementById('login-screen').hidden,
      appHidden: document.getElementById('app').hidden,
      urlHasToken: new URL(location.href).searchParams.has('token'),
      headAssets: Array.from(document.querySelectorAll('link[rel="stylesheet"], script[src]'))
        .map((el) => el.getAttribute('href') || el.getAttribute('src'))
        .filter((src) => src && src.includes('?v=')),
    }));
    assert.strictEqual(shell.loginHidden, true, 'the startup token must reveal the application shell');
    assert.strictEqual(shell.appHidden, false, 'the application shell must be visible after startup auth');
    assert.strictEqual(shell.urlHasToken, false, 'the startup token must be stripped from the address bar');

    // Cachebusters are compared against index.html on disk rather than pinned as
    // literals here. Pinning literals is exactly how the other browser harness
    // went stale (DECISIONS.md F1); this way a bump can never make the harness
    // wrong, only the source of truth can.
    const indexHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
    for (const asset of shell.headAssets) {
      assert.ok(
        indexHtml.includes(asset),
        'the served asset ' + asset + ' does not match index.html on disk'
      );
    }

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const chrome of CHROMES) {
        const applied = await applyChrome(page, chrome);
        for (const route of ROUTES) {
          await page.evaluate((mode) => window.cwm.setViewMode(mode), route.mode);
          // Two frames plus the 200ms fade-out is the longest transition in the
          // current sheet, so the paint is settled before the shutter.
          await page.waitForTimeout(350);

          const name = [viewport.id, chrome.id, route.id].join('-') + '.png';
          const file = path.join(outputDir, name);
          await page.screenshot({ path: file, fullPage: false });

          const dims = pngDimensions(file);
          assert.ok(
            dims.width <= ABSOLUTE_MAX_DIM && dims.height <= ABSOLUTE_MAX_DIM,
            'captured PNG exceeds ' + ABSOLUTE_MAX_DIM + 'px (' + dims.width + 'x' + dims.height + '): ' + file
          );
          assert.strictEqual(dims.width, viewport.width, 'PNG width must equal the CSS viewport width: ' + file);
          assert.strictEqual(dims.height, viewport.height, 'PNG height must equal the CSS viewport height: ' + file);
          assert.ok(dims.bytes > MIN_PNG_BYTES, 'captured PNG is suspiciously small: ' + file);

          const metrics = await readMetrics(page);
          assert.strictEqual(
            metrics.horizontalOverflow,
            false,
            'the shell must not scroll horizontally at ' + viewport.width + 'px (' + name + ')'
          );

          manifest.shots.push({
            name,
            viewport: viewport.id,
            chrome: chrome.id,
            route: route.id,
            width: dims.width,
            height: dims.height,
            bytes: dims.bytes,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
            chromeMechanism: applied.applied,
            chromeAttr: applied.chromeAttr,
            themeAttr: applied.themeAttr,
            metrics,
          });
          console.log('  captured ' + name + '  ' + dims.width + 'x' + dims.height +
            '  ' + Math.round(dims.bytes / 1024) + 'KB  theme=' + applied.themeAttr +
            (applied.chromeAttr ? ' chrome=' + applied.chromeAttr : ''));
        }
      }
    }

    // Opt-in region shots. Desktop only, both chromes, into regions/, recorded
    // under their own manifest key so the standard shot list is unchanged.
    if (process.argv.includes('--regions')) {
      const regionDir = path.join(outputDir, 'regions');
      fs.mkdirSync(regionDir, { recursive: true });
      manifest.regionShots = [];
      await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
      for (const chrome of CHROMES) {
        const applied = await applyChrome(page, chrome);
        for (const region of REGION_ROUTES) {
          // A region may pin itself to one chrome, which is how the two-axis
          // proof shot avoids being captured twice with the same meaning.
          if (region.chromeOnly && region.chromeOnly !== chrome.id) continue;
          await region.apply(page);
          await page.waitForTimeout(400);
          const name = ['desktop', chrome.id, region.id].join('-') + '.png';
          const file = path.join(regionDir, name);
          await page.screenshot({ path: file, fullPage: false });
          const dims = pngDimensions(file);
          assert.ok(
            dims.width <= ABSOLUTE_MAX_DIM && dims.height <= ABSOLUTE_MAX_DIM,
            'captured PNG exceeds ' + ABSOLUTE_MAX_DIM + 'px: ' + file
          );
          assert.ok(dims.bytes > MIN_PNG_BYTES, 'captured region PNG is suspiciously small: ' + file);
          // Read the LIVE attributes and grounds rather than reusing the ones
          // applyChrome reported, because a region may change either (the
          // two-axis proof shot deliberately does). Recording them is what
          // turns "the picture looks dark" into a number somebody can act on.
          const state = await page.evaluate(() => {
            const root = document.documentElement;
            const pane = document.querySelector('.terminal-pane:not(.terminal-pane-empty) .terminal-container');
            const sidebar = document.querySelector('#sidebar');
            const styleOf = (el) => (el ? getComputedStyle(el).backgroundColor : null);
            return {
              chromeAttr: root.dataset.chrome || null,
              themeAttr: root.dataset.theme || null,
              themeChoiceAttr: root.dataset.themeChoice || null,
              uiShellAttr: root.dataset.uiShell || null,
              bodyBackground: getComputedStyle(document.body).backgroundColor,
              sidebarBackground: styleOf(sidebar),
              terminalBackground: styleOf(pane),
              termBgVar: getComputedStyle(root).getPropertyValue('--term-bg').trim() || null,
              termAccentVar: getComputedStyle(root).getPropertyValue('--term-accent').trim() || null,
              appBgPrimary: getComputedStyle(root).getPropertyValue('--app-bg-primary').trim() || null,
            };
          });
          manifest.regionShots.push({
            name, chrome: chrome.id, region: region.id,
            width: dims.width, height: dims.height, bytes: dims.bytes,
            themeAttr: state.themeAttr, chromeAttr: state.chromeAttr,
            state,
          });
          console.log('    state ' + JSON.stringify(state));
          console.log('  captured regions/' + name + '  ' + dims.width + 'x' + dims.height +
            '  ' + Math.round(dims.bytes / 1024) + 'KB');
          // A region that opened something live tears it down itself, so the
          // next region in the loop never inherits a PTY, a socket or a pane.
          if (typeof region.cleanup === 'function') {
            await region.cleanup(page);
            await page.waitForTimeout(200);
          }
        }
        // Leave the shell in a neutral state before the next chrome pass, so an
        // open settings overlay never leaks into the following capture.
        await page.evaluate(() => {
          if (window.cwm.closeSettings) window.cwm.closeSettings();
          if (window.cwm.deselectSession) window.cwm.deselectSession();
          window.cwm.setViewMode('workspace');
        });
      }
    }

    // One metric block per viewport and chrome, hoisted out of the shot list so
    // a later phase can diff numbers without parsing image names.
    for (const shot of manifest.shots) {
      manifest.metrics[shot.viewport + '/' + shot.chrome + '/' + shot.route] = shot.metrics;
    }

    // BUILD-CONTRACT 5.2 phase P2: "Nothing scrolls horizontally at 320, 768,
    // 1024, 1440." The capture matrix stays at two viewports so phases remain
    // comparable, so the extra widths are probed rather than photographed.
    manifest.horizontalOverflowProbe = await probeHorizontalOverflow(page, {
      width: VIEWPORTS[0].width,
      height: VIEWPORTS[0].height,
    });
    const overflowing = manifest.horizontalOverflowProbe.filter((row) => row.overflow);
    assert.deepStrictEqual(
      overflowing,
      [],
      'the shell scrolls horizontally at: ' + overflowing.map((r) => r.width + 'px').join(', ')
    );

    assert.deepStrictEqual(pageErrors, [], 'the application raised browser errors during capture');

    // Google Fonts is the one external origin the app requests today. P1.2
    // removes it, and this assertion is what proves it: after P1.2 the list must
    // be empty, and until then it must contain nothing else.
    const unexpectedExternalRequests = blockedExternalRequests.filter((requestUrl) => (
      !requestUrl.startsWith('https://fonts.googleapis.com/') &&
      !requestUrl.startsWith('https://fonts.gstatic.com/')
    ));
    assert.deepStrictEqual(
      unexpectedExternalRequests,
      [],
      'the application attempted an unexpected external request: ' + unexpectedExternalRequests.join(', ')
    );
    manifest.externalRequests = [...new Set(blockedExternalRequests)];

    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8'
    );

    console.log('\nPASS notion-shell screenshot harness');
    console.log('  ' + manifest.shots.length + ' screenshots, all within ' + ABSOLUTE_MAX_DIM + 'px on both axes');
    console.log('  output: ' + manifest.outputDir);
    console.log('  external origins requested (all blocked): ' +
      (manifest.externalRequests.length ? manifest.externalRequests.join(', ') : 'none'));
    console.log('  no real profile, credential, session or provider state was used');
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
            'the screenshot harness changed .git/FETCH_HEAD'
          );
          assert.deepStrictEqual(
            metadataFingerprint(LEGACY_CONFIG_PATH),
            legacyConfigBefore,
            'the screenshot harness touched the clone-local legacy config'
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
  console.error('FAIL notion-shell screenshot harness');
  console.error(redactToken(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
