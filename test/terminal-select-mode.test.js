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
const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'index.html');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
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
check('terminal.js restores Select mode per terminal session', () => {
  assert.ok(/SELECT_MODE_STORAGE_PREFIX/.test(termSrc),
    'expected a versioned per-session Select-mode storage key');
  assert.ok(
    /this\._selectMode\s*=\s*TerminalPane\._loadSelectModePreference\(this\.sessionId\)/.test(termSrc),
    'constructor must restore the same terminal session preference after refresh'
  );
  assert.ok(/_saveSelectModePreference\(this\.sessionId,\s*this\._selectMode\)/.test(termSrc),
    'setSelectMode must persist an explicit toggle');
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
  assert.ok(/getCopySelection\(\)\.hasSelection/.test(termSrc),
    'expected the right-click/hover guard to use the pane-scoped copy selection');
  assert.ok(/selectedHover/.test(termSrc), 'expected selected hover suppression');
  assert.ok(/selectedRightEdge/.test(termSrc), 'expected both right-button edges to be suppressed');
});

check('pane capture focus skips a selected-text right-button press', () => {
  assert.ok(
    /_focusTerminalPaneFromPointer\s*\(slotIdx,\s*event\)/.test(appSrc),
    'pane mousedown listener must delegate through the selection-aware focus helper'
  );
  const start = appSrc.indexOf('  _focusTerminalPaneFromPointer(slotIdx, event) {');
  const end = appSrc.indexOf('\n  setActiveTerminalPane(slotIdx) {', start);
  const body = start >= 0 && end > start ? appSrc.slice(start, end) : '';
  assert.ok(body, 'expected _focusTerminalPaneFromPointer method body');
  assert.ok(
    /getCopySelection\(\)/.test(body),
    'right-button focus guard must consult the pane-scoped live selection'
  );
  assert.ok(
    /selectedRightPress[\s\S]*stopPropagation[\s\S]*return false/.test(body),
    'selected right press must stop before app-level activation'
  );
  assert.ok(
    body.indexOf('if (selectedRightPress)') <
      body.indexOf('this.setActiveTerminalPane(focusSlot)'),
    'selected right press must return before setActiveTerminalPane'
  );
  assert.ok(
    /this\._activeTerminalSlot\s*===\s*focusSlot/.test(body),
    'already-active owner must skip duplicate focus/activate work'
  );
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
  const start = termSrc.indexOf('  _maybeShowCopyHint() {');
  const end = termSrc.indexOf('\n  /** Dismiss the one-time copy hint', start);
  const body = start >= 0 && end > start ? termSrc.slice(start, end) : '';
  assert.ok(/localStorage\.setItem\('cwm_copyhint_v1', '1'\)/.test(body),
    'the hint must be marked shown immediately so a host rebind cannot repeat it');
});

check('Ctrl+C leaves selected text on the trusted native copy path', () => {
  const start = termSrc.indexOf("if (mod && shortcutKey === 'c')");
  const end = termSrc.indexOf('// Ctrl+V / Cmd+V', start);
  const body = start >= 0 && end > start ? termSrc.slice(start, end) : '';
  assert.ok(/getCopySelection\(\)/.test(body),
    'expected normalized Ctrl+C to read the pane-scoped selection');
  assert.ok(/copySelection\.hasSelection\)\s*return false/.test(body),
    'selected Ctrl+C must be withheld from the PTY');
  assert.ok(!/preventDefault/.test(body),
    'selected Ctrl+C must not cancel Chromium/xterm native copy');
  assert.ok(!/copyTextToClipboard/.test(body),
    'keyboard copy must not use the permission-gated async helper');
});

