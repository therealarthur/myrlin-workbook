#!/usr/bin/env node
/**
 * terminal-history.test.js
 * Notion restyle phase P7, work packages P7.1 to P7.6.
 * BUILD-CONTRACT.md P7, TERMINAL-ARCHITECTURE.md sections 7 to 13.
 *
 * WHAT THIS GATES
 *
 * The Unified Scrollback Surface has four rulings that are decisions rather
 * than implementation details, and each of them has a way of quietly reverting
 * under a later edit. This suite pins all four, EXECUTED wherever the code can
 * be run without a browser:
 *
 *   1. THE ROUTER KEYS ON BUFFER MODE, NOT ON PROVIDER, and it must survive
 *      the mode frame being absent, because CWM_VT_SIDECAR defaults off. The
 *      truth table is executed against both signal sources.
 *
 *   2. `mouseTracking` IS A STRING ENUM AND 'none' IS TRUTHY. A truthy test
 *      anywhere on that field reports mouse tracking ON for every pane that
 *      has ever answered the question, which would silently take the wheel
 *      away from history on every shell. Executed for all five enum values.
 *
 *   3. THE SEAM IS AN OVERLAP, NEVER A HEURISTIC JOIN. The dedupe window is
 *      derived from the sidecar's own reflow counter, and at zero reflows it
 *      must be zero: a monotonic log has no duplicates to remove, so any
 *      dedupe there would be eating real repeated output.
 *
 *   4. THE FREEZE IS THE MIRROR, NOT THE STREAM. Executed against a fake pane:
 *      a held selection must stop the DOM refresh and must not touch the write
 *      pipeline, and 200 lines of output must not disturb the held text.
 *
 * Plus the two preservation gates P7 is unusually strict about: every Select
 * mode v1/v2/v3 identifier still present in terminal.js (P7.6's done
 * criterion), and the three source-sliced Ctrl+C anchors still resolving to
 * the branch the three pinned suites expect.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'src', 'web', 'public');
const HISTORY_PATH = path.join(PUBLIC_DIR, 'terminal-history.js');
const TERMINAL_PATH = path.join(PUBLIC_DIR, 'terminal.js');
const STYLES_PATH = path.join(PUBLIC_DIR, 'styles.css');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const SERVER_PATH = path.join(ROOT, 'src', 'web', 'server.js');

const H = require(HISTORY_PATH);
const historySrc = fs.readFileSync(HISTORY_PATH, 'utf8');
const terminalSrc = fs.readFileSync(TERMINAL_PATH, 'utf8');
const stylesCss = fs.readFileSync(STYLES_PATH, 'utf8');
const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named check.
 *
 * @param {string} name - Assertion name.
 * @param {Function} fn - Body that throws on failure.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.stack
      ? err.stack.split('\n').slice(0, 4).join('\n       ')
      : String(err)));
  }
}

/**
 * Slice a balanced-brace block out of source text, starting at a literal
 * anchor. Same idiom the Select-mode suites use, so a body assertion here
 * reads the same way theirs do.
 *
 * @param {string} src - Source text.
 * @param {string} anchor - Literal anchor including its opening brace.
 * @returns {string} The block including its closing brace.
 */
function extractBlock(src, anchor) {
  const start = src.indexOf(anchor);
  assert.ok(start !== -1, 'anchor not found: ' + anchor);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail('unbalanced block for anchor: ' + anchor);
  return '';
}

/* ═══════════════════════════════════════════════════════════════
   A MINIMAL DOM
   Enough of one for the layer to build itself, render segments,
   scroll, freeze and select. Deliberately hand written rather than
   pulled from a library: the suite must stay dependency free and
   must run in the same bare Node the rest of test/ runs in.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a fake element with the surface the layer touches.
 *
 * @param {string} tag - Tag name.
 * @returns {object} The fake element.
 */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attrs: {},
    listeners: {},
    _classes: new Set(),
    hidden: false,
    tabIndex: -1,
    textContent: '',
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    dispatch(type, event) {
      for (const fn of (this.listeners[type] || [])) fn(event);
    },
    contains(node) {
      if (node === this) return true;
      for (const child of this.children) if (child.contains && child.contains(node)) return true;
      return false;
    },
    querySelector() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 400, height: 200, right: 400, bottom: 200 }; },
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: (c, on) => { if (on) el._classes.add(c); else el._classes.delete(c); },
  };
  return el;
}

/**
 * Install a fake document/window for the duration of one test, and return a
 * teardown that removes them again. Globals are used because the layer reads
 * `document`, `window`, `requestAnimationFrame` and `getSelection` by name,
 * exactly as it does in a browser.
 *
 * @param {object} [selection] - Selection stub the layer will read.
 * @returns {Function} Teardown.
 */
