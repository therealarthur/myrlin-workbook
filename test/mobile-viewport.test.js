#!/usr/bin/env node
/**
 * mobile-viewport.test.js - the phone viewport driver, executed.
 * Created: 2026-08-13 (Notion restyle phase P10, work package P10.3).
 *
 * WHAT IT PROVES
 *
 * MOBILE-EXPERIENCE.md C.1 names three defects in the code this driver
 * replaces, and BUILD-CONTRACT P10.3 turns them into done criteria. Two of the
 * three are behavioural and cannot be proved by reading source, so this file
 * RUNS mobile-viewport.js against a fake viewport rather than grepping it:
 *
 *   - Exactly ONE settle notification per burst of viewport events. The
 *     criterion is "exactly one resize frame is sent to the stub PTY per
 *     keyboard open-and-close cycle, not three", and the settle subscriber is
 *     where that frame originates: every applied resize is a full ConPTY
 *     repaint on every attached client.
 *   - The keyboard class toggles on a measured INSET, never on a ratio against
 *     `window.screen.height`. The fake window's `screen` property throws if it
 *     is read at all, so a regression cannot pass silently.
 *   - No `transform` is ever written. A transform on an ancestor creates a
 *     containing block for every `position: fixed` descendant, which in this
 *     app is the action sheet, the account sheet backdrop, every modal and the
 *     toast container.
 *
 * The remaining checks are source-level, because they are bans rather than
 * behaviours: the deleted `position: fixed` body rule, the eliminated `100vh`,
 * and the meta-viewport token pair.
 *
 * HOW THE FAKE DOM WORKS
 *
 * mobile-viewport.js is a plain IIFE over one `global` argument, so a `vm`
 * context whose `window` points at itself is enough to run it exactly as a
 * browser would, with no jsdom dependency and no network.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const DRIVER_PATH = path.join(PUBLIC, 'mobile-viewport.js');
const driverSrc = fs.readFileSync(DRIVER_PATH, 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

/**
 * Strip CSS block comments so a property assertion never matches prose inside
 * a comment. The comments in this stylesheet deliberately NAME the values they
 * ban, which is exactly the string a naive grep would find.
 *
 * @param {string} css - Raw stylesheet text.
 * @returns {string} Stylesheet with block comments removed.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const stylesMobile = stripCssComments(
  fs.readFileSync(path.join(PUBLIC, 'styles-mobile.css'), 'utf8')
);

/**
 * Strip JS block and line comments.
 *
 * Every ban below is a ban on CODE, and the comments in these files
 * deliberately NAME the construct they replaced, which is exactly the string
 * a naive grep would find. Without this the documentation would fail the test
 * that the documentation exists to explain.
 *
 * @param {string} js - Raw JavaScript source.
 * @returns {string} Source with comments removed.
 */
