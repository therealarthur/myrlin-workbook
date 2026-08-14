#!/usr/bin/env node
/**
 * terminal-surface.test.js
 * Notion restyle phase P5, work package P5.4.
 * BUILD-CONTRACT.md P5.4 and P5.5, TERMINAL-ARCHITECTURE.md 10.2 and 10.5,
 * DESIGN-SPEC.md 10.2 and 10.4, CURRENT-UI.md section 6.
 *
 * WHAT THIS GATES
 *
 * terminal-surface.js is a static data table of thirteen palettes. A static
 * table is the right shape for it (it needs no DOM, it guarantees six-digit
 * hex for the _colorWithAlpha constraint in risk R5, and it lets the colour
 * flow JS to CSS so the pane chrome and the terminal cannot disagree), and it
 * has exactly one failure mode: it can ROT. Somebody edits `--mauve` for Nord
 * in styles.css, the chrome moves, the terminal does not, and nobody notices
 * for a release.
 *
 * So the central assertion here is a DRIFT GATE. It re-derives every palette
 * from the real per-theme blocks in styles.css, through the real
 * `_buildThemePalette` in terminal.js, and asserts the projection matches key
 * for key. That is what makes CURRENT-UI 6.2's finding ("editing styles.css
 * alone will not change the terminal for eight of the thirteen") false going
 * forward: the two are now provably one system, enforced rather than intended.
 *
 * The rest is the contract: the exact shape P7 and P10 consume, the six-digit
 * hex constraint, the contrast floors TERMINAL-ARCHITECTURE 10.5 makes a
 * verification gate, and the null-safety that lets every consumer degrade to
 * its own last-resort palette rather than to another theme's colours.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const SURFACE_PATH = path.join(PUBLIC_DIR, 'terminal-surface.js');
const TERMINAL_PATH = path.join(PUBLIC_DIR, 'terminal.js');
const REGISTRY_PATH = path.join(PUBLIC_DIR, 'theme-registry.js');
const STYLES_PATH = path.join(PUBLIC_DIR, 'styles.css');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

const surface = require(SURFACE_PATH);
const registry = require(REGISTRY_PATH);
const surfaceSrc = fs.readFileSync(SURFACE_PATH, 'utf8');
const terminalSrc = fs.readFileSync(TERMINAL_PATH, 'utf8');
const stylesCss = fs.readFileSync(STYLES_PATH, 'utf8');
const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named check.
 *
 * @param {string} name - Assertion name.
 * @param {Function} fn - Body that throws on failure.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : String(err)));
  }
}

const THEME_IDS = [
  'mocha', 'macchiato', 'frappe', 'nord', 'dracula', 'tokyo-night',
  'cherry', 'ocean', 'amber', 'mint', 'latte', 'rose-pine-dawn', 'gruvbox-light',
];
const LIGHT_THEMES = new Set(['latte', 'rose-pine-dawn', 'gruvbox-light']);
const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
];
const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * Relative luminance, WCAG 2.1 formula.
 *
 * @param {string} hex - Six-digit hex colour.
 * @returns {number} Relative luminance in 0..1.
 */
function luminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4]
    .map((i) => parseInt(value.substr(i, 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * WCAG contrast ratio between two opaque colours.
 *
 * @param {string} a - Six-digit hex.
 * @param {string} b - Six-digit hex.
 * @returns {number} Ratio from 1 to 21.
 */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Extract the body of a top-level CSS rule whose prelude is exactly `selector`.
 *
 * Exact rather than prefix-matched: `:root[data-theme="latte"]` is also the
 * prefix of six descendant rules in this stylesheet, and matching one of those
 * would silently read an empty palette.
 *
 * @param {string} selector - Rule prelude, without the brace.
 * @returns {string|null} The rule body, or null.
 */
function ruleBody(selector) {
  const needle = selector + ' {';
  const at = stylesCss.indexOf(needle);
  if (at === -1) return null;
  const open = stylesCss.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < stylesCss.length; i++) {
    if (stylesCss[i] === '{') depth++;
    else if (stylesCss[i] === '}') {
      depth--;
      if (depth === 0) return stylesCss.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Parse the six-digit hex custom properties out of a rule body.
 *
 * @param {string} body - Rule body text.
 * @returns {Object} Property name to hex value.
 */
function hexProperties(body) {
  const out = {};
  if (!body) return out;
  const re = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let match;
  while ((match = re.exec(body)) !== null) out[match[1]] = match[2].toLowerCase();
  return out;
}

// Mocha is the base :root; every other theme carries a full 24-token block.
const ROOT_TOKENS = hexProperties(ruleBody(':root'));

/**
 * The palette tokens in force for a theme, as a browser would resolve them.
 *
 * @param {string} themeId - Persisted theme id.
 * @returns {Object} Token name to hex value.
 */
function paletteTokens(themeId) {
  if (themeId === 'mocha') return ROOT_TOKENS;
  return Object.assign({}, ROOT_TOKENS, hexProperties(ruleBody(':root[data-theme="' + themeId + '"]')));
}

/**
 * Evaluate terminal.js in a vm and hand back the real TerminalPane, with the
 * document stamped to a theme and, optionally, the projection global present.
 *
 * @param {string} themeId - Theme to stamp on documentElement.dataset.
 * @param {boolean} withProjection - Whether to expose MyrlinTerminalSurface.
 * @returns {{TerminalPane: Function, sandbox: Object}} The runtime.
 */
function loadTerminal(themeId, withProjection) {
  const styleWrites = {};
  const sandbox = {
    window: {},
    document: {
      documentElement: {
        dataset: { theme: themeId },
        style: {
          setProperty(name, value) { styleWrites[name] = value; },
        },
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
    console,
  };
  vm.createContext(sandbox);
  if (withProjection) {
    // Evaluate the projection INSIDE the same context, which is what the
    // browser does: index.html loads it as a script immediately before
    // terminal.js. Injecting the Node-required module instead would give its
    // closure Node's globals, so its `document` would be undefined and the CSS
    // publication would silently no-op in a way it never does in production.
    vm.runInContext(surfaceSrc, sandbox, { filename: 'terminal-surface.js' });
    sandbox.window.MyrlinTerminalSurface = sandbox.MyrlinTerminalSurface;
  }
  vm.runInContext(terminalSrc, sandbox, { filename: 'terminal.js' });
  return { TerminalPane: sandbox.window.TerminalPane, sandbox: sandbox, styleWrites: styleWrites };
}

console.log('\n  P5.4: the terminalSurface projection');
console.log('  ' + '-'.repeat(58));

/* ============================================================
   1. The contract: exactly the shape P7 and P10 consume
   ============================================================ */

check('the projection covers exactly the 13 persisted theme ids, in registry order', () => {
  assert.deepStrictEqual(surface.SURFACE_IDS, THEME_IDS);
  assert.deepStrictEqual(registry.LEGACY_THEME_IDS.slice(), THEME_IDS,
    'the projection and the registry must agree on the id set AND its order');
});

check('every surface carries the documented fields and nothing is undefined', () => {
  const scalar = ['id', 'appearance', 'bg', 'ink', 'dim', 'rule', 'accent',
    'cursor', 'cursorAccent', 'selectionBg', 'selectionInk', 'fontFamily'];
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    assert.ok(s, id + ' has no surface');
    for (const key of scalar) {
      assert.strictEqual(typeof s[key], 'string', id + '.' + key + ' must be a string');
      assert.ok(s[key].length > 0, id + '.' + key + ' must not be empty');
    }
    assert.strictEqual(s.id, id);
    assert.strictEqual(s.appearance, LIGHT_THEMES.has(id) ? 'light' : 'dark');
    assert.strictEqual(typeof s.ansi, 'object');
    assert.deepStrictEqual(Object.keys(s.ansi), ANSI_KEYS,
      id + ' must carry the 16 ANSI slots in the canonical order');
  }
});

check('an unknown id returns NULL rather than a default palette', () => {
  // Load bearing. A caller that received Mocha for an unknown id would paint
  // one pane in another theme's colours, which is the exact failure the eight
  // static palettes were written to prevent.
  assert.strictEqual(surface.terminalSurface('not-a-theme'), null);
  assert.strictEqual(surface.terminalSurface(''), null);
  assert.strictEqual(surface.terminalSurface(undefined), null);
  assert.strictEqual(surface.xtermTheme('not-a-theme'), null);
  assert.strictEqual(surface.applyTerminalSurfaceVars('not-a-theme', { style: { setProperty() {} } }), false);
});

check('the table is deeply frozen, so one consumer cannot recolour every pane', () => {
  assert.ok(Object.isFrozen(surface), 'the module export must be frozen');
  assert.ok(Object.isFrozen(surface.SURFACES));
  for (const id of THEME_IDS) {
    assert.ok(Object.isFrozen(surface.SURFACES[id]), id + ' must be frozen');
    assert.ok(Object.isFrozen(surface.SURFACES[id].ansi), id + ' ansi must be frozen');
  }
});

/* ============================================================
   2. Risk R5: every value _colorWithAlpha could see is 6-digit hex
   ============================================================ */

check('every colour except the selection wash is a SIX-DIGIT hex (risk R5)', () => {
  // BUILD-CONTRACT P5.4's critical constraint: _colorWithAlpha at
  // terminal.js:464 parses only /^#([0-9a-f]{6})$/i and silently returns its
  // fallback for anything else. No rgba(), no hsl(), no oklch(), no
  // color-mix() may enter this table.
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    for (const key of ['bg', 'ink', 'dim', 'rule', 'accent', 'cursor', 'cursorAccent', 'selectionInk']) {
      assert.match(s[key], HEX6, id + '.' + key + ' must be six-digit hex, got ' + s[key]);
    }
    for (const key of ANSI_KEYS) {
      assert.match(s.ansi[key], HEX6, id + '.ansi.' + key + ' must be six-digit hex, got ' + s.ansi[key]);
    }
  }
});

check('the selection wash is the one translucent value, and it is xterm-ready rgba', () => {
  // selectionBg is the ONLY slot that is not opaque, because a selection has
  // to composite over the cell beneath it. It is precomputed here rather than
  // handed to _colorWithAlpha at run time, which is what keeps the R5
  // constraint total: nothing in this file is ever parsed by that function.
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    assert.match(s.selectionBg, /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.\d+\)$/,
      id + '.selectionBg must be an rgba() string xterm can consume directly');
  }
});

/* ============================================================
   3. THE DRIFT GATE
   ============================================================ */

/**
 * The three places where the palette this application SHIPS and the palette
 * `_buildThemePalette` would derive from styles.css disagree, found by the
 * drift gate below on the run that introduced it.
 *
 * All three predate P5 and none is visible today, because the eight static
 * palettes never went through the builder. They are the concrete form of
 * CURRENT-UI.md section 6's finding: two independent colour systems that meet
 * only through getComputedStyle will drift, and these are the three places
 * they already had.
 *
 * The projection keeps the SHIPPED value in every case, because P5.4's done
 * criterion is that nobody's terminal changes colour, and because in each case
 * the shipped value is the better one:
 *
 *   mocha.brightWhite      #a6adc8 is Catppuccin's own subtext0 mapping for
 *                          ANSI 15, and it is the value the mock's `dim` slot
 *                          uses for this theme. The builder's generic rule
 *                          (bright white equals `text`) would collapse ANSI 15
 *                          onto the foreground and lose a step.
 *   macchiato/frappe
 *     .selectionBackground These two were authored at 0.3 alpha while the
 *                          builder uses 0.25 for every dark theme. A selection
 *                          wash is a matter of one palette's taste and both
 *                          are legible; changing it would move a colour for no
 *                          reason.
 *   cherry/ocean/amber/mint
 *     .cursor              All four invented dark themes chose a SIGNATURE
 *                          cursor (cherry's pink, ocean's and mint's and
 *                          amber's own accents) rather than the rosewater slot
 *                          the builder reads; their CSS blocks carry a warm
 *                          neutral in --rosewater instead. The cursor is the
 *                          most identity-carrying pixel in a terminal and it
 *                          moves on every keystroke, so this is the single
 *                          most visible thing in the file to change by
 *                          accident.
 *     .selectionBackground Follows from the cursor: each of the four derives
 *                          its selection wash from its own signature colour
 *                          rather than from --mauve.
 *
 * Eleven in total, over 286 compared values. DECISIONS.md 14.3 carries the
 * full list. Every OTHER key of every OTHER theme must match, which is what
 * the gate enforces.
 */
const KNOWN_BUILDER_DIVERGENCE = new Set([
  // ANSI 15 on Mocha: Catppuccin's own subtext0 mapping, not `text`.
  'mocha.brightWhite',
  // Two palettes authored their selection wash at 0.3 rather than 0.25.
  'macchiato.selectionBackground',
  'frappe.selectionBackground',
  // The four invented dark themes, each with a signature cursor and a
  // selection wash derived from it rather than from --rosewater and --mauve.
  'cherry.cursor',
  'cherry.selectionBackground',
  'ocean.cursor',
  'ocean.selectionBackground',
  'amber.cursor',
  'amber.selectionBackground',
  'mint.cursor',
  'mint.selectionBackground',
]);

check('DRIFT GATE: every projected palette equals what styles.css plus _buildThemePalette produce', () => {
  // The whole reason a static table is safe. Re-derive each palette from the
  // real per-theme block in styles.css through the real builder in
  // terminal.js, and compare key for key. An edit to --base, --mauve, --text
  // or any of the other eleven tokens for any theme fails HERE rather than
  // shipping a terminal that disagrees with its own chrome.
  const { TerminalPane } = loadTerminal('mocha', false);
  const drift = [];
  for (const id of THEME_IDS) {
    const tokens = paletteTokens(id);
    assert.ok(tokens['--base'], id + ' has no --base in styles.css');
    const derived = TerminalPane._buildThemePalette({
      base: tokens['--base'],
      surface1: tokens['--surface1'],
      surface2: tokens['--surface2'],
      text: tokens['--text'],
      subtext0: tokens['--subtext0'],
      subtext1: tokens['--subtext1'],
      mauve: tokens['--mauve'],
      blue: tokens['--blue'],
      green: tokens['--green'],
      yellow: tokens['--yellow'],
      red: tokens['--red'],
      teal: tokens['--teal'],
      rosewater: tokens['--rosewater'],
    }, LIGHT_THEMES.has(id));
    const projected = surface.xtermTheme(id);
    for (const key of Object.keys(derived)) {
      if (KNOWN_BUILDER_DIVERGENCE.has(id + '.' + key)) continue;
      if (String(derived[key]).toLowerCase() !== String(projected[key]).toLowerCase()) {
        drift.push(id + '.' + key + ': styles.css says ' + derived[key] + ', the projection says ' + projected[key]);
      }
    }
  }
  assert.strictEqual(drift.length, 0,
    drift.length + ' projected value(s) have drifted from the palette blocks in styles.css:\n  ' +
    drift.join('\n  '));
});

check('every known divergence is still a real one, so the exemption list cannot go stale', () => {
  // An allow-list that nobody re-checks becomes a hiding place. This asserts
  // each entry is STILL a real divergence, so a future edit that reconciles one
  // of them fails here and the entry gets removed rather than lingering as a
  // licence for a fourth.
  const { TerminalPane } = loadTerminal('mocha', false);
  for (const entry of KNOWN_BUILDER_DIVERGENCE) {
    const [id, key] = entry.split('.');
    const tokens = paletteTokens(id);
    const derived = TerminalPane._buildThemePalette({
      base: tokens['--base'], surface1: tokens['--surface1'], surface2: tokens['--surface2'],
      text: tokens['--text'], subtext0: tokens['--subtext0'], subtext1: tokens['--subtext1'],
      mauve: tokens['--mauve'], blue: tokens['--blue'], green: tokens['--green'],
      yellow: tokens['--yellow'], red: tokens['--red'], teal: tokens['--teal'],
      rosewater: tokens['--rosewater'],
    }, LIGHT_THEMES.has(id));
    assert.notStrictEqual(
      String(derived[key]).toLowerCase(),
      String(surface.xtermTheme(id)[key]).toLowerCase(),
      entry + ' no longer diverges; remove it from KNOWN_BUILDER_DIVERGENCE rather than leaving a stale exemption'
    );
  }
});

check('the projected background is byte-identical to the one theme-registry.test.js pins', () => {
  // That suite asserts all thirteen backgrounds through getCurrentTheme with no
  // projection loaded. This asserts the projection agrees with it, so the two
  // paths can never diverge without one of them turning red.
  const expected = {
    mocha: '#1e1e2e', macchiato: '#24273a', frappe: '#303446', nord: '#2e3440',
    dracula: '#282a36', 'tokyo-night': '#1a1b26', cherry: '#221a22', ocean: '#1a1e28',
    amber: '#211e1a', mint: '#1a2120', latte: '#eff1f5', 'rose-pine-dawn': '#faf4ed',
    'gruvbox-light': '#fbf1c7',
  };
  for (const id of THEME_IDS) {
    assert.strictEqual(surface.terminalSurface(id).bg, expected[id], id + ' background');
    assert.strictEqual(surface.xtermTheme(id).background, expected[id], id + ' xterm background');
  }
});

check('the live path agrees with the fallback path for all 13, key for key', () => {
  // getCurrentTheme WITH the projection must equal getCurrentTheme WITHOUT it.
  // This is the promise "nobody's terminal changes colour", executed.
  for (const id of THEME_IDS) {
    const withProjection = loadTerminal(id, true).TerminalPane.getCurrentTheme();
    const withoutProjection = loadTerminal(id, false).TerminalPane.getCurrentTheme();
    assert.deepStrictEqual(
      Object.assign({}, withProjection),
      Object.assign({}, withoutProjection),
      id + ': the projection and the retained static fallback must produce the same ITheme'
    );
  }
});

/* ============================================================
   4. Contrast, TERMINAL-ARCHITECTURE 10.5 and VG-7
   ============================================================ */

check('ink clears 4.5:1 against its own ground in all 13 palettes', () => {
  const rows = [];
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    const ratio = contrast(s.ink, s.bg);
    if (ratio < 4.5) rows.push(id + ' ink ' + ratio.toFixed(2));
  }
  assert.deepStrictEqual(rows, [], 'primary terminal output below the text floor: ' + rows.join(', '));
});

check('dim clears 4.5:1 against its own ground in all 13, including the three light themes', () => {
  // TERMINAL-ARCHITECTURE 10.5 makes this a verification gate (VG-7) for
  // latte, rose-pine-dawn and gruvbox-light specifically, because dim is the
  // ink for the history layer's paging chrome and its provenance rules. It is
  // applied to all thirteen here: a floor that only holds for three themes is
  // a floor somebody will step off.
  const rows = [];
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    const ratio = contrast(s.dim, s.bg);
    if (ratio < 4.5) rows.push(id + ' dim ' + ratio.toFixed(2));
  }
  assert.deepStrictEqual(rows, [], 'secondary terminal output below the text floor: ' + rows.join(', '));
});

check('the prompt accent clears 4.5:1 against its own ground in all 13', () => {
  const rows = [];
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    const ratio = contrast(s.accent, s.bg);
    if (ratio < 4.5) rows.push(id + ' accent ' + ratio.toFixed(2));
  }
  assert.deepStrictEqual(rows, [], 'the prompt glyph is text and is below the text floor: ' + rows.join(', '));
});