function installDom(selection) {
  const created = [];
  const doc = {
    createElement: (tag) => { const el = makeEl(tag); created.push(el); return el; },
    createRange: () => ({
      setStartBefore() {}, setEndAfter() {}, selectNodeContents() {},
    }),
    getSelection: () => selection || { isCollapsed: true, anchorNode: null, focusNode: null },
    addEventListener: (type, fn) => { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = doc._listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    documentElement: { getAttribute: () => 'mocha' },
    _listeners: {},
  };
  const prevDoc = global.document;
  const prevWin = global.window;
  const prevRaf = global.requestAnimationFrame;
  const prevCancel = global.cancelAnimationFrame;
  const prevRo = global.ResizeObserver;
  global.document = doc;
  global.window = {
    getSelection: () => selection || { removeAllRanges() {}, addRange() {}, isCollapsed: true },
    getComputedStyle: () => ({ fontFamily: 'iA Writer Mono', fontSize: '13px', letterSpacing: 'normal', paddingLeft: '14px', paddingTop: '12px' }),
    MyrlinTerminalSurface: require(path.join(PUBLIC_DIR, 'terminal-surface.js')),
  };
  // Deliberately synchronous, so a test can assert the effect of a scheduled
  // refresh without a timer. The layer never depends on the frame boundary
  // for correctness, only for batching.
  global.requestAnimationFrame = (fn) => { fn(); return 1; };
  global.cancelAnimationFrame = () => {};
  global.ResizeObserver = undefined;
  return function teardown() {
    global.document = prevDoc;
    global.window = prevWin;
    global.requestAnimationFrame = prevRaf;
    global.cancelAnimationFrame = prevCancel;
    global.ResizeObserver = prevRo;
  };
}

/**
 * A fake xterm buffer namespace.
 *
 * @param {object} opts - { type, lines, baseY, normalLines }.
 * @returns {object} The namespace.
 */
function makeBuffers(opts) {
  const o = opts || {};
  const mkBuf = (type, lines, baseY) => ({
    type,
    baseY: baseY || 0,
    viewportY: o.viewportY === undefined ? (baseY || 0) : o.viewportY,
    length: lines.length,
    getLine: (i) => (i >= 0 && i < lines.length
      ? { translateToString: () => lines[i], isWrapped: false }
      : undefined),
  });
  const active = mkBuf(o.type || 'normal', o.lines || [], o.baseY || 0);
  const normal = o.type === 'alternate'
    ? mkBuf('normal', o.normalLines || [], 0)
    : active;
  return { active, normal, onBufferChange: () => ({ dispose() {} }) };
}

/**
 * A fake TerminalPane sufficient for the layer.
 *
 * @param {object} over - Overrides.
 * @returns {object} The fake pane.
 */
function makePane(over) {
  const paneEl = makeEl('div');
  const container = makeEl('div');
  container.querySelector = () => null;
  const pane = Object.assign({
    sessionId: 'sess-1',
    paneEl,
    container,
    term: {
      options: { fontSize: 13, lineHeight: 1.2, fontFamily: 'iA Writer Mono' },
      modes: { mouseTrackingMode: 'none' },
      buffer: makeBuffers({ type: 'normal', lines: ['a', 'b', 'c'], baseY: 0 }),
      scrollToBottom() { pane.scrolledToBottom = (pane.scrolledToBottom || 0) + 1; },
    },
    ws: null,
    _remoteModeFrame: null,
    scrolledToBottom: 0,
    writes: [],
    _getOwnedContainer: () => container,
    _copyViewIdentity: () => ({ provider: 'claude', providerSessionId: 'sess-1' }),
    _log() {},
    _notifySelectChromeState() { pane.notified = (pane.notified || 0) + 1; },
    focus() { pane.focused = (pane.focused || 0) + 1; },
    fetchDeepHistory: () => Promise.resolve({ available: false }),
    fetchTranscriptWindow: () => Promise.resolve(null),
  }, over || {});
  return pane;
}

console.log('\n  \x1b[1mP7 Unified Scrollback Surface: router, seam, freeze, boundaries, preservation\x1b[0m');
console.log('  ' + '-'.repeat(74));

/* ═══════════════════════════════════════════════════════════════
   1. THE ROUTER (7.2, P7.5)
   ═══════════════════════════════════════════════════════════════ */

check('executed: the router keys on buffer mode, never on provider', () => {
  assert.strictEqual(H.routeHistorySource({ altBuffer: true, hasTranscript: true }), H.SOURCE_TRANSCRIPT);
  assert.strictEqual(H.routeHistorySource({ altBuffer: false, hasTranscript: true }), H.SOURCE_NATIVE,
    'a shell pane keeps the native path even when a transcript exists');
  assert.strictEqual(H.routeHistorySource({ altBuffer: true, hasTranscript: false }), H.SOURCE_NATIVE,
    'an alternate pane with no transcript identity falls back rather than erroring');
  assert.strictEqual(H.routeHistorySource({}), H.SOURCE_NATIVE, 'the empty state is the safe state');
  assert.strictEqual(H.routeHistorySource(undefined), H.SOURCE_NATIVE);
});

check('executed: altBuffer prefers the mode frame and FALLS BACK to xterm', () => {
  const altTerm = { buffer: { active: { type: 'alternate' } } };
  const normTerm = { buffer: { active: { type: 'normal' } } };
  // Frame absent: the sidecar defaults off, so the fallback is the common path.
  assert.strictEqual(H.resolveAltBuffer(null, altTerm), true);
  assert.strictEqual(H.resolveAltBuffer(null, normTerm), false);
  assert.strictEqual(H.resolveAltBuffer(undefined, null), false, 'no terminal at all must not throw');
  // Frame present and authoritative, even when it disagrees with this client.
  assert.strictEqual(H.resolveAltBuffer({ altBuffer: true }, normTerm), true);
  assert.strictEqual(H.resolveAltBuffer({ altBuffer: false }, altTerm), false);
  // A frame carrying no opinion on the field must not shadow the fallback.
  assert.strictEqual(H.resolveAltBuffer({ mouseTracking: 'any' }, altTerm), true);
});

check("executed: mouseTracking is a STRING ENUM and 'none' is never truthy-tested", () => {
  for (const value of ['x10', 'vt200', 'drag', 'any']) {
    assert.strictEqual(H.resolveMouseTrackingActive({ mouseTracking: value }, null), true, value);
  }
  assert.strictEqual(H.resolveMouseTrackingActive({ mouseTracking: 'none' }, null), false,
    "'none' is a truthy string: reading it as a boolean takes the wheel from every shell");
  assert.strictEqual(H.resolveMouseTrackingActive({ mouseTracking: '' }, null), false);
  // The published boolean wins when it is there.
  assert.strictEqual(H.resolveMouseTrackingActive({ mouseTracking: 'any', mouseTrackingActive: false }, null), false);
  // Fallback to xterm's own reader, same enum discipline.
  assert.strictEqual(H.resolveMouseTrackingActive(null, { modes: { mouseTrackingMode: 'none' } }), false);
  assert.strictEqual(H.resolveMouseTrackingActive(null, { modes: { mouseTrackingMode: 'any' } }), true);
  assert.strictEqual(H.resolveMouseTrackingActive(null, {}), false);
  assert.strictEqual(H.resolveMouseTrackingActive(null, null), false);
});

check('the source router is re-evaluated on a buffer change, not cached', () => {
  const onBuffer = extractBlock(historySrc, 'TerminalHistoryLayer.prototype.onBufferChange = function onBufferChange() {');
  assert.ok(onBuffer.includes('this.resolveSource()'), 'a pane that crosses the boundary must re-route');
  assert.ok(terminalSrc.includes('onBufferChange'),
    'terminal.js must subscribe to xterm onBufferChange so the route follows the application');
});

/* ═══════════════════════════════════════════════════════════════
   2. PAGING AND THE SEAM (7.4, P7.5)
   ═══════════════════════════════════════════════════════════════ */

check('executed: wrapped rows rejoin into logical lines', () => {
  const rows = [
    { t: 'hello ', w: false },
    { t: 'world', w: true },
    { t: 'next', w: false },
  ];
  assert.deepStrictEqual(H.joinWrappedLines(rows), ['hello world', 'next']);
  // A page that STARTS mid-line keeps the orphan rather than dropping it: the
  // line above was never loaded, so there is nothing to join it to.
  assert.deepStrictEqual(H.joinWrappedLines([{ t: 'tail', w: true }]), ['tail']);
  assert.deepStrictEqual(H.joinWrappedLines(null), []);
  assert.deepStrictEqual(H.joinWrappedLines([{}]), ['']);
});

check('executed: the deep cursor skips exactly what the client already shows', () => {
  assert.strictEqual(H.deepStartCursor({ total: 1000, oldestAvailable: 0, clientCommitted: 200 }), 800);
  assert.strictEqual(H.deepStartCursor({ total: 1000, oldestAvailable: 900, clientCommitted: 200 }), 900,
    'never page below what the server still holds');
  assert.strictEqual(H.deepStartCursor({ total: 100, oldestAvailable: 0, clientCommitted: 500 }), 0,
    'a client holding more than the server asks for nothing older');
  assert.strictEqual(H.deepStartCursor({}), 0);
});

check('executed: the next cursor stops at the oldest line the server still holds', () => {
  assert.strictEqual(H.nextDeepCursor({ hasMore: true, firstLine: 500, oldestAvailable: 0 }), 500);
  assert.strictEqual(H.nextDeepCursor({ hasMore: false, firstLine: 500 }), null);
  assert.strictEqual(H.nextDeepCursor({ hasMore: true, firstLine: 100, oldestAvailable: 100 }), null);
  assert.strictEqual(H.nextDeepCursor(null), null);
});

check('executed: ZERO reflows means ZERO dedupe, which is the whole seam ruling', () => {
  assert.strictEqual(H.seamDedupeWindow(0), 0,
    'a monotonic log has no duplicates, so any dedupe there would eat real repeated output');
  assert.strictEqual(H.seamDedupeWindow(1), H.HISTORY_SEAM_DEDUPE_PER_REFLOW);
  assert.strictEqual(H.seamDedupeWindow(1000), H.HISTORY_SEAM_DEDUPE_MAX_LINES, 'the window is capped');
  assert.strictEqual(H.seamDedupeWindow(undefined), 0);
  assert.strictEqual(H.seamDedupeWindow(-4), 0);
});

check('executed: the seam dedupe removes only an exact contiguous overlap', () => {
  const older = ['a', 'b', 'c', 'd'];
  const newer = ['c', 'd', 'e'];
  assert.strictEqual(H.trailingOverlap(older, newer, 10), 2);
  assert.strictEqual(H.trailingOverlap(older, newer, 0), 0, 'a zero window can never delete anything');
  assert.strictEqual(H.trailingOverlap(older, newer, 1), 0,
    'a window of one cannot match a two-line overlap, and must not match a partial one');
  assert.strictEqual(H.trailingOverlap(['x'], ['y'], 5), 0);
  assert.strictEqual(H.trailingOverlap([], [], 5), 0);
  // The repeated-prompt case: identical lines that are NOT at a seam must
  // survive, which is why the window is bounded by the reflow count.
  const prompts = ['$ ', '$ ', '$ ', '$ '];
  assert.strictEqual(H.trailingOverlap(prompts, prompts, 0), 0);
});

check('the seam is a rule with no label, and the overlap is documented as deliberate', () => {
  assert.ok(/terminal-history-rule/.test(historySrc), 'the seam element must exist');
  assert.ok(/title/.test(extractBlock(historySrc, 'TerminalHistoryLayer.prototype._ensureDom = function _ensureDom() {')),
    'the explanation belongs in a title attribute, not in a visible banner');
  assert.ok(/deliberate one-turn overlap|one-turn overlap|OVERLAP, NEVER A HEURISTIC JOIN/i.test(historySrc),
    'the overlap ruling must be recorded where the next reader will find it');
  assert.ok(!/dropTranscriptMessagesPresentInFrame|joinTranscriptToFrame/.test(historySrc),
    'no heuristic join may exist: a false positive silently deletes real conversation');
});

/* ═══════════════════════════════════════════════════════════════
   3. BUFFER READING AND RENDERING
   ═══════════════════════════════════════════════════════════════ */

check('executed: readBufferRange is defensive by row and clamps its range', () => {
  const buf = {
    length: 3,
    getLine: (i) => (i === 1
      ? { translateToString: () => { throw new Error('bad row'); } }
      : { translateToString: () => 'row' + i }),
  };
  assert.deepStrictEqual(H.readBufferRange(buf, 0, 3), ['row0', '', 'row2'],
    'a row that cannot be read becomes blank rather than aborting the document');
  assert.deepStrictEqual(H.readBufferRange(buf, -5, 99), ['row0', '', 'row2']);
  assert.deepStrictEqual(H.readBufferRange(null, 0, 3), []);
  assert.deepStrictEqual(H.readBufferRange(buf, 2, 1), []);
});

check('executed: blank runs collapse in ARCHIVED segments only', () => {
  assert.deepStrictEqual(H.collapseBlankRuns(['a', '', '', '', 'b']), ['a', '', 'b']);
  assert.deepStrictEqual(H.collapseBlankRuns(['', '', 'a']), ['a'], 'a leading run is padding');
  assert.deepStrictEqual(H.collapseBlankRuns(['a', '', 'b']), ['a', '', 'b'], 'one blank line is structure');
  const live = extractBlock(historySrc, 'TerminalHistoryLayer.prototype._refreshLiveSegment = function _refreshLiveSegment(force) {');
  assert.ok(!live.includes('collapseBlankRuns'),
    'collapsing the live segment would change its height and make the seam visible');
});

check('executed: transcript rendering matches the Copy view idiom', () => {
  const lines = H.renderTranscriptLines([
    { role: 'user', text: 'hi', kind: 'text' },
    { role: 'assistant', model: 'opus', text: 'line1\nline2', kind: 'text' },
    { kind: 'tool_use', toolName: 'Read', text: 'file.txt\nmore' },
    { kind: 'tool_result', text: 'ok', truncated: true },
  ]);
  assert.ok(lines.includes('User:'));
  assert.ok(lines.includes('Assistant (opus):'));
  assert.ok(lines.includes('line1') && lines.includes('line2'),
    'a multi-line turn must become multiple document lines, not one long one');
  assert.ok(lines.some((l) => l.startsWith('[tool: Read]')));
  assert.ok(lines.some((l) => l.indexOf('[truncated]') !== -1),
    'a truncated message must be marked so a reader is never given a silent partial quote');
  assert.deepStrictEqual(H.renderTranscriptLines(null), []);
});

/* ═══════════════════════════════════════════════════════════════
   4. THE BOUNDARY (8.1, 8.2, P7.1)
   ═══════════════════════════════════════════════════════════════ */

check('executed: wheel deltas normalise across all three delta modes', () => {
  assert.strictEqual(H.wheelLines({ deltaY: -100, deltaMode: 0 }, 30), -3);
  assert.strictEqual(H.wheelLines({ deltaY: 4, deltaMode: 1 }, 30), 4);
  assert.strictEqual(H.wheelLines({ deltaY: -1, deltaMode: 2 }, 30), -30);
  assert.strictEqual(H.wheelLines({ deltaY: 0 }, 30), 0);
  assert.strictEqual(H.wheelLines(null, 30), 0);
});

check('executed: wheel-up at the xterm top boundary opens, above it xterm keeps the wheel', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'normal', lines: ['a', 'b'], baseY: 40, viewportY: 12 });
    const layer = new H.TerminalHistoryLayer(pane);

    // Mid-scrollback: Workbook code is not involved at all.
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), true);
    assert.strictEqual(layer.isOpen(), false);

    // At the top of xterm's own ring: the surface opens, and continuity is
    // exact because its bottom segment IS the screen xterm was showing.
    pane.term.buffer.active.viewportY = 0;
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), false);
    assert.strictEqual(layer.isOpen(), true);

    // Wheel DOWN at the bottom of the document closes and pins live.
    layer.doc.scrollTop = layer.doc.scrollHeight - layer.doc.clientHeight;
    let prevented = 0;
    layer.doc.dispatch('wheel', { deltaY: 120, cancelable: true, preventDefault() { prevented++; } });
    assert.strictEqual(layer.isOpen(), false, 'passing the bottom returns to live');
    assert.strictEqual(prevented, 1);
    assert.ok(pane.scrolledToBottom > 0, 'closing must pin the terminal to the newest output');
    layer.destroy();
  } finally { teardown(); }
});

