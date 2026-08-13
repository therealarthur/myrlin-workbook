#!/usr/bin/env node
/**
 * Unit tests for instance-colors UMD module.
 *
 * Section 6 onwards (Notion restyle P2.7) also covers the app.js half of
 * BUILD-CONTRACT 1.8: the five colour maps, the three inline-style resolvers
 * they go through, and the two shell-chrome listeners DEVIATIONS DV-9 left
 * unshipped in P2 (the scrolled topbar and the hover gate). Those are
 * source-scan assertions against src/web/public/app.js, in the same idiom the
 * other frontend tests use, because app.js is a browser class with no Node
 * entry point. Adding them here rather than in a new file keeps test/run.js
 * untouched while a second agent owns it.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const fs = require('fs');
const path = require('path');
const {
  TAB_COLORS,
  getSessionInstances,
  getTabColor,
} = require(path.join(__dirname, '..', 'src', 'web', 'public', 'instance-colors.js'));

// Notion restyle P2.7 additions. Destructured separately, and the module is
// required a second time by name below, so the original destructure above
// stays character-for-character what it was: BUILD-CONTRACT 4.4 P2.7's done
// criterion is that this file is green with no edit to an existing assertion.
const InstanceColors = require(path.join(__dirname, '..', 'src', 'web', 'public', 'instance-colors.js'));

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else    { failed++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Fixture — folderIds preserved on tabs to confirm they don't influence tab color.
const tabs = [
  { id: 't1', name: 'Main',    folderId: 'f1', panes: [
    { slot: 0, sessionId: 'sA' }, { slot: 1, sessionId: 'sB' },
  ]},
  { id: 't2', name: 'Logs',    folderId: 'f1', panes: [
    { slot: 0, sessionId: 'sA' },
  ]},
  { id: 't3', name: 'Sandbox', folderId: 'f2', panes: [
    { slot: 0, sessionId: 'sA' },
  ]},
  { id: 't4', name: 'Loose',   folderId: null, panes: [
    { slot: 2, sessionId: 'sA' },
  ]},
  { id: 't5', name: 'Other',   folderId: null, panes: [] },
];

// 1. TAB_COLORS contract
check('TAB_COLORS has 6 distinct entries',
  TAB_COLORS.length === 6 && new Set(TAB_COLORS).size === 6);

// 2. getSessionInstances finds all instances across all tabs
const instances = getSessionInstances('sA', tabs);
check('getSessionInstances returns 4 entries for sA',
  instances.length === 4,
  'got ' + instances.length);
check('getSessionInstances entries carry tabId and slot only',
  instances.every(i => 'tabId' in i && 'slot' in i && !('folderId' in i)));
check('getSessionInstances finds the ungrouped tab too',
  instances.some(i => i.tabId === 't4' && i.slot === 2));
check('getSessionInstances returns empty for unknown session',
  eq(getSessionInstances('nope', tabs), []));

// 3. getTabColor: GLOBAL positional index across all tabs (folder is irrelevant)
// Global order: [t1, t2, t3, t4, t5] -> red, yellow, green, teal, blue
check('getTabColor t1 (global index 0)', getTabColor('t1', tabs) === 'red');
check('getTabColor t2 (global index 1)', getTabColor('t2', tabs) === 'yellow');
check('getTabColor t3 (global index 2)', getTabColor('t3', tabs) === 'green');
check('getTabColor t4 (global index 3)', getTabColor('t4', tabs) === 'teal');
check('getTabColor t5 (global index 4)', getTabColor('t5', tabs) === 'blue');

// 4. Modulo wraparound at the global level
const longTabs = Array.from({ length: 8 }, (_, i) => ({
  id: 'tw' + i, name: 'T' + i, folderId: null, panes: [],
}));
check('getTabColor wraps at global index 6', getTabColor('tw6', longTabs) === 'red');
check('getTabColor wraps at global index 7', getTabColor('tw7', longTabs) === 'yellow');

// 5. Unknown tab falls back to first colour
check('getTabColor unknown tab falls back to first colour',
  getTabColor('nope', tabs) === 'red');

/* ─── 6. Chrome hue projection (Notion restyle P2.7) ────────────────────────
   BUILD-CONTRACT 1.8 requires the palette NAMES to survive untouched and the
   emitted CSS to move onto the chrome layer. These assertions guard both
   halves: the arrays above are still the same six strings (checks 1 and 3 to
   5 above prove that), and nothing this module emits may name a Catppuccin
   custom property ever again. DESIGN-SPEC 10.4. */

