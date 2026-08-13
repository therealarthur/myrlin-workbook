#!/usr/bin/env node
/**
 * Source-contract gate for the second focused-experience cleanup.
 *
 * Browser behavior is exercised separately. These checks keep the shipped
 * labels, pre-paint state, accessible controls, and implementation hooks from
 * silently drifting while requiring no server, profile, or GUI.
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
const semanticCss = stripCssComments(
  fs.readFileSync(path.join(PUBLIC, 'semantic-theme.css'), 'utf8')
);
const experienceModelSource = fs.readFileSync(
  path.join(PUBLIC, 'experience-model.js'),
  'utf8'
);

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
  return balancedBlock(
    source.slice(signature.index),
    header.trimStart().replace(/\{$/, '')
  );
}

function regionBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notStrictEqual(start, -1, `Missing region start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notStrictEqual(end, -1, `Missing region end: ${endNeedle}`);
  return source.slice(start, end);
}

console.log('\n  \x1b[1mFocused experience UX source contract\x1b[0m');
console.log('  ' + '-'.repeat(48));

check('experience and semantic assets load before pre-paint and focused CSS', () => {
  const semanticAt = html.indexOf('semantic-theme.css');
  const focusedAt = html.indexOf('focused-shell.css');
  const registryAt = html.indexOf('theme-registry.js');
  const modelAt = html.indexOf('experience-model.js');
  const prepaintAt = html.indexOf('<script>', modelAt);
  assert.ok(semanticAt !== -1, 'semantic-theme.css is not linked');
  assert.ok(focusedAt !== -1, 'focused-shell.css is not linked');
  assert.ok(registryAt !== -1, 'theme-registry.js is not loaded');
  assert.ok(modelAt !== -1, 'experience-model.js is not loaded');
  assert.ok(prepaintAt !== -1, 'pre-paint bootstrap is missing');
  assert.ok(semanticAt < focusedAt, 'semantic roles must load before component CSS');
  assert.ok(registryAt < modelAt, 'theme metadata must load before the experience model');
  assert.ok(modelAt < prepaintAt, 'experience model must load before pre-paint state');
  for (const asset of [
    'semantic-theme.css',
    'focused-shell.css',
    'theme-registry.js',
    'experience-model.js',
  ]) {
    // SANCTIONED EDIT SE-7 (BUILD-CONTRACT.md 5.4, phase P1.6): Notion restyle
    // phase P1: assets changed, cachebuster bumped atomically across index.html
    // and three tests.
    assert.match(
      html,
      new RegExp(`${escapeRegExp(asset)}\\?v=20260813-notion-p5`),
      `${asset} cachebuster is stale`
    );
  }
});

check('canonical task vocabulary distinguishes Agent Tasks, Issues, and Checklist', () => {
  const tasksRegion = regionBetween(
    html,
    'id="tasks-tab-strip"',
    'id="tasks-layout-toggle"'
  );
  assert.match(
    tasksRegion,
    /data-tasks-tab="worktree"[\s\S]*?>\s*Agent Tasks\s*<\/button>/
  );
  assert.match(
    tasksRegion,
    /data-tasks-tab="td"[\s\S]*?>\s*Issues\s*<\/button>/
  );
  assert.doesNotMatch(tasksRegion, />\s*Worktree Tasks\s*</);
  assert.doesNotMatch(tasksRegion, />\s*td\s*</);
  assert.match(
    html,
    /<span class="docs-section-title">\s*Checklist\s*<\/span>/
  );
  assert.match(html, /placeholder="Filter agent tasks\.\.\."/);
  assert.match(html, />\s*New agent task\s*<\/button>/);
  assert.match(html, /<h3>\s*New Agent Task\s*<\/h3>/);
});

check('Project Notes exposes and wires an explicit project selector', () => {
  const selector = startTagById(html, 'select', 'docs-workspace-select');
  assert.ok(selector, 'Project Notes project selector is missing');
  assert.ok(classTokens(selector).includes('docs-workspace-select'));
  assert.strictEqual(attribute(selector, 'aria-label'), 'Project for notes');
  assert.match(appJs, /docsWorkspaceSelect:\s*document\.getElementById\('docs-workspace-select'\)/);
  assert.ok(
    /docsWorkspaceSelect\.addEventListener\('change',[\s\S]{0,500}selectWorkspace\(workspaceId\s*\|\|\s*null\)/.test(appJs),
    'Project Notes selector must route changes through selectWorkspace()'
  );
  const selectWorkspace = methodBody(appJs, 'selectWorkspace');
  assert.match(selectWorkspace, /this\.state\.viewMode\s*===\s*'docs'/);
  assert.match(selectWorkspace, /this\.loadDocs\(\)/);
  assert.match(selectWorkspace, /this\.loadTdIssues\(\)/);

  // A select that is never populated is worse than a passive label: it looks
  // interactive but cannot change context. Allow DOM or HTML-option rendering.
  assert.ok(
    /docsWorkspaceSelect[\s\S]{0,800}(?:createElement\(['"]option['"]\)|\.replaceChildren\(|\.appendChild\(|\.add\(|\.innerHTML\s*=)/.test(appJs),
    'Project Notes selector is wired but never populated with project options'
  );
  assert.match(appJs, /(?:Choose|Select) a project|No project selected/);
  assert.match(
    focusedCss,
    /@media\s*\(max-width:\s*768px\)[\s\S]*?\.docs-workspace-select\s*\{[\s\S]*?min-height:\s*44px/
  );
});

check('attention queue has accessible markup and a model-driven renderer', () => {
  const button = startTagById(html, 'button', 'attention-queue-btn');
  assert.ok(button, 'attention queue trigger is missing');
  assert.ok(classTokens(button).includes('attention-queue-btn'));
  assert.strictEqual(attribute(button, 'aria-haspopup'), 'menu');
  assert.strictEqual(attribute(button, 'aria-expanded'), 'false');
  assert.strictEqual(attribute(button, 'aria-controls'), 'context-menu');
  assert.strictEqual(attribute(button, 'aria-label'), 'Session attention queue');
  assert.ok(startTagById(html, 'span', 'attention-queue-badge'));
  assert.match(experienceModelSource, /buildAttentionQueue/);
  assert.ok(
    /(?:MyrlinExperienceModel|model)\.buildAttentionQueue/.test(appJs),
    'attention renderer must consume experienceModel.buildAttentionQueue()'
  );
  assert.match(appJs, /(?:attentionQueueBadge|badge)\.textContent\s*=/);
  assert.match(appJs, /(?:attentionQueueBtn|button)\.hidden\s*=/);
  assert.match(appJs, /classList\.(?:toggle|add)\(['"]has-actionable/);

  const menuBody = methodBody(appJs, 'showAttentionQueue');
  assert.match(menuBody, /data-attention-state|attention-state/);
  assert.match(menuBody, /item\.label|item\.state/);
  assert.match(menuBody, /showContextMenu|_renderContextItems/);
  assert.match(
    semanticCss,
    /\.attention-state\[data-attention-state="needs-input"\][\s\S]*?--status-needs-input/
  );
  assert.match(focusedCss, /\.attention-queue-btn:focus-visible/);
});

check('density is normalized before paint and persisted only by the live setter', () => {
  assert.match(html, /savedDensity\s*=\s*localStorage\.getItem\('cwm_density'\)/);
  assert.match(
    html,
    /dataset\.density\s*=\s*experienceModel[\s\S]{0,180}normalizeDensity\(savedDensity\)/
  );
  assert.match(appJs, /density:\s*\(window\.MyrlinExperienceModel/);
  assert.match(appJs, /this\.setDensity\(this\.state\.density,\s*\{\s*persist:\s*false\s*\}\)/);

  const setter = methodBody(appJs, 'setDensity');
  assert.match(setter, /normalizeDensity/);
  assert.match(setter, /this\.state\.density\s*=/);
  assert.match(setter, /document\.documentElement\.dataset\.density\s*=/);
  assert.match(setter, /localStorage\.setItem\('cwm_density'/);
  assert.match(setter, /persist/);
  assert.doesNotMatch(
    setter,
    /new\s+TerminalPane|\.dispose\(|closeTerminal|\.connect\(|new\s+WebSocket/,
    'density changes must not reconstruct or disconnect terminal panes'
  );
  assert.match(
    focusedCss,
    /data-density="informative"[\s\S]*?#header-stats/
  );
});

check('Appearance is one modal gallery for density and grouped themes', () => {
  const overlay = startTagById(html, 'div', 'appearance-overlay');
  const dialog = startTagById(html, 'div', 'appearance-dialog');
  const close = startTagById(html, 'button', 'appearance-close');
  assert.ok(overlay && dialog && close);
  assert.strictEqual(attribute(dialog, 'role'), 'dialog');
  assert.strictEqual(attribute(dialog, 'aria-modal'), 'true');
  assert.strictEqual(attribute(dialog, 'aria-labelledby'), 'appearance-title');
  assert.strictEqual(attribute(dialog, 'tabindex'), '-1');
  assert.strictEqual(attribute(close, 'aria-label'), 'Close appearance');
  assert.ok(startTagById(html, 'div', 'density-choices'));
  assert.ok(startTagById(html, 'div', 'theme-gallery'));

  const openMatch = /\n\s{2}(showAppearance|openAppearance)\s*\(/.exec(appJs);
  assert.ok(openMatch, 'Missing showAppearance/openAppearance method');
  const openName = openMatch[1];
  const openBody = methodBody(appJs, openName);
  const renderBody = methodBody(appJs, 'renderAppearance');
  const closeBody = methodBody(appJs, 'closeAppearance');
  assert.match(openBody, /renderAppearance/);
  assert.match(renderBody, /DENSITY_CHOICES/);
  assert.match(renderBody, /FEATURED_THEME_CHOICES/);
  assert.match(renderBody, /groupThemes/);
  assert.match(renderBody, /theme-gallery-card/);
  assert.match(renderBody, /aria-pressed/);
  assert.match(openBody, /appearanceOverlay\.hidden\s*=\s*false/);
  assert.match(closeBody, /appearanceOverlay\.hidden\s*=\s*true/);
  assert.ok(
    new RegExp(`label:\\s*'Appearance'[\\s\\S]{0,160}action:\\s*\\(\\)\\s*=>\\s*this\\.${openName}\\(`)
      .test(appJs),
    'More must open the Appearance gallery directly'
  );
  assert.doesNotMatch(
    appJs,
    /label:\s*'Appearance'[\s\S]{0,100}submenu:/,
    'Appearance must open the grouped gallery rather than a long submenu'
  );
  assert.ok(
    new RegExp(`themeToggleBtn[\\s\\S]{0,500}this\\.${openName}\\(`).test(appJs),
    'header Appearance trigger must open the same grouped gallery'
  );
  assert.match(focusedCss, /\.appearance-dialog[\s\S]*?max-height/);
  assert.match(
    focusedCss,
    /@media\s*\(max-width:\s*768px\)[\s\S]*?\.theme-gallery-grid[\s\S]*?repeat\(2/
  );
});

check('semantic theme layer defines palette-independent state roles', () => {
  const requiredTokens = [
    '--surface-canvas',
    '--surface-raised',
    '--surface-interactive',
    '--surface-selected',
    '--color-focus',
    '--color-attention',
    '--color-success',
    '--color-danger',
    '--status-needs-input',
    '--status-running',
    '--status-complete',
    '--status-failed',
    '--status-stale',
    '--selection-bg',
    '--focus-ring',
  ];
  for (const token of requiredTokens) {
    assert.match(
      semanticCss,
      new RegExp(`${escapeRegExp(token)}\\s*:`),
      `Missing semantic token ${token}`
    );
  }
  for (const state of ['needs-input', 'running', 'complete', 'failed', 'stale']) {
    assert.match(
      semanticCss,
      new RegExp(`data-attention-state=["']${state}["']`),
      `Missing semantic selector for ${state}`
    );
  }
  assert.doesNotMatch(
    semanticCss,
    /#[0-9a-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/i,
    'semantic stylesheet must consume palette roles, not raw colors'
  );
  assert.match(semanticCss, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(semanticCss, /outline:\s*2px solid Highlight/);
});

check('Git and Files task tabs are retired, hard-hidden, and sanitized', () => {
  const taskTabs = startTags(html, 'button')
    .filter(tag => classTokens(tag).includes('tasks-tab'));
  for (const name of ['git', 'files']) {
    const tag = taskTabs.find(tab => attribute(tab, 'data-tasks-tab') === name);
    assert.ok(tag, `Missing compatibility tab ${name}`);
    assert.strictEqual(attribute(tag, 'data-shell-maturity'), 'retired');
    assert.match(tag, /\shidden(?:\s|>)/i, `${name} compatibility tab must be hard-hidden`);
  }
  assert.match(
    focusedCss,
    /\.tasks-tab\[data-shell-maturity="retired"\]\s*\{[\s\S]*?display:\s*none/
  );
  const initTabs = methodBody(appJs, '_initTasksTabs');
  const switchTabs = methodBody(appJs, '_switchTasksTab');
  assert.match(initTabs, /savedTab\.hidden/);
  assert.match(initTabs, /savedIsAvailable\s*\?\s*saved\s*:\s*'worktree'/);
  assert.match(switchTabs, /requestedTab\.hidden/);
  assert.match(switchTabs, /name\s*=\s*'worktree'/);
});

check('System Resources renders accessible per-row overflow hooks', () => {
  const resources = methodBody(appJs, 'renderResources');
  let resourceFlow = resources;
  const includedHelpers = new Set();
  // Follow resource-named helpers for a few levels so the contract encourages
  // a small renderer plus focused menu/execution methods instead of forcing
  // every action and confirmation branch back into renderResources().
  for (let depth = 0; depth < 3; depth++) {
    const helperNames = Array.from(
      resourceFlow.matchAll(/this\.([A-Za-z0-9_]*[Rr]esource[A-Za-z0-9_]*)\s*\(/g)
    ).map(match => match[1]);
    let added = false;
    for (const helperName of helperNames) {
      if (helperName === 'renderResources' || includedHelpers.has(helperName)) continue;
      if (!new RegExp(`\\n\\s{2}(?:async\\s+)?${escapeRegExp(helperName)}\\s*\\(`).test(appJs)) {
        continue;
      }
      includedHelpers.add(helperName);
      resourceFlow += '\n' + methodBody(appJs, helperName);
      added = true;
    }
    if (!added) break;
  }
  assert.ok(
    /resource-row-menu-btn/.test(resources),
    'renderResources must emit one overflow trigger per session row'
  );
  assert.match(resources, /aria-haspopup=["']menu["']/);
  assert.match(resources, /aria-expanded=["']false["']/);
  assert.match(resources, /(?:aria-label=["'][^"']*Actions|Actions for)/);
  assert.match(resources, /data-label=["']Actions["']/);
  assert.match(resourceFlow, /showContextMenu|_renderContextItems/);
  for (const action of ['restart', 'stop', 'kill', 'start']) {
    assert.match(resourceFlow, new RegExp(`['"]${action}['"]|data-action=["']${action}`));
  }
  assert.match(resourceFlow, /showConfirmModal[\s\S]{0,500}Kill Process/);
  assert.match(focusedCss, /\.resource-row-menu-btn:focus-visible/);
  assert.match(
    focusedCss,
    /@media\s*\(max-width:\s*768px\)[\s\S]*?\.claude-session-table[\s\S]*?display:\s*block/
  );
  assert.match(
    semanticCss,
    /@media\s*\(forced-colors:\s*active\)[\s\S]*?\.resource-row-menu-btn/
  );
});

console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
