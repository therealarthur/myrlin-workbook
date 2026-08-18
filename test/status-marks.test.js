#!/usr/bin/env node
/**
 * status-marks.test.js - the status treatment is a MARK plus a label, never a
 * pill with a dot in it.
 * Created: 2026-08-18.
 *
 * WHY THIS FILE EXISTS
 *
 * The user's standing UI rule of 2026-08-13 bans the status pill that contains
 * a dot indicator in every form, blinking, pulsing OR static, because the
 * pill-plus-dot pattern is itself the generic tell. DECISIONS 13.1 recorded the
 * motion half of that rule and gate G14 enforces it. The SHAPE half went
 * unenforced for five days, and in that window `.status-badge` (the sessions
 * table's Status column, and the side peek) and `.stat-chip` (the header's
 * running counter) both shipped as exactly the banned pattern: a capsule with a
 * dot inside it. DECISIONS 13.6 records the sweep that removed them.
 *
 * Gate G16 in scripts/do-not-break-gates.js is the structural, whole-tree
 * enforcement. This file is the narrow one, and it exists for a different
 * reason: G16 answers "does any capsule anywhere contain a dot", which is a
 * question about the tree, while these assertions answer "is THIS rule still
 * de-capsuled and does THIS renderer still emit the contract's class names",
 * which is a question about the two specific surfaces the sweep changed. A
 * regression that reintroduced the wash but not the radius would slip past G16
 * and be caught here.
 *
 * The renderer half is EXECUTED rather than pattern-matched: `statusChipHtml`
 * is lifted out of app.js by brace matching and run against a fake `this`, so
 * the assertions are about the string a browser would receive rather than about
 * the source that produces it.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

/** Radii at or above this many pixels read as a capsule rather than a corner. */
const CAPSULE_RADIUS_PX = 9;

/** The eight states DESIGN-SPEC 6 maps, and the label each one renders as. */
const STATE_LABELS = Object.freeze({
  running: 'Running',
  'needs-input': 'Needs input',
  idle: 'Idle',
  error: 'Failed',
  failed: 'Failed',
  complete: 'Complete',
  stale: 'Stale',
  stopped: 'Stopped',
});

let passed = 0;
let failed = 0;

/**
 * Run a single named assertion, tallying rather than bailing so one regression
 * does not hide the next.
 *
 * @param {string} name - Human-readable assertion name.
 * @param {Function} fn - Body that throws on failure.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m' + String.fromCharCode(10003) + '\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m' + String.fromCharCode(10007) + '\x1b[0m ' + name);
    console.log('    \x1b[31m' + err.message + '\x1b[0m');
  }
}

/**
 * Strip CSS block comments, so prose about the old capsule is never mistaken
 * for the old capsule. This file talks about `border-radius` at length in the
 * very comments that explain why it is gone.
 *
 * @param {string} text - Stylesheet text.
 * @returns {string} Comment-free text.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const bareCss = stripComments(css);

/**
 * The declaration block of one top-level rule, by exact selector.
 *
 * Brace matched rather than regex captured, because a declaration value in this
 * sheet can contain a brace-free but comma-heavy color-mix() and because the
 * next rule's opening brace is the only reliable terminator.
 *
 * @param {string} selector - Exact selector text, for example ".status-badge".
 * @returns {string} The text between the rule's braces.
 */
function ruleBlock(selector) {
  const re = new RegExp('(?:^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
  const m = re.exec(bareCss);
  assert.ok(m, 'no rule found for ' + selector);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < bareCss.length && depth > 0) {
    if (bareCss[i] === '{') depth++;
    else if (bareCss[i] === '}') depth--;
    i++;
  }
  return bareCss.slice(start, i - 1);
}

/**
 * Whether a declaration block draws a capsule or circle corner.
 *
 * @param {string} block - Declaration text.
 * @returns {boolean} True when a border-radius resolves to a pill or circle.
 */