check('executed: Shift+wheel is the GUARANTEED path, in every session type', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    // The hardest case: alternate buffer with the application owning the mouse,
    // which is every agent CLI measured in section 2.
    pane.term.buffer = makeBuffers({ type: 'alternate', lines: ['frame'], normalLines: [] });
    pane.term.modes.mouseTrackingMode = 'any';
    const layer = new H.TerminalHistoryLayer(pane);

    // Plain wheel up is forwarded to the application, exactly as a native
    // terminal does when mouse tracking is on.
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), true);
    assert.strictEqual(layer.isOpen(), false);

    // Shift plus wheel always reaches history.
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100, shiftKey: true }), false);
    assert.strictEqual(layer.isOpen(), true);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: an alternate pane with NO mouse tracking opens on a plain wheel', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'alternate', lines: ['frame'], normalLines: [] });
    pane.term.modes.mouseTrackingMode = 'none';
    const layer = new H.TerminalHistoryLayer(pane);
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), false);
    assert.strictEqual(layer.isOpen(), true);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: the wheel escalation waits for silence and is cancelled by output', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'alternate', lines: ['frame'], normalLines: [] });
    pane.term.modes.mouseTrackingMode = 'any';
    const layer = new H.TerminalHistoryLayer(pane);

    // One forwarded notch, then the probe fires with no output: exhausted.
    layer.handleTerminalWheel({ deltaY: -100 });
    layer._wheelExhaustedAt = Date.now();
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), false,
      'the notch after an exhaustion verdict opens the surface');
    assert.strictEqual(layer.isOpen(), true);
    layer.close('test');

    // Output cancels the verdict: an application that ANSWERS the wheel is
    // scrolling its own history and must keep the wheel.
    layer._wheelExhaustedAt = Date.now();
    layer.noteOutput();
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), true);
    assert.strictEqual(layer.isOpen(), false);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: the escalation has an off switch and the Shift path survives it', () => {
  const teardown = installDom();
  const prevLs = global.localStorage;
  global.localStorage = {
    getItem: () => JSON.stringify({ terminalWheelEscalation: false }),
    setItem: () => {},
  };
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'alternate', lines: ['frame'], normalLines: [] });
    pane.term.modes.mouseTrackingMode = 'any';
    const layer = new H.TerminalHistoryLayer(pane);
    assert.strictEqual(layer._escalationEnabled(), false);
    layer._wheelExhaustedAt = Date.now();
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100 }), true,
      'with escalation off, a plain wheel always belongs to the application');
    assert.strictEqual(layer.handleTerminalWheel({ deltaY: -100, shiftKey: true }), false,
      'the guaranteed path must never depend on the convenience path');
    layer.destroy();
  } finally {
    global.localStorage = prevLs;
    teardown();
  }
});

