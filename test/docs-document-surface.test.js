#!/usr/bin/env node
/**
 * docs-document-surface.test.js - the docs panel as a Notion document surface.
 * Created: 2026-08-13 (Notion restyle phase P4, work package P4.6).
 *
 * WHAT IT IS FOR
 *
 * BUILD-CONTRACT.md 6 calls P4.6 "the hardest step to revert", because it
 * rewrites component internals rather than a theme layer: a margin-based
 * rhythm becomes a padding-based one, and the 720px named-line grid replaces a
 * flat 20px inset. LAYOUT.md on why the padding matters: "A margin based
 * rhythm produces dead zones between blocks that you cannot click, and the
 * whole editor feel falls apart."
 *
 * Every failure mode here is invisible in a green build and hard to spot by
 * eye:
 *
 *   1. A margin creeping back onto a block. It looks almost identical and it
 *      silently reopens the dead zones.
 *   2. The list collapse reverting to the NAIVE rule (collapse any item that is
 *      not the last child). That is wrong for a run followed by a paragraph,
 *      and PROCEDURE 6.3 records it as a correction the bundle only found after
 *      rendering. Only `:has(+ .docs-item)` gets it right.
 *   3. The 40px one-line block quietly becoming 37px or 34px because the leaf
 *      padding or the body line-height moved. This test does the arithmetic
 *      from the shipped token values rather than trusting a comment.
 *   4. The seven section headers losing an `aria-expanded` button or an
 *      `aria-controls` target. The panel keeps working; the screen reader stops.
 *
 * MECHANICS: pure string parsing over styles.css and index.html, plus token
 * arithmetic read out of :root. No DOM, no browser, no network, no port.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;

/**
 * Record one named assertion.
 *
 * @param {string} name - What the assertion protects.
 * @param {boolean} ok - Whether it holds.
 * @param {string} [detail] - Extra context printed on failure.
 * @returns {void}
 */
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  - ' + detail : '')); }
}

/**
 * Extract the declaration block of the FIRST rule whose prelude matches.
 *
 * @param {string} selector - Exact selector text at the start of a line.
 * @returns {string} Declarations between the braces, or '' when absent.
 */
function ruleBlock(selector) {
  const at = CSS.indexOf('\n' + selector + ' {');
  if (at === -1) return '';
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return close === -1 ? '' : CSS.slice(open + 1, close);
}

/**
 * Read a pixel-valued custom property out of the token block.
 *
 * @param {string} name - Token name including the leading dashes.
 * @returns {number} The value in px, or NaN when absent or not a px value.
 */
function tokenPx(name) {
  const m = new RegExp('\\' + name + ':\\s*([0-9.]+)px').exec(CSS);
  return m ? parseFloat(m[1]) : NaN;
}

console.log('\n  \x1b[1mDocs panel as a document surface (P4.6, BUILD-CONTRACT 6)\x1b[0m');
console.log('  ' + '─'.repeat(42));

/* ─── 1. The 720px named-line grid ──────────────────────────────────────── */

const layout = ruleBlock('.nt-layout');
check('.nt-layout is a grid, not a centred max-width container',
  /display: grid;/.test(layout),
  'named lines are what keep a full-bleed block in the document flow');
check('the content column is minmax(auto, 720px) through the captured token',
  /--nt-content-width: minmax\(auto, var\(--app-content-width\)\);/.test(layout) &&
  /--app-content-width:\s*720px/.test(CSS));
check('the gutters are minmax(96px, 1fr) through the captured token',
  /--nt-margin-width: minmax\(var\(--app-margin-width\), 1fr\);/.test(layout) &&
  /--app-margin-width:\s*96px/.test(CSS));
check('all four named lines are declared, so grid-column: full and content both work',
  /\[full-start\]/.test(layout) && /\[content-start\]/.test(layout) &&
  /\[content-end\]/.test(layout) && /\[full-end\]/.test(layout));
check('children land in the content column by default',
  /grid-column: content;/.test(ruleBlock('.nt-layout > *')));
