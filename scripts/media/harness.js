#!/usr/bin/env node
/**
 * harness.js - the sandboxed application the marketing capture films.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHAT THIS IS
 *
 * A capture run needs the same three things every browser proof in test/browser/
 * needs: a disposable profile, a server bound to a port the OS picked, and a
 * browser pointed at it. This is that setup, factored out so capture.js and
 * stills.js share one implementation and one teardown path rather than two
 * slightly different ones.
 *
 * It is a sibling of test/browser/notion-shell.spec.js by design, not a new
 * invention, and it reuses that file's child server verbatim
 * (test/browser/workbook-shell-server.js). That server is the proven one: it
 * binds port 0, reports its URL over IPC, and shuts down on a message. Nothing
 * in notion-shell.spec.js is modified by this file.
 *
 * SAFETY, and why each rule is here rather than "probably fine"
 *
 *   - EPHEMERAL PORT, NEVER 3456. Port 3456 serves a different checkout on the
 *     build machine under a scheduled task. Binding it would take the operator's
 *     live workbook down mid-shoot. The child asks the OS for a port and this
 *     file refuses the URL if it ever comes back as 3456.
 *   - NO REAL PROFILE. USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and TMP all
 *     point inside the sandbox, and so do CWM_DATA_DIR, CWM_CLAUDE_DIR,
 *     CWM_CLAUDE_PROJECTS_DIR and CODEX_HOME. Provider discovery therefore
 *     cannot reach a real session even if a code path forgot to honour one of
 *     them: it would have to defeat all of them at once.
 *   - NO CREDENTIAL TRAFFIC. CWM_CRED_EXTERNAL_BRIDGE_OWNER=1 and
 *     CWM_CRED_DISABLE_MAC=1 are set, and the seeded store carries
 *     proactiveRefreshMinutes: 0, which the server reads once at startup and
 *     then never creates the sweep interval at all. A token cannot rotate while
 *     the camera is running.
 *   - NO NETWORK. CWM_TEST_HERMETIC_UI=1 removes the git fetch behind
 *     /api/version, the self-update route and the Cloudflare tunnel probe, and
 *     the browser context blocks every non-loopback request.
 *   - OWNED TEARDOWN ONLY. The server child is stopped by pid, never by name,
 *     and the sandbox is deleted only after its path is validated as a
 *     directory this process created inside the OS temp root.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/harness
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

const { writeFixture } = require('./fixture');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** The proven child server. Reused as-is; this file never modifies it. */
const SERVER_PATH = path.join(PROJECT_ROOT, 'test', 'browser', 'workbook-shell-server.js');

/** Every sandbox directory carries this prefix, and teardown checks for it. */
const TEMP_PREFIX = 'myrlin-media-';

/** The one port that must never be bound. It serves the live checkout. */
const FORBIDDEN_PORT = '3456';

/** How long to wait for the child server to report readiness, in milliseconds. */
const SERVER_READY_TIMEOUT_MS = 45000;

/** How long to wait for a graceful shutdown before escalating, in milliseconds. */
const SHUTDOWN_GRACE_MS = 5000;

/** How long to wait for the SPA to finish booting, in milliseconds. */
const APP_BOOT_TIMEOUT_MS = 45000;

/**
 * localStorage keys that mark a one-time onboarding card as already dismissed.
 *
 * @see openApp for why a capture sets them.
 */
const ONBOARDING_FLAGS = Object.freeze(['cwm_copyhint_v1']);

/**
 * The pane command. Forward slashes only: pty-server.js's isSafeCommand
 * rejects a backslash outright, so a Windows path has to be normalised before
 * it can reach a spawn.
 */
const FAKE_AGENT_COMMAND = 'node ' + path.join(__dirname, 'fake-agent.js').replace(/\\/g, '/');

/**
 * Create the disposable sandbox root.
 *
 * @returns {string} Absolute path to a fresh directory inside the OS temp root.
 */
function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
}