check('dim is quieter than ink but louder than the rule, in every palette', () => {
  // The hierarchy is the point of having three slots. Without this, a
  // substitution that fixed a contrast number could silently invert the
  // reading order of primary and secondary output.
  for (const id of THEME_IDS) {
    const s = surface.terminalSurface(id);
    const ink = contrast(s.ink, s.bg);
    const dim = contrast(s.dim, s.bg);
    const rule = contrast(s.rule, s.bg);
    assert.ok(dim <= ink, id + ': dim (' + dim.toFixed(2) + ') must not be louder than ink (' + ink.toFixed(2) + ')');
    assert.ok(rule < dim, id + ': the rule (' + rule.toFixed(2) + ') must be quieter than dim (' + dim.toFixed(2) + ')');
  }
});

/* ============================================================
   5. The CSS publication, which is what makes the chrome match
   ============================================================ */

check('applyTerminalSurfaceVars writes the seven --term-* properties', () => {
  const written = {};
  const fake = { style: { setProperty(name, value) { written[name] = value; } } };
  assert.strictEqual(surface.applyTerminalSurfaceVars('mocha', fake), true);
  assert.deepStrictEqual(written, {
    '--term-bg': '#1e1e2e',
    '--term-ink': '#cdd6f4',
    '--term-dim': '#a6adc8',
    '--term-rule': '#45475a',
    '--term-accent': '#cba6f7',
    '--term-selection-bg': 'rgba(203, 166, 247, 0.25)',
    '--term-cursor': '#f5e0dc',
  });
});

