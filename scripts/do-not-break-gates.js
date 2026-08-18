#!/usr/bin/env node
/**
 * do-not-break-gates.js - the mechanical floor for the Notion restyle.
 * Created: 2026-08-13 (phase P0, work package P0.6).
 *
 * Implements gates G1 to G12 from BUILD-CONTRACT.md 5.3, plus G13 for the
 * data-* attribute contract that rule 4 of section 0.4 requires and that 5.3
 * does not cover. Each gate prints its number, its measured value, its recorded
 * baseline and its target.
 *
 * WHY THESE ARE RATCHETS AND NOT ABSOLUTES
 *
 * The contract's own P0 done criterion is "all gates pass on unmodified source,
 * proving they are not vacuous". But several targets describe the END STATE of
 * phases P2 to P4: zero radius literals, zero gradients, one uppercase rule,
 * zero Catppuccin consumption in chrome. None of those can be true in P0.
 *
 * So every countable gate carries three numbers: a baseline measured on
 * unmodified source, a target, and the phase the target is due. The gate FAILS
 * when the measurement moves away from the target relative to the baseline, and
 * reports progress otherwise. Set-shaped gates (ids, classes, data keys) have no
 * baseline number: any removal is a failure, always.
 *
 * Run `--strict` to turn every phase target into a hard failure. That is what
 * the final acceptance sweep in P12 runs.
 * Run `--record` to rewrite the baseline file from the current measurements.
 * That is a deliberate re-baselining act for the phase that improves a number;
 * it is never run to make a red gate green.
 *
 * Usage:
 *   node scripts/do-not-break-gates.js            # ratchet mode, the phase gate
 *   node scripts/do-not-break-gates.js --strict   # targets are hard failures
 *   node scripts/do-not-break-gates.js --json     # machine-readable summary
 *   node scripts/do-not-break-gates.js --record   # re-baseline (deliberate only)
 *
 * Exit code 0 when every gate passes, 1 otherwise.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'src', 'web', 'public');
const DESIGN_DOCS = path.join(ROOT, 'docs', 'design', 'notion-restyle');
const BASELINE_PATH = path.join(DESIGN_DOCS, 'gate-baseline.json');

const ARGS = new Set(process.argv.slice(2));
const STRICT = ARGS.has('--strict');
const RECORD = ARGS.has('--record');
const JSON_OUT = ARGS.has('--json');

// The four project stylesheets. Vendored CSS is never scanned: it is a copy of
// a captured brand and test/notion-token-parity.test.js owns its integrity.
const STYLESHEETS = ['styles.css', 'styles-mobile.css', 'focused-shell.css', 'semantic-theme.css'];

// The frontend sources a class or dataset key may live in. index.html carries
// authored markup; the four scripts carry generated markup.
const FRONTEND_SOURCES = ['index.html', 'app.js', 'terminal.js', 'mirror-view.js', 'schedules.js'];

// The 24 Catppuccin-family palette token names. Chrome consumption of these
// must reach zero by the end of P4; the terminal keeps them forever.
const PALETTE_TOKENS = [
  'base', 'mantle', 'crust', 'surface0', 'surface1', 'surface2', 'overlay0', 'overlay1',
  'subtext0', 'subtext1', 'mauve', 'lavender', 'flamingo', 'rosewater', 'sapphire', 'sky',
  'peach', 'pink', 'text', 'blue', 'green', 'yellow', 'red', 'teal',
];

// The data-* attribute floor, from DO-NOT-BREAK.md B.2. Losing one of these
// detaches a row from its record or kills a delegation path. Checked in either
// attribute form (data-view-mode) or dataset form (viewMode), because three of
// them only ever appear in dataset form today.
const DATA_ATTRIBUTE_FLOOR = [
  'data-account-id', 'data-action', 'data-body', 'data-cancel', 'data-density',
  'data-density-choice', 'data-device-id', 'data-encoded', 'data-form', 'data-form-error',
  'data-group-id', 'data-history', 'data-id', 'data-index', 'data-key', 'data-list',
  'data-path', 'data-pid', 'data-port', 'data-profile-id', 'data-project-encoded',
  'data-project-path', 'data-provider', 'data-provider-tab', 'data-provider-toggle',
  'data-pty-id', 'data-reset-at', 'data-session-id', 'data-setting', 'data-setting-key',
  'data-setting-num', 'data-setting-select', 'data-setting-slider', 'data-slot', 'data-sort',
  'data-task-id', 'data-td-id', 'data-theme', 'data-theme-appearance', 'data-theme-choice',
  'data-tunnel-id', 'data-ui-shell', 'data-view-mode', 'data-when', 'data-workspace-id',
  'data-ws-id',
];

// Trees scanned for em dashes. Everything the restyle can touch.
const EM_DASH_TREES = ['src', 'test', 'scripts', path.join('docs', 'design', 'notion-restyle')];
const EM_DASH_SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.mp4', '.webm', '.pdf', '.map', '.wasm', '.db', '.sqlite',
]);

const results = [];

/**
 * Read a project file as text.
 *
 * @param {string} relPath - Path relative to the repository root.
 * @returns {string} File contents, or an empty string when absent.
 */