function stripJsComments(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Strip HTML comments, for the same reason.
 *
 * @param {string} markup - Raw markup.
 * @returns {string} Markup with comments removed.
 */
function stripHtmlComments(markup) {
  return markup.replace(/<!--[\s\S]*?-->/g, '');
}

const driverCode = stripJsComments(driverSrc);
const appCode = stripJsComments(appJs);
const htmlCode = stripHtmlComments(html);

let passed = 0;
let failed = 0;

/**
 * Run one named assertion block and record its outcome.
 *
 * @param {string} name - Human-readable check name.
 * @param {Function} fn - Body; throws to fail.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  [32mPASS[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  [31mFAIL[0m ' + name);
    console.log('       ' + err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   THE FAKE VIEWPORT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Build a fake browser environment and load the driver into it.
 *
 * The style object records every property written, so "no transform is ever
 * written" is a fact about the recording rather than a fact about the source.
 * `window.screen` is a throwing getter, so any read at all fails the run.
 *
 * @param {Object} opts - { layoutHeight, visualHeight, offsetTop, chrome }.
 * @returns {Object} A harness: { win, root, body, fire, timers }.
 */
function makeHarness(opts) {
  const options = opts || {};
  const rootStyle = {};
  const rootRemoved = [];
  const bodyClasses = new Set();
  const timers = new Map();
  let nextTimer = 1;

  const chrome = options.chrome || {};

  const root = {
    clientHeight: options.layoutHeight || 844,
    style: {
      setProperty(name, value) { rootStyle[name] = value; },
      removeProperty(name) { rootRemoved.push(name); delete rootStyle[name]; },
    },
  };

  const body = {
    classList: {
      toggle(name, on) {
        if (on) bodyClasses.add(name);
        else bodyClasses.delete(name);
        return on;
      },
      contains(name) { return bodyClasses.has(name); },
    },
  };

  const listeners = { window: {}, visual: {} };

  /**
   * Register a listener bucket helper.
   *
   * @param {Object} bucket - The bucket to add into.
   * @returns {Function} An addEventListener implementation.
   */
  function adder(bucket) {
    return function addEventListener(type, fn) {
      if (!bucket[type]) bucket[type] = [];
      bucket[type].push(fn);
    };
  }

  const win = {
    document: {
      documentElement: root,
      body: body,
      querySelector(selector) {
        if (Object.prototype.hasOwnProperty.call(chrome, selector)) {
          return { offsetHeight: chrome[selector] };
        }
        return null;
      },
    },
    visualViewport: {
      height: options.visualHeight === undefined ? 844 : options.visualHeight,
      offsetTop: options.offsetTop || 0,
      addEventListener: adder(listeners.visual),
      removeEventListener() {},
    },
    innerWidth: options.innerWidth || 390,
    addEventListener: adder(listeners.window),
    removeEventListener() {},
    matchMedia(query) {
      const m = /max-width:\s*(\d+)px/.exec(query);
      const limit = m ? Number(m[1]) : 0;
      return { matches: (options.innerWidth || 390) <= limit };
    },
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn: fn, at: ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  // Any read of window.screen is a regression: MOBILE-EXPERIENCE C.1 defect 1.
  Object.defineProperty(win, 'screen', {
    get() { throw new Error('window.screen was read for layout'); },
  });

  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(driverSrc, win, { filename: 'mobile-viewport.js' });

  return {
    win: win,
    api: win.MyrlinMobileViewport,
    rootStyle: rootStyle,
    bodyClasses: bodyClasses,
    /**
     * Dispatch one fake viewport event.
     *
     * @param {string} target - 'visual' or 'window'.
     * @param {string} type - Event type.
     * @returns {void}
     */
    fire(target, type) {
      const bucket = listeners[target === 'window' ? 'window' : 'visual'][type] || [];
      for (const fn of bucket) fn({ type: type });
    },
    /**
     * Run every pending timer, which is how the settle window is closed.
     *
     * @returns {number} How many timers fired.
     */
    flush() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, entry] of pending) entry.fn();
      return pending.length;
    },
    pending() { return timers.size; },
  };
}

/* ═══════════════════════════════════════════════════════════════
   EXECUTED BEHAVIOUR
   ═══════════════════════════════════════════════════════════════ */

check('the driver publishes its API and its constant table', () => {
  const h = makeHarness({});
  assert.ok(h.api, 'window.MyrlinMobileViewport must exist');
  for (const name of ['start', 'stop', 'apply', 'onSettle', 'isPhone']) {
    assert.strictEqual(typeof h.api[name], 'function', name + ' must be a function');
  }
  const c = h.api.constants;
  assert.strictEqual(c.MW_LONGPRESS_MS, 400, 'one long-press duration for the whole app');
  assert.strictEqual(c.MW_LONGPRESS_MOVE_PX, 8);
  assert.strictEqual(c.MW_LONGPRESS_HAPTIC_MS, 25);
  assert.strictEqual(c.MW_VP_SETTLE_MS, 150);
  assert.strictEqual(c.MW_KEYBOARD_MIN_INSET_PX, 120);
  assert.strictEqual(c.MW_SWIPE_MIN_PX, 96);
  assert.strictEqual(c.MW_SWIPE_EDGE_PX, 32);
  assert.strictEqual(c.MW_PHONE_MAX_WIDTH_PX, 768);
  assert.strictEqual(c.MW_TABLET_MAX_WIDTH_PX, 900);
});

check('start() writes all four custom properties from the visual viewport', () => {
  const h = makeHarness({
    layoutHeight: 844,
    visualHeight: 844,
    chrome: {
      '.terminal-pane.mobile-active .terminal-mobile-toolbar': 50,
      '.terminal-pane.mobile-active .terminal-mobile-input-row': 52,
    },
  });
  h.api.start();
  assert.strictEqual(h.rootStyle['--mw-vh'], '844px');
  assert.strictEqual(h.rootStyle['--mw-kb'], '0px');
  assert.strictEqual(h.rootStyle['--mw-toolbar-h'], '50px');
  assert.strictEqual(h.rootStyle['--mw-inputrow-h'], '52px');
  // The pre-restyle token name is kept correct, per DO-NOT-BREAK D.10.
  assert.strictEqual(h.rootStyle['--vh'], '844px');
});