const {
  BLOCK_HUE_TOKENS,
  BLOCK_HUE_BG_TOKENS,
  PALETTE_BLOCK_HUE,
  TAB_COLOR_TOKENS,
  blockHueToken,
  blockHueVar,
  blockHueBgToken,
  blockHueBgVar,
  blockHueWash,
  getTabColorVar,
} = InstanceColors;

check('TAB_COLOR_TOKENS covers exactly the six TAB_COLORS names',
  eq(Object.keys(TAB_COLOR_TOKENS).sort(), [...TAB_COLORS].sort()));

// The literal BUILD-CONTRACT 1.8 table for TAB_COLORS, spelled out rather
// than derived, so a change to the resolver cannot quietly agree with itself.
check('TAB_COLOR_TOKENS matches BUILD-CONTRACT 1.8 verbatim',
  eq(TAB_COLOR_TOKENS, {
    red: '--app-text-red',
    yellow: '--app-text-yellow',
    green: '--app-text-green',
    teal: '--app-text-teal',
    blue: '--app-text-blue',
    mauve: '--app-text-purple',
  }),
  JSON.stringify(TAB_COLOR_TOKENS));

check('the block palette is the ten named Notion hues',
  eq(Object.keys(BLOCK_HUE_TOKENS).sort(),
    ['blue', 'brown', 'gray', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'yellow']));

check('every block hue token is an --app-text-<hue> custom property',
  Object.entries(BLOCK_HUE_TOKENS).every(([hue, token]) => token === '--app-text-' + hue));

// The five names with no one-to-one Notion equivalent, per BUILD-CONTRACT 1.8
// row 3. These are the ones a careless mapping gets wrong.
check('sky maps to teal, not blue', blockHueToken('sky') === '--app-text-teal');
check('lavender maps to purple', blockHueToken('lavender') === '--app-text-purple');
check('sapphire maps to blue', blockHueToken('sapphire') === '--app-text-blue');
check('flamingo maps to brown', blockHueToken('flamingo') === '--app-text-brown');
check('rosewater maps to brown', blockHueToken('rosewater') === '--app-text-brown');
check('peach maps to orange', blockHueToken('peach') === '--app-text-orange');
check('mauve maps to purple, never to blue (contract 1.9 C1)',
  blockHueToken('mauve') === '--app-text-purple');

check('every persisted palette name resolves to a defined block hue',
  Object.values(PALETTE_BLOCK_HUE).every(hue => typeof BLOCK_HUE_TOKENS[hue] === 'string'));

check('the thirteen persistable palette names are all covered',
  eq(Object.keys(PALETTE_BLOCK_HUE).sort(),
    ['blue', 'flamingo', 'green', 'lavender', 'mauve', 'peach', 'pink', 'red',
      'rosewater', 'sapphire', 'sky', 'teal', 'yellow']));

// Canonical hue names resolve to themselves, so a caller may pass either
// vocabulary without a lookup table of its own.
check('a canonical hue name resolves to itself',
  blockHueToken('purple') === '--app-text-purple' && blockHueToken('brown') === '--app-text-brown');

// Robustness: persisted state is user data and can be anything at all.
check('an unknown, empty or non-string name degrades to the neutral hue',
  ['nope', '', null, undefined, 42, {}].every(v => blockHueToken(v) === '--app-text-gray'));
