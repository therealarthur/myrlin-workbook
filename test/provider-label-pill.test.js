#!/usr/bin/env node
/**
 * Plan 22-02 gate: provider label pill + sidebar entry stripes.
 *
 * Locks the shape of:
 *   1. The new .pane-provider-pill selector + per-provider ::before dot.
 *   2. The sidebar stripes on .ws-session-item and .project-session-item.
 *   3. Existing .project-accordion stripes still present (bumped to 3px).
 *   4. Pane markup carries a .pane-provider-pill element.
 *   5. openTerminalInPane wires the pill text + visibility.
 *
 * Pure string-match over styles.css and index.html and app.js. No DOM.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { failed++; console.log('  \x1b[31m✗\x1b[0m ' + name); console.log('    ' + e.message); }
}

console.log('\n  Plan 22-02: provider pill + sidebar stripes');
console.log('  ' + '─'.repeat(48));

check('.pane-provider-pill base selector exists', () => {
  assert.ok(css.includes('.pane-provider-pill'), 'expected .pane-provider-pill in styles.css');
});
check('Claude pill dot uses --provider-claude-accent', () => {
  assert.ok(
    /\.pane-provider-pill\[data-provider="claude"\]::before[\s\S]*?--provider-claude-accent/.test(css),
    'expected the claude pill ::before to reference --provider-claude-accent'
  );
});
check('Codex pill dot uses --provider-codex-accent', () => {
  assert.ok(
    /\.pane-provider-pill\[data-provider="codex"\]::before[\s\S]*?--provider-codex-accent/.test(css),
    'expected the codex pill ::before to reference --provider-codex-accent'
  );
});
check('Pane HTML markup includes pane-provider-pill', () => {
  assert.ok(html.includes('pane-provider-pill'),
    'expected pane-provider-pill span in index.html pane templates');
});
check('openTerminalInPane sets pill text + visibility', () => {
  assert.ok(/pillEl\.textContent/.test(app), 'expected pillEl.textContent assignment in app.js');
  assert.ok(/pillEl\.hidden\s*=/.test(app), 'expected pillEl.hidden assignment in app.js');
});
check('Sidebar .ws-session-item carries provider stripe', () => {
  assert.ok(
    /\.ws-session-item\[data-provider="claude"\][\s\S]*?--provider-claude-accent/.test(css),
    'claude ws-session-item must reference --provider-claude-accent'
  );
  assert.ok(
    /\.ws-session-item\[data-provider="codex"\][\s\S]*?--provider-codex-accent/.test(css),
    'codex ws-session-item must reference --provider-codex-accent'
  );
});
// Note: post-alpha.7 the project-session-item and project-accordion
// provider stripes were removed per user feedback (Discovered Projects
// already filters by provider tab so the stripe was redundant noise).
// Only the workspace sidebar's .ws-session-item carries the stripe now.
// SANCTIONED EDIT SE-2 (BUILD-CONTRACT 5.4, blessed in DEVIATIONS DV-6,
// spent in Notion restyle P4.5 alongside its source change).
//
// Notion restyle: a 4px one-side accent bar is on the rejection list; the pane
// frame carries a 35 percent tint of the hairline instead. The whole-pane 8
// percent wash goes with it: it sat BEHIND the xterm canvas, which paints
// opaque over its own area, so the only place it was ever visible was the
// chrome the hairline now identifies.
//
// The assertion keeps its shape and its subject. It still proves that each
// provider's pane frame references that provider's accent token and nothing
// else's, which is the drift this test exists to catch.
check('Pane frame carries a 35 percent mix of the provider accent, not a 4px bar', () => {
  assert.ok(
    /\.terminal-pane\[data-provider="claude"\][\s\S]*?border:\s*1px solid color-mix\(in srgb, var\(--provider-claude-accent\) 35%, var\(--app-border-primary\)\)/.test(css),
    'claude pane frame must be a 35% mix of --provider-claude-accent into the hairline'
  );
  assert.ok(
    /\.terminal-pane\[data-provider="codex"\][\s\S]*?border:\s*1px solid color-mix\(in srgb, var\(--provider-codex-accent\) 35%, var\(--app-border-primary\)\)/.test(css),
    'codex pane frame must be a 35% mix of --provider-codex-accent into the hairline'
  );
  assert.ok(
    !/border-top:\s*4px solid var\(--provider-(claude|codex)-accent\)/.test(css),
    'the 4px one-side accent bar must not come back'
  );
});
check('Pane header carries the flat provider tint, and no whole-pane wash', () => {
  assert.ok(
    /\.terminal-pane\[data-provider="claude"\][^{]*>\s*\.terminal-pane-header\s*\{[^}]*background:\s*var\(--provider-claude-tint\)/.test(css),
    'claude pane header must take the flat --provider-claude-tint'
  );
  assert.ok(
    /\.terminal-pane\[data-provider="codex"\][^{]*>\s*\.terminal-pane-header\s*\{[^}]*background:\s*var\(--provider-codex-tint\)/.test(css),
    'codex pane header must take the flat --provider-codex-tint'
  );
  assert.ok(
    !/color-mix\(in srgb, var\(--(mauve|green)\) 8%, var\(--bg-primary\)\)/.test(css),
    'the whole-pane 8% palette wash must not come back'
  );
});

console.log('  ' + '─'.repeat(48));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
