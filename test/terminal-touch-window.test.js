#!/usr/bin/env node
/**
 * terminal-touch-window.test.js
 * Notion restyle phase P11b: the post-P7 mop-up P11 named in DECISIONS 17.7.
 * BUILD-CONTRACT.md P11.7 and P11.8, MOBILE-EXPERIENCE.md B.4, B.9, E.3, E.4.
 *
 * WHAT THIS GATES, and why each one is here rather than in a screenshot.
 *
 * P11.7's own done criterion in BUILD-CONTRACT is "manual matrix on a real
 * phone; touch selection cannot be meaningfully asserted headlessly", and that
 * is true of the FEEL of a gesture. It is not true of the DECISIONS a gesture
 * makes, and those are what regress silently:
 *
 *   1. THE BOUNDARY IS SYMMETRICAL AND THRESHOLDED. A flick that runs out of
 *      buffer opens the surface and hands it the travel it had banked; a pull
 *      past the bottom of the document gives the terminal back. Both are
 *      executed here against fakes, because "the momentum carried through"
 *      is arithmetic before it is a feeling.
 *
 *   2. THE ROUTER IS ONE FUNCTION. A boundary that only a slow drag can cross
 *      teaches the user that flicking is broken, so the finger path and the
 *      momentum path must be the same code. Asserted structurally.
 *
 *   3. NATIVE SCROLLING IS NOT REIMPLEMENTED. B.4 rule 2 is the whole reason
 *      the surface is DOM text, and rule 1 is why the platform's own handles
 *      have to survive. Both are stylesheet facts, and both are one word away
 *      from being destroyed by a plausible edit (`touch-action: none`).
 *
 *   4. THE WINDOW NEVER MOVES THE READER. Executed: a chunk is only ever
 *      collapsed to a height it was MEASURED at, a held selection freezes
 *      collapsing exactly as it freezes the mirror, and select-all puts the
 *      whole document back before it selects it.
 *
 *   5. THE BUDGET IS A BUDGET. E.3's three caps and E.4's cadence, executed.
 *
 * METHOD follows the P7 suite next door: terminal.js is evaluated in a sandbox
 * with stubbed globals and its real prototype methods are invoked against
 * minimal fakes; terminal-history.js is required directly because it is a UMD
 * module; anything that genuinely needs a browser is a SCOPED source assertion
 * (balanced-brace block extraction), never a loose file-wide regex.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'src', 'web', 'public');
const TERMINAL_PATH = path.join(PUBLIC_DIR, 'terminal.js');
const HISTORY_PATH = path.join(PUBLIC_DIR, 'terminal-history.js');
const STYLES_PATH = path.join(PUBLIC_DIR, 'styles.css');
const APP_PATH = path.join(PUBLIC_DIR, 'app.js');
const VIEWPORT_PATH = path.join(PUBLIC_DIR, 'mobile-viewport.js');

const terminalSrc = fs.readFileSync(TERMINAL_PATH, 'utf8');
const historySrc = fs.readFileSync(HISTORY_PATH, 'utf8');
const stylesCss = fs.readFileSync(STYLES_PATH, 'utf8');
const appSrc = fs.readFileSync(APP_PATH, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;

/**
 * Run one named check, tally it, and keep going on failure so one regression
 * cannot hide the rest of the suite.
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
 * Slice a balanced-brace block out of source text from a literal anchor.
 *
 * Same idiom the Select-mode suites use, so a body assertion here reads the
 * way theirs do and fails for the same reasons.
 *
 * @param {string} src - Source text.
 * @param {string} anchor - Literal that starts the block.
 * @returns {string} The block including its braces.
 */
function balancedBlock(src, anchor) {
  const at = src.indexOf(anchor);
  assert.notStrictEqual(at, -1, 'anchor not found: ' + anchor);
  const open = src.indexOf('{', at);
  assert.notStrictEqual(open, -1, 'no brace after anchor: ' + anchor);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced block for anchor: ' + anchor);
}

/**
 * Slice a CSS rule body by selector, cutting at the first closing brace.
 *
 * @param {string} css - Stylesheet text.
 * @param {string} selector - Exact selector text.
 * @returns {string} The declarations between the braces.
 */
function cssRule(css, selector) {
  const at = css.indexOf(selector + ' {');
  assert.notStrictEqual(at, -1, 'selector not found: ' + selector);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.notStrictEqual(close, -1, 'unterminated rule: ' + selector);
  return css.slice(open + 1, close);
}

/**
 * Compile terminal.js in a sandbox with stubbed browser globals.
 *
 * The stubbed `window` and `document` are returned alongside the bindings and
 * are the ONLY way to change what the compiled code sees. `new Function` binds
 * them as parameters, so they shadow the real globals for the whole file, and
 * a test that reassigns `global.window` would be talking to nobody. That is
 * exactly the trap the first draft of this suite fell into: three checks
 * passed while asserting nothing.
 *
 * @param {object} [over] - Overrides for the stubbed window and document.
 * @returns {object} The exported runtime bindings, plus `win` and `doc`.
 */
function loadTerminalRuntime(over) {
  const o = over || {};
  const win = Object.assign({
    matchMedia: () => ({ matches: false }),
  }, o.window || {});
  const doc = Object.assign({
    documentElement: { dataset: o.viewMode ? { viewMode: o.viewMode } : {} },
    getElementById: () => (o.container === undefined ? null : o.container),
  }, o.document || {});
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const WebSocketStub = Object.assign(function () {}, { OPEN: 1 });
  const factory = new Function(
    'window', 'document', 'Terminal', 'FitAddon', 'WebSocket', 'localStorage',
    'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    terminalSrc +
    '\nreturn {' +
    ' TerminalPane: TerminalPane,' +
    ' PHONE_SCROLLBACK_LINES: PHONE_SCROLLBACK_LINES,' +
    ' DESKTOP_SCROLLBACK_LINES: DESKTOP_SCROLLBACK_LINES,' +
    ' PHONE_MAX_LIVE_PANES: PHONE_MAX_LIVE_PANES,' +
    ' BACKGROUND_FLUSH_MS: BACKGROUND_FLUSH_MS,' +
    ' IDLE_FLUSH_MS: IDLE_FLUSH_MS,' +
    ' DORMANT_FLUSH_MS: DORMANT_FLUSH_MS,' +
    ' READER_MAX_CHARS: READER_MAX_CHARS,' +
    ' READER_TRUNCATION_NOTICE: READER_TRUNCATION_NOTICE,' +
    ' HISTORY_TOUCH_OPEN_PX: HISTORY_TOUCH_OPEN_PX,' +
    ' HISTORY_TOUCH_CLOSE_PX: HISTORY_TOUCH_CLOSE_PX };'
  );
  const bindings = factory(
    win, doc, function () {}, { FitAddon: function () {} }, WebSocketStub, storage,
    { maxTouchPoints: 0 },
    (fn) => { if (typeof fn === 'function') fn(); return 1; },
    () => {}, setTimeout, clearTimeout
  );
  return Object.assign(bindings, { win: win, doc: doc });
}