function read(relPath) {
  const full = path.join(ROOT, relPath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

/**
 * Read a public frontend file as text.
 *
 * @param {string} name - File name under src/web/public.
 * @returns {string} File contents, or an empty string when absent.
 */
function readPublic(name) {
  const full = path.join(PUBLIC_DIR, name);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

/**
 * Strip CSS block comments so commented-out code and prose never count.
 *
 * @param {string} css - Stylesheet text.
 * @returns {string} Comment-free text.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Load the recorded baselines. A missing file is fatal outside --record: a gate
 * with no baseline cannot tell progress from regression, and silently passing
 * would be worse than stopping.
 *
 * @returns {object} Baseline document.
 */
function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    if (RECORD) return { gates: {} };
    console.error('FATAL: ' + BASELINE_PATH + ' is missing. Run with --record to create it.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

const baseline = loadBaseline();

/**
 * Record a countable ratchet gate.
 *
 * @param {string} id - Gate id, for example "G6".
 * @param {string} name - What the gate protects.
 * @param {number} measured - Current measurement.
 * @param {object} spec - { direction: 'down'|'up', target: number|null, phase: string, note?: string }
 * @returns {void}
 */
function countGate(id, name, measured, spec) {
  const recorded = baseline.gates && baseline.gates[id] ? baseline.gates[id].baseline : null;
  const target = spec.target;
  let status = 'PASS';
  let detail = '';
  if (recorded === null || recorded === undefined) {
    status = RECORD ? 'RECORD' : 'FAIL';
    detail = 'no recorded baseline';
  } else if (spec.direction === 'down' && measured > recorded) {
    status = 'FAIL';
    detail = 'regressed by ' + (measured - recorded);
  } else if (spec.direction === 'up' && measured < recorded) {
    status = 'FAIL';
    detail = 'lost ' + (recorded - measured);
  } else if (target !== null && target !== undefined) {
    const reached = spec.direction === 'down' ? measured <= target : measured >= target;
    if (!reached) {
      status = STRICT ? 'FAIL' : 'TODO';
      detail = 'target ' + target + ' due in ' + spec.phase;
    }
  }
  results.push({
    id, name, measured, baseline: recorded, target: target === undefined ? null : target,
    phase: spec.phase, status, detail, note: spec.note || '',
    direction: spec.direction,
  });
}

/**
 * Record a set gate: every member of a frozen set must still be found.
 *
 * @param {string} id - Gate id.
 * @param {string} name - What the gate protects.
 * @param {string[]} missing - Members that are no longer present.
 * @param {number} total - Size of the protected set.
 * @param {string} [note] - Extra context for the report line.
 * @returns {void}
 */
function setGate(id, name, missing, total, note) {
  results.push({
    id, name, measured: total - missing.length, baseline: total, target: total,
    phase: 'always', status: missing.length === 0 ? 'PASS' : 'FAIL',
    detail: missing.length ? missing.length + ' missing: ' + missing.slice(0, 12).join(', ') +
      (missing.length > 12 ? ' and ' + (missing.length - 12) + ' more' : '') : '',
    note: note || '', direction: 'set',
  });
}

/**
 * Record a warning-only observation. Never fails the run; exists so a
 * pre-existing defect stays visible instead of being forgotten.
 *
 * @param {string} id - Gate id.
 * @param {string} name - What was observed.
 * @param {boolean} clean - Whether the observation is currently clean.
 * @param {string} detail - Explanation shown when it is not.
 * @returns {void}
 */
function warnGate(id, name, clean, detail) {
  results.push({
    id, name, measured: clean ? 0 : 1, baseline: null, target: 0, phase: 'advisory',
    status: clean ? 'PASS' : 'WARN', detail: clean ? '' : detail, note: '', direction: 'warn',
  });
}

/**
 * Parse a stylesheet into top-level rule ranges keyed by their prelude, so a
 * measurement can ask "is this offset inside a :root block".
 *
 * @param {string} css - Comment-free stylesheet text.
 * @returns {Array<{prelude: string, start: number, end: number}>} Block ranges.
 */
function topLevelBlocks(css) {
  const blocks = [];
  let depth = 0;
  let preludeStart = 0;
  let blockStart = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        prelude = css.slice(preludeStart, i).trim().replace(/\s+/g, ' ');
        blockStart = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        blocks.push({ prelude, start: blockStart, end: i });
        preludeStart = i + 1;
      }
    }
  }
  return blocks;
}

/**
 * Offsets that sit inside a `:root` block, which is where raw values are
 * allowed to live: the Notion token block, the dark chrome block and the 13
 * palette blocks all match.
 *
 * @param {string} css - Comment-free stylesheet text.
 * @returns {Array<{start: number, end: number}>} Allowed ranges.
 */
function rootBlockRanges(css) {
  return topLevelBlocks(css)
    .filter((b) => /^:root\b/.test(b.prelude))
    .map((b) => ({ start: b.start, end: b.end }));
}

/**
 * Count regex matches that fall outside a set of allowed ranges.
 *
 * @param {string} text - Text to scan.
 * @param {RegExp} re - Global regular expression.
 * @param {Array<{start: number, end: number}>} allowed - Ranges that do not count.
 * @returns {{total: number, outside: number, samples: string[]}} Counts and a few example lines.
 */
function countOutside(text, re, allowed) {
  let total = 0;
  let outside = 0;
  const samples = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    total++;
    const inside = allowed.some((r) => m.index >= r.start && m.index <= r.end);
    if (!inside) {
      outside++;
      if (samples.length < 5) {
        samples.push('line ' + (text.slice(0, m.index).split('\n').length) + ': ' + m[0]);
      }
    }
  }
  return { total, outside, samples };
}

// ── G1: every protected element id survives ────────────────────────────────

/**
 * Parse a sectioned snapshot file into its named sections.
 *
 * @param {string} filePath - Absolute path to the snapshot.
 * @returns {Map<string, string[]>} Section name to entries. Unsectioned entries land under "".
 */