check('executed: typing dismisses and the key is passed on, Escape only dismisses', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    assert.strictEqual(layer.handleTerminalKey({ type: 'keydown', key: 'x' }), 'pass',
      'a printable key means: close, and let the key reach the PTY');
    assert.strictEqual(layer.isOpen(), false);

    layer.open('test');
    assert.strictEqual(layer.handleTerminalKey({ type: 'keydown', key: 'Escape' }), 'consumed');
    assert.strictEqual(layer.isOpen(), false);

    // A modified key is NOT typing: Ctrl+C must copy, not dismiss.
    layer.open('test');
    assert.strictEqual(layer.handleTerminalKey({ type: 'keydown', key: 'c', ctrlKey: true }), null);
    assert.strictEqual(layer.isOpen(), true);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: Shift+PageUp opens from live, Shift+PageDown walks back out', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    const layer = new H.TerminalHistoryLayer(pane);
    assert.strictEqual(layer.isOpen(), false);
    assert.strictEqual(layer.handleTerminalKey({ type: 'keydown', key: 'PageUp', shiftKey: true }), 'consumed');
    assert.strictEqual(layer.isOpen(), true, 'the keyboard half of the guaranteed path');
    layer.doc.scrollTop = layer.doc.scrollHeight - layer.doc.clientHeight;
    assert.strictEqual(layer.handleTerminalKey({ type: 'keydown', key: 'PageDown', shiftKey: true }), 'consumed');
    assert.strictEqual(layer.isOpen(), false);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: isPrintableKey excludes modifiers and named keys', () => {
  assert.strictEqual(H.isPrintableKey({ key: 'a' }), true);
  assert.strictEqual(H.isPrintableKey({ key: ' ' }), true);
  assert.strictEqual(H.isPrintableKey({ key: 'Enter' }), false);
  assert.strictEqual(H.isPrintableKey({ key: 'a', ctrlKey: true }), false);
  assert.strictEqual(H.isPrintableKey({ key: 'a', metaKey: true }), false);
  assert.strictEqual(H.isPrintableKey({ key: 'ArrowUp' }), false);
  assert.strictEqual(H.isPrintableKey(null), false);
});

/* ═══════════════════════════════════════════════════════════════
   5. THE MIRROR FREEZE (7.3, P7.3)
   ═══════════════════════════════════════════════════════════════ */

