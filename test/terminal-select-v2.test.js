#!/usr/bin/env node
/**
 * Select mode v2: freeze-while-selecting and the Copy view overlay.
 *
 * WHY v1 was not enough. Select mode v1 re-dispatched a plain left drag as a
 * synthetic Shift+drag so xterm would force a text selection while the running
 * CLI holds mouse tracking. That fixes the gesture but not the content: xterm 6
 * anchors a selection to ABSOLUTE buffer coordinates and clears it only on user
 * input, scrollback trim, a row-count resize, or a buffer switch. A plain PTY
 * write leaves the selection object intact while repainting the cells beneath
 * it, so a full-screen TUI (which repaints whole frames continuously) turns a
 * valid selection into stale text within a frame or two. v2 therefore freezes
 * the write pipeline for the duration of the selection.
 *
 * Two behaviors are covered here:
 *   1. Freeze: incoming output accumulates in the existing write queue and is
 *      not written; leaving the mode drains it; typing leaves the mode BEFORE
 *      the keystroke goes out; a server-initiated reset drops the freeze before
 *      term.reset(); an overflow cap prevents unbounded holding; a pane that
 *      loses its fixed-slot host stops freezing and drains.
 *   2. Copy view: a text snapshot composed from both buffers (the normal
 *      buffer still holds the pre-TUI transcript and shell scrollback while the
 *      alternate buffer is active), with blank-run collapsing, rendered as
 *      ordinary selectable DOM text.
 *
 * Method follows test/terminal-host-ownership.test.js and
 * test/terminal-select-mode.test.js: terminal.js is evaluated in a sandbox with
 * stubbed globals, real prototype methods are invoked against minimal fakes,
 * and load-bearing wiring that cannot be reached without a full DOM is verified
 * by SCOPED source scan (balanced-brace block extraction, never a loose
 * file-wide regex).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
// src/web/public/*.js is stored with CRLF endings. Every anchor used against
// app.js below is single-line, which matches either way, but the normalized
// copy is what gets COMPILED so a multi-line template inside a method body can
// never depend on the checkout's line endings. Same reasoning (and the same
// fix) as test/terminal-select-mode.test.js.
const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion block, tally it, and keep going on failure so a
 * single regression does not hide the rest of the suite.
 *
 * @param {string} name - Human-readable check name.
 * @param {Function} fn - Assertion body; throws on failure.
 */
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

/**
 * Queue of asynchronous checks, drained after every synchronous check has run.
 *
 * `check` above is deliberately synchronous: it tallies as soon as fn()
 * returns, so handing it an async function would tally a PASS the moment the
 * promise was created and let a later rejection escape as an unhandled
 * rejection. Anything that awaits therefore goes through checkAsync, which is
 * awaited by the runner at the bottom of this file before the summary prints.
 */
const asyncChecks = [];

/**
 * Register an asynchronous assertion block.
 *
 * @param {string} name - Human-readable check name.
 * @param {Function} fn - Async assertion body; rejects on failure.
 */
function checkAsync(name, fn) {
  asyncChecks.push({ name, fn });
}

/**
 * Extract a balanced-brace source block starting at an anchor string, so every
 * source assertion is scoped to the intended function body instead of matching
 * a lookalike elsewhere in the file.
 *
 * Anchors are deliberately SINGLE-LINE. src/web/public/*.js is stored with CRLF
 * line endings, so a multi-line anchor written with bare \n never matches.
 *
 * @param {string} src - Full file source.
 * @param {string} anchor - Text immediately preceding (or containing) the
 *   block's opening brace.
 * @returns {string} Source from the anchor through the matching close brace.
 */
function extractBlock(src, anchor) {
  const idx = src.indexOf(anchor);
  assert.notStrictEqual(idx, -1, 'Anchor not found in source: ' + anchor);
  const braceStart = src.indexOf('{', idx);
  assert.notStrictEqual(braceStart, -1, 'No opening brace after anchor: ' + anchor);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  assert.fail('Unbalanced braces after anchor: ' + anchor);
  return '';
}

/**
 * Evaluate terminal.js inside a Function sandbox with stubbed globals and hand
 * back the real class plus the module constants the assertions need. Nothing
 * DOM-real is required: every method exercised here is invoked against a
 * purpose-built fake `this`.
 *
 * @param {object} [container] - Optional fake element that document
 *   .getElementById resolves to (used by the DOM-adjacent executed checks).
 * @returns {object} { TerminalPane, and the module-level tuning constants }
 */
function loadRuntime(container) {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const win = { matchMedia: () => ({ matches: false }) };
  const doc = {
    documentElement: { dataset: {} },
    getElementById: () => (container || null),
  };
  // WebSocket is only consulted for its OPEN constant in the paths under test.
  const WebSocketStub = Object.assign(function () {}, { OPEN: 1 });
  // The Select-mode interceptor builds a shift-forced clone with `new
  // MouseEvent(...)`. Node has no such global, and the production code treats a
  // construction failure as "let the raw event through", so without this stub
  // every interceptor path would silently take the fallback branch and the v3
  // hold checks would prove nothing.
  function FakeMouseEvent(type, init) {
    this.type = type;
    Object.assign(this, init || {});
  }
  const factory = new Function(
    'window', 'document', 'Terminal', 'FitAddon', 'WebSocket', 'localStorage',
    'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    'MouseEvent',
    termSrc +
    '\nreturn {' +
    ' TerminalPane: TerminalPane,' +
    ' SELECT_FREEZE_MAX_HOLD_CHARS: SELECT_FREEZE_MAX_HOLD_CHARS,' +
    ' TERMINAL_REPORT_MAX_CHARS: TERMINAL_REPORT_MAX_CHARS,' +
    ' SELECT_FREEZE_WHEEL_LINES: SELECT_FREEZE_WHEEL_LINES,' +
    ' SELECT_NOTICE_MS: SELECT_NOTICE_MS,' +
    ' COPY_VIEW_DIVIDER: COPY_VIEW_DIVIDER,' +
    ' COPY_VIEW_BLANK_RUN_LIMIT: COPY_VIEW_BLANK_RUN_LIMIT,' +
    ' ACTIVATE_DEBOUNCE_MS: ACTIVATE_DEBOUNCE_MS,' +
    ' ACTIVATE_REASSERT_MS: ACTIVATE_REASSERT_MS,' +
    ' ACTIVATE_CONNECT_GUARD_MS: ACTIVATE_CONNECT_GUARD_MS,' +
    ' ACTIVATE_VISIBILITY_RATIO: ACTIVATE_VISIBILITY_RATIO };'
  );
  return factory(
    win, doc, function () {}, { FitAddon: function () {} }, WebSocketStub, storage,
    { maxTouchPoints: 0 },
    (fn) => { if (typeof fn === 'function') fn(); return 1; },
    () => {},
    setTimeout,
    clearTimeout,
    FakeMouseEvent
  );
}

const rt = loadRuntime();
const TerminalPane = rt.TerminalPane;

/**
 * Build a minimal pane fake carrying only the state the freeze paths read.
 * Records every term.write() so "held" versus "flushed" is directly
 * observable, and stubs the UI hooks the real methods call.
 *
 * `paneEl` is truthy by default because the mainline freeze predicate also
 * requires a bound fixed-slot host (see _isWriteFrozen): a pane detached into
 * a cached tab group has no selection to protect and must keep rendering.
 *
 * `_selectHold` defaults to FALSE, which is the v3 change: the toggle alone no
 * longer pauses anything, so a fake that wants the frozen state has to say
 * `{ _selectMode: true, _selectHold: true }` the way a real pane only reaches
 * it through a drag.
 *
 * @param {object} [over] - Fields to override on the fake.
 * @returns {object} The fake pane instance (used as `this`).
 */
function makeFreezeFake(over) {
  // Built on the real prototype so the methods under test can call their
  // siblings (setSelectMode -> _unfreezeAndFlush -> _flushWriteBuffer) exactly
  // as they do in production. Own properties shadow the handful of members
  // that would need a live DOM or a live xterm.
  const fake = Object.assign(Object.create(TerminalPane.prototype), {
    writes: [],
    uiUpdates: 0,
    notices: [],
    fits: 0,
    sessionId: 'sess-1',
    paneEl: { classList: { remove() {}, toggle() {} } },
    _selectMode: false,
    _selectHold: false,
    _selectDragging: false,
    _selectFrozenAt: 0,
    _freezeBlockedUntil: 0,
    _log() {},
    _fitDeferredWhileFrozen: false,
    _writeBuf: '',
    _activitySample: '',
    _writeRaf: null,
    _bgFlushTimer: null,
    _isFocused: true,
    _activityDebounceTimer: 1, // pretend the debounce is armed; keeps the fake tiny
    term: { write(s) { fake.writes.push(s); } },
    _updateSelectModeUI() { fake.uiUpdates++; },
    _dismissCopyHint() {},
    _trackActivityForCompletion() {},
    _showSelectModeNotice(text) { fake.notices.push(text); },
    safeFit() { fake.fits++; },
  });
  return Object.assign(fake, over || {});
}

/** Fake xterm buffer line exposing only translateToString. */
function fakeLine(text) {
  return { translateToString: () => text };
}

/**
 * Fake xterm buffer over an array of row strings.
 *
 * @param {string[]} lines - Row texts in buffer order.
 * @param {string} type - 'normal' or 'alternate'.
 * @returns {object} A buffer stub with length/getLine/type.
 */
function fakeBuffer(lines, type) {
  return {
    type,
    length: lines.length,
    getLine: (i) => (i >= 0 && i < lines.length ? fakeLine(lines[i]) : null),
  };
}

console.log('\n  Select mode v2: freeze-while-selecting + Copy view overlay');
console.log('  ' + '='.repeat(58));

/* ============================================================
   1. Freeze: the write pipeline holds output while selecting
   ============================================================ */

check('constructor seeds v2 state (freeze + overlay) as inert defaults', () => {
  const pane = new TerminalPane('c1', 's1', 'Pane', {});
  assert.strictEqual(pane._selectMode, false, 'Select mode must default OFF');
  assert.strictEqual(pane._selectFrozenAt, 0);
  assert.strictEqual(pane._fitDeferredWhileFrozen, false);
  assert.strictEqual(pane._copyOverlay, null);
  assert.strictEqual(pane._copyOverlayOpen, false);
  assert.strictEqual(pane._selWheelHandler, null);
  assert.strictEqual(pane._selWheelTarget, null);
});

check('_isWriteFrozen requires Select mode, a HOLD, a bound host, and no replay', () => {
  const f = makeFreezeFake();
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false);
  // v3: the toggle alone pauses nothing. This is the user-reported defect
  // ("when i toggle select, the window freezes and i cannot scroll or drag
  // up") expressed as an assertion.
  f._selectMode = true;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false,
    'turning the mode ON must leave output live so the pane can still scroll');
  f._selectHold = true;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), true,
    'the hold engaged by a drag is what pauses output');
  // A replay window suspends the freeze without disturbing the toggle.
  f._freezeBlockedUntil = Date.now() + 3000;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false,
    'a scrollback replay must never be held back');
  f._freezeBlockedUntil = 0;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), true);
  // A cached tab group detaches host bindings and nulls paneEl while the
  // WebSocket keeps streaming. Such a pane has no visible selection and no
  // reachable toggle, so it must never hold output.
  f.paneEl = null;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false,
    'an unhosted pane must keep rendering even with Select mode remembered');
  assert.strictEqual(f._selectMode, true,
    'the per-session preference itself must survive a detach');
});

check('frozen _enqueueWrite accumulates and schedules NOTHING', () => {
  const f = makeFreezeFake({ _selectMode: true, _selectHold: true });
  TerminalPane.prototype._enqueueWrite.call(f, 'frame-1');
  TerminalPane.prototype._enqueueWrite.call(f, 'frame-2');
  assert.strictEqual(f._writeBuf, 'frame-1frame-2', 'bytes must be held, not dropped');
  assert.strictEqual(f.writes.length, 0, 'nothing may reach term.write while frozen');
  assert.strictEqual(f._writeRaf, null, 'no animation frame may be scheduled while frozen');
  assert.strictEqual(f._bgFlushTimer, null, 'no background flush timer may be scheduled while frozen');
});

check('frozen _flushWriteBuffer refuses to consume the queue (stray rAF guard)', () => {
  const f = makeFreezeFake({ _selectMode: true, _selectHold: true, _writeBuf: 'held', _writeRaf: 7 });
  TerminalPane.prototype._flushWriteBuffer.call(f);
  assert.strictEqual(f.writes.length, 0, 'a flush scheduled before the freeze must not write');
  assert.strictEqual(f._writeBuf, 'held', 'the queue must survive a suppressed flush');
  assert.strictEqual(f._writeRaf, null, 'the consumed frame handle is still cleared');
});

check('frozen setFocused schedules no catch-up frame', () => {
  const f = makeFreezeFake({ _selectMode: true, _selectHold: true, _writeBuf: 'held' });
  TerminalPane.prototype.setFocused.call(f, true);
  assert.strictEqual(f._isFocused, true, 'focus bookkeeping still happens');
  assert.strictEqual(f._writeRaf, null, 'no frame may be scheduled for a frozen pane');
  assert.strictEqual(f.writes.length, 0);
});

check('unfrozen _enqueueWrite still writes normally (v1 behavior preserved)', () => {
  const f = makeFreezeFake();
  TerminalPane.prototype._enqueueWrite.call(f, 'live');
  assert.strictEqual(f.writes.join(''), 'live', 'a non-frozen pane writes through the rAF path');
});

check('v3: setSelectMode(true) keeps output LIVE, the hold is what pauses it', () => {
  const f = makeFreezeFake();
  TerminalPane.prototype.setSelectMode.call(f, true);
  assert.strictEqual(f._selectMode, true);
  assert.strictEqual(f._selectHold, false, 'the toggle must not engage a hold');
  assert.strictEqual(f._selectFrozenAt, 0, 'nothing is frozen yet, so there is no start time');
  TerminalPane.prototype._enqueueWrite.call(f, 'live-1');
  assert.strictEqual(f.writes.join(''), 'live-1',
    'output keeps painting so the user can scroll to what they want to select');

  // Now the drag begins, which is where the pause belongs.
  assert.strictEqual(TerminalPane.prototype._engageSelectHold.call(f, 'drag-start'), true);
  assert.ok(f._selectFrozenAt > 0, 'freeze start timestamp must be recorded at drag start');
  TerminalPane.prototype._enqueueWrite.call(f, 'a');
  TerminalPane.prototype._enqueueWrite.call(f, 'b');
  assert.strictEqual(f.writes.length, 1, 'held while the selection is being made');
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.strictEqual(f.writes.length, 2, 'the drain must be a SINGLE write, not one per chunk');
  assert.strictEqual(f.writes[1], 'ab', 'held output must be written in arrival order');
  assert.strictEqual(f._writeBuf, '', 'queue is empty after the drain');
  assert.strictEqual(f._selectHold, false);
  assert.strictEqual(f._selectFrozenAt, 0);
});

check('v3: _engageSelectHold refuses to pause a pane whose mode is OFF', () => {
  const f = makeFreezeFake();
  assert.strictEqual(TerminalPane.prototype._engageSelectHold.call(f, 'stray'), false,
    'a stray call must never pause an ordinary pane');
  assert.strictEqual(f._selectHold, false);
  // Idempotent inside one gesture: a second mousedown keeps the first hold.
  f._selectMode = true;
  assert.strictEqual(TerminalPane.prototype._engageSelectHold.call(f, 'drag-start'), true);
  const startedAt = f._selectFrozenAt;
  assert.strictEqual(TerminalPane.prototype._engageSelectHold.call(f, 'again'), false);
  assert.strictEqual(f._selectFrozenAt, startedAt, 'the original start time must survive');
});

check('v3: _releaseSelectHold drains what arrived and leaves the MODE alone', () => {
  const f = makeFreezeFake({ _selectMode: true, _selectHold: true, _writeBuf: 'held-during-drag' });
  assert.strictEqual(TerminalPane.prototype._releaseSelectHold.call(f, 'selection-cleared'), true);
  assert.strictEqual(f._selectHold, false);
  assert.strictEqual(f.writes.join(''), 'held-during-drag', 'the pause ends by flushing, not dropping');
  assert.strictEqual(f._selectMode, true,
    'releasing a hold is not the user turning the mode off');
  assert.strictEqual(TerminalPane.prototype._releaseSelectHold.call(f, 'again'), false,
    'a second release is a no-op');
});

check('setSelectMode still persists the per-session preference (v1 contract intact)', () => {
  const saved = [];
  const original = TerminalPane._saveSelectModePreference;
  TerminalPane._saveSelectModePreference = (id, on) => saved.push([id, on]);
  try {
    const f = makeFreezeFake();
    TerminalPane.prototype.setSelectMode.call(f, true);
    TerminalPane.prototype.setSelectMode.call(f, false);
  } finally {
    TerminalPane._saveSelectModePreference = original;
  }
  assert.deepStrictEqual(saved, [['sess-1', true], ['sess-1', false]],
    'the freeze must not displace v1 persistence on either edge');
});

