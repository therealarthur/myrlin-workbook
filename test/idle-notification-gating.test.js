#!/usr/bin/env node
/**
 * Notification-storm fix: idle-notification gating in terminal.js + app.js.
 *
 * Bug: "this terminal needs your input" toasts and dings fired on every
 * tab switch and output burst, even for panes the user had already viewed.
 * Root causes (see commit message on fix/notification-storm):
 *   1. Level-triggered re-arm: ANY output byte reset _idleNotified, so the
 *      once-per-cycle guard was dead code.
 *   2. Scrollback replay after (re)connect flowed through the detector.
 *   3. No focus acknowledgement and a stale _activeTerminalSlot after
 *      switchTerminalGroup meant visible panes still notified.
 *   4. _playNotificationSound had no cooldown and leaked AudioContexts.
 *
 * This test loads terminal.js in a sandboxed Function (the source-harvest
 * approach used by test/idle-signal-dispatch.test.js; no jsdom, no real
 * xterm.js) and exercises the gating logic behaviorally:
 *   - MIN_REARM_CHARS edge-trigger in _trackActivityForCompletion
 *   - REPLAY_SUPPRESS_MS window in _checkForCompletion
 *   - IDLE_REFIRE_COOLDOWN_MS at the terminal-idle dispatch site
 * App.js is too DOM-entangled to instantiate here, so its half of the fix
 * (per-session dedupe, focus acknowledgement, active-slot re-point, chime
 * cooldown + shared AudioContext) is verified via distinctive-line source
 * presence checks, the same convention other app.js gate tests use.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const PROVIDER_SPECS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'provider-specs.js');
const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : String(err)));
  }
}

console.log('\n  Notification storm: idle-notification gating');
console.log('  ' + '-'.repeat(58));

/**
 * Minimal CustomEvent stand-in for the sandbox. Node only gained a global
 * CustomEvent recently; passing our own keeps the test portable and lets
 * us inspect .type/.detail on recorded dispatches.
 */
class FakeCustomEvent {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
    this.detail = (opts && opts.detail) || null;
  }
}

/**
 * Build a sandboxed runtime containing TerminalPane plus the provider spec
 * map, with a controllable document stub whose getElementById returns a
 * fake container that records every dispatched CustomEvent.
 *
 * @returns {{ TerminalPane: Function, container: {events: Array} }}
 */
function loadSandbox() {
  const terminalSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
  const providerSpecsSrc = fs.readFileSync(PROVIDER_SPECS_PATH, 'utf8');

  // Fake container: records dispatched events for assertion.
  const container = {
    events: [],
    dispatchEvent(ev) { this.events.push(ev); return true; },
  };

  const win = {};
  const doc = {
    documentElement: { dataset: {} },
    getElementById() { return container; },
  };

  const factory = new Function(
    'window', 'document', 'Terminal', 'FitAddon', 'WebSocket', 'CustomEvent',
    providerSpecsSrc + '\n' + terminalSrc + '\nreturn TerminalPane;'
  );
  const TerminalPane = factory(
    win, doc, function () {}, { FitAddon: function () {} }, function () {}, FakeCustomEvent
  );

  // Synthesize the runtime spec map from the locals file, mirroring the
  // app.js merge behavior in offline mode (same as idle-signal-dispatch).
  const locals = win.CWMProviderSpecLocals || {};
  const specs = {};
  for (const id of Object.keys(locals)) {
    specs[id] = { id, ...locals[id] };
  }
  win.CWMProviderSpecs = specs;

  return { TerminalPane, container };
}

/**
 * Construct a TerminalPane instance with a stubbed xterm buffer whose
 * cursor line always reads as the given text. The constructor itself is
 * DOM-free, so instantiation is safe inside the sandbox.
 *
 * @param {Function} TerminalPane - Harvested class.
 * @param {string} cursorLineText - Text returned for the cursor line.
 * @returns {object} TerminalPane instance ready for _checkForCompletion.
 */
function makePane(TerminalPane, cursorLineText) {
  const tp = new TerminalPane('term-container-0', 'sess-test', 'Test Pane', {});
  tp.term = {
    buffer: {
      active: {
        cursorY: 0,
        baseY: 0,
        getLine() { return { translateToString() { return cursorLineText; } }; },
      },
    },
  };
  return tp;
}

