#!/usr/bin/env node
/**
 * Round 1 post-launch gate: terminal panes recover from a token invalidation.
 *
 * THE BUG THIS FILE EXISTS FOR. Auth tokens live in an in-memory Set on the
 * server (src/web/auth.js), so every server restart invalidates every token
 * that was ever issued. The SPA recovered on its own, because its api() 401
 * branch clears localStorage and shows the login screen. Terminal panes did
 * not: connect() read localStorage directly, and when the SPA had already
 * cleared the key the pane printed "No auth token. Please log in again." and
 * RETURNED. Nothing re-armed it, so after a deploy every open pane showed
 * "Connecting to session..." followed by that red line, and a successful
 * re-login left them dead until a full page reload.
 *
 * The contract this file locks:
 *   1. ONE token source. terminal.js resolves through TerminalPane
 *      .getAuthToken() (app state first, storage second) and the storage key
 *      it names is the same literal app.js writes at login.
 *   2. ONE event name. app.js dispatches 'cwm:auth-ready' after every
 *      successful authentication; terminal.js listens for exactly that.
 *   3. NO dead end. A missing token parks the pane on that event instead of
 *      returning, and the listener is single (never stacked) and removed on
 *      dispose.
 *   4. NO retry storm. A socket that closed without ever opening is the
 *      signature of a rejected upgrade; when the token is already gone the
 *      pane parks instead of walking the ten-step reconnect ladder, and when
 *      the token is still present it asks the app to validate ONCE.
 *
 * Approach follows the executed-extraction idiom used by provider-tabs.test.js
 * and paste-input-preparation.test.js: source-string assertions for the wiring
 * that cannot be executed without a DOM, plus a real extraction of the static
 * auth helpers evaluated against fakes so the precedence and the debounce are
 * proved by execution rather than by regex.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const terminalSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'terminal.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

let passed = 0;
let failed = 0;
const queue = [];

/**
 * Register a named assertion. Queued so output order is deterministic.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void|Promise<void>} fn Function that throws on failure.
 */
function check(name, fn) {
  queue.push({ name, fn });
}

async function runQueue() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + err.message + '\x1b[0m');
    }
  }
}

console.log('\n  \x1b[1mRound 1: terminal auth recovery\x1b[0m');
console.log('  ' + '─'.repeat(42));

// ───────────────────────────────────────────────────────────────────────
// SECTION A: one token source, one event name
// ───────────────────────────────────────────────────────────────────────

check('terminal.js names the auth storage key as a static constant', () => {
  assert.ok(
    /static\s+AUTH_TOKEN_STORAGE_KEY\s*=\s*'cwm_token'/.test(terminalSrc),
    'TerminalPane.AUTH_TOKEN_STORAGE_KEY must be the literal cwm_token'
  );
});

check('app.js writes the same storage key terminal.js reads', () => {
  assert.ok(
    /localStorage\.setItem\(\s*'cwm_token'\s*,\s*data\.token\s*\)/.test(appSrc),
    'the login flow must persist the token under cwm_token'
  );
});