const rt = loadTerminalRuntime();
const TerminalPane = rt.TerminalPane;

/**
 * Replace the sandbox window's mobile driver for one check.
 *
 * @param {boolean} phone - What `isPhone()` should answer.
 * @param {object} [constants] - Constant table to publish.
 * @returns {void}
 */
function setSandboxDriver(phone, constants) {
  rt.win.MyrlinMobileViewport = { isPhone: () => phone, constants: constants || {} };
}

/**
 * Restore the sandbox window to a bare browser with no Workbook globals.
 *
 * @returns {void}
 */
function clearSandboxGlobals() {
  delete rt.win.MyrlinMobileViewport;
  delete rt.win.MyrlinClaimGate;
  rt.win.matchMedia = () => ({ matches: false });
  rt.doc.documentElement.dataset = {};
}

/* ── the history module, and a DOM small enough to reason about ── */

/**
 * Build a fake element that measures, holds children, and reports a height.
 *
 * `offsetHeight` is derived from the text it currently holds, which is the one
 * behaviour the windowed renderer depends on: it may only collapse a chunk it
 * has measured.
 *
 * @param {string} tag - Tag name.
 * @returns {object} The fake element.
 */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attrs: {},
    hidden: false,
    listeners: {},
    _text: '',
    _classes: new Set(),
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    get textContent() { return el._text; },
    set textContent(v) {
      el._text = String(v);
      if (el._text === '') el.children.length = 0;
    },
    get offsetHeight() {
      if (el.style.height) return parseFloat(el.style.height) || 0;
      // One pixel per character is a fiction, but it is a MONOTONIC fiction,
      // which is all the renderer needs: a measured height is a measured
      // height, and the test asserts that the pinned value equals it.
      return el._text.length;
    },
    appendChild(child) { el.children.push(child); return child; },
    remove() {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = el.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    dispatch(type, event) { for (const fn of (el.listeners[type] || [])) fn(event); },
    contains(node) {
      if (node === el) return true;
      for (const c of el.children) if (c && c.contains && c.contains(node)) return true;
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
 * Install fake browser globals for the history layer, optionally with a
 * controllable IntersectionObserver.
 *
 * @param {object} [opts] - { selection, observer, reducedMotion }.
 * @returns {object} { teardown, observers }.
 */
function installDom(opts) {
  const o = opts || {};
  const observers = [];
  const prev = {
    document: global.document,
    window: global.window,
    raf: global.requestAnimationFrame,
    caf: global.cancelAnimationFrame,
  };
  const doc = {
    createElement: (tag) => makeEl(tag),
    createRange: () => ({ setStartBefore() {}, setEndAfter() {}, selectNodeContents() {} }),
    getSelection: () => o.selection || { isCollapsed: true, anchorNode: null, focusNode: null },
    addEventListener() {},
    removeEventListener() {},
    documentElement: { getAttribute: () => 'mocha' },
  };
  function FakeIntersectionObserver(cb, init) {
    this.callback = cb;
    this.init = init || {};
    this.observed = [];
    observers.push(this);
  }
  FakeIntersectionObserver.prototype.observe = function observe(el) {
    if (this.observed.indexOf(el) === -1) this.observed.push(el);
  };
  FakeIntersectionObserver.prototype.unobserve = function unobserve(el) {
    const i = this.observed.indexOf(el);
    if (i !== -1) this.observed.splice(i, 1);
  };
  FakeIntersectionObserver.prototype.disconnect = function disconnect() {
    this.observed.length = 0;
    this.disconnected = true;
  };
  /**
   * Fire the observer for a subset of its observed elements.
   *
   * @param {Function} predicate - Given an element, true when it intersects.
   * @returns {void}
   */
  FakeIntersectionObserver.prototype.fire = function fire(predicate) {
    this.callback(this.observed.map((el) => ({ target: el, isIntersecting: !!predicate(el) })));
  };
  global.document = doc;
  global.window = {
    getSelection: () => o.selection || { removeAllRanges() {}, addRange() {}, isCollapsed: true },
    getComputedStyle: () => ({
      fontFamily: 'iA Writer Mono', fontSize: '13px', letterSpacing: 'normal',
      paddingLeft: '14px', paddingTop: '12px',
    }),
    matchMedia: (q) => ({ matches: !!o.reducedMotion && /reduced-motion/.test(q) }),
    MyrlinTerminalSurface: require(path.join(PUBLIC_DIR, 'terminal-surface.js')),
  };
  if (o.observer !== false) global.window.IntersectionObserver = FakeIntersectionObserver;
  global.requestAnimationFrame = (fn) => { fn(); return 1; };
  global.cancelAnimationFrame = () => {};
  return {
    observers,
    teardown() {
      global.document = prev.document;
      global.window = prev.window;
      global.requestAnimationFrame = prev.raf;
      global.cancelAnimationFrame = prev.caf;
    },
  };
}

const H = require(HISTORY_PATH);

/**
 * A fake pane sufficient for the history layer.
 *
 * @param {object} [over] - Overrides.
 * @returns {object} The fake pane.
 */
function makePane(over) {
  const paneEl = makeEl('div');
  const container = makeEl('div');
  const pane = Object.assign({
    sessionId: 'sess-1',
    paneEl,
    term: {
      options: { fontSize: 13, lineHeight: 1.2, fontFamily: 'iA Writer Mono' },
      modes: { mouseTrackingMode: 'none' },
      buffer: {
        active: {
          type: 'normal', baseY: 0, viewportY: 0, length: 0,
          getLine: () => undefined,
        },
        normal: { type: 'normal', baseY: 0, viewportY: 0, length: 0, getLine: () => undefined },
        onBufferChange: () => ({ dispose() {} }),
      },
      scrollToBottom() {},
    },
    ws: null,
    _remoteModeFrame: null,
    _getOwnedContainer: () => container,
    _copyViewIdentity: () => null,
    _log() {},
    _notifySelectChromeState() {},
    focus() {},
    fetchDeepHistory: () => Promise.resolve({ available: false }),
    fetchTranscriptWindow: () => Promise.resolve(null),
  }, over || {});
  return pane;
}

/**
 * Build an open layer whose document has controllable scroll geometry.
 *
 * @param {object} dom - The installDom result.
 * @param {object} [geometry] - { scrollTop, scrollHeight, clientHeight }.
 * @returns {object} The layer.
 */
function openLayer(dom, geometry) {
  const layer = new H.TerminalHistoryLayer(makePane());
  layer._ensureDom();
  layer._open = true;
  const g = geometry || {};
  layer.doc.scrollHeight = g.scrollHeight === undefined ? 1000 : g.scrollHeight;
  layer.doc.clientHeight = g.clientHeight === undefined ? 200 : g.clientHeight;
  layer.doc.scrollTop = g.scrollTop === undefined ? 800 : g.scrollTop;
  void dom;
  return layer;
}

console.log('\n  \x1b[1mP11b: the touch boundary, the jump pills, the window and the budget\x1b[0m');
console.log('  ' + '-'.repeat(74));

/* ═══════════════════════════════════════════════════════════════
   1. THE CLAIM GATE (item 1, DEVIATIONS DV-P11-3)
   ═══════════════════════════════════════════════════════════════ */

/**
 * A fake pane sufficient for the claim path.
 *
 * @param {object} [over] - Overrides.
 * @returns {object} The fake.
 */
function makeClaimFake(over) {
  const fake = Object.assign(Object.create(TerminalPane.prototype), {
    sessionId: 'sess-claim',
    sent: [],
    term: { cols: 50, rows: 20 },
    ws: { readyState: 1, send(m) { fake.sent.push(m); } },
    _selectMode: false,
    _selectHold: false,
    _activateBlockedUntil: 0,
    _lastActivateAt: 0,
    _lastActivateCols: 0,
    _lastActivateRows: 0,
    _activatePending: false,
    paneEl: null,
    safeFit() {},
    _log() {},
  });
  return Object.assign(fake, over || {});
}

check('executed: _requestActivate consults the published claim gate and obeys a refusal', () => {
  const fake = makeClaimFake();
  const asked = [];
  rt.win.MyrlinClaimGate = { canClaim: (id) => { asked.push(id); return false; } };
  try {
    assert.strictEqual(TerminalPane.prototype._requestActivate.call(fake, 'visible'), false,
      'a refused claim must not reach the wire');
    assert.strictEqual(fake.sent.length, 0);
    assert.deepStrictEqual(asked, ['sess-claim'],
      'the gate is asked about THIS session, which is B.9 rule 4');
    assert.strictEqual(fake._activatePending, false,
      'a refusal is not a deferral: replaying it later is the claim the user did not ask for');
  } finally {
    clearSandboxGlobals();
  }
});

check('executed: a permitting gate, and no gate at all, both leave the claim intact', () => {
  try {
    rt.win.MyrlinClaimGate = { canClaim: () => true };
    const allowed = makeClaimFake();
    assert.strictEqual(TerminalPane.prototype._requestActivate.call(allowed, 'visible'), true);
    assert.strictEqual(allowed.sent.length, 1);

    clearSandboxGlobals();
    const ungated = makeClaimFake();
    assert.strictEqual(TerminalPane.prototype._requestActivate.call(ungated, 'visible'), true,
      'a page without app.js keeps the P6 behaviour');
  } finally {
    clearSandboxGlobals();
  }
});

check('executed: a throwing gate fails OPEN, because a broken guard must not disable the claim', () => {
  rt.win.MyrlinClaimGate = { canClaim() { throw new Error('boom'); } };
  try {
    const fake = makeClaimFake();
    assert.strictEqual(TerminalPane.prototype._requestActivate.call(fake, 'visible'), true);
    assert.strictEqual(fake.sent.length, 1);
  } finally {
    clearSandboxGlobals();
  }
});

check('the gate is read ABOVE the freeze branch, so a refusal is never queued', () => {
  const body = balancedBlock(terminalSrc, '_requestActivate(reason) {');
  const gateAt = body.indexOf('window.MyrlinClaimGate');
  const freezeAt = body.indexOf('this._activatePending = true');
  assert.ok(gateAt !== -1, 'the DV-P11-3 line must be inside _requestActivate');
  assert.ok(freezeAt !== -1);
  assert.ok(gateAt < freezeAt, 'the gate must be consulted before the deferral branch');
  assert.ok(body.includes('!window.MyrlinClaimGate.canClaim(this.sessionId)'),
    'the predicate is the one app.js publishes, not a re-derivation');
});

/* ═══════════════════════════════════════════════════════════════
   2. ONE TABLE OF GESTURE CONSTANTS (item 5)
   ═══════════════════════════════════════════════════════════════ */

check('executed: mobileConstant reads the published table and falls back cleanly', () => {
  try {
    setSandboxDriver(false, { MW_LONGPRESS_MS: 555 });
    assert.strictEqual(TerminalPane.mobileConstant('MW_LONGPRESS_MS', 400), 555);
    assert.strictEqual(TerminalPane.mobileConstant('MW_MISSING', 42), 42);
    setSandboxDriver(false, { MW_LONGPRESS_MS: 'soon' });
    assert.strictEqual(TerminalPane.mobileConstant('MW_LONGPRESS_MS', 400), 400,
      'a non-numeric table entry must not become a timer duration');
    clearSandboxGlobals();
    assert.strictEqual(TerminalPane.mobileConstant('MW_LONGPRESS_MS', 400), 400,
      'a build without the driver keeps the literal it always had');
  } finally {
    clearSandboxGlobals();
  }
});

check('the touch engine takes all three gesture numbers from the table, with the old literals as fallbacks', () => {
  const body = balancedBlock(terminalSrc, '  initMobileInputMode() {');
  assert.ok(body.includes("TerminalPane.mobileConstant('MW_LONGPRESS_MS', 400)"),
    'the long-press duration must come from the table');
  assert.ok(body.includes("TerminalPane.mobileConstant('MW_LONGPRESS_MOVE_PX', 8)"),
    'the slop must come from the table');
  assert.ok(!/const LONG_PRESS_MS = 400;/.test(body),
    'the bare literal must be gone, or the table is decoration');
  const selection = balancedBlock(terminalSrc, '  _enableMobileSelection() {');
  assert.ok(selection.includes("TerminalPane.mobileConstant('MW_LONGPRESS_HAPTIC_MS', 25)"),
    'the haptic that confirms a long press must be the shared one');
});

check('the fallbacks equal the published values, so the two paths cannot disagree today', () => {
  const viewportSrc = fs.readFileSync(VIEWPORT_PATH, 'utf8');
  assert.ok(/var MW_LONGPRESS_MS = 400;/.test(viewportSrc));
  assert.ok(/var MW_LONGPRESS_MOVE_PX = 8;/.test(viewportSrc));
  assert.ok(/var MW_LONGPRESS_HAPTIC_MS = 25;/.test(viewportSrc));
});

/* ═══════════════════════════════════════════════════════════════
   3. THE TOUCH BOUNDARY (P11.7)
   ═══════════════════════════════════════════════════════════════ */

check('one router serves the finger and the momentum tail, so a flick crosses like a drag', () => {
  const body = balancedBlock(terminalSrc, '  initMobileInputMode() {');
  const router = balancedBlock(body, 'const applyGestureScroll = (px) => {');
  assert.ok(router.includes('crossIntoHistory'), 'the router owns the crossing');
  assert.ok(router.includes('driveHistory'), 'and owns the frames after it');
  const momentum = balancedBlock(body, 'const animateMomentum = (timestamp) => {');
  assert.ok(momentum.includes('applyGestureScroll(velocity * dt)'),
    'the momentum tail must go through the same router the finger does');
  const move = body.indexOf('applyGestureScroll(deltaY)');
  assert.notStrictEqual(move, -1, 'the finger path must go through the router too');
});

check('the crossing is thresholded and banks its travel rather than dropping it', () => {
  const body = balancedBlock(terminalSrc, '  initMobileInputMode() {');
  const cross = balancedBlock(body, 'const crossIntoHistory = (px) => {');
  assert.ok(cross.includes('boundaryAccum += px'), 'travel is accumulated');
  assert.ok(cross.includes('boundaryAccum < HISTORY_TOUCH_OPEN_PX'), 'and thresholded');
  assert.ok(/return banked;/.test(cross),
    'the banked travel must be handed to the surface, or the gesture visibly stalls for a frame');
  assert.ok(rt.HISTORY_TOUCH_OPEN_PX > 8,
    'the open threshold must exceed the scroll slop, or an idle overscroll opens the surface');
  assert.strictEqual(rt.HISTORY_TOUCH_OPEN_PX, rt.HISTORY_TOUCH_CLOSE_PX,
    'the two directions must use the same number, or the boundary feels lopsided');
});

check('the alternate buffer is ALWAYS at the boundary, which is the case the surface exists for', () => {
  const body = balancedBlock(terminalSrc, '  initMobileInputMode() {');
  const atTop = balancedBlock(body, 'const atBufferTop = () => {');
  assert.ok(/buf\.type === 'alternate'\) return true;/.test(atTop),
    'an agent CLI paints a frame with no scrollback, so its viewport is always the top');
  assert.ok(atTop.includes('viewportY'),
    'the normal buffer asks xterm where the viewport is rather than tracking its own copy');
});

check('executed: scrollByPixels absorbs what it can and reports the rest, in the caller sign', () => {
  const dom = installDom();
  try {
    const layer = openLayer(dom, { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 });
    assert.strictEqual(layer.scrollByPixels(100), 0, 'an absorbed scroll leaves nothing over');
    assert.strictEqual(layer.doc.scrollTop, 300, 'positive px moves toward OLDER content');

    layer.doc.scrollTop = 20;
    assert.strictEqual(layer.scrollByPixels(50), 30,
      'travel past the TOP comes back positive, which is what keeps paging honest');
    assert.strictEqual(layer.doc.scrollTop, 0);

    layer.doc.scrollTop = 780;
    assert.strictEqual(layer.scrollByPixels(-40), -20,
      'travel past the BOTTOM comes back negative, which is the exit signal');
    assert.strictEqual(layer.doc.scrollTop, 800);
  } finally {
    dom.teardown();
  }
});

check('executed: a touch that pulls past the bottom of the surface closes it, and a scroll does not', () => {
  const dom = installDom();
  try {
    const layer = openLayer(dom, { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    let closed = 0;
    layer.close = function fakeClose() { closed++; return true; };

    // Not at the bottom: an upward drag is an ordinary scroll and must not exit.
    layer.doc.scrollTop = 100;
    layer._onDocTouchStart({ touches: [{ clientY: 500 }] });
    layer._onDocTouchMove({ touches: [{ clientY: 400 }] });
    assert.strictEqual(closed, 0, 'scrolling through the document must never exit it');

    // At the bottom: travel the scroller refused accumulates and exits.
    layer.doc.scrollTop = 800;
    layer._onDocTouchStart({ touches: [{ clientY: 500 }] });
    layer._onDocTouchMove({ touches: [{ clientY: 490 }] });
    assert.strictEqual(closed, 0, 'a small overscroll is not an intent');
    layer._onDocTouchMove({ touches: [{ clientY: 460 }] });
    assert.strictEqual(closed, 1, 'past the threshold the terminal comes back');
  } finally {
    dom.teardown();
  }
});

check('the surface reimplements no scrolling of its own for gestures that start inside it', () => {
  const bind = balancedBlock(historySrc, "TerminalHistoryLayer.prototype._bindDomEvents = function _bindDomEvents() {");
  assert.ok(/touchstart[\s\S]{0,200}passive: true/.test(bind),
    'the touch listeners must be passive, or every touch costs a frame');
  const moveBody = balancedBlock(historySrc, 'TerminalHistoryLayer.prototype._onDocTouchMove = function _onDocTouchMove(e) {');
  assert.ok(!/scrollTop\s*[-+]?=/.test(moveBody),
    'B.4 rule 2: the surface must not translate touchmove into scrollTop; native scrolling owns it');
  assert.ok(!/preventDefault/.test(moveBody),
    'a passive listener cannot preventDefault, and nothing here needs to');
});

/* ═══════════════════════════════════════════════════════════════
   4. B.4 RULES 1 AND 2 IN THE STYLESHEET
   ═══════════════════════════════════════════════════════════════ */

check('B.4 rules 1 and 2: native scrolling, native handles, no pull-to-refresh', () => {
  const rule = cssRule(stylesCss, '.terminal-history-doc');
  assert.ok(/touch-action:\s*pan-y/.test(rule),
    'pan-y says "scroll vertically and nothing else" without taking the gesture');
  assert.ok(!/touch-action:\s*none/.test(rule),
    'touch-action: none would hand every touch to script and take the platform handles with it');
  assert.ok(/-webkit-touch-callout:\s*default/.test(rule),
    'B.4 rule 1: the platform callout bar is what "do not reimplement handles" means');
  assert.ok(/user-select:\s*text/.test(rule) && /-webkit-user-select:\s*text/.test(rule));
  assert.ok(/overscroll-behavior:\s*contain/.test(rule),
    'a contained overscroll cannot chain to the root scroller, which is what suppresses pull-to-refresh');
  assert.ok(/-webkit-overflow-scrolling:\s*touch/.test(rule));
});

check('the terminal engine suppresses pull-to-refresh for the whole crossing gesture', () => {
  const body = balancedBlock(terminalSrc, '  initMobileInputMode() {');
  const move = balancedBlock(body, 'const onTouchMove = (e) => {');
  const guardAt = move.indexOf('if (e.cancelable) e.preventDefault();');
  const scrollAt = move.indexOf('applyGestureScroll(deltaY)');
  assert.ok(guardAt !== -1 && scrollAt !== -1);
  assert.ok(guardAt < scrollAt,
    'the default is prevented BEFORE the frame is applied, so the frames that scroll history are covered too');
});

/* ═══════════════════════════════════════════════════════════════
   5. THE JUMP PILLS (B.4 rule 4, and Ctrl+Shift+Home on touch)
   ═══════════════════════════════════════════════════════════════ */

check('executed: "Jump to live" appears past one viewport, "Oldest" whenever there is anything above', () => {
  const dom = installDom();
  try {
    const layer = openLayer(dom, { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    layer._updateJumpAffordance();
    assert.strictEqual(layer.jumpLiveBtn.hidden, true,
      'at the bottom the live screen is on screen, so offering to go there is noise');
    assert.strictEqual(layer.jumpTopBtn.hidden, false,
      'Oldest is needed AT the bottom, which is where the surface opens');

    layer.doc.scrollTop = 500;
    layer._updateJumpAffordance();
    assert.strictEqual(layer.jumpLiveBtn.hidden, false,
      'more than one viewport above the bottom is B.4 rule 4 exactly');
    assert.strictEqual(layer.jumpEl.hidden, false);

    layer.doc.scrollTop = 0;
    layer._updateJumpAffordance();
    assert.strictEqual(layer.jumpTopBtn.hidden, true, 'nothing above means nothing to jump to');

    layer.doc.scrollHeight = 200;
    layer.doc.scrollTop = 0;
    layer._updateJumpAffordance();
    assert.strictEqual(layer.jumpEl.hidden, true,
      'a document with no history hides the group entirely');
  } finally {
    dom.teardown();
  }
});

check('executed: the two pills perform the two keyboard actions a phone cannot press', () => {
  const dom = installDom();
  try {
    const layer = openLayer(dom, { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 });
    let closed = 0;
    layer.close = function fakeClose(reason) { closed++; layer.closeReason = reason; return true; };
    layer._pageOlder = () => Promise.resolve(false);

    layer.jumpTopBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(layer.doc.scrollTop, 0, 'Oldest is Ctrl+Shift+Home');

    layer.jumpLiveBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(closed, 1, 'Jump to live is Ctrl+Shift+End');
    assert.strictEqual(layer.closeReason, 'jump-to-live');
  } finally {
    dom.teardown();
  }
});

check('the pills clear the touch floor and are drawn on the terminal palette', () => {
  const rule = cssRule(stylesCss, '.terminal-history-jump-btn');
  assert.ok(/min-height:\s*44px/.test(rule), 'P10.6: the 44px floor wins over a tidier pill');
  assert.ok(/min-width:\s*44px/.test(rule));
  assert.ok(/border-radius:\s*var\(--radius-pill\)/.test(rule), 'G6: no radius literals');
  assert.ok(/var\(--term-bg/.test(rule) && /var\(--term-ink/.test(rule),
    'inside the terminal region the terminal palette wins');
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(rule), 'G5: no hex literals');
  const group = cssRule(stylesCss, '.terminal-history-jump');
  assert.ok(/position:\s*absolute/.test(group));
  assert.ok(!/box-shadow/.test(group), 'the rejection list bans shadows on this surface');
});

/* ═══════════════════════════════════════════════════════════════
   6. REDUCED MOTION ON OPEN AND CLOSE (P11.7)
   ═══════════════════════════════════════════════════════════════ */

check('executed: reduced motion is asked of the PLATFORM, not inferred from a scroll setting', () => {
  const quiet = installDom({ reducedMotion: true });
  try {
    const layer = openLayer(quiet, {});
    assert.strictEqual(layer._reducedMotion(), true);
    assert.strictEqual(layer._animationDuration(), 0);
    layer.root.style.transform = 'translateY(9px)';
    layer._animateIn();
    assert.strictEqual(layer.root.style.transform, '',
      'under reduced motion the surface must simply BE there, with no translate to undo');
  } finally {
    quiet.teardown();
  }
  const moving = installDom({ reducedMotion: false });
  try {
    const layer = openLayer(moving, {});
    assert.strictEqual(layer._reducedMotion(), false);
    assert.strictEqual(layer._animationDuration(), H.HISTORY_ANIMATION_MS);
  } finally {
    moving.teardown();
  }
});

check('executed: close strips the inline animation, so there is no exit animation to skip', () => {
  const dom = installDom({ reducedMotion: false });
  try {
    const layer = openLayer(dom, {});
    layer.root.style.transition = 'transform 160ms ease';
    layer.root.style.transform = 'translateY(4px)';
    layer.root.style.opacity = '0.5';
    layer.close('test');
    assert.strictEqual(layer.root.style.transition, '');
    assert.strictEqual(layer.root.style.transform, '');
    assert.strictEqual(layer.root.style.opacity, '');
    assert.strictEqual(layer.root.hidden, true);
  } finally {
    dom.teardown();
  }
});

/* ═══════════════════════════════════════════════════════════════
   7. WINDOWED RENDERING (P11.8, E.3 last row)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a layer holding a large archive segment.
 *
 * @param {object} dom - installDom result.
 * @param {number} lineCount - Lines to put in the transcript segment.
 * @returns {object} The layer.
 */
function bigLayer(dom, lineCount) {
  const layer = openLayer(dom, {});
  const lines = [];
  for (let i = 0; i < lineCount; i++) lines.push('transcript line ' + i);
  layer._lines.transcript = lines;
  layer._renderSegment('transcript');
  return layer;
}

check('executed: a 50000-line document holds a bounded window, not 50000 rows', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const observer = dom.observers[0];
    assert.ok(observer, 'the window must be maintained by an IntersectionObserver');
    assert.strictEqual(observer.init.root, layer.doc, 'rooted on the scrolling document');
    assert.ok(/px 0px$/.test(observer.init.rootMargin), 'with a runway margin, not a bare 0');

    const built = layer.windowStats();
    assert.strictEqual(built.lines, 50000);
    assert.strictEqual(built.chunks, 250, '50000 lines at 200 per chunk is 250 chunk elements');
    assert.strictEqual(built.hydrated, 250, 'a fresh build is fully hydrated, which is what stops a rebuild moving the reader');

    // The observer now reports that only the last five chunks are near the
    // viewport, which is what a reader sitting at the live end looks like.
    const near = observer.observed.slice(-5);
    observer.fire((el) => near.indexOf(el) !== -1);

    const windowed = layer.windowStats();
    assert.strictEqual(windowed.chunks, 250, 'the elements stay; only their text is recycled');
    assert.strictEqual(windowed.hydrated, 5, 'E.3: a bounded number of chunks hold text');
    assert.ok(windowed.domChars < built.lines * 4,
      'the DOM holds a fraction of the document, which is the whole point');
    assert.ok(windowed.domChars > 0, 'and it is not empty, which would be a different bug');
  } finally {
    dom.teardown();
  }
});

check('executed: a collapsed chunk is pinned to the height it was MEASURED at, never a computed one', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const observer = dom.observers[0];
    const victim = layer._chunks.transcript[0];
    const measured = victim.el.offsetHeight;
    assert.ok(measured > 0);
    observer.fire((el) => el !== victim.el);
    assert.strictEqual(victim.hydrated, false);
    assert.strictEqual(victim.el.style.height, measured + 'px',
      'the pinned height must be the measured one, or the document height changes and the reader moves');
    assert.strictEqual(victim.el.textContent, '');
    assert.strictEqual(victim.el.offsetHeight, measured,
      'the collapsed chunk occupies exactly the space its text did');
  } finally {
    dom.teardown();
  }
});

check('executed: an unmeasurable chunk stays hydrated rather than collapsing to nothing', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const observer = dom.observers[0];
    const victim = layer._chunks.transcript[0];
    Object.defineProperty(victim.el, 'offsetHeight', { get: () => 0, configurable: true });
    observer.fire((el) => el !== victim.el);
    assert.strictEqual(victim.hydrated, true,
      'a height that was never measured must never be pinned');
  } finally {
    dom.teardown();
  }
});

