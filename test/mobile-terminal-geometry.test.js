#!/usr/bin/env node
/**
 * mobile-terminal-geometry.test.js - the shared-PTY geometry contract.
 * Created: 2026-08-19.
 *
 * WHAT IS UNDER TEST
 *
 * MOBILE-TERMINAL.md measured a phone rendering a desktop-owned frame on its
 * own grid: 0 of 30 rows whole, 20 rows left as fragments, 10 painted onto a
 * row the application never addressed. The browser harness
 * (`npm run test:mobile-terminal`) proves the fix end to end against two real
 * clients and a real PTY. This file covers the parts of it that are PURE, so
 * they are checked in milliseconds on every `npm test` rather than only in a
 * three minute browser run:
 *
 *   1. Typed input against terminal replies. A DEC 1004 focus report is not a
 *      person asking for the width, and treating it as one is what took a
 *      live desktop's geometry away without a key being pressed.
 *   2. The `size` frame's shape, including the difference between "you are
 *      not driving" and "somebody else is".
 *   3. The type-size ladder arithmetic, which decides how many columns a
 *      phone gets and how much of an owner's grid fits on its screen.
 *   4. The source-level contract: the follower path exists, the fit path
 *      defers to it, ambient claims are suppressed, and the stylesheet and
 *      the markup carry their halves.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

require('./_test-data-dir');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'src', 'web', 'public');
const termSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'terminal.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const mobileCss = fs.readFileSync(path.join(PUBLIC_DIR, 'styles-mobile.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const ptyManagerSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'web', 'pty-manager.js'), 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, recording the outcome rather than aborting.
 *
 * @param {string} name - What is being checked.
 * @param {Function} fn - The assertions.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  [32mPASS[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  [31mFAIL[0m ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Evaluate terminal.js in a fresh sandbox and hand back the class.
 *
 * The same shape the other pinned suites use: no DOM, no xterm, no network,
 * and a localStorage that lives in a Map, so a static that reads a stored
 * preference is exercised without touching the machine.
 *
 * @param {Object} [storage] - Seed values for localStorage.
 * @returns {{TerminalPane: Function, sandbox: Object, storage: Map}} The class.
 */
function loadTerminalPane(storage) {
  const store = new Map(Object.entries(storage || {}));
  const sandbox = {
    window: {},
    document: { getElementById: () => null, body: null },
    navigator: { maxTouchPoints: 0 },
    requestAnimationFrame: () => 0,
    setTimeout: () => 1,
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    console,
  };
  sandbox.window.matchMedia = () => ({ matches: false });
  vm.createContext(sandbox);
  vm.runInContext(termSrc, sandbox, { filename: 'terminal.js' });
  return { TerminalPane: sandbox.window.TerminalPane, sandbox, storage: store };
}

console.log('\n  mobile terminal: the shared-PTY geometry contract');
console.log('  ' + '-'.repeat(66));

/* ═══════════════════════════════════════════════════════════════
   1. TYPED INPUT AGAINST TERMINAL REPLIES
   ═══════════════════════════════════════════════════════════════ */

const { isUserOriginatedInput } = require('../src/web/pty-manager');

check('a DEC 1004 focus report is not a person asking for the width', () => {
  // The measured payload. A phone opened a shared session, pressed nothing,
  // and sent exactly this; the desktop's terminal went from 155 columns to 49.
  assert.strictEqual(isUserOriginatedInput('\x1b[O'), false, 'focus out');
  assert.strictEqual(isUserOriginatedInput('\x1b[I'), false, 'focus in');
  assert.strictEqual(isUserOriginatedInput('\x1b[O\x1b[I'), false,
    'a frame of several reports is still no person');
});

check('mouse reports in both encodings claim nothing', () => {
  assert.strictEqual(isUserOriginatedInput('\x1b[<0;10;5M'), false, 'SGR 1006 press');
  assert.strictEqual(isUserOriginatedInput('\x1b[<0;10;5m'), false, 'SGR 1006 release');
  assert.strictEqual(isUserOriginatedInput('\x1b[<35;80;24M'), false, 'SGR 1006 motion');
  assert.strictEqual(isUserOriginatedInput('\x1b[M !!'), false, 'X10 encoding');
});

