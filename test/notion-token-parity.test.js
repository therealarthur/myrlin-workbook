#!/usr/bin/env node
/**
 * notion-token-parity.test.js - the anti-drift gate for the Notion restyle.
 * Created: 2026-08-13 (phase P0, work package P0.4).
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * test/phantom-tokens.test.js scans styles.css and styles-mobile.css as BOTH
 * the consumption set and the definition set. A custom property defined only in
 * src/web/public/design/notion/tokens/*.css and consumed in styles.css is
 * therefore a phantom: the gate turns red, and in the browser the rule using it
 * silently does nothing. See BUILD-CONTRACT.md 1.1.1 and risk R9.
 *
 * So the restyle cannot link the vendored token files. Every raw Notion value
 * the project consumes is authored into the :root block of styles.css instead,
 * which means the values are DUPLICATED: once in the vendored bundle, once in
 * styles.css. Duplication without a diff is drift waiting to happen.
 *
 * This test is that diff. It fails on any value mismatch between the two
 * copies, so the duplication is safe.
 *
 * WHAT IT CHECKS, IN THREE LAYERS
 *
 * 1. Bundle integrity (load-bearing from day one). Every vendored file exists,
 *    is intact against its recorded SHA-256, and is still identical to its
 *    read-only source of record under docs/design/notion-import/_ds/.
 * 2. Vendored component resolution (load-bearing from day one). Every var() in
 *    the vendored components.css resolves against the union of definition
 *    sites. That closes the one hole the phantom gate cannot see, because the
 *    phantom gate never reads components.css.
 * 3. Token parity (trivial in P0, load-bearing from P1). Every --app-*,
 *    --radius-*, --duration-*, --ease-*, --motion-* and --font-* token that
 *    styles.css defines must carry the bundle's value for that name, per chrome
 *    theme. In P0 styles.css defines none of them outside the eight documented
 *    pre-existing project tokens, so there is nothing to compare and this layer
 *    passes trivially, exactly as the contract's P0.4 requires. Verified not to
 *    be vacuous: injecting `--app-bg-primary: #ff0000` and a misspelled
 *    `--app-typo-token` into the :root block fails two assertions.
 *
 * TWO EXCLUSION LISTS, BOTH DELIBERATE AND BOTH AUDITED
 *
 * PRE_EXISTING_PROJECT_TOKENS: the eight names in bundle-owned families that
 * styles.css already defined before the restyle touched anything. Five of them
 * collide with a Notion token of the same spelling carrying a different value;
 * three have no bundle counterpart at all. BUILD-CONTRACT table C re-points them
 * through var() rather than adopting the bundle's raw value, so they are
 * excluded from the value comparison. They are asserted to stay DEFINED and the
 * list is asserted never to grow, so the exclusion can become neither a deletion
 * route nor a way around the parity gate.
 *
 * INVENTED_TOKENS: read out of INVENTIONS.md rather than hard-coded here, so a
 * token that is absent from the bundle can only pass by being documented as an
 * invention. That is the intended friction.
 *
 * MECHANICS: pure string parsing over stylesheet text, like css-tokens.test.js
 * and phantom-tokens.test.js. No DOM, no browser, no network. Line endings are
 * normalised before hashing and comparing because the repository is checked out
 * with core.autocrlf=true, so the same file is LF in git and CRLF on disk.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'src', 'web', 'public');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'design', 'notion');
const BUNDLE_DIR = path.join(ROOT, 'docs', 'design', 'notion-import', '_ds');
const DESIGN_DOCS = path.join(ROOT, 'docs', 'design', 'notion-restyle');

// The five token files plus the machine-readable provenance, in the order the
// bundle's own entry sheet imports them. Order matters for last-wins parsing.
const TOKEN_FILES = ['colors.css', 'typography.css', 'spacing.css', 'effects.css', 'motion.css'];

// Vendored path -> bundle source path. The bundle flattens on the way in
// (components/components.css becomes components.css, assets/fonts becomes
// fonts), which is what BUILD-CONTRACT 3.1 specifies.
const VENDORED_TEXT = new Map([
  ['tokens/colors.css', 'tokens/colors.css'],
  ['tokens/typography.css', 'tokens/typography.css'],
  ['tokens/spacing.css', 'tokens/spacing.css'],
  ['tokens/effects.css', 'tokens/effects.css'],
  ['tokens/motion.css', 'tokens/motion.css'],
  ['tokens/tokens.json', 'tokens/tokens.json'],
  ['components.css', 'components/components.css'],
]);

const VENDORED_BINARY = new Map([
  ['fonts/iAWriterMonoS-Regular.woff2', 'assets/fonts/iAWriterMonoS-Regular.woff2'],
  ['fonts/iAWriterMonoS-Italic.woff2', 'assets/fonts/iAWriterMonoS-Italic.woff2'],
  ['fonts/iAWriterMonoS-Bold.woff2', 'assets/fonts/iAWriterMonoS-Bold.woff2'],
  ['fonts/iAWriterMonoS-BoldItalic.woff2', 'assets/fonts/iAWriterMonoS-BoldItalic.woff2'],
  ['fonts/permanent-marker.woff', 'assets/fonts/permanent-marker.woff'],
]);

// SHA-256 recorded at vendoring time (P0.2). Text files are hashed after
// CRLF-to-LF normalisation so the value is stable across checkouts; binaries
// are hashed raw. An edit to either copy fails this gate.
const EXPECTED_SHA256 = {
  'tokens/colors.css': '98480488ca28789b631f53326e1b62fcb20d1437b65f454c28f0c738c553c844',
  'tokens/typography.css': '04e97d338a793d63895e00fd7127bbba9d178f52bd5091ef6fcd7fcfdbde0b60',
  'tokens/spacing.css': '96e82a55ae2c7aec0c57c9626ee443b7f31f173e3012e95fec7a3e07e03966b2',
  'tokens/effects.css': '9748911e78f558a0d5caadcc616fb9cf89cb26099aeff3958a3147d08d9b6d80',
  'tokens/motion.css': '3480d0cc45532f7d94655b176ff56946113bf8a0dec3d919014771221573b3b3',
  'tokens/tokens.json': 'f298cc7c2571a6740a465c7ef7fc69bb51416aef6d93024fad9077aa66549bb2',
  'components.css': 'ee8b0771bf2f42c3225fe60d900e64c322ff59372056721ebf6c3750926d7a78',
  'fonts/iAWriterMonoS-Regular.woff2': '5a0e1e2ca42330ec3edfb30385566ba5963cdc7f8c9a3f3e164baf207ee534d0',
  'fonts/iAWriterMonoS-Italic.woff2': 'ea7f9cb9d83b61fb81c973268b8b914e1d8dd80446df37ba7a4cb2f4b93d89ba',
  'fonts/iAWriterMonoS-Bold.woff2': '3c07d30fc8169b38943bf4d7f4b97aa37a7d228678e9cacbe680e4bd52f89801',
  'fonts/iAWriterMonoS-BoldItalic.woff2': '75e6be0e0e57c1728ac816a4885a345c1f56946801b739ae4d0232869de2a442',
  'fonts/permanent-marker.woff': '60a75ec7d53f86b58e5982bc3d0fb3903a2fbd3d716a6baf70c9dc30c584441b',
};

// Distinct custom-property counts per vendored token file, measured at
// vendoring time with the parser below. A truncated or emptied file fails here
// with a clear message rather than silently shrinking the comparison set to
// nothing, which would make the whole gate vacuous instead of red.
const MIN_TOKEN_COUNT = {
  'tokens/colors.css': 323,
  'tokens/typography.css': 119,
  'tokens/spacing.css': 181,
  'tokens/effects.css': 50,
  'tokens/motion.css': 40,
};

// Token families whose values are owned by the bundle. Anything outside these
// prefixes is project-local and is not compared.
const BUNDLE_OWNED_FAMILIES = ['--app-', '--radius-', '--duration-', '--ease-', '--motion-', '--font-'];

// The eight tokens in bundle-owned families that styles.css already defined on
// unmodified source, at commit 7eac21e, before the restyle touched anything.
//
// Five of them COLLIDE: the same spelling exists in the bundle carrying a
// different value (--border, --radius-sm, --radius-md, --radius-lg,
// --font-mono). Three of them are project-only and have no bundle counterpart
// (--radius-xs, --radius-xl, --font-sans).
//
// Either way they are project legacy names, not adopted Notion tokens.
// BUILD-CONTRACT table C re-points them through var() (and retires --radius-xl
// by alias) rather than giving them the bundle's raw value, so comparing them
// against the bundle would be comparing two different things.
//
// FROZEN IN P0. This list may shrink, never grow: growing it would be a route
// around the parity gate. Every entry is asserted to stay defined, so it can
// never become a route around code preservation either.
const PRE_EXISTING_PROJECT_TOKENS = new Set([
  '--border',      // project: var(--border-default). Bundle: a surface-scoped alias.
  '--radius-sm',   // project: 6px, re-pointed to var(--radius-app-button) in P1.
  '--radius-md',   // project: 10px, re-pointed to var(--radius-callout) in P1.
  '--radius-lg',   // project: 14px, re-pointed to var(--radius-popover) in P1.
  '--font-mono',   // project: JetBrains Mono stack, re-pointed to the iA Writer stack in P1.
  '--radius-xs',   // project only: 4px, re-pointed to var(--radius-property-chip) in P1.
  '--radius-xl',   // project only: 18px, RETIRED-with-alias to var(--radius-callout) in P1.
  '--font-sans',   // project only: Plus Jakarta Sans stack, re-pointed to var(--font-app-ui) in P1.
]);

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, tallying the result so every check reports before
 * the process exits with the worst outcome.
 *
 * @param {string} name - Human-readable assertion name.
 * @param {() => void} fn - Function that throws on failure.
 * @returns {void}
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

/**
 * Read a text file with line endings normalised to LF.
 *
 * @param {string} filePath - Absolute path.
 * @returns {string} Normalised text.
 */