check('toggle-off with an empty queue writes nothing (no spurious flush)', () => {
  const f = makeFreezeFake({ _selectMode: true });
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.strictEqual(f.writes.length, 0);
});

check('a resize deferred during the freeze is re-applied on unfreeze', () => {
  // safeFit is the real method here so the deferral branch is the one tested;
  // fitAddon must be present or it bails before reaching that branch.
  const f = makeFreezeFake({
    _selectMode: true, _selectHold: true,
    fitAddon: { fit() { assert.fail('must not fit while frozen'); } },
  });
  TerminalPane.prototype.safeFit.call(f);
  assert.strictEqual(f._fitDeferredWhileFrozen, true, 'a fit during the freeze must be deferred, not applied');
  const g = makeFreezeFake({ _selectMode: true, _selectHold: true, _fitDeferredWhileFrozen: true });
  TerminalPane.prototype.setSelectMode.call(g, false);
  assert.strictEqual(g.fits, 1, 'the deferred fit must run once the freeze lifts');
  assert.strictEqual(g._fitDeferredWhileFrozen, false);
});

check('held output is written BEFORE the deferred re-fit (old frames, old geometry)', () => {
  const order = [];
  const f = makeFreezeFake({ _selectMode: true, _fitDeferredWhileFrozen: true, _writeBuf: 'frames' });
  f.term.write = (s) => order.push('write:' + s);
  f.safeFit = () => order.push('fit');
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.deepStrictEqual(order, ['write:frames', 'fit'],
    'fitting first would render old-width frames into a new-width grid');
});

check('_exitSelectModeForInput lifts the freeze and reports whether it did', () => {
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'queued' });
  assert.strictEqual(TerminalPane.prototype._exitSelectModeForInput.call(f), true);
  assert.strictEqual(f._selectMode, false);
  assert.strictEqual(f.writes.join(''), 'queued', 'the echo must land on a current screen');
  assert.strictEqual(TerminalPane.prototype._exitSelectModeForInput.call(f), false,
    'a second call on an unfrozen pane is a no-op');
  assert.strictEqual(f.writes.length, 1);
});

check('_discardSelectModeHold opens the replay window WITHOUT writing (resync paths)', () => {
  const f = makeFreezeFake({
    _selectMode: true, _selectHold: true,
    _writeBuf: 'stale-frames', _fitDeferredWhileFrozen: true,
  });
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), true);
  TerminalPane.prototype._discardSelectModeHold.call(f);
  assert.strictEqual(f.writes.length, 0, 'a replay is about to re-send everything; do not write stale frames');
  assert.strictEqual(f._fitDeferredWhileFrozen, false, 'a fit deferred before the resync is stale');
  assert.ok(f._freezeBlockedUntil > Date.now(), 'the replay must find the gate open');
  assert.strictEqual(f._selectHold, false,
    'v3: term.reset() destroys the selection the hold was protecting, so the hold goes too');
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false,
    'output arriving during the replay window must reach the screen');
});

check('a resync must NOT undo the per-session Select mode preference', () => {
  // The server sends a reset marker plus a full replay on EVERY attach, the
  // first one after a page refresh included. Clearing the mode (or its stored
  // preference) here would make the v1 "Select mode survives refresh" feature
  // silently reset itself on every connect.
  const saved = [];
  const original = TerminalPane._saveSelectModePreference;
  TerminalPane._saveSelectModePreference = (id, on) => saved.push([id, on]);
  let f;
  try {
    f = makeFreezeFake({ _selectMode: true });
    TerminalPane.prototype._discardSelectModeHold.call(f);
  } finally {
    TerminalPane._saveSelectModePreference = original;
  }
  assert.strictEqual(f._selectMode, true, 'the toggle stays where the user left it');
  assert.deepStrictEqual(saved, [], 'a resync must not write the stored preference at all');
});

check('v3: after a resync the pane stays LIVE even once the replay window closes', () => {
  // v2 resumed holding here because the toggle alone was the freeze condition.
  // v3 has nothing to resume: the resync cleared the hold along with the
  // selection it protected, and only a new drag can start another one.
  const f = makeFreezeFake({ _selectMode: true, _selectHold: true });
  TerminalPane.prototype._discardSelectModeHold.call(f);
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false);
  f._freezeBlockedUntil = Date.now() - 1;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false,
    'a pane with no selection must keep painting after a resync');
  assert.strictEqual(f._selectMode, true, 'the toggle itself still survives the resync');
  // A fresh drag pauses again, so the feature is not disabled by the resync.
  TerminalPane.prototype._engageSelectHold.call(f, 'drag-start');
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), true);
});

check('connect and socket open both open the replay window', () => {
  const connectBlock = extractBlock(termSrc, 'const isReconnect = this._gotFirstData;');
  assert.ok(/_freezeBlockedUntil = Date\.now\(\) \+ TerminalPane\.REPLAY_SUPPRESS_MS/.test(connectBlock) ||
    termSrc.includes('this._freezeBlockedUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;'),
    'connect must open the window before the socket exists');
  const onopen = extractBlock(termSrc, 'this.ws.onopen = () => {');
  assert.ok(onopen.includes('_freezeBlockedUntil'),
    'socket open must re-arm the window, since a slow handshake can outlast the connect-time arm');
});

check('overflow cap leaves Select mode, flushes everything, and explains why', () => {
  const f = makeFreezeFake({ _selectMode: true, _selectHold: true });
  const big = 'x'.repeat(rt.SELECT_FREEZE_MAX_HOLD_CHARS);
  TerminalPane.prototype._enqueueWrite.call(f, big);
  assert.strictEqual(f._selectMode, false, 'the cap must end the freeze');
  assert.strictEqual(f.writes.length, 1, 'everything held must be flushed on overflow');
  assert.strictEqual(f.writes[0].length, big.length);
  assert.strictEqual(f.notices.length, 1, 'the user must be told the pane resumed');
  assert.ok(/resumed/i.test(f.notices[0]), 'notice should say output resumed: ' + f.notices[0]);
});

check('overflow cap is 2MB of held output', () => {
  assert.strictEqual(rt.SELECT_FREEZE_MAX_HOLD_CHARS, 2 * 1024 * 1024);
});

/* ============================================================
   2. Freeze wiring: input paths, resync paths, host lifecycle
   ============================================================ */

check('onData exits Select mode BEFORE it forwards the keystroke', () => {
  const block = extractBlock(termSrc, 'this.term.onData((data) => {');
  const exitIdx = block.indexOf('_exitSelectModeForInput');
  const sendIdx = block.indexOf('this.ws.send(');
  assert.ok(exitIdx !== -1, 'onData must unfreeze on input');
  assert.ok(sendIdx !== -1, 'onData must still forward input');
  assert.ok(exitIdx < sendIdx, 'the unfreeze must precede the send so the echo renders on a current screen');
});

check('every other send-to-PTY path also unfreezes (paste, Ctrl+V, Shift+Enter, commands)', () => {
  const paste = extractBlock(termSrc, "if (e.inputType === 'insertFromPaste') {");
  assert.ok(paste.includes('_exitSelectModeForInput'), 'beforeinput paste path must unfreeze');
  const replace = extractBlock(termSrc, "if (e.inputType === 'insertReplacementText') {");
  assert.ok(replace.includes('_exitSelectModeForInput'), 'autocorrect replacement path must unfreeze');
  const ctrlV = extractBlock(termSrc, "if (mod && shortcutKey === 'v') {");
  assert.ok(ctrlV.includes('_exitSelectModeForInput'), 'Ctrl+V path must unfreeze');
  const shiftEnter = extractBlock(termSrc, "if (e.key === 'Enter' && e.shiftKey) {");
  assert.ok(shiftEnter.includes('_exitSelectModeForInput'), 'Shift+Enter path must unfreeze');
  const sendCommand = extractBlock(termSrc, 'sendCommand(cmd) {');
  assert.ok(sendCommand.includes('_exitSelectModeForInput'), 'sendCommand must unfreeze');
  const pasteApi = extractBlock(termSrc, 'async pasteFromClipboard() {');
  assert.ok(pasteApi.includes('_exitSelectModeForInput'), 'the explicit Paste action must unfreeze');
});

check('executed: an input frame sent straight on the socket also unfreezes first', () => {
  // The app shell writes { type: 'input' } directly onto tp.ws in several
  // places (the mobile toolbar keys and the mobile type-and-send row among
  // them), bypassing every pane-level send site. The socket hook is what keeps
  // those from leaving the pane frozen with the answer stuck in the queue.
  const order = [];
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  f.term.write = (s) => order.push('write:' + s);
  const ws = { send: (payload) => order.push('send:' + payload) };
  const wrapped = TerminalPane.prototype._installInputUnfreezeHook.call(f, ws);
  assert.strictEqual(wrapped, ws, 'the same socket is returned for call-site convenience');
  ws.send(JSON.stringify({ type: 'input', data: 'x' }));
  assert.strictEqual(f._selectMode, false, 'a raw input frame must resume live output');
  assert.strictEqual(order[0], 'write:held', 'the drain must precede the send');
  assert.ok(order[1].startsWith('send:'), 'the frame must still go out');
});

check('executed: the socket hook ignores non-input frames and never double-wraps', () => {
  const sent = [];
  const f = makeFreezeFake({ _selectMode: true });
  const ws = { send: (payload) => sent.push(payload) };
  TerminalPane.prototype._installInputUnfreezeHook.call(f, ws);
  const afterFirst = ws.send;
  TerminalPane.prototype._installInputUnfreezeHook.call(f, ws);
  assert.strictEqual(ws.send, afterFirst, 'a re-wrap on the same socket must be a no-op');
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'activate' }));
  assert.strictEqual(f._selectMode, true, 'geometry traffic is not input and must not unfreeze');
  assert.strictEqual(sent.length, 2, 'every frame still reaches the socket');
  // A missing/odd socket is tolerated rather than throwing into a send path.
  assert.strictEqual(TerminalPane.prototype._installInputUnfreezeHook.call(f, null), null);
});

check('connect() wraps the live socket right after constructing it', () => {
  const connectBlock = extractBlock(termSrc, 'this.ws = new WebSocket(wsUrl);');
  assert.ok(termSrc.includes('this._installInputUnfreezeHook(this.ws);'),
    'each reconnect builds a new socket and must re-wrap it');
  const idxNew = termSrc.indexOf('this.ws = new WebSocket(wsUrl);');
  const idxHook = termSrc.indexOf('this._installInputUnfreezeHook(this.ws);');
  assert.ok(idxHook > idxNew && idxHook - idxNew < 400,
    'the wrap must happen immediately after construction, before anything can send');
  assert.ok(connectBlock.length >= 0);
});

check('a selected Ctrl+C is withheld from xterm, so copying never lifts the freeze', () => {
  // The copy shortcut returns false from the custom key handler when a
  // selection exists, so xterm emits no data and onData (the unfreeze funnel)
  // is never reached. Losing that property would resume output mid-copy.
  const handler = extractBlock(termSrc, 'this.term.attachCustomKeyEventHandler((e) => {');
  const copyBranch = extractBlock(handler, "if (mod && shortcutKey === 'c') {");
  assert.ok(/return false/.test(copyBranch), 'a selected Ctrl+C must not reach xterm');
  assert.ok(!copyBranch.includes('_exitSelectModeForInput'),
    'copying is not input; it must leave the freeze and the selection alone');
});

check('executed: the real RESET branch unfreezes BEFORE term.reset()', () => {
  // Compile the actual reset branch body and run it against a fake pane. This
  // is the non-vacuous form of "a replay must never land in a frozen pane".
  const block = extractBlock(termSrc, "} else if (msg.type === 'reset') {");
  const body = block.slice(block.indexOf('{'));
  // The branch also arms the width-claim quiet window, so that constant has to
  // be in scope for the compiled harness.
  const harness = new Function('cancelAnimationFrame', 'clearTimeout', 'ACTIVATE_CONNECT_GUARD_MS',
    'return function () { if (true) ' + body + ' };')(() => {}, () => {}, rt.ACTIVATE_CONNECT_GUARD_MS);
  const order = [];
  const fake = {
    _selectMode: true,
    _selectFrozenAt: 123,
    _freezeBlockedUntil: 0,
    _fitDeferredWhileFrozen: true,
    paneEl: {},
    _writeRaf: 3,
    _bgFlushTimer: 4,
    _writeBuf: 'stale',
    _activitySample: 'stale',
    _updateSelectModeUI() { order.push('ui'); },
    term: { reset() { order.push('reset'); } },
  };
  fake._discardSelectModeHold = function () {
    order.push('unfreeze');
    TerminalPane.prototype._discardSelectModeHold.call(this);
  };
  harness.call(fake);
  assert.ok(order.indexOf('unfreeze') !== -1, 'the reset branch must drop the freeze');
  assert.ok(order.indexOf('unfreeze') < order.indexOf('reset'), 'unfreeze must happen before term.reset()');
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(fake), false,
    'the replay that follows this branch must reach the screen');
  assert.strictEqual(fake._selectMode, true, 'the resync must not toggle Select mode off');
  assert.strictEqual(fake._writeBuf, '', 'the reset branch still clears the queue for the replay');
});

check('the reconnect path in connect() also drops the freeze before term.reset()', () => {
  const block = extractBlock(termSrc, 'if (isReconnect && this.term) {');
  const discardIdx = block.indexOf('_discardSelectModeHold');
  const resetIdx = block.indexOf('this.term.reset()');
  assert.ok(discardIdx !== -1, 'the reconnect path must drop the freeze');
  assert.ok(resetIdx !== -1);
  assert.ok(discardIdx < resetIdx, 'unfreeze must precede the reset on reconnect too');
});

check('executed: detaching the fixed-slot host drains the hold and releases v2 chrome', () => {
  let wheelRemoved = 0;
  let overlayRemoved = 0;
  let btnRemoved = 0;
  const f = Object.assign(Object.create(TerminalPane.prototype), {
    writes: [],
    sessionId: 's', _selectMode: true,
    paneEl: { classList: { remove() {}, toggle() {} } },
    _hostMobileTypeMode: undefined,
    _mobileTypeMode: false,
    _touchScrollCleanup: null,
    _mobileSelectionResetTimer: null,
    _resizeObserver: null,
    _copyHintTimer: null,
    _selInterceptorContainer: null,
    _selMouseHandler: null,
    _selNoticeTimer: null,
    _selWheelTarget: { removeEventListener: () => { wheelRemoved++; } },
    _selWheelHandler: () => {},
    _copyFeedbackTimer: null,
    _copyOverlay: { removeEventListener: () => {}, remove: () => { overlayRemoved++; } },
    _copyOverlayKeyHandler: () => {},
    _copyOverlayOpen: true,
    _copyViewBtn: { remove: () => { btnRemoved++; } },
    _selectModeBtn: null,
    _selStrip: null,
    _copyHint: null,
    _writeBuf: 'held-while-hosted',
    _activitySample: '',
    _writeRaf: null,
    _bgFlushTimer: null,
    _activityDebounceTimer: 1,
    _isFocused: true,
    _fitDeferredWhileFrozen: false,
    term: { write(s) { f.writes.push(s); } },
    _trackActivityForCompletion() {},
    safeFit() {},
  });
  TerminalPane.prototype.detachHostBindings.call(f);
  assert.strictEqual(wheelRemoved, 1, 'the capture-phase wheel guard must not stay on a shared slot');
  assert.strictEqual(overlayRemoved, 1, 'the Copy view overlay must leave the released pane element');
  assert.strictEqual(btnRemoved, 1, 'the Copy view header button belongs to the fixed host');
  assert.strictEqual(f.paneEl, null);
  assert.deepStrictEqual(f.writes, ['held-while-hosted'],
    'an unhosted pane must not keep sitting on held output');
  assert.strictEqual(f._selectMode, true,
    'the Select-mode preference survives the detach and re-freezes on rebind');
});

check('rebindHost reinstalls the wheel guard alongside the mouse interceptor', () => {
  const rebind = extractBlock(termSrc, 'rebindHost(containerId) {');
  assert.ok(rebind.includes('_installSelectModeInterceptor()'), 'v1 interceptor must be reinstalled');
  assert.ok(rebind.includes('_installSelectModeWheelGuard()'),
    'the wheel guard is host-owned and must follow the pane to its new slot');
  assert.ok(rebind.includes('_injectCopyControls()'),
    'the header controls (Select toggle + Copy view) must be rebuilt');
});

check('mount wires both Select-mode listeners before connecting', () => {
  const mount = extractBlock(termSrc, 'mount() {');
  assert.ok(mount.includes('_installSelectModeInterceptor()'));
  assert.ok(mount.includes('_installSelectModeWheelGuard()'));
  assert.ok(mount.indexOf('_installSelectModeWheelGuard()') < mount.indexOf('this.connect()'),
    'listeners must exist before the first byte can arrive');
});