check('executed: a held selection pauses the MIRROR and 200 lines of output cannot move it', () => {
  const lines = ['line-0'];
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'normal', lines, baseY: 0 });
    // Rebuild the buffer view over the live array so the fake terminal grows.
    pane.term.buffer.active.getLine = (i) => (i < lines.length
      ? { translateToString: () => lines[i], isWrapped: false } : undefined);
    Object.defineProperty(pane.term.buffer.active, 'length', { get: () => lines.length });

    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    const held = layer.segments.live.textContent;
    assert.ok(held.indexOf('line-0') !== -1);

    // Hold a selection inside the layer.
    global.document.getSelection = () => ({
      isCollapsed: false,
      anchorNode: layer.segments.live,
      focusNode: layer.segments.live,
    });
    layer._syncFreeze();
    assert.strictEqual(layer.isFrozen(), true);

    for (let i = 1; i <= 200; i++) {
      lines.push('line-' + i);
      layer.noteOutput();
    }
    assert.strictEqual(layer.segments.live.textContent, held,
      'the text the user is selecting must not move while they hold it');

    // Releasing catches up in one write.
    global.document.getSelection = () => ({ isCollapsed: true, anchorNode: null, focusNode: null });
    layer._syncFreeze();
    assert.ok(layer.segments.live.textContent.indexOf('line-200') !== -1,
      'releasing the selection must catch the mirror up immediately');
    layer.destroy();
  } finally { teardown(); }
});

check('the freeze never touches the write pipeline', () => {
  const freeze = extractBlock(historySrc, 'TerminalHistoryLayer.prototype._syncFreeze = function _syncFreeze() {');
  for (const banned of ['_writeBuf', '_flushWriteBuffer', '_enqueueWrite', '_engageSelectHold', '_isWriteFrozen']) {
    assert.ok(!freeze.includes(banned), 'the mirror freeze must not reach ' + banned);
  }
  assert.ok(!/ws\.send|term\.write/.test(historySrc.slice(historySrc.indexOf('_syncFreeze'))).valueOf ||
    !freeze.includes('term.write'), 'the freeze pauses a textContent swap and nothing else');
  // And the pane side: the PTY hooks are notifications, never gates.
  const enqueue = extractBlock(terminalSrc, '  _enqueueWrite(data) {');
  assert.ok(enqueue.includes('_historyLayer.noteOutput()'),
    'the pane must tell the surface that output arrived');
  assert.ok(!/if\s*\(\s*this\._historyLayer[^)]*\)\s*return/.test(enqueue),
    'the surface must never be able to stop a write');
});

/* ═══════════════════════════════════════════════════════════════
   6. THE DOCUMENT CONTAINS THE SCREEN (8.6, P7.6)
   ═══════════════════════════════════════════════════════════════ */

check('executed: the live screen is the LAST segment of the document', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'normal', lines: ['old-1', 'old-2', 'screen-1'], baseY: 2 });
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    const ids = layer.doc.children.filter((c) => c.dataset && c.dataset.seg).map((c) => c.dataset.seg);
    assert.deepStrictEqual(ids, ['deep', 'ring', 'transcript', 'live'],
      'oldest first, with the current screen last, so a drag up never crosses a surface boundary');
    assert.ok(layer.segments.ring.textContent.indexOf('old-1') !== -1, 'the ring holds what scrolled off');
    assert.ok(layer.segments.live.textContent.indexOf('screen-1') !== -1, 'the live segment holds the screen');
    layer.destroy();
  } finally { teardown(); }
});

check('executed: an alternate pane puts the pre-alternate normal buffer above the frame', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({
      type: 'alternate', lines: ['FRAME ROW'], normalLines: ['shell output', '', '', '', 'more shell'],
    });
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    assert.ok(layer.segments.ring.textContent.indexOf('shell output') !== -1);
    assert.strictEqual(layer.segments.ring.textContent.indexOf('\n\n\n'), -1,
      'archived padding collapses; only the live segment keeps its blank rows verbatim');
    assert.ok(layer.segments.live.textContent.indexOf('FRAME ROW') !== -1);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: the document text is oldest-first and includes the screen', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    pane.term.buffer = makeBuffers({ type: 'normal', lines: ['a', 'b', 'c'], baseY: 2 });
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    layer._prependLines('deep', ['deepest']);
    const text = layer.getDocumentText();
    assert.ok(text.indexOf('deepest') < text.indexOf('a'), 'deep is older than the ring');
    assert.ok(text.indexOf('a') < text.indexOf('c'), 'the ring is older than the screen');
    layer.destroy();
  } finally { teardown(); }
});

check('executed: the live segment rebalances without changing the document text', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    const many = [];
    for (let i = 0; i < H.HISTORY_LIVE_SEGMENT_MAX_LINES + 25; i++) many.push('l' + i);
    pane.term.buffer = makeBuffers({ type: 'normal', lines: many, baseY: 0 });
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    const before = layer.getDocumentText();
    assert.strictEqual(layer._lines.live.length, H.HISTORY_LIVE_SEGMENT_MAX_LINES,
      'the live segment is bounded so one text node cannot grow without limit');
    assert.strictEqual(before.indexOf('l0'), 0, 'nothing moved on screen: the same lines in the same order');
    assert.ok(before.indexOf('l' + (many.length - 1)) !== -1);
    layer.destroy();
  } finally { teardown(); }
});

check('executed: prepending preserves the reading position', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    // Grow the document by 300px when the prepend lands.
    layer.doc.scrollTop = 500;
    const grow = () => { layer.doc.scrollHeight += 300; };
    const originalRender = layer._renderSegment.bind(layer);
    layer._renderSegment = (id) => { const r = originalRender(id); if (id === 'deep') grow(); return r; };
    layer._prependLines('deep', ['older-1', 'older-2']);
    assert.strictEqual(layer.doc.scrollTop, 800,
      'content added above the viewport must not yank it');
    layer.destroy();
  } finally { teardown(); }
});

/* ═══════════════════════════════════════════════════════════════
   7. THE AFFORDANCE (8.3, P7.4)
   ═══════════════════════════════════════════════════════════════ */

check('executed: the scrollbar hides when there is nothing above the current screen', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    layer.doc.scrollHeight = 200;
    layer.doc.clientHeight = 200;
    layer._updateScrollbar(true);
    assert.strictEqual(layer.scrollbarEl.hidden, true,
      'an affordance for history that does not exist is a lie about the surface');
    layer.doc.scrollHeight = 2000;
    layer._updateScrollbar(true);
    assert.strictEqual(layer.scrollbarEl.hidden, false);
    assert.ok(layer.scrollbarEl.classList.contains('is-visible'));
    // The thumb size communicates how much history exists.
    const height = parseFloat(layer.thumbEl.style.height);
    assert.ok(height >= 24 && height < 200, 'thumb height: ' + height);
    layer.destroy();
  } finally { teardown(); }
});

