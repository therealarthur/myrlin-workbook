#!/usr/bin/env node
/**
 * Contract tests for the browser/CommonJS theme metadata registry.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const registryPath = path.join(
  __dirname,
  '..',
  'src',
  'web',
  'public',
  'theme-registry.js'
);
const terminalPath = path.join(
  __dirname,
  '..',
  'src',
  'web',
  'public',
  'terminal.js'
);
const registry = require(registryPath);
const registrySource = fs.readFileSync(registryPath, 'utf8');
const terminalSource = fs.readFileSync(terminalPath, 'utf8');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (error) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + error.message);
  }
}

const expectedLegacyIds = [
  'mocha',
  'macchiato',
  'frappe',
  'nord',
  'dracula',
  'tokyo-night',
  'cherry',
  'ocean',
  'amber',
  'mint',
  'latte',
  'rose-pine-dawn',
  'gruvbox-light',
];

function loadTerminalRuntime(themeId, cssVariables) {
  const sandbox = {
    window: {},
    document: { documentElement: { dataset: { theme: themeId } } },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
    console,
  };
  if (cssVariables) {
    sandbox.window.getComputedStyle = () => ({
      getPropertyValue: (property) => cssVariables[property] || '',
    });
  }
  vm.createContext(sandbox);
  vm.runInContext(terminalSource, sandbox, { filename: 'terminal.js' });
  return { TerminalPane: sandbox.window.TerminalPane, sandbox };
}

check('exports exactly the 13 existing persisted theme IDs', () => {
  assert.strictEqual(registry.THEME_REGISTRY.length, 13);
  assert.deepStrictEqual(registry.LEGACY_THEME_IDS, expectedLegacyIds);
});

check('theme IDs and labels are unique', () => {
  const ids = registry.THEME_REGISTRY.map((theme) => theme.id);
  const labels = registry.THEME_REGISTRY.map((theme) => theme.label);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(new Set(labels).size, labels.length);
});

check('Frappé renders correctly while the registry source remains ASCII-safe', () => {
  assert.strictEqual(registry.getTheme('frappe').label, 'Frapp\u00e9');
  assert.ok(registrySource.includes("'Frapp\\u00e9'"));
  assert.ok(!registrySource.includes('Frapp\u00e9'));
});

check('every theme declares appearance, tier, and immutable xterm metadata', () => {
  for (const theme of registry.THEME_REGISTRY) {
    assert.ok(['dark', 'light'].includes(theme.appearance), theme.id + ' has invalid appearance');
    assert.ok(['featured', 'more'].includes(theme.tier), theme.id + ' has invalid tier');
    assert.strictEqual(typeof theme.xterm.paletteId, 'string', theme.id + ' lacks xterm paletteId');
    assert.strictEqual(typeof theme.xterm.fallback, 'boolean', theme.id + ' lacks xterm fallback flag');
    assert.ok(Object.isFrozen(theme), theme.id + ' metadata must be frozen');
    assert.ok(Object.isFrozen(theme.xterm), theme.id + ' xterm metadata must be frozen');
  }
});

check('every known theme has a direct theme-correct xterm mapping', () => {
  for (const themeId of expectedLegacyIds) {
    assert.strictEqual(registry.resolveXtermPaletteId(themeId), themeId);
    assert.strictEqual(registry.getTheme(themeId).xterm.fallback, false);
  }
  assert.strictEqual(registry.resolveXtermPaletteId('unknown-theme'), 'mocha');
});

check('terminal fallback palettes cover all 13 known themes without computed CSS', () => {
  const expectedBackgrounds = {
    mocha: '#1e1e2e',
    macchiato: '#24273a',
    frappe: '#303446',
    nord: '#2e3440',
    dracula: '#282a36',
    'tokyo-night': '#1a1b26',
    cherry: '#221a22',
    ocean: '#1a1e28',
    amber: '#211e1a',
    mint: '#1a2120',
    latte: '#eff1f5',
    'rose-pine-dawn': '#faf4ed',
    'gruvbox-light': '#fbf1c7',
  };
  const runtime = loadTerminalRuntime('mocha');

  for (const themeId of expectedLegacyIds) {
    runtime.sandbox.document.documentElement.dataset.theme = themeId;
    const palette = runtime.TerminalPane.getCurrentTheme();
    assert.strictEqual(palette.background, expectedBackgrounds[themeId], themeId + ' background');
    assert.strictEqual(typeof palette.foreground, 'string', themeId + ' foreground');
    assert.strictEqual(typeof palette.red, 'string', themeId + ' ANSI red');
    assert.strictEqual(typeof palette.brightWhite, 'string', themeId + ' ANSI bright white');
  }
});

check('terminal palette deterministically derives from active CSS variables', () => {
  const cssVariables = {
    '--base': '#102030',
    '--surface1': '#203040',
    '--surface2': '#304050',
    '--text': '#f0f1f2',
    '--subtext0': '#c0c1c2',
    '--subtext1': '#d0d1d2',
    '--mauve': '#112233',
    '--blue': '#223344',
    '--green': '#334455',
    '--yellow': '#445566',
    '--red': '#556677',
    '--teal': '#667788',
    '--rosewater': '#778899',
  };
  const runtime = loadTerminalRuntime('nord', cssVariables);
  const palette = runtime.TerminalPane.getCurrentTheme();

  assert.strictEqual(palette.background, '#102030');
  assert.strictEqual(palette.foreground, '#f0f1f2');
  assert.strictEqual(palette.cursor, '#778899');
  assert.strictEqual(palette.black, '#203040');
  assert.strictEqual(palette.red, '#556677');
  assert.strictEqual(palette.blue, '#223344');
  assert.strictEqual(palette.magenta, '#112233');
  assert.strictEqual(palette.cyan, '#667788');
  assert.strictEqual(palette.selectionBackground, 'rgba(17, 34, 51, 0.25)');
});

check('unknown terminal theme IDs safely use the complete Mocha palette', () => {
  const runtime = loadTerminalRuntime('not-a-theme', { '--base': '#ffffff' });
  const palette = runtime.TerminalPane.getCurrentTheme();
  assert.strictEqual(palette, runtime.TerminalPane.THEME_MOCHA);
  assert.strictEqual(palette.background, '#1e1e2e');
});

check('featured choices are conceptual aliases and never replace legacy persistence IDs', () => {
  const choiceIds = registry.FEATURED_THEME_CHOICES.map((choice) => choice.id);
  assert.deepStrictEqual(choiceIds, ['system', 'myrlin-dark', 'myrlin-light']);
  for (const choiceId of choiceIds) {
    assert.ok(!registry.LEGACY_THEME_IDS.includes(choiceId), choiceId + ' must not be a persisted legacy ID');
  }

  assert.strictEqual(registry.resolveFeaturedChoice('myrlin-dark'), 'mocha');
  assert.strictEqual(registry.resolveFeaturedChoice('myrlin-light'), 'latte');
  assert.strictEqual(registry.resolveFeaturedChoice('system', 'dark'), 'mocha');
  assert.strictEqual(registry.resolveFeaturedChoice('system', 'light'), 'latte');
  assert.strictEqual(registry.resolveFeaturedChoice('missing'), null);

  const system = registry.FEATURED_THEME_CHOICES.find((choice) => choice.id === 'system');
  assert.strictEqual(system.persistedThemeId, null);
});

check('featured legacy themes are the dark and light Myrlin alias targets', () => {
  const featured = registry.THEME_REGISTRY
    .filter((theme) => theme.tier === 'featured')
    .map((theme) => theme.id);
  assert.deepStrictEqual(featured, ['mocha', 'latte']);
});

check('CommonJS loading does not leak a Node global', () => {
  assert.strictEqual(global.MyrlinThemeRegistry, undefined);
});

check('plain browser loading exposes one frozen MyrlinThemeRegistry global', () => {
  const source = fs.readFileSync(registryPath, 'utf8');
  const browserContext = {};
  vm.createContext(browserContext);
  vm.runInContext(source, browserContext, { filename: 'theme-registry.js' });

  assert.ok(browserContext.MyrlinThemeRegistry);
  assert.strictEqual(browserContext.MyrlinThemeRegistry.THEME_REGISTRY.length, 13);
  assert.ok(Object.isFrozen(browserContext.MyrlinThemeRegistry));
});

console.log('\n  [theme-registry] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