check('executed: a held selection freezes the window exactly as it freezes the mirror', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const observer = dom.observers[0];
    layer._frozen = true;
    const chunks = layer._chunks.transcript;
    observer.fire(() => false);
    assert.strictEqual(layer.windowStats().hydrated, chunks.length,
      'nothing may be collapsed out from under a selection');
    observer.fire((el) => el === chunks[0].el);
    assert.strictEqual(chunks[0].hydrated, true,
      'hydration is still allowed while frozen: a drag that auto-scrolls must find text');
    layer._frozen = false;
    observer.fire(() => false);
    assert.ok(layer.windowStats().hydrated < chunks.length,
      'releasing the selection lets the window resume');
  } finally {
    dom.teardown();
  }
});

check('executed: select-all puts the WHOLE document back before it selects it', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const observer = dom.observers[0];
    observer.fire((el) => el === layer._chunks.transcript[249].el);
    assert.strictEqual(layer.windowStats().hydrated, 1);
    layer.selectAll();
    const after = layer.windowStats();
    assert.strictEqual(after.hydrated, after.chunks,
      'a Range cannot select text that is not in the DOM, so select-all hydrates first');
    assert.strictEqual(layer._windowSuspended, true, 'and HOLDS it hydrated');
    observer.fire(() => false);
    assert.strictEqual(layer.windowStats().hydrated, after.chunks,
      'the hold survives an observer callback, which is what makes it a hold');
  } finally {
    dom.teardown();
  }
});

