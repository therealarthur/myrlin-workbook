#!/usr/bin/env node
/**
 * Alpha.9 gate: settings page left-side category rail.
 *
 * Locks the contract:
 *   1. index.html has `.settings-content` wrapping a `.settings-nav` rail
 *      and `.settings-body`.
 *   2. CSS defines `.settings-nav`, `.settings-nav-item`, and the
 *      `is-active` / `is-dimmed` states.
 *   3. app.js has `_settingsCategorySlug`, `_buildSettingsNav`, and
 *      `_updateSettingsActiveNavItem` methods.
 *   4. renderSettingsBody tags each .settings-category with id +
 *      data-category so the rail can anchor to it.
 *   5. The providers section receives an id post-render so it joins
 *      the rail too.
 *
 * Pure source-scan. No DOM.
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

console.log('\n  Alpha.9: settings nav rail');
console.log('  ' + '─'.repeat(32));

check('index.html has .settings-content wrapping nav + body', () => {
  assert.ok(html.includes('class="settings-content"'),
    'expected .settings-content wrapper in index.html');
  assert.ok(html.includes('id="settings-nav"'),
    'expected <nav id="settings-nav"> in index.html');
});

check('CSS: .settings-content uses grid-template-columns', () => {
  assert.ok(/\.settings-content[\s\S]{0,300}grid-template-columns/.test(css),
    '.settings-content must declare grid-template-columns for rail + body');
});

check('CSS: .settings-nav-item + is-active selectors exist', () => {
  assert.ok(/\.settings-nav-item\b/.test(css), '.settings-nav-item missing');
  assert.ok(/\.settings-nav-item\.is-active/.test(css), '.settings-nav-item.is-active missing');
});

// SANCTIONED EDIT SE-12 (BUILD-CONTRACT.md 5.4, Notion restyle P4 remainder):
// the settings rail's active state takes the standard active recipe, which is
// the selected wash plus primary ink. Three reasons point the same way and none
// of them is taste. --mauve is a CATPPUCCIN palette token, so the rail's
// selected state used to change hue with the TERMINAL theme, which
// DESIGN-SPEC 10.4 forbids and gate G4 counts. Mauve is also the retired brand
// primary (P3.1). And the same rule carried a 2px left border, which is on the
// rejection list beside the sidebar bars P2.2 removed and the tab underlines
// P4.4 removed. The assertion's intent, that the active rail item is visibly
// distinguished by a rule of its own, is preserved and retargeted.
check('CSS: active rail item highlights via the standard selected wash', () => {
  assert.ok(/\.settings-nav-item\.is-active[\s\S]{0,400}--app-sidebar-item-selected/.test(css),
    '.settings-nav-item.is-active must reference --app-sidebar-item-selected');
  assert.ok(!/\.settings-nav-item\.is-active[\s\S]{0,400}border-left/.test(css),
    '.settings-nav-item.is-active must not reintroduce a left accent bar');
});

check('app.js: _settingsCategorySlug method exists', () => {
  assert.ok(/_settingsCategorySlug\s*\(/.test(app),
    'expected _settingsCategorySlug method');
});

check('app.js: _buildSettingsNav method exists', () => {
  assert.ok(/_buildSettingsNav\s*\(/.test(app),
    'expected _buildSettingsNav method');
});

check('app.js: _updateSettingsActiveNavItem (scroll-spy) exists', () => {
  assert.ok(/_updateSettingsActiveNavItem\s*\(/.test(app),
    'expected _updateSettingsActiveNavItem scroll-spy method');
});

check('renderSettingsBody tags each category with id="settings-cat-..."', () => {
  assert.ok(/settings-cat-\$\{[\s\S]{0,50}slug/.test(app)
    || /id="settings-cat-/.test(app),
    'expected id="settings-cat-<slug>" template in renderSettingsBody');
});

check('renderSettingsBody calls _buildSettingsNav after innerHTML', () => {
  assert.ok(/_buildSettingsNav\(/.test(app),
    'expected _buildSettingsNav(...) call');
});

check('Providers section receives id post-render for rail anchor', () => {
  // The post-render code sets section.id = 'settings-cat-providers'
  assert.ok(/settings-cat-providers/.test(app),
    'expected settings-cat-providers id assignment after providers section lands');
});

check('Click handler smooth-scrolls inside the settings body', () => {
  assert.ok(/scrollTo\(\s*\{[\s\S]{0,200}behavior:\s*['"]smooth['"]/.test(app),
    'click handler must use scrollTo({ behavior: "smooth" })');
});

console.log('  ' + '─'.repeat(32));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