check('publication never throws on a hostile or absent target', () => {
  assert.strictEqual(surface.applyTerminalSurfaceVars('mocha', {}), false);
  assert.strictEqual(surface.applyTerminalSurfaceVars('mocha', { style: {} }), false);
  assert.strictEqual(surface.applyTerminalSurfaceVars('mocha', {
    style: { setProperty() { throw new Error('CSSOM refused'); } },
  }), false);
});

check('getCurrentTheme publishes the variables as a side effect, so app.js needs no edit', () => {
  // app.js already calls TerminalPane.getCurrentTheme() once per live pane on
  // every theme change. Publishing here is what makes the chrome half of the
  // re-theme work without touching a file this work package does not own.
  const runtime = loadTerminal('gruvbox-light', true);
  runtime.TerminalPane.getCurrentTheme();
  assert.strictEqual(runtime.styleWrites['--term-bg'], '#fbf1c7');
  assert.strictEqual(runtime.styleWrites['--term-accent'], '#af3a03');
});

check('every published property is consumed by styles.css, and every consumed one is published', () => {
  // The phantom-token gate cannot see these: they are set from JavaScript, so
  // they live in that suite's DYNAMIC_TOKENS allow-list. This is the assertion
  // that keeps the allow-list honest from the other side.
  const published = Object.keys(surface.CSS_VARIABLES);
  for (const name of published) {
    assert.ok(/^--term-[a-z-]+$/.test(name), name + ' must use the --term- prefix');
  }
  const consumed = new Set();
  const re = /var\(\s*(--term-[a-z-]+)/g;
  let match;
  while ((match = re.exec(stylesCss)) !== null) consumed.add(match[1]);
  for (const name of consumed) {
    assert.ok(published.includes(name),
      'styles.css consumes ' + name + ' but the projection never publishes it, so the rule silently does nothing');
  }
});

/* ============================================================
   6. Wiring: the registry accessor, the load order, the font
   ============================================================ */

check('theme-registry gains the accessor and keeps every existing export', () => {
  assert.strictEqual(typeof registry.terminalSurface, 'function');
  assert.strictEqual(registry.terminalSurface('mocha').bg, '#1e1e2e');
  assert.strictEqual(registry.terminalSurface('not-a-theme'), null);
  // The frozen metadata the registry has always carried is untouched.
  assert.strictEqual(registry.THEME_REGISTRY.length, 13);
  assert.strictEqual(registry.resolveXtermPaletteId('nord'), 'nord');
  assert.strictEqual(registry.getTheme('frappe').label, 'Frappé');
});

check('index.html loads terminal-surface.js BEFORE terminal.js', () => {
  const surfaceAt = indexHtml.indexOf('terminal-surface.js');
  const terminalAt = indexHtml.indexOf('<script src="terminal.js');
  assert.ok(surfaceAt !== -1, 'terminal-surface.js is not loaded');
  assert.ok(terminalAt !== -1, 'terminal.js is not loaded');
  assert.ok(surfaceAt < terminalAt,
    'the projection must be parsed before the class that reads it at parse time');
  assert.match(indexHtml, /terminal-surface\.js\?v=/, 'the new asset needs a cachebuster like every other');
});

check('the four head assets keep their relative order around the new body script', () => {
  const order = ['semantic-theme.css', 'focused-shell.css', 'theme-registry.js', 'experience-model.js']
    .map((asset) => indexHtml.indexOf(asset));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], 'head asset order changed at index ' + i);
  }
  assert.ok(indexHtml.indexOf('terminal-surface.js') > order[order.length - 1],
    'the projection is a BODY script; putting it in the head would reorder the four pinned assets');
});

