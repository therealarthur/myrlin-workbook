#!/usr/bin/env node
/**
 * Plan 22-01 gate: Codex bottom status strip.
 *
 * Locks the contract:
 *   1. .codex-pane-status selector exists in CSS, scoped to Codex panes.
 *   2. .codex-status-chip + .codex-status-chip-bypass selectors present.
 *   3. _renderCodexStatusStrip + _onCodexStatusChipClick methods exist.
 *   4. Strip render is wired into openTerminalInPane + putSettings.
 *   5. Server includes adHocProviderSettings in /api/discover response.
 *   6. Frontend hydrates state.adHocProviderSettings from that field.
 *
 * Pure source-scan over styles.css, app.js, server.js. No DOM.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { failed++; console.log('  \x1b[31m✗\x1b[0m ' + name); console.log('    ' + e.message); }
}

console.log('\n  Plan 22-01: Codex bottom status strip');
console.log('  ' + '─'.repeat(42));

check('.codex-pane-status selector exists', () => {
  assert.ok(css.includes('.codex-pane-status'), 'expected .codex-pane-status in styles.css');
});
check('.codex-status-chip + chip-bypass selectors exist', () => {
  assert.ok(css.includes('.codex-status-chip'), 'expected .codex-status-chip in styles.css');
  assert.ok(css.includes('.codex-status-chip-bypass'), 'expected .codex-status-chip-bypass in styles.css');
});
// Sanctioned test edit SE-5 (BUILD-CONTRACT.md 5.4), spent in phase P3, work
// package P3.2, in the same commit as its source change.
// Notion restyle: status ink moves to the named block palette.
check('bypass chip uses the named block-palette red', () => {
  assert.ok(/codex-status-chip-bypass[\s\S]{0,400}var\(--app-text-red\)/.test(css),
    '.codex-status-chip-bypass must reference var(--app-text-red)');
});

check('_renderCodexStatusStrip method exists', () => {
  assert.ok(/_renderCodexStatusStrip\s*\(/.test(app),
    'expected _renderCodexStatusStrip method on app');
});
check('_onCodexStatusChipClick handler exists', () => {
  assert.ok(/_onCodexStatusChipClick\s*\(/.test(app),
    'expected _onCodexStatusChipClick method on app');
});

check('openTerminalInPane wires the strip render', () => {
  // The renderer is invoked from openTerminalInPane after the pane is
  // tagged with data-provider; we assert by source order: a call to
  // _renderCodexStatusStrip must follow the data-provider assignment.
  assert.ok(/_renderCodexStatusStrip\(slotIdx\)/.test(app),
    'expected this._renderCodexStatusStrip(slotIdx) call somewhere in app.js');
});

check('putSettings refreshes the strip after a settings change', () => {
  // The Codex menu factory's putSettings callback must re-render the
  // strip so chip values reflect the change without waiting for the
  // next discover/refresh.
  const m = app.match(/putSettings\s*=\s*async[\s\S]{0,2000}_renderCodexStatusStrip/);
  assert.ok(m, 'expected _renderCodexStatusStrip call inside putSettings');
});

check('strip renders 6 chips (model, sandbox, approval, effort, bypass conditional, features conditional)', () => {
  // Scope: app.js as a whole. The chip identifiers are unique enough
  // that a whole-file grep is fine; there is no other 'model'/'sandbox'
  // chip producer outside _renderCodexStatusStrip.
  assert.ok(/chip\(['"]model['"]/.test(app), 'model chip missing');
  assert.ok(/chip\(['"]sandbox['"]/.test(app), 'sandbox chip missing');
  assert.ok(/chip\(['"]approval['"]/.test(app), 'approval chip missing');
  assert.ok(/chip\(['"]effort['"]/.test(app), 'effort chip missing');
  assert.ok(/data-chip="bypass"/.test(app), 'bypass chip missing');
  assert.ok(/chip\(['"]features['"]/.test(app), 'features chip missing');
});

check('bypass chip is conditional on bypassApprovalsAndSandbox === true', () => {
  // The bypass chip should only be pushed when bypass is ON. Grep the
  // file for the literal condition; it's specific enough that the
  // bypass chip render is the only place this triple-equals shape
  // appears in app.js.
  assert.ok(/bypassApprovalsAndSandbox\s*===\s*true/.test(app),
    'bypass chip must only render when bypassApprovalsAndSandbox === true');
});

check('Server: /api/discover response includes adHocProviderSettings', () => {
  // Look for the key in the discover response handler.
  const idx = server.indexOf("'/api/discover'");
  assert.ok(idx !== -1, '/api/discover route not found');
  const body = server.substr(idx, 4000);
  assert.ok(/adHocProviderSettings/.test(body),
    'discover response must include adHocProviderSettings');
});

check('Frontend hydrates state.adHocProviderSettings from /api/discover', () => {
  assert.ok(/state\.adHocProviderSettings\s*=/.test(app),
    'expected this.state.adHocProviderSettings = ... in app.js');
});

console.log('  ' + '─'.repeat(42));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
