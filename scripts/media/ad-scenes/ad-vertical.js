/**
 * ad-vertical.js - builds and drives the vertical ad timeline inside the page.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHY A TIMELINE RATHER THAN CSS ANIMATIONS
 *
 * Every motion here is built with element.animate(), the Web Animations API,
 * and never with a CSS @keyframes rule. Two reasons, both practical:
 *
 *   1. A CSS animation is owned by its owning element's style, and driving one
 *      by hand through document.getAnimations() puts the WAAPI override and the
 *      cascade in competition. Animations created in script have one owner.
 *   2. The composition needs two independent animations on some elements, one
 *      for the entrance and one for the exit, and the timings are derived from
 *      the ad's duration and its line count. Deriving those in CSS would mean
 *      generating a stylesheet, which is the same code with an extra step.
 *
 * THE ONE RULE THAT MAKES FRAME STEPPING WORK
 *
 * Every animation starts at global time zero and carries its own offset as a
 * DELAY, with fill "both". Nothing uses a negative delay and nothing is started
 * late. That is what makes `animation.currentTime = t` mean "the state of the
 * whole scene at t" for every animation at once, which is exactly what the
 * frame stepper in ads.js sets. Break that rule and frames silently desync.
 *
 * WHY SOME ANIMATIONS DRIVE LAYOUT PROPERTIES
 *
 * The closing move shrinks the headline and lifts it to the top of frame. That
 * animates `top` and `font-size`, which are layout properties and would be the
 * wrong choice in a live UI. Here they are the RIGHT choice: a transform scale
 * rasterises the text once and resamples it, so mid move the type goes soft and
 * the last frames can stay soft on a composited layer. Relaying out four lines
 * thirty times a second costs nothing on a build machine and every frame is
 * rendered at its true size.
 *
 * DRIVEN, NOT AUTONOMOUS. Opening this page in a browser does nothing. ads.js
 * injects window.__MYRLIN_AD__, then calls adBuild, adSetFrame and adSeek.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/ad-scenes/ad-vertical
 */

'use strict';