check('resolution is case and whitespace insensitive',
  blockHueToken('  MAUVE ') === '--app-text-purple');

check('blockHueVar wraps the token as a CSS value',
  blockHueVar('mauve') === 'var(--app-text-purple)');

// The named block colour system is a PAIR: ink plus its matching ground
// (BUILD-CONTRACT 2.3 row 3). The two accessors must resolve every name to
// the same hue or a content label ends up with red ink on a green wash.
check('the block background palette covers the same ten hues',
  eq(Object.keys(BLOCK_HUE_BG_TOKENS).sort(), Object.keys(BLOCK_HUE_TOKENS).sort()));
check('every block background token is an --app-bg-<hue> custom property',
  Object.entries(BLOCK_HUE_BG_TOKENS).every(([hue, token]) => token === '--app-bg-' + hue));
check('ink and ground resolve every persisted name to the same hue',
  [...Object.keys(PALETTE_BLOCK_HUE), 'purple', 'gray', 'nope', ''].every(name =>
    blockHueToken(name).replace('--app-text-', '') ===
    blockHueBgToken(name).replace('--app-bg-', '')));
check('blockHueBgVar wraps the background token as a CSS value',
  blockHueBgVar('mauve') === 'var(--app-bg-purple)' &&
  blockHueBgVar('flamingo') === 'var(--app-bg-brown)');
check('blockHueWash mixes the identity ink down over transparent',
  blockHueWash('mauve', 15) === 'color-mix(in srgb, var(--app-text-purple) 15%, transparent)');
check('blockHueWash clamps an out-of-range percentage',
  blockHueWash('red', 140) === 'color-mix(in srgb, var(--app-text-red) 100%, transparent)' &&
  blockHueWash('red', -5) === 'color-mix(in srgb, var(--app-text-red) 0%, transparent)');

check('getTabColorVar keeps the positional rule and paints from chrome',
  getTabColorVar('t1', tabs) === 'var(--app-text-red)' &&
  getTabColorVar('t5', tabs) === 'var(--app-text-blue)' &&
  getTabColorVar('nope', tabs) === 'var(--app-text-red)');

// The gate that matters: no emitted string may reference the terminal palette.
const emitted = [
  ...Object.values(BLOCK_HUE_TOKENS),
  ...Object.values(BLOCK_HUE_BG_TOKENS),
  ...Object.values(TAB_COLOR_TOKENS),
  ...TAB_COLORS.map(blockHueVar),
  ...Object.keys(PALETTE_BLOCK_HUE).map(blockHueVar),
  ...Object.keys(PALETTE_BLOCK_HUE).map(blockHueBgVar),
  ...Object.keys(PALETTE_BLOCK_HUE).map(name => blockHueWash(name, 15)),
];
const CATPPUCCIN = ['rosewater', 'flamingo', 'mauve', 'maroon', 'peach', 'sky', 'sapphire',
  'lavender', 'text', 'subtext1', 'subtext0', 'overlay2', 'overlay1', 'overlay0',
  'surface2', 'surface1', 'surface0', 'base', 'mantle', 'crust'];
check('nothing this module emits names a Catppuccin custom property',
  emitted.every(value => !CATPPUCCIN.some(name => value.includes('--' + name))),
  emitted.join(' '));

// Freezing is what makes this a contract rather than a suggestion: a caller
// cannot patch a hue at run time and desynchronise two surfaces.
check('the projection tables are frozen',
  Object.isFrozen(BLOCK_HUE_TOKENS) && Object.isFrozen(BLOCK_HUE_BG_TOKENS) &&
  Object.isFrozen(PALETTE_BLOCK_HUE) && Object.isFrozen(TAB_COLOR_TOKENS));

/* ─── 7. The app.js half of BUILD-CONTRACT 1.8 (P2.7) ───────────────────────
   Source scan, CRLF-normalised per DO-NOT-BREAK E.1 idiom 3: the public JS is
   stored with CRLF and every anchor below is deliberately single-line. */

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8'
).replace(/\r\n/g, '\n');

