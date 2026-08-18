#!/usr/bin/env node
/**
 * fake-agent.js - the terminal "player" the marketing capture panes run.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * EVERYTHING THIS SCRIPT PRINTS IS INVENTED. There is no account behind it, no
 * model call, no network, no file read and no file write. The project names,
 * file paths, diffs, test counts and timings are fabricated to look like a real
 * Claude Code turn so the footage shows a plausible session, and they match the
 * invented fixture in scripts/media/fixture.js. Nothing here is copied from,
 * derived from, or capable of reaching the operator's real sessions.
 *
 * WHY A PLAYER RATHER THAN A REAL CLI
 *
 * A marketing clip has to be re-shootable byte for byte. A real agent CLI needs
 * credentials, a network and a model, takes tens of seconds to cold start, and
 * prints something different every run, so a re-shoot after a UI tweak would
 * change the content as well as the chrome. This prints the same turn, at the
 * same pace, every time, in a few seconds.
 *
 * WHY THE NORMAL BUFFER, NOT THE ALTERNATE ONE
 *
 * test/browser/fake-agent-cli.js already reproduces the alternate-screen agent
 * pane, because that is the case the Unified Scrollback Surface exists for. This
 * player is the opposite case on purpose: it stays in the NORMAL buffer and
 * emits enough rows to fill the terminal's own scrollback, because the clip the
 * contract asks for is "wheel back through history, drag-select across the seam,
 * copy" and a viewport that never scrolls has no history to wheel back through.
 * SCROLLBACK_FLOOR below is the guarantee that there is always something above
 * the fold to scroll to.
 *
 * GLYPH DISCIPLINE
 *
 * test/terminal-font-coverage.test.js documents the bug this constrains: a
 * character the leading terminal face does not map is drawn by a fallback face
 * at THAT face's advance width, inside a cell grid xterm measured from the
 * leading face, so every row containing it drifts. In a still that is ugly; in a
 * 12 fps clip it shimmers. So the output is confined to printable ASCII plus the
 * eight light box-drawing characters in BOX_DRAWING below, and
 * test/media-pipeline.test.js fails the suite if anything else appears.
 *
 * Usage:
 *   node scripts/media/fake-agent.js              # paced, then idles at a prompt
 *   node scripts/media/fake-agent.js --fast       # same content, minimal pacing
 *   node scripts/media/fake-agent.js --dry        # print everything, no pacing, exit
 *   node scripts/media/fake-agent.js --plain      # no colour (for diffing content)
 *   node scripts/media/fake-agent.js --variant push   # the shorter second story
 *   node scripts/media/fake-agent.js --speed 0.3      # same beats, 0.3x the delays
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module scripts/media/fake-agent
 */

'use strict';

/* ── Pacing ────────────────────────────────────────────────────────────────
   The clip is captured at 12 fps, so a beat shorter than about 80 ms cannot be
   seen at all and a beat longer than about 1200 ms wastes budget. These are the
   two ends of that window, chosen so a 10 second clip lands on a natural pause
   rather than mid-word. */

/** Delay after a line of narrative prose, in milliseconds. */
const BEAT_PROSE_MS = 260;

/** Delay after a tool-call header, in milliseconds. Long enough to read. */
const BEAT_TOOL_MS = 420;

/** Delay between two rows of the same block, in milliseconds. */
const BEAT_ROW_MS = 55;

/** Delay before the closing summary, in milliseconds. */
const BEAT_SETTLE_MS = 700;

/** Per-character delay while echoing the operator's prompt, in milliseconds. */
const BEAT_TYPE_MS = 26;

/** Multiplier applied to every delay under --fast. */
const FAST_FACTOR = 0.15;

/**
 * Bounds on `--speed`.
 *
 * WHY THE FLAG EXISTS. The first cut of every clip ran two to seven times over
 * its contract duration, and almost all of the excess was the camera watching
 * this player type. The pacing above is tuned for a person reading a terminal;
 * a ten second marketing clip cannot afford eighteen seconds of it. `--speed`
 * scales every delay at once so a capture scene can ask for the same transcript
 * at the rate its budget allows, without a second copy of the script tuned
 * differently. Clamped so a typo cannot stall a shoot or flatten the pacing to
 * nothing.
 */
