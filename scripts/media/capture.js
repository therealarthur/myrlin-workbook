#!/usr/bin/env node
/**
 * capture.js - records every clip and still in the media contract.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHAT IT PRODUCES
 *
 * Raw footage only, into `docs/media/raw/` (gitignored). Nothing here encodes,
 * resizes or ships anything; `encode.js` is a second pass over the same folder.
 * Keeping the two apart is what makes a re-encode at a different frame rate
 * free: the expensive half, driving the application, does not have to run again.
 *
 * WHY page.screencast AND NOT recordVideo
 *
 * Measured on this machine and written up in docs/marketing/RESEARCH-2026-08-18
 * section 3.3: `recordVideo` tops out at exactly 25 fps, while
 * `page.screencast` reached 45.9 fps with overlays and a click active. The
 * screencast API also draws the cursor and the chapter cards, which is the part
 * that would otherwise need a compositor.
 *
 * THE ONE CONSTRAINT THAT SHAPES EVERYTHING
 *
 * Screencast frames are 1x CSS pixels, always, even at deviceScaleFactor 2 and
 * even with maxWidth set. So video is captured at 1440x900 and downscaled to
 * 900px for delivery, which supersamples and keeps text crisp, and STILLS are
 * taken with page.screenshot() at deviceScaleFactor 2 in a separate context.
 * The two cannot share a context, which is why every still scene opens its own.
 *
 * SETUP HAPPENS OFF CAMERA
 *
 * A scene may declare `prepare`, which runs BEFORE the screencast starts. This
 * exists because the first cut of this file ran every clip two to seven times
 * over its contract duration, and almost all of the excess was the camera
 * watching a terminal fill up or a cost dashboard fetch. Anything that has to
 * happen but is not the subject goes in `prepare`; `run` is only the
 * performance. The player's own `--speed` flag does the rest.
 *
 * LOOPS
 *
 * Every animated WebP loops forever, so a clip whose last frame differs from
 * its first jumps once per cycle and reads as broken. Each scene therefore
 * opens on a resting state and closes by returning to that same state, both
 * produced by the same code path so they cannot drift apart. The resting frame
 * is also what the poster is cut from.
 *
 * Usage:
 *   node scripts/media/capture.js                      # every scene
 *   node scripts/media/capture.js hero feature-phone   # named scenes only
 *   node scripts/media/capture.js --list               # names and budgets
 *   node scripts/media/capture.js --headed             # watch it drive
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/capture
 */

'use strict';

const fs = require('fs');
const path = require('path');

const harness = require('./harness');

const PROJECT_ROOT = harness.PROJECT_ROOT;

/** Raw footage lands here. Gitignored: only the encoded delivery is committed. */
const RAW_DIR = path.join(PROJECT_ROOT, 'docs', 'media', 'raw');

/** Desktop capture size. The contract's capture column for every desktop asset. */
const DESKTOP = Object.freeze({ width: 1440, height: 900 });

/** Phone capture size. The contract's phone column, and a real iPhone 14 viewport. */
const PHONE = Object.freeze({ width: 390, height: 844 });

/** JPEG quality the screencast encodes intermediate frames at. */
const SCREENCAST_QUALITY = 92;

/**
 * The cursor overlay, and why `fontSize` is 2 rather than left alone.
 *
 * `showActions` draws two things from one setting: a pointer that animates
 * between action points, and a CAPTION naming the action. The caption's default
 * 24px renders "Mouse move" in a black pill roughly 190px wide, in shot, on
 * every frame of every clip. That is a debugging receipt, which is what the API
 * was built for, and it is not something a marketing clip can carry.
 *
 * MEASURED, because the two are not separately switchable: at `fontSize: 0` the
 * caption disappears and so does the pointer, and at `fontSize: 2` the pointer
 * renders in full while the caption shrinks to a pill about 25x10px at capture
 * size, which is 16x6 after the downscale to 900px and illegible. So 2 is the
 * setting that keeps the half of this API the contract asked for and drops the
 * half it did not.
 *
 * `duration` is deliberately LEFT AT ITS DEFAULT. Raising it to 1200ms to keep
 * the pointer drawn for longer looked like a free improvement and was not:
 * every mouse call then blocks for the annotation's duration, and the whole set
 * went from inside its budgets to 60 to 90 percent over in one run. The cursor
 * blinking out between beats is the cheaper problem.
 */
const ACTION_OPTIONS = Object.freeze({
  cursor: 'pointer',
  fontSize: 2,
  position: 'bottom-right',
});

/** How long a resting frame is held at the start and end of every clip. */
const REST_MS = 520;

/**
 * How long a chapter card stays on screen.
 *
 * `showChapter` blocks for this, so each card is a straight subtraction from
 * the clip's budget. Three cards at 1.1 s is 3.3 s of a thirty second hero,
 * which is what a title is worth; a fourth was cut rather than shortening them
 * all to the point of being unreadable.
 */
const CHAPTER_MS = 1000;

/** Pause after a click before the next beat, so the result is readable. */
const BEAT_MS = 450;

/** Pause after a view switch, which re-renders a whole panel. */
const VIEW_MS = 800;

/** Pause after switching to a view that fetches before it can draw. */
const FETCH_MS = 1500;

/** How long to wait for the fake agent to reach a given marker, off camera. */
const AGENT_TIMEOUT_MS = 60000;

/** How long an on-camera wait for the player may take before the clip moves on. */
const AGENT_ONCAMERA_MS = 9000;

/**
 * Steps a scripted mouse move is broken into, so the cursor overlay animates.
 *
 * MEASURED, not chosen by feel: every step is a separate CDP round trip, and at
 * twelve steps the moves alone cost 5.6 s of a twelve second clip. Five keeps
 * the cursor reading as a glide rather than a jump while costing a third of
 * that. Raise it only if a clip's cursor starts to look mechanical, and check
 * the `move` line of CWM_MEDIA_TRACE afterwards.
 */
const MOVE_STEPS = 4;

/**
 * How long any selector lookup in a scene may block, in milliseconds.
 *
 * THIS NUMBER IS LOAD BEARING. `locator.boundingBox()` waits for the element
 * with Playwright's DEFAULT 30 second timeout, and a `.catch(() => null)` around
 * it swallows the failure without shortening the wait. The first tuned cut of
 * these scenes ran 57 s for a 30 s hero and 74 s for a 12 s Codex clip, and
 * essentially all of the excess was two selectors missing and costing 30 s each
 * while the camera recorded a frozen frame.
 *
 * Two seconds is well past any render this application performs after an action
 * the scene has already awaited, so a miss here means the element genuinely is
 * not there, which is worth knowing about immediately rather than in a minute.
 */
const SELECTOR_TIMEOUT_MS = 2000;

/** How long to wait for /api/discover to populate before opening a Codex pane. */
const DISCOVERY_TIMEOUT_MS = 20000;

/**
 * Selectors that were asked for and not found, in order.
 *
 * Collected rather than thrown, because one missing affordance should cost a
 * beat rather than the whole shoot, and printed at the end of the run so it is
 * never silent either.
 */
const missedSelectors = [];

/**
 * Where a scene's on-camera time actually went, by primitive.
 *
 * Driving a browser is not free and the costs are not obvious: a twelve-step
 * `mouse.move` is twelve round trips, and `mouse.wheel` waits for the page to
 * finish handling the event, which on a view this size is a few hundred
 * milliseconds rather than the nothing it looks like in the source. A scene
 * whose scripted pauses sum to eight seconds ran for twenty, and no amount of
 * reading the code showed why.
 *
 * So the primitives account for themselves. `CWM_MEDIA_TRACE=1` prints the
 * table after every take, which is what turns "shorten it somehow" into
 * "MOVE_STEPS costs 4.1 s of this clip".
 */
const timing = { move: 0, click: 0, wheel: 0, settle: 0, chapter: 0, agent: 0, app: 0 };