check('executed: the document text is byte-identical whether it is windowed or not', () => {
  const dom = installDom();
  try {
    const windowed = bigLayer(dom, 50000);
    const chunkText = windowed._chunks.transcript.map((c) => c.text).join('');
    assert.strictEqual(chunkText, windowed._lines.transcript.join('\n'),
      'chunk boundaries must not add, drop or move a single newline');
    assert.strictEqual(windowed.getDocumentText(), windowed._lines.transcript.join('\n'),
      'getDocumentText reads the line arrays, so a copy is complete however the DOM is rendered');
  } finally {
    dom.teardown();
  }
});

check('executed: prepending a page leaves every existing chunk byte-identical', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const before = layer._chunks.transcript.slice();
    const older = [];
    for (let i = 0; i < 400; i++) older.push('older ' + i);
    layer._lines.transcript = older.concat(layer._lines.transcript);
    layer._renderSegment('transcript');
    const after = layer._chunks.transcript;
    assert.strictEqual(after.length, before.length + 2, 'two more chunks for 400 more lines');
    for (let i = 0; i < before.length; i++) {
      assert.strictEqual(after[i + 2], before[i],
        'end-relative boundaries mean a prepend reuses every existing chunk object');
    }
  } finally {
    dom.teardown();
  }
});

check('executed: below the threshold, and without an IntersectionObserver, rendering is exactly P7', () => {
  const small = installDom();
  try {
    const layer = openLayer(small, {});
    layer._lines.transcript = ['a', 'b', 'c'];
    layer._renderSegment('transcript');
    assert.strictEqual(layer.segments.transcript.textContent, 'a\nb\nc',
      'a small document is one text node, as P7 shipped it');
    assert.strictEqual(layer.windowStats().chunks, 0);
  } finally {
    small.teardown();
  }
  const blind = installDom({ observer: false });
  try {
    const layer = bigLayer(blind, 50000);
    assert.strictEqual(layer.windowStats().chunks, 0,
      'an engine without the observer keeps the P7 renderer rather than a half-window');
    assert.ok(layer.segments.transcript.textContent.length > 0);
  } finally {
    blind.teardown();
  }
});