const SPEED_MIN = 0.05;

/** @see SPEED_MIN */
const SPEED_MAX = 4;

/** How often the idle loop wakes after the turn finishes, in milliseconds. */
const IDLE_TICK_MS = 5000;

/**
 * The floor on emitted rows.
 *
 * The terminal viewport at the capture size holds roughly 30 rows, so 200 rows
 * guarantees at least six screens of scrollback above the fold. The capture
 * scene wheels back through that; a shorter transcript would hit the top of the
 * buffer mid-gesture and the clip would show a dead scroll.
 */
const SCROLLBACK_FLOOR = 200;

/* ── Glyph repertoire ─────────────────────────────────────────────────────── */

/**
 * The eight light box-drawing characters the frames are allowed to use.
 *
 * Chosen as the intersection of what every mono face in the --font-terminal
 * chain maps on a machine that can run this project: Cascadia Mono, Cascadia
 * Code, Consolas, DejaVu Sans Mono, Menlo and SF Mono all carry the light box
 * set. Deliberately EXCLUDED, because coverage is not universal and a miss
 * shimmers: heavy and double frames, block elements (U+2580-259F), braille
 * spinners (U+2800-28FF), arrows, check marks, and the U+23FA / U+23BF pair the
 * real CLI uses for its bullets. ASCII stands in for those.
 */
const BOX_DRAWING = Object.freeze({
  H: '─',   // horizontal
  V: '│',   // vertical
  TL: '┌',  // top left
  TR: '┐',  // top right
  BL: '└',  // bottom left
  BR: '┘',  // bottom right
  TEE_L: '├', // left tee
  TEE_R: '┤', // right tee
});

/**
 * Every code point the player may emit, as a frozen sorted array.
 *
 * Exported so test/media-pipeline.test.js can assert the rendered script never
 * strays outside it, rather than trusting a reviewer to notice a pasted emoji.
 * Printable ASCII is expressed as a range for readability.
 */
const REPERTOIRE = Object.freeze({
  asciiLow: 0x20,
  asciiHigh: 0x7e,
  newline: 0x0a,
  extra: Object.freeze(Object.values(BOX_DRAWING).map((c) => c.codePointAt(0)).sort((a, b) => a - b)),
});

/* ── Colour ────────────────────────────────────────────────────────────────
   Basic 16-colour SGR only, never 256-colour or truecolor. The point is that
   every colour on screen comes from the ACTIVE TERMINAL PALETTE, so the themes
   clip can swap palettes and the transcript recolours with it. A truecolor
   escape would pin the output to one palette and make that clip pointless. */

/** The ESC byte, written as a code point so no raw control character is committed. */
const ESC = String.fromCharCode(27);
const SGR = (n) => ESC + '[' + n + 'm';

const C = Object.freeze({
  reset: SGR(0),
  dim: SGR(2),
  bold: SGR(1),
  red: SGR(31),
  green: SGR(32),
  yellow: SGR(33),
  blue: SGR(34),
  magenta: SGR(35),
  cyan: SGR(36),
  white: SGR(37),
  brightBlack: SGR(90),
  brightGreen: SGR(92),
  brightYellow: SGR(93),
  brightBlue: SGR(94),
  brightCyan: SGR(96),
});

/* ── Content ──────────────────────────────────────────────────────────────── */

/**
 * Width of the drawn frames, in cells.
 *
 * 56 rather than the 80 a terminal usually assumes, and the reason is the
 * HISTORY surface rather than the terminal. The scrollback document is a
 * `pre-wrap` block whose wrap point is computed in CSS pixels, and it lands a
 * cell or two earlier than xterm's own column count. A frame sized to the
 * terminal's width therefore renders correctly in the live pane and wraps its
 * closing rule onto a line of its own the moment the same text is read back
 * through the history surface. 56 keeps both surfaces inside their wrap point
 * even in a half-width pane.
 */
const FRAME_WIDTH = 56;