check('device replies claim nothing', () => {
  assert.strictEqual(isUserOriginatedInput('\x1b[?62;c'), false, 'DA1');
  assert.strictEqual(isUserOriginatedInput('\x1b[>0;10;1c'), false, 'DA2');
  assert.strictEqual(isUserOriginatedInput('\x1b[12;40R'), false, 'cursor position report');
  assert.strictEqual(isUserOriginatedInput('\x1b[0n'), false, 'device status report');
});

check('anything a person can type still claims, including inside a report frame', () => {
  assert.strictEqual(isUserOriginatedInput('a'), true, 'a character');
  assert.strictEqual(isUserOriginatedInput('\r'), true, 'Enter');
  assert.strictEqual(isUserOriginatedInput('\x03'), true, 'Ctrl+C');
  assert.strictEqual(isUserOriginatedInput('\x1b'), true, 'a bare Escape key');
  assert.strictEqual(isUserOriginatedInput('\x1b[A'), true, 'an arrow key');
  assert.strictEqual(isUserOriginatedInput('\x1b[200~text\x1b[201~'), true, 'a paste');
  // The conservatism points this way deliberately: a keystroke that happens
  // to share a frame with a focus report must still claim, because failing to
  // claim on real typing is a worse bug than claiming on an exotic reply.
  assert.strictEqual(isUserOriginatedInput('\x1b[O' + 'x'), true,
    'a keystroke riding along with a report');
});

check('an empty or malformed frame claims nothing and cannot spin', () => {
  assert.strictEqual(isUserOriginatedInput(''), false);
  assert.strictEqual(isUserOriginatedInput(null), false);
  assert.strictEqual(isUserOriginatedInput(undefined), false);
  assert.strictEqual(isUserOriginatedInput(12), false);
});

check('the write reaches the PTY whichever way the frame is classified', () => {
  // The classifier gates the CLAIM only. An application that asked for focus
  // reports must still receive them, so the write is unconditional.
  const handler = ptyManagerSrc.slice(ptyManagerSrc.indexOf("if (msg.type === 'input'"));
  const body = handler.slice(0, handler.indexOf("} else if (msg.type === 'resize'"));
  assert.ok(/isUserOriginatedInput\(String\(msg\.data\)\)\)\s*claimSizeOwnership/.test(body),
    'the claim is gated on the classifier');
  assert.ok(/session\.pty\.write\(msg\.data\)/.test(body),
    'the write is not gated on anything');
  const claimAt = body.indexOf('claimSizeOwnership');
  const writeAt = body.indexOf('session.pty.write');
  assert.ok(claimAt !== -1 && writeAt !== -1 && claimAt < writeAt,
    'the classification happens before the write, so a slow classifier cannot delay input');
});

/* ═══════════════════════════════════════════════════════════════
   2. THE SIZE FRAME
   ═══════════════════════════════════════════════════════════════ */

const { __test } = require('../src/web/pty-manager');

check('the size frame publishes the geometry and both ownership answers', () => {
  const owner = { id: 'desktop' };
  const other = { id: 'phone' };
  const session = { cols: 155, rows: 40, sizeOwner: owner, clients: new Set([owner, other]) };

  const toOwner = JSON.parse(__test.buildSizeFrame(session, owner, 7));
  assert.strictEqual(toOwner.type, 'size');
  assert.strictEqual(toOwner.cols, 155);
  assert.strictEqual(toOwner.rows, 40);
  assert.strictEqual(toOwner.owned, true, 'the owner is told it is driving');
  assert.strictEqual(toOwner.seq, 7, 'a sequence number, so an out-of-order frame is droppable');

  const toOther = JSON.parse(__test.buildSizeFrame(session, other, 7));
  assert.strictEqual(toOther.owned, false, 'the other client is told it is not');
  assert.strictEqual(toOther.ownerAssigned, true,
    'and that somebody IS, which is what stops it claiming automatically');
});

check('nobody driving reads differently from somebody else driving', () => {
  const client = { id: 'phone' };
  const unowned = { cols: 80, rows: 24, sizeOwner: null, clients: new Set([client]) };
  const frame = JSON.parse(__test.buildSizeFrame(unowned, client, 1));
  assert.strictEqual(frame.owned, false);
  assert.strictEqual(frame.ownerAssigned, false,
    'an unclaimed session must not look like a contended one, or a sole client ' +
    'would follow a geometry nobody chose');
});

