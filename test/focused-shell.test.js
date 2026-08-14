#!/usr/bin/env node
/**
 * Focused Workbook shell source-contract regression gate.
 *
 * This intentionally inspects the shipped HTML, CSS, and browser JavaScript
 * without starting Workbook. Browser behavior remains covered by the shell
 * Playwright suite; these checks make the product hierarchy and recovery path
 * difficult to remove accidentally during later UI work.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const focusedCss = stripCssComments(
  fs.readFileSync(path.join(PUBLIC, 'focused-shell.css'), 'utf8')
);
const themeRegistryPath = path.join(PUBLIC, 'theme-registry.js');
const themeRegistrySource = fs.readFileSync(themeRegistryPath, 'utf8');
const themeRegistry = require(themeRegistryPath);

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (error) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${error && error.message ? error.message : String(error)}`);
  }
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attribute(tag, name) {
  const match = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`,
    'i'
  ).exec(tag);
  return match ? match[2] : null;
}

function classTokens(tag) {
  return (attribute(tag, 'class') || '').split(/\s+/).filter(Boolean);
}

function startTags(fragment, tagName) {
  return Array.from(fragment.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')))
    .map(match => match[0]);
}

function startTagById(fragment, tagName, id) {
  return startTags(fragment, tagName)
    .find(tag => attribute(tag, 'id') === id) || null;
}

function elementRegionById(fragment, tagName, id) {
  const startTag = startTagById(fragment, tagName, id);
  assert.ok(startTag, `Missing <${tagName}>#${id}`);
  const start = fragment.indexOf(startTag);
  const end = fragment.indexOf(`</${tagName}>`, start + startTag.length);
  assert.notStrictEqual(end, -1, `Missing closing </${tagName}> for #${id}`);
  return fragment.slice(start, end + tagName.length + 3);
}

function balancedBlock(source, header) {
  const headerAt = source.indexOf(header);
  assert.notStrictEqual(headerAt, -1, `Missing block header: ${header}`);
  const open = source.indexOf('{', headerAt + header.length);
  assert.notStrictEqual(open, -1, `Missing opening brace after: ${header}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced block after: ${header}`);
}

function methodBody(source, methodName) {
  const signature = new RegExp(
    `\\n\\s{2}(?:async\\s+)?${escapeRegExp(methodName)}\\s*\\([^)]*\\)\\s*\\{`
  ).exec(source);
  assert.ok(signature, `Missing method: ${methodName}`);
  const header = signature[0].trimEnd();
  return balancedBlock(source.slice(signature.index), header.trimStart().replace(/\{$/, ''));
}

console.log('\n  \x1b[1mFocused Workbook shell contract\x1b[0m');
console.log('  ' + '-'.repeat(48));

check('focused shell is default with an explicit classic density fallback', () => {
  const rootTag = startTags(html, 'html')[0];
  assert.strictEqual(attribute(rootTag, 'data-ui-shell'), 'focused');
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('ui'\)/);
  assert.match(
    html,
    /shellOverride\s*===\s*'classic'\s*\?\s*'classic'\s*:\s*'focused'/
  );
  assert.match(html, /catch\s*\(_\)\s*\{[\s\S]*dataSet|catch\s*\(_\)\s*\{[\s\S]*dataset\.uiShell\s*=\s*'focused'/i);
});

check('desktop primary views are exactly terminal, workspace, and tasks', () => {
  const viewButtons = startTags(html, 'button')
    .filter(tag => classTokens(tag).includes('view-tab'));
  const primaryModes = viewButtons
    .filter(tag => attribute(tag, 'data-shell-tier') === 'primary')
    .map(tag => attribute(tag, 'data-mode'));
  assert.deepStrictEqual(primaryModes, ['terminal', 'workspace', 'tasks']);
});

check('secondary and contextual view routes remain in the DOM', () => {
  const viewButtons = startTags(html, 'button')
    .filter(tag => classTokens(tag).includes('view-tab'));
  const secondaryModes = viewButtons
    .filter(tag => attribute(tag, 'data-shell-tier') === 'secondary')
    .map(tag => attribute(tag, 'data-mode'));
  const contextualModes = viewButtons
    .filter(tag => attribute(tag, 'data-shell-tier') === 'contextual')
    .map(tag => attribute(tag, 'data-mode'));
  assert.deepStrictEqual(secondaryModes, ['costs', 'recent', 'resources']);
  assert.deepStrictEqual(contextualModes, ['docs']);
});

check('focused More is a utility control, not a view tab', () => {
  const more = startTagById(html, 'button', 'focused-more-btn');
  const tablist = elementRegionById(html, 'nav', 'workbook-view-tabs');
  assert.ok(more, 'Missing #focused-more-btn');
  assert.ok(classTokens(more).includes('focused-more-btn'));
  assert.ok(!classTokens(more).includes('view-tab'));
  assert.strictEqual(attribute(more, 'data-mode'), null);
  assert.strictEqual(attribute(more, 'aria-haspopup'), 'menu');
  assert.strictEqual(attribute(more, 'aria-expanded'), 'false');
  assert.strictEqual(attribute(more, 'aria-controls'), 'context-menu');
  assert.ok(!tablist.includes('focused-more-btn'), 'More must sit outside the tablist');
  assert.match(
    focusedCss,
    /:root\[data-ui-shell="focused"\] \.focused-more-btn:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--accent\)\s*;[\s\S]*?outline-offset:\s*2px\s*;[\s\S]*?\}/
  );
});

check('mobile navigation is exactly home, sessions, terminal, attention, and search', () => {
  // SANCTIONED TEST EDIT SE-8 (BUILD-CONTRACT 5.4), shipped in the same commit
  // as the source change because a deepStrictEqual cannot be split.
  //
  // Notion restyle IA: five-tab bar per DESIGN-SPEC 14.1; `tasks` moves to
  // Home > Workspace, `more` is dissolved into Home > Workspace and
  // per-surface overflow sheets.
  //
  // `#mobile-more-tab` is NOT deleted: it survives as the "All commands" row
  // inside Home > Workspace, so `showMoreMenu` keeps a phone route and the id
  // keeps its entry in the G1 snapshot. It is no longer a `.mobile-tab`, so
  // this filter no longer sees it, which is the point of the filter.
  const mobileNav = elementRegionById(html, 'nav', 'mobile-tab-bar');
  const mobileModes = startTags(mobileNav, 'button')
    .filter(tag => classTokens(tag).includes('mobile-tab'))
    .map(tag => attribute(tag, 'data-view'));
  assert.deepStrictEqual(mobileModes, ['home', 'sessions', 'terminal', 'attention', 'search']);
});

check('Workbench empty state and both CTA IDs ship in the shell', () => {
  const emptyState = elementRegionById(html, 'section', 'workbench-empty-state');
  assert.ok(emptyState);
  assert.ok(startTagById(html, 'button', 'workbench-start-btn'));
  assert.ok(startTagById(html, 'button', 'workbench-projects-btn'));
  assert.match(emptyState, /browse sessions already on this machine/i);
  assert.match(emptyState, />Browse sessions<\/button>/);
  assert.match(appJs, /workbenchStartBtn:\s*document\.getElementById\('workbench-start-btn'\)/);
  assert.match(appJs, /workbenchProjectsBtn:\s*document\.getElementById\('workbench-projects-btn'\)/);
});

check('More menus expose dialog/menu semantics and keyboard focus management', () => {
  const contextMenu = startTagById(html, 'div', 'context-menu');
  const actionSheet = startTagById(html, 'div', 'action-sheet');
  assert.strictEqual(attribute(contextMenu, 'role'), 'menu');
  assert.strictEqual(attribute(actionSheet, 'role'), 'dialog');
  assert.strictEqual(attribute(actionSheet, 'aria-modal'), 'true');
  assert.strictEqual(attribute(actionSheet, 'tabindex'), '-1');

  const contextKeys = methodBody(appJs, '_handleContextMenuKeydown');
  assert.match(contextKeys, /ArrowDown/);
  assert.match(contextKeys, /ArrowUp/);
  assert.match(contextKeys, /ArrowRight/);
  assert.match(contextKeys, /ArrowLeft/);
  assert.match(contextKeys, /e\.key\s*===\s*'Tab'/);
  assert.match(methodBody(appJs, 'hideContextMenu'), /restoreFocus/);
  assert.match(
    methodBody(appJs, '_renderContextItems'),
    /hideContextMenu\(\{\s*restoreFocus:\s*true\s*\}\)/
  );
  assert.match(methodBody(appJs, 'showActionSheet'), /_actionSheetReturnFocus/);
  assert.match(methodBody(appJs, 'hideActionSheet'), /returnFocus\.focus/);
});

check('token cleanup preserves non-secret shell and navigation parameters', () => {
  const initBody = methodBody(appJs, 'init');
  assert.match(initBody, /params\.delete\('token'\)/);
  assert.match(initBody, /remainingQuery\s*=\s*params\.toString\(\)/);
  assert.match(initBody, /window\.location\.hash/);
  assert.match(initBody, /replaceState\(\{\},\s*'',\s*sanitizedUrl\)/);
  assert.doesNotMatch(
    initBody,
    /replaceState\(\{\},\s*'',\s*window\.location\.pathname\)/
  );
});

check('mobile More stays active for routes reached through its sheet', () => {
  const viewMode = methodBody(appJs, 'setViewMode');
  assert.match(
    viewMode,
    /\['costs',\s*'recent',\s*'docs',\s*'resources'\]\.includes\(mode\)/
  );
  assert.match(
    viewMode,
    /tab\.dataset\.view\s*===\s*'more'\s*&&\s*isMoreDestination/
  );
  assert.match(viewMode, /setAttribute\('aria-current',\s*'page'\)/);
});

check('focused mobile CSS keeps the sole empty terminal pane visible', () => {
  const mobile = balancedBlock(focusedCss, '@media (max-width: 768px)');
  const slotZero = balancedBlock(
    mobile,
    ':root[data-ui-shell="focused"] #term-pane-0.terminal-pane-empty:not([hidden])'
  );
  assert.match(slotZero, /display:\s*flex\s*!important\s*;/);
  assert.doesNotMatch(
    mobile,
    /#term-pane-0\.terminal-pane-empty\s*\{\s*display:\s*flex\s*!important/
  );
});

check('focused desktop CSS gives dense terminal grids usable pane widths', () => {
  const desktopGrid = balancedBlock(
    focusedCss,
    '@media (min-width: 769px) and (max-width: 1559px)'
  );
  assert.match(desktopGrid, /\.terminal-grid\[data-panes="5"\]/);
  assert.match(desktopGrid, /\.terminal-grid\[data-panes="6"\]/);
  assert.match(desktopGrid, /grid-template-columns:\s*1fr 1fr\s*!important\s*;/);
  assert.match(desktopGrid, /grid-template-rows:\s*1fr 1fr 1fr\s*!important\s*;/);
  assert.match(desktopGrid, /\.terminal-resize-row/);
  assert.match(desktopGrid, /display:\s*none\s*!important\s*;/);
});

check('focused dense grids also respond to the real work-surface width', () => {
  const mainContent = balancedBlock(
    focusedCss,
    ':root[data-ui-shell="focused"] .main-content'
  );
  const containerGrid = balancedBlock(
    focusedCss,
    '@container workbook-main (max-width: 1399px)'
  );
  assert.match(mainContent, /container-name:\s*workbook-main\s*;/);
  assert.match(mainContent, /container-type:\s*inline-size\s*;/);
  assert.match(containerGrid, /\.terminal-grid\[data-panes="5"\]/);
  assert.match(containerGrid, /\.terminal-grid\[data-panes="6"\]/);
  assert.match(containerGrid, /grid-template-columns:\s*1fr 1fr\s*!important\s*;/);
  assert.match(containerGrid, /grid-template-rows:\s*1fr 1fr 1fr\s*!important\s*;/);
  assert.match(containerGrid, /\.terminal-resize-row/);
  assert.match(containerGrid, /display:\s*none\s*!important\s*;/);
});

check('Myrlin Light keeps small tertiary labels at readable contrast', () => {
  const latte = balancedBlock(
    focusedCss,
    ':root[data-ui-shell="focused"][data-theme="latte"]'
  );
  assert.match(latte, /--text-tertiary:\s*var\(--subtext1\)\s*;/);
});

check('empty Project Notes sections auto-collapse only in the focused shell', () => {
  const syncBody = methodBody(appJs, '_syncDocsSectionDensity');
  assert.match(syncBody, /dataset\.uiShell\s*===\s*'focused'/);
  assert.match(syncBody, /section\.dataset\.empty\s*=\s*String\(isEmpty\)/);
  assert.match(syncBody, /section\.dataset\.autoCollapsed\s*=\s*'true'/);
  assert.match(syncBody, /delete section\.dataset\.autoCollapsed/);
  assert.match(syncBody, /_setDocsSectionExpanded\(header,\s*false\)/);
  assert.match(syncBody, /_setDocsSectionExpanded\(header,\s*true\)/);
  assert.match(syncBody, /Refresh to summarize sessions in this project/);
  assert.match(
    focusedCss,
    /\.docs-section\[data-empty="true"\][\s\S]*?margin-bottom:\s*2px\s*;/
  );
});

check('Project Notes disclosures are semantic buttons with static ARIA wiring', () => {
  const headers = startTags(html, 'button')
    .filter(tag => classTokens(tag).includes('docs-section-header'));
  const controlledIds = headers.map(tag => attribute(tag, 'aria-controls'));

  assert.deepStrictEqual(controlledIds, [
    'docs-notes-list',
    'docs-goals-list',
    'docs-tasks-list',
    'docs-td-list',
    'docs-roadmap-list',
    'docs-rules-list',
    'docs-ai-insights',
  ]);
  for (const header of headers) {
    assert.strictEqual(attribute(header, 'type'), 'button');
    assert.strictEqual(attribute(header, 'aria-expanded'), 'true');
  }
  for (const id of controlledIds) {
    assert.ok(startTagById(html, 'div', id), `Missing controlled region #${id}`);
  }
  const nonButtonHeaders = startTags(html, 'div')
    .filter(tag => classTokens(tag).includes('docs-section-header'));
  assert.strictEqual(nonButtonHeaders.length, 0);
});

check('Project Notes disclosure behavior keeps ARIA, body, and chevron synchronized', () => {
  const bindBody = methodBody(appJs, 'bindEvents');
  const disclosureBody = methodBody(appJs, '_setDocsSectionExpanded');
  assert.match(bindBody, /disclosure\.getAttribute\('aria-expanded'\)\s*===\s*'true'/);
  assert.match(bindBody, /_setDocsSectionExpanded\(header,\s*!expanded\)/);
  assert.match(disclosureBody, /getAttribute\('aria-controls'\)/);
  assert.match(disclosureBody, /body\.hidden\s*=\s*!isExpanded/);
  assert.match(
    disclosureBody,
    /setAttribute\('aria-expanded',\s*String\(isExpanded\)\)/
  );
  assert.match(disclosureBody, /classList\.toggle\('open',\s*isExpanded\)/);
});

check('Project Notes disclosure reset avoids nested interactive controls', () => {
  const reset = balancedBlock(
    focusedCss,
    '.docs-section-heading > .docs-section-header'
  );
  assert.match(reset, /appearance:\s*none\s*;/);
  assert.match(reset, /border:\s*0\s*;/);
  assert.match(reset, /background:\s*transparent\s*;/);
  assert.match(reset, /text-align:\s*left\s*;/);
  assert.match(focusedCss, /\.docs-section-actions\s*\{[\s\S]*?display:\s*inline-flex\s*;/);
});

check('focused settings omit obsolete header controls while classic keeps them', () => {
  const registryBody = methodBody(appJs, 'getSettingsRegistry');
  const getRegistry = new Function(
    'document',
    `return function getSettingsRegistry() {${registryBody}};`
  );
  const keysForShell = shell => getRegistry({
    documentElement: { dataset: { uiShell: shell } },
  })().map(setting => setting.key);

  const focusedKeys = keysForShell('focused');
  const classicKeys = keysForShell('classic');
  for (const key of ['sessionCountInHeader', 'headerHeight']) {
    assert.ok(!focusedKeys.includes(key), `${key} must be hidden in focused settings`);
    assert.ok(classicKeys.includes(key), `${key} must remain available in classic settings`);
  }
  assert.ok(focusedKeys.includes('uiScale'), 'focused settings must retain useful controls');
});

/*
 * RETARGETED IN P12 (sanctioned edit SE-18), and the reason is a measurement,
 * not a rename. What this check has always been for is that the sidebar's
 * supporting copy resolves through a SEMANTIC token rather than through a raw
 * palette value or an inline style, which is why it names the token and not a
 * colour. The token it named, --text-tertiary, measures 2.67:1 on the light
 * canvas, so the rule it was protecting was protecting unreadable text.
 * P12's contrast reconciliation introduced --ink-meta for exactly this class of
 * copy (4.27:1 light, 7.52:1 dark) and swept every `color:` use of the tertiary
 * inks onto it. The assertion follows the sweep: same intent, same two rules,
 * same !important, one token later. DECISIONS 19 carries the table.
 */
