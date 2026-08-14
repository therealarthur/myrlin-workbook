#!/usr/bin/env node
/**
 * mobile-touch-model.test.js - the phone's touch contract, executed.
 * Created: 2026-08-13 (Notion restyle phase P11).
 *
 * WHAT IT PROVES
 *
 * MOBILE-EXPERIENCE.md section B is a contract about what a finger does, and
 * three of its clauses are ALGORITHMS rather than markup, so this file RUNS
 * them instead of grepping them:
 *
 *   - The three-zone resolver (B.2). The whole point of replacing the
 *     denylist is that an unclassified surface must resolve to `chrome`,
 *     where nothing happens, rather than to a context sheet that steals a
 *     selection. That is a property of the resolver, not of the markup.
 *   - The priority-plus toolbar fit (B.7). B.7 works an arithmetic example
 *     and concludes "five to six keys on a 390px phone". This measures the
 *     real algorithm against fake boxes at four widths and checks both that
 *     the fitted set never overflows and that the overflowed set is the
 *     LOW-priority tail rather than an arbitrary one.
 *   - The geometry claim gate (B.9 rules 1, 2 and 4). "No `activate` frame is
 *     sent while the Sessions tab is active" is the contract's own done
 *     criterion for P11.6, and it is a boolean function of four conditions.
 *
 * The rest are source gates, because they are BANS and STRUCTURES rather than
 * behaviours: no horizontally scrolling toolbar, no pane-container long press
 * on a phone, one long-press duration everywhere, a notice toast that cannot
 * take a tap, and the Sessions surface A.3.2 asks for.
 *
 * HOW app.js IS LOADED
 *
 * app.js has exactly one module-scope side effect, a `DOMContentLoaded`
 * listener, so a `vm` context with a stub `document` evaluates the whole file
 * and hands back the class without constructing it. Prototype methods are
 * then called against hand-built fakes, which is the same technique
 * copy-secure-context-fallback.test.js uses on terminal.js.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const driverJs = fs.readFileSync(path.join(PUBLIC, 'mobile-viewport.js'), 'utf8');

/**
 * Strip JS comments so a ban on a construct is never satisfied, or defeated,
 * by the comment that explains it. Every comment in this phase's code
 * deliberately NAMES what it replaced.
 *
 * @param {string} js - Raw source.
 * @returns {string} Source without comments.
 */
function stripJsComments(js) {
  // LINE COMMENTS FIRST, and that order is load-bearing rather than a style
  // choice. app.js contains a line comment reading "(MIME /* types to avoid
  // conflicts)", and a block-comment pass that runs first treats that `/*` as
  // the start of a comment and swallows the next twenty thousand characters
  // of real code, silently, up to the next `*/`. Anything asserted inside
  // that region then passes or fails for the wrong reason. The `[^:]` guard
  // is what keeps `https://` inside a string from being eaten by the line
  // pass.
  return js.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Strip CSS block comments, for the same reason.
 *
 * @param {string} css - Raw stylesheet.
 * @returns {string} Stylesheet without comments.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const appCode = stripJsComments(appJs);
const stylesMobile = stripCssComments(
  fs.readFileSync(path.join(PUBLIC, 'styles-mobile.css'), 'utf8')
);

let passed = 0;
let failed = 0;

/**
 * Run one named assertion block and record its outcome.
 *
 * @param {string} name - Check name.
 * @param {Function} fn - Body; throws to fail.
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
    console.log('       ' + err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   LOADING THE CLASS
   ═══════════════════════════════════════════════════════════════ */

/**
 * Evaluate app.js in a vm and return the class.
 *
 * Nothing in the file runs at module scope except one listener registration,
 * so the stub only has to be complete enough for THAT. The viewport driver is
 * loaded into the same context first, because the touch model reads its
 * constant table and the point of this test is to prove the two agree.
 *
 * @returns {{CWMApp: Function, sandbox: Object}} The class and its context.
 */
function loadApp() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: {
      _v: new Map(),
      getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
      setItem(k, v) { this._v.set(k, String(v)); },
      removeItem(k) { this._v.delete(k); },
    },
    navigator: { vibrate() { return true; }, maxTouchPoints: 5 },
    document: {
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      documentElement: { dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } },
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      visibilityState: 'visible',
    },
    WebSocket: function WebSocketStub() {},
    EventSource: function EventSourceStub() {},
    // app.js installs a boot-failure recovery handler at module scope, which
    // is the one thing besides the DOMContentLoaded listener that runs on
    // load. Both are satisfied by a listener registry that records nothing.
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    fetch() { return Promise.resolve({ json: () => Promise.resolve({}) }); },
    matchMedia() {
      return { matches: false, addEventListener() {}, addListener() {} };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.WebSocket.OPEN = 1;
  const context = vm.createContext(sandbox);
  vm.runInContext(driverJs, context, { filename: 'mobile-viewport.js' });
  vm.runInContext(appJs, context, { filename: 'app.js' });
  const CWMApp = vm.runInContext('CWMApp', context);
  assert.strictEqual(typeof CWMApp, 'function', 'CWMApp did not evaluate in the sandbox');
  // The boot watchdog fires five seconds later and dispatches an ErrorEvent
  // this realm does not have. Nothing is being booted here, so it is cleared
  // rather than stubbed.
  clearTimeout(sandbox.__cwmInitTimeout);
  return { CWMApp, sandbox };
}