/**
 * Delete only a directory this module created.
 *
 * Two assertions rather than one, because the argument is the thing being
 * recursively deleted and a typo here is unrecoverable: the path must sit
 * directly inside the OS temp root AND carry the prefix.
 *
 * @param {string} sandbox - Candidate sandbox root.
 * @returns {void}
 */
function removeSandbox(sandbox) {
  if (!sandbox) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(sandbox);
  assert.strictEqual(path.dirname(resolved), tempRoot, 'sandbox escaped the OS temp directory');
  assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX), 'sandbox prefix validation failed');
  fs.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Remove anything token-shaped from text on its way to a log.
 *
 * @param {string} value - Diagnostic text.
 * @returns {string} The same text with token values replaced.
 */
function redactToken(value) {
  return String(value || '').replace(/token=[A-Za-z0-9._-]+/g, 'token=REDACTED');
}

/**
 * Wait for a child process to exit.
 *
 * @param {import('child_process').ChildProcess} child - The child.
 * @param {number} timeoutMs - How long to wait.
 * @returns {Promise<boolean>} True when it exited inside the window.
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Spawn the sandboxed server and wait for its one-use URL.
 *
 * @param {object} paths - The directories writeFixture produced.
 * @returns {Promise<{child: import('child_process').ChildProcess, url: string}>} Owned child and URL.
 */
function startServer(paths) {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(paths.root, 'temp');
    const appData = path.join(paths.profileDir, 'AppData', 'Roaming');
    const localAppData = path.join(paths.profileDir, 'AppData', 'Local');
    const emptySeed = path.join(paths.root, 'empty-seed');
    for (const dir of [tempDir, appData, localAppData, emptySeed]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Allow-listed environment. Nothing is inherited except the handful of
    // Windows variables a Node child cannot start without.
    const childEnv = {
      CWM_DATA_DIR: paths.dataDir,
      CWM_CLAUDE_DIR: path.join(paths.profileDir, '.claude'),
      CWM_CLAUDE_JSON: path.join(paths.profileDir, '.claude.json'),
      // The override added for this pipeline. USERPROFILE already redirects
      // os.homedir() on Windows, so this is the second independent lock rather
      // than the only one, and it is what makes the sandbox hold on a platform
      // where homedir resolves differently.
      CWM_CLAUDE_PROJECTS_DIR: paths.claudeProjectsDir,
      CODEX_HOME: paths.codexHome,
      CWM_CRED_SEED_DIR: emptySeed,
      CWM_CRED_EXTERNAL_BRIDGE_OWNER: '1',
      CWM_CRED_DISABLE_MAC: '1',
      CWM_TEST_HERMETIC_UI: '1',
      CWM_NO_OPEN: '1',
      CWM_PASSWORD: crypto.randomUUID(),
      USERPROFILE: paths.profileDir,
      HOME: paths.profileDir,
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
      clearTimeout(timer);
      stopServer(child).then(() => reject(error), () => reject(error));
    };

    const timer = setTimeout(() => {
      fail(new Error('media harness server did not report readiness: ' +
        redactToken((stdout + '\n' + stderr).trim())));
    }, SERVER_READY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('message', (message) => {
      if (settled || !message || message.type !== 'ready' || typeof message.url !== 'string') return;
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.searchParams.has('token')) {
        fail(new Error('media harness server reported an invalid startup URL'));
        return;
      }
      if (parsed.port === FORBIDDEN_PORT) {
        fail(new Error('refusing to drive port ' + FORBIDDEN_PORT + ': it serves the live checkout'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ child, url: message.url });
    });

    child.once('error', (error) => fail(error));
    child.on('exit', (code) => {
      if (settled) return;
      fail(new Error('media harness server exited ' + code + ': ' +
        redactToken((stdout + '\n' + stderr).trim())));
    });
  });
}