function hasCapsuleRadius(block) {
  const m = /border-radius\s*:\s*([^;}]+)/.exec(block);
  if (!m) return false;
  const value = m[1];
  if (/\b(?:50|100)%|--radius-avatar|--radius-pill|--radius-status-chip|--radius-callout/.test(value)) return true;
  for (const px of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
    if (parseFloat(px[1]) >= CAPSULE_RADIUS_PX) return true;
  }
  return false;
}

/**
 * Whether a declaration block paints a real fill.
 *
 * @param {string} block - Declaration text.
 * @returns {boolean} True when a background or border carries a real value.
 */
function hasFill(block) {
  const background = /(?:^|[;\s])background(?:-color|-image)?\s*:\s*([^;}]+)/.exec(block);
  const border = /(?:^|[;\s])border(?:-color|-width|-style)?\s*:\s*([^;}]+)/.exec(block);
  const realBackground = background &&
    !/^\s*(?:none|transparent|inherit|initial|unset|revert)\s*$/.test(background[1]);
  const realBorder = border && !/^\s*(?:none|0|inherit|initial|unset|revert)\b/.test(border[1]);
  return !!(realBackground || realBorder);
}

/**
 * Lift one method out of app.js by brace matching and make it callable.
 *
 * app.js is a single 30000 line class in a browser global, so it cannot be
 * required. Extracting the method keeps the assertion on the shipped source
 * rather than on a copy that would rot the day somebody edits the real one.
 *
 * @param {string} name - Method name.
 * @returns {Function} The method, callable with an explicit `this`.
 */
function liftMethod(name) {
  const marker = '\n  ' + name + '(';
  const at = appJs.indexOf(marker);
  assert.ok(at !== -1, 'method ' + name + ' not found in app.js');
  const open = appJs.indexOf('{', appJs.indexOf(')', at));
  let depth = 1;
  let i = open + 1;
  while (i < appJs.length && depth > 0) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') depth--;
    i++;
  }
  const signature = appJs.slice(at + marker.length, appJs.indexOf(')', at));
  const body = appJs.slice(open + 1, i - 1);
  // eslint-disable-next-line no-new-func
  return new Function(signature, body);
}

console.log('\n  \x1b[1mStatus marks: a mark plus a label, never a pill with a dot\x1b[0m');
console.log('  ' + String.fromCharCode(9472).repeat(58));

/* ── The container is not a capsule ───────────────────────────────────────── */

check('.status-badge declares no border-radius at all', () => {
  const block = ruleBlock('.status-badge');
  assert.ok(!/border-radius\s*:/.test(block),
    '.status-badge declares a border-radius; the capsule is banned and the ' +
    'declaration is removed rather than zeroed, because gate G6 counts a ' +
    'numeric radius literal in this sheet');
});

check('.status-badge draws no capsule corner by any route', () => {
  assert.ok(!hasCapsuleRadius(ruleBlock('.status-badge')), '.status-badge rounds to a pill');
});

check('.status-badge paints no fill of its own', () => {
  assert.ok(!hasFill(ruleBlock('.status-badge')),
    '.status-badge carries a background or border; a status label sits on the page ground');
});

check('.status-badge keeps the metrics that hold the row height', () => {
  const block = ruleBlock('.status-badge');
  assert.ok(/display\s*:\s*inline-flex/.test(block), 'lost display: inline-flex');
  assert.ok(/height\s*:\s*20px/.test(block), 'lost its 20px height');
  assert.ok(/gap\s*:\s*6px/.test(block), 'lost the 6px gap between mark and label');
});

check('every .status-badge-<state> rule declares background: transparent', () => {
  for (const state of Object.keys(STATE_LABELS)) {
    const block = ruleBlock('.status-badge-' + state);
    assert.ok(/background\s*:\s*transparent\s*;/.test(block),
      '.status-badge-' + state + ' does not state background: transparent');
    assert.ok(!hasFill(block), '.status-badge-' + state + ' paints a fill');
    assert.ok(!hasCapsuleRadius(block), '.status-badge-' + state + ' rounds to a pill');
  }
});

