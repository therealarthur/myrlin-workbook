#!/usr/bin/env node
/**
 * Select mode v2: freeze-while-selecting, Copy view overlay, and the
 * visible-pane width claim.
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
 * Three behaviors are covered here:
 *   1. Freeze: incoming output accumulates in the existing write queue and is
 *      not written; leaving the mode drains it; typing leaves the mode BEFORE
 *      the keystroke goes out; a server-initiated reset drops the freeze before
 *      term.reset(); an overflow cap prevents unbounded holding.
 *   2. Copy view: a text snapshot composed from both buffers (the normal
 *      buffer still holds the pre-TUI transcript and shell scrollback while the
 *      alternate buffer is active), with blank-run collapsing.
 *   3. Width claim: a visible or focused pane claims PTY geometry ownership by
 *      sending the existing 'activate' control message, debounced, and never
 *      while frozen or inside the connect/replay window.
 *
 * Method follows test/smooth-scroll.test.js and test/terminal-select-mode.test.js:
 * terminal.js is evaluated in a sandbox with stubbed globals, real prototype
 * methods are invoked against minimal fakes, and load-bearing wiring that
 * cannot be reached without a full DOM is verified by SCOPED source scan
 * (balanced-brace block extraction, never a loose file-wide regex).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');

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
 * Extract a balanced-brace source block starting at an anchor string, so every
 * source assertion is scoped to the intended function body instead of matching
 * a lookalike elsewhere in the file.
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
 * @returns {object} { TerminalPane, and the module-level tuning constants }
 */
function loadRuntime() {
  const storage = { getItem: () => null, setItem: () => {} };
  const win = { matchMedia: () => ({ matches: false }) };
  const doc = { documentElement: { dataset: {} }, getElementById: () => null };
  // WebSocket is only consulted for its OPEN constant in the paths under test.
  const WebSocketStub = Object.assign(function () {}, { OPEN: 1 });
  const factory = new Function(
    'window', 'document', 'Terminal', 'FitAddon', 'WebSocket', 'localStorage',
    'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    termSrc +
    '\nreturn {' +
    ' TerminalPane: TerminalPane,' +
    ' SELECT_FREEZE_MAX_HOLD_CHARS: SELECT_FREEZE_MAX_HOLD_CHARS,' +
    ' SELECT_FREEZE_WHEEL_LINES: SELECT_FREEZE_WHEEL_LINES,' +
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
    clearTimeout
  );
}

/**
 * Build a minimal pane fake carrying only the state the freeze paths read.
 * Records every term.write() so "held" versus "flushed" is directly
 * observable, and stubs the UI hooks the real methods call.
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
    _selectMode: false,
    _selectFrozenAt: 0,
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

console.log('\n  Select mode v2: freeze, Copy view, visible-pane width claim');
console.log('  ' + '='.repeat(58));

const rt = loadRuntime();
const TerminalPane = rt.TerminalPane;

/* ============================================================
   1. Freeze: the write pipeline holds output while selecting
   ============================================================ */

check('constructor seeds v2 state (freeze, overlay, claim) as inert defaults', () => {
  const pane = new TerminalPane('c1', 's1', 'Pane', {});
  assert.strictEqual(pane._selectMode, false, 'Select mode must default OFF');
  assert.strictEqual(pane._selectFrozenAt, 0);
  assert.strictEqual(pane._fitDeferredWhileFrozen, false);
  assert.strictEqual(pane._copyOverlay, null);
  assert.strictEqual(pane._copyOverlayOpen, false);
});

check('_isWriteFrozen tracks Select mode and nothing else', () => {
  const f = makeFreezeFake();
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), false);
  f._selectMode = true;
  assert.strictEqual(TerminalPane.prototype._isWriteFrozen.call(f), true);
});

check('frozen _enqueueWrite accumulates and schedules NOTHING', () => {
  const f = makeFreezeFake({ _selectMode: true });
  TerminalPane.prototype._enqueueWrite.call(f, 'frame-1');
  TerminalPane.prototype._enqueueWrite.call(f, 'frame-2');
  assert.strictEqual(f._writeBuf, 'frame-1frame-2', 'bytes must be held, not dropped');
  assert.strictEqual(f.writes.length, 0, 'nothing may reach term.write while frozen');
  assert.strictEqual(f._writeRaf, null, 'no animation frame may be scheduled while frozen');
  assert.strictEqual(f._bgFlushTimer, null, 'no background flush timer may be scheduled while frozen');
});

check('frozen _flushWriteBuffer refuses to consume the queue (stray rAF guard)', () => {
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'held', _writeRaf: 7 });
  TerminalPane.prototype._flushWriteBuffer.call(f);
  assert.strictEqual(f.writes.length, 0, 'a flush scheduled before the freeze must not write');
  assert.strictEqual(f._writeBuf, 'held', 'the queue must survive a suppressed flush');
  assert.strictEqual(f._writeRaf, null, 'the consumed frame handle is still cleared');
});

