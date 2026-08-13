#!/usr/bin/env node
/**
 * Unit tests for instance-colors UMD module.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed)');
process.exit(failed === 0 ? 0 : 1);