/* ============================================================
   3. Wheel guard: swallow under a TUI, scroll in a shell pane
   ============================================================ */

check('wheel deltas normalize to signed rows across all three delta modes', () => {
  const W = TerminalPane._wheelLinesFromEvent;
  assert.strictEqual(W({ deltaY: 120, deltaMode: 0 }, 30), rt.SELECT_FREEZE_WHEEL_LINES, 'pixel mode down');
  assert.strictEqual(W({ deltaY: -3, deltaMode: 0 }, 30), -rt.SELECT_FREEZE_WHEEL_LINES, 'pixel mode up');
  assert.strictEqual(W({ deltaY: 2, deltaMode: 1 }, 30), 2, 'line mode is used verbatim');
  assert.strictEqual(W({ deltaY: -1, deltaMode: 2 }, 24), -24, 'page mode scales by viewport rows');
  assert.strictEqual(W({ deltaY: 0, deltaMode: 0 }, 30), 0, 'a zero delta scrolls nothing');
  assert.strictEqual(W(null, 30), 0, 'a malformed event scrolls nothing');
});

/**
 * Install the real wheel guard against a fake container and hand back the
 * registered handler plus the fake pane.
 *
 * The guard resolves its target through _getOwnedContainer(), the mainline
 * ownership helper, so the fake supplies that rather than leaning on
 * document.getElementById. That is the same shape test/terminal-select-mode
 * uses for the mouse interceptor.
 *
 * @param {boolean} selectMode - Initial toggle state.
 * @param {string} bufferType - 'normal' or 'alternate'.
 * @param {boolean} [hold=false] - Whether a selection is currently held (v3).
 * @returns {{handler: Function, pane: object, scrolled: number[], options: object}}
 */
function installWheelGuard(selectMode, bufferType, hold) {
  let handler = null;
  let options = null;
  const container = {
    addEventListener: (type, fn, opts) => { if (type === 'wheel') { handler = fn; options = opts; } },
    removeEventListener: () => {},
  };
  const scrolled = [];
  const pane = Object.assign(Object.create(TerminalPane.prototype), {
    containerId: 'c',
    _selectMode: selectMode,
    _selectHold: !!hold,
    _selWheelHandler: null,
    _selWheelTarget: null,
    _copyOverlay: null,
    _copyOverlayOpen: false,
    _getOwnedContainer: () => container,
    term: {
      rows: 30,
      buffer: { active: { type: bufferType } },
      scrollLines: (n) => scrolled.push(n),
    },
  });
  TerminalPane.prototype._installSelectModeWheelGuard.call(pane);
  return { handler, pane, scrolled, options, container };
}

check('executed: the wheel guard registers non-passive in the capture phase', () => {
  const { handler, options } = installWheelGuard(false, 'normal');
  assert.ok(typeof handler === 'function', 'a wheel listener must be registered');
  assert.strictEqual(options.capture, true, 'it must run before xterm listeners');
  assert.strictEqual(options.passive, false, 'preventDefault must be honored');
});

check('executed: the wheel guard is inert while Select mode is OFF', () => {
  const { handler, scrolled } = installWheelGuard(false, 'normal');
  let prevented = false;
  handler({ deltaY: 100, deltaMode: 0, cancelable: true, target: null,
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {} });
  assert.strictEqual(prevented, false, 'OFF must not touch the wheel');
  assert.strictEqual(scrolled.length, 0);
});