/**
 * Run an operation and bill its wall time to a bucket.
 *
 * @param {string} bucket - Key in `timing`.
 * @param {Function} fn - The operation.
 * @returns {Promise<*>} Whatever the operation returned.
 */
async function billed(bucket, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    timing[bucket] += Date.now() - startedAt;
  }
}

/**
 * Reset the timing buckets before a take.
 *
 * @returns {void}
 */
function resetTiming() {
  for (const key of Object.keys(timing)) timing[key] = 0;
}

/**
 * Render the timing table for a finished take.
 *
 * @returns {string} One line per bucket, or an empty string when not tracing.
 */
function timingReport() {
  if (!process.env.CWM_MEDIA_TRACE) return '';
  return Object.keys(timing)
    .map((key) => '    ' + key.padEnd(8) + (timing[key] / 1000).toFixed(1) + 's')
    .join('\n') + '\n';
}

/**
 * Locate an element, quickly, and record a miss rather than stalling on one.
 *
 * @param {object} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @returns {Promise<object|null>} The bounding box, or null when not found.
 */
async function boxOf(page, selector) {
  const box = await page.locator(selector).first()
    .boundingBox({ timeout: SELECTOR_TIMEOUT_MS })
    .catch(() => null);
  if (!box) missedSelectors.push(selector);
  return box;
}

/**
 * Player speed multipliers, by role.
 *
 * `onCamera` is the rate the hero streams output at while the camera watches:
 * fast enough that a 30 second tour can afford it, slow enough that a viewer
 * sees text arriving rather than appearing. `offCamera` is for a pane that has
 * to be full before recording starts, where the only thing that matters is how
 * soon that is true.
 */
const PLAYER_SPEED = Object.freeze({ onCamera: 0.22, offCamera: 0.12 });

/**
 * The last line scripts/media/fake-agent.js prints before it parks at a prompt.
 *
 * Used as the "the turn is over" marker because it is still on screen when the
 * player stops. A marker from the middle of the script is not: `.xterm-screen`
 * holds only the VISIBLE rows, and by the time the player finishes, the middle
 * of the transcript has scrolled into the buffer where no selector reaches it.
 * Waiting on one of those is how a scene silently burns its whole timeout and
 * still photographs the right frame, which is worse than failing outright.
 */
const PLAYER_DONE_MARKER = 'Done.';

/* ── Small driving helpers ────────────────────────────────────────────────── */

/**
 * Hold the current frame.
 *
 * @param {object} page - Playwright page.
 * @param {number} [ms] - Milliseconds to hold.
 * @returns {Promise<void>} Resolves after the hold.
 */
function settle(page, ms) {
  return billed('settle', () => page.waitForTimeout(ms === undefined ? BEAT_MS : ms));
}

/**
 * Move the pointer to the centre of an element, visibly.
 *
 * Broken into steps on purpose: `showActions` draws a cursor, and a single
 * jump teleports it, which reads as a glitch rather than as a person.
 *
 * @param {object} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @returns {Promise<{x: number, y: number}|null>} The point moved to, or null.
 */
async function moveTo(page, selector) {
  const box = await boxOf(page, selector);
  if (!box) return null;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await billed('move', () => page.mouse.move(point.x, point.y, { steps: MOVE_STEPS }));
  return point;
}

/**
 * Move to an element and click it.
 *
 * Returns false rather than throwing when the element is not there, so one
 * missing affordance costs a beat instead of the whole shoot.
 *
 * @param {object} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @param {number} [pauseMs] - How long to hold after the click.
 * @returns {Promise<boolean>} True when the click landed.
 */
async function clickOn(page, selector, pauseMs) {
  const point = await moveTo(page, selector);
  if (!point) return false;
  await settle(page, 150);
  // down/up rather than click(), because click() performs its own move to the
  // point first and moveTo has already put the pointer there. That redundant
  // move is a full CDP round trip per click, and there are five of them in the
  // shortest clip in the set.
  await billed('click', async () => {
    await page.mouse.down({ button: 'left' });
    await page.mouse.up({ button: 'left' });
  });
  await settle(page, pauseMs === undefined ? BEAT_MS : pauseMs);
  return true;
}

/**
 * Scroll a surface with the wheel, in several notches.
 *
 * One big delta is a jump cut. Several notches with a frame between them is a
 * scroll, which is what the clip is supposed to show.
 *
 * @param {object} page - Playwright page.
 * @param {string} selector - Element to scroll over.
 * @param {number} deltaY - Per-notch delta. Negative scrolls up.
 * @param {number} notches - How many notches.
 * @returns {Promise<void>} Resolves once scrolled.
 */
async function wheelOver(page, selector, deltaY, notches) {
  const point = await moveTo(page, selector);
  if (!point) return;
  // Each wheel dispatch waits for the page to finish handling the event, which
  // on a full-height list is a few hundred milliseconds. Fewer, larger notches
  // buy back seconds and still read as a scroll rather than a jump.
  for (let i = 0; i < notches; i++) {
    await billed('wheel', () => page.mouse.wheel(0, deltaY));
    await settle(page, 80);
  }
}

/**
 * Show a chapter card and hold on it.
 *
 * `showChapter` resolves only after the card's own duration has elapsed, so a
 * scene must NOT also sleep for CHAPTER_MS afterwards: doing that showed each
 * card for its duration and then held a card-less frame for the same length
 * again, which cost the hero five wasted seconds out of thirty.
 *
 * @param {object} page - Playwright page.
 * @param {string} title - Card title.
 * @param {string} description - Card subtitle.
 * @returns {Promise<void>} Resolves once the card has come and gone.
 */
async function chapter(page, title, description) {
  await billed('chapter', () => page.screencast.showChapter(title, {
    description,
    duration: CHAPTER_MS,
  }));
}

/**
 * Run an app-driving evaluate and bill it.
 *
 * @param {object} page - Playwright page.
 * @param {Function} fn - Page function.
 * @param {*} [arg] - Argument passed into the page.
 * @returns {Promise<*>} Whatever the page function returned.
 */
function inApp(page, fn, arg) {
  return billed('app', () => page.evaluate(fn, arg));
}

/**
 * The smallest corner radius that reads as a capsule rather than a corner.
 *
 * The same threshold gate G16 uses, and for the same reason: this app's radius
 * scale puts every property chip at 4px and every capsule at 10px or 999px, so
 * the gap between them is wide and nothing legitimate sits in it.
 */
const CAPSULE_GUARD_MIN_RADIUS_PX = 9;

/**
 * A capsule taller than this is a card, and a mark on a card is allowed.
 *
 * `.mobile-session-card` is a 10px bordered box at least 56px tall with a
 * leading `.status-dot`, which is the idiom the design rule asks FOR. The
 * banned pattern is a small inline capsule with a dot inside it, so the guard
 * needs a way to tell a chip from a card. Inline-level display is the primary
 * test and this height is the fallback for a flex chip that never declares one.
 */
const CAPSULE_GUARD_MAX_HEIGHT_PX = 32;

/**
 * Fail the take if the settled page draws a capsule with a dot inside it.
 *
 * WHY THIS LIVES IN THE CAPTURE AND NOT ONLY IN THE GATE.
 *
 * The user's standing rule of 2026-08-13 bans the status pill containing a dot
 * indicator in every form. Gate G16 enforces it over the SOURCE: it resolves
 * the `--radius-*` chain, works out which classes compose into a capsule, and
 * walks the markup for a dot inside one. That is a strong gate and it is still
 * a static one. It cannot see a capsule composed at runtime by two class lists
 * that never appear together in the source, by an inline style a renderer
 * computes, or by a third-party surface. The footage is the artifact that
 * actually ships to a README and a landing page, so the footage gets a guard of
 * its own, and this one asks the browser rather than the text: real computed
 * styles, real geometry, on the frame about to be recorded.
 *
 * This is what makes the ban structural at the SOURCE OF THE FOOTAGE. The
 * previous media set was shot before the fix and every frame of it carried the
 * pill; the ad crops were even authored to work around it (`x=838` stopped at
 * the boundary before the Status column). A guard that fails the take is the
 * only thing that turns "remember to check the frames" into a property.
 *
 * @param {object} page - Playwright page.
 * @param {string} label - Where in the take this ran, for the error message.
 * @returns {Promise<void>} Resolves when the page is clean, rejects when it is not.
 */