check('a hidden chrome element measures exactly 0, so the anchor collapses', () => {
  const h = makeHarness({ layoutHeight: 844, visualHeight: 844, chrome: {} });
  h.api.start();
  assert.strictEqual(h.rootStyle['--mw-toolbar-h'], '0px');
  assert.strictEqual(h.rootStyle['--mw-inputrow-h'], '0px');
});

check('the keyboard inset is layout minus (visual plus offset), the iOS shape', () => {
  // iOS Safari does not shrink the layout viewport; it offsets the visual one.
  const h = makeHarness({ layoutHeight: 844, visualHeight: 508, offsetTop: 0 });
  h.api.start();
  assert.strictEqual(h.rootStyle['--mw-kb'], '336px');
  assert.ok(h.bodyClasses.has('mw-keyboard'), 'a 336px inset is a keyboard');
});

check('an Android layout-resize reports no inset, because the CSS path handled it', () => {
  // With interactive-widget=resizes-content the layout viewport shrinks too,
  // so layout and visual agree and the driver correctly reports no inset.
  const h = makeHarness({ layoutHeight: 508, visualHeight: 508 });
  h.api.start();
  assert.strictEqual(h.rootStyle['--mw-kb'], '0px');
  assert.ok(!h.bodyClasses.has('mw-keyboard'), 'no inset is not a keyboard');
});

check('browser chrome under the threshold is not mistaken for a keyboard', () => {
  // A 90px inset is a collapsing URL bar, not a keyboard. The old code
  // compared against window.screen.height * 0.75 and got this wrong in
  // landscape and in an installed PWA.
  const h = makeHarness({ layoutHeight: 844, visualHeight: 754 });
  h.api.start();
  assert.strictEqual(h.rootStyle['--mw-kb'], '90px');
  assert.ok(!h.bodyClasses.has('mw-keyboard'), '90px is browser chrome, not a keyboard');
});

check('window.screen is never read, in any code path', () => {
  // The fake window throws on any read of `screen`. Exercising start, a
  // resize, a scroll, an orientation change and a settle covers every path.
  const h = makeHarness({ layoutHeight: 844, visualHeight: 508 });
  h.api.start();
  h.fire('visual', 'resize');
  h.fire('visual', 'scroll');
  h.fire('window', 'orientationchange');
  h.fire('window', 'resize');
  h.flush();
  assert.ok(true, 'no read of window.screen occurred');
});

check('a burst of viewport events produces exactly ONE settle notification', () => {
  // The done criterion for P10.3. A keyboard animation fires a storm of
  // resize and scroll events; three fits mean three full ConPTY repaints on
  // every attached client.
  const h = makeHarness({ layoutHeight: 844, visualHeight: 508 });
  let settles = 0;
  h.api.onSettle(() => { settles++; });
  h.api.start();
  for (let i = 0; i < 9; i++) {
    h.fire('visual', 'resize');
    h.fire('visual', 'scroll');
  }
  assert.strictEqual(settles, 0, 'nothing settles while the events are still arriving');
  assert.strictEqual(h.pending(), 1, 'the burst must coalesce into one pending timer');
  h.flush();
  assert.strictEqual(settles, 1, 'exactly one settle per burst');
});

check('an open-and-close cycle settles twice, once per window, never per event', () => {
  const h = makeHarness({ layoutHeight: 844, visualHeight: 844 });
  let settles = 0;
  h.api.onSettle(() => { settles++; });
  h.api.start();

  // Keyboard opening: a storm of shrinking resizes.
  h.win.visualViewport.height = 700;
  h.fire('visual', 'resize');
  h.win.visualViewport.height = 600;
  h.fire('visual', 'resize');
  h.win.visualViewport.height = 508;
  h.fire('visual', 'resize');
  h.flush();
  assert.strictEqual(settles, 1, 'one settle for the whole opening animation');
  assert.ok(h.bodyClasses.has('mw-keyboard'));

  // Keyboard closing: the same storm in reverse.
  h.win.visualViewport.height = 700;
  h.fire('visual', 'resize');
  h.win.visualViewport.height = 844;
  h.fire('visual', 'resize');
  h.flush();
  assert.strictEqual(settles, 2, 'one settle for the whole closing animation');
  assert.ok(!h.bodyClasses.has('mw-keyboard'));
});