check('v3 executed: ON with NOTHING selected FORWARDS the wheel in the ALTERNATE buffer', () => {
  // This is the reported defect. Under a full-screen CLI the only thing that
  // can scroll is the app's own history, so the wheel has to reach it. v2
  // swallowed the event here, which is why the pane felt stuck the moment the
  // toggle went on: "i cannot scroll or drag up".
  const { handler, scrolled } = installWheelGuard(true, 'alternate', false);
  let prevented = false;
  let stopped = false;
  handler({ deltaY: 100, deltaMode: 0, cancelable: true, target: null,
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
  assert.strictEqual(prevented, false,
    'the wheel must reach xterm so it becomes the mouse report the app scrolls on');
  assert.strictEqual(stopped, false, 'nothing may intercept it before xterm');
  assert.strictEqual(scrolled.length, 0, 'the alternate buffer has no local scrollback to move');
});

/* ============================================================
   3b. v3 hold lifecycle: engaged by the drag, released by the
   selection going away. Driven through the REAL interceptor so
   the ordering that matters (hold engaged before the clone is
   dispatched) is proven, not assumed.
   ============================================================ */

/**
 * Install the real Select-mode mouse interceptor against a fake container and
 * return the registered handlers plus the pane fake.
 *
 * Mirrors the shape test/terminal-select-mode.test.js uses for the same
 * interceptor, extended with the v3 hold state and a settable selection so a
 * whole press/drag/release gesture can be played through it.
 *
 * @param {object} [over] - Fields to override on the pane fake.
 * @returns {{handlers: object, pane: object, order: string[]}}
 */
function installInterceptor(over) {
  const handlers = {};
  const order = [];
  const container = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: () => {},
    dispatchEvent: (e) => { order.push('dispatch:' + e.type); },
  };
  const pane = Object.assign(Object.create(TerminalPane.prototype), {
    containerId: 'c',
    sessionId: 's',
    writes: [],
    hasSelection: false,
    order,
    paneEl: { classList: { remove() {}, toggle() {} } },
    _selectMode: true,
    _selectHold: false,
    _selectDragging: false,
    _selectFrozenAt: 0,
    _freezeBlockedUntil: 0,
    _selInterceptorContainer: null,
    _selMouseHandler: null,
    _writeBuf: '',
    _activitySample: '',
    _writeRaf: null,
    _bgFlushTimer: null,
    _activityDebounceTimer: 1,
    _isFocused: true,
    _fitDeferredWhileFrozen: false,
    _activatePending: false,
    term: { write(s) { pane.writes.push(s); order.push('write:' + s); } },
    getCopySelection() { return { hasSelection: pane.hasSelection, text: 'X', source: 'xterm' }; },
    _getOwnedContainer: () => container,
    _updateSelectModeUI() {},
    _trackActivityForCompletion() {},
    _log(msg) { order.push('log:' + msg); },
    safeFit() {},
  });
  Object.assign(pane, over || {});
  TerminalPane.prototype._installSelectModeInterceptor.call(pane);
  return { handlers, pane, order, container };
}

/**
 * Build a plain mouse event stub for the interceptor.
 * @param {string} type - Event type.
 * @param {object} [extra] - Overrides (button, buttons, ...).
 * @returns {object} Event stub.
 */
function mouseEvent(type, extra) {
  return Object.assign({
    type,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
    cancelable: true,
    __cwmSelSynthetic: false,
    detail: 1, screenX: 1, screenY: 2, clientX: 3, clientY: 4,
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    relatedTarget: null,
    // Null on purpose: the interceptor dispatches its clone to
    // `(e.target || container)`, so a null target routes it to the recording
    // container above and makes the ordering observable.
    target: null,
    preventDefault: () => {},
    stopImmediatePropagation: () => {},
  }, extra || {});
}

check('v3 executed: the drag START engages the hold BEFORE xterm sees the click', () => {
  const { handlers, pane, order } = installInterceptor();
  assert.strictEqual(pane._selectHold, false, 'the toggle alone left the pane live');
  TerminalPane.prototype._enqueueWrite.call(pane, 'live-before-drag');
  assert.strictEqual(pane.writes.join(''), 'live-before-drag', 'scrolling era: output paints');

  handlers.mousedown(mouseEvent('mousedown'));
  assert.strictEqual(pane._selectHold, true, 'the press must pause output');
  const holdAt = order.findIndex((o) => /Select hold engaged/.test(o));
  const dispatchAt = order.findIndex((o) => o === 'dispatch:mousedown');
  assert.ok(holdAt !== -1 && dispatchAt !== -1, 'both events must be recorded');
  assert.ok(holdAt < dispatchAt,
    'the hold must engage BEFORE the shift-forced clone anchors the selection, or a ' +
    'frame written in between slides the text out from under the pointer');

  // Output arriving mid-gesture is now held.
  TerminalPane.prototype._enqueueWrite.call(pane, 'mid-drag');
  assert.strictEqual(pane.writes.join(''), 'live-before-drag', 'nothing may paint mid-drag');
  assert.strictEqual(pane._writeBuf, 'mid-drag');
});

check('v3 executed: a click that selects NOTHING releases the hold immediately', () => {
  const { handlers, pane } = installInterceptor();
  handlers.mousedown(mouseEvent('mousedown'));
  TerminalPane.prototype._enqueueWrite.call(pane, 'arrived-during-click');
  assert.strictEqual(pane._selectHold, true);
  pane.hasSelection = false; // xterm selected nothing during the clone dispatch
  handlers.mouseup(mouseEvent('mouseup'));
  assert.strictEqual(pane._selectHold, false,
    'a stray click must never leave the pane paused: the user would not know to undo it');
  assert.strictEqual(pane.writes.join(''), 'arrived-during-click',
    'whatever was held during the click must be flushed');
  assert.strictEqual(pane._selectMode, true, 'the mode itself is untouched');
});

check('v3 executed: a drag that DID select keeps the hold after mouseup', () => {
  const { handlers, pane } = installInterceptor();
  handlers.mousedown(mouseEvent('mousedown'));
  TerminalPane.prototype._enqueueWrite.call(pane, 'held');
  pane.hasSelection = true;
  handlers.mouseup(mouseEvent('mouseup'));
  assert.strictEqual(pane._selectHold, true,
    'the selection is on screen and must stay protected until it goes away');
  assert.strictEqual(pane.writes.length, 0, 'output is still held');
  assert.strictEqual(pane._selectDragging, false, 'the gesture itself is over');
});

check('v3 executed: a drag that ended OUTSIDE the pane cannot strand the hold', () => {
  // xterm tracks the tail of a drag on document, so a mouseup beyond the pane
  // never reaches this container listener. The first buttonless move back over
  // the terminal closes the gesture.
  const { handlers, pane } = installInterceptor();
  handlers.mousedown(mouseEvent('mousedown'));
  assert.strictEqual(pane._selectHold, true);
  pane.hasSelection = false;
  handlers.mousemove(mouseEvent('mousemove', { buttons: 0 }));
  assert.strictEqual(pane._selectDragging, false, 'the stale drag flag must be cleared');
  assert.strictEqual(pane._selectHold, false, 'and the hold must not outlive the gesture');
});

check('v3 executed: onSelectionChange releases only when the gesture is really over', () => {
  const { handlers, pane } = installInterceptor();
  handlers.mousedown(mouseEvent('mousedown'));
  TerminalPane.prototype._enqueueWrite.call(pane, 'held-frames');

  // Mid-drag xterm reports intermediate states, including an empty one when
  // the pointer is back at the anchor cell. Releasing there would resume
  // output in the middle of the user's own gesture.
  pane.hasSelection = false;
  assert.strictEqual(TerminalPane.prototype._onSelectionChanged.call(pane), false,
    'an empty intermediate update during a drag must not release');
  assert.strictEqual(pane._selectHold, true);
  assert.strictEqual(pane.writes.length, 0);

  // Gesture ends WITH a selection: still held.
  pane.hasSelection = true;
  handlers.mouseup(mouseEvent('mouseup'));
  assert.strictEqual(pane._selectHold, true);
  assert.strictEqual(TerminalPane.prototype._onSelectionChanged.call(pane), false,
    'a selection that still exists keeps the pause');

  // The selection is cleared (a click elsewhere, xterm clearing it): release.
  pane.hasSelection = false;
  assert.strictEqual(TerminalPane.prototype._onSelectionChanged.call(pane), true);
  assert.strictEqual(pane._selectHold, false);
  assert.strictEqual(pane.writes.join(''), 'held-frames',
    'everything held during the selection must land in one write');
  assert.strictEqual(pane._selectMode, true, 'clearing a selection is not turning the mode off');
  assert.strictEqual(TerminalPane.prototype._onSelectionChanged.call(pane), false,
    'with no hold there is nothing to release');
});

check('v3: copying does NOT release the hold', () => {
  // Ctrl+C with a selection is withheld from xterm (no onData), the native
  // copy leaves the selection in place, and nothing in the copy path touches
  // the hold. Proven structurally plus by the absence of a release call.
  const handler = extractBlock(termSrc, 'this.term.attachCustomKeyEventHandler((e) => {');
  const copyBranch = extractBlock(handler, "if (mod && shortcutKey === 'c') {");
  assert.ok(/return false/.test(copyBranch), 'a selected Ctrl+C must not reach xterm');
  assert.ok(!copyBranch.includes('_releaseSelectHold'),
    'copying must leave the pause and the selection exactly as they are');
  assert.ok(!copyBranch.includes('_exitSelectModeForInput'), 'copying is not input');
  const copyAll = extractBlock(termSrc, '_copyAllFromCopyView() {');
  assert.ok(!copyAll.includes('_releaseSelectHold'), 'Copy all must not resume output either');
  // Executed: a pane holding a selection stays held across a copy read.
  const { handlers, pane } = installInterceptor();
  handlers.mousedown(mouseEvent('mousedown'));
  pane.hasSelection = true;
  handlers.mouseup(mouseEvent('mouseup'));
  const before = pane._selectHold;
  const copied = pane.getCopySelection();
  assert.strictEqual(copied.hasSelection, true);
  assert.strictEqual(pane._selectHold, before, 'reading the selection must not change the hold');
});

check('v3 executed: a HELD selection swallows the wheel in the ALTERNATE buffer', () => {
  const { handler, scrolled } = installWheelGuard(true, 'alternate', true);
  let prevented = false;
  let stopped = false;
  handler({ deltaY: 100, deltaMode: 0, cancelable: true, target: null,
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
  assert.strictEqual(prevented, true, 'the app must never repaint under a live selection');
  assert.strictEqual(stopped, true, 'xterm must not forward the wheel to the PTY while selecting');
  assert.strictEqual(scrolled.length, 0, 'the alternate buffer has no scrollback to scroll');
});

check('executed: ON translates the wheel into local scrolling in the NORMAL buffer', () => {
  // Local scrolling moves the viewport without writing a cell, so it is safe
  // in BOTH states: with nothing selected it is how a shell pane scrolls, and
  // with a selection held it leaves the absolute buffer coordinates the
  // selection is anchored to untouched (and keeps drag-at-edge extension).
  for (const hold of [false, true]) {
    const { handler, scrolled } = installWheelGuard(true, 'normal', hold);
    handler({ deltaY: -100, deltaMode: 0, cancelable: true, target: null,
      preventDefault: () => {}, stopImmediatePropagation: () => {} });
    assert.deepStrictEqual(scrolled, [-rt.SELECT_FREEZE_WHEEL_LINES],
      'a shell pane keeps scrollback, so Select mode still scrolls it (hold=' + hold + ')');
  }
});

check('executed: the wheel guard never steals a scroll inside the Copy view overlay', () => {
  const { handler, pane, scrolled } = installWheelGuard(true, 'normal');
  const target = {};
  pane._copyOverlayOpen = true;
  pane._copyOverlay = { contains: (el) => el === target };
  let prevented = false;
  handler({ deltaY: 100, deltaMode: 0, cancelable: true, target,
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {} });
  assert.strictEqual(prevented, false, 'the overlay is an ordinary scrollable element');
  assert.strictEqual(scrolled.length, 0, 'it must not be converted into terminal scrolling');
});

check('executed: reinstalling the guard replaces rather than stacks the listener', () => {
  const removed = [];
  const container = {
    addEventListener: () => {},
    removeEventListener: (type) => removed.push(type),
  };
  const pane = Object.assign(Object.create(TerminalPane.prototype), {
    containerId: 'c', _selectMode: false,
    _selWheelHandler: () => {}, _selWheelTarget: container,
    _copyOverlay: null, _copyOverlayOpen: false,
    _getOwnedContainer: () => container,
    term: { rows: 30, buffer: { active: { type: 'normal' } }, scrollLines: () => {} },
  });
  TerminalPane.prototype._installSelectModeWheelGuard.call(pane);
  assert.deepStrictEqual(removed, ['wheel'], 'a remount into the same slot must remove the old guard first');
});

/* ============================================================
   4. Copy view: snapshot composition
   ============================================================ */

check('_collapseBlankRuns collapses runs of 3+ blanks to one and trims the ends', () => {
  const out = TerminalPane._collapseBlankRuns([
    '', '', 'first', '', 'second', '', '', '', '', 'third', '', '', '',
  ]);
  assert.deepStrictEqual(out, ['first', '', 'second', '', 'third'],
    'leading blanks drop, a 1-blank gap survives, a 4-blank run collapses, trailing blanks drop');
});

check('_collapseBlankRuns preserves a 2-blank paragraph gap (below the limit)', () => {
  assert.strictEqual(rt.COPY_VIEW_BLANK_RUN_LIMIT, 3);
  const out = TerminalPane._collapseBlankRuns(['a', '', '', 'b']);
  assert.deepStrictEqual(out, ['a', '', '', 'b']);
});

check('_readBufferLines walks the whole buffer and survives unreadable rows', () => {
  const buf = {
    length: 3,
    getLine: (i) => {
      if (i === 1) throw new Error('row vanished mid-read');
      return fakeLine('row' + i);
    },
  };
  assert.deepStrictEqual(TerminalPane._readBufferLines(buf), ['row0', '', 'row2']);
  assert.deepStrictEqual(TerminalPane._readBufferLines(null), [], 'a missing buffer yields no lines');
});

check('_composeCopyViewText joins BOTH buffers with a divider when the alt buffer is active', () => {
  const bufferApi = {
    normal: fakeBuffer(['$ npm start', 'booting', '', '', '', 'ready'], 'normal'),
    active: fakeBuffer(['+- prompt -+', '| hello   |', '+----------+'], 'alternate'),
  };
  const text = TerminalPane.prototype._composeCopyViewText.call({}, bufferApi);
  const lines = text.split('\n');
  assert.ok(lines.includes('$ npm start'), 'the pre-TUI transcript must be included');
  assert.ok(lines.includes('ready'), 'shell scrollback must be included');
  assert.ok(lines.includes(rt.COPY_VIEW_DIVIDER), 'a divider must separate transcript from live frame');
  assert.ok(lines.includes('| hello   |'), 'the live full-screen frame must be included');
  const dividerAt = lines.indexOf(rt.COPY_VIEW_DIVIDER);
  assert.ok(lines.indexOf('ready') < dividerAt, 'transcript comes first');
  assert.ok(lines.indexOf('| hello   |') > dividerAt, 'current screen comes last');
  assert.strictEqual(lines.filter((l) => l === '').length, 1,
    'the 3-blank padding run between transcript lines must collapse to one');
});

check('_composeCopyViewText reads the normal buffer alone when no app is running', () => {
  const normal = fakeBuffer(['line-a', 'line-b'], 'normal');
  const text = TerminalPane.prototype._composeCopyViewText.call({}, { normal, active: normal });
  assert.strictEqual(text, 'line-a\nline-b');
  assert.ok(!text.includes(rt.COPY_VIEW_DIVIDER), 'no divider without an alternate buffer');
});

check('_composeCopyViewText omits the divider when there is no transcript above it', () => {
  const bufferApi = {
    normal: fakeBuffer(['', '', ''], 'normal'),
    active: fakeBuffer(['only the frame'], 'alternate'),
  };
  const text = TerminalPane.prototype._composeCopyViewText.call({}, bufferApi);
  assert.strictEqual(text, 'only the frame');
});

check('_composeCopyViewText never throws on a missing or empty buffer namespace', () => {
  assert.strictEqual(TerminalPane.prototype._composeCopyViewText.call({}, null), '');
  assert.strictEqual(TerminalPane.prototype._composeCopyViewText.call({}, {}), '');
});

/* ============================================================
   5. Copy view: overlay behavior and lifecycle
   ============================================================ */

check('opening the Copy view does NOT freeze the live terminal', () => {
  const open = extractBlock(termSrc, '_openCopyView() {');
  assert.ok(!/setSelectMode|_isWriteFrozen\s*=/.test(open),
    'the overlay is a snapshot; the session underneath must keep streaming');
});

check('the snapshot is rendered as TEXT, never as markup', () => {
  const refresh = extractBlock(termSrc, '_refreshCopyView() {');
  assert.ok(refresh.includes('textContent'), 'terminal output must be assigned via textContent');
  assert.ok(!refresh.includes('innerHTML'), 'terminal output must never be parsed as HTML');
});

check('the overlay is selectable, scrollable, focusable, and monospaced', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(/user-select:text/.test(ensure), 'text must be selectable');
  assert.ok(/-webkit-user-select:text/.test(ensure), 'long-press selection needs the webkit alias on touch');
  assert.ok(/overflow:auto/.test(ensure), 'the snapshot pane must scroll');
  assert.ok(/white-space:pre-wrap/.test(ensure), 'long lines must wrap instead of overflowing');
  assert.ok(/tabIndex/.test(ensure), 'the snapshot must be focusable so its key handler receives keys');
  // SANCTIONED EDIT SE-4 (BUILD-CONTRACT.md 5.4, phase P1.2): Notion restyle:
  // the terminal mono stack is --font-code per PROCEDURE 5.3 option C. The
  // assertion still proves the same property, that the snapshot cannot render
  // proportionally; it just names the token the family now comes from.
  assert.ok(/var\(--font-code/.test(ensure), 'terminal text must stay monospaced');
});

check('the overlay is themed with CSS custom properties plus literal fallbacks', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(/var\(--mantle/.test(ensure) || /var\(--surface0/.test(ensure), 'background must follow the theme');
  assert.ok(/var\(--text/.test(ensure), 'foreground must follow the theme');
  assert.ok(/var\(--surface1/.test(ensure), 'borders must follow the theme');
  assert.ok(/var\(--mantle, #181825\)/.test(ensure),
    'every token needs a literal fallback for a stale cached stylesheet');
});

check('the overlay keeps Esc, Ctrl+A and every other key to itself', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  const onKey = extractBlock(ensure, 'const onKey = (e) => {');
  assert.ok(onKey.includes('e.stopPropagation()'), 'app-level shortcuts must not fire from inside the overlay');
  assert.ok(/Escape/.test(onKey), 'Esc must close the overlay');
  assert.ok(/_selectAllInCopyView/.test(onKey), 'Ctrl+A must be scoped to the snapshot');
  assert.ok(ensure.includes("addEventListener('mousedown', (e) => e.stopPropagation())"),
    'a click inside the overlay must not re-focus the terminal underneath');
});

check('Copy all routes through the universal clipboard helper (works on plain http)', () => {
  const copyAll = extractBlock(termSrc, '_copyAllFromCopyView() {');
  assert.ok(copyAll.includes('TerminalPane.copyTextToClipboard'), 'must reuse the no-throw helper');
  assert.ok(!/navigator\.clipboard/.test(copyAll), 'a bare clipboard property access throws on insecure origins');
  assert.ok(/Copied/.test(copyAll), 'the button must confirm a successful copy');
});

check('executed: Copy all copies the composed snapshot and reports both outcomes', () => {
  const original = TerminalPane.copyTextToClipboard;
  /**
   * Drive _copyAllFromCopyView with a stubbed clipboard helper and read the
   * button label it left behind.
   * @param {Function} helper - Replacement for the static clipboard helper.
   * @returns {{label: string, seen: string[]}}
   */
  const run = (helper) => {
    const seen = [];
    const btn = { textContent: 'Copy all' };
    const f = { _copyOverlayBtns: { copy: btn }, _copyViewText: 'SNAPSHOT', _copyFeedbackTimer: null };
    TerminalPane.copyTextToClipboard = (text) => { seen.push(text); return helper(text); };
    try {
      TerminalPane.prototype._copyAllFromCopyView.call(f);
    } finally {
      if (f._copyFeedbackTimer) clearTimeout(f._copyFeedbackTimer);
    }
    return { label: btn.textContent, seen };
  };
  try {
    // A non-thenable return settles synchronously through the success arm.
    const ok = run(() => true);
    assert.deepStrictEqual(ok.seen, ['SNAPSHOT'], 'the composed snapshot is what gets copied');
    assert.strictEqual(ok.label, 'Copied');
    // A throwing helper must be contained, not propagated out of a click.
    const bad = run(() => { throw new Error('clipboard exploded'); });
    assert.strictEqual(bad.label, 'Copy failed', 'a failure must be reported, never swallowed silently');
  } finally {
    TerminalPane.copyTextToClipboard = original;
  }
});

check('the mobile touch engine yields every gesture inside the overlay', () => {
  const init = extractBlock(termSrc, 'initMobileInputMode() {');
  for (const anchor of ['const onTouchStart = (e) => {', 'const onTouchMove = (e) => {', 'const onTouchEnd = (e) => {']) {
    const body = extractBlock(init, anchor);
    assert.ok(body.includes('_isInsideCopyView(e.target)'),
      anchor + ' must let the overlay scroll and long-press natively');
    assert.ok(body.indexOf('_isInsideCopyView') < body.indexOf('stopPropagation'),
      anchor + ' must bail before it starts stealing the gesture');
  }
});

check('_isInsideCopyView is false unless the overlay is open and contains the target', () => {
  const target = {};
  const closed = { _copyOverlayOpen: false, _copyOverlay: { contains: () => true } };
  assert.strictEqual(TerminalPane.prototype._isInsideCopyView.call(closed, target), false);
  const open = { _copyOverlayOpen: true, _copyOverlay: { contains: (el) => el === target } };
  assert.strictEqual(TerminalPane.prototype._isInsideCopyView.call(open, target), true);
  assert.strictEqual(TerminalPane.prototype._isInsideCopyView.call(open, {}), false);
  assert.strictEqual(TerminalPane.prototype._isInsideCopyView.call({}, target), false,
    'a pane with no overlay must answer false, never throw');
});

check('repeated opens reuse one overlay instead of stacking DOM nodes', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(/if \(this\._copyOverlay\) return this\._copyOverlay;/.test(ensure),
    'the overlay must be created at most once per pane');
  assert.ok(/this\.paneEl \|\| this\._getOwnedContainer\(\)/.test(ensure),
    'the host must be resolved through the ownership helper, not a raw id lookup');
});

check('toggleCopyView flips open state through the same entry point as the header button', () => {
  const f = {
    _copyOverlayOpen: false, closed: 0, opened: 0,
    _closeCopyView() { this.closed++; this._copyOverlayOpen = false; },
    _openCopyView() { this.opened++; this._copyOverlayOpen = true; return true; },
  };
  assert.strictEqual(TerminalPane.prototype.toggleCopyView.call(f), true);
  assert.strictEqual(f.opened, 1);
  assert.strictEqual(TerminalPane.prototype.toggleCopyView.call(f), false);
  assert.strictEqual(f.closed, 1);
});

check('the Copy view button is injected next to the Select toggle in the pane header', () => {
  const inject = extractBlock(termSrc, '_injectCopyControls() {');
  assert.ok(/terminal-pane-copyview/.test(inject), 'the button needs its own class for teardown and tests');
  assert.ok(/btn btn-ghost btn-icon btn-sm/.test(inject), 'it must match the sibling header icon buttons');
  assert.ok(/toggleCopyView\(\)/.test(inject), 'clicking it must open the overlay');
  assert.ok(inject.indexOf("header.querySelector('.terminal-pane-copyview')") !== -1,
    'a remount into the same slot must not stack buttons');
  assert.ok(inject.indexOf('this._selectModeBtn = btn;') < inject.indexOf('terminal-pane-copyview'),
    'Copy view sits after the Select toggle, before the close button');
});

check('dispose() removes the overlay, the button, the wheel guard and the freeze', () => {
  const dispose = extractBlock(termSrc, 'dispose() {');
  assert.ok(dispose.includes('_destroyCopyView()'), 'overlay + its listeners must be torn down');
  assert.ok(dispose.includes('_removeSelectModeWheelGuard()'), 'the capture-phase wheel guard must be removed');
  assert.ok(dispose.includes('this._copyViewBtn.remove()'), 'the header button must be removed');
  assert.ok(/this\._selectMode = false/.test(dispose), 'a disposed pane must not stay frozen');
  assert.ok(!dispose.includes('_saveSelectModePreference'),
    'closing a pane is not the user changing their mind: the preference must survive');
  const destroy = extractBlock(termSrc, '_destroyCopyView() {');
  assert.ok(destroy.includes("removeEventListener('keydown'"), 'the overlay key handler must be detached');
  assert.ok(destroy.includes('this._copyOverlay.remove()'), 'the overlay node must leave the DOM');
});

check('detachHostBindings() releases the same v2 surfaces dispose() relies on', () => {
  const detach = extractBlock(termSrc, 'detachHostBindings() {');
  assert.ok(detach.includes('_removeSelectModeWheelGuard()'));
  assert.ok(detach.includes('_destroyCopyView()'));
  assert.ok(detach.includes('this._copyViewBtn.remove()'));
  assert.ok(detach.includes('_unfreezeAndFlush()'), 'an unhosted pane must not sit on held output');
  assert.ok(detach.indexOf('this.paneEl = null;') < detach.indexOf('_unfreezeAndFlush()'),
    'the drain has to run after the host is released or the freeze gate is still closed');
  assert.ok(!/this\._selectMode = false/.test(detach),
    'a pane move or group cache must not silently turn Select mode off');
});

check('all Copy view state is per instance (two panes never share an overlay)', () => {
  const a = new TerminalPane('c1', 's1', 'A', {});
  const b = new TerminalPane('c2', 's2', 'B', {});
  a._copyOverlay = { fake: true };
  a._copyOverlayOpen = true;
  a._selectMode = true;
  assert.strictEqual(b._copyOverlay, null, 'a second pane must have its own overlay slot');
  assert.strictEqual(b._copyOverlayOpen, false);
  assert.strictEqual(b._selectMode, false, 'freeze state is per pane');
});

/* ============================================================
   6. Strip copy: the user is told what changed
   ============================================================ */

check('the strip explains scrolling, the pause, the copy paths, and how to resume', () => {
  const text = TerminalPane.SELECT_STRIP_TEXT;
  // v3 wording: v2 led with "output paused", which was true from the instant
  // the toggle went on and described exactly the behavior the user rejected.
  assert.ok(/scroll/i.test(text), 'must say scrolling still works, which is the v3 change');
  assert.ok(/pause/i.test(text), 'must still say output pauses');
  assert.ok(/drag/i.test(text), 'must tie the pause to the drag, not to the toggle');
  assert.ok(/Ctrl\+C/.test(text), 'must name the copy key');
  assert.ok(/Copy view/i.test(text), 'must point at the copy-everything path');
  assert.ok(/type|typing/i.test(text), 'must say how live output resumes');
  // The forbidden dash is built from its code point rather than typed: this
  // repo bans the literal character in source, so a gate containing one would
  // be self-defeating.
  assert.ok(text.indexOf(String.fromCharCode(0x2014)) === -1, 'no em dashes in user-facing copy');
});

check('a transient notice restores the standing strip text instead of sticking', () => {
  const show = extractBlock(termSrc, '_showSelectModeStrip() {');
  assert.ok(show.includes('TerminalPane.SELECT_STRIP_TEXT'),
    're-showing the strip must re-assert its default text');
  const notice = extractBlock(termSrc, '_showSelectModeNotice(text, ms) {');
  assert.ok(notice.includes('_selNoticeTimer'), 'the notice must be time-bounded');
  assert.ok(notice.includes('_hideSelectModeStrip()'),
    'a notice shown after the mode ended must stand down again');
});

/* ============================================================
   7. Visible-pane width claim
   ============================================================ */

/**
 * Minimal pane fake for the geometry-claim paths: records what went out on the
 * socket, counts fits, and starts with every guard open.
 *
 * @param {object} [over] - Fields to override.
 * @returns {object} The fake pane instance (used as `this`).
 */
function makeClaimFake(over) {
  const fake = Object.assign(Object.create(TerminalPane.prototype), {
    sent: [],
    fits: 0,
    logs: [],
    containerId: 'c', sessionId: 's',
    paneEl: { classList: { remove() {}, toggle() {} } },
    term: { cols: 60, rows: 24 },
    ws: { readyState: 1, send(payload) { fake.sent.push(payload); } },
    _selectMode: false,
    _freezeBlockedUntil: 0,
    _lastActivateAt: 0,
    _lastActivateCols: null,
    _lastActivateRows: null,
    _activatePending: false,
    _activateBlockedUntil: 0,
    _activateRetryTimer: null,
    _writeBuf: '',
    _fitDeferredWhileFrozen: false,
    _writeRaf: null,
    _bgFlushTimer: null,
    safeFit() { fake.fits++; },
    _log(msg) { fake.logs.push(msg); },
    _updateSelectModeUI() {},
    _dismissCopyHint() {},
  });
  return Object.assign(fake, over || {});
}

/**
 * Load a fresh runtime whose document.getElementById resolves to the given
 * fake container and whose IntersectionObserver is a stub. Used by the
 * executed visibility checks.
 *
 * @param {object} container - Fake element with addEventListener/querySelector.
 * @param {Function} [observerCtor] - Stub IntersectionObserver constructor.
 * @returns {object} { TerminalPane }
 */
function loadRuntimeWithObserver(container, observerCtor) {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const win = { matchMedia: () => ({ matches: false }) };
  const doc = { documentElement: { dataset: {} }, getElementById: () => container };
  const WebSocketStub = Object.assign(function () {}, { OPEN: 1 });
  const factory = new Function(
    'window', 'document', 'Terminal', 'FitAddon', 'WebSocket', 'localStorage',
    'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    'IntersectionObserver',
    termSrc + '\nreturn { TerminalPane: TerminalPane };'
  );
  return factory(
    win, doc, function () {}, { FitAddon: function () {} }, WebSocketStub, storage,
    { maxTouchPoints: 0 }, (fn) => { if (typeof fn === 'function') fn(); return 1; }, () => {},
    setTimeout, clearTimeout, observerCtor || undefined
  );
}

check('a claim sends the existing activate control message and nothing else', () => {
  const f = makeClaimFake();
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), true);
  assert.strictEqual(f.sent.length, 1);
  assert.deepStrictEqual(JSON.parse(f.sent[0]), { type: 'activate' },
    'the claim must reuse the wire message the server already understands');
});

check('the pane fits BEFORE claiming so the server stores current geometry', () => {
  const order = [];
  const f = makeClaimFake();
  f.safeFit = () => order.push('fit');
  f.ws.send = () => order.push('send');
  TerminalPane.prototype._requestActivate.call(f, 'visible');
  assert.deepStrictEqual(order, ['fit', 'send']);
});

check('two rapid triggers claim once (debounce)', () => {
  const f = makeClaimFake();
  const first = TerminalPane.prototype._requestActivate.call(f, 'visible');
  const second = TerminalPane.prototype._requestActivate.call(f, 'focus');
  assert.strictEqual(first, true, 'the first trigger claims');
  assert.strictEqual(second, false, 'a second trigger inside the debounce window is dropped');
  assert.strictEqual(f.sent.length, 1, 'exactly one claim on the wire for one user gesture');
  assert.ok(rt.ACTIVATE_DEBOUNCE_MS >= 500, 'debounce window must cover a visibility + focus pair');
});

check('an identical-geometry re-claim is suppressed, then allowed again after the reassert window', () => {
  const f = makeClaimFake();
  TerminalPane.prototype._requestActivate.call(f, 'visible');
  assert.strictEqual(f.sent.length, 1);
  // Past the debounce but still inside the reassert window, same cols/rows.
  f._lastActivateAt = Date.now() - (rt.ACTIVATE_DEBOUNCE_MS + 50);
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), false);
  assert.strictEqual(f.sent.length, 1, 'no wire traffic for an unchanged viewport');
  // Past the reassert window: ownership may have moved, so claim again.
  f._lastActivateAt = Date.now() - (rt.ACTIVATE_REASSERT_MS + 50);
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), true);
  assert.strictEqual(f.sent.length, 2);
});

