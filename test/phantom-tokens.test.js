#!/usr/bin/env node
/**
 * Phantom-token gate: every CSS custom property consumed via var(--x) in
 * styles.css / styles-mobile.css must be DEFINED in one of those stylesheets
 * (or be a known dynamic token set inline per-element from app.js).
 *
 * Why: a var() referencing an undefined token computes to the guaranteed
 * invalid value (or its fallback), so the declaration silently does nothing.
 * That is exactly how the app shipped with no context-menu hover highlight
 * (--bg-hover), invisible menu borders (--border), and dead settings-rail
 * hover states (--surface-1/--surface-2/--text-base) until the ui-token
 * repair. This gate turns that failure mode from "silent visual rot" into
 * a red CI run.
 *
 * Mechanics mirror test/css-tokens.test.js: pure string parsing over the
 * stylesheet text, no DOM, no browser. CSS comments are stripped before
 * parsing so prose that mentions token names can never satisfy (or fail)
 * the gate.
 *
 * Dynamic tokens: some custom properties are intentionally never defined in
 * CSS because render code in app.js sets them inline per-element (e.g.
 * style="--ws-color: var(--mauve)"). Those live in DYNAMIC_TOKENS below.
 * Adding a new inline-set token requires adding it to that allow-list,
 * which is the desired friction: it forces the author to confirm the token
 * really is populated at runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const CSS_FILES = ['styles.css', 'styles-mobile.css'];

/**
 * Strip block comments from CSS source so commented-out declarations and
 * prose never count as definitions or consumptions.
 *
 * @param {string} css Raw stylesheet text.
 * @returns {string} Stylesheet text with all comment blocks removed.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Collect every custom property DEFINED in the given CSS text. A definition
 * is a `--name:` declaration inside any rule (matched after `{`, `;` or
 * whitespace so selectors like `:root[data-theme=...]` never confuse it).
 *
 * @param {string} css Comment-stripped stylesheet text.
 * @param {Set<string>} into Set to accumulate token names into.
 */
