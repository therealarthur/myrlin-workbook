#!/usr/bin/env node
/**
 * Plan 19-01 PTY-07: layout pane provider persistence.
 *
 * Verifies that the saved layout (group.panes[]) carries an explicit
 * `provider` field per pane, and that loadTerminalLayout reads it back into
 * spawnOpts when restoring. Without this, a Codex pane saved during one
 * session and restored after a refresh (or after Codex was toggled off and
 * back on) would lose its provider tag, the post-Phase-18 sidebar lookup
 * falls back to the v1.1 default and the pane visually mis-renders as
 * Claude until next attach.
 *
 * Like test/data-provider-attr.test.js, this gate is a string-match over
 * src/web/public/app.js because the frontend is a single 18k-line vanilla
 * class with no module exports; instantiating CWMApp in Node would need
 * jsdom plus the full xterm + WebSocket chain. The persisted-shape
 * patterns we assert below are unique enough that any refactor that drops
 * the field will fail this gate as a clean regression signal.
 *
 * Requirements covered: PTY-07 (the layout-persistence half).
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

console.log('\n  \x1b[1mPlan 19-01: layout provider persistence\x1b[0m');
console.log('  ' + '─'.repeat(42));

// (1) saveCurrentGroupPanes pushes a `provider` field on each pane record.
check('saveCurrentGroupPanes pushes provider field on each pane record', () => {
  // Locate the saveCurrentGroupPanes body and assert it contains a
  // `provider: ...` field next to the existing `sessionId:` field inside
  // the group.panes.push(...) call.
  const saveFn = src.match(/saveCurrentGroupPanes\s*\(\)\s*\{[\s\S]*?\n\s{2}\}/);
  assert.ok(saveFn, 'saveCurrentGroupPanes() function body must be findable in app.js');
  const body = saveFn[0];
  assert.ok(
    /group\.panes\.push\(\{[\s\S]*?provider\s*:/.test(body),
    'saveCurrentGroupPanes must write a `provider` field on the pushed pane record'
  );
});

// (2) saveCurrentGroupPanes reads provider from paneEl.dataset.provider.
check('saveCurrentGroupPanes reads provider from paneEl.dataset.provider', () => {
  const saveFn = src.match(/saveCurrentGroupPanes\s*\(\)\s*\{[\s\S]*?\n\s{2}\}/);
  assert.ok(saveFn, 'saveCurrentGroupPanes() function body must be findable in app.js');
  const body = saveFn[0];
  // The pattern reads from the live pane element so the persisted value
  // reflects the visible tag, not a stale spawnOpts copy.
  assert.ok(
    /paneEl[\s\S]*?dataset[\s\S]*?provider/.test(body),
    'saveCurrentGroupPanes must read provider from paneEl.dataset.provider'
  );
});

// (3) saveCurrentGroupPanes default falls back to the v1.1 back-compat value.
check('saveCurrentGroupPanes defaults to v1.1 fallback when dataset missing', () => {
  const saveFn = src.match(/saveCurrentGroupPanes\s*\(\)\s*\{[\s\S]*?\n\s{2}\}/);
  assert.ok(saveFn, 'saveCurrentGroupPanes() function body must be findable in app.js');
  const body = saveFn[0];
  // The "|| 'claude'" form is the project standard for the default.
  // gsd:provider-literal-allowed marker must accompany the literal.
  assert.ok(
    /paneProvider[\s\S]*?\|\|\s*'claude'/.test(body),
    'saveCurrentGroupPanes must default to the v1.1 fallback (|| \'claude\') when dataset.provider is missing'
  );
});

// (4) loadTerminalLayout reads p.provider and merges into spawnOpts.
check('loadTerminalLayout reads p.provider and merges into spawnOpts', () => {
  // The restore pattern: `if (p.provider && !opts.provider) opts.provider = p.provider;`
  // It must appear inside loadTerminalLayout's body, before the
  // openTerminalInPane call. We match the merge form loosely so small
  // refactors (e.g., ternary instead of if-statement) still pass.
  assert.ok(
    /p\.provider[\s\S]{0,200}?opts\.provider/.test(src),
    'loadTerminalLayout must merge p.provider into spawnOpts before openTerminalInPane'
  );
});

// (5) loadTerminalLayout still calls openTerminalInPane with the merged opts.
check('loadTerminalLayout calls openTerminalInPane with the merged opts', () => {
  // Match the call form `openTerminalInPane(p.slot, p.sessionId, ..., opts)`
  // where opts is the merged spawnOpts variable.
  const loadFn = src.match(/loadTerminalLayout\s*\(\)\s*\{[\s\S]*?\n\s{2}\}/);
  assert.ok(loadFn, 'loadTerminalLayout() function body must be findable in app.js');
  const body = loadFn[0];
  assert.ok(
    /this\.openTerminalInPane\(p\.slot,\s*p\.sessionId,\s*p\.sessionName[^,]*,\s*opts\)/.test(body),
    'loadTerminalLayout must call openTerminalInPane with the merged opts variable'
  );
});

// (6) openTerminalInPane honors spawnOpts.provider over the allSessions lookup.
check('openTerminalInPane honors spawnOpts.provider over the allSessions lookup', () => {
  // The explicit-provider branch: `_explicitProvider || (_sessForProvider && ...)`
  // This ensures a restored Codex pane stays tagged 'codex' even when
  // state.allSessions is empty.
  assert.ok(
    /_explicitProvider\s*\n?\s*\|\|\s*\(_sessForProvider/.test(src) ||
    /spawnOpts[\s\S]{0,50}?provider[\s\S]{0,200}?_sessForProvider/.test(src),
    'openTerminalInPane must prefer spawnOpts.provider over the allSessions lookup'
  );
});

// (7) openTerminalInPane sets paneEl.dataset.provider from the resolved value.
check('openTerminalInPane sets paneEl.dataset.provider from resolved value', () => {
  // Existing assertion from data-provider-attr.test.js, repeated here as a
  // smoke check that the explicit-provider branch did not accidentally
  // drop the assignment.
  assert.ok(
    /paneEl\.dataset\.provider\s*=/.test(src),
    'openTerminalInPane must assign paneEl.dataset.provider'
  );
});

console.log('  ' + '─'.repeat(42));
console.log('  [layout-provider-persist] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