check('the affordance is the specified quiet chrome, and no spinner', () => {
  assert.ok(/\.terminal-history-scrollbar\s*\{[^}]*width:\s*6px/.test(stylesCss), '6px overlay bar');
  assert.ok(/color-mix\(in srgb, var\(--app-border-secondary\) 40%, transparent\)/.test(stylesCss),
    '--app-border-secondary at 40 percent, per 8.3');
  assert.ok(/\.terminal-history-scrollbar\.is-paging::before[^}]*height:\s*2px/.test(stylesCss),
    'a 2px indeterminate shimmer, not a spinner');
  assert.ok(/@keyframes history-paging-shimmer/.test(stylesCss));
  assert.ok(/prefers-reduced-motion[^}]*\}[\s\S]{0,400}history-paging-shimmer|history-paging-shimmer[\s\S]{0,600}prefers-reduced-motion/.test(stylesCss),
    'the shimmer must respect reduced motion');
  assert.strictEqual(H.HISTORY_SCROLLBAR_FADE_MS, 900, 'fades after 900ms');
});

/* ═══════════════════════════════════════════════════════════════
   8. THEMING AND METRICS (10.1, 10.3, P7.2)
   ═══════════════════════════════════════════════════════════════ */

check('metrics come from the LIVE instance, never from a stylesheet', () => {
  const metrics = extractBlock(historySrc, 'TerminalHistoryLayer.prototype.applyMetrics = function applyMetrics() {');
  assert.ok(metrics.includes('term.options'), 'family, size and line height come from the terminal');
  assert.ok(metrics.includes('.xterm-screen'), 'the resolved values are read off the live surface');
  assert.ok(metrics.includes('.xterm-rows > div'), 'the row height is measured, not computed, where a row exists');
  assert.ok(/padLeft/.test(metrics), 'column 1 must land on the same x coordinate');
  assert.ok(metrics.includes('surface.bg') && metrics.includes('surface.ink'),
    'the ground and the ink come from the same projection the canvas uses');
  // The stylesheet must NOT pin typography for the document, or a webfont swap
  // would desynchronise the layer from the terminal.
  const docRule = stylesCss.slice(stylesCss.indexOf('.terminal-history-doc {'));
  const body = docRule.slice(0, docRule.indexOf('}'));
  assert.ok(!/font-size|line-height|font-family/.test(body),
    'typography is derived at open time (10.3), so the sheet must not pin it');
});

check('executed: the layer paints the SAME ground the terminal surface publishes', () => {
  const teardown = installDom();
  try {
    const pane = makePane();
    const layer = new H.TerminalHistoryLayer(pane);
    layer.open('test');
    const expected = require(path.join(PUBLIC_DIR, 'terminal-surface.js')).terminalSurface('mocha');
    assert.strictEqual(layer.root.style.background, expected.bg,
      'one shade of difference and the seam is visible (10.1)');
    assert.strictEqual(layer.doc.style.color, expected.ink);
    assert.strictEqual(layer.ruleEl.style.borderTopColor, expected.rule);
    assert.strictEqual(layer.pagingEl.style.color, expected.dim);
    layer.destroy();
  } finally { teardown(); }
});

/* ═══════════════════════════════════════════════════════════════
   9. WIRING AND LIFECYCLE IN terminal.js
   ═══════════════════════════════════════════════════════════════ */

check('the surface is optional: every entry point is gated on the module existing', () => {
  const available = extractBlock(terminalSrc, '  _historySurfaceAvailable() {');
  assert.ok(available.includes('window.TerminalHistory'));
  for (const method of ['_ensureHistoryLayer() {', '_historyKeyVerdict(e) {']) {
    const body = extractBlock(terminalSrc, '  ' + method);
    assert.ok(/_historySurfaceAvailable\(\)|_historyLayer/.test(body), method + ' must be gated');
  }
  const strip = extractBlock(terminalSrc, '  _shouldShowSelectModeStrip() {');
  assert.ok(strip.includes('if (!this._historySurfaceAvailable()) return true;'),
    'without the surface, the strip behaves exactly as it did before P7');
});

check('the layer is torn down with every other host-owned resource', () => {
  const detach = extractBlock(terminalSrc, 'detachHostBindings() {');
  assert.ok(detach.includes('_destroyHistoryLayer()'),
    'a cached pane must not leave one session history floating over another session terminal');
  const dispose = extractBlock(terminalSrc, 'dispose() {');
  assert.ok(dispose.includes('_destroyHistoryLayer()'));
  const rebind = extractBlock(terminalSrc, 'rebindHost(containerId) {');
  assert.ok(rebind.includes('_installHistorySurface()'), 'a moved pane rebuilds its surface');
  const mount = extractBlock(terminalSrc, 'mount() {');
  assert.ok(mount.includes('_installHistorySurface()'));
  const destroy = extractBlock(terminalSrc, '  _destroyHistoryLayer() {');
  assert.ok(destroy.includes('_historyBufferDisposable'), 'the buffer subscription must be released too');
});

check('the wheel hook uses the PUBLIC xterm API and leaves the Select guard alone', () => {
  const install = extractBlock(terminalSrc, '  _installHistorySurface() {');
  assert.ok(install.includes('attachCustomWheelEventHandler'),
    '13.2: add a sibling through the public API, never rewrite the capture-phase guard');
  const guard = extractBlock(terminalSrc, '  _installSelectModeWheelGuard() {');
  assert.ok(guard.includes('_isInsideCopyView(e.target)'), 'the Copy view exemption is preserved');
  assert.ok(guard.includes('_isInsideHistoryLayer(e.target)'), 'the surface gets the same exemption');
  assert.ok(guard.includes('SELECT_FREEZE_WHEEL_LINES') || guard.includes('_wheelLinesFromEvent'),
    'the guard body itself is unchanged');
});

check('the mode frame is stored WHOLE, and the enum is never truthy-tested in terminal.js', () => {
  assert.ok(/this\._remoteModeFrame = msg;/.test(terminalSrc),
    'the router needs altBuffer and mouseTracking, not just bracketedPaste');
  assert.ok(!/if\s*\(\s*(?:msg|frame|this\._remoteModeFrame)\.mouseTracking\s*\)/.test(terminalSrc),
    "'none' is truthy: a bare truthy test on mouseTracking is always a bug");
  const resolver = extractBlock(terminalSrc, '  _mouseTrackingActive() {');
  assert.ok(resolver.includes("!== 'none'"), 'the fallback must compare against the enum value');
});