check('geometry is correct on the FIRST frame, before the settle fires', () => {
  // Leading plus trailing, deliberately asymmetric: the properties are cheap
  // and must be right immediately; the settle is expensive and fires once.
  const h = makeHarness({ layoutHeight: 844, visualHeight: 844 });
  let settles = 0;
  h.api.onSettle(() => { settles++; });
  h.api.start();
  h.win.visualViewport.height = 508;
  h.fire('visual', 'resize');
  assert.strictEqual(h.rootStyle['--mw-vh'], '508px', 'the first frame must already be right');
  assert.strictEqual(settles, 0, 'the expensive work must not run on the leading edge');
});

check('the driver NEVER writes a transform, on any element', () => {
  const h = makeHarness({ layoutHeight: 844, visualHeight: 508, offsetTop: 120 });
  h.api.start();
  h.fire('visual', 'scroll');
  h.flush();
  const written = Object.keys(h.rootStyle);
  assert.ok(
    written.every(name => !/transform/i.test(name)),
    'a transform on an ancestor creates a containing block for every fixed descendant'
  );
  assert.ok(!/style\.transform/.test(driverCode), 'the driver source must not touch style.transform');
  assert.ok(!/translateY/.test(driverCode), 'the driver source must not write a translate');
});

check('the visualViewport scroll handler recomputes and moves nothing', () => {
  // On iOS the visual viewport is OFFSET rather than resized, so the scroll
  // handler is what catches the keyboard at all. It must recompute the inset
  // and it must not compensate by moving the shell.
  const h = makeHarness({ layoutHeight: 844, visualHeight: 700, offsetTop: 144 });
  h.api.start();
  assert.strictEqual(h.rootStyle['--mw-kb'], '0px', '700 + 144 equals the layout height');
  h.win.visualViewport.offsetTop = 0;
  h.win.visualViewport.height = 508;
  h.fire('visual', 'scroll');
  h.flush();
  assert.strictEqual(h.rootStyle['--mw-kb'], '336px');
});

check('start() is idempotent and stop() unbinds', () => {
  const h = makeHarness({ layoutHeight: 844, visualHeight: 844 });
  let settles = 0;
  h.api.onSettle(() => { settles++; });
  h.api.start();
  h.api.start();
  h.fire('visual', 'resize');
  h.flush();
  assert.strictEqual(settles, 1, 'a second start must not double-bind');
  h.api.stop();
  h.fire('visual', 'resize');
  h.flush();
  assert.strictEqual(settles, 1, 'stop() must silence the driver');
});

check('a throwing subscriber cannot wedge the driver', () => {
  const h = makeHarness({ layoutHeight: 844, visualHeight: 844 });
  let good = 0;
  h.api.onSettle(() => { throw new Error('subscriber exploded'); });
  h.api.onSettle(() => { good++; });
  h.api.start();
  h.fire('visual', 'resize');
  h.flush();
  assert.strictEqual(good, 1, 'a broken subscriber must not stop the next one');
});

check('an engine with no visualViewport still gets correct geometry', () => {
  const h = makeHarness({ layoutHeight: 844, visualHeight: 844 });
  delete h.win.visualViewport;
  h.api.apply();
  assert.strictEqual(h.rootStyle['--mw-vh'], '844px', 'fall back to the layout viewport');
  assert.strictEqual(h.rootStyle['--mw-kb'], '0px');
});

/* ═══════════════════════════════════════════════════════════════
   THE THREE BANS, AT SOURCE LEVEL
   ═══════════════════════════════════════════════════════════════ */

check('app.js no longer compares against window.screen for the keyboard', () => {
  assert.ok(
    !/window\.screen\.height\s*\*/.test(appCode),
    'the screen.height ratio is defect 1 of MOBILE-EXPERIENCE C.1'
  );
});