function collectDefined(css, into) {
  const re = /(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g;
  let m;
  while ((m = re.exec(css)) !== null) into.add(m[2]);
}

/**
 * Collect every custom property CONSUMED via var(--name) in the given CSS
 * text, including nested references inside color-mix() and fallbacks.
 *
 * @param {string} css Comment-stripped stylesheet text.
 * @param {Map<string, number>} into Map of token name to consumption count.
 */
function collectConsumed(css, into) {
  const re = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  let m;
  while ((m = re.exec(css)) !== null) into.set(m[1], (into.get(m[1]) || 0) + 1);
}

// Tokens that are set inline per-element by app.js render code (style=
// "--x: ..." attributes), so they are intentionally absent from the
// stylesheets. Each entry names its setter so drift is auditable.
const DYNAMIC_TOKENS = new Set([
  '--ws-color',        // app.js renderWorkspaces: workspace row accent
  '--ws-group-color',  // app.js renderWorkspaces: workspace group stripe/chip
  '--group-color',     // app.js workspace-group-header inline style
  '--tab-color',       // app.js terminal group tab inline style
  '--folder-color',    // app.js tab-folder-header inline style
  '--c-outer',         // app.js instance color pip (outer ring)
  '--c-inner',         // app.js instance color pip (inner dot)
  '--vh',              // app.js visualViewport handler: setProperty('--vh', ...) with 100vh/100dvh fallbacks
  // Notion restyle P5.4. terminal-surface.js publishes these seven onto
  // document.documentElement from applyTerminalSurfaceVars, which runs at load,
  // from every TerminalPane.getCurrentTheme() and from a data-theme observer.
  // They are the terminal palette reaching CSS, which is what lets the pane
  // chrome paint the SAME value xterm paints rather than a near neighbour
  // (TERMINAL-ARCHITECTURE 10.1, DESIGN-SPEC 5.6 and 10.4). Every consumption
  // site also carries a static fallback, so a stylesheet that resolves before
  // the script runs is never unstyled. test/terminal-surface.test.js asserts
  // the other direction: everything styles.css consumes here is published.
  // Only the four the stylesheets actually read are listed. terminal-surface.js
  // publishes three more (--term-dim, --term-selection-bg, --term-cursor)
  // because they are part of the projection's contract for the JS consumers
  // P7 and P10 build; they are deliberately NOT listed here, because this
  // allow-list asserts CSS consumption in both directions and an entry nothing
  // reads is exactly the stale exemption it exists to prevent. The phase that
  // first writes `var(--term-dim)` into a stylesheet adds its row then.
  '--term-bg',           // styles.css: the terminal surface and the input row ground
  '--term-ink',          // styles.css: the input row's typed text
  '--term-rule',         // styles.css: the input row's top rule and the terminal scrollbar
  '--term-accent',       // styles.css: the input row's prompt glyph
]);

let passed = 0;
let failed = 0;

/**
 * Run a single named assertion, tallying pass/fail so every check reports
 * before the process exits with the worst outcome.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void} fn Function that throws on failure.
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + err.message + '\x1b[0m');
  }
}

console.log('\n  \x1b[1mPhantom-token gate: consumed vs defined CSS custom properties\x1b[0m');
console.log('  ' + '─'.repeat(42));

const defined = new Set();
const consumed = new Map();
for (const file of CSS_FILES) {
  const css = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
  collectDefined(css, defined);
  collectConsumed(css, consumed);
}

// (1) The core gate: no consumed token may be undefined (minus dynamics).
check('every var(--x) consumed in styles.css/styles-mobile.css is defined (or dynamic)', () => {
  const phantoms = [];
  for (const [name, count] of consumed) {
    if (!defined.has(name) && !DYNAMIC_TOKENS.has(name)) {
      phantoms.push(name + ' (used ' + count + 'x)');
    }
  }
  assert.deepStrictEqual(
    phantoms.sort(),
    [],
    'Phantom tokens (consumed but never defined; rules using them silently do nothing): ' +
      phantoms.join(', ') +
      '. Define the token in :root (alias of a palette token) or substitute an existing token at the use site. ' +
      'If it is legitimately set inline from app.js, add it to DYNAMIC_TOKENS in test/phantom-tokens.test.js.'
  );
});

// (2) Dynamic allow-list hygiene: every allow-listed token must actually be
// consumed somewhere, otherwise the entry is stale and should be removed.
check('every DYNAMIC_TOKENS entry is still consumed by the stylesheets', () => {
  const stale = [...DYNAMIC_TOKENS].filter((t) => !consumed.has(t));
  assert.deepStrictEqual(
    stale,
    [],
    'Stale DYNAMIC_TOKENS entries (no longer consumed anywhere): ' + stale.join(', ')
  );
});

// (3) Lock the repaired alias layer: the five formerly-phantom tokens must
// stay defined at :root as var() references (theme-following), never hex.
const REPAIRED_ALIASES = ['--bg-hover', '--border', '--surface-1', '--surface-2', '--text-base'];
const stylesCss = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8'));
for (const alias of REPAIRED_ALIASES) {
  check(alias + ' is defined as a var() alias (not a hex literal)', () => {
    const re = new RegExp(alias.replace(/-/g, '\\-') + '\\s*:\\s*var\\(--[a-zA-Z0-9-]+\\)');
    assert.ok(re.test(stylesCss), alias + ' must be defined as an alias of an existing token, e.g. ' + alias + ': var(--surface0)');
    const hexRe = new RegExp(alias.replace(/-/g, '\\-') + '\\s*:\\s*#[0-9a-fA-F]+');
    assert.ok(!hexRe.test(stylesCss), alias + ' must not be defined as a hex literal (breaks theme cascade)');
  });
}

// (4) Contradictory fallbacks stay dead: a var() fallback that disagrees with
// the real token value hides the phantom AND renders the wrong size.
check('no contradictory radius fallbacks (var(--radius-sm, 4px) / var(--radius-xs, 3px))', () => {
  const bad = stylesCss.match(/var\(--radius-sm\s*,\s*4px\)|var\(--radius-xs\s*,\s*3px\)/g) || [];
  assert.deepStrictEqual(bad, [], 'Contradictory radius fallbacks found: ' + bad.join(' | '));
});

console.log('  ' + '─'.repeat(42));
console.log('  [phantom-tokens] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