check('an owner that has already disconnected does not count as driving', () => {
  const ghost = { id: 'gone' };
  const client = { id: 'phone' };
  const session = { cols: 80, rows: 24, sizeOwner: ghost, clients: new Set([client]) };
  const frame = JSON.parse(__test.buildSizeFrame(session, client, 1));
  assert.strictEqual(frame.ownerAssigned, false,
    'a stale sizeOwner reference must not lock every other client out of the width');
});

check('the geometry frame is broadcast on every applied resize and every flip', () => {
  const applyViewport = ptyManagerSrc.slice(ptyManagerSrc.indexOf('  applyViewport(cols, rows) {'));
  const applyBody = applyViewport.slice(0, applyViewport.indexOf('\n  }\n'));
  assert.ok(/this\.broadcastSize\(\)/.test(applyBody),
    'a client not told about a resize renders the next repaint on the grid it had');
  const commit = ptyManagerSrc.slice(ptyManagerSrc.indexOf('  _commitSizeOwnership(ws, now) {'));
  const commitBody = commit.slice(0, commit.indexOf('\n  }\n'));
  assert.ok(/previous !== ws\) this\.broadcastSize\(\)/.test(commitBody),
    'a handover between two clients with matching viewports changes no dimension, ' +
    'and both of them still have to hear that ownership moved');
  assert.ok(/session\.sendSizeTo\(ws\)/.test(ptyManagerSrc),
    'and an attaching client is told before its first frame');
});

/* ═══════════════════════════════════════════════════════════════
   3. THE TYPE SIZE LADDER
   ═══════════════════════════════════════════════════════════════ */

check('the ladder snaps down, never up, and clamps at both ends', () => {
  const { TerminalPane } = loadTerminalPane();
  assert.strictEqual(TerminalPane.snapFontToLadder(13), 13, 'an exact rung is itself');
  assert.strictEqual(TerminalPane.snapFontToLadder(13.9), 13, 'between rungs, take the lower');
  assert.strictEqual(TerminalPane.snapFontToLadder(2), 8, 'below the ladder, take the smallest');
  assert.strictEqual(TerminalPane.snapFontToLadder(99), 16, 'above it, take the largest');
  assert.strictEqual(TerminalPane.snapFontToLadder(NaN), 13, 'nonsense falls back to the default');
});

check('stepping stops at the ends instead of wrapping', () => {
  const { TerminalPane } = loadTerminalPane();
  assert.strictEqual(TerminalPane.stepFontLadder(13, 1), 14);
  assert.strictEqual(TerminalPane.stepFontLadder(13, -1), 12);
  assert.strictEqual(TerminalPane.stepFontLadder(8, -1), 8, 'the smallest rung is the floor');
  assert.strictEqual(TerminalPane.stepFontLadder(16, 1), 16, 'the largest is the ceiling');
});

check('the size for a column count is derived from a measured advance', () => {
  const { TerminalPane } = loadTerminalPane();
  // The real measurement from the reference device: 13px gives a 7.61px
  // advance, and a phone pane is about 373px of usable width.
  const width = 373;
  const measuredPx = 13;
  const advance = 7.61;
  assert.strictEqual(
    TerminalPane.fontForColumns(width, 60, measuredPx, advance, 9), 10,
    '60 columns on a 390px phone costs 10px, which is the shipped default');
  assert.strictEqual(
    TerminalPane.fontForColumns(width, 49, measuredPx, advance, 9), 13,
    'asking for what 13px already gives must not shrink the type');
  assert.strictEqual(
    TerminalPane.fontForColumns(width, 200, measuredPx, advance, 9), 9,
    'an impossible ask lands on the floor rather than on something illegible');
});

check('the floor is honoured and a broken measurement never returns nonsense', () => {
  const { TerminalPane } = loadTerminalPane();
  assert.strictEqual(TerminalPane.fontForColumns(373, 400, 13, 7.61, 8), 8,
    'the follower floor is lower than the first-run floor, because the alternative ' +
    'there is panning across a frame three screens wide');
  const fallback = TerminalPane.fontForColumns(0, 60, 13, 7.61, 9);
  assert.ok(TerminalPane.snapFontToLadder(fallback) === fallback,
    'a zero width returns a ladder value rather than Infinity');
  assert.strictEqual(TerminalPane.fontForColumns(373, 60, 13, 0, 9), 13,
    'a zero advance returns the size it was measured at');
});