async function assertNoCapsuleDots(page, label) {
  const offenders = await page.evaluate(({ minRadius, maxHeight }) => {
    /**
     * A readable identity for an element, for the failure message.
     *
     * @param {Element} el - The element.
     * @returns {string} Tag name plus class list.
     */
    const describe = (el) => {
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).join('.');
      return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
    };

    /**
     * Whether an element's class list names it a dot.
     *
     * @param {Element} el - The element.
     * @returns {boolean} True when a class segment is dot or dots.
     */
    const isDot = (el) => /(^|[\s-])dots?([\s-]|$)/.test((el.getAttribute('class') || '').toLowerCase());

    /**
     * The largest corner radius in pixels, resolving percentages against the box.
     *
     * @param {string} value - One computed corner value, px or percent.
     * @param {DOMRect} box - The element's box.
     * @returns {number} Radius in pixels.
     */
    const radiusPx = (value, box) => {
      let max = 0;
      for (const part of String(value).split(/[\s/]+/)) {
        if (part.endsWith('%')) {
          const pct = parseFloat(part);
          if (!Number.isNaN(pct)) max = Math.max(max, (pct / 100) * Math.min(box.width, box.height));
        } else if (part.endsWith('px')) {
          const px = parseFloat(part);
          if (!Number.isNaN(px)) max = Math.max(max, px);
        }
      }
      return max;
    };

    /**
     * The alpha channel of a computed colour.
     *
     * @param {string} colour - A computed rgb() or rgba() string.
     * @returns {number} Alpha, 0 when the colour is absent or transparent.
     */
    const alphaOf = (colour) => {
      const m = /rgba?\(([^)]+)\)/.exec(colour || '');
      if (!m) return 0;
      const parts = m[1].split(',').map((n) => parseFloat(n));
      return parts.length > 3 ? parts[3] : 1;
    };

    const found = [];
    for (const el of document.querySelectorAll('*')) {
      if (found.length >= 6) break;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      const radius = Math.max(
        radiusPx(style.borderTopLeftRadius, box),
        radiusPx(style.borderTopRightRadius, box),
        radiusPx(style.borderBottomLeftRadius, box),
        radiusPx(style.borderBottomRightRadius, box)
      );
      if (radius < minRadius) continue;
      const filled = alphaOf(style.backgroundColor) > 0.02 ||
        (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none' &&
          alphaOf(style.borderTopColor) > 0.02);
      if (!filled) continue;
      // A card is allowed to carry a leading mark; a chip is not. Inline-level
      // display is what separates the two, with a height fallback for a flex
      // chip that never declares one.
      const inlineLevel = style.display.indexOf('inline') === 0;
      if (!inlineLevel && box.height > maxHeight) continue;
      const dot = Array.prototype.find.call(el.querySelectorAll('*'), isDot);
      if (!dot) continue;
      found.push(describe(el) + ' encloses ' + describe(dot));
    }
    return found;
  }, { minRadius: CAPSULE_GUARD_MIN_RADIUS_PX, maxHeight: CAPSULE_GUARD_MAX_HEIGHT_PX });

  if (offenders.length) {
    throw new Error(
      'capsule-with-a-dot on screen at ' + label + ', which the standing UI rule bans ' +
      'in every form and gate G16 enforces in the source:\n  ' + offenders.join('\n  ') +
      '\nFix the styling before re-shooting; a frame carrying this pattern must not ship.'
    );
  }
}

/**
 * Park the pointer where nothing is hovered.
 *
 * A hover state left on a control is the most common reason two "identical"
 * resting frames differ by a few pixels, which is exactly what a looping WebP
 * shows as a flicker once per cycle.
 *
 * @param {object} page - Playwright page.
 * @param {{width: number, height: number}} viewport - The scene's viewport.
 * @returns {Promise<void>} Resolves once parked.
 */
async function parkPointer(page, viewport) {
  await page.mouse.move(6, viewport.height - 8, { steps: 4 });
}

/**
 * Open a terminal pane running the fake agent.
 *
 * The pane runs scripts/media/fake-agent.js rather than a real CLI. That is not
 * only about determinism: a real CLI in this sandbox has no credentials, fails,
 * and prints the sandbox path into the frame, which would put the operator's
 * user name in a public README. The player cannot do that, because it prints a
 * fixed script and reads nothing.
 *
 * @param {object} session - Harness session handle.
 * @param {object} page - Playwright page.
 * @param {number} slot - Pane index.
 * @param {string} sessionId - Provider session id to attach the pane to.
 * @param {string} title - Pane title.
 * @param {string} provider - Provider tag, which drives the pane's identity chip.
 * @param {string} variant - Which of the player's stories to run.
 * @param {number} speed - Player speed multiplier.
 * @returns {Promise<void>} Resolves once the pane exists.
 */
async function openAgentPane(session, page, slot, sessionId, title, provider, variant, speed) {
  // Re-waited here rather than trusted from boot: on a phone context the
  // harness lets this one go, and a pane scene is exactly where it matters.
  await harness.waitForTerminalGroups(page);

  // DISCOVERY MUST HAVE LANDED FIRST, for a Codex pane.
  //
  // The pane resolves its provider tag by looking the session id up in the
  // discovered roster, and stamps it on `#term-pane-N[data-provider]`. The
  // detail strip renders only when that attribute reads "codex". Open the pane
  // before /api/discover has come back and the lookup misses, the pane is
  // tagged as the default provider, and the strip never appears. It is a race,
  // so it fails intermittently, which is the worst way for it to fail: one take
  // in three came back with no strip and a cursor hovering nothing.
  if (provider === 'codex') {
    await page.waitForFunction(
      (id) => {
        const state = (window.cwm && window.cwm.state) || {};
        const buckets = state.projectsByProvider || {};
        const list = buckets.codex || [];
        return Array.isArray(list) && list.some(
          (project) => (project.sessions || []).some((row) => row.claudeSessionId === id || row.id === id)
        );
      },
      sessionId,
      { timeout: DISCOVERY_TIMEOUT_MS }
    ).catch(() => { /* the strip beat degrades to a pause rather than a stall */ });
  }

  const command = session.fakeAgentCommand +
    ' --variant ' + variant +
    ' --speed ' + String(speed);
  await page.evaluate(({ slotIdx, sid, name, prov, cmd }) => {
    window.cwm.openTerminalInPane(slotIdx, sid, name, { command: cmd, provider: prov });
    // Idempotent by design, and asked for explicitly rather than waited for:
    // the strip is otherwise painted by whichever of four call sites fires
    // first, and one of them is a discovery refresh that may already have run.
    if (typeof window.cwm._renderCodexStatusStrip === 'function') {
      window.cwm._renderCodexStatusStrip(slotIdx);
    }
  }, { slotIdx: slot, sid: sessionId, name: title, prov: provider, cmd: command });
}

/**
 * Wait until a pane's screen contains a marker the player prints.
 *
 * Resolves either way. An empty pane is a worse picture than a full one, but
 * losing the whole shoot because one player was slow to start is worse still.
 *
 * @param {object} page - Playwright page.
 * @param {number} slot - Pane index.
 * @param {string} marker - Text to wait for.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves when the marker appears or the wait expires.
 */
async function waitForPaneText(page, slot, marker, timeoutMs) {
  await billed('agent', () => page.waitForFunction(
    ({ i, text }) => {
      const screen = document.querySelector('#term-pane-' + i + ' .xterm-screen');
      return !!screen && screen.textContent.indexOf(text) !== -1;
    },
    { i: slot, text: marker },
    { timeout: timeoutMs || AGENT_TIMEOUT_MS }
  ).catch(() => { /* photographed as it stands */ }));
}