/**
 * Extract one balanced-brace method body by name, so an assertion is scoped
 * to the method it is about rather than matching a lookalike elsewhere.
 *
 * @param {string} src - Normalised source.
 * @param {string} name - Method name as it appears at its definition.
 * @returns {string} The body including its braces, or '' when not found.
 */
function methodBody(src, name) {
  const at = src.indexOf('\n  ' + name + '(');
  if (at === -1) return '';
  // Walk the parameter list first. A destructured signature such as
  // renderInstanceIndicator({ tabColor, ... }) opens a brace before the body
  // does, and a naive "first { after the name" lands inside the parameters.
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

// The five arrays BUILD-CONTRACT 1.8 requires to stay byte-identical. These
// are persisted-state vocabulary: workspace.color, folder.color and the tag
// hash all read them, so a rename silently invalidates stored data.
check('PANE_SLOT_COLORS is unchanged',
  APP_JS.includes("this.PANE_SLOT_COLORS = ['mauve', 'blue', 'green', 'peach', 'red', 'pink'];"));
check('FOLDER_COLORS is unchanged',
  APP_JS.includes("const FOLDER_COLORS = ['mauve', 'blue', 'green', 'peach', 'red', 'pink', 'teal', 'yellow'];"));
check('the _tagColor hash palette is unchanged',
  APP_JS.includes("const palette = ['teal', 'pink', 'sky', 'peach', 'lavender', 'flamingo', 'sapphire', 'rosewater'];"));

// The three resolvers, and the fallbacks that must themselves be chrome.
check('app.js defines the three chrome hue resolvers',
  /\n {2}_hueVar\(name\)/.test(APP_JS) &&
  /\n {2}_hueBgVar\(name\)/.test(APP_JS) &&
  /\n {2}_hueWash\(name, percent\)/.test(APP_JS));
check('both hue fallbacks are chrome tokens, never palette tokens',
  APP_JS.includes("static FALLBACK_HUE_VAR = 'var(--app-text-gray)';") &&
  APP_JS.includes("static FALLBACK_HUE_BG_VAR = 'var(--app-bg-gray)';"));

// The gate that catches a regression: no template in app.js may build a
// custom-property name by concatenation again. That idiom is how the terminal
// palette leaked into the chrome in the first place, and it is invisible to
// every grep that looks for a token by name.
const concatenatedVars = APP_JS.match(/var\(--\$\{/g) || [];
check('no template literal concatenates a var(--...) custom property name',
  concatenatedVars.length === 0,
  concatenatedVars.length + ' occurrence(s) remain');

// Per-map call sites.
const indicatorBody = methodBody(APP_JS, 'renderInstanceIndicator');
check('the instance pip paints both halves through the projection',
  /--c-outer:\$\{this\._hueVar\(tabColor\)\}/.test(indicatorBody) &&
  /--c-inner:\$\{this\._hueVar\(slotColor\)\}/.test(indicatorBody),
  indicatorBody ? 'body found' : 'renderInstanceIndicator not found');

check('the terminal group tab dot paints through the projection',
  APP_JS.includes('style="--tab-color:${this._hueVar(tabColor)}"'));
check('the tab folder header paints through the projection',
  APP_JS.includes('style="--folder-color: ${this._hueVar(color)}"'));
check('both folder colour swatches paint through the projection',
  (APP_JS.match(/border-radius:50%;background:\$\{this\._hueVar\(/g) || []).length === 2);
check('the workspace colour picker swatch paints through the projection',
  APP_JS.includes('style="background: ${this._hueVar(name)}"'));

// colorMap: thirteen persisted keys, every value resolved, no literal left.
const colorMapBlock = APP_JS.slice(APP_JS.indexOf('const colorMap = {'),
  APP_JS.indexOf('};', APP_JS.indexOf('const colorMap = {')) + 2);
check('colorMap still carries all thirteen persistable keys',
  Object.keys(PALETTE_BLOCK_HUE).every(name => colorMapBlock.includes(name + ': this._hueVar(')),
  colorMapBlock.slice(0, 80));
check('colorMap holds no literal palette var() any more',
  colorMapBlock.length > 0 && !/var\(--(?:mauve|peach|sky|sapphire|lavender|flamingo|rosewater)\)/.test(colorMapBlock));

// Tag chips take the named block PAIR (BUILD-CONTRACT 2.3 row 3), at all
// three render sites: the tasks list, the kanban card and the sidebar row.
const tagChipSites = APP_JS.match(
  /session-badge-tag" style="background:\$\{this\._hueBgVar\(color\)\};color:\$\{this\._hueVar\(color\)\};"/g
) || [];
check('all three tag-chip sites use the block ink and ground pair',
  tagChipSites.length === 3,
  'found ' + tagChipSites.length);

/* ─── 8. The two shell listeners DV-9 left unshipped ────────────────────── */

check('the shell binds one delegated, passive, capture-phase scroll observer',
  /document\.addEventListener\('scroll', \(e\) => this\._onShellScroll\(e\), \{\n\s*capture: true,\n\s*passive: true,\n\s*\}\)/.test(APP_JS));
check('bindEvents wires the scroll observer and the hover gate',
  /this\._bindShellScrollObserver\(\);\n\s*\/\/[^\n]*\n\s*this\._bindHoverGate\(\);/.test(APP_JS));

const headerBody = methodBody(APP_JS, '_updateHeaderScrolled');
check('the topbar scrolled state is toggled, at a named threshold',
  /classList\.toggle\('is-scrolled', scrolled\)/.test(headerBody) &&
  /CWMApp\.HEADER_SCROLLED_AT_PX/.test(headerBody),
  headerBody ? 'body found' : '_updateHeaderScrolled not found');
check('only main-column scrollers move the topbar, never a terminal transcript',
  /main\.contains\(scroller\)/.test(headerBody) &&
  /closest\('\.terminal-pane'\)/.test(headerBody));
check('a view switch resets the topbar scrolled state',
  APP_JS.includes('this._updateHeaderScrolled(null);'));

const gateBody = methodBody(APP_JS, '_bindHoverGate');
check('the hover gate class goes on the shell container',
  /classList\.toggle\('nt-enable-hover', enabled\)/.test(APP_JS) &&
  /this\._setHoverGate\(true\)/.test(gateBody));
check('the gate is stripped on drag start and released on drag end and drop',
  /addEventListener\('dragstart', \(\) => this\._suspendHoverGateForDrag\(\)/.test(gateBody) &&
  /addEventListener\('dragend', \(\) => this\._resumeHoverGateAfterDrag\(\)/.test(gateBody) &&
  /addEventListener\('drop', \(\) => this\._resumeHoverGateAfterDrag\(\)/.test(gateBody));
check('the gate is stripped on scroll before the throttled frame, not after',
  /this\._suspendHoverGateForScroll\(\);\n\s*if \(this\._shellScrollTicking\) return;/.test(APP_JS));
check('the restore idle and the drag safety net are named constants',
  APP_JS.includes('static HOVER_GATE_RESTORE_MS = 180;') &&
  APP_JS.includes('static HOVER_GATE_DRAG_MAX_MS = 30000;'));
check('a drag holds the gate off rather than restoring under the cursor',
  /if \(this\._hoverGateDragging\) return;/.test(methodBody(APP_JS, '_suspendHoverGateForScroll')));
check('only one restore timer can ever be pending',
  /clearTimeout\(this\._hoverGateTimer\);/.test(methodBody(APP_JS, '_scheduleHoverGateRestore')));

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed)');
process.exit(failed === 0 ? 0 : 1);