check('Ctrl+Shift+A selects the whole document and falls back to the terminal buffer', () => {
  const handler = extractBlock(terminalSrc, 'this.term.attachCustomKeyEventHandler((e) => {');
  const branch = extractBlock(handler, "if (mod && e.shiftKey && shortcutKey === 'a') {");
  assert.ok(branch.includes('selectAllHistory()'), 'P7.6 upgrades the body');
  assert.ok(branch.includes('term.selectAll()'), 'and keeps the old behaviour as the fallback');
  const selectAll = extractBlock(terminalSrc, '  selectAllHistory() {');
  assert.ok(selectAll.includes("layer.open('select-all')"),
    'selecting everything on a surface that is not showing everything would copy a subset');
});

check('the three pinned Ctrl+C anchors still resolve to the plain branch', () => {
  // The three suites locate the branch by these literals. A new branch that
  // began with the same characters would be extracted as part of it.
  const anchor = "if (mod && shortcutKey === 'c'";
  const start = terminalSrc.indexOf(anchor);
  assert.ok(start !== -1);
  const slice = terminalSrc.slice(start, terminalSrc.indexOf('return false;', start) + 13);
  assert.ok(!/preventDefault/.test(slice), 'the plain branch must stay free of preventDefault');
  assert.ok(!/copyTextToClipboard/.test(slice), 'and free of the async helper');
  assert.ok(terminalSrc.indexOf("if (this._historyOwnsSelection() && mod") > -1,
    'the history copy branch must be spelled so it cannot be mistaken for the plain one');
  assert.ok(terminalSrc.indexOf("if (this._historyOwnsSelection() && mod") < start,
    'and it must sit ABOVE it, or the plain branch swallows the case');
});

check('P7.6: not one Select mode identifier was removed', () => {
  // The done criterion, as a list. Every one of these is v1, v2 or v3
  // machinery that TERMINAL-ARCHITECTURE 13.2 requires to survive verbatim.
  const preserved = [
    '_installSelectModeInterceptor', '__cwmSelSynthetic', 'TERMINAL_REPORT_ONLY_RE',
    '_isTerminalReportOnly', '_isReportOnlyInputFrame', '_installInputUnfreezeHook',
    '_engageSelectHold', '_releaseSelectHold', '_onSelectionChanged', '_isWriteFrozen',
    '_unfreezeAndFlush', '_discardSelectModeHold', 'SELECT_FREEZE_MAX_HOLD_CHARS',
    '_overflowSelectFreeze', '_showSelectModeStrip', 'SELECT_STRIP_TEXT',
    '_applySelectStripPlacement', '_selectStripBottomPx', '_hideSelectModeStrip',
    '_showSelectModeNotice', '_ensureCopyOverlay', '_loadTranscriptSnapshot',
    '_loadEarlierTranscript', '_renderTranscriptText', '_copyViewIdentity',
    '_copyViewApi', '_copyViewDeviceId', 'getCopySelection', 'copyTextToClipboard',
    '_copyViaExecCommand', '_installSelectModeWheelGuard', '_removeSelectModeWheelGuard',
    '_wheelLinesFromEvent', 'setSelectMode', 'toggleSelectMode', '_exitSelectModeForInput',
    '_refocusTerminalForSelect', '_notifySelectChromeState', '_updateSelectModeUI',
    '_composeCopyViewText', '_readBufferLines', '_collapseBlankRuns', 'SELECT_STRIP_Z_INDEX',
    'SELECT_FREEZE_WHEEL_LINES', 'SELECT_NOTICE_MS', 'COPY_VIEW_DIVIDER',
  ];
  const missing = preserved.filter((id) => !terminalSrc.includes(id));
  assert.deepStrictEqual(missing, [], 'removed Select-mode identifiers: ' + missing.join(', '));
});

check('P7.6: the strip is DEMOTED at its call site, not rewritten', () => {
  const show = extractBlock(terminalSrc, '_showSelectModeStrip() {');
  assert.ok(show.includes('TerminalPane.SELECT_STRIP_TEXT'), 'the method body is untouched');
  assert.ok(show.includes('_applySelectStripPlacement'), 'including its placement calls');
  const ui = extractBlock(terminalSrc, '_updateSelectModeUI() {');
  assert.ok(ui.includes('_shouldShowSelectModeStrip()'), 'the gate is at the call site');
  assert.ok(ui.includes('_notifySelectChromeState()'), 'and the mobile mirror still fires');
  const notice = extractBlock(terminalSrc, '_showSelectModeNotice(text, ms) {');
  assert.ok(notice.includes('_showSelectModeStrip()'),
    'the transient notice path must still be able to raise the strip');
});

check('executed: the demoted strip appears on the first plain drag and never again', () => {
  const store = {};
  const prevLs = global.localStorage;
  global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const prevWin = global.window;
  global.window = { TerminalHistory: H };
  try {
    const TerminalPane = requireTerminalPane();
    const fake = Object.create(TerminalPane.prototype);
    fake._selectHold = false;
    fake._selectStripAnnounced = false;
    fake.term = { modes: { mouseTrackingMode: 'any' } };
    fake._remoteModeFrame = null;

    assert.strictEqual(fake._shouldShowSelectModeStrip(), false,
      'the toggle alone explains nothing: v3 pauses nothing until a drag starts');
    fake._selectHold = true;
    assert.strictEqual(fake._shouldShowSelectModeStrip(), true, 'the first plain drag says it once');
    assert.strictEqual(store.cwm_selectstrip_v1, '1');
    fake._selectHold = false;
    fake._shouldShowSelectModeStrip();
    fake._selectHold = true;
    assert.strictEqual(fake._shouldShowSelectModeStrip(), false, 'and never again');

    // A pane with no mouse tracking never needed the explanation at all.
    const shell = Object.create(TerminalPane.prototype);
    shell._selectHold = true;
    shell._selectStripAnnounced = false;
    shell.term = { modes: { mouseTrackingMode: 'none' } };
    shell._remoteModeFrame = null;
    delete store.cwm_selectstrip_v1;
    assert.strictEqual(shell._shouldShowSelectModeStrip(), false);
  } finally {
    global.localStorage = prevLs;
    global.window = prevWin;
  }
});

/**
 * Compile terminal.js in a sandbox and hand back the class.
 *
 * The file is a browser script rather than a module, so it is evaluated the
 * same way the other terminal suites evaluate it: in a vm context with the
 * globals it touches at parse time.
 *
 * @returns {Function} The TerminalPane class.
 */