check('dispose() tears the interceptor + injected DOM down', () => {
  assert.ok(/removeEventListener\('mousedown', this\._selMouseHandler/.test(termSrc),
    'expected the capture-phase interceptor to be removed on dispose');
  assert.ok(/this\._selectModeBtn\.remove\(\)/.test(termSrc), 'expected the toggle button removed');
});

check('index.html cache-busts the native-copy terminal fix', () => {
  // Bumped for Select mode v2 (freeze-while-selecting + Copy view overlay),
  // then again (r2) for the focus-report fix plus the mobile overlay/strip
  // geometry, and again (hoverfix) once a field report showed that hovering
  // over a mouse-tracking CLI also cancelled the mode. The two scripts are
  // versioned independently on purpose, so a terminal-only change does not
  // force a re-download of the whole SPA bundle.
  // SANCTIONED EDIT SE-7 (BUILD-CONTRACT.md 5.4, phase P1.6): Notion restyle
  // phase P1: assets changed, cachebuster bumped atomically across index.html
  // and three tests. Both scripts really did change in P1 (terminal.js for the
  // three font strings, app.js for setChrome), so they share this phase token
  // rather than drifting apart for no reason.
  // SANCTIONED EDIT SE-7 again (BUILD-CONTRACT.md 5.4, gate G10's own note:
  // "treat a bump as a five-file atomic change"). Notion restyle phase P5:
  // terminal.js gained the terminalSurface read, the paste preparation and the
  // two new shortcuts, so its token moves to -p5. app.js is untouched by P5
  // and keeps -p4r, which is the independent-versioning mechanism this comment
  // block has described since the beginning working as intended.
  assert.ok(/terminal\.js\?v=20260813-notion-p5/.test(indexSrc),
    'expected the current terminal.js cache token');
});

check('index.html cache-busts the app pane-focus/host fix', () => {
  // Bumped when the mobile toolbar and the pane action sheet gained the
  // Select mode and Copy view controls: those live in app.js, so clients need
  // a fresh copy of it to reach either feature on a phone.
  // SANCTIONED EDIT SE-7 (BUILD-CONTRACT.md 5.4, phase P1.6): Notion restyle
  // phase P1: assets changed, cachebuster bumped atomically across index.html
  // and three tests.
  // SANCTIONED EDIT SE-7 again, phase P10: app.js gained the five-tab mobile
  // IA, the three phone screens and the permanent input row, so a phone
  // holding a cached copy would show the old four-tab bar against the new
  // stylesheet. terminal.js keeps -p5, which is the independent versioning
  // working as intended.
  assert.ok(/app\.js\?v=20260813-notion-p10/.test(indexSrc),
    'expected the current app.js cache token');
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
    setTimeout: () => 1,
    clearTimeout: (id) => recorder.clearedTimers.push(id),
    localStorage: {
      getItem: (key) => recorder.storage.has(key) ? recorder.storage.get(key) : null,
      setItem: (key, value) => recorder.storage.set(key, String(value)),
      removeItem: (key) => recorder.storage.delete(key),
    },
    console,
  };
  recorder.clearedTimers = [];
  recorder.storage = new Map();
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
 * @returns {{handler: Function, handlers: Object, TerminalPane: Function, FakeMouseEvent: Function}}
 */
function installOnFakeContainer(selectMode, dispatched, hasSelection = false) {
  const { TerminalPane, FakeMouseEvent, sandbox } = loadTerminalPane();
  const handlers = {};
  const container = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: () => {},
    dispatchEvent: (e) => dispatched.push(e),
  };
  // Select mode v3 (2026-08-06) moved the output pause off the toggle and onto
  // the drag, so the interceptor now engages a hold on mousedown and releases
  // it on a selectionless mouseup. Both are recorded here rather than stubbed
  // silently, so this fixture can also prove the drag-start ordering.
  const holdCalls = [];
  const ctx = { containerId: 'x', _selectMode: selectMode, _selectDragging: false,
    _selectHold: false, holdCalls,
    _engageSelectHold(reason) {
      if (!this._selectMode || this._selectHold) return false;
      this._selectHold = true;
      holdCalls.push('engage:' + (reason || ''));
      return true;
    },
    _releaseSelectHold(reason) {
      if (!this._selectHold) return false;
      this._selectHold = false;
      holdCalls.push('release:' + (reason || ''));
      return true;
    },
    _selInterceptorContainer: null, _selMouseHandler: null,
    term: {
      hasSelection: () => hasSelection,
      getSelection: () => hasSelection ? 'SELECTED' : '',
    },
    getCopySelection: () => ({
      hasSelection,
      text: hasSelection ? 'SELECTED' : '',
      source: hasSelection ? 'xterm' : null,
    }),
    _getOwnedContainer: () => container,
  };
  // The interceptor resolves `document` to the SANDBOX document (it is a
  // closure defined inside the vm), so route the fake container through there.
  sandbox.document.getElementById = () => container;
  TerminalPane.prototype._installSelectModeInterceptor.call(ctx);
  return {
    handler: handlers.mousedown,
    handlers,
    TerminalPane,
    FakeMouseEvent,
    ctx,
    holdCalls,
  };
}

check('executed: Select mode survives refresh only for the same session', () => {
  const { TerminalPane, recorder } = loadTerminalPane();
  const first = new TerminalPane('x', 'session/a', 'Session A');
  assert.strictEqual(first._selectMode, false, 'unseen sessions must keep clickable TUI mode');
  first.setSelectMode(true);
  assert.strictEqual(
    recorder.storage.get('cwm_terminal_select_mode_v1:session%2Fa'),
    '1',
    'enabling Select mode must persist the encoded session key'
  );

  const restored = new TerminalPane('x', 'session/a', 'Session A');
  const unrelated = new TerminalPane('y', 'session/b', 'Session B');
  assert.strictEqual(restored._selectMode, true, 'same session must restore Select mode');
  assert.strictEqual(unrelated._selectMode, false, 'other panes must retain clickable TUI controls');

  restored.setSelectMode(false);
  assert.strictEqual(
    recorder.storage.has('cwm_terminal_select_mode_v1:session%2Fa'),
    false,
    'turning Select mode off must remove the saved preference'
  );
  assert.strictEqual(
    new TerminalPane('x', 'session/a', 'Session A')._selectMode,
    false,
    'an explicit OFF choice must survive the next refresh'
  );
});

/**
 * Compile the production app focus helper in isolation. Its body only calls
 * other instance methods/properties, so a small object stub can execute the
 * real event-order logic without booting the Workbook SPA.
 *
 * The end anchor spans two lines, and src/web/public/app.js is stored with
 * CRLF line endings, so a marker written with bare \n could never match it:
 * indexOf returned -1 and every executed focus check below failed with
 * "could not extract the production focus helper" while the file was
 * perfectly healthy. Normalizing a copy first fixes the search without
 * changing what is compiled, since line endings are insignificant to the
 * parser. Single-line anchors (the one below and the scoped-body check
 * further up) match either way because CRLF still ends in \n.
 *
 * @returns {Function} Production _focusTerminalPaneFromPointer method.
 */
function loadFocusHelper() {
  const normalizedAppSrc = appSrc.replace(/\r\n/g, '\n');
  const start = normalizedAppSrc.indexOf('  _focusTerminalPaneFromPointer(slotIdx, event) {');
  const end = normalizedAppSrc.indexOf('\n  /**\n   * Set the active terminal pane', start);
  assert.ok(start >= 0 && end > start, 'could not extract the production focus helper');
  const methodSource = normalizedAppSrc.slice(start, end).trim();
  return vm.runInNewContext(
    '({' + methodSource + '})._focusTerminalPaneFromPointer',
    {},
    { filename: 'app-focus-helper.js' }
  );
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
  const { handler, FakeMouseEvent, holdCalls } = installOnFakeContainer(true, dispatched);
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
  // v3: the same press also starts the output pause, and it must do so before
  // the clone reaches xterm and anchors the selection.
  assert.deepStrictEqual(holdCalls, ['engage:drag-start'],
    'the drag start must engage the hold exactly once');
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

check('executed: selected hover and right-button release cannot reach the TUI', () => {
  const dispatched = [];
  const { handlers } = installOnFakeContainer(false, dispatched, true);
  for (const event of [
    { type: 'mousemove', button: 0, buttons: 0 },
    { type: 'mouseup', button: 2, buttons: 0 },
  ]) {
    let stopped = false;
    let prevented = false;
    handlers[event.type]({
      ...event,
      __cwmSelSynthetic: false,
      cancelable: true,
      target: { dispatchEvent: (e) => dispatched.push(e) },
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; },
    });
    assert.strictEqual(stopped, true, event.type + ' must be stopped while text is selected');
    assert.strictEqual(prevented, false, event.type + ' must preserve the later contextmenu default');
  }
  assert.strictEqual(dispatched.length, 0, 'selection-preservation guards must not synthesize input');
});

check('executed: a stale mobile selection reset cannot cross a host rebind', () => {
  const { TerminalPane, recorder } = loadTerminalPane();
  const ctx = {
    _mobileSelectionResetTimer: 77,
    _mobileSelecting: false,
    _xtermScreen: { style: { pointerEvents: 'none' } },
  };
  TerminalPane.prototype._enableMobileSelection.call(ctx);
  assert.deepStrictEqual(recorder.clearedTimers, [77]);
  assert.strictEqual(ctx._mobileSelectionResetTimer, null);
  assert.strictEqual(ctx._mobileSelecting, true);
  assert.strictEqual(ctx._xtermScreen.style.pointerEvents, 'auto');
});

check('executed: active pane raw + synthetic drag start performs zero app activations', () => {
  const focusHelper = loadFocusHelper();
  const pane = {
    getCopySelection: () => ({ hasSelection: false, text: '', source: null }),
  };
  let activations = 0;
  const app = {
    terminalPanes: [pane],
    _activeTerminalSlot: 0,
    _terminalPaneFromPointerEvent: () => pane,
    setActiveTerminalPane(slot) {
      activations++;
      this._activeTerminalSlot = slot;
    },
  };
  const terminalTarget = {
    closest: (selector) => selector === '.xterm' ? {} : null,
  };
  const rawResult = focusHelper.call(app, 0, {
    type: 'mousedown',
    button: 0,
    target: terminalTarget,
  });
  const cloneResult = focusHelper.call(app, 0, {
    type: 'mousedown',
    button: 0,
    __cwmSelSynthetic: true,
  });
  assert.strictEqual(rawResult, false, 'active raw mousedown needs no app focus work');
  assert.strictEqual(cloneResult, false, 'nested synthetic mousedown needs no app focus work');
  assert.strictEqual(activations, 0, 'active selection start must never refocus/refit the pane');
});

check('executed: inactive pane raw + synthetic drag start activates exactly once', () => {
  const focusHelper = loadFocusHelper();
  const pane = {
    getCopySelection: () => ({ hasSelection: false, text: '', source: null }),
  };
  let activations = 0;
  const app = {
    terminalPanes: [pane],
    _activeTerminalSlot: null,
    _terminalPaneFromPointerEvent: () => pane,
    setActiveTerminalPane(slot) {
      activations++;
      this._activeTerminalSlot = slot;
    },
  };
  assert.strictEqual(
    focusHelper.call(app, 0, { type: 'mousedown', button: 0 }),
    true,
    'inactive raw mousedown must activate its owner'
  );
  assert.strictEqual(
    focusHelper.call(app, 0, {
      type: 'mousedown',
      button: 0,
      __cwmSelSynthetic: true,
    }),
    false,
    'nested clone must see the owner as active'
  );
  assert.strictEqual(activations, 1, 'raw + nested clone must activate exactly once');
});

check('executed: active pane chrome click still refocuses the terminal', () => {
  const focusHelper = loadFocusHelper();
  const pane = {
    getCopySelection: () => ({ hasSelection: false, text: '', source: null }),
  };
  let activations = 0;
  const app = {
    terminalPanes: [pane],
    _activeTerminalSlot: 0,
    _terminalPaneFromPointerEvent: () => pane,
    setActiveTerminalPane() { activations++; },
  };
  const result = focusHelper.call(app, 0, {
    type: 'mousedown',
    button: 0,
    target: { closest: () => null },
  });
  assert.strictEqual(result, true, 'pane chrome retains click-anywhere-to-focus behavior');
  assert.strictEqual(activations, 1);
});

check('executed: selected right press stops before any app activation', () => {
  const focusHelper = loadFocusHelper();
  const pane = {
    getCopySelection: () => ({ hasSelection: true, text: 'COPY ME', source: 'xterm' }),
  };
  let activations = 0;
  let stopped = 0;
  const app = {
    terminalPanes: [pane],
    _activeTerminalSlot: null,
    _terminalPaneFromPointerEvent: () => pane,
    setActiveTerminalPane() { activations++; },
  };
  const result = focusHelper.call(app, 0, {
    type: 'mousedown',
    button: 2,
    stopPropagation() { stopped++; },
  });
  assert.strictEqual(result, false);
  assert.strictEqual(stopped, 1, 'selected right press must stop at the pane capture boundary');
  assert.strictEqual(activations, 0, 'selected right press must never focus/activate/refit');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
