#!/usr/bin/env node
/**
 * Copy-mode gate (mouse-mode copy fix, 2026-07-25).
 * Modified: 2026-07-25
 *
 * Root cause under test: Claude Code's interactive TUI enables terminal mouse
 * tracking, so xterm forwards a plain drag/wheel to the PTY instead of making a
 * text selection. Plain-drag then never selects and Ctrl+C finds no selection.
 * xterm's documented escape hatch is Shift (SelectionService.shouldForceSelection
 * returns event.shiftKey on non-Mac), so Shift+drag always selects.
 *
 * The fix under test provides two copy paths WITHOUT disabling the clickable
 * TUI globally:
 *   A. A per-pane Select-mode toggle (terminal.js _installSelectModeInterceptor
 *      + _injectCopyControls) that makes a PLAIN left-drag act like a Shift+drag
 *      by re-dispatching a synthetic clone with shiftKey forced true.
 *   B. The always-on Shift+drag fast path xterm already honors, plus a one-time
 *      dismissable hint telling the user about both paths.
 *
 * Two layers, matching the no-jsdom source-scan style used elsewhere in test/:
 *   - Source gates: the load-bearing surface exists in terminal.js.
 *   - An EXECUTED proof: the real _installSelectModeInterceptor is run against a
 *     fake container, and a simulated left-button mousedown is checked to (1) do
 *     nothing while the toggle is OFF, and (2) while ON, be swallowed
 *     (stopImmediatePropagation + preventDefault) and re-dispatched as a clone
 *     carrying shiftKey === true. That is what makes the gate non-vacuous.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'index.html');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const indexSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

let passed = 0;
let failed = 0;

/** Tiny runner: name a check, run it, tally, print one line. */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    ' + (err && err.message ? err.message : String(err)));
  }
}

// ── Source gates ─────────────────────────────────────────────
check('terminal.js declares the _selectMode flag (OFF by default)', () => {
  assert.ok(/this\._selectMode\s*=\s*false/.test(termSrc), 'expected this._selectMode = false');
});

check('setSelectMode + toggleSelectMode exist', () => {
  assert.ok(/setSelectMode\s*\(on\)/.test(termSrc), 'expected setSelectMode(on)');
  assert.ok(/toggleSelectMode\s*\(\)/.test(termSrc), 'expected toggleSelectMode()');
});

check('interceptor forces selection via a shiftKey-true synthetic clone', () => {
  assert.ok(/_installSelectModeInterceptor/.test(termSrc), 'expected _installSelectModeInterceptor');
  assert.ok(/shiftKey:\s*true/.test(termSrc), 'expected the clone to force shiftKey: true');
  assert.ok(/__cwmSelSynthetic/.test(termSrc), 'expected a synthetic-clone guard flag');
  assert.ok(/stopImmediatePropagation/.test(termSrc), 'expected the raw event to be stopped');
});

check('interceptor steers left drags and preserves selected-text right-click', () => {
  assert.ok(/e\.button\s*!==\s*0/.test(termSrc), 'expected a left-button-only guard');
  assert.ok(/hasSelection\(\)/.test(termSrc), 'expected a selected-text right-click guard');
});

check('Select-mode control is injected into the pane header', () => {
  assert.ok(/_injectCopyControls/.test(termSrc), 'expected _injectCopyControls');
  assert.ok(/terminal-pane-selectmode/.test(termSrc), 'expected the toggle button class');
  assert.ok(/terminal-pane-header/.test(termSrc), 'expected header lookup');
});

check('while ON, an "options paused" strip is shown', () => {
  assert.ok(/terminal-selectmode-strip/.test(termSrc), 'expected the paused strip');
  assert.ok(/paused/i.test(termSrc), 'expected paused wording for the user');
});

check('one-time copy hint mentions Shift and Select mode, gated once', () => {
  assert.ok(/cwm_copyhint_v1/.test(termSrc), 'expected the one-time localStorage gate');
  assert.ok(/Shift/.test(termSrc), 'expected the hint to mention Shift');
});

check('Ctrl+C branch still copies the xterm selection (Shift path payoff)', () => {
  // The always-on Shift+drag path is only useful if Ctrl+C reads the selection.
  assert.ok(/e\.key === 'c'[\s\S]{0,120}hasSelection\(\)/.test(termSrc),
    'expected the Ctrl+C branch to gate on this.term.hasSelection()');
});