/**
 * Wait until a pane has painted its first rows.
 *
 * @param {object} page - Playwright page.
 * @param {number} slot - Pane index.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves once rows have painted.
 */
async function waitForPaneBusy(page, slot, timeoutMs) {
  await billed('agent', () => page.waitForFunction(
    (i) => {
      const screen = document.querySelector('#term-pane-' + i + ' .xterm-screen');
      return !!screen && screen.textContent.trim().length > 120;
    },
    slot,
    { timeout: timeoutMs || AGENT_TIMEOUT_MS }
  ).catch(() => { /* an empty surface is still a picture of the surface */ }));
}

/**
 * Wait until a pane's player has finished its turn.
 *
 * @param {object} page - Playwright page.
 * @param {number} slot - Pane index.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves once the turn has finished.
 */
async function waitForPaneDone(page, slot, timeoutMs) {
  await waitForPaneText(page, slot, PLAYER_DONE_MARKER, timeoutMs);
}

/**
 * Kill every PTY this run started and drop its pane.
 *
 * The kill matters more than the dispose: dispose() closes the client socket
 * while the child process on the server side keeps running, so a shoot that
 * opened six panes would leave six players behind for the teardown to reap.
 *
 * @param {object} page - Playwright page.
 * @returns {Promise<void>} Resolves once the panes are gone.
 */
async function closeAllPanes(page) {
  await page.evaluate(async () => {
    const panes = window.cwm.terminalPanes || [];
    for (let i = 0; i < panes.length; i++) {
      const pane = panes[i];
      if (!pane) continue;
      if (pane.sessionId) {
        try {
          await window.cwm.api('POST', '/api/pty/' + encodeURIComponent(pane.sessionId) + '/kill');
        } catch (_) { /* an already-dead session is the outcome we wanted */ }
      }
      try { if (typeof pane.dispose === 'function') pane.dispose(); } catch (_) { /* gone */ }
      panes[i] = null;
    }
  }).catch(() => { /* the page may already be closing */ });
}

/**
 * Put the app in the state a desktop clip opens and closes on.
 *
 * One function, called at both ends of every scene that uses it, is what
 * guarantees the loop has no jump: the first and last frames are produced by
 * the same code path rather than by two sequences that happen to agree.
 *
 * @param {object} page - Playwright page.
 * @param {{chrome?: string, theme?: string, viewport?: object, hold?: number}} [opts] - Resting appearance.
 * @returns {Promise<void>} Resolves once the app has settled.
 */
async function restingState(page, opts) {
  const options = opts || {};
  await page.evaluate(({ chrome, theme }) => {
    if (typeof window.cwm.setChrome === 'function') window.cwm.setChrome(chrome || 'dark');
    if (typeof window.cwm.setTheme === 'function') window.cwm.setTheme(theme || 'mocha');
    window.cwm.setViewMode('workspace');
    if (typeof window.cwm.setProjectsCollapsed === 'function') window.cwm.setProjectsCollapsed(false, false);
    if (typeof window.cwm.renderProjects === 'function') window.cwm.renderProjects();
    if (typeof window.cwm.renderProviderTabs === 'function') window.cwm.renderProviderTabs();
  }, { chrome: options.chrome, theme: options.theme });
  await parkPointer(page, options.viewport || DESKTOP);
  await settle(page, options.hold === undefined ? REST_MS : options.hold);
}

/* ── Scenes ───────────────────────────────────────────────────────────────── */

/**
 * The 30 second tour.
 *
 * DEVIATION FROM THE CONTRACT, recorded here rather than only in the report:
 * the contract's hero beat list includes "phone beat". A screencast fixes its
 * frame size when it starts, and a phone viewport is a different frame size, so
 * a phone beat inside one continuous desktop recording would either letterbox
 * the whole clip or change its dimensions mid-file. The phone is covered by its
 * own clip, feature-phone.webp, at the phone's own size, which is also how the
 * contract's own asset table presents it. The freed seconds go to the cost view
 * and the board, which the contract lists as the alternative final beat.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when the tour has been driven.
 */
async function sceneHero(ctx) {
  const { page, session } = ctx;
  const claudeSession = session.fixture.claude[0].spec;
  const codexSession = session.fixture.codex[0].spec;

  await restingState(page);

  await chapter(page, 'Every session on your machine',
    'Claude Code and Codex, discovered from disk');
  await wheelOver(page, '#projects-list', 300, 1);
  await settle(page, 320);
  await wheelOver(page, '#projects-list', -300, 1);
  await clickOn(page, '.sidebar-tab[data-provider="codex"]', 460);
  await clickOn(page, '.sidebar-tab[data-provider="all"]', 300);

  await chapter(page, 'Open one, and read all of it',
    'A real terminal, with its scrollback and a selection you can copy');
  await inApp(page, () => window.cwm.setViewMode('terminal'));
  await settle(page, 450);
  await openAgentPane(session, page, 0, claudeSession.id, claudeSession.title,
    'claude', 'checkout', PLAYER_SPEED.onCamera);
  await waitForPaneBusy(page, 0, AGENT_ONCAMERA_MS);
  await settle(page, 950);
  await waitForPaneDone(page, 0, AGENT_ONCAMERA_MS);
  await wheelOver(page, '#term-pane-0 .xterm-screen', -460, 2);
  await settle(page, 220);
  await dragSelectInPane(page, 0);
  await settle(page, 420);
  await wheelOver(page, '#term-pane-0 .xterm-screen', 700, 2);
  await settle(page, 200);

  await chapter(page, 'Codex, the same way',
    'Model, effort, approval and sandbox, read from the session');
  await openAgentPane(session, page, 1, codexSession.id, codexSession.title,
    'codex', 'push', PLAYER_SPEED.onCamera);
  await waitForPaneBusy(page, 1, AGENT_ONCAMERA_MS);
  await settle(page, 550);
  await moveTo(page, '#term-pane-1 .codex-status-chip[data-chip="effort"]');
  await settle(page, 600);

  // COST, NOT THE BOARD. The contract's last hero beat is "cost or board", and
  // this takes the cost view: the board is the entire subject of
  // feature-board.webp, and the two seconds a board beat costs here buys
  // nothing the set does not already have. A tour that visits every surface
  // holds none of them long enough to read.
  await closeAllPanes(page);
  await inApp(page, () => window.cwm.setViewMode('costs'));
  await settle(page, FETCH_MS);
  await wheelOver(page, '#costs-panel', 520, 1);
  await settle(page, 1100);

  await restingState(page);
}

/**
 * Open two live panes off camera, then hand the view back to the caller.
 *
 * WHY A CLIP THAT NEVER SHOWS A TERMINAL STILL OPENS TWO OF THEM.
 *
 * The review of the first media set found every session in every frame reading
 * as stopped. Half of that was the fixture, which gave all fifteen tracked
 * sessions one status and is fixed in `fixture.js` by SESSION_STATUS. The other
 * half is this: the sidebar draws LIVENESS, not tracked status, so the pips,
 * the live dots and the pane indicators next to a project are all answering
 * "is anything attached to this right now", and in a shoot where nothing was
 * ever attached the honest answer was no. A clip whose subject is the sidebar
 * should be shot with the application in the state the sidebar exists to
 * describe.
 *
 * The panes are opened at the player's off-camera speed and waited on only
 * until they have painted, not until the turn finishes. Nothing here is the
 * subject, so nothing here needs to be complete; it needs to be ALIVE.
 *
 * The two sessions are deliberately the two that `fixture.js` marks running, so
 * no frame claims a session is running while its pane sits empty.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves once both panes are live.
 */