check('unfrozen _enqueueWrite still writes normally (v1 behavior preserved)', () => {
  const f = makeFreezeFake();
  TerminalPane.prototype._enqueueWrite.call(f, 'live');
  assert.strictEqual(f.writes.join(''), 'live', 'a non-frozen pane writes through the rAF path');
});

check('setSelectMode(true) freezes, setSelectMode(false) flushes the whole queue at once', () => {
  const f = makeFreezeFake();
  TerminalPane.prototype.setSelectMode.call(f, true);
  assert.strictEqual(f._selectMode, true);
  assert.ok(f._selectFrozenAt > 0, 'freeze start timestamp must be recorded');
  TerminalPane.prototype._enqueueWrite.call(f, 'a');
  TerminalPane.prototype._enqueueWrite.call(f, 'b');
  assert.strictEqual(f.writes.length, 0, 'held while ON');
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.strictEqual(f.writes.length, 1, 'the drain must be a SINGLE write, not one per chunk');
  assert.strictEqual(f.writes[0], 'ab', 'held output must be written in arrival order');
  assert.strictEqual(f._writeBuf, '', 'queue is empty after the drain');
  assert.strictEqual(f._selectFrozenAt, 0);
});

check('toggle-off with an empty queue writes nothing (no spurious flush)', () => {
  const f = makeFreezeFake({ _selectMode: true });
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.strictEqual(f.writes.length, 0);
});