check('no .status-badge-<state> rule reaches for a chip fill token', () => {
  for (const state of Object.keys(STATE_LABELS)) {
    const block = ruleBlock('.status-badge-' + state);
    assert.ok(!/--app-chip-[a-z]+-fill/.test(block),
      '.status-badge-' + state + ' still consumes a chip wash token');
  }
});

check('every .status-badge-<state> rule sets a colour, since the mark inherits it', () => {
  for (const state of Object.keys(STATE_LABELS)) {
    const block = ruleBlock('.status-badge-' + state);
    assert.ok(/(?:^|[;\s])color\s*:\s*var\(/.test(block),
      '.status-badge-' + state + ' sets no colour, so .nt-chip-dot has no currentColor to take');
  }
});

/* ── The mark survives, with its two shapes ───────────────────────────────── */

check('.nt-chip-dot survives as a currentColor circle', () => {
  const block = ruleBlock('.nt-chip-dot');
  assert.ok(/background\s*:\s*currentColor/.test(block), 'the mark stopped inheriting its ink');
  assert.ok(/border-radius\s*:\s*var\(--radius-avatar\)/.test(block), 'the mark stopped being round');
  assert.ok(/width\s*:\s*8px/.test(block) && /height\s*:\s*8px/.test(block), 'the mark changed size');
});

check('the waiting states draw a RING rather than a disc', () => {
  assert.ok(
    /\.status-badge-idle \.nt-chip-dot,\s*\.status-badge-needs-input \.nt-chip-dot\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px currentColor/.test(bareCss),
    'idle and needs-input no longer take the ring; DECISIONS 13.1 spends the ' +
    'unique shape on the state whose hue DV-14 measured at 2.68:1'
  );
});

check('the four previously unstyled status dots now have a mark', () => {
  for (const state of ['needs-input', 'complete', 'failed', 'stale']) {
    assert.ok(new RegExp('\\.status-dot-' + state + '\\s*\\{').test(bareCss),
      '.status-dot-' + state + ' has no rule, so it draws a 7px box of nothing');
  }
});

/* ── The header counter lost its capsule too ──────────────────────────────── */

check('.stat-chip is no longer a capsule around a dot', () => {
  const block = ruleBlock('.stat-chip');
  assert.ok(!/border-radius\s*:/.test(block), '.stat-chip declares a border-radius');
  assert.ok(!hasFill(block), '.stat-chip paints a fill behind its .stat-dot');
  assert.ok(/background\s*:\s*transparent\s*;/.test(block), '.stat-chip does not state background: transparent');
});

/* ── No chip draws a dot out of a pseudo-element ──────────────────────────── */

check('no chip or pill pairs a fill with a pseudo-element circle', () => {
  // The narrow, name-based companion to gate G16. G16 measures SHAPE and only
  // counts a container at a pill radius, which is right for the tree as a whole
  // and blind to this case: the provider pills are 4px rounded rectangles, so
  // they are chips rather than capsules, and their dot was drawn by a ::before
  // that no element scan can see. The rule is therefore scoped by NAME here,
  // the way G14's first prong is, so it can be strict without flagging a card.
  const offenders = [];
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rules.exec(bareCss)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const block = m[2];
    if (!/::(?:before|after)\b/.test(selector)) continue;
    if (!/(?:^|[-.\s])(?:chip|pill|badge)s?\b/.test(selector.toLowerCase())) continue;
    if (!/content\s*:/.test(block)) continue;
    if (!/border-radius\s*:\s*(?:50%|100%|var\(--radius-avatar\)|var\(--radius-pill\))/.test(block)) continue;
    const display = /(?:^|[;\s])display\s*:\s*([^;}]+)/.exec(block);
    if (display && /^\s*none\s*$/.test(display[1])) continue;
    offenders.push(selector.slice(0, 80));
  }
  assert.deepStrictEqual(offenders, [],
    'a chip draws a circle out of a pseudo-element; the chip ground already ' +
    'carries the hue and the dot inside it is the banned pattern');
});

/* ── The status ink tokens ────────────────────────────────────────────────── */

