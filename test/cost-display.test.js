#!/usr/bin/env node
/**
 * Plan 18-04 gate: cost disclosure surfaces.
 *
 * Asserts the four cost-rendering branches added in Phase 18-04:
 *
 *   1. renderSessionItem's cost-badge block branches on the session's
 *      provider through _getProviderById; cost-supporting providers
 *      render the $X.XX badge, cost-unsupported providers render the
 *      em-dash badge with the "Cost not tracked for this provider"
 *      tooltip.
 *
 *   2. renderCostsDashboard's summary cards append "(Claude only)" to
 *      the Total Cost and Period card labels when any enabled provider
 *      reports supportsCost === false.
 *
 *   3. renderCostsDashboard's session table renders `<td>&ndash;</td>`
 *      (with a tooltip and data-provider on the row) for sessions whose
 *      provider lacks cost support.
 *
 *   4. _patchCostBadges leaves an existing .session-badge-cost-na badge
 *      untouched so a stale cost-batch response cannot overwrite the
 *      em-dash disclosure with a misleading dollar amount.
 *
 * The frontend has no module export and instantiating CWMApp would
 * require jsdom + xterm.js + WebSocket mocks. Following the Plan 18-01
 * convention (test/data-provider-attr.test.js), this gate reads the
 * source text and asserts the render-branch shape with regexes that
 * are tight enough to fail on a template-shape regression while loose
 * enough to tolerate whitespace / comment changes.
 *
 * Requirements covered: COST-02, COST-03 (the cost-display half).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const src = fs.readFileSync(APP_JS_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run a single named assertion and tally pass/fail so failures are visible
 * but do not abort the suite on the first miss.
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

console.log('\n  \x1b[1mPlan 18-04: cost-display disclosure\x1b[0m');
console.log('  ' + '─'.repeat(42));

// ─── Test 1: renderSessionItem renders $X.XX for cost-supporting providers ───
check('renderSessionItem keeps the existing $X.XX badge on the cost-supporting branch', () => {
  // The supportsCost-true branch retains the original Number(cachedCost).toFixed(2)
  // template; assert the dollar-amount template literal still exists.
  assert.ok(
    /session-badge-cost"\s*>\$\$\{Number\(cachedCost\)\.toFixed\(2\)\}/.test(src),
    'renderSessionItem must still emit the $X.XX badge for cost-supporting providers'
  );
});

// ─── Test 2: renderSessionItem renders em-dash for cost-unsupported providers ───
check('renderSessionItem emits .session-badge-cost-na with the tooltip on the supportsCost=false branch', () => {
  /* RETARGETED IN P12 (sanctioned edit SE-19). This pin was character-for-
     character on an EM dash entity, and BUILD-CONTRACT, DO-NOT-BREAK and
     TEST-CONSTRAINTS all copied that spelling into their own tables. It was
     the last user-facing em dash in the product: gate G12a only read literal
     codepoints, so four entity-encoded ones rendered a real em dash into the
     Sessions cost column while the gate reported zero. G12a now matches the
     named, decimal and hex entity forms as well, and this column takes an EN
     dash, which is the correct mark for an empty numeric cell anyway. The pin
     is as strict as it ever was; only the codepoint moved. */
  // The not-applicable branch must carry the tooltip text and the &ndash; entity
  // (rendering as the cost-not-tracked disclosure). One match is enough;
  // a future refactor that drops it will fail this check.
  assert.ok(
    /session-badge-cost-na"\s+title="Cost not tracked for this provider"\s*>&ndash;</.test(src),
    'renderSessionItem must emit the em-dash badge with the cost-not-tracked tooltip'
  );
});

// ─── Test 3: the em-dash branch never produces a $0.00 string ───
check('renderSessionItem branch for unsupported providers does NOT fall through to a $-value', () => {
  // Find the entire cost-rendering region (between the comment marker we
  // added and the next badge construction). Inside that region, assert
  // the em-dash branch is reached via the supportsCost guard rather than
  // by checking for cachedCost == 0 (which would silently produce $0.00).
  const region = src.slice(src.indexOf('Phase 18-04 (COST-02)'));
  assert.ok(region.length > 0, 'Phase 18-04 COST-02 marker must be present in renderSessionItem');
  // The supportsCost check uses the helper. The fallback to true (Claude) is
  // explicit so first-paint Claude badges are not blanked.
  assert.ok(
    /const supportsCost\s*=\s*costProvider\s*\?\s*\(costProvider\.supportsCost\s*!==\s*false\)\s*:\s*true/.test(region),
    'supportsCost computation must default to true when costProvider is null (Claude semantics)'
  );
});