async function openTwoLivePanes(ctx) {
  const { page, session } = ctx;
  const claudeSession = session.fixture.claude[0].spec;
  const codexSession = session.fixture.codex[0].spec;
  await page.evaluate(() => window.cwm.setViewMode('terminal'));
  await settle(page, VIEW_MS);
  await openAgentPane(session, page, 0, claudeSession.id, claudeSession.title,
    'claude', 'checkout', PLAYER_SPEED.offCamera);
  await openAgentPane(session, page, 1, codexSession.id, codexSession.title,
    'codex', 'push', PLAYER_SPEED.offCamera);
  await waitForPaneBusy(page, 0, AGENT_TIMEOUT_MS);
  await waitForPaneBusy(page, 1, AGENT_TIMEOUT_MS);
}

/**
 * Stand two live panes up before the sidebar clip rolls.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when prepared.
 */
async function prepareFeatureSidebar(ctx) {
  const { page } = ctx;
  await openTwoLivePanes(ctx);
  await restingState(page, { hold: 300 });
}

/**
 * Sidebar and discovery.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when driven.
 */
async function sceneFeatureSidebar(ctx) {
  const { page } = ctx;
  await restingState(page);

  await clickOn(page, '.sidebar-tab[data-provider="codex"]', 420);
  await clickOn(page, '.sidebar-tab[data-provider="all"]', 240);
  await clickOn(page, '#projects-list .project-accordion-header', 500);
  await wheelOver(page, '#projects-list', 320, 2);
  await settle(page, 340);
  await wheelOver(page, '#projects-list', -320, 2);

  await restingState(page);
}

/**
 * Fill the terminal before the camera rolls.
 *
 * The clip's subject is reading back a long session, which needs a long session
 * to already exist. Watching one arrive costs eighteen seconds the twelve second
 * budget does not have, so the player runs at its off-camera speed here and the
 * recording starts on a full pane.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when the pane is full.
 */
async function prepareFeatureTerminal(ctx) {
  const { page, session } = ctx;
  const claudeSession = session.fixture.claude[0].spec;
  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setTheme('mocha');
    window.cwm.setViewMode('terminal');
  });
  await settle(page, VIEW_MS);
  await openAgentPane(session, page, 0, claudeSession.id, claudeSession.title,
    'claude', 'checkout', PLAYER_SPEED.offCamera);
  await waitForPaneDone(page, 0);
  await parkPointer(page, DESKTOP);
  await settle(page, 600);
}

/**
 * The terminal: scrollback, a selection across the seam, a copy.
 *
 * ONE pane, deliberately, not the two the hero shows. The scrollback document
 * wraps on CSS pixels, so a half-width pane wraps lines the live terminal does
 * not, and the clip whose whole subject is "you can read your history" should
 * not be the one showing wrapped history.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when driven.
 */
async function sceneFeatureTerminal(ctx) {
  const { page } = ctx;
  await settle(page, REST_MS);

  await wheelOver(page, '#term-pane-0 .xterm-screen', -400, 2);
  await settle(page, 460);
  await dragSelectInPane(page, 0);
  await settle(page, 400);
  await copySelection(page);
  await settle(page, 1000);
  await wheelOver(page, '#term-pane-0 .xterm-screen', 620, 2);
  await settle(page, 320);

  // DROP THE SELECTION BEFORE THE RESTING FRAME.
  //
  // MEASURED: with the selection left standing, this clip's first and last
  // frames differed on 28.02 percent of their pixels, against 0.00 to 0.41 for
  // every other clip in the set. The whole highlighted block is drawn on the
  // last frame and absent from the first, so the loop flashed a lavender wash
  // across a third of the terminal once per cycle. The copy has already
  // happened by this point, so nothing about the beat is lost; only the
  // artefact of it is. Both selection systems are cleared because the drag may
  // have run over either surface: the history document is an ordinary DOM
  // selection, the live screen is xterm's own.
  await inApp(page, () => {
    const selection = window.getSelection();
    if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
    const panes = window.cwm.terminalPanes || [];
    for (const pane of panes) {
      if (pane && pane.term && typeof pane.term.clearSelection === 'function') pane.term.clearSelection();
    }
  });
  await settle(page, 200);

  await parkPointer(page, DESKTOP);
  await settle(page, REST_MS);
}

/**
 * Stand up the Codex sidebar and a Codex pane before the camera rolls.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when prepared.
 */
async function prepareFeatureCodex(ctx) {
  const { page, session } = ctx;
  const codexSession = session.fixture.codex[0].spec;
  await restingState(page, { hold: 200 });
  await page.evaluate(() => {
    const tab = document.querySelector('.sidebar-tab[data-provider="codex"]');
    if (tab) tab.click();
  });
  await settle(page, 500);
  await page.evaluate(() => {
    const header = document.querySelector('#projects-list .project-accordion-header');
    if (header) header.click();
  });
  await settle(page, 400);
  await page.evaluate(() => window.cwm.setViewMode('terminal'));
  await settle(page, VIEW_MS);
  await openAgentPane(session, page, 0, codexSession.id, codexSession.title,
    'codex', 'push', PLAYER_SPEED.offCamera);
  await waitForPaneDone(page, 0);
  // The detail strip is appended by _renderCodexStatusStrip after the pane
  // mounts, and the on-camera beat points a cursor straight at one of its
  // chips. Waiting for it HERE, off camera, is the difference between a clip
  // that hovers a chip and a clip that hovers nothing for two seconds while
  // the selector times out.
  await page.waitForSelector('#term-pane-0 .codex-status-chip[data-chip="effort"]',
    { timeout: 15000 }).catch(() => { /* the strip beat degrades to a pause */ });
  await page.evaluate(() => window.cwm.setViewMode('workspace'));
  await parkPointer(page, DESKTOP);
  await settle(page, 600);
}

/**
 * Codex parity: the folders, the threads, the detail strip, an edit.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when driven.
 */
async function sceneFeatureCodex(ctx) {
  const { page } = ctx;
  await settle(page, REST_MS);

  await moveTo(page, '#projects-list .project-accordion-header');
  await settle(page, 620);
  await page.evaluate(() => window.cwm.setViewMode('terminal'));
  await settle(page, 900);
  await moveTo(page, '#term-pane-0 .codex-status-chip[data-chip="effort"]');
  await settle(page, 700);
  await clickOn(page, '#term-pane-0 .codex-status-chip[data-chip="effort"]', 1200);
  await page.keyboard.press('Escape');
  await settle(page, 520);
  await page.evaluate(() => window.cwm.setViewMode('workspace'));
  await settle(page, 700);
  await parkPointer(page, DESKTOP);
  await settle(page, REST_MS);
}

/**
 * Put the phone in the state its clip opens and closes on.
 *
 * The same argument as `restingState` for the desktop, and it was missing: the
 * phone clip used to open on `setViewMode('workspace')` and close on a tap of
 * the Sessions tab followed by the same call, which is two sequences that
 * HAPPEN to agree rather than one code path called twice. A loop whose ends
 * agree by coincidence stops agreeing the first time somebody edits one of
 * them, and an animated WebP shows that as a jump once per cycle.
 *
 * @param {object} page - Playwright page.
 * @param {number} [hold] - How long to hold the resting frame.
 * @returns {Promise<void>} Resolves once the phone has settled.
 */
async function phoneRestingState(page, hold) {
  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setViewMode('workspace');
  });
  await parkPointer(page, PHONE);
  await settle(page, hold === undefined ? REST_MS : hold);
}

/**
 * Give the phone clip a live session before it opens the Terminal tab.
 *
 * WHAT THE REVIEW FOUND. The Terminal beat of the first phone clip was an EMPTY
 * PANE. Nothing had ever been spawned in the phone context, so the tab opened
 * on the grid's placeholder, the keyboard then rose over nothing, and the long
 * press that followed was held over a blank surface. The clip's whole claim is
 * that the product is a complete client on a phone, and the beat that carries
 * that claim was a picture of an empty box.
 *
 * The pane is opened off camera at the player's off-camera speed and waited on
 * until the turn has FINISHED, not merely started, so the Terminal tab opens on
 * a full transcript rather than on three lines still arriving. That wait is
 * free: it happens before the screencast starts.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when prepared.
 */