check('a changed viewport claims immediately once past the debounce', () => {
  const f = makeClaimFake();
  TerminalPane.prototype._requestActivate.call(f, 'visible');
  f._lastActivateAt = Date.now() - (rt.ACTIVATE_DEBOUNCE_MS + 50);
  f.term.cols = 60;
  f.term.rows = 40; // rotation or keyboard dismissal
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), true);
  assert.strictEqual(f.sent.length, 2, 'a real geometry change must not be suppressed');
});

check('no claim while output is frozen; it is remembered and sent on unfreeze', () => {
  const f = makeClaimFake({ _selectMode: true, _selectHold: true, term: { cols: 60, rows: 24, write() {} } });
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), false);
  assert.strictEqual(f.sent.length, 0, 'a claim would repaint the whole frame into the hold queue');
  assert.strictEqual(f._activatePending, true, 'the intent must be remembered');
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.strictEqual(f.sent.length, 1, 'the deferred claim goes out once the freeze lifts');
  assert.strictEqual(f._activatePending, false);
});

check('the public activate() also defers while frozen and never fits mid-selection', () => {
  const f = makeClaimFake({ _selectMode: true, _selectHold: true });
  TerminalPane.prototype.activate.call(f);
  assert.strictEqual(f.sent.length, 0, 'app-layer activate must respect the freeze too');
  assert.strictEqual(f.fits, 0, 'a fit could change the row count and clear the selection');
  assert.strictEqual(f._activatePending, true);
});

check('the public activate() sends, fits and records bookkeeping when not frozen', () => {
  const f = makeClaimFake();
  TerminalPane.prototype.activate.call(f);
  assert.strictEqual(f.sent.length, 1, 'the v1 behavior is unchanged for the app layer');
  assert.strictEqual(f.fits, 1);
  assert.strictEqual(f._lastActivateCols, 60, 'a manual claim must feed the debounce clock too');
  assert.strictEqual(f._lastActivateRows, 24);
  // The recorded claim now suppresses a redundant automatic one.
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'focus'), false);
});

check('a claim deferred by the freeze survives a resync as a queued retry', () => {
  const f = makeClaimFake({ _selectMode: true, _selectHold: true, _activatePending: true, term: { cols: 60, rows: 24, write() {} } });
  TerminalPane.prototype._discardSelectModeHold.call(f);
  assert.strictEqual(f._activatePending, false, 'the pending flag is converted, not dropped');
  assert.ok(f._activateRetryTimer, 'the intent must wait behind the replay as a retry');
  clearTimeout(f._activateRetryTimer);
  f._activateRetryTimer = null;
});

check('no claim during the connect or replay quiet window; a retry is queued instead', () => {
  const f = makeClaimFake({ _activateBlockedUntil: Date.now() + rt.ACTIVATE_CONNECT_GUARD_MS });
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), false);
  assert.strictEqual(f.sent.length, 0, 'resizing mid-replay would tear the replayed screen');
  assert.ok(f._activateRetryTimer, 'the intent must survive the quiet window as a retry');
  clearTimeout(f._activateRetryTimer);
  f._activateRetryTimer = null;
});

check('only one retry timer is outstanding per pane', () => {
  const f = makeClaimFake({ _activateBlockedUntil: Date.now() + rt.ACTIVATE_CONNECT_GUARD_MS });
  TerminalPane.prototype._requestActivate.call(f, 'visible');
  const first = f._activateRetryTimer;
  TerminalPane.prototype._requestActivate.call(f, 'focus');
  assert.strictEqual(f._activateRetryTimer, first, 'a second request must not stack timers');
  clearTimeout(f._activateRetryTimer);
  f._activateRetryTimer = null;
});

check('a closed or missing socket claims nothing', () => {
  const closed = makeClaimFake({ ws: { readyState: 3, send() { assert.fail('must not send'); } } });
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(closed, 'visible'), false);
  const none = makeClaimFake({ ws: null });
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(none, 'visible'), false);
});

check('a send failure is swallowed and not recorded as a successful claim', () => {
  const f = makeClaimFake({ ws: { readyState: 1, send() { throw new Error('socket died'); } } });
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), false);
  assert.strictEqual(f._lastActivateAt, 0, 'a failed claim must not arm the debounce');
});

check('executed: only the hidden-to-visible EDGE claims, and only past the ratio', () => {
  let cb = null;
  const observed = [];
  let options = null;
  const container = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
  };
  function FakeObserver(fn, opts) { cb = fn; options = opts; }
  FakeObserver.prototype.observe = function (el) { observed.push(el); };
  FakeObserver.prototype.disconnect = function () {};
  const rt2 = loadRuntimeWithObserver(container, FakeObserver);
  const claims = [];
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _paneVisible: false, _paneObserver: null,
    _activateFocusHandler: null, _activateFocusTarget: null, _activateRetryTimer: null,
    _activatePending: false,
    _getOwnedContainer: () => container,
    _requestActivate(reason) { claims.push(reason); return true; },
  });
  rt2.TerminalPane.prototype._installVisibilityActivate.call(f);
  assert.strictEqual(observed.length, 1, 'the pane container must be observed');
  assert.deepStrictEqual(options.threshold, [rt.ACTIVATE_VISIBILITY_RATIO]);
  cb([{ isIntersecting: true, intersectionRatio: 0.2 }]);
  assert.deepStrictEqual(claims, [], 'a barely visible pane is not the pane being looked at');
  cb([{ isIntersecting: true, intersectionRatio: 0.9 }]);
  assert.deepStrictEqual(claims, ['visible'], 'crossing the ratio claims once');
  cb([{ isIntersecting: true, intersectionRatio: 0.95 }]);
  assert.deepStrictEqual(claims, ['visible'], 'staying visible must not re-claim');
  cb([{ isIntersecting: false, intersectionRatio: 0 }]);
  cb([{ isIntersecting: true, intersectionRatio: 0.8 }]);
  assert.deepStrictEqual(claims, ['visible', 'visible'], 'coming back into view claims again');
});

check('executed: keyboard focus on the terminal claims, and teardown detaches everything', () => {
  const listeners = [];
  let disconnected = 0;
  const textarea = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  const container = {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: (sel) => (sel === '.xterm-helper-textarea' ? textarea : null),
  };
  function FakeObserver() {}
  FakeObserver.prototype.observe = function () {};
  FakeObserver.prototype.disconnect = function () { disconnected++; };
  const rt2 = loadRuntimeWithObserver(container, FakeObserver);
  const claims = [];
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _paneVisible: false, _paneObserver: null,
    _activateFocusHandler: null, _activateFocusTarget: null, _activateRetryTimer: null,
    _activatePending: true,
    _getOwnedContainer: () => container,
    _requestActivate(reason) { claims.push(reason); return true; },
  });
  rt2.TerminalPane.prototype._installVisibilityActivate.call(f);
  assert.strictEqual(listeners.length, 1, 'a focus listener must be attached to the hidden textarea');
  assert.strictEqual(listeners[0].type, 'focus');
  listeners[0].fn();
  assert.deepStrictEqual(claims, ['focus']);
  rt2.TerminalPane.prototype._removeVisibilityActivate.call(f);
  assert.strictEqual(listeners.length, 0, 'the focus listener must be detached');
  assert.strictEqual(disconnected, 1, 'the observer must be disconnected');
  assert.strictEqual(f._activatePending, false, 'a stale deferred claim must not survive teardown');
});

check('executed: an engine without IntersectionObserver still wires the focus trigger', () => {
  const listeners = [];
  const textarea = { addEventListener: (type, fn) => listeners.push({ type, fn }), removeEventListener: () => {} };
  const container = {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: (sel) => (sel === '.xterm-helper-textarea' ? textarea : null),
  };
  const rt2 = loadRuntimeWithObserver(container, undefined);
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _paneVisible: false, _paneObserver: null,
    _activateFocusHandler: null, _activateFocusTarget: null, _activateRetryTimer: null,
    _activatePending: false,
    _getOwnedContainer: () => container,
    _requestActivate() { return true; },
  });
  rt2.TerminalPane.prototype._installVisibilityActivate.call(f);
  assert.strictEqual(f._paneObserver, null, 'no observer where the API does not exist');
  assert.strictEqual(listeners.length, 1, 'the focus trigger must still be wired');
});

check('the claim triggers follow the fixed-slot host lifecycle', () => {
  const mount = extractBlock(termSrc, 'mount() {');
  assert.ok(mount.includes('_installVisibilityActivate()'), 'mount must wire the triggers');
  const rebind = extractBlock(termSrc, 'rebindHost(containerId) {');
  assert.ok(rebind.includes('_installVisibilityActivate()'),
    'a restored pane must observe its destination slot, not the one it left');
  const detach = extractBlock(termSrc, 'detachHostBindings() {');
  assert.ok(detach.includes('_removeVisibilityActivate()'),
    'a cached pane must stop observing a slot another session can occupy');
  const dispose = extractBlock(termSrc, 'dispose() {');
  assert.ok(dispose.includes('_removeVisibilityActivate()'),
    'a disposed pane must never claim geometry for a session it no longer shows');
});

check('the claim quiet window is armed on connect, on socket open, and on a server reset', () => {
  const connectBlock = extractBlock(termSrc, 'const isReconnect = this._gotFirstData;');
  assert.ok(/_activateBlockedUntil = Date\.now\(\) \+ ACTIVATE_CONNECT_GUARD_MS/.test(connectBlock) ||
    termSrc.includes('this._activateBlockedUntil = Date.now() + ACTIVATE_CONNECT_GUARD_MS;'),
    'connect must arm the quiet window');
  const onopen = extractBlock(termSrc, 'this.ws.onopen = () => {');
  assert.ok(onopen.includes('_activateBlockedUntil'), 'socket open must re-arm the quiet window');
  const reset = extractBlock(termSrc, "} else if (msg.type === 'reset') {");
  assert.ok(reset.includes('_activateBlockedUntil'), 'a server resync must arm the quiet window');
});

/* ============================================================
   8. Focus reports are not user input (ship blocker, 2026-08-05)

   ConPTY enables DEC 1004 focus reporting on every pane, so xterm
   forwards \x1b[I / \x1b[O through term.onData, the exact channel
   Select mode watches for "the user is typing". Reproduced stack:
   toggle Select ON with the header button (the button takes focus),
   press the mouse down in the terminal to drag, xterm refocuses its
   textarea, \x1b[I arrives, the mode turns itself off, and the
   selection is made against a live screen. The relayed input frame
   hit the socket hook on the same gesture, so BOTH funnels fired.
   ============================================================ */

/**
 * Compile the production term.onData body and hand back a callable handler.
 *
 * Same technique as the RESET-branch check above: the real source is executed
 * against a fake `this`, so the test cannot pass while the shipped body says
 * something else. WebSocket is injected because the body reads its OPEN
 * constant, and TerminalPane because the body calls the static report filter.
 *
 * @returns {Function} function (data) with the production body.
 */
function compileOnDataHandler() {
  const block = extractBlock(termSrc, 'this.term.onData((data) => {');
  const body = block.slice(block.indexOf('{'));
  return new Function('TerminalPane', 'WebSocket',
    'return function (data) ' + body + ';')(TerminalPane, { OPEN: 1 });
}

check('_isTerminalReportOnly accepts focus reports, alone and concatenated', () => {
  const R = TerminalPane._isTerminalReportOnly;
  assert.strictEqual(R('\x1b[I'), true, 'DEC 1004 focus in');
  assert.strictEqual(R('\x1b[O'), true, 'DEC 1004 focus out');
  assert.strictEqual(R('\x1b[O\x1b[I'), true, 'a blur/focus pair in one chunk is still all report');
  assert.strictEqual(R('\x1b[I\x1b[I\x1b[I'), true, 'repeats stay report-only');
});

check('_isTerminalReportOnly accepts DSR cursor position and device attributes', () => {
  const R = TerminalPane._isTerminalReportOnly;
  assert.strictEqual(R('\x1b[12;34R'), true, 'CPR response');
  assert.strictEqual(R('\x1b[1;1R'), true, 'CPR at the origin');
  assert.strictEqual(R('\x1b[?62;1;6c'), true, 'primary device attributes');
  assert.strictEqual(R('\x1b[>0;10;1c'), true, 'secondary device attributes');
  assert.strictEqual(R('\x1b[I\x1b[12;34R\x1b[?62c'), true,
    'a burst mixing report KINDS is still nothing but reports');
});

check('_isTerminalReportOnly rejects every real keystroke shape', () => {
  const R = TerminalPane._isTerminalReportOnly;
  for (const key of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']) {
    assert.strictEqual(R(key), false, 'arrow key ' + JSON.stringify(key) + ' is user input');
  }
  assert.strictEqual(R('\x1b[1;5A'), false, 'a modified arrow is user input');
  assert.strictEqual(R('\x1bOA'), false, 'an SS3 application cursor key is user input');
  assert.strictEqual(R('\x1bOR'), false, 'SS3 F3 is user input, not a cursor report');
  assert.strictEqual(R('\x1b[H'), false, 'Home is user input');
  assert.strictEqual(R('\x1b[3~'), false, 'Delete is user input');
  assert.strictEqual(R('\x1b'), false, 'a bare Escape is user input');
  assert.strictEqual(R('a'), false, 'a printable character is user input');
  assert.strictEqual(R('hello'), false, 'typed text is user input');
  assert.strictEqual(R('\r'), false, 'Enter is user input');
  assert.strictEqual(R('\t'), false, 'Tab is user input');
  assert.strictEqual(R('\x03'), false, 'Ctrl+C is user input');
  assert.strictEqual(R('\x04'), false, 'Ctrl+D is user input');
  assert.strictEqual(R('\x7f'), false, 'Backspace is user input');
  assert.strictEqual(R('\x1b[200~pasted\x1b[201~'), false, 'a bracketed paste is user input');
});

