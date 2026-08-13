#!/usr/bin/env node
/**
 * side-peek.test.js - the session side peek's contract test.
 * Created: 2026-08-13 (Notion restyle phase P4 remainder, work package B1).
 *
 * WHAT IT IS FOR
 *
 * DESIGN-SPEC.md 7 and BUILD-CONTRACT.md 2.12 turn the session detail panel
 * into a Notion side peek: a fixed-measure layout SIBLING that narrows the main
 * column rather than covering it, a 44px header mirroring the topbar, and an
 * eight-property grid on one aligned label column. DECISIONS.md 12.6 item 1
 * named it the largest region the restyle had not touched.
 *
 * Three of the things it ships are one careless edit away from silently
 * reverting, and none of them is visible in a passing build:
 *
 *   1. `display: contents` on `.meta-row`. This is what lets a grid declared on
 *      the grandparent align twelve label/value pairs with ZERO markup change.
 *      Someone restoring `display: flex` to "fix" a row would break the column
 *      alignment of every property at once, and nothing else would fail.
 *   2. The desktop width ladder being scoped to `min-width: 769px`. An unscoped
 *      `width` over-constrains the phone's full-bleed `left:0; right:0`
 *      slide-over and collapses it to 420px against the left edge. That is a
 *      phone-only regression, which is exactly the kind a desktop test run
 *      never sees.
 *   3. The notes editor never clobbering a focused textarea. renderSessionDetail
 *      runs on every SSE session event, so a render that writes into a focused
 *      editor eats what the user is typing, at an interval they cannot predict.
 *
 * It also pins the two properties the peek gained (Provider and Model) reading
 * through the SHARED helpers rather than through a second copy of the chip
 * rules, which is the same single-source discipline recency-surfaces.test.js
 * enforces for the four recency surfaces.
 *
 * MECHANICS: pure string parsing over index.html, app.js and styles.css. No
 * DOM, no browser, no network, no server, no port.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');

/**
 * Read a frontend source with newlines normalised, so a CRLF checkout and an
 * LF checkout produce identical matches.
 *
 * @param {string} name - File name under src/web/public.
 * @returns {string} Normalised file contents.
 */
function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

const HTML = readPublic('index.html');
const APP_JS = readPublic('app.js');
const CSS = readPublic('styles.css');

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
 * @param {string} css - Stylesheet text.
 * @param {string} selector - Exact selector text at the start of a line.
 * @returns {string} Declarations between the braces, or '' when absent.
 */
function ruleBlock(css, selector) {
  const at = css.indexOf('\n' + selector + ' {');
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return close === -1 ? '' : css.slice(open + 1, close);
}

/**
 * Extract one balanced-brace method body by name. Same lift the other frontend
 * tests use: app.js is a 27000-line browser class with no module boundary, so
 * requiring it in Node would run a DOM-dependent constructor.
 *
 * @param {string} src - Normalised app.js source.
 * @param {string} name - Method name as it appears at its definition.
 * @returns {string} The body including its braces, or '' when not found.
 */
function methodBody(src, name) {
  const at = src.indexOf('\n  ' + name + '(');
  if (at === -1) return '';
  const paren = src.indexOf('(', at);
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { afterParams = i + 1; break; }
  }
  if (afterParams === -1) return '';
  const open = src.indexOf('{', afterParams);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

console.log('\n  \x1b[1mSide peek (DESIGN-SPEC 7, P4 remainder B1)\x1b[0m');
console.log('  ' + '─'.repeat(42));

/* ─── 0. The peek is a sibling of the main column, not a child of it ────── */

check('the peek lives OUTSIDE <main>, as a flex sibling of the main column',
  HTML.indexOf('</main>') < HTML.indexOf('id="session-detail-panel"'),
  '.main-content is flex-direction: column, so a peek inside it stacks below the list and a fixed width squeezes the list to zero height');
check('the peek is still inside .app-body, which is the shell\'s only flex row',
  HTML.indexOf('id="session-detail-panel"') < HTML.indexOf('MOBILE BOTTOM TAB BAR'));