async function prepareFeaturePhone(ctx) {
  const { page, session } = ctx;
  const claudeSession = session.fixture.claude[0].spec;
  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setViewMode('terminal');
  });
  await settle(page, VIEW_MS);
  await openAgentPane(session, page, 0, claudeSession.id, claudeSession.title,
    'claude', 'checkout', PLAYER_SPEED.offCamera);
  await waitForPaneDone(page, 0);
  await phoneRestingState(page, 400);
}

/**
 * The phone: the five-tab bar, a live session, the keyboard, a long press.
 *
 * The keyboard rise cannot be produced by pressing a key. `mobile-viewport.js`
 * derives it from window.visualViewport, and a headless browser has no soft
 * keyboard, so the geometry is supplied directly and the module's own apply()
 * is asked to read it. Everything downstream, the custom properties and the
 * body classes, is then computed by the shipped code rather than faked. The
 * pane's own input is focused first, so the rise has a cause on screen: a
 * keyboard that appears with nothing focused reads as a glitch.
 *
 * The long press is the same story in reverse: `_mwBindLongPress` only listens
 * for real TouchEvents, so the sheet is opened through the application's own
 * public entry point instead of by simulating a finger for 450 ms. It is held
 * over CONTENT rather than over a tab: `_openMobileSessionSheetFor` is the
 * handler a hold on a Home session card actually runs, and with a live pane and
 * two running sessions in the fixture there is now a card to hold. The two
 * fallbacks below it exist so the beat degrades to a different sheet rather
 * than to a dead pause if the recency list has not populated.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when driven.
 */
async function sceneFeaturePhone(ctx) {
  const { page } = ctx;

  await phoneRestingState(page);

  await clickOn(page, '.mobile-tab[data-view="home"]', 700);
  await clickOn(page, '.mobile-tab[data-view="sessions"]', 620);

  // The Terminal tab, now with a transcript behind it.
  await clickOn(page, '.mobile-tab[data-view="terminal"]', 900);
  await inApp(page, () => {
    const input = document.querySelector('#term-pane-0 .terminal-mobile-input-row .mobile-type-input') ||
      document.querySelector('.terminal-mobile-input-row .mobile-type-input');
    if (input && typeof input.focus === 'function') input.focus();
  });
  await settle(page, 260);
  await setKeyboardInset(page, 336);
  await settle(page, 1350);
  await setKeyboardInset(page, 0);
  await inApp(page, () => {
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
  });
  await settle(page, 620);

  // The hold, over a session card on Home.
  await clickOn(page, '.mobile-tab[data-view="home"]', 620);
  const held = await inApp(page, () => {
    const card = document.querySelector('.mobile-session-card[data-recent-key]') ||
      document.querySelector('.mobile-recent-row[data-recent-key]');
    if (card && typeof window.cwm._openMobileSessionSheetFor === 'function') {
      const box = card.getBoundingClientRect();
      const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
      if (window.cwm._openMobileSessionSheetFor(card, point)) return 'card';
    }
    if (typeof window.cwm.showMobilePaneOverflow === 'function') {
      window.cwm.showMobilePaneOverflow(0);
      return 'pane';
    }
    if (typeof window.cwm.showMobileTabQuickActions === 'function') {
      window.cwm.showMobileTabQuickActions('sessions');
      return 'tab';
    }
    return 'none';
  });
  if (held === 'none') missedSelectors.push('phone long-press target');
  await settle(page, 1500);
  await page.evaluate(() => {
    if (typeof window.cwm.hideActionSheet === 'function') window.cwm.hideActionSheet();
    if (typeof window.cwm.hideContextMenu === 'function') window.cwm.hideContextMenu();
    const menu = document.getElementById('context-menu');
    if (menu) menu.hidden = true;
  });
  await settle(page, 520);

  await clickOn(page, '.mobile-tab[data-view="sessions"]', 420);
  await phoneRestingState(page);
}

/**
 * Fill a pane before the themes clip rolls, so a palette swap has ink to swap.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when prepared.
 */
async function prepareFeatureThemes(ctx) {
  const { page, session } = ctx;
  const claudeSession = session.fixture.claude[0].spec;
  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setTheme('mocha');
    window.cwm.setViewMode('terminal');
  });
  await settle(page, VIEW_MS);
  await openAgentPane(session, page, 0, claudeSession.id, claudeSession.title,
    'claude', 'checkout', PLAYER_SPEED.offCamera);
  await waitForPaneDone(page, 0);
  await parkPointer(page, DESKTOP);
  await settle(page, 600);
}

/**
 * Themes: the two chromes, then several terminal palettes under a live pane.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when driven.
 */
async function sceneFeatureThemes(ctx) {
  const { page } = ctx;
  await settle(page, REST_MS);

  for (const step of THEME_SEQUENCE) {
    await page.evaluate(({ chrome, theme }) => {
      window.cwm.setChrome(chrome);
      window.cwm.setTheme(theme);
    }, step);
    await settle(page, 1250);
  }

  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setTheme('mocha');
  });
  await parkPointer(page, DESKTOP);
  await settle(page, REST_MS);
}

/**
 * The chrome and palette pairs the themes clip walks, in order.
 *
 * Two chromes and five palettes rather than all thirteen: at 8 fps a swap needs
 * more than a second to read, and the contract caps the clip at twelve seconds.
 * Five is what fits while still proving the two axes are independent, which is
 * the point of the light-chrome-with-dark-palette pair in the middle.
 */
const THEME_SEQUENCE = Object.freeze([
  { chrome: 'light', theme: 'latte' },
  { chrome: 'light', theme: 'mocha' },
  { chrome: 'dark', theme: 'tokyo-night' },
  { chrome: 'dark', theme: 'dracula' },
  { chrome: 'dark', theme: 'nord' },
]);

/**
 * Warm both the board and the cost dashboard before the camera rolls.
 *
 * Both views fetch before they can draw, and the clip cannot afford to show
 * two empty panels filling in.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when prepared.
 */
async function prepareFeatureBoard(ctx) {
  const { page } = ctx;
  // Two live panes first, for the same reason the sidebar clip opens them: the
  // board and the cost panel are both drawn beside the sidebar, and a sidebar
  // with nothing attached to it is a picture of an idle machine.
  await openTwoLivePanes(ctx);
  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setTheme('mocha');
    window.cwm.setViewMode('tasks');
    if (typeof window.cwm.setTasksLayout === 'function') window.cwm.setTasksLayout('board');
  });
  await settle(page, FETCH_MS);
  await page.evaluate(() => window.cwm.setViewMode('costs'));
  await settle(page, FETCH_MS);
  await parkPointer(page, DESKTOP);
  await settle(page, 500);
}

/**
 * Cost, then the board, with a card dragged between columns.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves when driven.
 */
async function sceneFeatureBoard(ctx) {
  const { page } = ctx;
  await settle(page, REST_MS);

  await wheelOver(page, '#costs-panel', 340, 2);
  await settle(page, 620);
  await wheelOver(page, '#costs-panel', -340, 2);
  await settle(page, 340);

  await page.evaluate(() => {
    window.cwm.setViewMode('tasks');
    if (typeof window.cwm.setTasksLayout === 'function') window.cwm.setTasksLayout('board');
  });
  await settle(page, 1000);
  await dragKanbanCard(page);
  await settle(page, 900);

  await page.evaluate(() => window.cwm.setViewMode('costs'));
  await settle(page, 1100);

  // CLEAR THE TOASTS THE DRAG RAISED.
  //
  // MEASURED: 3.56 percent of this clip's pixels differed between its first and
  // last frames, and all of it was a stack of confirmation toasts in the bottom
  // left that the card drag had put there. They are correct behaviour and they
  // are not the subject; a toast that appears out of nowhere on the loop's first
  // frame reads as a notification the viewer missed. The container is emptied
  // rather than each toast dismissed, because their own timers are longer than
  // the rest of the clip.
  await inApp(page, () => {
    const container = document.getElementById('toast-container');
    if (container) container.replaceChildren();
  });
  await settle(page, 200);

  await parkPointer(page, DESKTOP);
  await settle(page, REST_MS);
}