/**
 * Find a method body by its DEFINITION rather than by its first mention.
 *
 * `indexOf('name(')` finds the call site when the caller is defined earlier in
 * the file, which silently slices the wrong region and turns a real assertion
 * into a false negative.
 *
 * @param {string} src - Source text.
 * @param {string} name - Method name.
 * @param {number} [span] - How much to return.
 * @returns {string} The slice starting at the definition.
 */
function methodSlice(src, name, span) {
  const at = src.search(new RegExp('\\n  (?:async )?' + name + '\\s*\\('));
  assert.ok(at !== -1, 'method not found: ' + name);
  return src.slice(at, at + (span || 2500));
}

const { CWMApp, sandbox } = loadApp();

/* ═══════════════════════════════════════════════════════════════
   A TINY DOM, ENOUGH FOR closest()
   ═══════════════════════════════════════════════════════════════ */

/**
 * Match one element against one simple selector.
 *
 * Supports exactly the four forms the zone model's selectors use: a tag name,
 * a class, an attribute presence and an attribute value. Anything else is a
 * test-harness bug rather than a silent false negative, so it throws.
 *
 * @param {Object} el - Fake element.
 * @param {string} sel - One simple selector.
 * @returns {boolean} Whether it matches.
 */
function matchesSimple(el, sel) {
  const s = sel.trim();
  if (!s) return false;
  if (s.startsWith('.')) return el.classes.includes(s.slice(1));
  if (s.startsWith('[')) {
    const eq = s.indexOf('=');
    if (eq === -1) return Object.prototype.hasOwnProperty.call(el.attrs, s.slice(1, -1));
    const name = s.slice(1, eq);
    const value = s.slice(eq + 1, -1).replace(/^["']|["']$/g, '');
    return el.attrs[name] === value;
  }
  if (/^[a-z][a-z0-9-]*$/i.test(s)) return el.tag === s;
  throw new Error('harness cannot match selector: ' + s);
}

/**
 * Build a fake element with a working `closest`.
 *
 * @param {Object} spec - { tag, classes, attrs, parent }.
 * @returns {Object} The fake element.
 */
function el(spec) {
  const node = {
    tag: spec.tag || 'div',
    classes: spec.classes || [],
    attrs: spec.attrs || {},
    parent: spec.parent || null,
    isConnected: true,
  };
  node.dataset = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      node.dataset[camel] = v;
    }
  }
  node.contains = (other) => {
    let cur = other;
    while (cur) {
      if (cur === node) return true;
      cur = cur.parent;
    }
    return false;
  };
  node.closest = (selectorList) => {
    const parts = selectorList.split(',');
    let cur = node;
    while (cur) {
      for (const part of parts) {
        if (matchesSimple(cur, part)) return cur;
      }
      cur = cur.parent;
    }
    return null;
  };
  return node;
}

/**
 * A bare instance with no constructor run, so prototype methods can be
 * exercised against explicit state rather than against a booted application.
 *
 * @param {Object} state - Properties to graft on.
 * @returns {Object} The stand-in.
 */
function instance(state) {
  const app = Object.create(CWMApp.prototype);
  Object.assign(app, state || {});
  return app;
}

console.log('\n  Notion restyle P11: the phone touch model');
console.log('  ' + '-'.repeat(58));

/* ═══════════════════════════════════════════════════════════════
   B.2 THE THREE ZONES, EXECUTED
   ═══════════════════════════════════════════════════════════════ */

check('the resolver answers exactly the three zone names', () => {
  assert.strictEqual(CWMApp.MW_ZONES.join(','), 'text,affordance,chrome');
});

check('an unclassified surface resolves to chrome, where nothing happens', () => {
  const app = instance({});
  const stray = el({ tag: 'div', classes: ['some-new-surface'] });
  assert.strictEqual(app._mwZoneOf(stray), 'chrome',
    'the allowlist must fail CLOSED: an unclassified surface gets no sheet');
});