function parseSnapshot(filePath) {
  const sections = new Map([['', []]]);
  let current = '';
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([a-z]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  return sections;
}

const idSnapshot = parseSnapshot(path.join(DESIGN_DOCS, 'id-snapshot.txt'));
const indexHtml = readPublic('index.html');
const authoredIds = new Set([...indexHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
const scriptSources = FRONTEND_SOURCES.filter((f) => f !== 'index.html').map(readPublic).join('\n');

const missingStaticIds = (idSnapshot.get('static') || []).filter((id) => !authoredIds.has(id));
const missingDynamicIds = (idSnapshot.get('dynamic') || []).filter((id) => !scriptSources.includes(id));
setGate(
  'G1',
  'element ids intact (static in index.html, dynamic in the four scripts)',
  missingStaticIds.concat(missingDynamicIds.map((id) => id + ' [dynamic]')),
  (idSnapshot.get('static') || []).length + (idSnapshot.get('dynamic') || []).length,
  'a missing id is a silent null that kills a feature branch at first click'
);

// ── G2: every JS-coupled class survives ────────────────────────────────────

const classSnapshot = parseSnapshot(path.join(DESIGN_DOCS, 'class-snapshot.txt')).get('') || [];
const allFrontend = FRONTEND_SOURCES.map(readPublic).join('\n');
setGate(
  'G2',
  'JS-coupled classes intact',
  classSnapshot.filter((name) => !allFrontend.includes(name)),
  classSnapshot.length,
  '23 of these have no CSS rule anywhere, so only this gate catches their removal'
);

// ── G3: [hidden] guards never decrease ─────────────────────────────────────

let hiddenGuards = 0;
for (const file of STYLESHEETS) {
  hiddenGuards += (stripCssComments(readPublic(file)).match(/\[hidden\]/g) || []).length;
}
countGate('G3', '[hidden] guard rules across the four stylesheets', hiddenGuards, {
  direction: 'up', target: 12, phase: 'always',
  note: 'JS toggles visibility through the hidden property 264 times; any new display: rule needs a paired guard',
});

// ── G4: Catppuccin purged from chrome ──────────────────────────────────────

const paletteRe = new RegExp('var\\(\\s*--(?:' + PALETTE_TOKENS.join('|') + ')\\s*[,)]', 'g');
let paletteOutside = 0;
const paletteDetail = [];
for (const file of STYLESHEETS) {
  const css = stripCssComments(readPublic(file));
  // Palette blocks are the terminal's own theme definitions and are exempt.
  const themeBlocks = topLevelBlocks(css)
    .filter((b) => /\[data-theme="(?!dark")[a-z0-9-]+"\]/.test(b.prelude))
    .map((b) => ({ start: b.start, end: b.end }));
  const counted = countOutside(css, paletteRe, themeBlocks);
  paletteOutside += counted.outside;
  if (counted.outside) paletteDetail.push(file + ':' + counted.outside);
}
countGate('G4', 'Catppuccin var() consumption outside the palette blocks', paletteOutside, {
  direction: 'down', target: 0, phase: 'P4',
  note: paletteDetail.join(' '),
});

// ── G5: hex literals outside :root ─────────────────────────────────────────

const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
let hexOutside = 0;
const hexDetail = [];
for (const file of ['styles.css', 'styles-mobile.css', 'focused-shell.css']) {
  const css = stripCssComments(readPublic(file));
  const counted = countOutside(css, hexRe, rootBlockRanges(css));
  hexOutside += counted.outside;
  hexDetail.push(file + ': ' + counted.outside + '/' + counted.total);
}
countGate('G5a', 'hex literals outside a :root block', hexOutside, {
  direction: 'down', target: 0, phase: 'P4',
  note: hexDetail.join('  '),
});

// The Mocha bleed is written as rgba(), not as hex, so a hex-only gate misses
// 179 of the literal sites CURRENT-UI.md section 4 censuses. Masks are exempt:
// styles-mobile.css uses #000 inside mask-image gradients, where the value is
// an alpha channel rather than a colour.
const rgbaRe = /\b(?:rgba?|hsla?)\s*\(/g;
let rgbaOutside = 0;
const rgbaDetail = [];
for (const file of ['styles.css', 'styles-mobile.css', 'focused-shell.css']) {
  const css = stripCssComments(readPublic(file));
  const counted = countOutside(css, rgbaRe, rootBlockRanges(css));
  rgbaOutside += counted.outside;
  rgbaDetail.push(file + ': ' + counted.outside + '/' + counted.total);
}
countGate('G5b', 'rgba()/hsla() literals outside a :root block', rgbaOutside, {
  direction: 'down', target: 0, phase: 'P4',
  note: rgbaDetail.join('  '),
});

// ── G6: radius literals ────────────────────────────────────────────────────

const radiusLiterals = (stripCssComments(readPublic('styles.css'))
  .match(/border-radius:\s*[0-9]/g) || []).length;
countGate('G6', 'numeric border-radius literals in styles.css', radiusLiterals, {
  direction: 'down', target: 0, phase: 'P2',
  note: 'every radius becomes a token; chips 4px and cards 10px must measure differently',
});

// ── G7: uppercase labels ───────────────────────────────────────────────────

let uppercase = 0;
for (const file of STYLESHEETS) {
  uppercase += (stripCssComments(readPublic(file)).match(/text-transform:\s*uppercase/g) || []).length;
}
countGate('G7', 'text-transform: uppercase rules', uppercase, {
  direction: 'down', target: 1, phase: 'P4',
  note: 'exactly one survives, the Quick Find group header',
});

// ── G8: hover lifts ────────────────────────────────────────────────────────

const translateY = (stripCssComments(readPublic('styles.css')).match(/translateY/g) || []).length;
countGate('G8', 'translateY occurrences in styles.css', translateY, {
  direction: 'down', target: null, phase: 'P12 review',
  note: 'no hard target: every survivor must be a layout translate, never a hover lift, and justified in its commit',
});

// ── G9: gradients and glass ────────────────────────────────────────────────

const stylesNoComments = stripCssComments(readPublic('styles.css'));
countGate('G9a', 'linear-gradient in styles.css', (stylesNoComments.match(/linear-gradient/g) || []).length, {
  direction: 'down', target: 0, phase: 'P4', note: 'rejection list, one documented exception allowed',
});
countGate('G9b', 'backdrop-filter in styles.css', (stylesNoComments.match(/backdrop-filter/g) || []).length, {
  direction: 'down', target: 0, phase: 'P4', note: 'rejection list, one documented exception allowed',
});

// ── G10: cachebuster atomicity ─────────────────────────────────────────────

/**
 * Extract the cachebuster an asset is served with from index.html.
 *
 * @param {string} asset - Asset file name, for example "terminal.js".
 * @returns {string|null} The `?v=` value, or null when the asset is unversioned.
 */
function servedVersion(asset) {
  const re = new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?v=([A-Za-z0-9._-]+)');
  const m = re.exec(indexHtml);
  return m ? m[1] : null;
}

const headAssets = ['semantic-theme.css', 'focused-shell.css', 'theme-registry.js', 'experience-model.js'];
const headVersions = new Set(headAssets.map(servedVersion));
const cacheMismatches = [];
if (headVersions.size !== 1) {
  cacheMismatches.push('the four head assets disagree: ' + [...headVersions].join(', '));
}
const headVersion = headAssets.length ? servedVersion(headAssets[0]) : null;
const terminalVersion = servedVersion('terminal.js');
const appVersion = servedVersion('app.js');

const PINNED_TESTS = {
  'test/experience-ux-contract.test.js': [headVersion],
  'test/terminal-select-mode.test.js': [terminalVersion, appVersion],
  'test/copy-secure-context-fallback.test.js': [terminalVersion, appVersion],
};
for (const [file, expected] of Object.entries(PINNED_TESTS)) {
  const source = read(file);
  for (const version of expected) {
    if (version && !source.includes('?v=' + version)) {
      cacheMismatches.push(file + ' does not pin ?v=' + version);
    }
  }
}
setGate('G10', 'cachebusters agree across index.html and the three pinning tests',
  cacheMismatches, Object.keys(PINNED_TESTS).length + 1,
  'treat a bump as a five-file atomic change');

// The browser lane pins the same two assets and is already stale on unmodified
// source. Reported, never failed: see DECISIONS.md finding F1.
const browserLane = read('test/browser/workbook-shell.test.js');
const browserStale = [];
if (terminalVersion && browserLane && !browserLane.includes('terminal.js?v=' + terminalVersion)) {
  browserStale.push('terminal.js');
}
if (appVersion && browserLane && !browserLane.includes('app.js?v=' + appVersion)) {
  browserStale.push('app.js');
}
warnGate('G10b', 'test/browser/workbook-shell.test.js cachebuster pins', browserStale.length === 0,
  'stale pins for ' + browserStale.join(' and ') + ' (pre-existing, DECISIONS.md F1)');

// ── G11: semantic layer purity ─────────────────────────────────────────────

const semanticRaw = (stripCssComments(readPublic('semantic-theme.css'))
  .match(/#[0-9a-fA-F]{3,8}\b|rgba?\s*\(|hsla?\s*\(/g) || []).length;
countGate('G11', 'raw colours in semantic-theme.css', semanticRaw, {
  direction: 'down', target: 0, phase: 'always',
  note: 'experience-ux-contract.test.js pins this at zero; every right-hand side is a var() or a color-mix() over var()s',
});

// ── G12: em dashes and prose double hyphens ────────────────────────────────

/**
 * Walk a directory tree, yielding text-like file paths.
 *
 * @param {string} dir - Absolute directory.
 * @param {string[]} out - Accumulator.
 * @returns {string[]} Absolute file paths.
 */
function walkText(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkText(full, out);
    else if (!EM_DASH_SKIP_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/*
 * What counts as an em dash, P12 edition.
 *
 * The literal codepoints, U+2014 and U+2015, AND the HTML entity spellings of
 * the same two. P12 found four entity-encoded ones in app.js that had survived
 * every ratchet reading of this gate: they render a real em dash into the
 * Sessions cost column, so a gate that only read literals was reporting a
 * number the product disagreed with. Named, decimal and hex forms are all
 * covered, because a copy rule that only knows one spelling is a copy rule
 * somebody routes around by accident rather than by intent.
 *
 * The alternation is ASSEMBLED from pieces rather than written out, because
 * this file is itself inside a scanned tree: a literal entity in the source of
 * the gate would make the gate count itself and never reach zero. Same reason
 * the codepoints are \u escapes.
 */
const EM_DASH_ENTITY_NAMES = ['mdash', 'horbar'];
const EM_DASH_ENTITY_NUMS = ['8212', '8213', 'x2014', 'x2015'];
const EM_DASH_PATTERN = new RegExp(
  '[\\u2014\\u2015]|&(?:'
  + EM_DASH_ENTITY_NAMES.concat(EM_DASH_ENTITY_NUMS.map((n) => '#' + n)).join('|')
  + ');',
  'gi'
);

let emDashOccurrences = 0;
const emDashFiles = [];
for (const tree of EM_DASH_TREES) {
  for (const file of walkText(path.join(ROOT, tree), [])) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    const hits = text.match(EM_DASH_PATTERN);
    if (hits) {
      emDashOccurrences += hits.length;
      emDashFiles.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
}
// CLOSED IN P12. 149 em dashes across 31 files predated this program, mostly
// in code comments but including user-facing strings such as the schedules.js
// skip reason and the DESIGN-SPEC copy vocabulary. The gate spent nine phases
// as a RATCHET with no target, because cleaning inherited copy is the copy
// pass's job and not a restyle work package, and all it enforced was that the
// number could never grow.
//
// P12.4 is that copy pass. The count went 149 -> 113 -> 0: every occurrence in
// src, test, scripts and this program's own docs is gone, replaced by a comma,
// a colon or a semicolon according to what the sentence was actually doing.
// Code identifiers were exempt and none needed changing, because no identifier
// in this tree contains one.
//
// The target is now a HARD FLOOR of zero rather than a ratchet. A single em
// dash anywhere in the scanned trees fails the gate, which is the only form of
// this rule that cannot decay.
countGate('G12a', 'em dash and horizontal bar occurrences in the scanned trees', emDashOccurrences, {
  direction: 'down', target: 0, phase: 'always',
  note: emDashFiles.length
    ? emDashFiles.length + ' files, e.g. ' + emDashFiles.slice(0, 4).join(' ')
    : 'zero, and the floor is hard: see the note above this gate',
});

/**
 * Lines this program ADDED since the recorded baseline commit that carry an em
 * dash, a horizontal bar, or a double hyphen used as prose punctuation. This is
 * the contract's actual G12: "scan changed files ... 0".
 *
 * Aligned trailing comments (SQL and the like) carry more than one space before
 * the hyphens and are not flagged, and neither is a line that is itself a
 * comment opened with a double hyphen. The read-only captured bundle under
 * docs/design/notion-import/ is out of scope: it is someone else's text.
 *
 * @returns {string[]} Offending diff lines.
 */
function addedPunctuationViolations() {
  const base = baseline.baselineCommit;
  if (!base) return [];
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--unified=0', base + '..HEAD'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
  } catch (_) {
    // No git, a detached baseline, or a shallow clone. Report nothing rather
    // than failing the phase gate on an environment problem.
    return [];
  }
  // Built from a constructed string rather than written as a literal, for the
  // same reason the em-dash class uses escapes: a pattern that contains the
  // thing it forbids matches its own source line the moment this file is
  // committed, and a gate that can never reach zero is a gate people disable.
  const DOUBLE_HYPHEN = '-'.repeat(2);
  const prosePattern = new RegExp('(?<=\\S) ' + DOUBLE_HYPHEN + ' (?=\\S)');
  const commentOpener = new RegExp('^\\s*' + DOUBLE_HYPHEN);

  const hits = [];
  let currentFile = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (/^docs\/design\/notion-import\//.test(currentFile)) continue;
    if (/\.(sql|patch|diff)$/i.test(currentFile)) continue;
    const body = line.slice(1);
    if (/[\u2014\u2015]/.test(body)) {
      hits.push(currentFile + ' [em dash]: ' + body.trim().slice(0, 80));
      continue;
    }
    if (commentOpener.test(body)) continue;
    if (prosePattern.test(body)) hits.push(currentFile + ': ' + body.trim().slice(0, 80));
  }
  return hits;
}

const addedViolations = addedPunctuationViolations();
countGate('G12b', 'em dashes and prose double hyphens in lines added since the baseline commit', addedViolations.length, {
  direction: 'down', target: 0, phase: 'always',
  note: addedViolations.slice(0, 3).join(' | '),
});

// ── G13: the data-* attribute floor ────────────────────────────────────────

/**
 * Convert an attribute name to its dataset property name.
 *
 * @param {string} attr - Attribute form, for example "data-view-mode".
 * @returns {string} Dataset form, for example "viewMode".
 */
function datasetKey(attr) {
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

const missingDataKeys = DATA_ATTRIBUTE_FLOOR.filter((attr) => {
  if (allFrontend.includes(attr)) return false;
  const key = datasetKey(attr);
  return !new RegExp('dataset\\.' + key + '\\b|dataset\\[[\'"]' + key + '[\'"]\\]').test(allFrontend);
});
setGate('G13', 'data-* attribute contract intact (attribute or dataset form)',
  missingDataKeys, DATA_ATTRIBUTE_FLOOR.length,
  'beyond BUILD-CONTRACT 5.3; enforces rule 4 of section 0.4, which no listed gate covered');

// ── G14: status marks never animate ────────────────────────────────────────
//
// The standing design rule, recorded in DECISIONS.md 13.1: a blinking or
// pulsing dot in a status pill, a status badge, or standing alone as a status
// mark is banned. A state the system can SIT IN is drawn as a static shape;
// only a transient operation the user just started may move, and never as a
// dot.
//
// This gate is structural rather than a grep for one keyframe name, because
// the failure mode is not "someone re-adds mwPulse", it is "someone writes a
// new keyframe for a new dot". It therefore measures CONSUMPTION on
// status-mark surfaces, in three ways that catch three different mistakes:
//
//   1. by NAME    a rule whose selector names a dot, pill, badge or chip, or
//                 keys off one of the four status data-* attributes.
//   2. by SHAPE   a rule that draws a circle (the avatar or pill radius, or a
//                 literal 50%) and animates it, whatever it is called.
//   3. INLINE     a style="" attribute in the authored markup or in a
//                 renderer that does both at once, which no stylesheet scan
//                 would ever see. The three spinoff loading dots lived here.
//
// Declarations are deliberately NOT counted. Under code preservation the
// keyframes stay in the sheet; what is banned is a status mark reaching for
// one. `animation: none` is not consumption, so the reduced-motion guards that
// outlived their animations do not count either.

// Identifier tokens that make a selector a status-mark selector. Matched
// against the selector's own identifier segments, so `.drop-indicator` and
// `.terminal-pane-mic` never trip on a substring.
const STATUS_MARK_TOKENS = new Set([
  'dot', 'dots', 'badge', 'badges', 'pill', 'pills', 'chip', 'chips',
  'tristate', 'notify', 'liveness', 'status',
]);

// Attribute selectors that carry a status regardless of what the class is
// called. A rule keyed on any of these is describing a state.
const STATUS_MARK_ATTRS = [
  'data-tristate', 'data-live', 'data-needs-input', 'data-attention-state',
];

// Radii that draw a circle or a capsule. A mark with one of these plus an
// animation is a moving dot however it is named.
const CIRCLE_RADIUS = /border-radius:\s*(?:50%|var\(\s*--radius-(?:avatar|pill)\s*\))/;

const ANIMATION_DECL = /animation(?:-name)?\s*:\s*([^;}]+)/g;

// ROTATION IS THE ONE EXEMPT MOTION, and it is exempt by construction rather
// than by favour. A circle rotating about its own centre is INVISIBLE unless
// it is a partial arc, so a rotating mark is a spinner, and a spinner is an
// activity indicator for one operation the user just started. BUILD-CONTRACT
// 2.2 retains exactly that ("the button loader still spins where it was
// already used, for genuinely indeterminate operations"). A keyframe qualifies
// only when EVERY declaration in it is a transform and EVERY transform is a
// bare rotate(), so a keyframe that rotates and fades is still a blink.
const ROTATE_ONLY_DECL = /^\s*transform\s*:\s*rotate\([^()]*\)\s*$/;

/**
 * Collect keyframe names whose every step is a bare rotation.
 *
 * @param {string} css - Comment-free stylesheet text.
 * @param {Set<string>} into - Accumulating set of rotation-only names.
 * @returns {void}
 */
function collectRotationOnlyKeyframes(css, into) {
  const re = /@(?:-\w+-)?keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const body = css.slice(start, i - 1);
    const decls = body
      .replace(/[0-9.]+%|from|to/g, '')
      .split(/[{};]/)
      .map((d) => d.trim())
      .filter((d) => d.includes(':'));
    if (decls.length && decls.every((d) => ROTATE_ONLY_DECL.test(d))) into.add(m[1]);
  }
}

const rotationOnlyKeyframes = new Set();
for (const file of STYLESHEETS) {
  collectRotationOnlyKeyframes(stripCssComments(readPublic(file)), rotationOnlyKeyframes);
}

/**
 * Whether every keyframe name a declaration reaches for is a bare rotation.
 *
 * @param {string} block - Declaration text to inspect.
 * @returns {boolean} True when the block animates only rotations.
 */
function animatesOnlyRotation(block) {
  ANIMATION_DECL.lastIndex = 0;
  const names = new Set();
  let m;
  while ((m = ANIMATION_DECL.exec(block)) !== null) {
    for (const token of m[1].split(/[\s,]+/)) {
      if (rotationOnlyKeyframes.has(token)) names.add(token);
      else if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(token) &&
        !/^(none|infinite|alternate|reverse|forwards|backwards|both|normal|linear|ease|ease-in|ease-out|ease-in-out|running|paused|initial|inherit|unset|steps|var)$/.test(token) &&
        !token.startsWith('cubic-bezier')) {
        return false;
      }
    }
  }
  return names.size > 0;
}

/**
 * Whether a selector names a status mark.
 *
 * @param {string} selector - Full selector text, possibly a comma list.
 * @returns {boolean} True when any identifier segment is a status-mark token.
 */
function isStatusMarkSelector(selector) {
  const lower = selector.toLowerCase();
  if (STATUS_MARK_ATTRS.some((attr) => lower.includes(attr))) return true;
  return lower.split(/[^a-z0-9]+/).some((token) => STATUS_MARK_TOKENS.has(token));
}

/**
 * Whether a declaration block consumes an animation. `none` does not count:
 * a reduced-motion guard that outlived its animation is not a moving mark.
 *
 * @param {string} block - Declaration text between the braces.
 * @returns {boolean} True when at least one animation resolves to a real name.
 */
function consumesAnimation(block) {
  ANIMATION_DECL.lastIndex = 0;
  let m;
  while ((m = ANIMATION_DECL.exec(block)) !== null) {
    if (!/^\s*none\s*$/.test(m[1])) return true;
  }
  return false;
}

/**
 * Walk a stylesheet and yield every leaf rule with its full selector path and
 * its own declarations. Blocks under an `@keyframes` are skipped: a keyframe
 * step is a declaration of motion, not a consumption of it.
 *
 * @param {string} css - Comment-free stylesheet text.
 * @returns {Array<{selector: string, block: string, line: number}>} Leaf rules.
 */
function leafRules(css) {
  const out = [];
  const stack = [];
  let buf = '';
  let declStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push({ prelude: buf.trim().replace(/\s+/g, ' '), declStart: i + 1 });
      buf = '';
      declStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame) {
        const inKeyframes = stack.some((f) => /^@(-\w+-)?keyframes\b/.test(f.prelude)) ||
          /^@(-\w+-)?keyframes\b/.test(frame.prelude);
        if (!inKeyframes && !/^@/.test(frame.prelude)) {
          out.push({
            selector: frame.prelude,
            block: css.slice(frame.declStart, i),
            line: css.slice(0, i).split('\n').length,
          });
        }
      }
      buf = '';
      declStart = i + 1;
    } else {
      buf += ch;
    }
  }
  return out;
}

let movingMarks = 0;
const movingMarkDetail = [];
for (const file of STYLESHEETS) {
  const css = stripCssComments(readPublic(file));
  for (const rule of leafRules(css)) {
    if (!consumesAnimation(rule.block)) continue;
    if (animatesOnlyRotation(rule.block)) continue;
    const named = isStatusMarkSelector(rule.selector);
    const round = CIRCLE_RADIUS.test(rule.block);
    if (!named && !round) continue;
    movingMarks++;
    if (movingMarkDetail.length < 6) {
      movingMarkDetail.push(file + ':' + rule.line + ' ' + rule.selector.slice(0, 60));
    }
  }
}

// Inline styles that draw a circle and animate it in the same attribute.
const INLINE_STYLE = /style\s*=\s*"([^"]*)"/g;
for (const file of FRONTEND_SOURCES) {
  const source = readPublic(file);
  INLINE_STYLE.lastIndex = 0;
  let m;
  while ((m = INLINE_STYLE.exec(source)) !== null) {
    const decl = m[1];
    if (!consumesAnimation(decl)) continue;
    if (animatesOnlyRotation(decl)) continue;
    if (!CIRCLE_RADIUS.test(decl) && !isStatusMarkSelector(decl)) continue;
    movingMarks++;
    if (movingMarkDetail.length < 6) {
      movingMarkDetail.push(file + ' inline: ' + decl.slice(0, 60));
    }
  }
}

countGate('G14', 'animated status marks (dots, pills, badges, and any animated circle)', movingMarks, {
  direction: 'down', target: 0, phase: 'always',
  note: movingMarks
    ? movingMarkDetail.join(' | ')
    : 'DECISIONS 13.1: a status mark is a static shape; only transient operations may move, never as a dot',
});

// ── G15: one reference per asset, and every app asset is versioned ─────────
//
// Round 2. The user reported "the mobile view is still the old layout" after a
// deploy that had already landed, and the first hypothesis was a duplicate
// stylesheet link: one bare `styles-mobile.css` shadowing the busted one. That
// turned out to be a false positive (the extra matches were HTML COMMENTS that
// discuss the file by name), but the class of bug it describes is real and
// nothing in this repo was watching for it. Two rules, both structural:
//
//   1. NO DUPLICATES. Exactly one <link> or <script> per local asset path.
//      Two references to one file mean the second silently wins, and if they
//      carry different `?v=` values the browser holds two copies of the same
//      module and one of them is stale.
//   2. NO BARE APP ASSETS. Every local, first-party asset carries a `?v=`.
//      Without one, a deploy cannot evict it: the browser and any shared cache
//      keep serving the copy they already have, forever.
//
// Vendored third-party bundles are exempt, and deliberately so: they are
// pinned by their own directory and version, they change only when the vendor
// directory is replaced, and busting them on every app release would evict
// megabytes of unchanged xterm and icon payload from every client.
//
// The scan strips HTML comments FIRST, which is the whole reason the original
// report was a false alarm. A gate that reads commentary as markup is a gate
// that cries wolf.
const assetHtml = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
const assetRefs = [];
for (const m of assetHtml.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
  if (/rel="stylesheet"/.test(m[0])) assetRefs.push(m[1]);
}
for (const m of assetHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
  assetRefs.push(m[1]);
}
// Local means "served out of this tree": not absolute, not protocol relative.
const localRefs = assetRefs.filter((href) => !/^(https?:)?\/\//i.test(href));
const VENDOR_EXEMPT = /^vendor\//;

const seenRefs = new Map();
const assetProblems = [];
for (const href of localRefs) {
  const base = href.split('?')[0];
  seenRefs.set(base, (seenRefs.get(base) || 0) + 1);
}
for (const [base, count] of seenRefs) {
  if (count > 1) assetProblems.push(base + ' referenced ' + count + ' times');
}
for (const href of localRefs) {
  const base = href.split('?')[0];
  if (VENDOR_EXEMPT.test(base)) continue;
  if (!/\?v=[A-Za-z0-9._-]+$/.test(href)) assetProblems.push(base + ' has no ?v= cachebuster');
}
setGate('G15', 'index.html references each app asset once, and versions all of them',
  assetProblems, localRefs.length,
  'a duplicate or unbusted reference is how a deploy fails to reach a phone');

// ── G16: a status mark never sits inside a capsule ─────────────────────────
//
// The other half of the standing rule G14 enforces. G14 says a status mark may
// not MOVE. G16 says it may not be INSIDE A PILL. The user's wording of
// 2026-08-13 is that the status pill containing a dot indicator is banned in
// any form, blinking, pulsing OR static, because the pill-plus-dot pattern is
// itself the generic tell; status is to be carried by typography, by colour,
// and by marks OUTSIDE pill capsules. G14 could not see this: a static dot in
// a static pill animates nothing and passes it cleanly, which is exactly what
// `.status-badge` and `.stat-chip` did until DECISIONS 13.6.
//
// It is modelled on G14 and structural for the same reason. A grep for
// `nt-chip-dot` protects against the one mistake nobody will make. The mistake
// that will actually happen is a new pill, with a new class name, six months
// from now, by somebody who never read section 13. So the gate reconstructs
// what the browser would compute and asks a shape question about it:
//
//   1. Which classes are drawn as a CAPSULE. A rule whose border-radius
//      resolves, through the --radius-* token chain, to 9px or more or to a
//      literal 50 or 100 percent. Nine is the threshold because this app's own
//      scale puts every property chip at 4px and every capsule at 10px or
//      999px, so the gap is wide and nothing legitimate sits in it.
//   2. Which classes carry a FILL. A background or a border with a real value.
//      `transparent`, `none` and `0` do not count, which is what lets the
//      de-capsuled rules keep an explicit `background: transparent` as a
//      statement of intent instead of having to delete the declaration.
//   3. Whether the element is INLINE-LEVEL. Without this the gate would fail
//      every card in the app: `.mobile-session-card` is a 10px bordered box
//      with a leading `.status-dot`, and a mark on a card is precisely the
//      idiom the rule asks FOR. A capsule is a small inline thing; a card is
//      not, and `display` is where the two separate.
//
// The three conditions are evaluated across the element's WHOLE class list
// rather than per rule, because that is how the cascade works and because this
// app splits them on purpose: `.status-badge` carried the radius and
// `.status-badge-running` carried the fill, so a per-rule gate would have seen
// two innocent halves and missed the capsule they compose into.
//
// A DOT CHILD is a class with an identifier segment of `dot` or `dots`, or an
// EMPTY element whose class is drawn as a circle. The emptiness test is what
// keeps `.account-chip-avatar` out of the count: it is a circle inside a pill,
// and it holds an initial, so it is an avatar and not an indicator.
//
// The runtime half of this ban lives in scripts/media/capture.js, which asks
// the same question of the real computed styles in a real page before every
// media take. This gate reads source; that one reads pixels; a pattern has to
// clear both.

/** Radii at or above this many pixels read as a capsule rather than a corner. */
const CAPSULE_RADIUS_PX = 9;

/** Tags that are inline-level by default, so a capsule can be built from them. */
const INLINE_TAGS = new Set(['span', 'a', 'small', 'em', 'strong', 'b', 'i', 'label', 'button']);

/** Tags that never have a closing tag, so they never open a stack frame. */
const VOID_TAGS = new Set([
  'br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'track', 'wbr', 'col', 'area', 'base', 'embed',
]);

/** Class-name segments that declare an element a capsule by name alone. */
const CAPSULE_NAME = /(?:^|-)(?:chip|pill|badge|tag|capsule)$/;

/** Class-name segments that declare an element a status dot. */
const DOT_NAME = /(?:^|-)(?:dot|dots)$/;

/**
 * Every --radius-* custom property declared anywhere in the four stylesheets.
 *
 * First declaration wins, which matches the cascade for the :root block that
 * defines the scale; the per-theme blocks below it never redefine a radius.
 *
 * @returns {Map<string, string>} Token name to its raw declared value.
 */
function collectRadiusTokens() {
  const tokens = new Map();
  for (const file of STYLESHEETS) {
    const css = stripCssComments(readPublic(file));
    for (const m of css.matchAll(/(--radius-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
      if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
    }
  }
  return tokens;
}

const RADIUS_TOKENS = collectRadiusTokens();

/**
 * Substitute --radius-* references until the value is literal.
 *
 * @param {string} value - A border-radius value, possibly a var() chain.
 * @param {number} [depth] - Recursion guard.
 * @returns {string} The value with every known radius token expanded.
 */
function resolveRadius(value, depth) {
  const level = depth || 0;
  if (level > 6) return value;
  return value.replace(/var\(\s*(--radius-[a-z0-9-]+)\s*(?:,[^()]*)?\)/g, (all, name) =>
    (RADIUS_TOKENS.has(name) ? resolveRadius(RADIUS_TOKENS.get(name), level + 1) : all));
}

/**
 * Whether a border-radius value draws a capsule or a circle.
 *
 * @param {string} raw - The declared value.
 * @returns {boolean} True when it rounds to a pill or a circle.
 */
function isCapsuleRadius(raw) {
  const resolved = resolveRadius(raw);
  if (/\b(?:50|100)%/.test(resolved)) return true;
  for (const m of resolved.matchAll(/(\d+(?:\.\d+)?)px/g)) {
    if (parseFloat(m[1]) >= CAPSULE_RADIUS_PX) return true;
  }
  return false;
}

/**
 * Whether a border-radius value draws a full circle specifically.
 *
 * @param {string} raw - The declared value.
 * @returns {boolean} True for 50 or 100 percent.
 */
function isCircleRadius(raw) {
  return /\b(?:50|100)%/.test(resolveRadius(raw));
}

/**
 * The classes a selector actually applies to: the last compound in each
 * comma-separated branch, because that is the subject of the rule.
 *
 * @param {string} selector - Full selector text.
 * @returns {Set<string>} Class names the rule styles.
 */
function subjectClasses(selector) {
  const out = new Set();
  for (const branch of selector.split(',')) {
    const compounds = branch.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    const subject = compounds[compounds.length - 1];
    if (!subject) continue;
    for (const m of subject.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(m[1]);
  }
  return out;
}

const capsuleRadiusClasses = new Set();
const circleClasses = new Set();
const filledClasses = new Set();
const inlineClasses = new Set();
const blockClasses = new Set();
for (const file of STYLESHEETS) {
  const css = stripCssComments(readPublic(file));
  for (const rule of leafRules(css)) {
    const classes = subjectClasses(rule.selector);
    if (!classes.size) continue;
    const radius = /border-radius\s*:\s*([^;}]+)/.exec(rule.block);
    if (radius && isCapsuleRadius(radius[1])) for (const c of classes) capsuleRadiusClasses.add(c);
    if (radius && isCircleRadius(radius[1])) for (const c of classes) circleClasses.add(c);
    const background = /(?:^|[;\s])background(?:-color|-image)?\s*:\s*([^;}]+)/.exec(rule.block);
    const border = /(?:^|[;\s])border(?:-color|-width|-style)?\s*:\s*([^;}]+)/.exec(rule.block);
    const realBackground = background &&
      !/^\s*(?:none|transparent|inherit|initial|unset|revert)\s*$/.test(background[1]);
    const realBorder = border && !/^\s*(?:none|0|inherit|initial|unset|revert)\b/.test(border[1]);
    if (realBackground || realBorder) for (const c of classes) filledClasses.add(c);
    const display = /(?:^|[;\s])display\s*:\s*([^;}]+)/.exec(rule.block);
    if (display && /^\s*inline/.test(display[1])) for (const c of classes) inlineClasses.add(c);
    if (display && /^\s*(?:block|flex|grid|table|list-item)/.test(display[1])) {
      for (const c of classes) blockClasses.add(c);
    }
  }
}

/**
 * Read an element's class list out of a raw attribute string, dropping any
 * template interpolation so a generated `status-badge-${key}` still yields the
 * literal half of the name.
 *
 * @param {string} attrs - Everything between the tag name and the closing angle.
 * @returns {string[]} Class tokens.
 */
function classListOf(attrs) {
  const m = /\bclass\s*=\s*"([^"]*)"/.exec(attrs) || /\bclass\s*=\s*'([^']*)'/.exec(attrs);
  if (!m) return [];
  return m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Whether any of an element's class tokens is in a set, treating a token that
 * ends in a hyphen as a PREFIX.
 *
 * This is what makes the gate see a capsule that is composed at runtime.
 * `statusChipHtml` emits `class="status-badge status-badge-${key}"`, so after
 * the interpolation is stripped the second token is the bare stem
 * `status-badge-`. The radius lived on `.status-badge` and the fill lived on
 * `.status-badge-running`, and a gate that compared whole tokens saw a rounded
 * element with no fill and a filled element that never appears in the markup:
 * two innocent halves, and the capsule they compose into invisible between
 * them. Measured, not theorised: the first cut of this gate returned 0 on the
 * pre-sweep tree.
 *
 * @param {string[]} classes - The element's class tokens.
 * @param {Set<string>} set - A class set collected from the stylesheets.
 * @returns {boolean} True when any token matches, exactly or by stem.
 */
function hasClassIn(classes, set) {
  for (const token of classes) {
    if (set.has(token)) return true;
    if (token.length > 1 && token.endsWith('-')) {
      for (const known of set) if (known.startsWith(token)) return true;
    }
  }
  return false;
}

/**
 * Whether an element is drawn as a capsule: a pill radius, a real fill, and an
 * inline-level box.
 *
 * @param {string} tag - Lower-cased tag name.
 * @param {string[]} classes - The element's class tokens.
 * @param {string} attrs - The raw attribute string, for inline styles.
 * @returns {boolean} True when the element is a capsule.
 */
function isCapsuleElement(tag, classes, attrs) {
  const inline = /\bstyle\s*=\s*"([^"]*)"/.exec(attrs);
  const inlineRadius = inline && /border-radius\s*:\s*([^;"]+)/.exec(inline[1]);
  const inlineFilled = inline && /background(?:-color)?\s*:\s*(?!\s*(?:none|transparent)\s*[;"])/.test(inline[1]);
  if (inlineRadius && isCapsuleRadius(inlineRadius[1]) && inlineFilled) return true;
  if (!classes.length) return false;
  if (!hasClassIn(classes, capsuleRadiusClasses)) return false;
  if (!hasClassIn(classes, filledClasses)) return false;
  if (hasClassIn(classes, inlineClasses)) return true;
  if (classes.some((c) => CAPSULE_NAME.test(c))) return true;
  return INLINE_TAGS.has(tag) && !hasClassIn(classes, blockClasses);
}

/**
 * Whether an element is a status dot: named as one, or an empty circle.
 *
 * @param {string[]} classes - The element's class tokens.
 * @param {boolean} isEmpty - Whether the element closes immediately.
 * @returns {boolean} True when the element reads as a dot indicator.
 */
function isDotElement(classes, isEmpty) {
  if (classes.some((c) => DOT_NAME.test(c))) return true;
  return isEmpty && hasClassIn(classes, circleClasses);
}

let capsuleDots = 0;
const capsuleDotDetail = [];
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>/g;
for (const file of FRONTEND_SOURCES) {
  const source = readPublic(file);
  if (!source) continue;
  const stack = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(source)) !== null) {
    const tag = m[2].toLowerCase();
    if (m[1] === '/') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = m[3];
    const classes = classListOf(attrs);
    const selfClosing = m[4] === '/' || VOID_TAGS.has(tag);
    const closesImmediately = /^\s*<\//.test(source.slice(m.index + m[0].length));
    if (isDotElement(classes, selfClosing || closesImmediately)) {
      const owner = stack.slice().reverse().find((frame) => frame.capsule);
      if (owner) {
        capsuleDots++;
        if (capsuleDotDetail.length < 6) {
          capsuleDotDetail.push(
            file + ':' + source.slice(0, m.index).split('\n').length + ' .' +
            classes.join('.') + ' inside .' + owner.classes.join('.')
          );
        }
      }
    }
    if (!selfClosing) stack.push({ tag, classes, capsule: isCapsuleElement(tag, classes, attrs) });
  }
}

countGate('G16', 'status dots enclosed by a capsule (pill radius plus a fill)', capsuleDots, {
  direction: 'down', target: 0, phase: 'always',
  note: capsuleDots
    ? capsuleDotDetail.join(' | ')
    : 'DECISIONS 13.6: status is carried by a mark OUTSIDE a capsule, never by a pill with a dot in it',
});

// ── Report ─────────────────────────────────────────────────────────────────

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

if (RECORD) {
  const next = {
    _comment: 'Recorded baselines for scripts/do-not-break-gates.js. Ratcheted DOWN by the phase ' +
      'that improves a number, never up to make a red gate green. Regenerate with --record only as ' +
      'a deliberate re-baselining act, and say so in the commit message.',
    recordedAt: new Date().toISOString().slice(0, 10),
    baselineCommit: baseline.baselineCommit || null,
    suite: baseline.suite || null,
    gates: {},
  };
  for (const r of results) {
    if (r.direction === 'set' || r.direction === 'warn') continue;
    next.gates[r.id] = {
      name: r.name, baseline: r.measured, target: r.target, phase: r.phase,
    };
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('RECORDED ' + path.relative(ROOT, BASELINE_PATH) + ' from the current tree.');
}

if (JSON_OUT) {
  console.log(JSON.stringify({ strict: STRICT, results }, null, 2));
} else {
  console.log('\n  DO-NOT-BREAK gates' + (STRICT ? ' (strict: phase targets are hard failures)' : '') );
  console.log('  ' + '-'.repeat(74));
  for (const r of results) {
    const colour = r.status === 'PASS' ? GREEN : (r.status === 'FAIL' ? RED : YELLOW);
    const numbers = r.direction === 'set'
      ? r.measured + '/' + r.baseline + ' present'
      : 'measured ' + r.measured + '  baseline ' + (r.baseline === null ? 'n/a' : r.baseline) +
        '  target ' + (r.target === null ? 'review' : r.target) + ' (' + r.phase + ')';
    console.log('  ' + colour + r.status.padEnd(6) + RESET + r.id.padEnd(5) + r.name);
    console.log('         ' + DIM + numbers + RESET);
    if (r.detail) console.log('         ' + colour + r.detail + RESET);
    if (r.note) console.log('         ' + DIM + r.note + RESET);
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  const todo = results.filter((r) => r.status === 'TODO');
  console.log('  ' + '-'.repeat(74));
  console.log('  ' + (results.length - failed.length) + '/' + results.length + ' gates pass' +
    (todo.length ? ', ' + todo.length + ' still short of a later phase target' : '') +
    (failed.length ? ', ' + RED + failed.length + ' FAILED' + RESET : ''));
}

process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