check('no media query reproduces the grid, because the minmax pair does the whole job',
  !/@media[^{]*\{[^}]*--nt-content-width: minmax\(auto/.test(CSS));
check('the docs body carries .nt-layout in the markup',
  /class="docs-structured nt-layout"/.test(HTML));
check('the wide modifier exists as an OPT IN and is not the default',
  /\.nt-layout-wide \{/.test(CSS) && !/\.nt-layout \{[^}]*--nt-content-width: 1fr/.test(CSS),
  'APPLY.md section 5: ship it as an opt in and keep 720px as the default');
check('the page bottom dead zone is the captured 270px',
  /padding: 16px 0 var\(--app-page-bottom-dead-zone\);/.test(ruleBlock('.docs-structured')) &&
  /--app-page-bottom-dead-zone:\s*270px/.test(CSS));

/* ─── 2. Zero margins between blocks ────────────────────────────────────── */

for (const [selector, label] of [
  ['.docs-section', 'section'],
  ['.docs-section-body', 'section body'],
  ['.docs-item', 'list block'],
  ['.docs-section-header', 'section header'],
]) {
  check('the ' + label + ' declares margin: 0, so the rhythm is all padding',
    /margin: 0/.test(ruleBlock(selector)),
    selector + ' must not reintroduce a margin-based rhythm');
}

/* ─── 3. The list collapse, and the correction PROCEDURE 6.3 records ────── */

check('a consecutive item collapses its TOP padding to 1px',
  /padding-top: var\(--app-block-pad-collapsed\);/.test(ruleBlock('.docs-item + .docs-item')));
check('an item collapses its BOTTOM padding only when the next sibling is also an item',
  /padding-bottom: var\(--app-block-pad-collapsed\);/.test(ruleBlock('.docs-item:has(+ .docs-item)')),
  'the naive "not the last child" rule is wrong for a run followed by a paragraph');
check('a solo item keeps the full 6px block padding',
  /padding: var\(--app-block-pad\);/.test(ruleBlock('.docs-item')));
check('the collapsed value is the captured 1px and the block value the captured 6px',
  tokenPx('--app-block-pad-collapsed') === 1 && tokenPx('--app-block-pad') === 6);

/* ─── 4. A one-line block measures exactly 40px ─────────────────────────── */

const wrapper = tokenPx('--app-block-pad');
const leaf = tokenPx('--app-leaf-pad');
const line = tokenPx('--app-body-line');
const oneLine = wrapper + leaf + line + leaf + wrapper;
check('the block arithmetic closes at exactly 40px (6 + 2 + 24 + 2 + 6)',
  oneLine === tokenPx('--app-block-height-1line') && oneLine === 40,
  'measured ' + oneLine + 'px against the captured --app-block-height-1line');
check('the leaf carries the 2px text padding that makes the arithmetic close',
  /padding: var\(--app-leaf-pad\) 0;/.test(ruleBlock('.docs-item-text,\n.docs-note-text')));
check('the item text is the 16px/24px document body, not a 13px UI size',
  /font-size: var\(--app-body-size\);/.test(ruleBlock('.docs-item-text,\n.docs-note-text')) &&
  /line-height: var\(--app-body-line\);/.test(ruleBlock('.docs-item-text,\n.docs-note-text')));

/* ─── 5. The hover box is the INNER box, not the whole block ────────────── */

check('the hover box is a pseudo-element inset by the block padding',
  /inset: var\(--app-block-pad\) 0;/.test(ruleBlock('.docs-item::before')),
  'painting the wash on the block turns a run of items into one continuous slab');
check('the hover wash stays behind the hover gate',
  /\.nt-enable-hover \.docs-item:hover::before \{/.test(CSS));
check('the collapsed edges collapse the hover box with them',
  /top: var\(--app-block-pad-collapsed\);/.test(ruleBlock('.docs-item + .docs-item::before')) &&
  /bottom: var\(--app-block-pad-collapsed\);/.test(ruleBlock('.docs-item:has(+ .docs-item)::before')));

/* ─── 6. The seven sections keep their accessibility contract ───────────── */

const controls = [...HTML.matchAll(/aria-controls="(docs-[a-z-]+)"/g)].map((m) => m[1]);
check('all seven docs sections still declare aria-controls, in order',
  JSON.stringify(controls) === JSON.stringify([
    'docs-notes-list', 'docs-goals-list', 'docs-tasks-list', 'docs-td-list',
    'docs-roadmap-list', 'docs-rules-list', 'docs-ai-insights',
  ]),
  'found ' + JSON.stringify(controls));
check('every section header is still a button carrying aria-expanded',
  (HTML.match(/class="docs-section-header" aria-expanded=/g) || []).length >= 6,
  'a div with a click handler is not a disclosure control');

/* ─── 7. The callout, and the bar that is gone ──────────────────────────── */

const callout = ruleBlock('.docs-rule-item');
check('a rule item is a callout on a named-palette ground, not a left-barred box',
  /background: var\(--app-bg-yellow\);/.test(callout) && !/border-left:/.test(callout),
  'zero left borders, zero bars, zero underlines');
check('the callout takes the captured 10px radius and the 12px inner padding',
  /border-radius: var\(--radius-callout\);/.test(callout) &&
  /padding: var\(--app-block-inner-pad\);/.test(callout));

console.log('  ──────────────────────────────────────────');
console.log('  [docs-document-surface] ' + passed + '/' + (passed + failed) + ' tests passed');
if (failed > 0) process.exit(1);