check('a declared affordance resolves to affordance', () => {
  const app = instance({});
  const row = el({ tag: 'tr', classes: ['session-item'], attrs: { 'data-mw-zone': 'affordance' } });
  const span = el({ tag: 'span', classes: ['session-name'], parent: row });
  assert.strictEqual(app._mwZoneOf(span), 'affordance');
});

check('the xterm screen is a text zone with no attribute on it', () => {
  const app = instance({});
  const grid = el({ tag: 'div', classes: ['terminal-grid'], attrs: { 'data-mw-zone': 'chrome' } });
  const pane = el({ tag: 'div', classes: ['terminal-pane'], parent: grid });
  const screen = el({ tag: 'div', classes: ['xterm-screen'], parent: pane });
  assert.strictEqual(app._mwZoneOf(screen), 'text',
    'a surface another track authors is matched structurally, not by attribute');
});

check('the future scrollback-history surface is a text zone before it exists', () => {
  const app = instance({});
  const history = el({ tag: 'div', classes: ['terminal-history'] });
  assert.strictEqual(app._mwZoneOf(history), 'text',
    'B.4 rule 3: history must never have a context sheet bound to it');
});

check('a text zone NESTED in an affordance keeps its selection', () => {
  const app = instance({});
  const card = el({ tag: 'div', classes: ['peek-card'], attrs: { 'data-mw-zone': 'affordance' } });
  const notes = el({ tag: 'textarea', classes: ['peek-notes'], parent: card });
  assert.strictEqual(app._mwZoneOf(notes), 'text',
    'the NEAREST declaration wins, or a notes field inside a card loses selection');
});

check('the pane container is chrome, which is the reported defect fixed', () => {
  const app = instance({});
  const grid = el({ tag: 'div', classes: ['terminal-grid'], attrs: { 'data-mw-zone': 'chrome' } });
  const pane = el({ tag: 'div', classes: ['terminal-pane'], parent: grid });
  const toolbarBg = el({ tag: 'div', classes: ['terminal-mobile-toolbar'], attrs: { 'data-mw-zone': 'chrome' }, parent: pane });
  assert.strictEqual(app._mwZoneOf(pane), 'chrome');
  assert.strictEqual(app._mwZoneOf(toolbarBg), 'chrome',
    'the gap between toolbar keys must not arm the pane action sheet');
});

check('a toolbar key inside the chrome strip is still an affordance', () => {
  const app = instance({});
  const toolbar = el({ tag: 'div', classes: ['terminal-mobile-toolbar'], attrs: { 'data-mw-zone': 'chrome' } });
  const key = el({ tag: 'button', attrs: { 'data-mw-zone': 'affordance', 'data-key': 'ctrlc' }, parent: toolbar });
  assert.strictEqual(app._mwZoneOf(key), 'affordance');
});

check('an unknown zone value degrades to chrome rather than inventing a zone', () => {
  const app = instance({});
  const weird = el({ tag: 'div', attrs: { 'data-mw-zone': 'sometimes' } });
  assert.strictEqual(app._mwZoneOf(weird), 'chrome');
});

/* ═══════════════════════════════════════════════════════════════
   B.2 ONE TIMING CONSTANT
   ═══════════════════════════════════════════════════════════════ */

check('every long-press duration comes from the viewport driver table', () => {
  const c = CWMApp.mwConstants();
  assert.strictEqual(c.MW_LONGPRESS_MS, 400, 'one duration, and it is terminal.js\'s 400ms');
  assert.strictEqual(c.MW_LONGPRESS_MOVE_PX, 8);
  assert.strictEqual(c.MW_LONGPRESS_HAPTIC_MS, 25);
  assert.strictEqual(
    c, sandbox.MyrlinMobileViewport.constants,
    'the table must be the published one, not a copy that can drift'
  );
});

check('the fallback table matches the driver, so a missing driver changes nothing', () => {
  const published = sandbox.MyrlinMobileViewport.constants;
  for (const [key, value] of Object.entries(CWMApp.MW_FALLBACK_CONSTANTS)) {
    assert.strictEqual(published[key], value, key + ' drifted from the driver');
  }
});