check('a stored preference wins over the default, and no preference reads as none', () => {
  const clean = loadTerminalPane();
  assert.strictEqual(clean.TerminalPane.storedFontPx(), null,
    'null and 13 are different answers: only the first lets a phone choose for itself');
  assert.strictEqual(clean.TerminalPane.initialFontPx(), 13);

  const chosen = loadTerminalPane({ mw_term_font_px: '10' });
  assert.strictEqual(chosen.TerminalPane.storedFontPx(), 10);
  assert.strictEqual(chosen.TerminalPane.initialFontPx(), 10);

  const junk = loadTerminalPane({ mw_term_font_px: 'not a number' });
  assert.strictEqual(junk.TerminalPane.storedFontPx(), null, 'corrupt storage reads as unset');
});

check('storing a choice snaps it to the ladder', () => {
  const { TerminalPane, storage } = loadTerminalPane();
  assert.strictEqual(TerminalPane.storeFontPx(11.4), 11);
  assert.strictEqual(storage.get('mw_term_font_px'), '11');
});

/* ═══════════════════════════════════════════════════════════════
   4. THE SOURCE-LEVEL CONTRACT
   ═══════════════════════════════════════════════════════════════ */

check('a follower renders the published grid and never fits itself', () => {
  const fit = termSrc.slice(termSrc.indexOf('  safeFit() {'));
  const body = fit.slice(0, fit.indexOf('\n  }\n'));
  const guardAt = body.indexOf('_isFollowingRemoteGeometry()');
  const fitAt = body.indexOf('this.fitAddon.fit()');
  assert.ok(guardAt !== -1, 'safeFit must ask whether this client owns the geometry');
  assert.ok(fitAt !== -1 && guardAt < fitAt,
    'and it must ask BEFORE it fits, or the fragmentation is back');
  assert.ok(/_applyRemoteGeometry\('fit'\)/.test(body),
    'the follower branch renders the owner grid rather than doing nothing');
});

check('a follower reports its OWN geometry to the server', () => {
  const send = termSrc.slice(termSrc.indexOf('  _sendResizeIfChanged(force) {'));
  const body = send.slice(0, send.indexOf('\n  }\n'));
  assert.ok(/_isFollowingRemoteGeometry\(\)/.test(body) && /_proposeOwnGeometry/.test(body),
    'reporting the owner grid would make a later handover restore the wrong size');
});

check('the size frame is guarded on its sequence, like the mode frame', () => {
  const handler = termSrc.slice(termSrc.indexOf("} else if (msg.type === 'size') {"));
  const body = handler.slice(0, handler.indexOf("} else if (msg.type === 'error')"));
  assert.ok(/msg\.seq !== 'number' \|\| msg\.seq >= this\._sizeSeq/.test(body),
    'an out-of-order frame must not move the pane backwards');
  assert.ok(/this\._remoteSizeFrame = msg/.test(body), 'the whole frame is kept');
  assert.ok(/_applyRemoteGeometry\('frame'\)/.test(body), 'and acted on');
});

check('an ambient claim never takes the width off a device that is driving', () => {
  const act = termSrc.slice(termSrc.indexOf('  activate(options) {'));
  const body = act.slice(0, act.indexOf('\n  }\n'));
  assert.ok(/options && options\.ambient/.test(body), 'the caller says which kind it is');
  assert.ok(/remote\.owned === false && remote\.ownerAssigned === true/.test(body),
    'and an ambient caller stands down only when somebody else actually holds it');
  // Every automatic app-layer trigger has to pass the flag, or the guard is
  // decoration. Three call sites: the visibility path, the pane-focus path
  // (which a phone tab switch reaches) and the tab-group restore.
  const ambientCalls = (appSrc.match(/activate\(\{ ambient: true \}\)/g) || []).length;
  assert.ok(ambientCalls >= 3,
    'expected the three automatic activate call sites to be marked ambient, found ' +
    ambientCalls);
  // And the explicit one must NOT be, or the take-over affordance would do
  // nothing at all.
  const notice = appSrc.slice(appSrc.indexOf("notice.className = 'mw-width-notice'"));
  const noticeBody = notice.slice(0, notice.indexOf('const toolbar ='));
  assert.ok(/pane\.activate\(\)/.test(noticeBody),
    'tapping the take-over affordance is an explicit claim and must be unconditional');
});