(function () {
  /* ── Timing ─────────────────────────────────────────────────────────────── */

  /**
   * Every offset and duration in the scene, in seconds.
   *
   * These are the numbers a viewer feels, so each one is chosen against the
   * format rather than picked to look tidy. A vertical social snippet is
   * watched once, at speed, with sound off: the hook has to be legible inside
   * the first second and the closing card has to hold long enough to be read
   * and acted on before the clip loops.
   */
  var TIMING = Object.freeze({
    /** Brand line first, before any claim. Half a second of it alone reads as
     *  a signature rather than a logo slam. */
    EYEBROW_IN: 0.12,
    EYEBROW_DUR: 0.55,

    /** First headline line lands inside the first half second, so a viewer who
     *  scrolls past at one second has still read something. Pulled forward from
     *  0.45 after review: a vertical clip autoplays in a feed, and every frame
     *  before the first word is a frame spent on an empty plate. */
    LINE_IN_FIRST: 0.36,

    /** Gap between lines. Measured against reading speed rather than taste:
     *  a three word line takes roughly 400ms to read, so a shorter stagger
     *  stacks lines faster than they can be taken in and a longer one leaves
     *  the frame feeling stalled. */
    LINE_STAGGER: 0.42,

    /** One line's own reveal. Long enough for the mask wipe to register as a
     *  wipe and not a cut. */
    LINE_DUR: 0.62,

    /**
     * How long after the SECOND line the capture starts to rise.
     *
     * Anchored to the second line and not to the last, which is what it was
     * first. Anchoring to the last made the panel's entrance a function of how
     * many lines the copy happened to have, so a four line ad held an empty
     * lower two thirds for nearly three seconds while a three line ad held it
     * for two. Anchoring to the second gives every ad the same 1.6 second hook
     * no matter how the copy is broken, and the remaining lines land over a
     * frame that already has the product in it.
     */
    PANEL_AFTER_SECOND_LINE: 0.10,
    PANEL_DUR: 0.90,

    /** How long the closing block holds before the clip ends. Four seconds is
     *  the read time for a claim plus a command, twice over, which is what a
     *  looping feed clip needs since a viewer may join it halfway. */
    CLOSING_HOLD: 4.00,

    /** The headline shrink that clears the frame for the closing block. */
    SHRINK_DUR: 0.75,

    /** Scrim leads the closing text in slightly, so the text never appears
     *  over an unprotected background even for one frame. */
    SCRIM_AFTER_SHRINK: 0.15,
    SCRIM_DUR: 0.60,
    CTA_AFTER_SHRINK: 0.45,
    CTA_DUR: 0.70,
  });

  /**
   * Easing curves.
   *
   * One expressive curve for entrances and one plain curve for exits. An exit
   * that overshoots draws attention to itself, and by then attention belongs to
   * whatever is arriving.
   */
  var EASE = Object.freeze({
    ENTER: 'cubic-bezier(0.16, 0.84, 0.30, 1)',
    EXIT: 'cubic-bezier(0.40, 0.00, 0.70, 1)',
    DRIFT: 'linear',
  });

  /** How far a headline line starts below its mask, in ems of its own size.
   *  Larger than one line box so no ascender peeks out on the first frame. */
  var LINE_RISE_EM = 1.22;

  /** How far the capture panel starts below its resting place, in pixels.
   *  Small on purpose: the panel is the biggest object in frame and a long
   *  travel reads as a slide show transition. */
  var PANEL_RISE_PX = 92;

  /** Size the headline shrinks to for the closing card, in pixels. Still
   *  comfortably readable on a phone, roughly 3.9 percent of frame width. */
  var KICKER_SIZE_PX = 42;

  /** Where the shrunken headline parks, clear of the eyebrow above it. */
  var KICKER_TOP_PX = 246;

  /** Opacity the shrunken headline settles at, so it reads as a caption
   *  rather than competing with the closing claim. */
  var KICKER_OPACITY = 0.66;

  /** Gap between the bottom of the headline block and the top of the panel. */
  var HEADLINE_TO_PANEL_GAP_PX = 84;

  /**
   * How far the panel lifts once the headline has shrunk out of its way.
   *
   * Shrinking the headline leaves close to three hundred pixels of empty plate
   * between the caption and the panel, which reads as a gap rather than as
   * space. Lifting the panel into most of it closes the composition for the
   * hold that a viewer actually spends the longest looking at. It stays an
   * integer number of pixels so the settled frames are still pixel exact.
   */
  var PANEL_LIFT_PX = 96;

  /** How far the glow drifts across the whole run, in percent of frame. The
   *  only continuous motion in the background; the panel is deliberately left
   *  pixel exact instead of being pushed. */
  var GLOW_DRIFT_PCT = 9;

  /* ── State ──────────────────────────────────────────────────────────────── */

  /** The injected scene config, or null when the page was opened by hand. */
  var config = window.__MYRLIN_AD__ || null;

  /** Every animation this module created, kept for the audit only. adSeek
   *  reads document.getAnimations() instead, so an animation added by a future
   *  edit is driven whether or not it was registered here. */
  var built = [];

  /* ── Helpers ────────────────────────────────────────────────────────────── */

  /**
   * Look up an element by id and fail loudly when the markup drifted.
   *
   * @param {string} id - Element id.
   * @returns {HTMLElement} The element.
   */
  function need(id) {
    var el = document.getElementById(id);
    if (!el) throw new Error('ad-vertical.html is missing #' + id);
    return el;
  }

  /**
   * Create an animation anchored to global time zero.
   *
   * Wrapping element.animate() rather than calling it directly is what enforces
   * the one rule frame stepping depends on: an offset is always expressed as a
   * delay from zero, never as a late start, and the fill is always "both" so
   * the animation still applies before it begins and after it ends.
   *
   * @param {Element} el - Target element.
   * @param {Array<object>} frames - Keyframes.
   * @param {number} atSeconds - When the effect begins, from the start of the ad.
   * @param {number} durSeconds - How long the effect runs.
   * @param {string} easing - A CSS easing function.
   * @returns {Animation} The paused animation.
   */
  function at(el, frames, atSeconds, durSeconds, easing) {
    var anim = el.animate(frames, {
      delay: Math.max(0, atSeconds) * 1000,
      duration: durSeconds * 1000,
      easing: easing || EASE.ENTER,
      fill: 'both',
    });
    anim.pause();
    anim.currentTime = 0;
    built.push(anim);
    return anim;
  }

  /**
   * Report whether a font family genuinely resolved in this browser.
   *
   * The method is the one the media research used to catch a silent fallback:
   * measure a probe string in the family, measure it again in a family name
   * that cannot exist, and compare. Identical widths mean the browser fell back
   * and the ad would ship in the wrong face with no error anywhere.
   *
   * @param {string} family - A single CSS family name, quoted if it has spaces.
   * @param {number} weight - The weight to probe at.
   * @returns {boolean} True when the family resolved to a real face.
   */
  function faceResolves(family, weight) {
    var PROBE = 'HAMBURGEFONTSIV hamburgefontsiv 0123456789 ,.;';
    var ABSENT = '"myrlin-face-that-cannot-exist"';
    var ctx = document.createElement('canvas').getContext('2d');
    ctx.font = weight + ' 96px ' + ABSENT;
    var fallbackWidth = ctx.measureText(PROBE).width;
    ctx.font = weight + ' 96px ' + family + ', ' + ABSENT;
    var actualWidth = ctx.measureText(PROBE).width;
    return Math.abs(actualWidth - fallbackWidth) > 0.5;
  }

  /**
   * Apply every per ad seed value onto the stage as a custom property.
   *
   * Colours, grid pitch and glow position are seeded per ad so the two clips
   * cannot come out wearing the same texture, which the project's design rules
   * forbid for repeated surfaces.
   *
   * @param {HTMLElement} stage - The stage element.
   * @returns {void}
   */
  function applySeed(stage) {
    var plate = config.plate;
    var panel = config.panel;
    var pairs = {
      '--ad-plate-base': plate.base,
      '--ad-plate-wash': plate.wash,
      '--ad-glow-color': plate.glow,
      '--ad-glow-x': plate.glowX,
      '--ad-glow-y': plate.glowY,
      '--ad-glow-size': plate.glowSize,
      '--ad-grid-pitch': plate.gridPitch,
      '--ad-grid-angle': plate.gridAngle,
      '--ad-accent-a': plate.accentA,
      '--ad-accent-b': plate.accentB,
      '--ad-panel-left': panel.left + 'px',
      '--ad-panel-top': panel.top + 'px',
      '--ad-panel-width': config.render.width + 'px',
      '--ad-panel-height': config.render.height + 'px',
      '--ad-headline-size': config.headline.size + 'px',
    };
    Object.keys(pairs).forEach(function (key) {
      if (pairs[key] !== undefined && pairs[key] !== null) {
        stage.style.setProperty(key, String(pairs[key]));
      }
    });
  }

  /**
   * Build the headline markup from the config's line segments.
   *
   * Three nested elements per line and not two. The mask needs its own box so
   * the ink can slide inside it; a clip and a transform on one box move
   * together and the reveal does nothing. The outer shift box exists so the
   * closing move can animate a transform without fighting the reveal for the
   * same property.
   *
   * @param {HTMLElement} headline - The h1 element.
   * @returns {Array<HTMLElement>} The per line shift elements, in order.
   */
  function buildHeadline(headline) {
    headline.textContent = '';
    var shifts = [];
    config.headline.lines.forEach(function (segments) {
      var shift = document.createElement('span');
      shift.className = 'line-shift';
      var mask = document.createElement('span');
      mask.className = 'line-mask';
      var ink = document.createElement('span');
      ink.className = 'line-ink';
      segments.forEach(function (segment) {
        var piece = document.createElement('span');
        if (segment.accent === 'a') piece.className = 'ink-accent-a';
        else if (segment.accent === 'b') piece.className = 'ink-accent-b';
        piece.textContent = segment.t;
        ink.appendChild(piece);
      });
      mask.appendChild(ink);
      shift.appendChild(mask);
      headline.appendChild(shift);
      shifts.push(shift);
    });
    return shifts;
  }

  /**
   * Work out when each beat happens for this ad's duration and line count.
   *
   * @param {number} lineCount - How many headline lines there are.
   * @returns {object} Absolute times in seconds for every beat.
   */
  function schedule(lineCount) {
    var lastLineIn = TIMING.LINE_IN_FIRST + (lineCount - 1) * TIMING.LINE_STAGGER;
    var secondLineIn = TIMING.LINE_IN_FIRST + Math.min(1, lineCount - 1) * TIMING.LINE_STAGGER;
    var panelIn = secondLineIn + TIMING.LINE_DUR + TIMING.PANEL_AFTER_SECOND_LINE;
    var shrinkAt = config.durationSeconds - TIMING.CLOSING_HOLD - TIMING.SHRINK_DUR;
    return {
      lastLineIn: lastLineIn,
      panelIn: panelIn,
      shrinkAt: shrinkAt,
      scrimAt: shrinkAt + TIMING.SCRIM_AFTER_SHRINK,
      ctaAt: shrinkAt + TIMING.CTA_AFTER_SHRINK,
    };
  }

  /* ── Public surface, called by ads.js ───────────────────────────────────── */

  /**
   * Lay out the scene and create every animation, paused at time zero.
   *
   * Must be called AFTER document.fonts.ready, because the headline block is
   * positioned from its measured height and a fallback face measures wrong.
   *
   * @returns {object} A summary the driver can assert against.
   */
  window.adBuild = function adBuild() {
    if (!config) throw new Error('window.__MYRLIN_AD__ was not injected; ads.js owns this page');

    var stage = need('stage');
    var eyebrow = need('eyebrow');
    var headline = need('headline');
    var panelRise = need('panel-rise');
    var scrim = need('scrim');
    var cta = need('cta');
    var glow = need('glow');

    applySeed(stage);
    need('eyebrow-word').textContent = config.eyebrow;
    need('cta-claim').textContent = config.cta.claim;
    need('cta-cmd').textContent = config.cta.command;

    var shifts = buildHeadline(headline);

    // Position the block by its BOTTOM edge, a fixed gap above the panel, so
    // a three line ad and a four line ad both sit against the same optical
    // line. Measured rather than assumed: the block's height depends on the
    // face that actually resolved.
    var blockHeight = headline.getBoundingClientRect().height;
    var headlineTop = Math.round(config.panel.top - HEADLINE_TO_PANEL_GAP_PX - blockHeight);
    stage.style.setProperty('--ad-headline-top', headlineTop + 'px');

    var beats = schedule(shifts.length);

    // Eyebrow. Opacity plus a short lift, nothing more; it is a signature.
    at(eyebrow, [
      { opacity: 0, transform: 'translateY(14px)' },
      { opacity: 1, transform: 'translateY(0px)' },
    ], TIMING.EYEBROW_IN, TIMING.EYEBROW_DUR, EASE.ENTER);

    // Headline reveal, one animation per line's ink.
    shifts.forEach(function (shift, index) {
      var ink = shift.querySelector('.line-ink');
      at(ink, [
        { opacity: 0, transform: 'translateY(' + LINE_RISE_EM + 'em)' },
        { opacity: 1, transform: 'translateY(0em)' },
      ], TIMING.LINE_IN_FIRST + index * TIMING.LINE_STAGGER, TIMING.LINE_DUR, EASE.ENTER);
    });

    // Capture panel. Transform and opacity only. It settles on an exact
    // identity transform so the screenshot inside it stays pixel for pixel.
    at(panelRise, [
      { opacity: 0, transform: 'translateY(' + PANEL_RISE_PX + 'px)' },
      { opacity: 1, transform: 'translateY(0px)' },
    ], beats.panelIn, TIMING.PANEL_DUR, EASE.ENTER);

    // Closing move. The headline shrinks and lifts instead of leaving, so the
    // full claim stays on screen next to the command that answers it.
    at(headline, [
      { top: headlineTop + 'px', fontSize: config.headline.size + 'px', opacity: 1 },
      { top: KICKER_TOP_PX + 'px', fontSize: KICKER_SIZE_PX + 'px', opacity: KICKER_OPACITY },
    ], beats.shrinkAt, TIMING.SHRINK_DUR, EASE.EXIT);

    // The panel lifts on the figure, not on .panel-rise, because .panel-rise
    // already owns the entrance and one element cannot carry two animations of
    // the same property without the later one winning outright from time zero.
    at(need('panel'), [
      { transform: 'translateY(0px)' },
      { transform: 'translateY(-' + PANEL_LIFT_PX + 'px)' },
    ], beats.shrinkAt, TIMING.SHRINK_DUR, EASE.EXIT);

    at(scrim, [{ opacity: 0 }, { opacity: 1 }], beats.scrimAt, TIMING.SCRIM_DUR, EASE.ENTER);

    at(cta, [
      { opacity: 0, transform: 'translateY(30px)' },
      { opacity: 1, transform: 'translateY(0px)' },
    ], beats.ctaAt, TIMING.CTA_DUR, EASE.ENTER);

    // Background drift. Linear and slow, running the whole length of the ad,
    // so no frame of the clip is completely static even during a hold.
    at(glow, [
      { transform: 'translate(0%, 0%)' },
      { transform: 'translate(' + GLOW_DRIFT_PCT + '%, ' + (GLOW_DRIFT_PCT * 0.55) + '%)' },
    ], 0, config.durationSeconds, EASE.DRIFT);

    stage.dataset.standby = 'false';

    return {
      animations: built.length,
      headlineTop: headlineTop,
      headlineHeight: Math.round(blockHeight),
      beats: beats,
    };
  };

  /**
   * Put the whole scene at one instant.
   *
   * Reads document.getAnimations() rather than the list this module built, so
   * an animation introduced by a later edit, or by a stray CSS transition, is
   * still pinned to the same clock instead of running free between frames.
   *
   * @param {number} timeMs - Time from the start of the ad, in milliseconds.
   * @returns {number} How many animations were pinned.
   */
  window.adSeek = function adSeek(timeMs) {
    var animations = document.getAnimations();
    for (var i = 0; i < animations.length; i++) {
      animations[i].pause();
      animations[i].currentTime = timeMs;
    }
    return animations.length;
  };

  /**
   * Swap the capture frame and wait until it is genuinely ready to paint.
   *
   * img.decode() is the whole point of this function. Assigning src and
   * screenshotting on the next tick races the decoder, and the race is won by
   * the decoder often enough that it looks like it works: the failure is a
   * handful of frames scattered through the clip showing the PREVIOUS frame,
   * which reads as a stutter nobody can trace back to here.
   *
   * @param {string} url - Same origin URL of the extracted source frame.
   * @returns {Promise<string>} The natural size that was decoded, as WxH.
   */
  window.adSetFrame = function adSetFrame(url) {
    var img = document.getElementById('capture-frame');
    img.src = url;
    return img.decode().then(function () {
      return img.naturalWidth + 'x' + img.naturalHeight;
    });
  };

  /**
   * Wait until the compositor has actually produced a frame for the state we
   * just set, or give up after a bounded wait.
   *
   * Two nested requestAnimationFrame callbacks and not one: the first fires
   * before the frame that is about to be produced, the second fires after it,
   * which is the only in page signal that a style change has been composited.
   * The timeout exists because a headless browser that has stopped producing
   * frames would otherwise hang the whole run with no diagnostic at all, and
   * a stalled frame is a far better failure than a stalled build.
   *
   * @returns {Promise<boolean>} True when a frame was composited, false on timeout.
   */
  function composited() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (value) {
        if (!settled) { settled = true; resolve(value); }
      };
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { finish(true); });
      });
      setTimeout(function () { finish(false); }, 500);
    });
  }

  /**
   * Everything one delivered frame needs, in a single round trip.
   *
   * Split across three calls this cost four round trips per frame and roughly a
   * third of the wall clock of a run. The ORDER inside it is the part that
   * matters and is not interchangeable: the capture image is swapped and
   * decoded first, because swapping it dirties the layer the clock was just set
   * against, then the clock is set, then the compositor is allowed to catch up.
   *
   * @param {string} url - Same origin URL of the source frame for this instant.
   * @param {number} timeMs - Time from the start of the ad, in milliseconds.
   * @returns {Promise<object>} What was decoded and how many animations were pinned.
   */
  window.adPrepareFrame = function adPrepareFrame(url, timeMs) {
    return window.adSetFrame(url).then(function (decoded) {
      var pinned = window.adSeek(timeMs);
      return composited().then(function (painted) {
        return { decoded: decoded, pinned: pinned, painted: painted };
      });
    });
  };

  /**
   * Everything the driver needs to assert before it spends two minutes
   * photographing a scene that was already wrong on frame one.
   *
   * @returns {object} Font resolution, line metrics and panel geometry.
   */
  window.adAudit = function adAudit() {
    var stage = need('stage');
    var usable = stage.clientWidth - 2 * parseFloat(getComputedStyle(stage).getPropertyValue('--ad-margin'));
    var lines = [];
    var inks = document.querySelectorAll('.line-ink');
    for (var i = 0; i < inks.length; i++) {
      var rect = inks[i].getBoundingClientRect();
      lines.push({
        text: inks[i].textContent,
        width: Math.round(rect.width),
        overflows: rect.width > usable,
      });
    }

    // The display stack is probed family by family so the report can name the
    // face that actually rendered, rather than claiming the stack "worked".
    var displayCandidates = ['"Segoe UI Variable Display"', '"Segoe UI"', 'ui-sans-serif', 'Arial'];
    var displayResolved = null;
    for (var d = 0; d < displayCandidates.length; d++) {
      if (faceResolves(displayCandidates[d], 700)) { displayResolved = displayCandidates[d]; break; }
    }

    return {
      usableWidth: Math.round(usable),
      lines: lines,
      stage: { width: stage.clientWidth, height: stage.clientHeight },
      monoResolves: faceResolves('"iA Writer Mono"', 400),
      monoLoaded: document.fonts.check('400 38px "iA Writer Mono"'),
      monoBoldLoaded: document.fonts.check('700 28px "iA Writer Mono"'),
      displayResolved: displayResolved,
      animations: document.getAnimations().length,
    };
  };
}());