/**
 * The invented existing test suite, enumerated group by group.
 *
 * Two jobs. It reads like a real suite, which is what makes the footage
 * plausible, and it is long enough on its own to push the emitted row count
 * past SCROLLBACK_FLOOR so the terminal clip always has history to wheel back
 * through. Every name is fabricated.
 */
const EXISTING_CASES = Object.freeze([
  ['line items', [
    'sums a single line item',
    'sums several line items',
    'multiplies by quantity',
    'rejects a negative quantity',
    'rejects a zero quantity',
    'ignores an item marked removed',
    'keeps two decimal places',
    'rounds half away from zero',
  ]],
  ['percentage discounts', [
    'applies ten percent',
    'applies a hundred percent',
    'refuses more than a hundred percent',
    'refuses a negative percentage',
    'applies to the subtotal, not to tax',
    'stacks with a fixed amount code',
    'reports the amount taken off',
  ]],
  ['fixed amount discounts', [
    'takes a flat five off',
    'never takes the total below zero',
    'refuses a discount larger than the cart',
    'reports the amount taken off',
    'is applied before tax',
  ]],
  ['gift cards', [
    'draws the full balance',
    'draws a partial balance',
    'leaves the remainder on the card',
    'refuses an expired card',
    'refuses a card with no balance',
    'accepts two cards in one order',
    'is applied after tax',
  ]],
  ['tax', [
    'looks up the rate for the region',
    'falls back to the default rate',
    'exempts a zero rated item',
    'rounds the tax line separately',
  ]],
  ['totals', [
    'returns subtotal, tax and total',
    'returns the raw subtotal on the receipt',
    'returns zero for an empty cart',
    'is stable across two calls',
  ]],
]);

/**
 * Draw a labelled box frame.
 *
 * @param {string} label - Header text, printed inside the top rule.
 * @param {string[]} rows - Body rows, each already short enough to fit.
 * @returns {string[]} The frame as an array of lines.
 */
function frame(label, rows) {
  const inner = FRAME_WIDTH - 2;
  const head = ' ' + label + ' ';
  const dashes = Math.max(0, inner - head.length - 1);
  const lines = [];
  lines.push(BOX_DRAWING.TL + BOX_DRAWING.H + head + BOX_DRAWING.H.repeat(dashes) + BOX_DRAWING.TR);
  for (const row of rows) {
    const text = row.length > inner - 2 ? row.slice(0, inner - 5) + '...' : row;
    lines.push(BOX_DRAWING.V + ' ' + text + ' '.repeat(Math.max(0, inner - 1 - text.length)) + BOX_DRAWING.V);
  }
  lines.push(BOX_DRAWING.BL + BOX_DRAWING.H.repeat(inner) + BOX_DRAWING.BR);
  return lines;
}

/**
 * A separator rule the width of a frame.
 *
 * @returns {string} One rule line.
 */
function rule() {
  return BOX_DRAWING.TEE_L + BOX_DRAWING.H.repeat(FRAME_WIDTH - 2) + BOX_DRAWING.TEE_R;
}

/**
 * The invented turn, as an ordered list of chunks with their pacing.
 *
 * Pure: it reads nothing, writes nothing and returns the same value every call,
 * which is what makes it testable without a terminal. The player is the only
 * thing that turns it into timed output.
 *
 * @param {{colour: boolean}} opts - Rendering options.
 * @returns {Array<{text: string, delay: number, type: boolean}>} Ordered chunks.
 */