check('the take-over affordance compares against the SERVER width', () => {
  const sync = appSrc.slice(appSrc.indexOf('  syncPaneWidthNotice(slot) {'));
  const body = sync.slice(0, sync.indexOf('\n  }\n'));
  assert.ok(/pane\._remoteSizeFrame/.test(body),
    'comparing term.cols against this client own fit compares a number with itself, ' +
    'which is why this affordance had never once appeared');
  assert.ok(/owned \|\| applied <= mine \* CWMApp\.MW_WIDTH_NOTICE_RATIO/.test(body),
    'a client that owns the geometry is not being driven by anything');
});

check('the follower viewport pans on both axes and hides the nested scroller', () => {
  const block = stylesCss.slice(stylesCss.indexOf('.terminal-pane[data-mw-follow="1"] .terminal-container {'));
  const container = block.slice(0, block.indexOf('}'));
  assert.ok(/overflow:\s*auto/.test(container), 'the pane body is the scroller');
  assert.ok(/touch-action:\s*pan-x pan-y/.test(container), 'and it pans on both axes');
  const rootRule = stylesCss.slice(
    stylesCss.indexOf('.terminal-pane[data-mw-follow="1"] .xterm {'));
  assert.ok(/width:\s*max-content/.test(rootRule.slice(0, rootRule.indexOf('}'))),
    'the root takes its natural size, or there is nothing to pan across');
  const viewportRule = stylesCss.slice(
    stylesCss.indexOf('.terminal-pane[data-mw-follow="1"] .xterm-viewport {'));
  assert.ok(/overflow:\s*hidden/.test(viewportRule.slice(0, viewportRule.indexOf('}'))),
    'two scrollers on one axis, one absolutely positioned over the other, is a ' +
    'gesture nobody can aim');
  assert.ok(mobileCss.includes('.terminal-pane.mobile-active[data-mw-follow="1"] .terminal-container'),
    'the phone rules out-specify the ones inside the phone media query');
});

check('every pane template carries both type-size keys', () => {
  const down = (indexHtml.match(/data-key="fontdown"/g) || []).length;
  const up = (indexHtml.match(/data-key="fontup"/g) || []).length;
  const toolbars = (indexHtml.match(/class="terminal-mobile-toolbar"/g) || []).length;
  assert.strictEqual(down, toolbars, 'one smaller key per pane, got ' + down + ' of ' + toolbars);
  assert.strictEqual(up, toolbars, 'one larger key per pane, got ' + up + ' of ' + toolbars);
  assert.ok(/fontdown', 'fontup'/.test(appSrc),
    'both rungs sit adjacent in the priority table so they never overflow apart');
  assert.ok(/fontdown: 'Smaller type', fontup: 'Larger type'/.test(appSrc),
    'and both are labelled in the overflow sheet, which is where they live at 390px');
});

check('the type-size keys meet the touch floor from their own box', () => {
  const rule = mobileCss.slice(mobileCss.indexOf('.terminal-mobile-toolbar .toolbar-font {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.ok(/min-width:\s*44px/.test(body) && /min-height:\s*44px/.test(body),
    'the toolbar sets overflow-x: auto, which would clip an expanded pseudo-element');
});

check('changing the type size only reaches the PTY when this client owns it', () => {
  const step = termSrc.slice(termSrc.indexOf('  stepFontSize(direction) {'));
  const body = step.slice(0, step.indexOf('\n  }\n'));
  assert.ok(/_isFollowingRemoteGeometry\(\)/.test(body),
    'a follower changing its own type size must not resize a terminal it does not own');
  assert.ok(/TerminalPane\.storeFontPx\(next\)/.test(body), 'the choice is remembered');
  assert.ok(/this\._fontAutoResolved = true/.test(body),
    'and an explicit choice stops the first-run measurement from overriding it later');
});

check('the first-run size is verified against the real fit, not only estimated', () => {
  const resolve = termSrc.slice(termSrc.indexOf('  _resolveAutoFontSize(widthPx) {'));
  const body = resolve.slice(0, resolve.indexOf('\n  }\n'));
  assert.ok(/proposeDimensions\(\)/.test(body),
    'the arithmetic works from the container rect and the addon works from the ' +
    'terminal box; measured, the estimate said 60 columns and the fit gave 58');
  assert.ok(/guard < TERM_FONT_LADDER\.length/.test(body),
    'and the correction loop is bounded by the ladder');
});

console.log('  ' + '-'.repeat(66));
console.log('  [mobile-terminal-geometry] ' + passed + '/' + (passed + failed) + ' tests passed');
console.log('  ' + '-'.repeat(66) + '\n');

if (failed > 0) process.exit(1);