function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * SHA-256 of a normalised string.
 *
 * @param {string} text - Input text.
 * @returns {string} Lowercase hex digest.
 */
function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Strip CSS block comments so prose that mentions a token name can never count
 * as a definition or a consumption.
 *
 * @param {string} css - Raw stylesheet text.
 * @returns {string} Comment-free stylesheet text.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse a stylesheet into custom-property declarations tagged with the full
 * selector and at-rule context they sit in.
 *
 * A hand-written walker rather than a regex because context is the whole point:
 * the same token name carries a different value inside :root, inside
 * :root[data-theme="latte"] and inside @media (prefers-color-scheme: dark), and
 * collapsing those into one map is precisely the bug this gate must not have.
 *
 * @param {string} css - Comment-free stylesheet text.
 * @returns {Array<{name: string, value: string, context: string[]}>} Declarations in source order.
 */
function parseDeclarations(css) {
  const out = [];
  const stack = [];
  let prelude = '';
  let buffer = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push(prelude.trim().replace(/\s+/g, ' '));
      prelude = '';
      buffer = '';
    } else if (ch === '}') {
      collectDeclaration(buffer, stack, out);
      stack.pop();
      buffer = '';
      prelude = '';
    } else if (ch === ';') {
      collectDeclaration(buffer, stack, out);
      buffer = '';
    } else if (stack.length === 0) {
      prelude += ch;
      if (ch === '\n') buffer = '';
    } else {
      buffer += ch;
      prelude += ch;
    }
    if (ch === '{' || ch === '}' || ch === ';') prelude = '';
  }
  return out;
}