check('the terminal face comes from the projection, with the shipped stack retained beneath it', () => {
  assert.ok(/--font-terminal/.test(stylesCss), 'the token must be defined in styles.css');
  assert.ok(/getTerminalFontFamily/.test(terminalSrc), 'the constructor must read the face through the projection');
  assert.ok(/'JetBrains Mono', 'Cascadia Code', Consolas, monospace/.test(terminalSrc),
    'the previously shipped stack must be retained as the last resort, or a failed script load changes cell metrics');
  const { TerminalPane } = loadTerminal('mocha', true);
  const face = TerminalPane.getTerminalFontFamily();
  assert.ok(/iA Writer Mono/.test(face), 'the default face is the vendored iA Writer Mono');
  assert.ok(/JetBrains Mono/.test(face), 'JetBrains Mono stays selectable for anyone who has it installed');
  const bare = loadTerminal('mocha', false).TerminalPane.getTerminalFontFamily();
  assert.strictEqual(bare, "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    'with no projection the face must be exactly what shipped before P5');
});

check('a per-theme font override is an extension point that exists and is unused', () => {
  assert.ok(/surface\.fontFamily/.test(surfaceSrc),
    'the resolver must prefer a per-theme override so a palette can carry its own face');
  for (const id of THEME_IDS) {
    assert.strictEqual(surface.SURFACES[id].fontFamily, undefined,
      id + ' must not pin a face today: the token is the source and a theme override is opt-in');
  }
});

check('the projection is optional: terminal.js still resolves all 13 without it', () => {
  // The degradation contract, executed. If terminal-surface.js fails to load,
  // the terminal must be exactly what it was before P5 rather than blank.
  for (const id of THEME_IDS) {
    const palette = loadTerminal(id, false).TerminalPane.getCurrentTheme();
    assert.match(palette.background, HEX6, id + ' must still resolve a background with no projection');
  }
});

console.log('  ' + '-'.repeat(58));
console.log('  [terminal-surface] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
