#!/usr/bin/env node
/**
 * Usage meter (feat/usage-meter): per-model usage bars for the Claude
 * account switcher.
 *
 * Source-scan + extracted-logic gate, mirroring the harvesting approach of
 * test/idle-signal-dispatch.test.js and the markup gates like
 * test/pane-context-menu.test.js. No jsdom, no browser: markup and wiring
 * are asserted against the shipped sources, and the two pure helpers
 * (_accountModelWindow, _usageFillClass) are brace-extracted from app.js
 * and executed against fixtures so their logic is tested for real, not
 * just for existence.
 *
 * What this locks down:
 *   1. The header meter mount (#usage-meter) and the bottom-sheet mirror
 *      (#account-panel-meter) exist in index.html.
 *   2. app.js defines renderUsageMeter/_usageMeterBarsHtml/
 *      _usageMeterRowHtml/_accountModelWindow/_usageFillClass and calls
 *      renderUsageMeter from renderAccountSwitcher (the single render path
 *      shared by load, refresh-usage, switch, and both SSE broadcasts).
 *   3. Per-model reset rendering is ABSOLUTE local time everywhere: the
 *      meter rows pass absolute=true into _formatResetText and stamp
 *      data-absolute="1", and the panel's Opus/Fable rows render with
 *      absolute=true. The per-model data is WEEKLY scoped upstream, so a
 *      relative countdown would read as an hourly window; absolute local
 *      time is the honest rendering (and what Arthur asked for).
 *   4. _accountModelWindow prefers weekly_scoped limits matched by
 *      row.model (case-insensitive), falls back to seven_day_<model>, and
 *      degrades to null on malformed input.
 *   5. The meter CSS uses semantic theme tokens only (no hardcoded hex in
 *      the meter block) and the mobile sheet mirror is media-scoped.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const MOBILE_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles-mobile.css'), 'utf8');
const CRED_MANAGER = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'credential-manager.js'), 'utf8');

let passed = 0;
let failed = 0;

/**
 * Minimal check harness: runs fn, records pass/fail, prints result.
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (throws to fail).
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + ((err && err.message) || err));
  }
}

/** Assert a condition. @param {*} cond @param {string} msg */
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

/**
 * Brace-extract one method body from the CWMApp class source by name.
 * Finds `  <name>(` and scans forward matching braces, so the returned
 * text is the full method (shorthand form) ready to drop into an object
 * literal. Throws when the method is missing (that IS the test).
 * @param {string} name - Method name to extract.
 * @returns {string} The method source, shorthand form.
 */