check('_isTerminalReportOnly accepts SGR mouse reports (the hover field bug)', () => {
  // Field report, 2026-08-06: "as soon as I go and hover over the terminal the
  // select button stops being toggled on". An interactive CLI enables DECSET
  // 1003 any-event tracking plus SGR 1006, so moving the pointer with NO button
  // held emits one of these every few pixels on the same channel keystrokes
  // use. A measured sweep produced 81 of them in a single gesture.
  const R = TerminalPane._isTerminalReportOnly;
  assert.strictEqual(R('\x1b[<35;2;6M'), true, 'plain hover motion');
  assert.strictEqual(R('\x1b[<35;120;40M'), true, 'multi-digit coordinates');
  assert.strictEqual(R('\x1b[<0;10;5M'), true, 'left button press');
  assert.strictEqual(R('\x1b[<0;10;5m'), true, 'release uses the lowercase final byte');
  assert.strictEqual(R('\x1b[<32;10;5M'), true, 'left drag (button 0 plus the motion bit)');
  assert.strictEqual(R('\x1b[<34;10;5M'), true, 'right drag');
  // The button field is matched as a full number rather than an enumeration,
  // so modifier-varied motion codes cannot regress the filter.
  assert.strictEqual(R('\x1b[<39;10;5M'), true, 'hover with Shift');
  assert.strictEqual(R('\x1b[<43;10;5M'), true, 'hover with Meta');
  assert.strictEqual(R('\x1b[<51;10;5M'), true, 'hover with Ctrl');
  // The wheel guard normally swallows these before they are emitted; accepted
  // anyway because they are unambiguously machine-generated.
  assert.strictEqual(R('\x1b[<64;10;5M'), true, 'wheel up');
  assert.strictEqual(R('\x1b[<65;10;5M'), true, 'wheel down');
  // Legacy X10 encoding: CSI M followed by exactly three bytes.
  assert.strictEqual(R('\x1b[M !!'), true, 'legacy X10 report');
  assert.strictEqual(R('\x1b[M'), false, 'an X10 header with no payload is not a report');
  assert.strictEqual(R('\x1b[M !'), false, 'a truncated X10 payload is not a report');
});

check('_isTerminalReportOnly survives a coalesced hover BURST past the old cap', () => {
  const R = TerminalPane._isTerminalReportOnly;
  const burst = '\x1b[<35;12;7M'.repeat(40);
  assert.ok(burst.length > 64,
    'the burst must exceed the ORIGINAL 64 char cap or this proves nothing');
  assert.strictEqual(R(burst), true,
    'xterm hands several motion reports to one onData callback; rejecting the ' +
    'burst is exactly how the hover bug survived the first fix');
  assert.strictEqual(rt.TERMINAL_REPORT_MAX_CHARS, 1024, 'the cap must cover a real burst');
  // Mixed encodings inside one burst are still nothing but reports.
  assert.strictEqual(R('\x1b[I' + burst + '\x1b[<0;12;7m'), true,
    'a focus report, a motion burst and a release in one chunk are all machine output');
});

check('_isTerminalReportOnly treats a MIXED chunk as input, so the pane unfreezes', () => {
  const R = TerminalPane._isTerminalReportOnly;
  assert.strictEqual(R('\x1b[Ia'), false, 'report + keystroke must unfreeze');
  assert.strictEqual(R('a\x1b[I'), false, 'keystroke + report must unfreeze');
  assert.strictEqual(R('\x1b[I\r'), false, 'report + Enter must unfreeze');
  assert.strictEqual(R('\x1b[12;34Rx'), false, 'report + trailing byte must unfreeze');
  assert.strictEqual(R('\x1b[<35;2;6Ma'), false, 'mouse report + printable must unfreeze');
  assert.strictEqual(R('a\x1b[<35;2;6M'), false, 'printable + mouse report must unfreeze');
  assert.strictEqual(R('\x1b[<35;2;6M\x1b[A'), false,
    'a mouse report followed by an arrow key is still a keypress and must unfreeze');
  assert.strictEqual(R('\x1b[<35;2;6'), false, 'a truncated mouse report is not a report');
});

check('_isTerminalReportOnly rejects empty, non-string and oversized payloads', () => {
  const R = TerminalPane._isTerminalReportOnly;
  assert.strictEqual(R(''), false, '"one or more" is part of the contract');
  assert.strictEqual(R(null), false);
  assert.strictEqual(R(undefined), false);
  assert.strictEqual(R(42), false);
  assert.strictEqual(R({}), false);
  // Past the length cap the answer is deliberately "input", the fail-safe
  // direction: an unwanted unfreeze beats a swallowed selection-cancel. The
  // cap was raised to 1024 on 2026-08-06 because any-event mouse tracking
  // coalesces genuine motion bursts well past the original 64 (see the mouse
  // burst check below), so the "too long to trust" threshold moved with it.
  assert.strictEqual(R('\x1b[I'.repeat(400)), false, 'an implausibly long burst is not trusted');
  assert.strictEqual(R('\x1b[I'.repeat(64)), true,
    'a 192 character burst is now well inside the raised cap');
});

check('executed: the real onData body forwards a focus report WITHOUT unfreezing', () => {
  const handler = compileOnDataHandler();
  const sent = [];
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  f.ws = { readyState: 1, send: (p) => sent.push(p) };
  handler.call(f, '\x1b[I');
  assert.strictEqual(f._selectMode, true,
    'the focus report from the mousedown that starts a drag must not cancel Select mode');
  assert.strictEqual(f.writes.length, 0, 'the freeze must still be holding the screen still');
  assert.strictEqual(sent.length, 1, 'the report must still go to the PTY');
  assert.deepStrictEqual(JSON.parse(sent[0]), { type: 'input', data: '\x1b[I' },
    'what reaches the PTY is unchanged in every case');
});

check('executed: the real onData body still unfreezes for a genuine keystroke', () => {
  const handler = compileOnDataHandler();
  const sent = [];
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  f.ws = { readyState: 1, send: (p) => sent.push(p) };
  handler.call(f, 'a');
  assert.strictEqual(f._selectMode, false, 'typing still resumes live output');
  assert.strictEqual(f.writes.join(''), 'held', 'held frames land before the echo');
  assert.deepStrictEqual(JSON.parse(sent[0]), { type: 'input', data: 'a' });
});

check('executed: the real onData body unfreezes on a mixed report + keystroke chunk', () => {
  const handler = compileOnDataHandler();
  const sent = [];
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  f.ws = { readyState: 1, send: (p) => sent.push(p) };
  handler.call(f, '\x1b[Ix');
  assert.strictEqual(f._selectMode, false, 'any non-report content in the chunk means input');
  assert.strictEqual(f.writes.join(''), 'held');
  assert.strictEqual(sent.length, 1, 'the whole chunk still goes out unchanged');
  assert.deepStrictEqual(JSON.parse(sent[0]).data, '\x1b[Ix');
});

check('executed: hovering does not cancel Select mode on EITHER funnel', () => {
  // Both unfreeze funnels consume the same predicate, and the field bug needed
  // both to be wrong at once: onData saw the report as a keystroke, and the
  // relayed input frame hit the socket hook on the same gesture. Drive the
  // real onData body and the real socket wrapper with the exact bytes captured
  // from a browser hover sweep over a pane in any-event tracking.
  const hoverChunk = '\x1b[<35;12;7M';
  const handler = compileOnDataHandler();
  const sent = [];
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  f.ws = { readyState: 1, send: (p) => sent.push(p) };
  for (let i = 0; i < 20; i++) handler.call(f, hoverChunk);
  assert.strictEqual(f._selectMode, true, 'a hover must never cancel Select mode');
  assert.strictEqual(f.writes.length, 0, 'the freeze must still hold the screen still');
  assert.strictEqual(sent.length, 20,
    'every report must still reach the PTY: the CLI needs them for its own clickable interface');
  assert.deepStrictEqual(JSON.parse(sent[0]), { type: 'input', data: hoverChunk },
    'forwarded byte for byte');

  // Same bytes, socket funnel.
  const g = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  const relayed = [];
  const ws = TerminalPane.prototype._installInputUnfreezeHook.call(g, { send: (p) => relayed.push(p) });
  ws.send(JSON.stringify({ type: 'input', data: hoverChunk.repeat(40) }));
  assert.strictEqual(g._selectMode, true, 'a relayed hover burst must not resume live output');
  assert.strictEqual(g.writes.length, 0);
  assert.strictEqual(relayed.length, 1, 'the frame still goes out');

  // And a click that lands a real keystroke still resumes, on both funnels.
  handler.call(f, 'q');
  assert.strictEqual(f._selectMode, false, 'typing still resumes live output after a hover');
});

check('_isReportOnlyInputFrame parses the frame instead of substring matching', () => {
  const F = TerminalPane._isReportOnlyInputFrame;
  assert.strictEqual(F(JSON.stringify({ type: 'input', data: '\x1b[I' })), true);
  assert.strictEqual(F(JSON.stringify({ type: 'input', data: '\x1b[12;34R' })), true);
  assert.strictEqual(F(JSON.stringify({ type: 'input', data: 'a' })), false);
  assert.strictEqual(F(JSON.stringify({ type: 'input', data: '' })), false);
  assert.strictEqual(F(JSON.stringify({ type: 'resize', data: '\x1b[I' })), false,
    'only an input frame can be report-only');
  // Every uncertainty resolves to "not a report", which means the caller
  // unfreezes exactly as it did before the filter existed.
  assert.strictEqual(F('{"type":"input", this is not json'), false, 'a broken frame is treated as input');
  assert.strictEqual(F('null'), false);
  assert.strictEqual(F(''), false);
  assert.strictEqual(F(null), false);
  assert.strictEqual(F(undefined), false);
});

check('executed: the socket hook lets a report-only input frame pass without unfreezing', () => {
  const order = [];
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  f.term.write = (s) => order.push('write:' + s);
  const ws = { send: (payload) => order.push('send:' + payload) };
  TerminalPane.prototype._installInputUnfreezeHook.call(f, ws);
  ws.send(JSON.stringify({ type: 'input', data: '\x1b[I' }));
  assert.strictEqual(f._selectMode, true,
    'the relayed focus report must not resume live output');
  assert.deepStrictEqual(order.filter((e) => e.startsWith('write:')), [],
    'nothing may be flushed for a focus report');
  assert.strictEqual(order.length, 1, 'the frame still reaches the socket');
  assert.ok(order[0].startsWith('send:'));
});

check('executed: the socket hook still unfreezes for real input and for broken frames', () => {
  const real = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  const sentReal = [];
  TerminalPane.prototype._installInputUnfreezeHook.call(real, { send: (p) => sentReal.push(p) })
    .send(JSON.stringify({ type: 'input', data: 'ls\r' }));
  assert.strictEqual(real._selectMode, false, 'a typed frame still resumes live output');
  assert.strictEqual(real.writes.join(''), 'held');
  assert.strictEqual(sentReal.length, 1);

  // A frame that carries the token but cannot be parsed keeps the pre-filter
  // behavior: unfreeze, because a stuck frozen pane is the worse failure.
  const broken = makeFreezeFake({ _selectMode: true, _writeBuf: 'held' });
  const sentBroken = [];
  TerminalPane.prototype._installInputUnfreezeHook.call(broken, { send: (p) => sentBroken.push(p) })
    .send('{"type":"input","data":');
  assert.strictEqual(broken._selectMode, false, 'an unparseable input frame must still unfreeze');
  assert.strictEqual(broken.writes.join(''), 'held');
  assert.strictEqual(sentBroken.length, 1, 'a malformed frame is still forwarded untouched');
});

check('the Select toggle hands focus back to the terminal when it turns ON', () => {
  const inject = extractBlock(termSrc, '_injectCopyControls() {');
  const click = extractBlock(inject, "btn.addEventListener('click', (e) => {");
  assert.ok(/_refocusTerminalForSelect\(\)/.test(click),
    'turning the mode ON must return focus so the next mousedown makes no focus transition');
  assert.ok(/if \(on\)\s*this\._refocusTerminalForSelect\(\)/.test(click),
    'the refocus belongs to the turn-ON edge');
  assert.ok(click.includes('this.term.focus()'),
    'the pre-existing turn-OFF refocus must survive');
});

check('executed: _refocusTerminalForSelect defers to the pane focus policy and never throws', () => {
  let focused = 0;
  const ok = { term: {}, focus() { focused++; } };
  assert.strictEqual(TerminalPane.prototype._refocusTerminalForSelect.call(ok), true);
  assert.strictEqual(focused, 1,
    'pane.focus() is the entry point because it already declines on a mobile pane in scroll mode');
  assert.strictEqual(TerminalPane.prototype._refocusTerminalForSelect.call({ term: null }), false,
    'a pane with no terminal has nothing to focus');
  const boom = { term: {}, focus() { throw new Error('detached host'); } };
  assert.strictEqual(TerminalPane.prototype._refocusTerminalForSelect.call(boom), false,
    'a failed refocus must never break the toggle');
});

/* ============================================================
   9. Mobile parity: the controls have to EXIST on a phone

   styles-mobile.css sets display:none on .terminal-pane-header
   at phone widths, and the header buttons were the only callers
   of toggleSelectMode/toggleCopyView, so both features were
   unreachable on a phone. The mobile toolbar and the pane
   long-press action sheet are the two mobile surfaces. This
   section also covers the geometry a hidden header breaks: the
   overlay's top offset, the strip against the toolbar, and the
   touch sizing of the overlay bar.
   ============================================================ */

/**
 * Compile ONE production app.js method in isolation and hand it back.
 *
 * The method bodies exercised here only touch their arguments, `this`, and
 * `document`, so an object stub plus an injected document runs the real logic
 * with no SPA boot. Balanced-brace extraction keeps the scope exact, the same
 * way the terminal.js checks above avoid file-wide regexes.
 *
 * @param {string} anchor - Single-line method signature, indentation included.
 * @param {object} [doc] - Stub used for the compiled body's `document`.
 * @returns {Function} The production method, unbound.
 */
function compileAppMethod(anchor, doc) {
  const methodSource = extractBlock(appSrc, anchor);
  const name = anchor.trim().split('(')[0];
  const obj = new Function('document', 'return ({' + methodSource + '});')(doc || null);
  const fn = obj[name];
  assert.strictEqual(typeof fn, 'function', 'could not compile app method ' + name);
  return fn;
}

/**
 * Minimal element stub good enough for the toolbar paths: records attributes,
 * class toggles and inline styles.
 *
 * @param {object} [over] - Extra fields (dataset, querySelector, ...).
 * @returns {object} The fake element.
 */
function fakeEl(over) {
  const el = {
    dataset: {},
    style: {},
    classes: new Set(),
    attrs: {},
    className: '',
    textContent: '',
    title: '',
    classList: {
      toggle: (name, on) => { if (on) el.classes.add(name); else el.classes.delete(name); },
      contains: (name) => el.classes.has(name),
      add: (name) => el.classes.add(name),
      remove: (name) => el.classes.delete(name),
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
  };
  return Object.assign(el, over || {});
}

/**
 * Build a fake mobile toolbar carrying only the existing Copy button, so the
 * injector has the anchor it inserts after.
 *
 * @returns {{toolbar: object, children: object[]}}
 */
function fakeToolbar() {
  const children = [];
  const toolbar = fakeEl({
    querySelector: (sel) => {
      const m = /\[data-key="([^"]+)"\]/.exec(sel);
      if (!m) return null;
      return children.find((c) => c.dataset.key === m[1]) || null;
    },
    insertBefore: (node, ref) => {
      const i = children.indexOf(ref);
      children.splice(i < 0 ? children.length : i, 0, node);
      node.parentNode = toolbar;
    },
    appendChild: (node) => { children.push(node); node.parentNode = toolbar; },
  });
  const copyBtn = fakeEl({ dataset: { key: 'copy' }, parentNode: toolbar });
  children.push(copyBtn);
  toolbar.children = children;
  return { toolbar, children };
}

check('the Copy view overlay top offset is recomputed, and a HIDDEN header means top 0', () => {
  const T = TerminalPane.prototype._copyOverlayTopPx;
  // Desktop: sit exactly under the measured header.
  const desktop = { paneEl: { querySelector: () => ({ offsetHeight: 30 }) } };
  assert.strictEqual(T.call(desktop), 30);
  // Phone: styles-mobile.css hides the header, so it measures 0 and the
  // overlay must cover the pane FROM THE TOP. The old code fell through to the
  // 34px desktop fallback and left a live band of terminal above the snapshot.
  const phone = { paneEl: { querySelector: () => ({ offsetHeight: 0 }) } };
  assert.strictEqual(T.call(phone), 0, 'a hidden header occupies no space');
  // No header element at all: keep the historical fallback.
  const headerless = { paneEl: { querySelector: () => null } };
  assert.strictEqual(headerless.paneEl.querySelector('.terminal-pane-header'), null);
  assert.ok(T.call(headerless) > 0, 'an absent header keeps the measured-later fallback');
  assert.strictEqual(T.call({}), T.call(headerless), 'no host answers the same way');
  const throwing = { paneEl: { querySelector: () => { throw new Error('detached'); } } };
  assert.ok(T.call(throwing) > 0, 'a throwing lookup must fall back, never propagate');
});