/** Cancel the 2s debounce timer a _trackActivityForCompletion call left behind. */
function clearIdleTimer(tp) {
  clearTimeout(tp._idleCheckTimer);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

check('gating constants exist with the planned values', () => {
  const { TerminalPane } = loadSandbox();
  assert.strictEqual(TerminalPane.MIN_REARM_CHARS, 24, 'MIN_REARM_CHARS');
  assert.strictEqual(TerminalPane.IDLE_REFIRE_COOLDOWN_MS, 30000, 'IDLE_REFIRE_COOLDOWN_MS');
  assert.strictEqual(TerminalPane.REPLAY_SUPPRESS_MS, 3000, 'REPLAY_SUPPRESS_MS');
  assert.ok(TerminalPane.ANSI_ESCAPE_RE instanceof RegExp, 'ANSI_ESCAPE_RE is a RegExp');
});

// ---------------------------------------------------------------------------
// Edge-triggered re-arm (_trackActivityForCompletion)
// ---------------------------------------------------------------------------

check('cosmetic chunk (pure ANSI escapes) does NOT re-arm', () => {
  const { TerminalPane } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = false;
  tp._idleNotified = true;
  // Cursor-move / clear / color noise: strips to nothing meaningful.
  tp._trackActivityForCompletion('\x1b[2J\x1b[H\x1b[0m\x1b[32m\x1b[1;1H\x1b[K');
  clearIdleTimer(tp);
  assert.strictEqual(tp._isWorking, false, 'cosmetic bytes must not mark the pane as working');
  assert.strictEqual(tp._idleNotified, true, 'cosmetic bytes must not reset the once-per-cycle guard');
});

check('short residue below MIN_REARM_CHARS does NOT re-arm', () => {
  const { TerminalPane } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = false;
  tp._idleNotified = true;
  // 10 visible chars after stripping: under the 24-char floor.
  tp._trackActivityForCompletion('\x1b[32mspinner...\x1b[0m');
  clearIdleTimer(tp);
  assert.strictEqual(tp._isWorking, false);
  assert.strictEqual(tp._idleNotified, true);
});

check('meaningful chunk (>= MIN_REARM_CHARS clean chars) re-arms', () => {
  const { TerminalPane } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = false;
  tp._idleNotified = true;
  tp._trackActivityForCompletion('Compiling 42 modules, please wait for the build to finish');
  clearIdleTimer(tp);
  assert.strictEqual(tp._isWorking, true, 'meaningful output must mark the pane as working');
  assert.strictEqual(tp._idleNotified, false, 'meaningful output must allow the next idle event');
});

check('ANSI-wrapped meaningful content still re-arms (strip then measure)', () => {
  const { TerminalPane } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = false;
  tp._idleNotified = true;
  tp._trackActivityForCompletion('\x1b[1;34mRunning the full test suite across packages\x1b[0m');
  clearIdleTimer(tp);
  assert.strictEqual(tp._isWorking, true);
  assert.strictEqual(tp._idleNotified, false);
});

check('debounced idle check is still scheduled on cosmetic flushes', () => {
  // The re-arm is gated, but the 2s debounce must keep running on EVERY
  // flush so an in-progress work cycle still lands its completion check.
  const { TerminalPane } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = true; // mid-work
  tp._trackActivityForCompletion('\x1b[K');
  const timerSet = tp._idleCheckTimer !== null && tp._idleCheckTimer !== undefined;
  clearIdleTimer(tp);
  assert.ok(timerSet, 'idle check timer must be (re)scheduled regardless of chunk size');
});

// ---------------------------------------------------------------------------
// Replay suppression window (_checkForCompletion)
// ---------------------------------------------------------------------------

check('idle check inside the replay window disarms and does not dispatch', () => {
  const { TerminalPane, container } = loadSandbox();
  const tp = makePane(TerminalPane, '>'); // prompt-shaped cursor line
  tp._isWorking = true;
  tp._idleNotified = false;
  tp._suppressIdleUntil = Date.now() + 10000;
  tp._checkForCompletion();
  assert.strictEqual(tp._isWorking, false, 'suppressed check must disarm the pane');
  assert.strictEqual(container.events.length, 0, 'no events during the replay window');
});

check('idle check after the replay window expires works normally', () => {
  const { TerminalPane, container } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = true;
  tp._idleNotified = false;
  tp._suppressIdleUntil = Date.now() - 1; // window already expired
  tp._checkForCompletion();
  const idleEvents = container.events.filter(e => e.type === 'terminal-idle');
  assert.strictEqual(idleEvents.length, 1, 'terminal-idle fires once after the window');
});

// ---------------------------------------------------------------------------
// Per-pane refire cooldown (dispatch site)
// ---------------------------------------------------------------------------

check('recent _lastIdleFiredAt blocks a re-dispatch (cooldown)', () => {
  const { TerminalPane, container } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = true;
  tp._idleNotified = false;
  tp._lastIdleFiredAt = Date.now() - 1000; // 1s ago, inside the 30s cooldown
  tp._checkForCompletion();
  const idleEvents = container.events.filter(e => e.type === 'terminal-idle');
  assert.strictEqual(idleEvents.length, 0, 'cooldown must swallow the dispatch');
  assert.strictEqual(tp._idleNotified, false, 'guard stays open for a post-cooldown retry');
});

check('expired cooldown dispatches and stamps _lastIdleFiredAt', () => {
  const { TerminalPane, container } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = true;
  tp._idleNotified = false;
  tp._lastIdleFiredAt = Date.now() - 40000; // 40s ago, past the 30s cooldown
  const before = Date.now();
  tp._checkForCompletion();
  const idleEvents = container.events.filter(e => e.type === 'terminal-idle');
  assert.strictEqual(idleEvents.length, 1, 'terminal-idle fires after cooldown expiry');
  assert.strictEqual(idleEvents[0].detail.sessionId, 'sess-test');
  assert.strictEqual(tp._idleNotified, true);
  assert.ok(tp._lastIdleFiredAt >= before, '_lastIdleFiredAt stamped at dispatch time');
});

check('second idle check in the same cycle stays silent (_idleNotified guard)', () => {
  const { TerminalPane, container } = loadSandbox();
  const tp = makePane(TerminalPane, '>');
  tp._isWorking = true;
  tp._idleNotified = false;
  tp._checkForCompletion(); // fires
  tp._isWorking = true;     // trivial repaint restarted the debounce
  tp._checkForCompletion(); // must not fire again
  const idleEvents = container.events.filter(e => e.type === 'terminal-idle');
  assert.strictEqual(idleEvents.length, 1, 'exactly one terminal-idle per work cycle');
});

// ---------------------------------------------------------------------------
// Source presence checks: ws.onopen suppression + app.js half of the fix.
// app.js cannot be instantiated without a full DOM, so we assert the
// distinctive lines exist (same convention as other app.js gate tests).
// ---------------------------------------------------------------------------

const terminalSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');

check('ws.onopen arms the replay-suppression window', () => {
  assert.ok(
    terminalSrc.includes('this._suppressIdleUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;'),
    'onopen must set _suppressIdleUntil from REPLAY_SUPPRESS_MS'
  );
});

check('app.js declares dedupe/chime constants and state', () => {
  assert.ok(appSrc.includes('static SESSION_NOTIFY_DEDUPE_MS = 60000'), 'SESSION_NOTIFY_DEDUPE_MS');
  assert.ok(appSrc.includes('static CHIME_COOLDOWN_MS = 5000'), 'CHIME_COOLDOWN_MS');
  assert.ok(appSrc.includes('this._sessionNotifyState = new Map()'), '_sessionNotifyState map');
  assert.ok(appSrc.includes('this._lastChimeAt = 0'), '_lastChimeAt');
  assert.ok(appSrc.includes('this._audioCtx = null'), '_audioCtx slot');
});

check('onTerminalIdle dedupes per session and gates toast+sound on visibility', () => {
  assert.ok(
    appSrc.includes('CWMApp.SESSION_NOTIFY_DEDUPE_MS) return;'),
    'per-session dedupe early return'
  );
  assert.ok(
    appSrc.includes('const paneVisibleAndSeen = activeIdx !== -1 && document.hasFocus();'),
    'visible-pane + window-focus suppression flag'
  );
  assert.ok(
    appSrc.includes('if (!paneVisibleAndSeen) {'),
    'toast+sound wrapped in the suppression branch'
  );
});

check('terminal-activity listener re-enables one notification per new work cycle', () => {
  assert.ok(
    appSrc.includes('this._sessionNotifyState.delete(sessionId);'),
    'non-idle activity must clear the dedupe entry'
  );
});

check('setActiveTerminalPane acknowledges completion without dismissing unresolved input', () => {
  const focusStart = appSrc.indexOf('  setActiveTerminalPane(slotIdx) {');
  const focusEnd = appSrc.indexOf('  openTerminalReader(pane) {', focusStart);
  const focusBlock = appSrc.slice(focusStart, focusEnd);

  assert.ok(appSrc.includes('tp._idleNotified = true;'), 'idle cycle consumed on focus');
  assert.ok(appSrc.includes('tp._lastIdleFiredAt = Date.now();'), 'cooldown stamped on focus');
  assert.ok(
    focusBlock.includes("this._attentionState.get(tp.sessionId) === 'complete'"),
    'completed attention is acknowledged on focus'
  );
  assert.ok(
    !focusBlock.includes('tp._needsInput = false'),
    'focus alone must not clear unresolved needs-input state'
  );
  assert.ok(
    !focusBlock.includes("dataset.needsInput = 'false'"),
    'focus alone must not dismiss the needs-input badge'
  );
});

check('switchTerminalGroup re-points _activeTerminalSlot at the restored group', () => {
  assert.ok(
    appSrc.includes('const firstFilledSlot = this.terminalPanes.findIndex(p => p);'),
    'first filled slot lookup'
  );
  assert.ok(
    appSrc.includes('this._activeTerminalSlot = firstFilledSlot !== -1 ? firstFilledSlot : null;'),
    'active slot assignment'
  );
});

check('_playNotificationSound has a global cooldown and reuses one AudioContext', () => {
  assert.ok(
    appSrc.includes('if (now - this._lastChimeAt < CWMApp.CHIME_COOLDOWN_MS) return;'),
    'chime cooldown gate'
  );
  assert.ok(
    appSrc.includes('this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();'),
    'lazily-created shared context'
  );
  assert.ok(
    !appSrc.includes('const ctx = new (window.AudioContext || window.webkitAudioContext)();'),
    'per-call context allocation must be gone'
  );
});

check('needs-input badge listener targets the real pane id (term-pane-N)', () => {
  assert.ok(
    !appSrc.includes('getElementById(`terminal-pane-${i}`)'),
    'stale terminal-pane-N selector (matched nothing) must be gone'
  );
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('  ' + '-'.repeat(58));
console.log('  [idle-notification-gating] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