/**
 * Push one `--name: value` declaration, if the buffer holds one.
 *
 * @param {string} buffer - Text since the last delimiter.
 * @param {string[]} stack - Current selector and at-rule context.
 * @param {Array} out - Accumulator.
 * @returns {void}
 */
function collectDeclaration(buffer, stack, out) {
  const match = /(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]+)$/.exec(buffer.trim());
  if (!match || stack.length === 0) return;
  out.push({
    name: match[1],
    value: match[2].trim().replace(/\s+/g, ' '),
    context: stack.slice(),
  });
}

/**
 * Whether a declaration's context marks it as a dark-theme value.
 *
 * Covers the bundle's own conventions (prefers-color-scheme, .app-theme-dark,
 * .notion-dark-theme, [data-theme="dark"]) and the chrome attribute this
 * project introduces in P1 ([data-chrome="dark"]).
 *
 * @param {string[]} context - Selector and at-rule stack.
 * @returns {boolean} True when the declaration belongs to dark chrome.
 */
function isDarkContext(context) {
  return context.some((sel) => (
    /prefers-color-scheme\s*:\s*dark/.test(sel) ||
    /\[data-theme\s*=\s*"dark"\]/.test(sel) ||
    /\[data-chrome\s*=\s*"dark"\]/.test(sel) ||
    /\.app-theme-dark/.test(sel) ||
    /\.notion-dark-theme/.test(sel) ||
    /\.mkt-theme-dark/.test(sel)
  ));
}

/**
 * Whether a declaration sits inside one of the 13 Catppuccin-family palette
 * blocks, which are the terminal palette and are never compared against the
 * bundle. `[data-theme="dark"]` is excluded from this test because the contract
 * reuses that selector for dark chrome, not for a palette id.
 *
 * @param {string[]} context - Selector and at-rule stack.
 * @returns {boolean} True when the declaration belongs to a palette block.
 */