check('executed: _applyCopyOverlayMetrics re-fits top offset and touch targets on every open', () => {
  const btns = { copy: fakeEl(), refresh: fakeEl(), close: fakeEl() };
  // Built on the real prototype so the method under test reaches its sibling
  // _copyOverlayTopPx exactly as it does in production.
  const f = Object.assign(Object.create(TerminalPane.prototype), {
    paneEl: { querySelector: () => ({ offsetHeight: 0 }) },
    _copyOverlay: fakeEl(),
    _copyOverlayBtns: btns,
    _isPhoneWidthLayout: () => true,
  });
  TerminalPane.prototype._applyCopyOverlayMetrics.call(f);
  assert.strictEqual(f._copyOverlay.style.top, '0px', 'the hidden-header case must cover the pane');
  for (const key of ['copy', 'refresh', 'close']) {
    assert.strictEqual(btns[key].style.minHeight, '40px',
      key + ' must meet the 40px touch floor (Copy all and Refresh shipped at 26px)');
    assert.strictEqual(btns[key].style.minWidth, '40px');
    assert.strictEqual(btns[key].style.alignItems, 'center', 'the label must center in the taller box');
  }
  // Back on a desktop layout the minimums are cleared, not pinned to a stale
  // pixel value, so the stylesheet sizing applies again.
  const desk = Object.assign(Object.create(TerminalPane.prototype), {
    paneEl: { querySelector: () => ({ offsetHeight: 30 }) },
    _copyOverlay: fakeEl(),
    _copyOverlayBtns: btns,
    _isPhoneWidthLayout: () => false,
  });
  TerminalPane.prototype._applyCopyOverlayMetrics.call(desk);
  assert.strictEqual(desk._copyOverlay.style.top, '30px');
  assert.strictEqual(btns.copy.style.minHeight, '');
  // No overlay yet, or no buttons: never throws.
  TerminalPane.prototype._applyCopyOverlayMetrics.call({});
  TerminalPane.prototype._applyCopyOverlayMetrics.call({ _copyOverlay: fakeEl(), paneEl: null });
});

check('the overlay geometry is applied at creation AND on every open', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(ensure.includes('this._copyOverlayTopPx()'),
    'creation must measure through the helper, not inline the old ternary');
  assert.ok(ensure.includes('this._applyCopyOverlayMetrics()'), 'first paint must be sized');
  const open = extractBlock(termSrc, '_openCopyView() {');
  assert.ok(open.includes('this._applyCopyOverlayMetrics()'),
    'the overlay is created once and reused, so every open must re-measure');
  assert.ok(open.indexOf('_applyCopyOverlayMetrics') < open.indexOf('_refreshCopyView'),
    'geometry before content, so the snapshot is laid out into its final box');
});

check('_isPhoneWidthLayout accepts a real touch device or a phone-width viewport', () => {
  const P = TerminalPane.prototype._isPhoneWidthLayout;
  assert.strictEqual(P.call({ _isMobile: () => true }), true, 'a real touch device qualifies');
  assert.strictEqual(P.call({ _isMobile: () => false }), false,
    'a desktop window (the sandbox has no window.innerWidth) does not');
  assert.strictEqual(P.call({ _isMobile: () => { throw new Error('no matchMedia'); } }), false,
    'a throwing probe answers false rather than propagating');
});

check('the Select-mode strip clears the mobile toolbar instead of covering it', () => {
  const B = TerminalPane.prototype._selectStripBottomPx;
  // Desktop pane: the plain inset, because nothing else owns the bottom edge.
  const desktop = { paneEl: { classList: { contains: () => false } } };
  assert.strictEqual(B.call(desktop), 8);
  // Mobile-active pane: clear the toolbar plus the type-and-send row.
  const mobile = {
    paneEl: {
      classList: { contains: (c) => c === 'mobile-active' },
      querySelector: (sel) => {
        if (sel === '.terminal-mobile-toolbar') return { offsetHeight: 50 };
        if (sel === '.terminal-mobile-input-row') return { offsetHeight: 40 };
        return null;
      },
    },
  };
  assert.strictEqual(B.call(mobile), 8 + 50 + 40,
    'the strip is pointer-events:none, so covering the toolbar hides it while leaving it tappable');
  // Hidden chrome measures 0, which naturally falls back to the fallback inset
  // rather than to zero (zero is the failure mode being fixed).
  const unmeasured = {
    paneEl: {
      classList: { contains: (c) => c === 'mobile-active' },
      querySelector: () => ({ offsetHeight: 0 }),
    },
  };
  assert.ok(B.call(unmeasured) > 8, 'an unmeasurable toolbar still gets cleared');
  assert.strictEqual(B.call({}), 8, 'no host answers with the desktop inset');
});

check('executed: the strip re-measures its placement on every show', () => {
  const strip = fakeEl();
  // Prototype-backed: _applySelectStripPlacement calls _selectStripBottomPx.
  const f = Object.assign(Object.create(TerminalPane.prototype), {
    _selStrip: strip,
    paneEl: {
      classList: { contains: (c) => c === 'mobile-active' },
      querySelector: (sel) => (sel === '.terminal-mobile-toolbar' ? { offsetHeight: 50 } : null),
    },
  });
  TerminalPane.prototype._applySelectStripPlacement.call(f);
  assert.strictEqual(strip.style.bottom, '58px');
  // The same pane, now shown on a desktop layout: the placement must follow.
  f.paneEl.classList.contains = () => false;
  TerminalPane.prototype._applySelectStripPlacement.call(f);
  assert.strictEqual(strip.style.bottom, '8px', 'placement must never be cached from a previous show');
  TerminalPane.prototype._applySelectStripPlacement.call({});
  const show = extractBlock(termSrc, '_showSelectModeStrip() {');
  const firstApply = show.indexOf('_applySelectStripPlacement');
  assert.ok(firstApply !== -1 && show.indexOf('_applySelectStripPlacement', firstApply + 1) !== -1,
    'both the cached-show and the create paths must measure');
});

check('executed: a fit re-places the strip even on the frozen (early-return) path', () => {
  // The reachable regression: a pane whose Select mode was remembered shows
  // its strip at mount, BEFORE switchTerminalTab marks the pane mobile-active,
  // so the strip is placed with the desktop inset and lands on the toolbar.
  // safeFit runs on that tab switch (and on a rotation, and when the mobile
  // type row opens), so it has to re-place before it defers for the freeze.
  const strip = fakeEl();
  const f = Object.assign(Object.create(TerminalPane.prototype), {
    fitAddon: { fit() { assert.fail('must not fit while frozen'); } },
    term: {},
    _selStrip: strip,
    _selectMode: true,
    // v3: the deferral only happens while a selection is actually held, so the
    // fake has to be in that state for this check to exercise the same path.
    _selectHold: true,
    _freezeBlockedUntil: 0,
    _fitDeferredWhileFrozen: false,
    paneEl: {
      classList: { contains: (c) => c === 'mobile-active' },
      querySelector: (sel) => (sel === '.terminal-mobile-toolbar' ? { offsetHeight: 50 } : null),
    },
  });
  TerminalPane.prototype.safeFit.call(f);
  assert.strictEqual(strip.style.bottom, '58px', 'the strip must clear the toolbar after the switch');
  assert.strictEqual(f._fitDeferredWhileFrozen, true, 'the freeze deferral itself must be unchanged');
  const fit = extractBlock(termSrc, '  safeFit() {');
  assert.ok(fit.indexOf('_applySelectStripPlacement') < fit.indexOf('_isWriteFrozen()'),
    'placing after the freeze guard would never run while the strip is on screen');
});

check('the strip paints below the floating action buttons, not over them', () => {
  const show = extractBlock(termSrc, '_showSelectModeStrip() {');
  assert.ok(!/z-index:20/.test(show), 'z-index 20 painted over the pane FABs (z-index 5)');
  assert.ok(show.includes('SELECT_STRIP_Z_INDEX'), 'the stacking order must come from the named constant');
  const apply = extractBlock(termSrc, '_applySelectStripPlacement() {');
  assert.ok(apply.includes('SELECT_STRIP_Z_INDEX'), 'a cached strip must be re-asserted at the same layer');
  const decl = /const SELECT_STRIP_Z_INDEX = (\d+);/.exec(termSrc);
  assert.ok(decl, 'the constant must be declared');
  assert.ok(Number(decl[1]) < 5,
    'the FABs sit at z-index 5 in styles.css and must render above a pointer-events:none notice');
});