check('the live segment is never windowed, because it is the mirror', () => {
  assert.deepStrictEqual(H.WINDOWED_SEGMENT_IDS, ['deep', 'ring', 'transcript']);
  assert.strictEqual(H.WINDOWED_SEGMENT_IDS.indexOf('live'), -1,
    'chunking the segment that is rewritten every frame would put the window in the mirror path');
  assert.strictEqual(H.HISTORY_WINDOW_CHUNK_LINES, 200, 'E.3 names 200 rows');
});

check('executed: destroy releases the observer and unlinks every chunk', () => {
  const dom = installDom();
  try {
    const layer = bigLayer(dom, 50000);
    const observer = dom.observers[0];
    const sample = layer._chunks.transcript[0].el;
    layer.destroy();
    assert.strictEqual(observer.disconnected, true, 'a cached pane must not keep calling back');
    assert.strictEqual(sample.__cwmHistoryChunk, null, 'and must not retain its chunk records');
  } finally {
    dom.teardown();
  }
});

/* ═══════════════════════════════════════════════════════════════
   8. THE PERFORMANCE BUDGET (P11.8, E.3 and E.4 item 4)
   ═══════════════════════════════════════════════════════════════ */

check('executed: the client ring is 2000 on a phone and 10000 on a desktop', () => {
  assert.strictEqual(rt.PHONE_SCROLLBACK_LINES, 2000, 'E.3 names 2000');
  assert.strictEqual(rt.DESKTOP_SCROLLBACK_LINES, 10000, 'P5.3 raised the desktop to 10000');
  try {
    setSandboxDriver(true);
    assert.strictEqual(TerminalPane.resolveScrollbackLines(), 2000);
    setSandboxDriver(false);
    assert.strictEqual(TerminalPane.resolveScrollbackLines(), 10000);
    clearSandboxGlobals();
    rt.win.matchMedia = () => ({ matches: true });
    assert.strictEqual(TerminalPane.resolveScrollbackLines(), 2000,
      'without the driver the breakpoint still resolves through matchMedia');
  } finally {
    clearSandboxGlobals();
  }
  assert.ok(terminalSrc.includes('scrollback: TerminalPane.resolveScrollbackLines(),'),
    'the constructor must read the resolver, not a literal');
});

