#!/usr/bin/env node
/**
 * Plan 18-01 gate: data-provider attribute on every render site.
 *
 * Asserts that the three sidebar render sites (sidebar session item,
 * project accordion, project-session sub-item) AND the terminal-pane
 * attach/detach paths all emit / set / clear the data-provider attribute
 * per the Phase 18 foundation design.
 *
 * The frontend is a single 18k-line vanilla-JS class with no module
 * exports; instantiating CWMApp inside Node would require jsdom and the
 * full DOM chain. Instead, the test reads the source of app.js as text
 * and string-matches the render-site lines we added. The render-site
 * patterns are unique enough that a future refactor that changes the
 * template shape will fail this gate as a regression, which is the
 * intended signal.
 *
 * Requirements covered: UI-03 (foundation layer).
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

console.log('\n  \x1b[1mPlan 18-01: data-provider attribute\x1b[0m');
console.log('  ' + '─'.repeat(42));

// (1) Sidebar session item template carries data-provider.
// The renderSessionItem template literal opens with class="ws-session-item${...}"
// and the attribute should appear inside the same opening tag.
check('renderSessionItem template emits data-provider on .ws-session-item', () => {
  // Match the opening tag of .ws-session-item and ensure data-provider= appears
  // before the closing `>`. Use [\s\S] so the regex tolerates line wrapping
  // even though the current template is on one line.
  const re = /<div class="ws-session-item\$\{[\s\S]*?data-provider="\$\{[^}]*\}"[\s\S]*?>/;
  assert.ok(
    re.test(src),
    '.ws-session-item opening tag must include data-provider="${...}"; not found'
  );
});

check('renderSessionItem source contains s.provider || \'claude\' default', () => {
  // The defensive default for v1.1-shaped sessions that lack provider.
  assert.ok(
    /s\.provider\s*\|\|\s*'claude'/.test(src),
    'renderSessionItem must default to \'claude\' for v1.1-shaped sessions lacking provider'
  );
});

// (2) renderProjects emits data-provider on .project-session-item.
check('renderProjects emits data-provider on .project-session-item', () => {
  const re = /<div class="project-session-item"[\s\S]*?data-provider="\$\{[^}]*\}"[\s\S]*?>/;
  assert.ok(
    re.test(src),
    '.project-session-item opening tag must include data-provider="${...}"; not found'
  );
});

// (3) renderProjects emits data-provider on .project-accordion.
check('renderProjects emits data-provider on .project-accordion', () => {
  const re = /<div class="project-accordion\$\{[\s\S]*?data-provider="\$\{[^}]*\}"[\s\S]*?>/;
  assert.ok(
    re.test(src),
    '.project-accordion opening tag must include data-provider="${...}"; not found'
  );
});

check('renderProjects source contains p.provider || \'claude\' default', () => {
  assert.ok(
    /p\.provider\s*\|\|\s*'claude'/.test(src),
    'renderProjects must default to \'claude\' for v1.1-shaped projects lacking provider'
  );
});

// (4) openTerminalInPane sets paneEl.dataset.provider at attach time.
check('openTerminalInPane sets paneEl.dataset.provider', () => {
  assert.ok(
    /paneEl\.dataset\.provider\s*=/.test(src),
    'openTerminalInPane must assign paneEl.dataset.provider so the pane CSS selectors render'
  );
});

check('openTerminalInPane lookup falls back to \'claude\' on missing session', () => {
  // The exact form we use is "(_sessForProvider && _sessForProvider.provider) || 'claude'"
  // but the test stays loose enough to tolerate small refactors.
  assert.ok(
    /\.provider\)?\s*\|\|\s*'claude'/.test(src),
    'pane attach must default to \'claude\' when the looked-up session lacks provider'
  );
});

// (5) Cleanup: fatal error and close paths both route through the unified
// fixed-host reset, which clears data-provider with the rest of the chrome.
check('fatal error path resets its fixed host', () => {
  const start = src.indexOf('  _handleTerminalPaneFatal(');
  const end = src.indexOf('\n  openTerminalInPane(', start);
  const body = src.slice(start, end);
  assert.ok(
    /_resetTerminalPaneHost\(liveSlot\)/.test(body),
    'fatal cleanup must reset the fixed host so an empty pane is not visually tagged'
  );
});

check('unified host reset clears data-provider', () => {
  const start = src.indexOf('  _resetTerminalPaneHost(');
  const end = src.indexOf('\n  _syncTerminalPaneHost(', start);
  const body = src.slice(start, end);
  assert.ok(
    /paneEl\.removeAttribute\(['"]data-provider['"]\)/.test(body),
    'fixed-host reset must clear data-provider so a closed pane is not visually tagged'
  );
});

// (6) Sanity: at least three template-level data-provider= occurrences exist
// across the file (one per sidebar render site: session item, project accordion,
// project session). Catches drift if a render site silently drops the attr.
check('app.js contains at least 3 template-level data-provider= occurrences', () => {
  const occurrences = (src.match(/data-provider="\$\{/g) || []).length;
  assert.ok(
    occurrences >= 3,
    'Expected >= 3 template-level data-provider="${...}" occurrences in app.js; found ' + occurrences
  );
});

// (7) Plan 19-01 PTY-07: openTerminalInPane honors spawnOpts.provider over
// the _sessForProvider lookup. Without this, a layout-restore of a Codex
// pane while state.allSessions is empty would default to claude.
check('openTerminalInPane honors spawnOpts.provider over the allSessions lookup', () => {
  // Match the explicit-provider branch (either the named variable form or
  // an inline spawnOpts.provider check before _sessForProvider).
  const hasExplicitFirst =
    /_explicitProvider[\s\S]{0,80}?\|\|[\s\S]{0,80}?_sessForProvider/.test(src) ||
    /spawnOpts[\s\S]{0,40}?provider[\s\S]{0,180}?_sessForProvider/.test(src);
  assert.ok(
    hasExplicitFirst,
    'openTerminalInPane must prefer spawnOpts.provider over _sessForProvider so layout restore is deterministic'
  );
});

console.log('  ' + '─'.repeat(42));
console.log('  [data-provider-attr] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