check('no long-press site carries a duration literal any more', () => {
  // The four legacy sites ran at 500ms and the pane at 600ms while xterm ran
  // at 400ms. Three durations on adjacent elements is what makes a gesture
  // feel unreliable, so every site now reads the one constant. Scoped to the
  // long-press timers by name: this file has other 500ms timers (a restart
  // delay, a poll) and they are not gestures.
  const timers = ['wsLPTimer', 'sessLPTimer', 'projLPTimer', 'tabLPTimer'];
  for (const name of timers) {
    const arms = appCode.match(new RegExp(name + ' = setTimeout\\([\\s\\S]*?\\}, [^)]+\\)', 'g')) || [];
    assert.ok(arms.length > 0, name + ' has no arming site');
    for (const arm of arms) {
      assert.ok(!/\}, \d+\)/.test(arm), name + ' still arms on a literal: ' + arm.slice(-40));
    }
  }
  assert.ok(!/}, 600\);/.test(appCode), 'the 600ms pane long-press timer survives');
  const armSites = appCode.match(/MW_LONGPRESS_MS/g) || [];
  assert.ok(armSites.length >= 5,
    'every long-press site must read the published duration, found ' + armSites.length);
});

check('the pane container no longer arms a long press on a phone', () => {
  const paneBind = appCode.slice(appCode.indexOf('TERMINAL_SURFACE_SELECTOR ='));
  assert.ok(/if \(this\.isPhone\) return;/.test(paneBind.slice(0, 1200)),
    'the phone must not reach the timer at all');
  assert.ok(/_mwZoneOf\(e\.target\) === 'text'/.test(paneBind.slice(0, 1200)),
    'above the breakpoint the zone model, not the denylist, decides');
  // The listener is RETAINED for a tablet or desktop touchscreen, which has
  // no right-click and no other route to the pane menu.
  assert.ok(/pane\.addEventListener\('touchstart'/.test(appCode),
    'the non-phone pane long press must be retained, not deleted');
});

check('the pane sheet has two affordance hosts, per B.2', () => {
  assert.ok(/data-mw-route="pane-overflow"/.test(appCode), 'the pinned chip host');
  assert.ok(
    /_mwBindLongPress\(this\.els\.terminalTabStrip[\s\S]{0,400}showMobilePaneOverflow/.test(appCode),
    'the chip long-press host'
  );
});

/* ═══════════════════════════════════════════════════════════════
   B.7 THE PRIORITY-PLUS TOOLBAR, EXECUTED
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a fake toolbar whose keys have the widths B.7's worked example uses.
 *
 * @param {number} width - Toolbar client width.
 * @returns {Object} { toolbar, app, widths }.
 */
function makeToolbar(width) {
  const widths = {
    enter: 56, ctrlc: 58, escape: 44, up: 44, down: 44, tab: 44, copy: 44,
    ctrld: 52, select: 60, copyview: 74, reader: 58,
  };
  const buttons = Object.keys(widths).map((key) => ({
    dataset: { key },
    offsetWidth: widths[key],
    hidden: false,
    classList: { contains: () => false },
  }));
  const overflow = { offsetWidth: 44, hidden: false, classList: { contains: () => true } };
  const toolbar = {
    clientWidth: width,
    querySelector: (sel) => (sel === '.toolbar-overflow' ? overflow : null),
    querySelectorAll: (sel) => (sel === '[data-key]' ? buttons : []),
  };
  const app = instance({});
  // getComputedStyle is the one browser API the algorithm reads.
  sandbox.getComputedStyle = (node) => {
    if (node === toolbar) return { paddingLeft: '8px', paddingRight: '8px', columnGap: '4px' };
    return { display: 'flex' };
  };
  return { toolbar, app, widths, buttons, overflow };
}

check('at 390px the fit is five to six keys plus the pinned overflow', () => {
  const { toolbar, app } = makeToolbar(390);
  const out = app._fitToolbar(toolbar, 390);
  assert.ok(out.fitted.length >= 5 && out.fitted.length <= 6,
    'B.7: the honest count at 390px is five to six, got ' + out.fitted.length +
    ' (' + out.fitted.join(',') + ')');
  assert.ok(out.overflowed.length > 0, 'the rest must go to the sheet, not off the edge');
});

check('the fitted set never exceeds the budget, so nothing scrolls', () => {
  for (const width of [360, 375, 390, 430]) {
    const { toolbar, app, widths } = makeToolbar(width);
    const out = app._fitToolbar(toolbar, width);
    const gap = 4;
    const used = out.fitted.reduce((sum, key, i) => sum + widths[key] + (i ? gap : 0), 0);
    assert.ok(used <= out.budget,
      'at ' + width + 'px the fitted keys total ' + used + ' over a budget of ' + out.budget);
  }
});

check('a wider phone fits more keys, and never fewer', () => {
  const narrow = makeToolbar(360);
  const wide = makeToolbar(430);
  const a = narrow.app._fitToolbar(narrow.toolbar, 360).fitted.length;
  const b = wide.app._fitToolbar(wide.toolbar, 430).fitted.length;
  assert.ok(b >= a, 'a 430px phone fitted ' + b + ' against a 360px phone\'s ' + a);
});

check('the overflow is the LOW-priority tail, never an arbitrary set', () => {
  const { toolbar, app } = makeToolbar(390);
  const out = app._fitToolbar(toolbar, 390);
  const rank = (key) => CWMApp.MW_TOOLBAR_PRIORITY.indexOf(key);
  const worstFitted = Math.max(...out.fitted.map(rank));
  const bestOverflowed = Math.min(...out.overflowed.map(rank));
  assert.ok(worstFitted < bestOverflowed,
    'a key was overflowed while a lower-priority one was kept');
  assert.strictEqual(out.fitted[0], 'enter', 'Enter is priority 0 and always fits');
});

check('an overflowed key is hidden rather than removed', () => {
  const { toolbar, app, buttons } = makeToolbar(390);
  const out = app._fitToolbar(toolbar, 390);
  for (const key of out.overflowed) {
    const btn = buttons.find(b => b.dataset.key === key);
    assert.strictEqual(btn.hidden, true, key + ' must be hidden, so its handler survives');
  }
});

check('a re-fit at a wider width restores a previously overflowed key', () => {
  const shared = makeToolbar(360);
  shared.app._fitToolbar(shared.toolbar, 360);
  const after = shared.app._fitToolbar(shared.toolbar, 430);
  assert.ok(after.fitted.length >= 5,
    'the pass must un-hide before it measures, or hidden keys never come back');
});

check('the pinned control is excluded from the budget before any key is measured', () => {
  const { toolbar, app } = makeToolbar(390);
  const out = app._fitToolbar(toolbar, 390);
  assert.strictEqual(out.budget, 390 - 16 - 44 - 4,
    'budget = width minus padding minus the pinned control minus one gap');
});

check('the toolbar cannot scroll horizontally at any phone width', () => {
  assert.ok(/\.terminal-mobile-toolbar\s*\{[^}]*overflow-x:\s*hidden/s.test(stylesMobile),
    'the strip must overflow into the sheet, never scroll');
  assert.ok(/\.terminal-mobile-toolbar\s*button\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s.test(stylesMobile),
    'the hidden guard must be paired with the display rule (DO-NOT-BREAK rule 3)');
});

check('the pinned overflow control is sticky and at the touch floor', () => {
  assert.ok(
    /\.terminal-mobile-toolbar \.toolbar-overflow\s*\{[^}]*position:\s*sticky[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s
      .test(stylesMobile),
    'B.7 step 4: sticky, opaque, and a legal target'
  );
});

check('an overflowed key routes through the identical click handler', () => {
  assert.ok(/action: \(\) => btn\.click\(\)/.test(appCode),
    'the sheet row must click the real button, not re-implement the key');
});

/* ═══════════════════════════════════════════════════════════════
   B.9 THE CLAIM GATE, EXECUTED
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build an app stand-in for the claim gate with an explicit world.
 *
 * @param {Object} world - { visible, viewMode, phone, suppressedUntil, unfollowed }.
 * @returns {Object} The stand-in.
 */
function claimApp(world) {
  const app = instance({
    state: { viewMode: world.viewMode || 'terminal' },
    _claimSuppressedUntil: world.suppressedUntil || 0,
    _followDevice: new Set(world.unfollowed || []),
  });
  Object.defineProperty(app, 'isPhone', { get: () => world.phone !== false });
  sandbox.document.visibilityState = world.visible === false ? 'hidden' : 'visible';
  return app;
}

check('a foreground phone on the Terminal tab may claim', () => {
  assert.strictEqual(claimApp({}).canClaimGeometry('s1'), true);
});

check('NO claim while the Sessions tab is the active surface', () => {
  // BUILD-CONTRACT P11.6's done criterion, verbatim.
  assert.strictEqual(claimApp({ viewMode: 'workspace' }).canClaimGeometry('s1'), false);
});

check('no claim from a backgrounded document', () => {
  assert.strictEqual(claimApp({ visible: false }).canClaimGeometry('s1'), false);
  sandbox.document.visibilityState = 'visible';
});

check('no claim while the keyboard is settling', () => {
  const app = claimApp({ suppressedUntil: Date.now() + 5000 });
  assert.strictEqual(app.canClaimGeometry('s1'), false);
});

check('the suppression window closes on its own', () => {
  const app = claimApp({ suppressedUntil: Date.now() - 1 });
  assert.strictEqual(app.canClaimGeometry('s1'), true);
});

check('a session pinned to another device never claims', () => {
  const app = claimApp({ unfollowed: ['s1'] });
  assert.strictEqual(app.canClaimGeometry('s1'), false, 'Follow this device is OFF for s1');
  assert.strictEqual(app.canClaimGeometry('s2'), true, 'and only for s1');
});

check('Follow this device defaults to ON, so single-client use is unchanged', () => {
  const app = instance({ _followDevice: null });
  sandbox.localStorage._v.clear();
  assert.strictEqual(app.followsThisDevice('anything'), true);
});

check('a desktop is not gated by the phone tab rule', () => {
  const app = claimApp({ phone: false, viewMode: 'workspace' });
  assert.strictEqual(app.canClaimGeometry('s1'), true,
    'the tab rule is a PHONE rule; a desktop has no bottom tab bar');
});

check('the ambient claim path consults the gate; an explicit take-over does not', () => {
  assert.ok(/_activateActiveTerminalPane\(\)\s*\{[\s\S]{0,900}?canClaimGeometry\(tp\.sessionId\)/.test(appCode),
    'the visibility and focus path must be gated');
  assert.ok(/take over[\s\S]{0,600}?pane\.activate\(\)/.test(appJs),
    'the width notice must claim unconditionally when the user asks');
});

check('the gate is published for the pane layer to consult', () => {
  assert.ok(/window\.MyrlinClaimGate = \{/.test(appCode));
  assert.ok(/canClaim:/.test(appCode) && /follows:/.test(appCode) && /suppress:/.test(appCode));
});

/* ═══════════════════════════════════════════════════════════════
   B.5 THE TOAST CONTRACT
   ═══════════════════════════════════════════════════════════════ */

check('a toast with no action is a notice, by class and by rule', () => {
  assert.ok(/toast-notice/.test(appCode), 'showToast must mark the notice case');
  assert.ok(/\.toast-notice,\s*\.toast:not\(:has\(\.toast-action\)\)\s*\{[^}]*pointer-events:\s*none/s
    .test(stylesMobile), 'both the class and the :has() form must be authored');
});

check('the class comes first, because :has() is not universal on older WebKit', () => {
  const idx = stylesMobile.indexOf('.toast-notice,');
  const has = stylesMobile.indexOf('.toast:not(:has(.toast-action))');
  assert.ok(idx !== -1 && has > idx, 'the guaranteed fallback must lead the selector list');
});

check('only the action inside a toast takes a tap, and at the floor', () => {
  assert.ok(/\.toast \.toast-action\s*\{[^}]*pointer-events:\s*auto[^}]*min-height:\s*44px/s
    .test(stylesMobile));
});

check('toast durations follow B.5 rule 3, and the 60-second toast is gone', () => {
  assert.strictEqual(CWMApp.TOAST_DURATION_MS, 3500);
  assert.strictEqual(CWMApp.TOAST_DURATION_LOUD_MS, 6000);
  assert.ok(!/setTimeout\(\(\) => this\.dismissToast\(toast\), 60000\)/.test(appCode),
    'the flat 60-second lifetime must be gone');
  assert.ok(/action\s*\?\s*0/.test(appCode),
    'a toast carrying an action is indefinite, or the action can vanish first');
});

check('at most two toasts are visible on a phone, oldest evicted', () => {
  assert.strictEqual(CWMApp.TOAST_MAX_VISIBLE_PHONE, 2);
  assert.ok(/TOAST_MAX_VISIBLE_PHONE[\s\S]{0,200}dismissToast\(live\.shift\(\)\)/.test(appCode));
});

/* ═══════════════════════════════════════════════════════════════
   B.3 AND B.8, THE GESTURE BUDGET
   ═══════════════════════════════════════════════════════════════ */

check('no floating action button survives on a phone (B.6, P11.3)', () => {
  // Both are `position: absolute; bottom: 12px` over the toolbar and the
  // input row, both are 32px, and both are opacity 0 until a hover a phone
  // never delivers. The upload FAB was already suppressed; the schedule FAB
  // was not, and its own comment in styles.css said so out loud.
  assert.ok(/\.terminal-pane-schedule\s*\{[^}]*display:\s*none\s*!important/s.test(stylesMobile),
    'the schedule FAB must be display:none at phone widths');
  // The upload FAB's own suppression lives in styles.css, where it has been
  // since before the restyle. It is asserted from there rather than moved,
  // because moving another track's rule to satisfy this test would be the
  // collision BUILD-CONTRACT 4.1 item 4 exists to prevent.
  const stylesCss = stripCssComments(
    fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8')
  );
  assert.ok(/@media \(max-width: 768px\)[\s\S]{0,400}\.terminal-pane-upload \{ display: none; \}/
    .test(stylesCss), 'the upload FAB must stay suppressed at phone widths');
  assert.ok(/'Scheduled messages'/.test(appCode) || /Scheduled messages \(/.test(appCode),
    'its capability must survive in the pane overflow sheet, with its count');
});

check('the pane swipe reads the published travel and edge thresholds', () => {
  assert.ok(/Math\.abs\(dx\) < c\.MW_SWIPE_MIN_PX/.test(appCode), '96px travel');
  assert.ok(/startX < c\.MW_SWIPE_EDGE_PX/.test(appCode), 'left edge excluded');
  assert.ok(/startX > \(window\.innerWidth - c\.MW_SWIPE_EDGE_PX\)/.test(appCode),
    'the right edge is the Android back gesture and must be excluded too');
  assert.ok(!/Math\.abs\(dx\) < 80/.test(appCode), 'the old 80px threshold must be gone');
});

check('the pane swipe is inert while a selection or a text mode is live', () => {
  assert.ok(/_paneSwipeInert\(/.test(appCode));
  const body = appCode.slice(appCode.indexOf('_paneSwipeInert(pane)'));
  assert.ok(/_selectMode/.test(body.slice(0, 900)), 'Select mode');
  assert.ok(/_copyOverlayOpen/.test(body.slice(0, 900)), 'the Copy view');
  assert.ok(/hasSelection/.test(body.slice(0, 900)), 'a live xterm selection');
  assert.ok(/getSelection/.test(body.slice(0, 1400)), 'a native DOM selection');
});

check('the swipe is re-checked on release, not only on press', () => {
  assert.ok(/const activeAtEnd[\s\S]{0,200}_paneSwipeInert\(activeAtEnd\)/.test(appCode));
});

check('drag and drop is off on a phone and says so in one attribute', () => {
  assert.ok(/dataset\.mwDnd = state/.test(appCode));
  assert.ok(/this\.isPhone \? 'off' : 'on'/.test(appCode));
  assert.ok(/const draggable = this\.isPhone \? 'false' : 'true'/.test(appCode),
    'a phone row must not advertise a drag the shell will not honour');
});

check('the edge-swipe drawer is retired on a phone only', () => {
  assert.ok(/if \(dx > 0 && startX < 30 && !this\.state\.sidebarOpen\) \{\s*\n\s*if \(this\.isPhone\) return;/
    .test(appCode), 'B.1 rule R2: no app gesture starts in the OS back zone');
});

/* ═══════════════════════════════════════════════════════════════
   A.3.2 THE SESSIONS TAB SURFACE
   ═══════════════════════════════════════════════════════════════ */

check('the four filter pills exist, and Needs input reads the attention queue', () => {
  // Joined rather than deep-compared: the array is built inside the vm realm,
  // so its prototype is not this realm's Array and deepStrictEqual refuses.
  assert.strictEqual(
    CWMApp.MOBILE_SESSION_FILTERS.map(f => f.id).join(','),
    'all,running,needs-input,stopped'
  );
  assert.ok(/_getAttentionQueue\(\)\.filter\(item => item\.actionable\)/.test(
    methodSlice(appCode, 'applyMobileSessionFilter')
  ), 'needs input is a live pane state, not a stored status');
});

check('the filter is a no-op above the phone breakpoint', () => {
  const app = instance({ _mobileSessionFilter: 'running' });
  Object.defineProperty(app, 'isPhone', { get: () => false });
  const rows = [{ id: 'a', status: 'running' }, { id: 'b', status: 'stopped' }];
  assert.strictEqual(app.applyMobileSessionFilter(rows).length, 2,
    'a filter chosen on a phone must never hide rows from a desktop');
});

check('the filter actually filters on a phone', () => {
  const app = instance({ _mobileSessionFilter: 'running' });
  Object.defineProperty(app, 'isPhone', { get: () => true });
  const rows = [{ id: 'a', status: 'running' }, { id: 'b', status: 'stopped' }];
  assert.deepStrictEqual(app.applyMobileSessionFilter(rows).map(r => r.id), ['a']);
});

check('bulk select, its action bar and its stop path exist', () => {
  assert.ok(/setMobileSessionSelectMode\(on\)/.test(appCode));
  assert.ok(/toggleMobileSelectAll\(\)/.test(appCode));
  assert.ok(/stopMobileSelectedSessions\(\)/.test(appCode));
  assert.ok(/mobile-select-bar/.test(appCode), 'the bottom action bar');
  assert.ok(/\.mobile-select-bar\s*\{[^}]*bottom:\s*calc\(var\(--mw-tabbar-h\)/s.test(stylesMobile),
    'the bar must clear the tab bar, never cover the Attention badge');
});

check('the header overflow carries Select and Restart all', () => {
  const body = methodSlice(appCode, 'showMobileSessionsOverflow');
  assert.ok(/'Done selecting' : 'Select'/.test(body), 'the Select toggle');
  assert.ok(/label: 'Restart all sessions'/.test(body));
  assert.ok(/danger: true/.test(body), 'Restart all is the danger group');
  assert.ok(/label: 'Discover sessions'/.test(body), 'A.3.1 keeps a phone route');
});

check('a row swipe REVEALS and never performs', () => {
  assert.strictEqual(CWMApp.MW_SWIPE_REVEAL_PX, 72, 'B.3: threshold 72px');
  assert.ok(/_runMobileSwipeAction\(btn\.dataset\.swipeAction/.test(appCode),
    'the revealed BUTTON acts; the gesture only reveals');
  assert.ok(!/dx.*>.*threshold[\s\S]{0,120}deleteSession/.test(appCode),
    'there must be no swipe-past-threshold destructive branch');
});

check('the row tap opens the session in the pane the phone is showing', () => {
  assert.ok(/openSessionInCurrentPane\(id, opts = \{\}\)/.test(appCode));
  assert.ok(/if \(this\.isPhone\) \{[\s\S]{0,300}openSessionInCurrentPane\(item\.dataset\.id\)/.test(appCode));
});

check('Stop all stops, and Restart all keeps its own separate route', () => {
  assert.ok(/async stopAllSessions\(\)/.test(appCode), 'the method the label promises');
  const attention = methodSlice(appCode, 'buildMobileAttentionOverflowItems', 1200);
  assert.ok(/label: 'Stop all', danger: true, action: \(\) => this\.stopAllSessions\(\)/
    .test(attention),
    'the Attention overflow must stop, not restart');
  assert.ok(/label: 'Restart all sessions'/.test(appCode),
    'restartAllSessions keeps its own truthfully labelled route');
});

/* ═══════════════════════════════════════════════════════════════
   B.9 RULE 5, THE NOTICE
   ═══════════════════════════════════════════════════════════════ */

check('the width notice fires at the contract ratio and explains itself', () => {
  assert.strictEqual(CWMApp.MW_WIDTH_NOTICE_RATIO, 1.2);
  // Written across two source lines, so both halves are asserted rather than
  // the concatenation a reader sees.
  assert.ok(/Another device is setting the width\./.test(appJs) &&
    /Tap to take over\./.test(appJs),
    'the notice copy is the contract\'s, verbatim');
  assert.ok(/applied <= mine \* CWMApp\.MW_WIDTH_NOTICE_RATIO/.test(appCode));
});

check('the notice reads the applied width rather than assuming its own fit', () => {
  assert.ok(/proposeDimensions\(\)/.test(appCode),
    'the renderer must never assume term.cols equals its own fit result');
});

check('Follow this device is reachable from the pane overflow sheet', () => {
  assert.ok(/label: 'Follow this device'/.test(appCode));
  assert.ok(/toggleFollowThisDevice\(pane\.sessionId\)/.test(appCode));
});

/* ═══════════════════════════════════════════════════════════════
   THE ZONE DECLARATIONS IN THE MARKUP
   ═══════════════════════════════════════════════════════════════ */

check('the pane grid, the toolbars and the input rows declare their zone', () => {
  assert.ok(/id="terminal-grid"[^>]*data-mw-zone="chrome"/.test(html));
  const toolbars = html.match(/class="terminal-mobile-toolbar" data-mw-zone="chrome"/g) || [];
  assert.strictEqual(toolbars.length, 6, 'all six pane templates, found ' + toolbars.length);
  const rows = html.match(/class="terminal-mobile-input-row" data-mw-zone="chrome"/g) || [];
  assert.strictEqual(rows.length, 6, 'all six input rows, found ' + rows.length);
});

check('the affordance and text zones carry their CSS at every width', () => {
  assert.ok(/\[data-mw-zone="affordance"\],\s*\[data-mw-zone="chrome"\]\s*\{[^}]*user-select:\s*none/s
    .test(stylesMobile), 'no stray callout on a control');
  assert.ok(/\[data-mw-zone="text"\]\s*\{[^}]*user-select:\s*text/s.test(stylesMobile),
    'a text zone must never inherit the affordance rule');
});

console.log('  ' + '-'.repeat(58));
console.log('  [mobile-touch-model] ' + passed + '/' + (passed + failed) + ' tests passed');
if (failed > 0) process.exitCode = 1;