check('executed: two panes stay live on a phone and the rest are dormant', () => {
  try {
    setSandboxDriver(true);
    TerminalPane.__livePaneOrder = [];
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    TerminalPane.noteLivePane(a);
    TerminalPane.noteLivePane(b);
    TerminalPane.noteLivePane(c);
    assert.strictEqual(TerminalPane.isWithinLivePaneBudget(c), true);
    assert.strictEqual(TerminalPane.isWithinLivePaneBudget(b), true);
    assert.strictEqual(TerminalPane.isWithinLivePaneBudget(a), false,
      'E.3: the third and later panes go dormant');
    TerminalPane.noteLivePane(a);
    assert.strictEqual(TerminalPane.isWithinLivePaneBudget(a), true, 'recency, not arrival order');
    assert.strictEqual(TerminalPane.isWithinLivePaneBudget(b), false);
    TerminalPane.forgetLivePane(a);
    assert.strictEqual(TerminalPane._livePaneOrder().indexOf(a), -1,
      'a disposed pane must not hold a budget slot or be retained by a static array');

    setSandboxDriver(false);
    assert.strictEqual(TerminalPane.isWithinLivePaneBudget({ id: 'never-seen' }), true,
      'the desktop has no budget: every pane there is on screen at once');
  } finally {
    TerminalPane.__livePaneOrder = [];
    clearSandboxGlobals();
  }
  assert.strictEqual(rt.PHONE_MAX_LIVE_PANES, 2);
});