function isPaletteBlockContext(context) {
  return context.some((sel) => {
    const m = /\[data-theme\s*=\s*"([a-z0-9-]+)"\]/.exec(sel);
    return !!m && m[1] !== 'dark';
  });
}

/**
 * Whether a name belongs to a family whose values the bundle owns.
 *
 * @param {string} name - Custom property name.
 * @returns {boolean} True when the bundle is the source of record for it.
 */
function isBundleOwned(name) {
  return BUNDLE_OWNED_FAMILIES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build light and dark value maps from a list of declarations. Last definition
 * in source order wins, which mirrors the cascade for equal-specificity rules.
 * A name with no dark declaration inherits its light value.
 *
 * @param {Array<{name: string, value: string, context: string[]}>} declarations - Parsed declarations.
 * @param {{skipPaletteBlocks?: boolean}} [options] - Parsing options.
 * @returns {{light: Map<string,string>, dark: Map<string,string>, all: Set<string>}} Theme maps.
 */
function buildThemeMaps(declarations, options) {
  const skipPalette = !!(options && options.skipPaletteBlocks);
  const light = new Map();
  const dark = new Map();
  const all = new Set();
  for (const decl of declarations) {
    if (skipPalette && isPaletteBlockContext(decl.context)) continue;
    all.add(decl.name);
    if (isDarkContext(decl.context)) dark.set(decl.name, decl.value);
    else light.set(decl.name, decl.value);
  }
  for (const [name, value] of light) if (!dark.has(name)) dark.set(name, value);
  return { light, dark, all };
}

/**
 * Extract the invented token names from INVENTIONS.md. Reading them from the
 * document rather than hard-coding them here means an undocumented invention
 * cannot pass this gate.
 *
 * @returns {Set<string>} Token names documented as inventions.
 */
function readInventedTokens() {
  const doc = readText(path.join(DESIGN_DOCS, 'INVENTIONS.md'));
  const tokensSection = doc.slice(doc.indexOf('## Tokens'));
  const names = new Set();
  for (const line of tokensSection.split('\n')) {
    const m = /^\|\s*`(--[A-Za-z0-9_-]+)`\s*\|/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

console.log('\n  \x1b[1mNotion token parity: styles.css against the vendored bundle\x1b[0m');
console.log('  ' + '─'.repeat(42));

// ── Layer 1: bundle integrity ──────────────────────────────────────────────

check('every vendored bundle file is present and non-empty', () => {
  const missing = [];
  for (const rel of [...VENDORED_TEXT.keys(), ...VENDORED_BINARY.keys()]) {
    const full = path.join(VENDOR_DIR, rel);
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) missing.push(rel);
  }
  assert.deepStrictEqual(missing, [],
    'Missing or empty vendored files under src/web/public/design/notion/: ' + missing.join(', ') +
    '. Re-vendor from docs/design/notion-import/_ds/ (BUILD-CONTRACT 3.1, phase P0.2).');
});

check('every vendored text file matches its recorded SHA-256', () => {
  const drifted = [];
  for (const rel of VENDORED_TEXT.keys()) {
    const actual = hashText(readText(path.join(VENDOR_DIR, rel)));
    if (actual !== EXPECTED_SHA256[rel]) drifted.push(rel + ' (' + actual.slice(0, 12) + ')');
  }
  assert.deepStrictEqual(drifted, [],
    'Vendored files were edited: ' + drifted.join(', ') +
    '. The vendored bundle is a copy of a captured brand, not project source. ' +
    'Change styles.css instead and record the departure in DEVIATIONS.md.');
});

check('every vendored font binary matches its recorded SHA-256', () => {
  const drifted = [];
  for (const rel of VENDORED_BINARY.keys()) {
    const buf = fs.readFileSync(path.join(VENDOR_DIR, rel));
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== EXPECTED_SHA256[rel]) drifted.push(rel);
  }
  assert.deepStrictEqual(drifted, [], 'Vendored font binaries were modified: ' + drifted.join(', '));
});

check('every vendored file is still identical to its source of record in _ds/', () => {
  if (!fs.existsSync(BUNDLE_DIR)) {
    // The source of record is a docs folder. If it is ever removed the SHA-256
    // assertions above still protect the vendored copy, so this degrades rather
    // than failing the suite.
    console.log('    (skipped: docs/design/notion-import/_ds/ is not present)');
    return;
  }
  const mismatched = [];
  for (const [rel, source] of VENDORED_TEXT) {
    if (readText(path.join(VENDOR_DIR, rel)) !== readText(path.join(BUNDLE_DIR, source))) mismatched.push(rel);
  }
  for (const [rel, source] of VENDORED_BINARY) {
    if (!fs.readFileSync(path.join(VENDOR_DIR, rel)).equals(fs.readFileSync(path.join(BUNDLE_DIR, source)))) {
      mismatched.push(rel);
    }
  }
  assert.deepStrictEqual(mismatched, [],
    'Vendored copy has drifted from docs/design/notion-import/_ds/: ' + mismatched.join(', '));
});

// Parse the bundle once, after integrity is established.
let bundleDeclarations = [];
for (const file of TOKEN_FILES) {
  bundleDeclarations = bundleDeclarations.concat(
    parseDeclarations(stripComments(readText(path.join(VENDOR_DIR, 'tokens', file))))
  );
}
const bundle = buildThemeMaps(bundleDeclarations);

check('every vendored token file still defines its full token set', () => {
  const thin = [];
  for (const [rel, minimum] of Object.entries(MIN_TOKEN_COUNT)) {
    const declarations = parseDeclarations(stripComments(readText(path.join(VENDOR_DIR, rel))));
    const count = new Set(declarations.map((d) => d.name)).size;
    if (count < minimum) thin.push(rel + ' has ' + count + ', expected at least ' + minimum);
  }
  assert.deepStrictEqual(thin, [], 'Vendored token files look truncated: ' + thin.join('; '));
});

// ── Layer 2: the vendored paint layer resolves ─────────────────────────────

check('every var() in the vendored components.css resolves against the union of definition sites', () => {
  const componentsCss = stripComments(readText(path.join(VENDOR_DIR, 'components.css')));
  const defined = new Set(bundle.all);
  for (const decl of parseDeclarations(componentsCss)) defined.add(decl.name);
  for (const file of ['styles.css', 'styles-mobile.css', 'semantic-theme.css', 'focused-shell.css']) {
    const full = path.join(PUBLIC_DIR, file);
    if (!fs.existsSync(full)) continue;
    for (const decl of parseDeclarations(stripComments(readText(full)))) defined.add(decl.name);
  }
  const unresolved = new Map();
  const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(componentsCss)) !== null) {
    if (!defined.has(m[1])) unresolved.set(m[1], (unresolved.get(m[1]) || 0) + 1);
  }
  const names = [...unresolved.keys()].sort();
  assert.deepStrictEqual(names, [],
    'The vendored nt-* paint layer consumes tokens nothing defines: ' + names.join(', ') +
    '. Every one of those declarations is inert in the browser. Author the token into the ' +
    'styles.css :root block with the bundle value (BUILD-CONTRACT 1.1.1).');
});

