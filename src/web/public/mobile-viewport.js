/**
 * mobile-viewport.js - the single owner of viewport geometry on a phone.
 * Created: 2026-08-13 (Notion restyle phase P10, work package P10.3).
 *
 * WHY THIS FILE EXISTS
 *
 * A phone browser has two viewports. The LAYOUT viewport is what CSS `vh` and
 * `document.documentElement.clientHeight` describe. The VISUAL viewport is what
 * the user can actually see, and it is what shrinks when the soft keyboard
 * appears. On Chrome for Android the layout viewport also shrinks by default;
 * on iOS Safari it does not, and instead the page is scrolled and the visual
 * viewport is offset. An app that sizes itself with `vh` therefore has half of
 * its UI under the keyboard on iOS.
 *
 * MOBILE-EXPERIENCE.md C.1 names three specific defects in what this replaces,
 * and each one is a real bug rather than a style preference:
 *
 *   1. Keyboard detection compared the visual height against
 *      `window.screen.height * 0.75`. `screen.height` is the PHYSICAL screen
 *      including OS chrome and does not rotate consistently across browsers, so
 *      in landscape or in an installed PWA the ratio is wrong and the
 *      keyboard class toggled at the wrong times.
 *   2. `body.keyboard-open { position: fixed }` loses the scroll position and
 *      is a well-known source of iOS scroll jumps. With `.app` sized to the
 *      visual viewport there is nothing to scroll, so the hack bought nothing
 *      and cost that.
 *   3. `#app.style.transform = translateY(offset)` compensated the iOS scroll.
 *      A transform on an ancestor CREATES A CONTAINING BLOCK for every
 *      `position: fixed` descendant, which in this app means the action sheet,
 *      the account sheet and its backdrop, every modal and the toast
 *      container. The codebase already carries a long comment about the pain
 *      caused by `.app` forming a stacking context; the transform made that
 *      strictly worse.
 *
 * THE CONTRACT
 *
 * One module owns viewport geometry. Everything else reads custom properties.
 * NOTHING ELSE IN THE APP MAY READ `window.innerHeight` OR `window.screen` FOR
 * LAYOUT. The terminal fit, the toast anchor, the Select-mode strip placement
 * and the sheet max-heights all need the same numbers; three independent
 * readers is how they drift apart.
 *
 * NO `transform` IS EVER WRITTEN BY THIS FILE. The `visualViewport.scroll`
 * handler exists only to recompute the properties; it does not move anything.
 *
 * THE TWO-PATH STORY
 *
 * `interactive-widget=resizes-content` on the meta viewport makes Chromium
 * shrink the LAYOUT viewport for the keyboard, so on Android the CSS path
 * alone is correct and this driver is a no-op refinement. iOS Safari ignores
 * the token today, so the driver carries iOS. CSS handles Android, JS handles
 * iOS, and both write the same custom property.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function mobileViewportModule(global) {
  'use strict';

  /* ─── The constant table (MOBILE-EXPERIENCE, appendix) ──────────────
     Every measurement the mobile program introduces lives here, so
     implementers do not invent parallel constants. Four of these are read
     by P11's touch work rather than by this file; they are declared here
     anyway because the appendix names this module as their home, and two
     different long-press durations on adjacent elements is exactly what
     makes a gesture feel unreliable. */

  /** One long-press duration for the whole app. Matches terminal.js. */
  var MW_LONGPRESS_MS = 400;
  /** Movement past this cancels a long press. Matches terminal.js. */
  var MW_LONGPRESS_MOVE_PX = 8;
  /** Haptic confirmation for a long press, where the platform has one. */
  var MW_LONGPRESS_HAPTIC_MS = 25;
  /** Coalesce the keyboard animation's resize storm into one settle. */
  var MW_VP_SETTLE_MS = 150;
  /** Below this inset it is browser chrome, not a keyboard. */
  var MW_KEYBOARD_MIN_INSET_PX = 120;
  /** Pane-switch swipe travel. 80px on a 360px device is 22 percent of the
   *  width and collides with a lazy vertical scroll, so the threshold rises. */
  var MW_SWIPE_MIN_PX = 96;
  /** No app gesture starts within this many pixels of an edge: the edge
   *  belongs to the OS back gesture (B.1 rule R2). */
  var MW_SWIPE_EDGE_PX = 32;
  /** The phone breakpoint every rule in styles-mobile.css uses. */
  var MW_PHONE_MAX_WIDTH_PX = 768;
  /** The tablet breakpoint MOBILE-EXPERIENCE H.3 item 6 raises as an open
   *  question: phone IA below, desktop above, so an iPad Mini is the phone IA
   *  in portrait and the desktop only in landscape above 900px. Declared but
   *  NOT yet load-bearing; changing the breakpoint touches every
   *  `max-width: 768px` rule in the codebase and needs one decision, not
   *  thirty edits. Flagged for P11. */
  var MW_TABLET_MAX_WIDTH_PX = 900;

  /** Selectors whose measured height the toast anchor and the Select-mode
   *  strip read. Measured rather than assumed, so a chrome height and the
   *  surfaces that clear it can never drift apart (B.5 rule 2). */
  var CHROME_SELECTORS = {
    '--mw-toolbar-h': '.terminal-pane.mobile-active .terminal-mobile-toolbar',
    '--mw-inputrow-h': '.terminal-pane.mobile-active .terminal-mobile-input-row',
  };

  var settleTimer = null;
  var started = false;
  var subscribers = [];
  var lastApplied = null;

  /**
   * Measure one chrome element's height in CSS pixels.
   *
   * `offsetHeight` rather than `getBoundingClientRect().height` on purpose:
   * a hidden element must measure exactly 0 so the anchor arithmetic
   * collapses cleanly, and `offsetHeight` is 0 for `display: none` while a
   * rect can be fractional noise.
   *
   * @param {Document} doc - The document to query.
   * @param {string} selector - Element selector.
   * @returns {number} Height in pixels, 0 when absent or hidden.
   */
  function measureHeight(doc, selector) {
    if (!doc || typeof doc.querySelector !== 'function') return 0;
    var el = null;
    try {
      el = doc.querySelector(selector);
    } catch (_) {
      return 0;
    }
    if (!el) return 0;
    var h = el.offsetHeight;
    return typeof h === 'number' && isFinite(h) && h > 0 ? Math.round(h) : 0;
  }

  /**
   * Read the current geometry and write it to the document.
   *
   * Four custom properties and one body class, and nothing else. The
   * keyboard inset is derived as `layout - (visual + offsetTop)`, which is
   * correct on BOTH engines: on Android the layout viewport shrinks with the
   * keyboard so the difference is near zero and the class stays off (which is
   * right, because the CSS path already handled it), and on iOS the layout
   * viewport does not shrink so the difference is the keyboard's real height.
   *
   * `window.screen` is never read. That is the whole point.
   *
   * @returns {Object} The geometry that was applied, for tests and callers.
   */
  function apply() {
    var doc = global.document;
    if (!doc || !doc.documentElement) return null;

    var vv = global.visualViewport || null;
    var layoutH = doc.documentElement.clientHeight || 0;
    var visualH = vv && typeof vv.height === 'number' ? Math.floor(vv.height) : layoutH;
    var offsetTop = vv && typeof vv.offsetTop === 'number' ? Math.round(vv.offsetTop) : 0;
    var keyboardInset = Math.max(0, layoutH - (visualH + offsetTop));

    var root = doc.documentElement;
    root.style.setProperty('--mw-vh', visualH + 'px');
    root.style.setProperty('--mw-kb', keyboardInset + 'px');
    // The pre-restyle token name is kept and kept correct. Rules written
    // against `var(--vh, ...)` predate this module and must not silently stop
    // resolving (DO-NOT-BREAK D.10, "keep the token name").
    root.style.setProperty('--vh', visualH + 'px');

    var toolbarH = measureHeight(doc, CHROME_SELECTORS['--mw-toolbar-h']);
    var inputRowH = measureHeight(doc, CHROME_SELECTORS['--mw-inputrow-h']);
    root.style.setProperty('--mw-toolbar-h', toolbarH + 'px');
    root.style.setProperty('--mw-inputrow-h', inputRowH + 'px');

    var keyboardOpen = keyboardInset > MW_KEYBOARD_MIN_INSET_PX;
    if (doc.body && doc.body.classList) {
      doc.body.classList.toggle('mw-keyboard', keyboardOpen);
      // The pre-restyle class is kept in step. `body.keyboard-open` no longer
      // carries `position: fixed` (that rule is deleted), but the class itself
      // is read elsewhere and setViewMode clears it, so it stays truthful.
      doc.body.classList.toggle('keyboard-open', keyboardOpen);
    }

    lastApplied = {
      layoutHeight: layoutH,
      visualHeight: visualH,
      offsetTop: offsetTop,
      keyboardInset: keyboardInset,
      keyboardOpen: keyboardOpen,
      toolbarHeight: toolbarH,
      inputRowHeight: inputRowH,
    };
    return lastApplied;
  }

  /**
   * Notify every settle subscriber exactly once per settle window.
   *
   * This is the trailing edge, and it is the one that costs something: it is
   * where the terminal is re-fitted and where a geometry claim may be sent to
   * a shared PTY. Every applied resize is a full ConPTY repaint on every
   * attached client, so doing it three times during a 250ms keyboard
   * animation is three full repaints (C.6 rule 1).
   *
   * @returns {void}
   */
  function notifySettled() {
    var snapshot = lastApplied;
    for (var i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i](snapshot);
      } catch (_) {
        // A broken subscriber must never wedge the layout driver.
      }
    }
  }

  /**
   * Handle one viewport event.
   *
   * LEADING plus TRAILING, deliberately asymmetric: the custom properties are
   * written immediately so the first frame of a keyboard animation is already
   * correct, and the settle subscribers fire only on the trailing edge so the
   * expensive work happens once.
   *
   * @returns {void}
   */
  function onViewportEvent() {
    if (settleTimer === null) apply();
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(function settled() {
      settleTimer = null;
      apply();
      notifySettled();
    }, MW_VP_SETTLE_MS);
  }

  /**
   * Register a callback to run once per settle window.
   *
   * @param {Function} fn - Called with the applied geometry snapshot.
   * @returns {Function} An unsubscribe function.
   */
  function onSettle(fn) {
    if (typeof fn !== 'function') return function noop() {};
    subscribers.push(fn);
    return function unsubscribe() {
      var at = subscribers.indexOf(fn);
      if (at !== -1) subscribers.splice(at, 1);
    };
  }

  /**
   * Bind the driver and take the first measurement.
   *
   * Called once on boot, before the first paint of `.app`. Idempotent: a
   * second call re-applies the geometry and binds nothing twice.
   *
   * @returns {boolean} True when the driver is live.
   */
  function start() {
    if (started) {
      apply();
      return true;
    }
    started = true;

    var vv = global.visualViewport || null;
    if (vv && typeof vv.addEventListener === 'function') {
      vv.addEventListener('resize', onViewportEvent);
      // Scroll is bound to RECOMPUTE, never to move anything. On iOS the
      // visual viewport is offset rather than resized when the keyboard
      // opens, so without this the inset would be missed entirely.
      vv.addEventListener('scroll', onViewportEvent);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('resize', onViewportEvent);
      // Both orientationchange and the subsequent resize fire, and on iOS the
      // dimensions are briefly stale during the rotation animation, so the
      // geometry is read after the debounce and never inside the event (C.8).
      global.addEventListener('orientationchange', onViewportEvent);
    }

    apply();
    return true;
  }

  /**
   * Unbind the driver. Exists for tests and for a future teardown path;
   * nothing in the app calls it today.
   *
   * @returns {void}
   */
  function stop() {
    if (!started) return;
    started = false;
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    var vv = global.visualViewport || null;
    if (vv && typeof vv.removeEventListener === 'function') {
      vv.removeEventListener('resize', onViewportEvent);
      vv.removeEventListener('scroll', onViewportEvent);
    }
    if (typeof global.removeEventListener === 'function') {
      global.removeEventListener('resize', onViewportEvent);
      global.removeEventListener('orientationchange', onViewportEvent);
    }
    subscribers.length = 0;
  }

  /**
   * Whether the shell is at phone width right now.
   *
   * One reader for the breakpoint, so a rule and its JS guard cannot
   * disagree about what "phone" means.
   *
   * @returns {boolean} True at 768px and below.
   */
  function isPhone() {
    if (typeof global.matchMedia === 'function') {
      return global.matchMedia('(max-width: ' + MW_PHONE_MAX_WIDTH_PX + 'px)').matches;
    }
    return (global.innerWidth || 0) <= MW_PHONE_MAX_WIDTH_PX;
  }

  global.MyrlinMobileViewport = {
    start: start,
    stop: stop,
    apply: apply,
    onSettle: onSettle,
    isPhone: isPhone,
    get last() { return lastApplied; },
    constants: {
      MW_LONGPRESS_MS: MW_LONGPRESS_MS,
      MW_LONGPRESS_MOVE_PX: MW_LONGPRESS_MOVE_PX,
      MW_LONGPRESS_HAPTIC_MS: MW_LONGPRESS_HAPTIC_MS,
      MW_VP_SETTLE_MS: MW_VP_SETTLE_MS,
      MW_KEYBOARD_MIN_INSET_PX: MW_KEYBOARD_MIN_INSET_PX,
      MW_SWIPE_MIN_PX: MW_SWIPE_MIN_PX,
      MW_SWIPE_EDGE_PX: MW_SWIPE_EDGE_PX,
      MW_PHONE_MAX_WIDTH_PX: MW_PHONE_MAX_WIDTH_PX,
      MW_TABLET_MAX_WIDTH_PX: MW_TABLET_MAX_WIDTH_PX,
    },
  };
}(typeof window !== 'undefined' ? window : globalThis));