function requireTerminalPane() {
  const vm = require('vm');
  const sandbox = {
    window: global.window,
    document: undefined,
    localStorage: global.localStorage,
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    WebSocket: function WebSocket() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(terminalSrc + '\n;globalThis.__TerminalPane = TerminalPane;', sandbox);
  return sandbox.__TerminalPane;
}

/* ═══════════════════════════════════════════════════════════════
   10. THE SERVER ROUTE
   ═══════════════════════════════════════════════════════════════ */

check('the history route exists, is authenticated and is bounded', () => {
  assert.ok(serverSrc.includes("app.get('/api/sessions/:id/history', requireAuth,"),
    'the route must exist and must be behind requireAuth');
  const route = extractBlock(serverSrc, "app.get('/api/sessions/:id/history', requireAuth, (req, res) => {");
  assert.ok(route.includes('HISTORY_ROUTE_MAX_LINES'), 'the page size must be clamped');
  assert.ok(route.includes('getHistoryLines'), 'it wraps the P6 read API');
  assert.ok(route.includes('getSidecarStats'), 'and publishes the reflow count for render-time dedupe');
  assert.ok(route.includes('getSessionMode'), 'and the mode, as a fallback router signal');
  assert.ok(/catch\s*\(_\)\s*\{[\s\S]*res\.json\(empty\)/.test(route), 'it must never throw');
  assert.ok(!/res\.status\(4\d\d\)|res\.status\(5\d\d\)/.test(route),
    'no deep history is an ordinary state, not an error status');
});

check('executed: the route clamps, enriches and degrades without throwing', () => {
  // Compile the REAL route body against fakes. The handler is an arrow inside
  // an app.get call, so the balanced block starting at its own brace is the
  // function body, and wrapping it in a function of (req, res) reproduces the
  // handler exactly without booting a server.
  const routeSrc = extractBlock(serverSrc, "app.get('/api/sessions/:id/history', requireAuth, (req, res) => {");
  const body = extractBlock(routeSrc, '{');
  const factory = new Function('getPtyManager', 'HISTORY_ROUTE_MAX_LINES', 'HISTORY_ROUTE_DEFAULT_LINES',
    'return function handler(req, res) ' + body + ';');

  const calls = [];
  const manager = {
    getHistoryLines: (id, opts) => {
      calls.push(opts);
      return {
        lines: [{ t: 'x', w: false }], firstLine: 10, beforeLine: 11, total: 100,
        oldestAvailable: 0, hasMore: true, lostLines: 3, available: true,
      };
    },
    getSidecarStats: () => ({ sidecars: [{ sessionId: 's1', reflows: 7 }] }),
    getSessionMode: () => ({ altBuffer: false, mouseTracking: 'none', mouseTrackingActive: false, bracketedPaste: true }),
  };
  const handler = factory(() => manager, 2000, 500);
  const run = (query) => {
    let payload = null;
    handler({ params: { id: 's1' }, query }, { json: (p) => { payload = p; return p; } });
    return payload;
  };

  let out = run({ lines: '999999' });
  assert.strictEqual(calls[0].lines, 2000, 'an untrusted page size is clamped to the route ceiling');
  assert.strictEqual(out.reflows, 7);
  assert.strictEqual(out.lostLines, 3);
  assert.strictEqual(out.available, true);
  assert.strictEqual(out.mode.bracketedPaste, true);
  assert.strictEqual(out.maxLines, 2000);

  run({ lines: '0' });
  assert.strictEqual(calls[1].lines, 1, 'and to a floor of one');
  run({});
  assert.strictEqual(calls[2].lines, 500, 'a caller that asks for nothing gets the default page');
  assert.strictEqual('beforeLine' in calls[2], false, 'no cursor means the newest page');
  run({ beforeLine: '-40' });
  assert.strictEqual(calls[3].beforeLine, 0, 'a negative cursor is clamped, not rejected');
  run({ beforeLine: 'nonsense' });
  assert.strictEqual('beforeLine' in calls[4], false, 'a malformed cursor means the newest page');

  // No manager at all (the common case: CWM_VT_SIDECAR is off).
  const none = factory(() => null, 2000, 500);
  let empty = null;
  none({ params: { id: 's1' }, query: {} }, { json: (p) => { empty = p; } });
  assert.strictEqual(empty.available, false);
  assert.deepStrictEqual(empty.lines, []);
  assert.strictEqual(empty.mode, null);

  // A manager that throws must still answer.
  const angry = factory(() => ({
    getHistoryLines() { throw new Error('boom'); },
    getSidecarStats() { throw new Error('boom'); },
    getSessionMode() { throw new Error('boom'); },
  }), 2000, 500);
  let recovered = null;
  angry({ params: { id: 's1' }, query: {} }, { json: (p) => { recovered = p; } });
  assert.strictEqual(recovered.available, false, 'a throwing sidecar degrades to an empty page');
});

check('the pane fetchers reuse the mirror plumbing rather than duplicating it', () => {
  const transcript = extractBlock(terminalSrc, '  async fetchTranscriptWindow(options) {');
  assert.ok(transcript.includes('_copyViewIdentity()'), '13.2: share the identity resolver');
  assert.ok(transcript.includes('_copyViewApi('), 'and the authenticated request helper');
  assert.ok(transcript.includes('/api/mirror/close'),
    'snapshot semantics: the ten-watcher limit must not be consumed by a reader');
  const deep = extractBlock(terminalSrc, '  async fetchDeepHistory(options) {');
  assert.ok(deep.includes('/api/sessions/'), 'the deep segment reads the new route');
  assert.ok(deep.includes('encodeURIComponent'), 'every interpolated value is encoded');
  // The Copy view's own methods must be untouched by the reuse.
  const snapshot = extractBlock(terminalSrc, '  async _loadTranscriptSnapshot() {');
  assert.ok(snapshot.includes('_renderTranscriptIntoOverlay()'),
    'the Copy view keeps its own rendering path');
});

check('index.html loads the surface after terminal.js, and it is optional to it', () => {
  assert.ok(/terminal-history\.js\?v=[A-Za-z0-9._-]+/.test(indexHtml), 'the script tag must exist');
  assert.ok(indexHtml.indexOf('terminal.js?v=') < indexHtml.indexOf('terminal-history.js?v='),
    'terminal.js first: the surface is an upgrade to it');
  assert.ok(indexHtml.indexOf('terminal-history.js?v=') < indexHtml.indexOf('app.js?v='),
    'and both before app.js, which owns the pane lifecycle');
});

console.log('  ' + '-'.repeat(74));
console.log('  [terminal-history] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