check('focused sidebar supporting text uses the semantic meta-ink token', () => {
  assert.match(
    focusedCss,
    /\.sidebar :is\([\s\S]*?\.sidebar-meta,[\s\S]*?\.workspace-group-empty,[\s\S]*?\.ws-session-empty,[\s\S]*?\.project-session-time,[\s\S]*?\.sidebar-section-divider-label[\s\S]*?\)[\s\S]*?color:\s*var\(--ink-meta\)\s*!important\s*;/
  );
  assert.match(
    focusedCss,
    /\.sidebar-list \[style\*="color: var\(--overlay0\)"\][\s\S]*?color:\s*var\(--ink-meta\)\s*!important\s*;/
  );
});

check('focused first-run sidebar hides only redundant zero-data scaffolding', () => {
  assert.match(focusedCss, /@supports selector\(\.sidebar:has\(#sidebar-create-ws\)\)/);
  assert.match(
    focusedCss,
    /\.sidebar:has\(#sidebar-create-ws\):not\(:has\(#projects-list \.project-accordion\)\)/
  );
  for (const selector of [
    '#sidebar-provider-tabs',
    '.sidebar-footer',
    '#sidebar-section-resize',
    '#projects-header',
    '#projects-search-bar',
    '#projects-list',
  ]) {
    assert.match(focusedCss, new RegExp(escapeRegExp(selector)));
  }
  assert.match(focusedCss, /display:\s*none\s*;/);
});

check('coarse-pointer focused controls retain 44px targets beyond phone widths', () => {
  const coarse = balancedBlock(focusedCss, '@media (pointer: coarse)');
  for (const selector of [
    '#sidebar-toggle',
    '#account-chip',
    '.terminal-group-tab',
    '.terminal-groups-add',
    '.docs-section-header',
    '.docs-section-actions > button',
    '#appearance-close',
    '#resources-refresh-btn',
    '.terminal-pane-header > button',
  ]) {
    assert.match(coarse, new RegExp(escapeRegExp(selector)));
  }
  assert.match(coarse, /min-height:\s*44px\s*;/);
  const groupClose = balancedBlock(
    coarse,
    ':root[data-ui-shell="focused"] .terminal-group-tab-close'
  );
  assert.match(groupClose, /min-width:\s*44px\s*;/);
  assert.match(groupClose, /min-height:\s*44px\s*;/);
});

check('resource rows use a single accessible overflow control', () => {
  assert.match(focusedCss, /\.resource-row-menu-btn\s*\{/);
  assert.match(appJs, /class="resource-row-menu-btn"/);
  assert.match(appJs, /aria-haspopup="menu"\s+aria-expanded="false"/);
  assert.match(appJs, /showResourceRowMenu\(btn\)/);
  assert.doesNotMatch(appJs, /class="resource-action-btn/);
});

check('focused terminal chrome is quiet until pane interaction', () => {
  const claudePane = balancedBlock(
    focusedCss,
    ':root[data-ui-shell="focused"] .terminal-pane[data-provider="claude"]:not(.terminal-pane-empty),'
  );
  assert.match(claudePane, /border-top:\s*1px solid/);
  assert.match(claudePane, /border-bottom:\s*0\s*;/);
  assert.match(claudePane, /background:\s*var\(--base\)\s*;/);

  const hoverControls = balancedBlock(
    focusedCss,
    '@media (hover: hover) and (pointer: fine)'
  );
  assert.match(hoverControls, /\.terminal-pane-header > button/);
  assert.match(hoverControls, /\.terminal-pane-header:hover > button/);
  assert.match(hoverControls, /\.terminal-pane-header:focus-within > button/);
  assert.match(hoverControls, /\.terminal-pane-mic\.mic-active/);
  assert.match(hoverControls, /\.terminal-pane-expand-stage1/);
  assert.match(hoverControls, /\.terminal-pane-collapse:not\(\[hidden\]\)/);
  assert.match(hoverControls, /opacity:\s*1\s*;/);
});

check('focused CSS retires Git and Files task tabs without deleting compatibility code', () => {
  const retiredRule = balancedBlock(
    focusedCss,
    ':root[data-ui-shell="focused"] .tasks-tab[data-shell-maturity="retired"]'
  );
  assert.match(retiredRule, /display:\s*none\s*;/);
  for (const tabName of ['git', 'files']) {
    const tab = startTags(html, 'button')
      .find(tag => attribute(tag, 'data-tasks-tab') === tabName);
    assert.ok(tab, `Missing ${tabName} task tab`);
    assert.strictEqual(attribute(tab, 'data-shell-maturity'), 'retired');
    assert.match(tab, /\shidden(?:\s|>)/i);
  }
});

check('tasks is a persisted top-level view mode', () => {
  const body = methodBody(appJs, 'loadAll');
  assert.match(body, /\[[^\]]*['"]tasks['"][^\]]*\]\.includes\(savedViewMode\)/s);
});

check('hidden or unavailable task subtabs are sanitized to worktree', () => {
  const initBody = methodBody(appJs, '_initTasksTabs');
  const switchBody = methodBody(appJs, '_switchTasksTab');
  assert.match(initBody, /localStorage\.getItem\('cwm_tasksTab'\)/);
  assert.match(initBody, /!savedTab\.hidden/);
  assert.match(initBody, /getComputedStyle\(savedTab\)\.display\s*!==\s*'none'/);
  assert.match(initBody, /_switchTasksTab\(savedIsAvailable\s*\?\s*saved\s*:\s*'worktree'\)/);
  assert.match(switchBody, /requestedTab\.hidden/);
  assert.match(switchBody, /getComputedStyle\(requestedTab\)\.display\s*===\s*'none'/);
  assert.match(switchBody, /name\s*=\s*'worktree'/);
  assert.match(switchBody, /localStorage\.setItem\('cwm_tasksTab',\s*name\)/);
});

check('Discovered collapse defaults by shell and persists explicit choice', () => {
  assert.match(appJs, /localStorage\.getItem\('cwm_projectsCollapsed'\)/);
  assert.match(appJs, /saved\s*!==\s*null[\s\S]{0,80}saved\s*===\s*'true'/);
  assert.match(appJs, /dataset\.uiShell\s*===\s*'focused'/);
  assert.match(
    appJs,
    /setProjectsCollapsed\(this\.state\.projectsCollapsed,\s*false\)/
  );
  const setBody = methodBody(appJs, 'setProjectsCollapsed');
  for (const id of ['projects-search-bar', 'sidebar-section-resize']) {
    assert.match(setBody, new RegExp(`getElementById\\('${id}'\\)`));
  }
  assert.match(setBody, /this\.els\.projectsList/);
  assert.match(setBody, /element\.hidden\s*=\s*this\.state\.projectsCollapsed/);
  assert.match(
    setBody,
    /localStorage\.setItem\('cwm_projectsCollapsed',\s*String\(this\.state\.projectsCollapsed\)\)/
  );
  assert.match(
    methodBody(appJs, 'toggleProjectsPanel'),
    /setProjectsCollapsed\(!this\.state\.projectsCollapsed\)/
  );
});

check('System and Myrlin theme aliases are canonical and used by the menu', () => {
  const featured = themeRegistry.FEATURED_THEME_CHOICES.map(choice => ({
    id: choice.id,
    label: choice.label,
  }));
  assert.deepStrictEqual(featured, [
    { id: 'system', label: 'System' },
    { id: 'myrlin-dark', label: 'Myrlin Dark' },
    { id: 'myrlin-light', label: 'Myrlin Light' },
  ]);
  assert.strictEqual(themeRegistry.resolveFeaturedChoice('myrlin-dark', 'light'), 'mocha');
  assert.strictEqual(themeRegistry.resolveFeaturedChoice('myrlin-light', 'dark'), 'latte');
  assert.match(html, /<script src="theme-registry\.js[^"]*"><\/script>/);
  assert.match(html, /savedChoice\s*=\s*'system'/);
  const themeMenu = methodBody(appJs, '_buildThemeMenuItems');
  assert.match(themeMenu, /registry\.FEATURED_THEME_CHOICES\.map/);
  assert.match(themeMenu, /action:\s*\(\)\s*=>\s*this\.setTheme\(choice\.id\)/);
  assert.match(themeRegistrySource, /kind:\s*'alias'/);
});

console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