check('app.js no longer writes a transform onto #app', () => {
  assert.ok(
    !/app\.style\.transform\s*=/.test(appCode),
    'defect 3 of C.1: a transform on #app breaks every position:fixed descendant'
  );
  assert.ok(
    /MyrlinMobileViewport\.start\(\)/.test(appCode),
    'app.js must start the one geometry owner'
  );
  assert.ok(
    /MyrlinMobileViewport\.onSettle\(/.test(appCode),
    'the terminal fit must ride the settle window, not the event'
  );
});

check('body.keyboard-open no longer sets position: fixed', () => {
  assert.ok(
    !/body\.keyboard-open\s*\{[^}]*position:\s*fixed/.test(stylesMobile),
    'defect 2 of C.1: position:fixed on body loses the scroll position'
  );
  // The class itself is retained and is still what retracts the tab bar, so
  // nothing that reads it breaks.
  assert.ok(
    /body\.keyboard-open \.mobile-tab-bar/.test(stylesMobile),
    'the class must still be honoured by the tab bar'
  );
  assert.ok(
    /body\.mw-keyboard \.mobile-tab-bar/.test(stylesMobile),
    'the new class must drive the same retract'
  );
  assert.ok(
    /\.mobile-tab-bar\s*\{[^}]*transform:\s*translateY\(100%\)/.test(stylesMobile) ||
      /body\.mw-keyboard \.mobile-tab-bar,[\s\S]{0,80}\{[^}]*transform:\s*translateY\(100%\)/.test(stylesMobile),
    'the bar must retract by transform, not by display, so there is no layout jump'
  );
});

check('no 100vh survives anywhere in styles-mobile.css', () => {
  const hits = stylesMobile.match(/100vh/g) || [];
  assert.deepStrictEqual(
    hits,
    [],
    '100vh is the LARGE viewport and overflows under the browser chrome by design'
  );
});

check('.app is sized from the visual viewport with a dvh base', () => {
  assert.ok(
    /\.app\s*\{[^}]*height:\s*100dvh/.test(stylesMobile),
    'the base must be correct before any script runs'
  );
  assert.ok(
    /\.app\s*\{[^}]*height:\s*var\(--mw-vh/.test(stylesMobile),
    'the refinement must read the driver property'
  );
});

check('the meta viewport carries the token and still forbids the two bans', () => {
  assert.ok(
    /interactive-widget=resizes-content/.test(htmlCode),
    'Chromium needs the token to shrink the layout viewport for the keyboard'
  );
  assert.ok(/viewport-fit=cover/.test(htmlCode), 'safe-area insets need viewport-fit=cover');
  assert.ok(!/user-scalable=no/.test(htmlCode), 'pinch zoom is an accessibility affordance');
  assert.ok(!/maximum-scale=1/.test(htmlCode), 'capping the scale breaks pinch zoom');
});

check('the driver loads before app.js, in the body, not the head', () => {
  const driverAt = html.indexOf('mobile-viewport.js?v=');
  const appAt = html.indexOf('app.js?v=');
  const headEnd = html.indexOf('</head>');
  assert.ok(driverAt !== -1, 'mobile-viewport.js must be served');
  assert.ok(driverAt < appAt, 'the driver must be parsed before app.js subscribes to it');
  assert.ok(driverAt > headEnd, 'the four pinned head assets must keep their relative order');
});

check('the eight safe-area surfaces of C.7 are all handled', () => {
  assert.ok(/\.app\s*\{[^}]*padding-left:\s*env\(safe-area-inset-left/.test(stylesMobile), '1. .app left');
  assert.ok(/\.app\s*\{[^}]*padding-right:\s*env\(safe-area-inset-right/.test(stylesMobile), '1. .app right');
  assert.ok(
    /display-mode:\s*standalone[\s\S]{0,200}padding-top:\s*env\(safe-area-inset-top/.test(stylesMobile),
    '2. header top, standalone only, or a browser tab gets a dead band'
  );
  assert.ok(
    /--mw-tabbar-h:\s*calc\(64px \+ env\(safe-area-inset-bottom/.test(stylesMobile),
    '3. the tab bar carries the bottom inset, once, for everything that clears it'
  );
  assert.ok(
    /calc\(16px \+ env\(safe-area-inset-bottom/.test(stylesMobile),
    '6. sheets and modals'
  );
  assert.ok(
    /bottom:\s*calc\(\s*var\(--mw-tabbar-h\)/.test(stylesMobile),
    '7. the toast anchor is computed from measured chrome, never a magic constant'
  );
  assert.ok(
    /scroll-padding-bottom:\s*var\(--mw-tabbar-h\)/.test(stylesMobile),
    '8. scroll bodies, so scrollIntoView never lands a row under the tab bar'
  );
});

console.log('  ' + '-'.repeat(48));
console.log('  [mobile-viewport] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