check('terminal.js and app.js agree on the auth-ready event name', () => {
  assert.ok(
    /static\s+AUTH_READY_EVENT\s*=\s*'cwm:auth-ready'/.test(terminalSrc),
    'TerminalPane.AUTH_READY_EVENT must be cwm:auth-ready'
  );
  assert.ok(
    /new\s+CustomEvent\(\s*'cwm:auth-ready'/.test(appSrc),
    'app.js must dispatch a cwm:auth-ready CustomEvent'
  );
});

check('connect() resolves its token through the unified accessor', () => {
  assert.ok(
    /const\s+token\s*=\s*TerminalPane\.getAuthToken\(\)/.test(terminalSrc),
    'connect() must call TerminalPane.getAuthToken(), not read storage inline'
  );
  // The pre-fix inline read must not come back.
  assert.ok(
    !/const\s+token\s*=\s*localStorage\.getItem\(\s*'cwm_token'\s*\)/.test(terminalSrc),
    'connect() must not read localStorage directly for the attach token'
  );
});

// ───────────────────────────────────────────────────────────────────────
// SECTION B: no dead end, no storm
// ───────────────────────────────────────────────────────────────────────

check('a missing token parks the pane instead of dead-ending', () => {
  assert.ok(/_waitForAuth\(\)\s*\{/.test(terminalSrc), '_waitForAuth must be declared');
  const connectIdx = terminalSrc.indexOf('  connect() {');
  assert.ok(connectIdx > -1, 'connect() declaration not found');
  const window = terminalSrc.slice(connectIdx, connectIdx + 3000);
  assert.ok(
    /if\s*\(!token\)\s*\{[\s\S]{0,600}?this\._waitForAuth\(\);/.test(window),
    'connect() must route a missing token into _waitForAuth()'
  );
  // The status line itself must be gone. The phrase survives inside the
  // comment that explains the bug, which is why the assertion is scoped to
  // the _status call rather than to the whole file.
  assert.ok(
    !/_status\(\s*'No auth token/.test(terminalSrc),
    'the dead-end red status must no longer be written to the pane'
  );
});

check('_waitForAuth arms exactly one listener and cannot stack handlers', () => {
  const idx = terminalSrc.indexOf('_waitForAuth() {');
  assert.ok(idx > -1, '_waitForAuth body not found');
  const body = terminalSrc.slice(idx, idx + 2200);
  assert.ok(/if\s*\(this\._authReadyHandler/.test(body), 'must early-return when already armed');
  assert.ok(
    /addEventListener\(TerminalPane\.AUTH_READY_EVENT/.test(body),
    'must subscribe to AUTH_READY_EVENT'
  );
  assert.ok(
    /removeEventListener\(TerminalPane\.AUTH_READY_EVENT/.test(body),
    'the handler must unsubscribe itself before reconnecting'
  );
  assert.ok(/this\._reconnectAttempts\s*=\s*0/.test(body), 'a fresh login must reset the ladder');
  assert.ok(/this\.connect\(\)/.test(body), 'the handler must retry the attach');
});

check('a rejected upgrade parks rather than walking the reconnect ladder', () => {
  const idx = terminalSrc.indexOf('this.ws.onclose = (event) => {');
  assert.ok(idx > -1, 'onclose handler not found');
  const body = terminalSrc.slice(idx, idx + 3200);
  assert.ok(
    /if\s*\(!this\._sawOpenThisAttempt\)\s*\{/.test(body),
    'onclose must branch on whether the socket ever opened'
  );
  assert.ok(
    /if\s*\(!TerminalPane\.getAuthToken\(\)\)\s*\{[\s\S]{0,400}?this\._waitForAuth\(\);[\s\S]{0,200}?return;/.test(body),
    'a closed-before-open socket with no token must park and return'
  );
  assert.ok(
    /TerminalPane\.requestReauthOnce\(\)/.test(body),
    'a closed-before-open socket with a token must probe re-auth once'
  );
  // The branch must sit BEFORE the ladder so the ladder cannot run first.
  assert.ok(
    body.indexOf('_sawOpenThisAttempt') < body.indexOf('this._reconnectAttempts <'),
    'the auth branch must precede the reconnect ladder'
  );
});

check('onopen retires both auth flags', () => {
  const idx = terminalSrc.indexOf('this.ws.onopen = () => {');
  assert.ok(idx > -1, 'onopen handler not found');
  const body = terminalSrc.slice(idx, idx + 1200);
  assert.ok(/this\._sawOpenThisAttempt\s*=\s*true/.test(body), 'onopen must record the open');
  assert.ok(/this\._awaitingAuth\s*=\s*false/.test(body), 'onopen must clear the parked flag');
});

check('dispose removes the auth listener so a dead pane cannot resurrect', () => {
  assert.ok(
    /if\s*\(this\._authReadyHandler\)\s*\{[\s\S]{0,300}?removeEventListener\(TerminalPane\.AUTH_READY_EVENT/.test(terminalSrc),
    'the teardown path must remove the auth-ready listener'
  );
});

// ───────────────────────────────────────────────────────────────────────
// SECTION C: app.js announces on every successful authentication
// ───────────────────────────────────────────────────────────────────────

check('_announceAuthReady is declared and called from all three auth paths', () => {
  assert.ok(/_announceAuthReady\(\)\s*\{/.test(appSrc), '_announceAuthReady must be declared');
  const calls = appSrc.match(/this\._announceAuthReady\(\)/g) || [];
  assert.ok(
    calls.length >= 3,
    'password login, startup-token login and the validated stored token must all announce; found ' + calls.length
  );
});

check('the password-login path announces before _initializeApp', () => {
  const idx = appSrc.indexOf("const data = await this.api('POST', '/api/auth/login'");
  assert.ok(idx > -1, 'login() body not found');
  const body = appSrc.slice(idx, idx + 900);
  const announceIdx = body.indexOf('this._announceAuthReady()');
  const initIdx = body.indexOf('await this._initializeApp()');
  assert.ok(announceIdx > -1 && initIdx > -1, 'both calls must be present in login()');
  assert.ok(announceIdx < initIdx, 'the announcement must precede the shell rebuild');
});

// ───────────────────────────────────────────────────────────────────────
// SECTION D: EXECUTED. The static helpers, evaluated against fakes.
// ───────────────────────────────────────────────────────────────────────

/**
 * Extract the auth statics from terminal.js and evaluate them as a standalone
 * class, the same trick provider-tabs.test.js uses for the tab strip: the real
 * class needs xterm and a DOM, the helpers need neither.
 *
 * @returns {Function} A class carrying the extracted static members.
 */
function buildAuthStatics() {
  const start = terminalSrc.indexOf('  static AUTH_TOKEN_STORAGE_KEY');
  assert.ok(start > -1, 'AUTH_TOKEN_STORAGE_KEY block not found');
  const probeIdx = terminalSrc.indexOf('static requestReauthOnce()', start);
  assert.ok(probeIdx > -1, 'requestReauthOnce declaration not found');
  const openBrace = terminalSrc.indexOf('{', probeIdx);
  let depth = 1;
  let i = openBrace + 1;
  while (i < terminalSrc.length && depth > 0) {
    const ch = terminalSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  const body = terminalSrc.slice(start, i);
  // eslint-disable-next-line no-new-func
  return new Function('class TerminalPane {\n' + body + '\n}\nreturn TerminalPane;\n')();
}

/**
 * Run fn with fake window/localStorage globals, then restore them.
 *
 * @param {object} opts Fake state: {appToken, storedToken, checkAuth}.
 * @param {(T:Function) => void} fn Test body receiving the extracted class.
 */
function withFakeGlobals(opts, fn) {
  const origWindow = global.window;
  const origLS = global.localStorage;
  const store = {};
  if (opts.storedToken) store.cwm_token = opts.storedToken;
  global.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  global.window = {
    cwm: {
      state: { token: opts.appToken || null },
      checkAuth: opts.checkAuth || (() => Promise.resolve(true)),
    },
  };
  try {
    fn(buildAuthStatics());
  } finally {
    global.window = origWindow;
    global.localStorage = origLS;
  }
}

check('EXECUTED: getAuthToken prefers live app state over stored storage', () => {
  withFakeGlobals({ appToken: 'fresh-token', storedToken: 'stale-token' }, (T) => {
    assert.strictEqual(T.getAuthToken(), 'fresh-token');
  });
});

check('EXECUTED: getAuthToken falls back to storage when app state is empty', () => {
  withFakeGlobals({ appToken: null, storedToken: 'stored-token' }, (T) => {
    assert.strictEqual(T.getAuthToken(), 'stored-token');
  });
});

check('EXECUTED: getAuthToken returns null when neither source has a token', () => {
  withFakeGlobals({ appToken: null, storedToken: null }, (T) => {
    assert.strictEqual(T.getAuthToken(), null);
  });
});

check('EXECUTED: getAuthToken survives a throwing storage (private mode)', () => {
  const origWindow = global.window;
  const origLS = global.localStorage;
  global.window = { cwm: null };
  global.localStorage = { getItem() { throw new Error('SecurityError'); } };
  try {
    const T = buildAuthStatics();
    assert.strictEqual(T.getAuthToken(), null, 'a throwing storage must read as unauthenticated');
  } finally {
    global.window = origWindow;
    global.localStorage = origLS;
  }
});

check('EXECUTED: requestReauthOnce debounces to one probe per cooldown', () => {
  let probes = 0;
  withFakeGlobals({
    appToken: null,
    storedToken: null,
    checkAuth: () => { probes++; return Promise.resolve(false); },
  }, (T) => {
    T.requestReauthOnce();
    T.requestReauthOnce();
    T.requestReauthOnce();
    assert.strictEqual(probes, 1, 'ten panes noticing one restart must produce one prompt');
    // Wind the clock past the cooldown; the next call is allowed through.
    T._lastReauthProbeAt = Date.now() - (T.REAUTH_PROBE_COOLDOWN_MS + 1);
    T.requestReauthOnce();
    assert.strictEqual(probes, 2, 'a probe is allowed again after the cooldown');
  });
});

check('EXECUTED: requestReauthOnce never throws when the app is not mounted', () => {
  const origWindow = global.window;
  global.window = undefined;
  try {
    const T = buildAuthStatics();
    T.requestReauthOnce();
  } finally {
    global.window = origWindow;
  }
});

(async () => {
  await runQueue();
  console.log('\n  ' + '─'.repeat(42));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('  ' + '─'.repeat(42) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