/**
 * Stop the exact child this module launched, by pid.
 *
 * Never by process name. A blanket kill on this machine takes the operator's
 * editor and every other Node process with it.
 *
 * @param {import('child_process').ChildProcess} child - Owned server child.
 * @returns {Promise<void>} Resolves once the child is gone.
 */
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const graceful = waitForExit(child, SHUTDOWN_GRACE_MS);
  try {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
  } catch (_) { /* already gone */ }
  if (await graceful) return;
  const forced = waitForExit(child, SHUTDOWN_GRACE_MS);
  try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
  await forced;
}

/**
 * Stand the whole thing up: sandbox, fixture, server, browser.
 *
 * @param {{now?: number, headless?: boolean}} [opts] - Fixture instant and browser mode.
 * @returns {Promise<object>} A session handle with a close() that tears everything down.
 */
async function launch(opts) {
  const options = opts || {};
  const sandbox = makeSandbox();
  let paths = null;
  let server = null;
  let browser = null;

  try {
    paths = await writeFixture({ root: sandbox, now: options.now });
    server = await startServer(paths);
    browser = await chromium.launch({
      headless: options.headless !== false,
      // The default viewport is set per context; these flags only remove the
      // two things that would otherwise appear in a frame.
      args: ['--hide-scrollbars', '--force-color-profile=srgb'],
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server.child);
    removeSandbox(sandbox);
    throw error;
  }

  return {
    sandbox,
    paths,
    url: server.url,
    // Filled in by the first openApp(), then presented by every context after
    // it. See the single-use note in openApp().
    authToken: null,
    browser,
    fixture: paths.fixture,
    fakeAgentCommand: FAKE_AGENT_COMMAND,

    /**
     * Tear down everything this handle owns, in the reverse of creation order.
     *
     * @returns {Promise<void>} Resolves once nothing is left running.
     */
    async close() {
      try { await browser.close(); } catch (_) { /* already closed */ }
      await stopServer(server.child);
      removeSandbox(sandbox);
    },
  };
}

/**
 * Wait until the terminal tab-group state exists.
 *
 * `initTerminalGroups()` runs during boot, awaits a layout fetch, and only then
 * assigns `_tabGroups` and `_activeGroupId`. `openTerminalInPane` immediately
 * calls `saveCurrentGroupPanes`, which reads `_tabGroups.find(...)` and throws a
 * TypeError if the fetch has not landed. Rejecting rather than resolving lets
 * the caller decide whether that matters.
 *
 * @param {object} page - Playwright page.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves once the layout state exists.
 */
function waitForTerminalGroups(page, timeoutMs) {
  return page.waitForFunction(
    () => !!(window.cwm && Array.isArray(window.cwm._tabGroups) && window.cwm._activeGroupId),
    { timeout: timeoutMs || APP_BOOT_TIMEOUT_MS }
  );
}

/**
 * Open a page on the running app and wait for the shell to finish booting.
 *
 * The startup URL carries a one-use token, so the SPA authenticates itself and
 * never shows the login form. `window.cwm.state.token` is the boot signal every
 * proven browser test in this repository waits on.
 *
 * @param {object} session - A handle from launch().
 * @param {object} contextOptions - Playwright browser-context options.
 * @returns {Promise<{context: object, page: object}>} The context and its page.
 */
async function openApp(session, contextOptions) {
  const context = await session.browser.newContext(Object.assign({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  }, contextOptions || {}));

  // Nothing outside loopback may be reached from a capture. A font or an
  // analytics beacon loading mid-shoot would put a network stall in the footage
  // and, worse, would mean the frame depends on somebody else's server.
  //
  // The same handler also patches the discovery payload. WHY, and why here:
  //
  // The fixture's working directories are invented (`D:/work/...`) so that no
  // real path from the build machine can appear in a frame. `/api/discover`
  // stats each one and reports `dirExists: false` for a path that is not on
  // disk, and the sidebar renders a missing project at `opacity: 0.4` with a
  // "missing" badge. Every project row in the footage would be greyed out.
  //
  // The alternatives were worse. Creating the directories for real means the
  // path on screen becomes a temporary directory inside the operator's profile,
  // which puts their user name in a public README and breaks the contract's
  // first ground rule. Patching the client's state object instead of the
  // response would be undone by the next loadProjects() refetch, and a capture
  // triggers several. Rewriting the response is the one place the change
  // survives every refetch and touches nothing on disk.
  //
  // This is presentation state, exactly like the seeded "running" statuses in
  // test/browser/notion-shell.spec.js: it changes how an invented world looks,
  // never what the application does.
  await context.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    const local = target.hostname === '127.0.0.1' || target.hostname === 'localhost';
    if (!local && target.protocol !== 'data:' && target.protocol !== 'blob:') return route.abort();
    if (!local || !target.pathname.startsWith('/api/discover')) return route.continue();

    let response;
    try {
      response = await route.fetch();
    } catch (_) {
      return route.continue();
    }
    let body;
    try {
      body = await response.json();
    } catch (_) {
      return route.fulfill({ response });
    }
    for (const list of Object.values((body && body.projects) || {})) {
      if (!Array.isArray(list)) continue;
      for (const project of list) project.dirExists = true;
    }
    return route.fulfill({ response, body: JSON.stringify(body) });
  });

  // THE STARTUP TOKEN IS SINGLE USE. auth.js marks it consumed on the first
  // exchange, so the second context of a shoot navigates to the same URL and
  // lands on the login form instead of the app, and every wait below times out.
  //
  // The fix is the same one a person gets for free: the first context trades
  // the startup token for a session token, and every context after it presents
  // that session token out of localStorage, which is exactly where the
  // application itself keeps it. Nothing is bypassed; the login simply is not
  // performed eleven times.
  if (session.authToken) {
    await context.addInitScript((token) => {
      try { window.localStorage.setItem('cwm_token', token); } catch (_) { /* first paint */ }
    }, session.authToken);
  }

  // Mark the one-time onboarding cards as already seen.
  //
  // `_maybeShowCopyHint` in terminal.js pops a 248px card over the top right of
  // the first terminal pane a browser profile ever opens, explaining Shift-drag
  // and Select mode, and it stays for fourteen seconds. Every capture runs in a
  // brand new browser profile, so EVERY take drew that card across the pane it
  // was filming. The flag is the same one the card sets when a person dismisses
  // it, so this is "shoot as a returning user", not a suppression: a first-run
  // hint is not what the feature clip is about.
  await context.addInitScript((flags) => {
    try {
      for (const key of flags) window.localStorage.setItem(key, '1');
    } catch (_) { /* storage unavailable before first paint */ }
  }, ONBOARDING_FLAGS);

  const page = await context.newPage();
  const target = session.authToken ? new URL(session.url).origin + '/' : session.url;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token, {
    timeout: APP_BOOT_TIMEOUT_MS,
  });
  if (!session.authToken) {
    session.authToken = await page.evaluate(() => window.cwm.state.token);
  }
  await page.waitForSelector('#app:not([hidden])', { timeout: APP_BOOT_TIMEOUT_MS });
  // initTerminalGroups() is async and fetches the saved layout. Opening a pane
  // before it resolves throws inside saveCurrentGroupPanes, because
  // `_tabGroups` is still undefined.
  //
  // Waited for here rather than in each scene, but NOT fatal: on a phone
  // viewport the terminal grid is not part of the first paint and the layout
  // fetch can settle later or not at all, and a still of the Sessions tab does
  // not care. Scenes that open a pane wait for it again, where it does matter.
  await waitForTerminalGroups(page).catch(() => { /* no pane scene will run, or it re-waits */ });
  // Webfonts settle before anything is photographed. A frame captured mid-swap
  // shows fallback glyphs, which is the exact silent failure the research
  // flagged as the worst class of bug for a brand asset.
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

module.exports = {
  FAKE_AGENT_COMMAND,
  ONBOARDING_FLAGS,
  waitForTerminalGroups,
  FORBIDDEN_PORT,
  TEMP_PREFIX,
  PROJECT_ROOT,
  makeSandbox,
  removeSandbox,
  redactToken,
  startServer,
  stopServer,
  launch,
  openApp,
};