check('the Copy view button carries an accessible name, not just a tooltip', () => {
  const inject = extractBlock(termSrc, '_injectCopyControls() {');
  assert.ok(/cvBtn\.setAttribute\('aria-label'/.test(inject),
    'an icon-only button needs a name before any state update runs');
  const update = extractBlock(termSrc, '_updateCopyViewUI() {');
  assert.ok(/setAttribute\('aria-label'/.test(update), 'the name must track open/closed state');
  assert.ok(/aria-pressed/.test(update), 'and it is still announced as a toggle');
});

check('the one-time hint names Copy view alongside Shift+drag and Select mode', () => {
  const hint = extractBlock(termSrc, '_maybeShowCopyHint() {');
  assert.ok(/Shift/.test(hint), 'Shift+drag is still the always-available path');
  assert.ok(/Select mode/.test(hint), 'the toggle is still named');
  assert.ok(/Copy view/.test(hint), 'the copy-everything path was missing from the onboarding card');
  assert.ok(hint.indexOf(String.fromCharCode(0x2014)) === -1, 'no em dashes in user-facing copy');
});

check('every Select/Copy view state change is announced for the mobile toolbar', () => {
  const selectUi = extractBlock(termSrc, '_updateSelectModeUI() {');
  assert.ok(selectUi.includes('_notifySelectChromeState()'),
    'a mode that ends without a toolbar tap (typing, overflow) must still be mirrored');
  const copyUi = extractBlock(termSrc, '_updateCopyViewUI() {');
  assert.ok(copyUi.includes('_notifySelectChromeState()'), 'Esc-closing the overlay must be mirrored');
  assert.ok(copyUi.indexOf('_notifySelectChromeState') < copyUi.indexOf('if (!this._copyViewBtn) return;'),
    'the announcement must precede the header-button guard, or a detached host swallows it');
  assert.strictEqual(TerminalPane.SELECT_CHROME_EVENT, 'cwm:select-chrome');
  assert.ok(appSrc.includes("document.addEventListener('cwm:select-chrome'"),
    'the app shell must listen for exactly that event name');
});

check('executed: the chrome notifier carries pane state and never throws', () => {
  const N = TerminalPane.prototype._notifySelectChromeState;
  // Every shape of missing host is tolerated: a toggle must never fail because
  // nothing is listening.
  N.call({});
  N.call({ paneEl: null });
  N.call({ paneEl: {} });
  N.call({ paneEl: { dispatchEvent: () => { throw new Error('detached host'); } } });
  const seen = [];
  N.call({
    paneEl: { dispatchEvent: (e) => seen.push(e) },
    sessionId: 's-1', _selectMode: true, _copyOverlayOpen: false,
  });
  if (typeof CustomEvent === 'function') {
    assert.strictEqual(seen.length, 1, 'the pane must announce the change');
    assert.strictEqual(seen[0].type, TerminalPane.SELECT_CHROME_EVENT);
    assert.strictEqual(seen[0].bubbles, true, 'the app shell listens on document by delegation');
    assert.strictEqual(seen[0].detail.selectMode, true);
    assert.strictEqual(seen[0].detail.copyViewOpen, false);
    assert.strictEqual(seen[0].detail.sessionId, 's-1');
  } else {
    // Older engines: the typeof guard short-circuits instead of throwing a
    // ReferenceError into the toggle, which is the property that matters.
    assert.strictEqual(seen.length, 0, 'no CustomEvent constructor means nobody can be listening');
  }
});

check('executed: the app injects Select + Copy view right after the toolbar Copy button', () => {
  const { toolbar, children } = fakeToolbar();
  const created = [];
  const doc = {
    querySelectorAll: () => [toolbar],
    createElement: () => { const el = fakeEl(); created.push(el); return el; },
  };
  const inject = compileAppMethod('  _injectMobileSelectControls() {', doc);
  assert.strictEqual(inject.call({}), 2, 'both controls must be created');
  assert.deepStrictEqual(children.map((c) => c.dataset.key), ['copy', 'select', 'copyview'],
    'they belong with the other get-text-out actions, not among the key senders');
  const [selectBtn, copyViewBtn] = created;
  assert.strictEqual(selectBtn.className, 'toolbar-select');
  assert.strictEqual(copyViewBtn.className, 'toolbar-copyview');
  assert.ok(selectBtn.textContent && copyViewBtn.textContent, 'both need a visible label');
  assert.ok(selectBtn.attrs['aria-label'] && copyViewBtn.attrs['aria-label'], 'both need an accessible name');
  assert.strictEqual(selectBtn.attrs['aria-pressed'], 'false', 'both are toggles');
  assert.strictEqual(copyViewBtn.attrs['aria-pressed'], 'false');
  // A second pass must not stack duplicates (re-init, or a future rebuild).
  assert.strictEqual(inject.call({}), 0, 'injection must be idempotent');
  assert.strictEqual(children.length, 3);
});

check('executed: the toolbar actions call the SAME pane methods the header buttons use', () => {
  const run = compileAppMethod('  _runMobileSelectToolbarAction(key, pane) {');
  const calls = [];
  const app = { synced: 0, _syncMobileSelectToolbar() { app.synced++; } };
  const pane = {
    toggleSelectMode: () => calls.push('toggleSelectMode'),
    toggleCopyView: () => calls.push('toggleCopyView'),
  };
  assert.strictEqual(run.call(app, 'select', pane), true);
  assert.strictEqual(run.call(app, 'copyview', pane), true);
  assert.deepStrictEqual(calls, ['toggleSelectMode', 'toggleCopyView'],
    'the mobile surface must not reimplement either behavior');
  assert.strictEqual(app.synced, 2, 'the button state must update in the same frame as the tap');
  assert.strictEqual(run.call(app, 'select', null), false, 'an empty slot does nothing');
  assert.strictEqual(run.call(app, 'nonsense', pane), false, 'an unknown key does nothing');
  // A read-only mirror pane shares the slot array without being a TerminalPane.
  assert.strictEqual(run.call(app, 'select', {}), false, 'a pane without the method is skipped');
  assert.strictEqual(app.synced, 2, 'a skipped action must not repaint');
});

check('executed: the toolbar mirrors Select mode and Copy view state per pane', () => {
  const sync = compileAppMethod('  _syncMobileSelectToolbar(pane, paneEl) {');
  const selectBtn = fakeEl();
  const copyViewBtn = fakeEl();
  const paneEl = {
    querySelector: (sel) => {
      if (sel.includes('"select"')) return selectBtn;
      if (sel.includes('"copyview"')) return copyViewBtn;
      return null;
    },
  };
  assert.strictEqual(sync.call({}, { _selectMode: true, _copyOverlayOpen: false }, paneEl), true);
  assert.strictEqual(selectBtn.classes.has('toolbar-active'), true,
    'Select ON needs a clear active state, matching the keyboard button idiom');
  assert.strictEqual(selectBtn.attrs['aria-pressed'], 'true');
  assert.ok(selectBtn.style.background, 'the active state must be visible without a stylesheet refresh');
  assert.strictEqual(copyViewBtn.classes.has('toolbar-active'), false);
  // The mode can end without a tap (typing resumes live output); re-reading
  // pane state is what keeps the button honest.
  sync.call({}, { _selectMode: false, _copyOverlayOpen: true }, paneEl);
  assert.strictEqual(selectBtn.classes.has('toolbar-active'), false, 'a self-exit must clear the button');
  assert.strictEqual(selectBtn.attrs['aria-pressed'], 'false');
  assert.strictEqual(selectBtn.style.background, '', 'the off state restores the stylesheet');
  assert.strictEqual(copyViewBtn.classes.has('toolbar-active'), true);
  // An empty slot clears both rather than keeping the previous pane's state.
  sync.call({}, null, paneEl);
  assert.strictEqual(copyViewBtn.classes.has('toolbar-active'), false);
  assert.strictEqual(sync.call({}, null, { querySelector: () => null }), false,
    'a pane with no toolbar reports that it did nothing');
});

check('the toolbar click handler routes both new keys to the shared action', () => {
  const handler = extractBlock(appSrc, "document.querySelectorAll('.terminal-mobile-toolbar button').forEach(btn => {");
  assert.ok(/key === 'select' \|\| key === 'copyview'/.test(handler), 'both keys must be handled');
  assert.ok(handler.includes('_runMobileSelectToolbarAction(key, activePane)'),
    'the handler must delegate rather than inline the pane calls');
  assert.ok(appSrc.indexOf('this._injectMobileSelectControls();') <
    appSrc.indexOf("document.querySelectorAll('.terminal-mobile-toolbar button')"),
    'the buttons must exist before the delegated click wiring runs, or they are dead');
});

check('the mobile tab switch re-asserts both toggles from pane state', () => {
  const switchTab = extractBlock(appSrc, '  switchTerminalTab(slotIdx) {');
  assert.ok(switchTab.includes('_syncMobileSelectToolbar(tp, activeEl)'),
    'Select mode survives a refresh, so a tab switch must re-read it rather than assume off');
  assert.ok(switchTab.includes("keyboardBtn.classList.toggle('toolbar-active', isTyping)"),
    'the existing stateful-button idiom must be preserved, not replaced');
});

check('the pane action sheet offers Select mode and Copy view', () => {
  const menu = extractBlock(appSrc, '  showTerminalContextMenu(slotIdx, x, y, copySelection, terminalPane) {');
  assert.ok(/label: tp\._selectMode \?/.test(menu), 'the label must state what the tap will do');
  assert.ok(menu.includes('tp.toggleSelectMode();'), 'the sheet must use the same entry point');
  assert.ok(menu.includes('tp.toggleCopyView();'), 'the sheet must use the same entry point');
  assert.ok(/Copy view/.test(menu), 'Copy view must be named in the sheet');
  assert.ok(menu.indexOf('tp.toggleSelectMode();') < menu.indexOf("items.push({ type: 'sep' });"),
    'the copy actions belong with the other text actions, above the destructive group');
});

check('a long press inside the Copy view selects text instead of opening the action sheet', () => {
  assert.ok(
    /TERMINAL_SURFACE_SELECTOR = '\.terminal-container, \.xterm, \.terminal-copyview'/.test(appSrc),
    'the overlay must be exempt: it renders selectable DOM text, and the sheet has Kill Session in reach');
  assert.ok(/closest\(TERMINAL_SURFACE_SELECTOR\)/.test(appSrc),
    'the exemption must still be applied through the long-press guard');
});

/* ============================================================
   10. Copy view: Full transcript source

   The terminal source can only offer what the TERMINAL saw. An
   interactive CLI keeps the conversation inside its own app and
   repaints a width-locked frame, so everything older than the
   visible screen exists only in the session transcript. The
   server already publishes that read-only through the mirror API,
   so the Copy view offers it as a second source.
   ============================================================ */

/**
 * Build a pane fake carrying just enough for the transcript source: a stubbed
 * API, the overlay elements it writes into, and a resolvable identity.
 *
 * @param {object} [over] - Fields to override.
 * @returns {object} The fake pane (used as `this`).
 */
function makeTranscriptFake(over) {
  const pre = fakeEl();
  const notice = fakeEl();
  const earlier = fakeEl();
  const fake = Object.assign(Object.create(TerminalPane.prototype), {
    calls: [],
    sessionId: 'abc-123',
    spawnOpts: { resumeSessionId: 'abc-123' },
    _providerId: 'testprov',
    _copyViewSource: 'terminal',
    _copyViewMessages: [],
    _copyViewStartOffset: null,
    _copyViewTruncatedHead: false,
    _copyViewLoading: false,
    _copyViewText: '',
    _copyOverlayPre: pre,
    _copyViewNoticeEl: notice,
    _copyViewLoadEarlierBtn: earlier,
    _copyViewSourceBtns: { terminal: fakeEl(), transcript: fakeEl() },
    term: { buffer: { active: { type: 'normal', length: 0, getLine: () => null } } },
    _scrollCopyViewToBottom() {},
    _composeCopyViewText() { return 'TERMINAL-TEXT'; },
    _copyViewApi(method, path, body) {
      fake.calls.push({ method, path, body });
      return fake.apiImpl(method, path, body);
    },
    apiImpl: () => Promise.resolve({}),
  });
  fake.pre = pre;
  fake.notice = notice;
  fake.earlier = earlier;
  return Object.assign(fake, over || {});
}

check('_renderTranscriptText labels turns and collapses tool events to one line', () => {
  const text = TerminalPane._renderTranscriptText([
    { role: 'user', kind: 'text', text: 'fix the build' },
    { role: 'assistant', kind: 'text', text: 'Looking now.', model: 'test-model' },
    { role: 'tool', kind: 'tool_use', toolName: 'Read', text: 'path/to/file.js\nline two\nline three' },
    { role: 'tool', kind: 'tool_result', text: 'ok\nmore output' },
    { role: 'assistant', kind: 'text', text: 'Fixed.', model: null },
  ]);
  const lines = text.split('\n');
  assert.ok(lines.includes('User:'), 'a pasted conversation must read as a dialogue');
  assert.ok(lines.includes('fix the build'));
  assert.ok(lines.includes('Assistant (test-model):'), 'the model belongs on the turn that used it');
  assert.ok(lines.includes('[tool: Read] path/to/file.js'),
    'a tool call collapses to ONE labelled line carrying its first line');
  assert.ok(!text.includes('line three'), 'tool payload bodies must not bloat the copy');
  assert.ok(lines.includes('[tool result] ok'), 'results collapse the same way');
  assert.ok(lines.includes('Assistant:'), 'a turn with no model still gets its label');
  assert.strictEqual(lines[lines.length - 1], 'Fixed.', 'no trailing padding');
});

check('_renderTranscriptText marks truncation and survives junk', () => {
  const text = TerminalPane._renderTranscriptText([
    { role: 'assistant', kind: 'text', text: 'partial', truncated: true },
    null,
    'not an object',
    { role: 'system', kind: 'system', text: 'compacted' },
    { kind: 'tool_use', toolName: 'Bash', text: 'ls', truncated: true },
  ]);
  assert.ok(/partial \[truncated\]/.test(text),
    'a reader must never be handed a partial quote without being told');
  assert.ok(/System:/.test(text));
  assert.ok(/\[tool: Bash\] ls \[truncated\]/.test(text));
  assert.strictEqual(TerminalPane._renderTranscriptText(null), '');
  assert.strictEqual(TerminalPane._renderTranscriptText([]), '');
  assert.strictEqual(TerminalPane._renderTranscriptText([{ kind: 'tool_use', toolName: 'X', text: '' }]),
    '[tool: X]', 'an empty tool payload still names the tool');
});

check('_copyViewIdentity resolves from pane state alone, and refuses to guess', () => {
  const I = TerminalPane.prototype._copyViewIdentity;
  assert.deepStrictEqual(
    I.call({ _providerId: 'testprov', sessionId: 'S1', spawnOpts: { resumeSessionId: 'upstream-1' } }),
    { provider: 'testprov', providerSessionId: 'upstream-1' },
    'the resumed upstream id wins');
  assert.deepStrictEqual(
    I.call({ _providerId: 'testprov', sessionId: 'S1', spawnOpts: {} }),
    { provider: 'testprov', providerSessionId: 'S1' },
    'a pane opened on an existing project session carries the id as its own');
  // Shapes the server would reject are caught here instead of as a 400.
  assert.strictEqual(I.call({ _providerId: 'BAD PROVIDER', sessionId: 'S1', spawnOpts: {} }), null);
  assert.strictEqual(I.call({ _providerId: 'testprov', sessionId: 'has spaces', spawnOpts: {} }), null);
  assert.strictEqual(I.call({ _providerId: 'testprov', spawnOpts: {} }), null,
    'a session with no upstream id yet must return null, not a guess');
  assert.strictEqual(I.call({}), null);
});

checkAsync('executed: selecting Full transcript opens, snapshots, and CLOSES the mirror', async () => {
  const f = makeTranscriptFake({
    apiImpl: (method, path) => {
      if (path === '/api/mirror/open') {
        return Promise.resolve({
          mirrorKey: 'testprov:abc-123',
          history: [{ role: 'user', kind: 'text', text: 'hello there' }],
          startOffset: 4096,
          endOffset: 8192,
          truncatedHead: true,
        });
      }
      return Promise.resolve({ ok: true });
    },
  });
  await TerminalPane.prototype._loadTranscriptSnapshot.call(f);
  const paths = f.calls.map((c) => c.method + ' ' + c.path);
  assert.deepStrictEqual(paths, ['POST /api/mirror/open', 'POST /api/mirror/close'],
    'the Copy view is a snapshot, so the live subscription must be released at once');
  assert.strictEqual(f.calls[0].body.provider, 'testprov');
  assert.strictEqual(f.calls[0].body.providerSessionId, 'abc-123');
  assert.ok(/^copyview-/.test(f.calls[0].body.deviceId), 'the device id must be pane-scoped');
  assert.strictEqual(f.calls[1].body.mirrorKey, 'testprov:abc-123');
  assert.ok(/User:/.test(f._copyViewText), 'the transcript must be rendered');
  assert.ok(/hello there/.test(f.pre.textContent), 'and written into the overlay');
  assert.strictEqual(f._copyViewStartOffset, 4096, 'the paging cursor must be kept');
  assert.strictEqual(f._copyViewTruncatedHead, true);
  assert.strictEqual(f._copyViewLoading, false);
});

checkAsync('executed: Load earlier pages backward and PREPENDS', async () => {
  const f = makeTranscriptFake({
    _copyViewSource: 'transcript',
    _copyViewMessages: [{ role: 'assistant', kind: 'text', text: 'newest turn' }],
    _copyViewStartOffset: 4096,
    _copyViewTruncatedHead: true,
    apiImpl: () => Promise.resolve({
      messages: [{ role: 'user', kind: 'text', text: 'oldest turn' }],
      startOffset: 0,
      truncatedHead: false,
    }),
  });
  const ok = await TerminalPane.prototype._loadEarlierTranscript.call(f);
  assert.strictEqual(ok, true);
  const call = f.calls[0];
  assert.strictEqual(call.method, 'GET');
  assert.ok(call.path.indexOf('/api/mirror/history') === 0);
  assert.ok(call.path.indexOf('beforeOffset=4096') !== -1,
    'paging must walk backward from the OLDEST line already loaded');
  assert.ok(call.path.indexOf('provider=testprov') !== -1);
  const text = f._copyViewText;
  assert.ok(text.indexOf('oldest turn') < text.indexOf('newest turn'),
    'earlier messages belong above what was already shown');
  assert.strictEqual(f._copyViewStartOffset, 0, 'the cursor must advance to the new head');
  assert.strictEqual(f._copyViewTruncatedHead, false, 'exhaustion is what hides the control');
  // Exhausted: the control is gone and a further call is refused.
  TerminalPane.prototype._updateCopyViewSourceUI.call(f);
  assert.strictEqual(f.earlier.hidden, true, 'nothing earlier left to load');
  const again = await TerminalPane.prototype._loadEarlierTranscript.call(f);
  assert.strictEqual(again, false, 'a start offset of 0 means the file head is loaded');
});

checkAsync('executed: a failing history endpoint degrades to an inline notice', async () => {
  const f = makeTranscriptFake({
    apiImpl: () => Promise.reject(new Error('MIRROR_UNSUPPORTED')),
  });
  const ok = await TerminalPane.prototype._loadTranscriptSnapshot.call(f);
  assert.strictEqual(ok, false);
  assert.strictEqual(f.notice.hidden, false, 'the failure must be visible where the user is looking');
  assert.ok(/MIRROR_UNSUPPORTED/.test(f.notice.textContent), 'and must say what went wrong');
  assert.strictEqual(f._copyViewLoading, false, 'a failure must not wedge the loading latch');
  // The Terminal source still works, which is the whole point of gating.
  TerminalPane.prototype._setCopyViewSource.call(f, 'terminal');
  assert.strictEqual(f._copyViewText, 'TERMINAL-TEXT');
  assert.strictEqual(f.pre.textContent, 'TERMINAL-TEXT');
  assert.strictEqual(f.notice.hidden, true, 'switching back clears the transcript notice');
});

checkAsync('executed: a pane with no upstream identity says so instead of calling the API', async () => {
  const f = makeTranscriptFake({ sessionId: 'has spaces', spawnOpts: {} });
  const ok = await TerminalPane.prototype._loadTranscriptSnapshot.call(f);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(f.calls, [], 'no identity means no request at all');
  assert.strictEqual(f.notice.hidden, false);
  assert.ok(/transcript/i.test(f.notice.textContent));
  assert.ok(/Terminal source/i.test(f.notice.textContent), 'and must point at the working alternative');
});

checkAsync('executed: an empty transcript is reported, not rendered as a blank pane', async () => {
  const f = makeTranscriptFake({
    apiImpl: (method, path) => (path === '/api/mirror/open'
      ? Promise.resolve({ mirrorKey: 'k', history: [], startOffset: 0, truncatedHead: false })
      : Promise.resolve({})),
  });
  await TerminalPane.prototype._loadTranscriptSnapshot.call(f);
  assert.strictEqual(f.notice.hidden, false);
  assert.ok(/no transcript entries/i.test(f.notice.textContent));
});

checkAsync('executed: the source switch flips state and does not re-fetch what it has', async () => {
  let opens = 0;
  const f = makeTranscriptFake({
    apiImpl: (method, path) => {
      if (path === '/api/mirror/open') {
        opens++;
        return Promise.resolve({
          mirrorKey: 'k',
          history: [{ role: 'user', kind: 'text', text: 'first' }],
          startOffset: 0, endOffset: 10, truncatedHead: false,
        });
      }
      return Promise.resolve({});
    },
  });
  await TerminalPane.prototype._loadTranscriptSnapshot.call(f);
  assert.strictEqual(opens, 1);
  f._copyViewSource = 'terminal';
  TerminalPane.prototype._setCopyViewSource.call(f, 'transcript');
  assert.strictEqual(f._copyViewSource, 'transcript');
  assert.strictEqual(opens, 1, 'flipping back to a loaded transcript must not re-fetch');
  assert.ok(/first/.test(f.pre.textContent));
  assert.strictEqual(f._copyViewSourceBtns.transcript.attrs['aria-pressed'], 'true');
  assert.strictEqual(f._copyViewSourceBtns.terminal.attrs['aria-pressed'], 'false');
  TerminalPane.prototype._setCopyViewSource.call(f, 'terminal');
  assert.strictEqual(f._copyViewSourceBtns.terminal.attrs['aria-pressed'], 'true');
  assert.strictEqual(f._copyViewText, 'TERMINAL-TEXT', 'Copy all follows the visible source');
});

check('Refresh re-fetches the transcript when that is the active source', () => {
  const refresh = extractBlock(termSrc, '_refreshCopyView() {');
  assert.ok(refresh.includes('COPY_VIEW_SOURCE_TRANSCRIPT'), 'Refresh must dispatch on the source');
  assert.ok(refresh.includes('_loadTranscriptSnapshot()'),
    'Refresh on the transcript means get the current end of the conversation');
  assert.ok(refresh.includes('_composeCopyViewText'),
    'the terminal source must keep the exact behavior it always had');
});

check('the transcript source is wired into the overlay chrome and torn down with it', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(/terminal-copyview-source/.test(ensure), 'the switch needs its own class');
  assert.ok(/Full transcript/.test(ensure), 'both sources must be labelled');
  assert.ok(/terminal-copyview-earlier/.test(ensure), 'paging control must exist');
  assert.ok(/aria-label/.test(ensure), 'the new controls need accessible names');
  const destroy = extractBlock(termSrc, '_destroyCopyView() {');
  assert.ok(destroy.includes('this._copyViewMessages = [];'),
    'a rebuilt overlay must not inherit another visit messages');
  assert.ok(destroy.includes('this._copyViewStartOffset = null;'), 'nor its paging cursor');
  assert.ok(destroy.includes('this._copyViewSourceBtns = null;'), 'nor dangling element references');
  const metrics = extractBlock(termSrc, '_applyCopyOverlayMetrics() {');
  assert.ok(metrics.includes('_copyViewSourceBtns'), 'the new controls meet the same touch floor');
  assert.ok(metrics.includes('_copyViewLoadEarlierBtn'));
});

check('the transcript source uses the read-only mirror API and the existing token', () => {
  const api = extractBlock(termSrc, 'async _copyViewApi(method, path, body) {');
  assert.ok(/cwm_token/.test(api), 'auth must reuse the token the pane already holds');
  assert.ok(/Bearer/.test(api), 'as a bearer header, the way the rest of the frontend does');
  const load = extractBlock(termSrc, 'async _loadTranscriptSnapshot() {');
  assert.ok(load.includes("'/api/mirror/open'"), 'must use the shipped read-only endpoint');
  assert.ok(load.includes("'/api/mirror/close'"), 'and release it immediately');
  assert.ok(!/pty|sendCommand|ws\.send/.test(load),
    'reading the transcript must never touch the running session');
});

/**
 * Drain the asynchronous checks, then print the combined summary.
 *
 * Kept as the very last statement so the synchronous checks above have all
 * run and tallied first, and so a rejection inside an awaited body is reported
 * as a FAIL here instead of escaping as an unhandled rejection.
 */
(async () => {
  for (const { name, fn } of asyncChecks) {
    try {
      await fn();
      passed++;
      console.log('  \x1b[32mPASS\x1b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m ' + name);
      console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : String(err)));
    }
  }
  console.log('  ' + '='.repeat(58));
  console.log('  [terminal-select-v2] ' + passed + '/' + (passed + failed) + ' tests passed');
  process.exit(failed > 0 ? 1 : 0);
})();