function buildTurn(opts) {
  const colour = opts && opts.colour !== false;
  const paint = (code, text) => (colour ? code + text + C.reset : text);
  const out = [];

  /**
   * Queue one line.
   *
   * @param {string} text - Line content, without the trailing newline.
   * @param {number} delay - Milliseconds to wait after printing it.
   * @returns {void}
   */
  const line = (text, delay) => out.push({ text: text + '\r\n', delay: delay === undefined ? BEAT_ROW_MS : delay, type: false });

  /**
   * Queue a block of lines that share one trailing pause.
   *
   * @param {string[]} rows - Lines to print.
   * @param {number} tail - Milliseconds to wait after the last one.
   * @returns {void}
   */
  const block = (rows, tail) => {
    rows.forEach((row, i) => line(row, i === rows.length - 1 ? tail : BEAT_ROW_MS));
  };

  // ── The operator's prompt, echoed a character at a time ──────────────────
  out.push({
    text: paint(C.brightCyan + C.bold, '> ') +
      'the checkout total is wrong when a discount and a gift card are both applied',
    delay: BEAT_PROSE_MS,
    type: true,
  });
  line('', BEAT_PROSE_MS);

  line(paint(C.dim, 'storefront-api  on  fix/checkout-race'), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  line('I will read the reducer, find where the two adjustments are applied, and', BEAT_ROW_MS);
  line('check the test that covers the combination.', BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  // ── Tool call 1: read ────────────────────────────────────────────────────
  block(frame('Read  src/checkout/total.js', [
    '148 lines, 4.1 KB',
    'applyDiscount() at line 61, applyGiftCard() at line 94',
    'both mutate the same running subtotal',
  ]), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);

  // ── Tool call 2: grep ────────────────────────────────────────────────────
  block(frame('Grep  applyGiftCard', [
    'src/checkout/total.js:94',
    'src/checkout/total.js:131',
    'test/checkout-total.test.js:78',
    '3 matches in 2 files',
  ]), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);

  line('The order matters. applyGiftCard reads the subtotal that applyDiscount', BEAT_ROW_MS);
  line('has not written back yet, so a percentage discount is computed against', BEAT_ROW_MS);
  line('the pre-gift-card figure and the gift card against the pre-discount one.', BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  // ── Long, colourful reading output: this is the scrollback bulk ──────────
  line(paint(C.bold, 'Reading the checkout module'), BEAT_ROW_MS);
  line(rule(), BEAT_ROW_MS);
  const files = [
    ['src/checkout/total.js', 148, 'subtotal, discount, gift card, tax'],
    ['src/checkout/cart.js', 96, 'line items and quantity rules'],
    ['src/checkout/discount.js', 74, 'percentage and fixed-amount codes'],
    ['src/checkout/giftcard.js', 61, 'balance draw-down, partial use'],
    ['src/checkout/tax.js', 88, 'per-region rate lookup'],
    ['src/checkout/index.js', 42, 'public surface'],
    ['test/checkout-total.test.js', 210, '31 cases, 2 skipped'],
    ['test/checkout-cart.test.js', 132, '18 cases'],
    ['test/checkout-tax.test.js', 77, '11 cases'],
  ];
  for (const [file, lines, note] of files) {
    line('  ' + paint(C.brightBlue, pad(file, 30)) + paint(C.dim, pad(String(lines) + ' lines', 12)) + paint(C.brightBlack, note), BEAT_ROW_MS);
  }
  line(rule(), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  // ── The existing suite, enumerated ───────────────────────────────────────
  //
  // This block exists as much for the CAPTURE as for the story. The terminal
  // clip has to wheel back through scrollback, and scrollback only exists if
  // the pane has emitted more rows than the viewport holds. Enumerating the
  // suite is the most natural way an agent turn produces sixty plausible rows
  // in a row, so the wheel gesture has somewhere to travel.
  line(paint(C.bold, 'Read  test/checkout-total.test.js'), BEAT_TOOL_MS);
  line(rule(), BEAT_ROW_MS);
  for (const [group, cases] of EXISTING_CASES) {
    line('  ' + paint(C.brightCyan, group), BEAT_ROW_MS);
    for (const name of cases) {
      line('    ' + paint(C.dim, '-') + ' ' + name, BEAT_ROW_MS);
    }
  }
  line(rule(), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);
  line('The combination case is the one that is missing. Every existing case', BEAT_ROW_MS);
  line('applies one adjustment at a time, so the ordering bug was never', BEAT_ROW_MS);
  line('reachable from the suite.', BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  // ── The fix ──────────────────────────────────────────────────────────────
  line(paint(C.bold, 'Edit  src/checkout/total.js'), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);
  const diff = [
    ['@@', '@@ -58,14 +58,19 @@ function computeTotal(cart, adjustments) {'],
    [' ', '   let subtotal = cart.items.reduce(sumLineItems, 0);'],
    [' ', ''],
    ['-', '  const discounted = applyDiscount(subtotal, adjustments.discount);'],
    ['-', '  const afterGift = applyGiftCard(subtotal, adjustments.giftCard);'],
    ['-', '  return { total: discounted - afterGift, subtotal };'],
    ['+', '  // Adjustments are ordered, not parallel. Each one has to see the'],
    ['+', '  // running subtotal the previous one produced, or a percentage'],
    ['+', '  // discount and a gift card both price against the original figure'],
    ['+', '  // and the customer is charged twice for the same reduction.'],
    ['+', '  subtotal = applyDiscount(subtotal, adjustments.discount);'],
    ['+', '  subtotal = applyGiftCard(subtotal, adjustments.giftCard);'],
    ['+', '  return { total: subtotal, subtotal: cart.rawSubtotal };'],
    [' ', ' }'],
  ];
  for (const [kind, text] of diff) {
    if (kind === '+') line(paint(C.brightGreen, '  + ' + text.replace(/^ {2}/, '')), BEAT_ROW_MS);
    else if (kind === '-') line(paint(C.red, '  - ' + text.replace(/^ {2}/, '')), BEAT_ROW_MS);
    else if (kind === '@@') line(paint(C.magenta, '  ' + text), BEAT_ROW_MS);
    else line(paint(C.dim, '   ' + text), BEAT_ROW_MS);
  }
  line('', BEAT_PROSE_MS);

  // ── Tests ────────────────────────────────────────────────────────────────
  // `npx vitest run checkout` rather than the `npm test` form a real session
  // would more often show. The npm form needs a bare double hyphen to separate
  // its own arguments from the runner's, and gate G12b in
  // scripts/do-not-break-gates.js fails the suite on any added line carrying
  // one. The command is equally plausible and the frame is identical.
  line(paint(C.bold, 'Bash  npx vitest run checkout'), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);
  let caseCount = 0;
  for (const [group, cases] of EXISTING_CASES) {
    line('  ' + paint(C.bold, group), BEAT_ROW_MS);
    for (const name of cases) {
      caseCount++;
      line('    ' + paint(C.brightGreen, 'pass') + '  ' + pad(name, 44) + paint(C.dim, (3 + (caseCount % 7)) + ' ms'), BEAT_ROW_MS);
    }
  }
  line('    ' + paint(C.bold, 'ordering') + '  ' + paint(C.dim, '(new)'), BEAT_ROW_MS);
  line('    ' + paint(C.brightGreen, 'pass') + '  ' + pad('discount then gift card on one subtotal', 44) + paint(C.dim, '6 ms'), BEAT_ROW_MS);
  line('    ' + paint(C.brightGreen, 'pass') + '  ' + pad('gift card then discount on one subtotal', 44) + paint(C.dim, '5 ms'), BEAT_ROW_MS);
  line('', BEAT_ROW_MS);
  line('  ' + paint(C.brightGreen + C.bold, (caseCount + 2) + ' passing') + paint(C.dim, '  (1.42s)'), BEAT_ROW_MS);
  line('  ' + paint(C.dim, '2 pending'), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  // ── A warning, so the palette shows a third hue ──────────────────────────
  line('  ' + paint(C.brightYellow, 'note') + '  ' + paint(C.dim, 'test/checkout-total.test.js:78 still asserts the old shape'), BEAT_ROW_MS);
  line('  ' + paint(C.brightYellow, 'note') + '  ' + paint(C.dim, 'subtotal is now the raw figure, not the discounted one'), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  block(frame('Edit  test/checkout-total.test.js', [
    'line 78: expect(result.subtotal).toBe(cart.rawSubtotal)',
    '1 assertion updated, 0 added',
  ]), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);

  // ── Working tree review ─────────────────────────────────────────────────
  line(paint(C.bold, 'Bash  git status --short'), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);
  const status = [
    ['M ', 'src/checkout/total.js'],
    ['M ', 'test/checkout-total.test.js'],
    ['  ', 'src/checkout/cart.js'],
    ['  ', 'src/checkout/discount.js'],
    ['  ', 'src/checkout/giftcard.js'],
    ['  ', 'src/checkout/tax.js'],
  ];
  for (const [flag, file] of status) {
    const mark = flag.trim() ? paint(C.brightYellow, flag) : paint(C.dim, flag);
    line('  ' + mark + ' ' + (flag.trim() ? file : paint(C.dim, file)), BEAT_ROW_MS);
  }
  line('', BEAT_ROW_MS);
  line('  ' + paint(C.dim, '2 files changed, 6 unchanged'), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  block(frame('Bash  npx eslint src/checkout', [
    'src/checkout/total.js   0 problems',
    'src/checkout/cart.js    0 problems',
    'src/checkout/discount.js  0 problems',
    'src/checkout/giftcard.js  0 problems',
    'src/checkout/tax.js     0 problems',
    'src/checkout/index.js   0 problems',
    'clean',
  ]), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);

  // ── Summary ──────────────────────────────────────────────────────────────
  line(paint(C.bold, 'Summary'), BEAT_ROW_MS);
  line(rule(), BEAT_ROW_MS);
  line('  ' + paint(C.brightGreen, '+10') + '  ' + paint(C.red, '-3') + '   ' + paint(C.dim, 'src/checkout/total.js'), BEAT_ROW_MS);
  line('  ' + paint(C.brightGreen, ' +1') + '  ' + paint(C.red, '-1') + '   ' + paint(C.dim, 'test/checkout-total.test.js'), BEAT_ROW_MS);
  line(rule(), BEAT_ROW_MS);
  line('', BEAT_ROW_MS);
  line('  ' + paint(C.dim, 'branch') + '    fix/checkout-race', BEAT_ROW_MS);
  line('  ' + paint(C.dim, 'ahead') + '     2 commits', BEAT_ROW_MS);
  line('  ' + paint(C.dim, 'suite') + '     ' + (caseCount + 2) + ' passing, 2 pending', BEAT_ROW_MS);
  line('  ' + paint(C.dim, 'lint') + '      clean', BEAT_ROW_MS);
  line('  ' + paint(C.dim, 'duration') + '  1.42s', BEAT_ROW_MS);
  line('', BEAT_ROW_MS);
  line('Adjustments now apply in order against one running subtotal, so a', BEAT_ROW_MS);
  line('discount and a gift card no longer both price against the original', BEAT_ROW_MS);
  line('figure. The reported subtotal is the raw one, which is what the', BEAT_ROW_MS);
  line('receipt template already expected.', BEAT_SETTLE_MS);
  line('', BEAT_ROW_MS);
  line(paint(C.brightCyan + C.bold, 'Done.') + paint(C.dim, '  4 files read, 2 edited, 83 tests passing.'), BEAT_SETTLE_MS);
  line('', BEAT_ROW_MS);
  line(paint(C.brightCyan + C.bold, '> ') + paint(C.dim, '_'), BEAT_ROW_MS);

  return out;
}

/**
 * The second invented turn, for a pane running beside the first.
 *
 * WHY A SECOND STORY EXISTS AT ALL. The hero and both desktop stills show two
 * panes side by side. Running one script in both makes the frame read as a
 * rendering bug rather than as two sessions, because a viewer's eye lands on
 * the repetition before it lands on anything else. This is shorter than the
 * checkout turn on purpose: the second pane is scenery, and the clip that needs
 * deep scrollback only ever uses one pane.
 *
 * Same glyph discipline, same colour discipline, same invented world: this is
 * the `mobile-app` project from scripts/media/fixture.js.
 *
 * @param {{colour: boolean}} opts - Rendering options.
 * @returns {Array<{text: string, delay: number, type: boolean}>} Ordered chunks.
 */
function buildTurnB(opts) {
  const colour = opts && opts.colour !== false;
  const paint = (code, text) => (colour ? code + text + C.reset : text);
  const out = [];
  const line = (text, delay) => out.push({ text: text + '\r\n', delay: delay === undefined ? BEAT_ROW_MS : delay, type: false });
  const block = (rows, tail) => rows.forEach((row, i) => line(row, i === rows.length - 1 ? tail : BEAT_ROW_MS));

  out.push({
    text: paint(C.brightCyan + C.bold, '> ') + 'wire up expo push tokens and the server side fan-out',
    delay: BEAT_PROSE_MS,
    type: true,
  });
  line('', BEAT_PROSE_MS);
  line(paint(C.dim, 'mobile-app  on  feat/push-notifications'), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  line('Registering the device token on launch, storing it against the', BEAT_ROW_MS);
  line('account, then fanning out from the notification worker.', BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  block(frame('Read  src/push/register.js', [
    '74 lines, 2.2 KB',
    'requests permission, then never stores the token',
  ]), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);

  block(frame('Grep  devicePushToken', [
    'src/push/register.js:31',
    'server/notify/worker.js:88',
    '2 matches in 2 files',
  ]), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);

  line(paint(C.bold, 'Edit  src/push/register.js'), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);
  line(paint(C.magenta, '  @@ -28,6 +28,11 @@ export async function registerForPush() {'), BEAT_ROW_MS);
  line(paint(C.dim, '     const granted = await requestPermission();'), BEAT_ROW_MS);
  line(paint(C.red, '  -  if (!granted) return null;'), BEAT_ROW_MS);
  line(paint(C.brightGreen, '  +  if (!granted) return { granted: false, token: null };'), BEAT_ROW_MS);
  line(paint(C.brightGreen, '  +  const token = await getDevicePushToken();'), BEAT_ROW_MS);
  line(paint(C.brightGreen, '  +  await api.put("/account/push-token", { token });'), BEAT_ROW_MS);
  line(paint(C.brightGreen, '  +  return { granted: true, token };'), BEAT_ROW_MS);
  line('', BEAT_PROSE_MS);

  line(paint(C.bold, 'Bash  npx vitest run push'), BEAT_TOOL_MS);
  line('', BEAT_ROW_MS);
  const cases = [
    'stores the token after permission is granted',
    'returns granted false when permission is denied',
    'does not call the api when there is no token',
    'replaces a stale token on reinstall',
    'fans out to every registered device',
    'skips a device that returned a 410',
  ];
  cases.forEach((name, i) => {
    line('  ' + paint(C.brightGreen, 'pass') + '  ' + pad(name, 46) + paint(C.dim, (4 + i) + ' ms'), BEAT_ROW_MS);
  });
  line('', BEAT_ROW_MS);
  line('  ' + paint(C.brightGreen + C.bold, '6 passing') + paint(C.dim, '  (0.61s)'), BEAT_PROSE_MS);
  line('', BEAT_ROW_MS);

  line(paint(C.bold, 'Summary'), BEAT_ROW_MS);
  line(rule(), BEAT_ROW_MS);
  line('  ' + paint(C.brightGreen, '+5') + '  ' + paint(C.red, '-1') + '   ' + paint(C.dim, 'src/push/register.js'), BEAT_ROW_MS);
  line('  ' + paint(C.brightGreen, '+9') + '  ' + paint(C.red, '-0') + '   ' + paint(C.dim, 'server/notify/worker.js'), BEAT_ROW_MS);
  line(rule(), BEAT_ROW_MS);
  line('', BEAT_ROW_MS);
  line('A denied permission is now a value rather than a null, so the', BEAT_ROW_MS);
  line('caller can tell "the user said no" from "the token never arrived".', BEAT_SETTLE_MS);
  line('', BEAT_ROW_MS);
  line(paint(C.brightCyan + C.bold, 'Done.') + paint(C.dim, '  2 files read, 2 edited, 6 tests passing.'), BEAT_SETTLE_MS);
  line('', BEAT_ROW_MS);
  line(paint(C.brightCyan + C.bold, '> ') + paint(C.dim, '_'), BEAT_ROW_MS);

  return out;
}

/**
 * The two stories, by name.
 *
 * `checkout` is the long one with enough scrollback for the terminal clip;
 * `push` is the shorter companion for a second pane.
 */
const VARIANTS = Object.freeze({
  checkout: buildTurn,
  push: buildTurnB,
});

/**
 * Right-pad to a fixed cell width without ever truncating below one space.
 *
 * @param {string} text - Source text.
 * @param {number} width - Target cell width.
 * @returns {string} Padded text.
 */
function pad(text, width) {
  if (text.length >= width) return text + ' ';
  return text + ' '.repeat(width - text.length);
}

/**
 * Render the whole turn as plain text, with no escapes and no pacing.
 *
 * This is what the glyph gate measures, and it is also the cheapest way to see
 * what the clip will say without opening a terminal.
 *
 * @param {string} [variant] - Story name, from VARIANTS. Defaults to `checkout`.
 * @returns {string} The full transcript.
 */
function renderPlain(variant) {
  const build = VARIANTS[variant] || buildTurn;
  return build({ colour: false }).map((chunk) => chunk.text).join('');
}

/**
 * How many rows the turn emits.
 *
 * @param {string} [variant] - Story name, from VARIANTS. Defaults to `checkout`.
 * @returns {number} Line count, counting the trailing newline as ending a line.
 */
function lineCount(variant) {
  return renderPlain(variant).split('\n').length - 1;
}

/* ── Player ───────────────────────────────────────────────────────────────── */

/**
 * Write to the PTY, tolerating a closed pipe.
 *
 * A capture scene kills the pane when the beat ends, which closes stdout under
 * the player. That is the expected end of life, not an error, so it is
 * swallowed rather than thrown into a stack trace the camera would film.
 *
 * @param {string} text - Bytes to write.
 * @returns {void}
 */
function write(text) {
  try { process.stdout.write(text); } catch (_) { /* the pane closed first */ }
}

/**
 * Clamp a requested speed multiplier into the supported range.
 *
 * A non-numeric or missing value means "as authored", which is 1.
 *
 * @param {number} value - Requested multiplier.
 * @returns {number} A multiplier inside [SPEED_MIN, SPEED_MAX].
 */
function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

/**
 * Sleep.
 *
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Play the turn at the configured pace, then idle at a prompt.
 *
 * @param {{fast: boolean, colour: boolean, variant: string, speed: number}} opts - Player options.
 * @returns {Promise<void>} Resolves once the turn has been printed.
 */
async function play(opts) {
  const factor = clampSpeed(opts.fast ? FAST_FACTOR : opts.speed);
  const build = VARIANTS[opts.variant] || buildTurn;
  for (const chunk of build({ colour: opts.colour })) {
    if (chunk.type) {
      // Echo the operator's line a character at a time, which is the single
      // most recognisable "a person is driving this" cue in the whole clip.
      for (const ch of chunk.text) {
        write(ch);
        await sleep(BEAT_TYPE_MS * factor);
      }
      write('\r\n');
    } else {
      write(chunk.text);
    }
    await sleep(chunk.delay * factor);
  }
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when the player has finished or exited.
 */
async function main() {
  const argv = process.argv.slice(2);
  const colour = !argv.includes('--plain');
  const variantIndex = argv.indexOf('--variant');
  const variant = variantIndex === -1 ? 'checkout' : (argv[variantIndex + 1] || 'checkout');
  const build = VARIANTS[variant] || buildTurn;
  if (argv.includes('--dry')) {
    write(colour ? build({ colour: true }).map((c) => c.text).join('') : renderPlain(variant));
    return;
  }
  const speedIndex = argv.indexOf('--speed');
  const speed = speedIndex === -1 ? 1 : Number(argv[speedIndex + 1]);
  await play({ fast: argv.includes('--fast'), colour, variant, speed });
  // Hold the pane open. A player that exits leaves a dead terminal on screen,
  // and the last beat of every clip is supposed to rest on a live prompt.
  setInterval(() => {}, IDLE_TICK_MS);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

module.exports = {
  BOX_DRAWING,
  REPERTOIRE,
  SCROLLBACK_FLOOR,
  clampSpeed,
  SPEED_MIN,
  SPEED_MAX,
  buildTurn,
  buildTurnB,
  VARIANTS,
  renderPlain,
  lineCount,
  frame,
};