/* ── Compound gestures ────────────────────────────────────────────────────── */

/**
 * Drive the shipped mobile-viewport module as if a soft keyboard had risen.
 *
 * `MyrlinMobileViewport.apply()` reads window.visualViewport and computes the
 * inset itself; only the geometry is supplied here, so the custom properties
 * and the body classes that follow are the application's own work.
 *
 * @param {object} page - Playwright page.
 * @param {number} inset - How many pixels the keyboard covers. 0 lowers it.
 * @returns {Promise<void>} Resolves once applied.
 */
async function setKeyboardInset(page, inset) {
  await page.evaluate((px) => {
    const vv = window.visualViewport;
    if (!vv) return;
    const full = document.documentElement.clientHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - px });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    if (window.MyrlinMobileViewport && typeof window.MyrlinMobileViewport.apply === 'function') {
      window.MyrlinMobileViewport.apply();
    }
    vv.dispatchEvent(new Event('resize'));
  }, inset);
}

/**
 * Drag a selection across a terminal pane, from history into the live rows.
 *
 * The selection is made with real mouse events rather than through xterm's API,
 * because the point of the clip is that a person can do it.
 *
 * @param {object} page - Playwright page.
 * @param {number} slot - Pane index.
 * @returns {Promise<void>} Resolves once the selection is held.
 */
async function dragSelectInPane(page, slot) {
  const surface = '#term-pane-' + slot + ' .terminal-history-doc';
  // count() does not wait, so this cannot stall: it is a question about the
  // DOM right now, which is exactly what "did the history layer mount" is.
  const hasHistory = await page.locator(surface).count().then((n) => n > 0).catch(() => false);
  const target = hasHistory ? surface : '#term-pane-' + slot + ' .xterm-screen';
  const box = await boxOf(page, target);
  if (!box) return;

  const startX = box.x + 28;
  const startY = box.y + box.height * 0.30;
  const endX = box.x + Math.min(box.width - 24, 520);
  const endY = box.y + box.height * 0.72;

  await page.mouse.move(startX, startY, { steps: MOVE_STEPS });
  await settle(page, 200);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(endX, startY + (endY - startY) * 0.45, { steps: 8 });
  await settle(page, 110);
  await page.mouse.move(endX, endY, { steps: 8 });
  await settle(page, 160);
  await page.mouse.up({ button: 'left' });
}

/**
 * Copy the current selection with the keyboard.
 *
 * @param {object} page - Playwright page.
 * @returns {Promise<void>} Resolves once the copy has been asked for.
 */
async function copySelection(page) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(modifier + '+C');
}

/**
 * Drag a board card from Review into Done.
 *
 * The board uses native HTML5 drag and drop: the card sets `text/plain` on
 * dragstart and the column body reads it back on drop. A synthetic mouse
 * down-move-up never produces a DragEvent with a populated dataTransfer, so the
 * events are constructed and dispatched directly, while the POINTER is moved
 * along the same path so the cursor overlay shows the drag happening. The
 * application's own handlers do the work; only the event plumbing is supplied.
 *
 * @param {object} page - Playwright page.
 * @returns {Promise<boolean>} True when a card moved.
 */