check('the status ink tokens are mixes over existing tokens, never literals', () => {
  for (const hue of ['green', 'yellow', 'red', 'teal', 'brown']) {
    const re = new RegExp('--app-status-ink-' + hue + ':\\s*color-mix\\(in srgb, var\\(--app-text-' + hue +
      '\\)\\s*var\\(--app-status-mix\\), var\\(--app-text-primary\\)\\)');
    assert.ok(re.test(bareCss), '--app-status-ink-' + hue + ' is not a mix over the two existing tokens');
  }
  assert.ok(/--app-status-mix:\s*\d+%/.test(bareCss), 'the mix constant is gone');
});

check('the mix is strong enough to keep the hue and weak enough to stay legible', () => {
  const m = /--app-status-mix:\s*(\d+)%/.exec(bareCss);
  assert.ok(m, 'no --app-status-mix');
  const mix = parseInt(m[1], 10);
  // MEASURED, not chosen: below 65 percent the yellow label drops under the
  // 4.5:1 text floor on the white canvas, and above about 80 percent the same
  // label drops under it again as the hue takes over from the chrome's ink.
  assert.ok(mix >= 60 && mix <= 80, 'the status ink mix is ' + mix + ' percent, outside the measured window');
});

/* ── The renderer, executed ───────────────────────────────────────────────── */

const statusChipHtml = liftMethod('statusChipHtml');
const host = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
const render = (status) => statusChipHtml.call(host, status);

check('statusChipHtml emits the contract class names, unchanged', () => {
  const html = render('running');
  assert.ok(html.includes('class="status-badge status-badge-running"'),
    'the DO-NOT-BREAK section B class tokens changed: ' + html);
  assert.ok(html.includes('class="nt-chip-dot"'), 'the mark class changed: ' + html);
});

check('statusChipHtml emits a mark then a label, and nothing that could be a capsule', () => {
  const html = render('running');
  assert.ok(/^<span class="status-badge [^"]*"><span class="nt-chip-dot"[^>]*><\/span>Running<\/span>$/.test(html),
    'the shape of the emitted markup changed: ' + html);
  assert.ok(!/style\s*=/.test(html), 'the renderer started emitting an inline style');
});

check('the mark is hidden from assistive technology, since the label says it', () => {
  assert.ok(render('running').includes('aria-hidden="true"'),
    'the decorative mark is announced, so the state is read twice');
});

check('all eight states render their contract label', () => {
  for (const [state, label] of Object.entries(STATE_LABELS)) {
    const html = render(state);
    assert.ok(html.includes('>' + label + '<'), state + ' rendered as ' + html + ', expected ' + label);
    assert.ok(html.includes('status-badge-' + state), state + ' lost its state class');
  }
});

check('an absent status falls back to stopped, and an unknown one to its own key', () => {
  assert.ok(render('').includes('status-badge-stopped'), 'the empty status lost its fallback');
  assert.ok(render(undefined).includes('>Stopped<'), 'undefined no longer reads as Stopped');
  const exotic = render('reconnecting');
  assert.ok(exotic.includes('status-badge-reconnecting') && exotic.includes('>reconnecting<'),
    'an unmapped state vanished instead of showing its key: ' + exotic);
});

check('the status string is escaped into both the class and the label', () => {
  const html = render('<img src=x>');
  assert.ok(!html.includes('<img'), 'a status string reached the DOM as markup: ' + html);
});

/* ── Cross-file: the peek renders the same eight states ───────────────────── */

check('renderSessionDetail has a mark for every state the table can show', () => {
  const at = appJs.indexOf('const statusIcons = {');
  assert.ok(at !== -1, 'the peek status map is gone');
  const block = appJs.slice(at, appJs.indexOf('};', at));
  for (const state of Object.keys(STATE_LABELS)) {
    if (state === 'error') continue; // error and failed are one state with two spellings
    assert.ok(block.includes('status-dot-' + state) || block.includes("'" + state + "'"),
      'the peek has no mark for ' + state + ', so it renders a label with nothing beside it');
  }
});

console.log('  [status-marks] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