/* ─── 1. The peek is a fixed-measure sibling, not an elastic half ───────── */

const peekDesktop = CSS.slice(CSS.indexOf('@media (min-width: 769px) {\n  .session-detail-panel'));
check('the desktop peek takes a fixed measure instead of flex: 1',
  /\.session-detail-panel \{\s*flex: 0 0 auto;\s*width: 420px;/.test(peekDesktop.slice(0, 400)),
  'a peek is a fixed measure; the list keeps the elastic half');
check('the peek clamps between 300px and 46vw',
  /min-width: 300px;/.test(peekDesktop.slice(0, 400)) && /max-width: 46vw;/.test(peekDesktop.slice(0, 400)));
check('the width ladder is scoped to desktop so the phone slide-over is not over-constrained',
  CSS.includes('@media (min-width: 769px) {\n  .session-detail-panel {'),
  'an unscoped width beats the phone rule\'s right:0 and collapses the panel to 420px');
check('the peek carries a left hairline, which is what makes it read as a sibling',
  /border-left: 1px solid var\(--app-border-primary\);/.test(peekDesktop.slice(0, 400)));
check('the peek takes the one shared entrance rather than its own fade',
  /animation: mwFadein/.test(ruleBlock(CSS, '.session-detail-panel')));

/* ─── 2. The 44px header band ───────────────────────────────────────────── */

const header = ruleBlock(CSS, '.detail-header');
check('the peek header mirrors the topbar height exactly',
  /height: var\(--app-topbar-height\);/.test(header) &&
  /min-height: var\(--app-topbar-height\);/.test(header),
  'the two must read as one 44px band across the window');
check('the title moved out of the header and into the body',
  HTML.indexOf('detail-header-spacer') < HTML.indexOf('class="detail-title-row"'),
  'DESIGN-SPEC 7 draws the page title as the first block of the document');
check('the page title is 22px/700 with the display tracking',
  /font-size: 22px;/.test(ruleBlock(CSS, '.detail-title')) &&
  /font-weight: 700;/.test(ruleBlock(CSS, '.detail-title')));
check('the title wraps rather than truncating, because a peek is for reading a whole name',
  /overflow-wrap: anywhere;/.test(ruleBlock(CSS, '.detail-title')));
check('the title-row dot stays 9px, not the 7px row dot',
  /width: 9px;/.test(ruleBlock(CSS, '.detail-status-dot')));

/* ─── 3. The property grid ──────────────────────────────────────────────── */

const metaGrid = ruleBlock(CSS, '.detail-meta');
check('the property grid is a two-column grid on the peek label measure',
  /display: grid;/.test(metaGrid) &&
  /grid-template-columns: minmax\(80px, 110px\) 1fr;/.test(metaGrid),
  'DESIGN-SPEC 7 narrows the design system\'s fixed 148px label column');
check('.meta-row is display: contents, which is what aligns every pair with zero markup change',
  /display: contents;/.test(ruleBlock(CSS, '.meta-row')),
  'restoring flex here silently breaks the column alignment of every property');
check('the grid is a bare label/value pair list, with no card fill left on the group',
  !/background: var\(--border-subtle\)/.test(metaGrid) && !/overflow: hidden;/.test(metaGrid));
/* RETARGETED IN P12 (sanctioned edit SE-18). The point of this check is that a
   property LABEL is subordinate ink at a fixed row height, never body ink and
   never a free-floating line. That is unchanged. What changed is which token
   carries subordinate ink: --app-text-tertiary measured 2.67:1 on the light
   canvas, which is under the 3:1 floor for a label a person actually reads, so
   P12's reconciliation swept every `color:` use of the tertiary inks onto
   --ink-meta at 4.27:1 light and 7.52:1 dark. DECISIONS 19 carries the table. */
check('label cells are meta ink at the 30px property row height',
  /color: var\(--ink-meta\);/.test(ruleBlock(CSS, '.meta-label')) &&
  /min-height: 30px;/.test(ruleBlock(CSS, '.meta-label')));
check('value cells lift the grid item automatic minimum, so a long path ellipsises',
  /min-width: 0;/.test(ruleBlock(CSS, '.meta-value')),
  'without min-width:0 a 200-character directory widens the track and scrolls the peek');
check('the grid collapses to one column on a phone',
  /\.detail-meta \{\n    grid-template-columns: 1fr;/.test(CSS));

/* ─── 3b. The table gives up two columns while the peek is open ─────────── */

check('opening the peek collapses the two lowest-value table columns',
  /\.cwm-peek-open \.session-table th\.session-col-project/.test(CSS) &&
  /\.cwm-peek-open \.session-table th\.session-col-model/.test(CSS),
  'seven fixed percentage columns in the remainder clip their chips rather than truncating');
check('the collapsed widths are re-cut rather than left to redistribute',
  /\.cwm-peek-open \.session-table th\.session-col-name \{ width: 44%; \}/.test(CSS));
check('the peek-open class is set from JS, not derived from :has([hidden])',
  /_setPeekOpen\(/.test(APP_JS) && /classList\.toggle\('cwm-peek-open'/.test(APP_JS),
  'a :has() selector cannot reach backwards from the peek to the table, and four [hidden] hits would inflate gate G3');
check('every path that hides the peek also clears the class',
  (APP_JS.match(/this\._setPeekOpen\(/g) || []).length >= 4,
  'renderSessionDetail both ways, deselectSession, and setViewMode');

/* ─── 4. The two properties the peek gained ─────────────────────────────── */

check('index.html carries the Provider row and its id',
  /<span class="meta-label">Provider<\/span>/.test(HTML) && HTML.includes('id="detail-provider"'));
check('index.html carries the Model row and its id',
  /<span class="meta-label">Model<\/span>/.test(HTML) && HTML.includes('id="detail-model"'));

const detailBody = methodBody(APP_JS, 'renderSessionDetail');
check('the peek renders its provider through the SHARED chip helper',
  detailBody.includes('this.providerChipHtml(session.provider)'),
  'a second copy of the chip rules is how two surfaces start disagreeing');
check('the peek renders its model through the SHARED short-model helper',
  detailBody.includes('this.shortModelLabel(session.model)'));
check('an unset model renders blank rather than as a dash placeholder',
  /shortModelLabel\(session\.model\) \|\| ''/.test(detailBody),
  'Notion draws an unset property as blank; the label beside it never disappears');

/* ─── 5. The borderless notes editor ────────────────────────────────────── */

const notesEditor = ruleBlock(CSS, '.detail-notes-editor');
check('the notes editor is borderless and groundless, which is the Notion idiom',
  /border: none;/.test(notesEditor) && /background: transparent;/.test(notesEditor));
check('the notes editor keeps a visible focus treatment despite outline: none',
  /\.detail-notes-editor:focus-visible \{/.test(CSS),
  'DECISIONS 11.2.6: outline:none on a borderless editor is not an accessibility exception');

const notesBody = methodBody(APP_JS, 'renderSessionNotes');
check('the notes editor never clobbers a focused textarea',
  notesBody.includes('document.activeElement !== editor'),
  'renderSessionDetail runs on every SSE session event; a blind write eats what is being typed');
check('the persistence listener is bound exactly once, not once per render',
  notesBody.includes('this._detailNotesBound'),
  'a per-render listener stacks one handler per SSE event on the same element');
check('the listener reads the selected session at event time rather than closing over an id',
  notesBody.includes('this.state.selectedSession'));
check('notes persist under the app\'s own cwm_ key convention',
  /SESSION_NOTES_KEY = 'cwm_sessionNotes'/.test(APP_JS));

const writeBody = methodBody(APP_JS, '_writeSessionNote');
check('an emptied note deletes its entry instead of storing an empty string',
  /delete map\[sessionId\]/.test(writeBody),
  'otherwise the map accumulates a row per session the user merely looked at');
check('every storage failure degrades to a working peek',
  methodBody(APP_JS, '_readSessionNotes').includes('catch') && writeBody.includes('catch'));

console.log('  ──────────────────────────────────────────');
console.log('  [side-peek] ' + passed + '/' + (passed + failed) + ' tests passed');
if (failed > 0) process.exit(1);