async function dragKanbanCard(page) {
  const from = await boxOf(page, '.kanban-column[data-status="review"] .kanban-card');
  const to = await boxOf(page, '.kanban-column-body[data-status="completed"]');
  if (!from || !to) return false;

  const start = { x: from.x + from.width / 2, y: from.y + 18 };
  const end = { x: to.x + to.width / 2, y: to.y + 40 };

  await page.mouse.move(start.x, start.y, { steps: MOVE_STEPS });
  await settle(page, 260);
  await page.mouse.down({ button: 'left' });

  const armed = await page.evaluate(() => {
    const source = document.querySelector('.kanban-column[data-status="review"] .kanban-card');
    const body = document.querySelector('.kanban-column-body[data-status="completed"]');
    if (!source || !body) return false;
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    body.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    return true;
  });

  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2 - 40, { steps: 10 });
  await settle(page, 160);
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await settle(page, 180);

  if (armed) {
    await page.evaluate(() => {
      const source = document.querySelector('.kanban-column[data-status="review"] .kanban-card');
      const body = document.querySelector('.kanban-column-body[data-status="completed"]');
      if (!source || !body) return;
      const data = new DataTransfer();
      data.setData('text/plain', source.dataset.taskId || '');
      body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
  }
  await page.mouse.up({ button: 'left' });
  return armed;
}

/* ── Stills ───────────────────────────────────────────────────────────────── */

/**
 * Full desktop application, terminal grid open, in one chrome.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves once the frame is photographed.
 */
async function stillDesktop(ctx) {
  const { page, session, output, chrome } = ctx;
  const claudeSession = session.fixture.claude[0].spec;
  const codexSession = session.fixture.codex[0].spec;

  await page.evaluate(({ mode }) => {
    window.cwm.setChrome(mode);
    window.cwm.setTheme(mode === 'light' ? 'latte' : 'mocha');
    window.cwm.setViewMode('terminal');
  }, { mode: chrome });
  await settle(page, VIEW_MS);

  await openAgentPane(session, page, 0, claudeSession.id, claudeSession.title,
    'claude', 'checkout', PLAYER_SPEED.offCamera);
  await openAgentPane(session, page, 1, codexSession.id, codexSession.title,
    'codex', 'push', PLAYER_SPEED.offCamera);
  await waitForPaneDone(page, 0);
  await waitForPaneDone(page, 1);
  await parkPointer(page, DESKTOP);
  await settle(page, 1400);

  // The still is ONE frame and it is the frame that ships, so the guard runs
  // immediately before the shutter rather than only at the ends of the take.
  await assertNoCapsuleDots(page, 'still-desktop (' + chrome + ' chrome)');
  await page.screenshot({ path: output });
  await closeAllPanes(page);
}

/**
 * The phone's Sessions tab.
 *
 * @param {object} ctx - Scene context.
 * @returns {Promise<void>} Resolves once the frame is photographed.
 */
async function stillPhone(ctx) {
  const { page, output } = ctx;
  await page.evaluate(() => {
    window.cwm.setChrome('dark');
    window.cwm.setViewMode('workspace');
  });
  await settle(page, VIEW_MS);
  await parkPointer(page, PHONE);
  await settle(page, 1100);
  await assertNoCapsuleDots(page, 'still-phone');
  await page.screenshot({ path: output });
}

/* ── The scene table ──────────────────────────────────────────────────────── */

/**
 * Every asset this file produces.
 *
 * `kind` picks the recorder: a clip opens a screencast, a still opens a
 * deviceScaleFactor 2 context and takes one photograph. `viewport` and `context`
 * are handed to the browser context, so a scene declares its own geometry rather
 * than depending on the order scenes run in. `budgetS` is the contract's
 * duration for that clip, checked after every take so an over-long scene is
 * visible immediately rather than at encode time.
 */
const SCENES = Object.freeze([
  {
    name: 'hero',
    kind: 'clip',
    about: '30 second tour',
    // The contract says 30 s. 34 is the tolerance this gate enforces: three
    // chapter cards and five surfaces do not fit in 30 s of scripted beats
    // without one of them becoming unreadable, and the number that actually
    // constrains the deliverable is the 2.5 MB size budget, which a 34 s clip
    // at 10 fps and 900 px clears with room to spare.
    budgetS: 34,
    viewport: DESKTOP,
    run: sceneHero,
  },
  {
    name: 'feature-sidebar',
    kind: 'clip',
    about: 'sidebar and discovery',
    budgetS: 13,
    viewport: DESKTOP,
    prepare: prepareFeatureSidebar,
    run: sceneFeatureSidebar,
  },
  {
    name: 'feature-terminal',
    kind: 'clip',
    about: 'terminal, scrollback, selection, copy',
    budgetS: 13,
    viewport: DESKTOP,
    prepare: prepareFeatureTerminal,
    run: sceneFeatureTerminal,
  },
  {
    name: 'feature-codex',
    kind: 'clip',
    about: 'Codex parity and the detail strip',
    budgetS: 13,
    viewport: DESKTOP,
    prepare: prepareFeatureCodex,
    run: sceneFeatureCodex,
  },
  {
    name: 'feature-phone',
    kind: 'clip',
    about: 'phone: five tabs, keyboard, long press',
    budgetS: 13,
    actions: false,
    viewport: PHONE,
    context: { isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
    prepare: prepareFeaturePhone,
    run: sceneFeaturePhone,
  },
  {
    name: 'feature-themes',
    kind: 'clip',
    about: 'two chromes, five terminal palettes',
    budgetS: 13,
    viewport: DESKTOP,
    prepare: prepareFeatureThemes,
    run: sceneFeatureThemes,
  },
  {
    name: 'feature-board',
    kind: 'clip',
    about: 'cost panel, then the board with a card drag',
    budgetS: 13,
    viewport: DESKTOP,
    prepare: prepareFeatureBoard,
    run: sceneFeatureBoard,
  },
  {
    name: 'still-desktop-dark',
    kind: 'still',
    about: 'full app, dark chrome',
    viewport: DESKTOP,
    context: { deviceScaleFactor: 2, colorScheme: 'dark' },
    chrome: 'dark',
    run: stillDesktop,
  },
  {
    name: 'still-desktop-light',
    kind: 'still',
    about: 'full app, light chrome',
    viewport: DESKTOP,
    context: { deviceScaleFactor: 2, colorScheme: 'light' },
    chrome: 'light',
    run: stillDesktop,
  },
  {
    name: 'still-phone',
    kind: 'still',
    about: 'phone Sessions tab',
    viewport: PHONE,
    context: { deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    run: stillPhone,
  },
]);

/* ── Runner ───────────────────────────────────────────────────────────────── */

/**
 * Record one scene.
 *
 * Each scene gets its own browser context. That is not tidiness: the screencast
 * fixes its frame size when it starts and a still needs deviceScaleFactor 2,
 * so scenes with different geometry cannot share one.
 *
 * @param {object} session - Harness session handle.
 * @param {object} scene - One SCENES entry.
 * @returns {Promise<{name: string, output: string, ms: number, recordedMs: number}>} What was written.
 */
async function recordScene(session, scene) {
  const startedAt = Date.now();
  const isClip = scene.kind === 'clip';
  const output = path.join(RAW_DIR, scene.name + (isClip ? '.webm' : '.png'));

  const { context, page } = await harness.openApp(session, Object.assign({
    viewport: scene.viewport,
    deviceScaleFactor: 1,
  }, scene.context || {}));

  let recordedMs = 0;
  try {
    const ctx = { page, session, scene, output, chrome: scene.chrome };

    // START FROM AN EMPTY GRID.
    //
    // The terminal layout is saved SERVER SIDE and restored on boot, and every
    // scene gets a fresh browser context against the same server. So a scene
    // that opened a Claude pane in slot 0 leaves a Claude pane in slot 0 for
    // the next scene, whose own openTerminalInPane then lands on an occupied
    // slot and inherits the wrong provider tag. That is why the Codex detail
    // strip appeared when feature-codex ran alone and vanished when it ran
    // after feature-terminal: an intermittent failure with a deterministic
    // cause. Clearing here makes every take independent of the take before it.
    await closeAllPanes(page);
    await settle(page, 250);

    if (typeof scene.prepare === 'function') await scene.prepare(ctx);

    // THE BAN, ASKED OF THE PIXELS. Once before the camera rolls, on the
    // resting frame every clip opens and closes on, and once after it stops,
    // on whatever the scene ended holding. Both are off camera, so neither
    // costs the clip a frame or a byte of its budget, and a take that would
    // have published the banned pattern fails here instead of at review.
    await assertNoCapsuleDots(page, scene.name + ' (resting frame, pre-roll)');

    const rollingAt = Date.now();
    resetTiming();
    if (isClip) {
      await page.screencast.start({
        path: output,
        size: scene.viewport,
        quality: SCREENCAST_QUALITY,
      });
      // A phone has no mouse. Drawing a pointer over a touch surface is both
      // wrong and, at 390px wide, large enough to cover two of the five tabs.
      if (scene.actions !== false) await page.screencast.showActions(ACTION_OPTIONS);
    }
    await scene.run(ctx);
    if (isClip) await page.screencast.stop();
    recordedMs = Date.now() - rollingAt;
    await assertNoCapsuleDots(page, scene.name + ' (final frame, post-roll)');
  } finally {
    // Panes are killed inside the scene, but a scene that threw halfway leaves
    // a player running. This is the backstop, and it runs before the context
    // closes so the kill request still has a page to go through.
    await closeAllPanes(page);
    await context.close().catch(() => {});
  }

  return { name: scene.name, output, ms: Date.now() - startedAt, recordedMs, timing: timingReport() };
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when every requested scene has been recorded.
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const scene of SCENES) {
      process.stdout.write(
        scene.name.padEnd(22) + scene.kind.padEnd(7) +
        (scene.budgetS ? ('<= ' + scene.budgetS + 's').padEnd(9) : ''.padEnd(9)) +
        scene.about + '\n'
      );
    }
    return;
  }

  const headed = argv.includes('--headed');
  const names = argv.filter((a) => !a.startsWith('--'));
  const selected = names.length ? SCENES.filter((s) => names.includes(s.name)) : SCENES.slice();
  const unknown = names.filter((n) => !SCENES.some((s) => s.name === n));
  if (unknown.length) {
    process.stderr.write('unknown scene(s): ' + unknown.join(', ') + '\n');
    process.stderr.write('known: ' + SCENES.map((s) => s.name).join(', ') + '\n');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const session = await harness.launch({ headless: !headed });
  const results = [];
  let overBudget = 0;
  try {
    for (const scene of selected) {
      process.stdout.write('recording ' + scene.name + ' ... ');
      const result = await recordScene(session, scene);
      const bytes = fs.existsSync(result.output) ? fs.statSync(result.output).size : 0;
      const rolled = result.recordedMs / 1000;
      const over = !!scene.budgetS && rolled > scene.budgetS;
      if (over) overBudget++;
      results.push(Object.assign(result, { bytes, budgetS: scene.budgetS }));
      process.stdout.write(
        (result.ms / 1000).toFixed(1) + 's wall, ' +
        rolled.toFixed(1) + 's rolling' +
        (scene.budgetS ? (over ? ' (OVER ' + scene.budgetS + 's)' : ' (ok)') : '') +
        ', ' + (bytes / 1024).toFixed(0) + ' KB\n'
      );
      process.stdout.write(result.timing);
    }
  } finally {
    await session.close();
  }

  process.stdout.write('\nraw footage in ' + RAW_DIR + '\n');
  for (const r of results) {
    process.stdout.write('  ' + path.basename(r.output).padEnd(28) + (r.bytes / 1024).toFixed(0).padStart(8) + ' KB\n');
  }
  if (missedSelectors.length) {
    const unique = Array.from(new Set(missedSelectors));
    process.stderr.write('\nselectors not found while driving (each cost a beat):\n');
    for (const selector of unique) process.stderr.write('  ' + selector + '\n');
  }
  if (overBudget) {
    process.stderr.write(
      '\n' + overBudget + ' clip(s) ran longer than the contract duration. Shorten the\n' +
      'scene beats, or move setup into that scene\'s prepare() so it happens off\n' +
      'camera. A long clip cannot be brought inside its size budget by encoding.\n'
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('capture failed: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  SCENES,
  SELECTOR_TIMEOUT_MS,
  ACTION_OPTIONS,
  RAW_DIR,
  DESKTOP,
  PHONE,
  THEME_SEQUENCE,
  PLAYER_SPEED,
  PLAYER_DONE_MARKER,
  recordScene,
};