// ── Layer 3: parity between styles.css and the bundle ──────────────────────

const stylesCss = stripComments(readText(path.join(PUBLIC_DIR, 'styles.css')));
const project = buildThemeMaps(parseDeclarations(stylesCss), { skipPaletteBlocks: true });
const invented = readInventedTokens();

check('INVENTIONS.md still documents the invented tokens', () => {
  assert.ok(invented.size >= 3,
    'INVENTIONS.md lists ' + invented.size + ' invented tokens; the contract names three ' +
    '(--app-on-accent, --app-scrim, --app-terminal-gutter). A shrinking list means the ' +
    'document was gutted, and the parity gate below depends on it.');
});

/**
 * Names in a bundle-owned family that styles.css defines and that are subject
 * to the value comparison: excludes the palette blocks (already filtered), the
 * frozen pre-existing project tokens, and anything documented as an invention.
 */
const comparable = [...project.all]
  .filter(isBundleOwned)
  .filter((name) => !PRE_EXISTING_PROJECT_TOKENS.has(name))
  .filter((name) => !invented.has(name))
  .sort();

check('every bundle-owned token styles.css defines exists in the bundle or is a documented invention', () => {
  const undocumented = comparable.filter((name) => !bundle.all.has(name));
  assert.deepStrictEqual(undocumented, [],
    'styles.css defines bundle-family tokens the captured bundle does not contain: ' +
    undocumented.join(', ') + '. Either the name is a typo, or it is an invention and needs a row ' +
    'in docs/design/notion-restyle/INVENTIONS.md.');
});