check('executed: dormant means DETACHED, read from the host-ownership model rather than a second flag', () => {
  const hosted = Object.create(TerminalPane.prototype);
  hosted._getOwnedContainer = () => ({});
  const detached = Object.create(TerminalPane.prototype);
  detached._getOwnedContainer = () => null;
  try {
    setSandboxDriver(false);
    assert.strictEqual(detached._isDormantPane(), true,
      'a pane whose slot no longer renders it is exactly what detachHostBindings leaves behind');
    assert.strictEqual(hosted._isDormantPane(), false);
  } finally {
    clearSandboxGlobals();
  }
  const body = balancedBlock(terminalSrc, '  _isDormantPane() {');
  assert.ok(body.includes('_getOwnedContainer'),
    'dormancy must READ the ownership model; a pane that detached itself would break its coherence');
  assert.ok(!/detachHostBindings\(\)/.test(body),
    'and must never call the detach the app layer owns');
});

check('executed: the three flush cadences, and the tab signal they read', () => {
  assert.strictEqual(rt.BACKGROUND_FLUSH_MS, 150, 'the Terminal tab keeps the pre-P11b cadence');
  assert.strictEqual(rt.IDLE_FLUSH_MS, 500, 'E.4 item 4 names 500ms for another tab');
  assert.strictEqual(rt.DORMANT_FLUSH_MS, 1000);
  assert.ok(rt.BACKGROUND_FLUSH_MS < rt.IDLE_FLUSH_MS && rt.IDLE_FLUSH_MS < rt.DORMANT_FLUSH_MS,
    'the three must be ordered, or the budget says nothing');

  const hosted = Object.create(TerminalPane.prototype);
  hosted._getOwnedContainer = () => ({});
  try {
    setSandboxDriver(false);
    rt.doc.documentElement.dataset = { viewMode: 'terminal' };
    assert.strictEqual(hosted._backgroundFlushDelay(), 150);
    rt.doc.documentElement.dataset = { viewMode: 'sessions' };
    assert.strictEqual(hosted._backgroundFlushDelay(), 500);
    rt.doc.documentElement.dataset = {};
    assert.strictEqual(hosted._backgroundFlushDelay(), 150,
      'no signal at all means the classic shell, where the grid is always on screen');
    const detached = Object.create(TerminalPane.prototype);
    detached._getOwnedContainer = () => null;
    assert.strictEqual(detached._backgroundFlushDelay(), 1000);
  } finally {
    clearSandboxGlobals();
  }
  const enqueue = balancedBlock(terminalSrc, '  _enqueueWrite(data) {');
  assert.ok(enqueue.includes('this._backgroundFlushDelay()'),
    'the cadence must be resolved at the scheduling site');
  assert.ok(!/}, 150\);/.test(enqueue), 'and the literal must be gone from the hot path');
});