check('a resize deferred during the freeze is re-applied on unfreeze', () => {
  // safeFit is the real method here so the deferral branch is the one tested;
  // fitAddon must be present or it bails before reaching that branch.
  const f = makeFreezeFake({ _selectMode: true, fitAddon: { fit() { assert.fail('must not fit while frozen'); } } });
  TerminalPane.prototype.safeFit.call(f);
  assert.strictEqual(f._fitDeferredWhileFrozen, true, 'a fit during the freeze must be deferred, not applied');
  const g = makeFreezeFake({ _selectMode: true, _fitDeferredWhileFrozen: true });
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

check('_discardSelectModeHold drops the freeze WITHOUT writing (resync paths)', () => {
  const f = makeFreezeFake({ _selectMode: true, _writeBuf: 'stale-frames', _fitDeferredWhileFrozen: true });
  TerminalPane.prototype._discardSelectModeHold.call(f);
  assert.strictEqual(f._selectMode, false);
  assert.strictEqual(f.writes.length, 0, 'a replay is about to re-send everything; do not write stale frames');
  assert.strictEqual(f._fitDeferredWhileFrozen, false);
  assert.strictEqual(f.uiUpdates, 1, 'the toggle UI must reflect the dropped mode');
});

check('overflow cap leaves Select mode, flushes everything, and explains why', () => {
  const f = makeFreezeFake({ _selectMode: true });
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
   2. Freeze wiring: input paths and the resync path
   ============================================================ */

check('onData exits Select mode BEFORE it forwards the keystroke', () => {
  const block = extractBlock(termSrc, 'this.term.onData((data) => {');
  const exitIdx = block.indexOf('_exitSelectModeForInput');
  const sendIdx = block.indexOf('this.ws.send(');
  assert.ok(exitIdx !== -1, 'onData must unfreeze on input');
  assert.ok(sendIdx !== -1, 'onData must still forward input');
  assert.ok(exitIdx < sendIdx, 'the unfreeze must precede the send so the echo renders on a current screen');
});

check('every other send-to-PTY path also unfreezes (paste, Ctrl+V, Shift+Enter, sendCommand)', () => {
  const paste = extractBlock(termSrc, "if (e.inputType === 'insertFromPaste') {");
  assert.ok(paste.includes('_exitSelectModeForInput'), 'beforeinput paste path must unfreeze');
  const replace = extractBlock(termSrc, "if (e.inputType === 'insertReplacementText') {");
  assert.ok(replace.includes('_exitSelectModeForInput'), 'autocorrect replacement path must unfreeze');
  const ctrlV = extractBlock(termSrc, "if (mod && e.key === 'v') {");
  assert.ok(ctrlV.includes('_exitSelectModeForInput'), 'Ctrl+V path must unfreeze (both origin arms)');
  const shiftEnter = extractBlock(termSrc, "if (e.key === 'Enter' && e.shiftKey) {");
  assert.ok(shiftEnter.includes('_exitSelectModeForInput'), 'Shift+Enter path must unfreeze');
  const sendCommand = extractBlock(termSrc, 'sendCommand(cmd) {');
  assert.ok(sendCommand.includes('_exitSelectModeForInput'), 'sendCommand must unfreeze');
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
    _fitDeferredWhileFrozen: true,
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
  assert.strictEqual(fake._selectMode, false);
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

check('executed: the wheel guard is inert while Select mode is OFF', () => {
  let handler = null;
  const container = {
    addEventListener: (type, fn) => { if (type === 'wheel') handler = fn; },
    removeEventListener: () => {},
  };
  const scrolled = [];
  // The method resolves `document` from the sandbox where terminal.js was
  // evaluated, so route the fake container through a per-call getElementById.
  const rt2 = loadRuntimeWithContainer(container);
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _selectMode: false, _selWheelHandler: null, _selWheelTarget: null,
    _copyOverlay: null,
    term: { rows: 30, buffer: { active: { type: 'normal' } }, scrollLines: (n) => scrolled.push(n) },
  });
  rt2.TerminalPane.prototype._installSelectModeWheelGuard.call(f);
  assert.ok(typeof handler === 'function', 'a wheel listener must be registered');
  let prevented = false;
  handler({ deltaY: 100, deltaMode: 0, cancelable: true, target: null,
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {} });
  assert.strictEqual(prevented, false, 'OFF must not touch the wheel');
  assert.strictEqual(scrolled.length, 0);
});

check('executed: ON swallows the wheel in the ALTERNATE buffer (no local scroll)', () => {
  let handler = null;
  const container = { addEventListener: (t, fn) => { if (t === 'wheel') handler = fn; }, removeEventListener: () => {} };
  const scrolled = [];
  const rt2 = loadRuntimeWithContainer(container);
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _selectMode: true, _selWheelHandler: null, _selWheelTarget: null, _copyOverlay: null,
    term: { rows: 30, buffer: { active: { type: 'alternate' } }, scrollLines: (n) => scrolled.push(n) },
  });
  rt2.TerminalPane.prototype._installSelectModeWheelGuard.call(f);
  let prevented = false;
  let stopped = false;
  handler({ deltaY: 100, deltaMode: 0, cancelable: true, target: null,
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
  assert.strictEqual(prevented, true, 'the app must never see the wheel while selecting');
  assert.strictEqual(stopped, true, 'xterm must not forward the wheel to the PTY while selecting');
  assert.strictEqual(scrolled.length, 0, 'the alternate buffer has no scrollback to scroll');
});

check('executed: ON translates the wheel into local scrolling in the NORMAL buffer', () => {
  let handler = null;
  const container = { addEventListener: (t, fn) => { if (t === 'wheel') handler = fn; }, removeEventListener: () => {} };
  const scrolled = [];
  const rt2 = loadRuntimeWithContainer(container);
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _selectMode: true, _selWheelHandler: null, _selWheelTarget: null, _copyOverlay: null,
    term: { rows: 30, buffer: { active: { type: 'normal' } }, scrollLines: (n) => scrolled.push(n) },
  });
  rt2.TerminalPane.prototype._installSelectModeWheelGuard.call(f);
  handler({ deltaY: -100, deltaMode: 0, cancelable: true, target: null,
    preventDefault: () => {}, stopImmediatePropagation: () => {} });
  assert.deepStrictEqual(scrolled, [-rt.SELECT_FREEZE_WHEEL_LINES],
    'a shell pane keeps scrollback, so Select mode still scrolls it');
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
  assert.ok(/JetBrains Mono/.test(ensure), 'terminal text must stay monospaced');
});

check('the overlay is themed with CSS custom properties, not hardcoded palette values', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(/var\(--mantle/.test(ensure) || /var\(--surface0/.test(ensure), 'background must follow the theme');
  assert.ok(/var\(--text/.test(ensure), 'foreground must follow the theme');
  assert.ok(/var\(--surface1/.test(ensure), 'borders must follow the theme');
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

check('repeated opens reuse one overlay instead of stacking DOM nodes', () => {
  const ensure = extractBlock(termSrc, '_ensureCopyOverlay() {');
  assert.ok(/if \(this\._copyOverlay\) return this\._copyOverlay;/.test(ensure),
    'the overlay must be created at most once per pane');
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
  const existingGuard = inject.indexOf("header.querySelector('.terminal-pane-copyview')");
  assert.ok(existingGuard !== -1, 'a remount into the same slot must not stack buttons');
});

check('dispose() removes the overlay, the button, the wheel guard and the freeze', () => {
  const dispose = extractBlock(termSrc, 'dispose() {');
  assert.ok(dispose.includes('_destroyCopyView()'), 'overlay + its listeners must be torn down');
  assert.ok(dispose.includes('_removeSelectModeWheelGuard()'), 'the capture-phase wheel guard must be removed');
  assert.ok(dispose.includes('this._copyViewBtn.remove()'), 'the header button must be removed');
  assert.ok(/this\._selectMode = false/.test(dispose), 'a disposed pane must not stay frozen');
  const destroy = extractBlock(termSrc, '_destroyCopyView() {');
  assert.ok(destroy.includes("removeEventListener('keydown'"), 'the overlay key handler must be detached');
  assert.ok(destroy.includes('this._copyOverlay.remove()'), 'the overlay node must leave the DOM');
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

check('the strip explains the pause, the copy paths, and how to resume', () => {
  const text = TerminalPane.SELECT_STRIP_TEXT;
  assert.ok(/paused/i.test(text), 'must say output is paused');
  assert.ok(/Ctrl\+C/.test(text), 'must name the copy key');
  assert.ok(/Copy view/i.test(text), 'must point at the copy-everything path');
  assert.ok(/Typing/i.test(text), 'must say how live output resumes');
  // The forbidden dash is built from its code point rather than typed: this
  // repo bans the literal character in source, so a gate containing one would
  // be self-defeating.
  assert.ok(text.indexOf(String.fromCharCode(0x2014)) === -1, 'no em dashes in user-facing copy');
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
    term: { cols: 60, rows: 24 },
    ws: { readyState: 1, send(payload) { fake.sent.push(payload); } },
    _selectMode: false,
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
  const f = makeClaimFake({ _selectMode: true });
  assert.strictEqual(TerminalPane.prototype._requestActivate.call(f, 'visible'), false);
  assert.strictEqual(f.sent.length, 0, 'a claim would repaint the whole frame into the hold queue');
  assert.strictEqual(f._activatePending, true, 'the intent must be remembered');
  TerminalPane.prototype.setSelectMode.call(f, false);
  assert.strictEqual(f.sent.length, 1, 'the deferred claim goes out once the freeze lifts');
  assert.strictEqual(f._activatePending, false);
});

check('the public activate() also defers while frozen and never fits mid-selection', () => {
  const f = makeClaimFake({ _selectMode: true });
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
  const rt2 = loadRuntimeWithContainer(container, FakeObserver);
  const claims = [];
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _paneVisible: false, _paneObserver: null,
    _activateFocusHandler: null, _activateFocusTarget: null, _activateRetryTimer: null,
    _activatePending: false,
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
  const rt2 = loadRuntimeWithContainer(container, FakeObserver);
  const claims = [];
  const f = Object.assign(Object.create(rt2.TerminalPane.prototype), {
    containerId: 'c', _paneVisible: false, _paneObserver: null,
    _activateFocusHandler: null, _activateFocusTarget: null, _activateRetryTimer: null,
    _activatePending: true,
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

check('mount wires the claim triggers and dispose tears them down', () => {
  const mount = extractBlock(termSrc, 'mount() {');
  assert.ok(mount.includes('_installVisibilityActivate()'), 'mount must wire the triggers');
  const dispose = extractBlock(termSrc, 'dispose() {');
  assert.ok(dispose.includes('_removeVisibilityActivate()'),
    'a disposed pane must never claim geometry for a session it no longer shows');
});

check('the quiet window is armed on connect, on socket open, and on a server reset', () => {
  const connectBlock = extractBlock(termSrc, 'const isReconnect = this._gotFirstData;');
  assert.ok(/_activateBlockedUntil = Date\.now\(\) \+ ACTIVATE_CONNECT_GUARD_MS/.test(connectBlock) ||
    termSrc.includes('this._activateBlockedUntil = Date.now() + ACTIVATE_CONNECT_GUARD_MS;'),
    'connect must arm the quiet window');
  const onopen = extractBlock(termSrc, 'this.ws.onopen = () => {');
  assert.ok(onopen.includes('_activateBlockedUntil'), 'socket open must re-arm the quiet window');
  const reset = extractBlock(termSrc, "} else if (msg.type === 'reset') {");
  assert.ok(reset.includes('_activateBlockedUntil'), 'a server resync must arm the quiet window');
});

/**
 * Load a fresh runtime whose document.getElementById always resolves to the
 * given fake container, optionally with a stub IntersectionObserver. Used by
 * the executed wheel-guard and visibility checks, which need the methods'
 * internal `document` and `IntersectionObserver` lookups to find their stubs.
 *
 * @param {object} container - Fake element with addEventListener/querySelector.
 * @param {Function} [observerCtor] - Stub IntersectionObserver constructor.
 * @returns {object} The same shape loadRuntime() returns.
 */
function loadRuntimeWithContainer(container, observerCtor) {
  const storage = { getItem: () => null, setItem: () => {} };
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

console.log('  ' + '='.repeat(58));
console.log('  [terminal-select-v2] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) process.exit(1);
process.exit(0);