check('light chrome values in styles.css match the bundle verbatim', () => {
  const mismatches = [];
  for (const name of comparable) {
    if (!bundle.light.has(name)) continue;
    const mine = project.light.get(name);
    const theirs = bundle.light.get(name);
    if (mine !== undefined && mine !== theirs) {
      mismatches.push(name + ': styles.css has "' + mine + '", bundle has "' + theirs + '"');
    }
  }
  assert.deepStrictEqual(mismatches, [],
    'Token values drifted from the vendored bundle (light):\n      ' + mismatches.join('\n      ') +
    '\n    Copy the bundle value verbatim, or record a DEVIATIONS.md row and exclude it here.');
});

check('dark chrome values in styles.css match the bundle verbatim', () => {
  const mismatches = [];
  for (const name of comparable) {
    if (!bundle.dark.has(name)) continue;
    const mine = project.dark.get(name);
    const theirs = bundle.dark.get(name);
    // Only compare when styles.css actually carries a dark declaration for the
    // name. A token that is deliberately theme-invariant (--app-accent-blue and
    // its ink, for example) has no dark block and inherits, which is correct.
    const hasOwnDark = parseDeclarations(stylesCss).some(
      (d) => d.name === name && isDarkContext(d.context) && !isPaletteBlockContext(d.context)
    );
    if (hasOwnDark && mine !== theirs) {
      mismatches.push(name + ': styles.css has "' + mine + '", bundle has "' + theirs + '"');
    }
  }
  assert.deepStrictEqual(mismatches, [],
    'Token values drifted from the vendored bundle (dark):\n      ' + mismatches.join('\n      '));
});

check('the pre-existing token list is frozen at its P0 size and may only shrink', () => {
  assert.ok(PRE_EXISTING_PROJECT_TOKENS.size <= 8,
    'PRE_EXISTING_PROJECT_TOKENS grew to ' + PRE_EXISTING_PROJECT_TOKENS.size + '. It was frozen at ' +
    '8 in P0. Growing it excuses a token from the parity comparison, which is exactly the drift ' +
    'this gate exists to catch. Author the bundle value instead, or record a DEVIATIONS.md row.');
});

check('the pre-existing token list is not a deletion route: every entry stays defined', () => {
  const gone = [...PRE_EXISTING_PROJECT_TOKENS].filter((name) => !project.all.has(name));
  assert.deepStrictEqual(gone, [],
    'Legacy tokens excluded from parity must still be DEFINED in styles.css (RETIRED-with-alias, ' +
    'never deleted, per BUILD-CONTRACT 0.3). Missing: ' + gone.join(', '));
});

// ── Forward-looking: the terminalSurface projection arrives in P5 ───────────

const TERMINAL_SURFACE_PATH = path.join(PUBLIC_DIR, 'terminal-surface.js');
check('terminalSurface projection colours are 6-digit hex (skipped until P5 creates it)', () => {
  if (!fs.existsSync(TERMINAL_SURFACE_PATH)) {
    console.log('    (skipped: src/web/public/terminal-surface.js does not exist yet)');
    return;
  }
  // terminal.js _colorWithAlpha parses 6-digit hex only and silently returns
  // its fallback for anything else, so an rgba(), hsl(), oklch() or color-mix()
  // value in the projection loses the terminal selection colour with no error.
  // See BUILD-CONTRACT risk R5.
  const source = readText(TERMINAL_SURFACE_PATH);
  const colourKeys = /(['"]?)(bg|ink|dim|rule|accent|cursor|selectionBg|selectionInk|ansi\d{1,2})\1\s*:\s*(['"])([^'"]*)\3/g;
  const bad = [];
  let m;
  while ((m = colourKeys.exec(source)) !== null) {
    if (!/^#[0-9a-fA-F]{6}$/.test(m[4])) bad.push(m[2] + ': ' + m[4]);
  }
  assert.deepStrictEqual(bad, [],
    'terminalSurface values must be 6-digit hex; terminal.js _colorWithAlpha cannot parse ' +
    'anything else and fails silently: ' + bad.join(', '));
});

console.log('  ' + '─'.repeat(42));
console.log('  bundle tokens: ' + bundle.all.size +
  ' | styles.css bundle-family tokens compared: ' + comparable.length +
  ' | pre-existing project tokens: ' + PRE_EXISTING_PROJECT_TOKENS.size +
  ' | inventions: ' + invented.size);
console.log('  [notion-token-parity] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) process.exit(1);
process.exit(0);