// ─── Test 4: _getProviderById helper exists ───
check('_getProviderById helper is defined and reads state.providers', () => {
  assert.ok(
    /_getProviderById\(id\)\s*\{[\s\S]{0,400}this\.state\.providers/.test(src),
    '_getProviderById must look up state.providers by id'
  );
});

// ─── Test 5: _sessionProviderLacksCost helper exists ───
check('_sessionProviderLacksCost helper exists', () => {
  assert.ok(
    /_sessionProviderLacksCost\(session\)\s*\{/.test(src),
    '_sessionProviderLacksCost helper must be defined'
  );
});

// ─── Test 6: renderCostsDashboard computes claudeOnly suffix ───
check('renderCostsDashboard computes claudeOnly from state.providers', () => {
  // The dashboard helper must read state.providers and derive a
  // boolean from any enabled provider with supportsCost === false.
  assert.ok(
    /const\s+claudeOnly\s*=[\s\S]{0,160}supportsCost\s*===\s*false/.test(src),
    'renderCostsDashboard must compute claudeOnly from any enabled provider with supportsCost === false'
  );
});

// ─── Test 7: renderCostsDashboard appends "(Claude only)" to the Total Cost label ───
check('renderCostsDashboard Total Cost card label includes ${claudeOnlySuffix}', () => {
  // The label is wrapped in a costs-card-label div; the suffix is appended.
  assert.ok(
    /Total Cost\$\{claudeOnlySuffix\}/.test(src),
    'Total Cost label must concatenate claudeOnlySuffix'
  );
});

// ─── Test 8: renderCostsDashboard appends "(Claude only)" to the Period card label ───
check('renderCostsDashboard Period card label includes ${claudeOnlySuffix}', () => {
  assert.ok(
    /summary\.periodLabel\)\}\$\{claudeOnlySuffix\}/.test(src),
    'Period card label must concatenate claudeOnlySuffix after the escaped periodLabel'
  );
});

// ─── Test 9: the suffix literal text "(Claude only)" is in the source ───
check('renderCostsDashboard source contains the literal " (Claude only)" suffix string', () => {
  assert.ok(
    /' \(Claude only\)'/.test(src),
    'The literal " (Claude only)" suffix string must appear so the gate fails on accidental copy edits'
  );
});

// ─── Test 10: renderCostsDashboard renders em-dash for unsupported cost rows ───
check('renderCostsDashboard cost cell branches on _sessionProviderLacksCost', () => {
  // The session table row computes rowLacksCost via the helper and
  // renders cost-cell-na with em-dash when true.
  assert.ok(
    /rowLacksCost\s*=\s*this\._sessionProviderLacksCost\(s\)/.test(src),
    'cost table render must call _sessionProviderLacksCost for each row'
  );
  assert.ok(
    /cost-cell\s+cost-cell-na"\s+title="Cost not tracked for this provider">&ndash;</.test(src),
    'cost table row for unsupported provider must render <td class="cost-cell cost-cell-na" title="...">&ndash;</td>'
  );
});

// ─── Test 11: cost table row carries data-provider attribute ───
check('renderCostsDashboard cost row carries data-provider', () => {
  // The data-provider must appear inside the same <tr> opening tag in
  // both render sites (initial + sort re-render). Two matches expected.
  const matches = src.match(/<tr\s+data-session-id="[^"]+"\s+data-provider="[^"]+"\s+class="costs-session-row"/g) || [];
  assert.ok(
    matches.length >= 2,
    'expected at least 2 cost-row <tr> openings with data-provider; got ' + matches.length
  );
});

// ─── Test 12: _patchCostBadges skips em-dash badges ───
check('_patchCostBadges leaves .session-badge-cost-na badges untouched', () => {
  // The patch helper must continue (skip) when the row already has the
  // em-dash class, so a stale cost-batch response cannot overwrite the
  // disclosure with a $-value.
  assert.ok(
    /_patchCostBadges\(costs\)[\s\S]{0,1200}\.session-badge-cost-na[\s\S]{0,80}\bcontinue;/.test(src),
    '_patchCostBadges must `continue;` when the row already displays .session-badge-cost-na'
  );
});

// ─── Test 13: the cost disclosure inline note appears when claudeOnly ───
check('renderCostsDashboard renders the "Codex cost tracking not yet supported" note when claudeOnly', () => {
  assert.ok(
    /Codex cost tracking not yet supported/.test(src),
    'the explanatory inline note must be present so users understand the aggregates'
  );
  // Must be guarded by the claudeOnly check.
  assert.ok(
    /if\s*\(\s*claudeOnly\s*\)\s*\{[\s\S]{0,200}Codex cost tracking not yet supported/.test(src),
    'the note must be guarded by `if (claudeOnly)` so it only appears when relevant'
  );
});

// ─── Summary ──────────────────────────────────────────────────────
console.log('  ' + '─'.repeat(42));
console.log('  \x1b[1m[cost-display]\x1b[0m ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