function extractMethod(name) {
  const startIdx = APP_JS.search(new RegExp('^  ' + name + '\\(', 'm'));
  assert(startIdx !== -1, 'method ' + name + ' not found in app.js');
  const openIdx = APP_JS.indexOf('{', startIdx);
  let depth = 0;
  for (let i = openIdx; i < APP_JS.length; i++) {
    const ch = APP_JS[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return APP_JS.slice(startIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

/**
 * Read a `static NAME = <number>;` class constant out of the app.js source
 * so the extracted _usageFillClass runs against the SHIPPED thresholds
 * (drift in the constants is then exercised, not masked by test copies).
 * @param {string} name - Constant name.
 * @returns {number} The constant's numeric value.
 */
function readStaticNumber(name) {
  const m = APP_JS.match(new RegExp('static ' + name + ' = (\\d+);'));
  assert(m, 'static ' + name + ' not found in app.js');
  return Number(m[1]);
}

console.log('\n  Usage meter: per-model bars, mapper wiring, absolute local resets');
console.log('  ' + '-'.repeat(66));

// ─── 1. Markup mounts ────────────────────────────────────────────────────

check('index.html mounts the header meter (#usage-meter + #usage-meter-bars) hidden by default', () => {
  assert(/id="usage-meter"[^>]*hidden|hidden[^>]*id="usage-meter"|<div class="usage-meter" id="usage-meter" hidden>/.test(INDEX_HTML),
    '#usage-meter mount with hidden attribute missing');
  assert(INDEX_HTML.includes('id="usage-meter-bars"'), '#usage-meter-bars missing');
});

check('index.html mounts the bottom-sheet mirror (#account-panel-meter) inside the account panel', () => {
  assert(INDEX_HTML.includes('id="account-panel-meter"'), '#account-panel-meter missing');
  const panelIdx = INDEX_HTML.indexOf('id="account-panel"');
  const meterIdx = INDEX_HTML.indexOf('id="account-panel-meter"');
  const listIdx = INDEX_HTML.indexOf('id="account-panel-list"');
  assert(panelIdx !== -1 && meterIdx > panelIdx && listIdx > meterIdx,
    'sheet mirror must sit inside the panel, above the row list');
});

// ─── 2. app.js wiring ────────────────────────────────────────────────────

check('app.js defines the meter surface (renderUsageMeter and its builders)', () => {
  for (const fn of ['renderUsageMeter()', '_usageMeterBarsHtml(p)', '_usageMeterRowHtml(keyLabel, u, titleText)', '_accountModelWindow(p, modelName)', '_usageFillClass(pct)']) {
    assert(APP_JS.includes(fn), 'missing ' + fn);
  }
});

check('renderAccountSwitcher calls renderUsageMeter (shared render path: load, refresh, switch, SSE)', () => {
  const start = APP_JS.indexOf('renderAccountSwitcher() {');
  assert(start !== -1, 'renderAccountSwitcher not found');
  const body = APP_JS.slice(start, APP_JS.indexOf('renderAccountRow(p) {'));
  assert(body.includes('this.renderUsageMeter()'), 'renderAccountSwitcher must repaint the meter');
});

check('els registry exposes the meter mounts to renderUsageMeter', () => {
  assert(APP_JS.includes("usageMeter: document.getElementById('usage-meter')"), 'els.usageMeter missing');
  assert(APP_JS.includes("usageMeterBars: document.getElementById('usage-meter-bars')"), 'els.usageMeterBars missing');
  assert(APP_JS.includes("accountPanelMeter: document.getElementById('account-panel-meter')"), 'els.accountPanelMeter missing');
});

check('the 60s countdown tick covers the meter mounts, not just the switcher subtree', () => {
  const start = APP_JS.indexOf('_tickAccountCountdowns() {');
  assert(start !== -1, '_tickAccountCountdowns not found');
  const body = APP_JS.slice(start, start + 900);
  assert(body.includes('usageMeter') && body.includes('accountPanelMeter'),
    'tick must include the meter scopes so Resetting... rollovers repaint');
});

// ─── 3. Absolute local reset rendering ───────────────────────────────────

check('meter rows render the EXACT local reset (absolute _formatResetText + data-absolute)', () => {
  const row = extractMethod('_usageMeterRowHtml');
  assert(row.includes('_formatResetText(u.resets_at, true)'),
    'meter rows must format resets with absolute=true (exact local time)');
  assert(row.includes('data-absolute="1"'), 'meter reset spans must be tick-absolute');
  assert(row.includes('data-reset-at='), 'meter reset spans must carry data-reset-at for the tick');
});

check('panel per-model rows (Opus/Fable) render with absolute=true and weekly-labelled tooltips', () => {
  assert(/_accountUsageRowHtml\('Opus', opusWin, true, 'Opus weekly usage'\)/.test(APP_JS),
    'Opus panel row must be absolute + weekly-labelled');
  assert(/_accountUsageRowHtml\('Fable', fableWin, true, 'Fable weekly usage'\)/.test(APP_JS),
    'Fable panel row must be absolute + weekly-labelled');
});

check('meter bars never mislabel weekly data as hourly (session vs weekly tooltip copy)', () => {
  const bars = extractMethod('_usageMeterBarsHtml');
  assert(bars.includes("'Session (5h) usage'"), 'session bar tooltip must name the 5h window');
  assert(bars.includes("'Opus weekly usage'") && bars.includes("'Fable weekly usage'"),
    'per-model bar tooltips must say weekly');
});

// ─── 4. Extracted-logic tests: _accountModelWindow ───────────────────────

const accountModelWindow = (() => {
  const src = extractMethod('_accountModelWindow');
  // Shorthand method dropped into an object literal; no `this` inside.
  return new Function('"use strict"; const o = { ' + src + ' }; return o._accountModelWindow;')();
})();

check('_accountModelWindow: weekly_scoped limit match is case-insensitive and maps percent to utilization', () => {
  const p = { usage: { limits: [
    { kind: 'weekly_scoped', model: 'Fable', percent: 38, resets_at: '2026-07-08T07:00:00+00:00' },
  ] } };
  const w = accountModelWindow(p, 'fable');
  assert(w && w.utilization === 38, 'percent must map to utilization');
  assert(w.resets_at === '2026-07-08T07:00:00+00:00', 'resets_at carried through');
});

check('_accountModelWindow: non-weekly_scoped rows never match (no mislabelled windows)', () => {
  const p = { usage: { limits: [
    { kind: 'session', model: 'Opus', percent: 90, resets_at: '2026-07-02T21:00:00+00:00' },
  ] } };
  assert(accountModelWindow(p, 'Opus') === null, 'a session-scoped row must not surface as a weekly bar');
});

check('_accountModelWindow: falls back to top-level seven_day_opus when limits carry no model', () => {
  const p = { usage: {
    limits: [{ kind: 'weekly_all', percent: 61 }],
    seven_day_opus: { utilization: 12, resets_at: '2026-07-08T07:00:00+00:00' },
  } };
  const w = accountModelWindow(p, 'Opus');
  assert(w && w.utilization === 12, 'seven_day_opus fallback must apply');
});

check('_accountModelWindow: null-tolerant on malformed input (no usage, junk limits, missing fields)', () => {
  assert(accountModelWindow(null, 'Opus') === null, 'null profile');
  assert(accountModelWindow({}, 'Opus') === null, 'no usage');
  assert(accountModelWindow({ usage: {} }, 'Opus') === null, 'empty usage');
  assert(accountModelWindow({ usage: { limits: [null, 42, {}, { kind: 'weekly_scoped', model: 7 }] } }, 'Opus') === null,
    'junk limit rows must not throw or match');
  assert(accountModelWindow({ usage: { limits: [] } }, '') === null, 'empty model name');
});

// ─── 5. Extracted-logic tests: _usageFillClass thresholds ────────────────

const usageFillClass = (() => {
  const src = extractMethod('_usageFillClass');
  const MID = readStaticNumber('USAGE_PCT_MID');
  const HIGH = readStaticNumber('USAGE_PCT_HIGH');
  const fn = new Function('CWMApp', '"use strict"; const o = { ' + src + ' }; return o._usageFillClass;')(
    { USAGE_PCT_MID: MID, USAGE_PCT_HIGH: HIGH }
  );
  return { fn, MID, HIGH };
})();

check('_usageFillClass: shipped thresholds render green/amber/red exactly at the design 6.3 boundaries', () => {
  const { fn, MID, HIGH } = usageFillClass;
  assert(fn(0) === 'u-low' && fn(MID - 1) === 'u-low', 'below MID is green');
  assert(fn(MID) === 'u-mid' && fn(HIGH) === 'u-mid', 'MID..HIGH inclusive is amber');
  assert(fn(HIGH + 1) === 'u-high' && fn(100) === 'u-high', 'above HIGH is red');
});

// ─── 6. Backend mapper wiring (the fix that unblocks all of the above) ───

check('credential-manager mapper extracts scope.model.display_name onto row.model', () => {
  assert(CRED_MANAGER.includes("typeof l.scope.model.display_name === 'string'"),
    'object-scope display_name guard missing');
  assert(CRED_MANAGER.includes('row.model = l.scope.model.display_name;'),
    'row.model assignment missing');
  assert(CRED_MANAGER.includes("if (typeof l.scope === 'string')"),
    'string-scope fallback must remain');
});

check('credential-manager mapper captures top-level seven_day_opus / seven_day_sonnet windows', () => {
  assert(CRED_MANAGER.includes('pickWindow(raw.seven_day_opus)'), 'seven_day_opus capture missing');
  assert(CRED_MANAGER.includes('pickWindow(raw.seven_day_sonnet)'), 'seven_day_sonnet capture missing');
});

// ─── 7. CSS: semantic tokens only, mobile mirror media-scoped ────────────

// Sanctioned test edit SE-6 (BUILD-CONTRACT.md 5.4), spent in phase P3, work
// package P3.3, in the same commit as its source change. Token names only; the
// three rules are still matched as whitespace-exact single lines.
// Notion restyle: meter thresholds use the named block palette.
check('meter CSS uses semantic theme tokens for fills (all 13 themes, light included)', () => {
  assert(STYLES_CSS.includes('.usage-meter-fill.u-low { background: var(--app-text-green); }'), 'u-low token fill');
  assert(STYLES_CSS.includes('.usage-meter-fill.u-mid { background: var(--app-text-yellow); }'), 'u-mid token fill');
  assert(STYLES_CSS.includes('.usage-meter-fill.u-high { background: var(--app-text-red); }'), 'u-high token fill');
});

check('meter CSS block contains no hardcoded hex colors', () => {
  const start = STYLES_CSS.indexOf('.usage-meter {');
  assert(start !== -1, '.usage-meter block missing from styles.css');
  const end = STYLES_CSS.indexOf('.account-panel-meter {', start);
  assert(end > start, '.account-panel-meter base rule must follow the meter block');
  const block = STYLES_CSS.slice(start, end);
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'meter block must not hardcode colors: ' + (block.match(/#[0-9a-fA-F]{3,8}\b/) || [''])[0]);
});

check('sheet mirror hidden on desktop, revealed inside the phone media query', () => {
  assert(/\.account-panel-meter \{\s*display: none;\s*\}/.test(STYLES_CSS),
    'desktop base rule must hide the sheet mirror');
  const mediaIdx = MOBILE_CSS.indexOf('.account-panel-meter:not([hidden])');
  assert(mediaIdx !== -1, 'mobile reveal selector missing');
  // The reveal must live inside a (max-width: 768px) block: find the
  // nearest preceding @media and confirm its condition.
  const before = MOBILE_CSS.slice(0, mediaIdx);
  const lastMedia = before.lastIndexOf('@media');
  assert(lastMedia !== -1 && /max-width:\s*768px/.test(MOBILE_CSS.slice(lastMedia, lastMedia + 60)),
    'mobile reveal must be scoped to max-width: 768px');
});

check('meter transitions respect prefers-reduced-motion', () => {
  // Whitespace-tolerant (the stylesheet may carry CRLF endings on Windows).
  assert(/\.usage-meter-fill \{\s*transition: none;\s*\}/.test(STYLES_CSS),
    'reduced-motion override for .usage-meter-fill missing');
});

// ─── Results ─────────────────────────────────────────────────────────────

console.log('\n  ' + '-'.repeat(66));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