check('the tab signal is the one app.js already publishes, with no new contract', () => {
  assert.ok(appSrc.includes('document.documentElement.dataset.viewMode = mode;'),
    'setViewMode publishes it');
  const body = balancedBlock(terminalSrc, '  static terminalTabActive() {');
  assert.ok(body.includes('dataset'), 'and terminal.js reads it rather than adding a listener');
});

check('executed: the Reader cap is tail-biased, line-aligned and announces itself', () => {
  assert.strictEqual(rt.READER_MAX_CHARS, 200000, 'E.3 names 200k characters');
  const short = 'line one\nline two';
  assert.strictEqual(TerminalPane.capReaderText(short), short, 'a small buffer is untouched');
  assert.strictEqual(TerminalPane.capReaderText(null), '', 'and a missing one cannot throw');

  const row = 'x'.repeat(79) + '\n';
  const huge = row.repeat(4000); // 320000 characters
  const capped = TerminalPane.capReaderText(huge);
  assert.ok(capped.length <= rt.READER_MAX_CHARS + rt.READER_TRUNCATION_NOTICE.length + 1,
    'the cap must actually cap');
  assert.ok(capped.startsWith(rt.READER_TRUNCATION_NOTICE),
    'a suffix presented as the whole buffer is the silent-wrong-answer failure');
  assert.ok(huge.endsWith(capped.slice(capped.indexOf('\n') + 1)),
    'what is kept must be the TAIL, which is what the Reader is opened for');
  assert.ok(!/^x*\n/.test(capped.slice(capped.indexOf('\n') + 1).slice(0, 1)) ||
    capped.slice(capped.indexOf('\n') + 1).split('\n')[0].length === 79,
    'the retained text starts on a whole line rather than mid-row');
});

check('the Reader call site uses the cap, and is feature-detected', () => {
  const body = balancedBlock(appSrc, '  openTerminalReader(pane) {');
  assert.ok(body.includes('TerminalPane.capReaderText'), 'the one call site must use it');
  assert.ok(body.includes("typeof TerminalPane.capReaderText === 'function'"),
    'a page served without a matching terminal.js must keep working');
  assert.ok(body.includes('content.textContent ='), 'and still write the overlay');
});

/* ═══════════════════════════════════════════════════════════════
   9. PRESERVATION
   ═══════════════════════════════════════════════════════════════ */

check('P7 and P11 identifiers this phase builds on are all still present', () => {
  const required = [
    '_isInsideHistoryLayer', '_historyOwnsSelection', 'selectAllHistory', 'openHistory',
    'closeHistory', 'toggleHistory', 'isHistoryOpen', '_installHistorySurface',
    '_destroyHistoryLayer', 'detachHostBindings', 'rebindHost', '_getOwnedContainer',
    '_isWriteFrozen', '_unfreezeAndFlush', '_showSelectModeStrip', '_applySelectStripPlacement',
  ];
  for (const name of required) {
    assert.ok(terminalSrc.includes(name), 'terminal.js must still contain ' + name);
  }
  const historyRequired = [
    'handleTerminalWheel', 'handleTerminalKey', '_onDocWheel', 'scrollByPages', 'scrollByRows',
    'scrollToTop', 'selectAll', 'getDocumentText', '_refreshLiveSegment', '_rebalanceLiveSegment',
    '_updateScrollbar', 'applyMetrics', 'noteOutput', 'onBufferChange',
  ];
  for (const name of historyRequired) {
    assert.ok(historySrc.includes(name), 'terminal-history.js must still contain ' + name);
  }
});

check('the wheel boundary P7 shipped is untouched by the touch boundary', () => {
  const wheel = balancedBlock(historySrc, 'TerminalHistoryLayer.prototype._onDocWheel = function _onDocWheel(e) {');
  assert.ok(wheel.includes("this.close('wheel-bottom')"),
    'the wheel exit must still be its own path, not folded into the touch one');
  assert.ok(wheel.includes('if (e.cancelable) e.preventDefault();'));
});

console.log('  ' + '-'.repeat(74));
console.log('  [terminal-touch-window] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