check('dispose() tears the interceptor + injected DOM down', () => {
  assert.ok(/removeEventListener\('mousedown', this\._selMouseHandler/.test(termSrc),
    'expected the capture-phase interceptor to be removed on dispose');
  assert.ok(/this\._selectModeBtn\.remove\(\)/.test(termSrc), 'expected the toggle button removed');
});

check('index.html cache-buster on terminal.js was bumped to copymode2', () => {
  assert.ok(/terminal\.js\?v=20260725-copymode2/.test(indexSrc),
    'expected terminal.js?v=20260725-copymode2 in index.html');
});

// ── Executed proof: run the real interceptor ─────────────────
// Evaluate terminal.js in a minimal sandbox so we can reach the real
// TerminalPane class without loading xterm. Only the final-line guard and the
// method under test touch these globals.
function loadTerminalPane() {
  const recorder = { dispatched: [] };
  // Fake MouseEvent that records the init it was constructed with.
  function FakeMouseEvent(type, init) {
    this.type = type;
    Object.assign(this, init || {});
  }
  const sandbox = {
    window: {},
    document: { getElementById: () => null },
    navigator: {},
    MouseEvent: FakeMouseEvent,
    requestAnimationFrame: () => 0,
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
  };
  sandbox.window.matchMedia = () => ({ matches: false });
  vm.createContext(sandbox);
  vm.runInContext(termSrc, sandbox, { filename: 'terminal.js' });
  return { TerminalPane: sandbox.window.TerminalPane, FakeMouseEvent, recorder, sandbox };
}

/**
 * Install the real interceptor against a fake container and return the
 * captured mousedown handler. Runs terminal.js in a fresh sandbox each call.
 * @param {boolean} selectMode - initial _selectMode for the fake pane.
 * @param {Array} dispatched - array that fake dispatchEvent pushes into.
 * @param {boolean} [hasSelection=false] - Whether xterm has selected text.
 * @returns {{handler: Function, TerminalPane: Function, FakeMouseEvent: Function}}
 */
function installOnFakeContainer(selectMode, dispatched, hasSelection = false) {
  const { TerminalPane, FakeMouseEvent, sandbox } = loadTerminalPane();
  let handler = null;
  const container = {
    addEventListener: (type, fn) => { if (type === 'mousedown') handler = fn; },
    removeEventListener: () => {},
    dispatchEvent: (e) => dispatched.push(e),
  };
  const ctx = { containerId: 'x', _selectMode: selectMode, _selectDragging: false,
    _selInterceptorContainer: null, _selMouseHandler: null,
    term: { hasSelection: () => hasSelection } };
  // The interceptor resolves `document` to the SANDBOX document (it is a
  // closure defined inside the vm), so route the fake container through there.
  sandbox.document.getElementById = () => container;
  TerminalPane.prototype._installSelectModeInterceptor.call(ctx);
  return { handler, TerminalPane, FakeMouseEvent };
}

check('executed: interceptor is a no-op while Select mode is OFF', () => {
  const dispatched = [];
  const { handler, TerminalPane } = installOnFakeContainer(false, dispatched);
  assert.ok(TerminalPane, 'TerminalPane should be exported onto window');
  assert.ok(typeof handler === 'function', 'a mousedown handler should be registered');

  let stopped = false;
  let prevented = false;
  const ev = {
    type: 'mousedown', button: 0, __cwmSelSynthetic: false, cancelable: true,
    target: { dispatchEvent: () => {} },
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; },
  };
  handler(ev); // OFF: must do nothing
  assert.strictEqual(stopped, false, 'OFF must not stop propagation');
  assert.strictEqual(prevented, false, 'OFF must not preventDefault');
});

check('executed: ON turns a plain left-drag into a shiftKey-true clone', () => {
  const dispatched = [];
  const { handler, FakeMouseEvent } = installOnFakeContainer(true, dispatched);
  assert.ok(typeof handler === 'function', 'handler registered');

  let stopped = false;
  let prevented = false;
  const target = { dispatchEvent: (e) => dispatched.push(e) };
  const ev = {
    type: 'mousedown', button: 0, __cwmSelSynthetic: false, cancelable: true,
    detail: 1, screenX: 5, screenY: 6, clientX: 7, clientY: 8,
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    buttons: 1, relatedTarget: null, target,
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; },
  };
  handler(ev);
  assert.strictEqual(stopped, true, 'ON must stop the raw event');
  assert.strictEqual(prevented, true, 'ON must preventDefault the raw event');
  const clone = dispatched.find((e) => e instanceof FakeMouseEvent);
  assert.ok(clone, 'a synthetic clone should have been dispatched');
  assert.strictEqual(clone.shiftKey, true, 'the clone must force shiftKey true');
  assert.strictEqual(clone.__cwmSelSynthetic, true, 'the clone must be flagged synthetic');
  assert.strictEqual(clone.type, 'mousedown', 'clone preserves the event type');
  assert.strictEqual(clone.clientX, 7, 'clone preserves the pointer position');
});

check('executed: a right-button press without selection passes through untouched when ON', () => {
  const dispatched = [];
  const { handler } = installOnFakeContainer(true, dispatched);
  let stopped = false;
  const ev = {
    type: 'mousedown', button: 2, __cwmSelSynthetic: false, cancelable: true,
    target: { dispatchEvent: (e) => dispatched.push(e) },
    preventDefault: () => {},
    stopImmediatePropagation: () => { stopped = true; },
  };
  handler(ev);
  assert.strictEqual(stopped, false, 'right button must not be intercepted');
  assert.strictEqual(dispatched.length, 0, 'no clone for the right button');
});

check('executed: right-click on selected text cannot reach the mouse-reporting TUI', () => {
  const dispatched = [];
  const { handler } = installOnFakeContainer(false, dispatched, true);
  let stopped = false;
  let prevented = false;
  const ev = {
    type: 'mousedown', button: 2, __cwmSelSynthetic: false, cancelable: true,
    target: { dispatchEvent: (e) => dispatched.push(e) },
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; },
  };
  handler(ev);
  assert.strictEqual(stopped, true, 'selected right-click must be stopped before xterm reports it');
  assert.strictEqual(prevented, false, 'contextmenu must remain available for the Copy action');
  assert.strictEqual(dispatched.length, 0, 'selected right-click must not synthesize a mouse event');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
