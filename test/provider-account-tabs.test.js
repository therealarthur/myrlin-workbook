#!/usr/bin/env node
/**
 * Frontend gate for the account-panel provider tabs (Codex account
 * switcher, design doc Part 3.4). Source-scan gate over index.html,
 * app.js, styles.css, and server.js, mirroring provider-tabs.test.js.
 * No jsdom, no browser.
 *
 * What this locks down:
 *   1. index.html ships the tab bar (#account-tabs, role=tablist) with a
 *      legacy Claude tab and a provider Codex tab, and the retitlable
 *      #account-panel-title span.
 *   2. app.js branches renderAccountSwitcher on the tab's data-kind, so
 *      the legacy Claude pipeline stays the default and the provider
 *      pipeline renders through _renderProviderAccountPane.
 *   3. The provider pipeline exists end to end (load, render row, stage,
 *      rename, capture, delete, apply) and builds every API URL from the
 *      tab's dataset.providerTab (no hardcoded provider path literal).
 *   4. Provider rows reuse the shared account-row / usage-bar classes,
 *      carry data-account-id (never data-profile-id), and get the same
 *      delete button with the same active-row guard as the Claude rows.
 *   5. Both provider-accounts SSE cases exist (without them the default
 *      branch turns every broadcast into a loadAll reload storm), and
 *      server.js registers both types in GLOBAL_EVENT_TYPES.
 *   6. styles.css defines the .account-tabs block with per-provider
 *      accent tokens and only theme tokens (no hardcoded hex).
 *
 * Exits 0 green, 1 red.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');

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
 * The parameter list is paren-matched FIRST so destructured defaults in
 * the signature (e.g. { refresh = false } = {}) cannot end the brace
 * scan early; the body brace is then matched to its true close.
 * @param {string} name - Method name to extract.
 * @returns {string} The full method source text.
 */
function extractMethod(name) {
  const startIdx = APP_JS.search(new RegExp('^  (?:async )?' + name + '\\(', 'm'));
  assert(startIdx !== -1, 'method ' + name + ' not found in app.js');
  // Skip the parameter list by matching parens.
  const parenOpen = APP_JS.indexOf('(', startIdx);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < APP_JS.length; i++) {
    if (APP_JS[i] === '(') parenDepth++;
    else if (APP_JS[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { parenClose = i; break; }
    }
  }
  assert(parenClose !== -1, 'unbalanced parens extracting ' + name);
  const openIdx = APP_JS.indexOf('{', parenClose);
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

console.log('\n  provider-account-tabs gate');
console.log('  ' + '-'.repeat(60));

// ─── 1. index.html markup ──────────────────────────────────────────────────

check('index.html ships the account tab bar with both tabs', () => {
  assert(INDEX_HTML.includes('id="account-tabs"'), '#account-tabs missing');
  assert(/class="account-tabs"[^>]*role="tablist"|role="tablist"[^>]*id="account-tabs"/.test(INDEX_HTML)
    || INDEX_HTML.includes('role="tablist" id="account-tabs"'), 'tablist role missing');
  assert(INDEX_HTML.includes('data-kind="legacy"'), 'legacy tab kind missing');
  assert(INDEX_HTML.includes('data-kind="provider"'), 'provider tab kind missing');
  assert(INDEX_HTML.includes('data-provider-tab="claude"'), 'claude tab id missing');
  assert(INDEX_HTML.includes('data-provider-tab="codex"'), 'codex tab id missing');
  assert(INDEX_HTML.includes('id="account-tab-claude"') && INDEX_HTML.includes('id="account-tab-codex"'), 'tab element ids missing');
});

check('index.html retitlable panel header span exists', () => {
  assert(INDEX_HTML.includes('id="account-panel-title"'), '#account-panel-title missing');
});

check('the Claude tab starts active; the Codex tab starts inactive', () => {
  const claudeIdx = INDEX_HTML.indexOf('id="account-tab-claude"');
  const codexIdx = INDEX_HTML.indexOf('id="account-tab-codex"');
  assert(claudeIdx !== -1 && codexIdx !== -1, 'both tabs present');
  const claudeBtn = INDEX_HTML.slice(INDEX_HTML.lastIndexOf('<button', claudeIdx), claudeIdx + 40);
  const codexBtn = INDEX_HTML.slice(INDEX_HTML.lastIndexOf('<button', codexIdx), codexIdx + 40);
  assert(claudeBtn.includes('is-active') && claudeBtn.includes('aria-selected="true"'), 'Claude tab must start active');
  assert(!codexBtn.includes('is-active') && codexBtn.includes('aria-selected="false"'), 'Codex tab must start inactive');
});

// ─── 2. app.js: tab branch + pipeline ──────────────────────────────────────

check('renderAccountSwitcher branches on data-kind provider BEFORE the legacy path', () => {
  const render = extractMethod('renderAccountSwitcher');
  const branchIdx = render.indexOf("dataset.kind === 'provider'");
  assert(branchIdx !== -1, 'data-kind branch missing from renderAccountSwitcher');
  assert(render.includes('_renderProviderAccountPane'), 'provider pane render call missing');
  const machinesIdx = render.indexOf('renderMachinesStrip');
  assert(machinesIdx === -1 || branchIdx < machinesIdx, 'the provider branch must run before the legacy machines strip');
});

check('the full provider pipeline exists', () => {
  ['_activateAccountTab', '_activeAccountTabEl', '_accountTabForProvider',
    'loadProviderAccounts', '_applyProviderListResponse', '_renderProviderAccountPane',
    'renderProviderAccountRow', 'stageProviderAccount', 'renameProviderAccount',
    'captureProviderAccount', 'deleteProviderAccount', 'applyStagedProviderAccount',
  ].forEach((m) => extractMethod(m));
});

check('every provider API URL is built from dataset.providerTab (no provider path literal)', () => {
  assert(APP_JS.includes('/api/provider-accounts/'), 'provider-accounts route prefix missing');
  assert(!APP_JS.includes('/api/provider-accounts/codex'), 'hardcoded provider id in an API path');
  const load = extractMethod('loadProviderAccounts');
  assert(load.includes('dataset.providerTab'), 'loadProviderAccounts must derive the id from the tab dataset');
  assert(load.includes('encodeURIComponent'), 'provider id must be URI-encoded');
});

check('loadProviderAccounts marks the tab unavailable on 404 (old server)', () => {
  const load = extractMethod('loadProviderAccounts');
  assert(load.includes('404'), '404 handling missing');
  assert(load.includes('is-unavailable'), 'is-unavailable class missing');
});

check('provider rows reuse the shared row/usage classes and carry data-account-id', () => {
  const row = extractMethod('renderProviderAccountRow');
  ['account-row', 'account-row-avatar', 'account-row-primary', 'account-row-secondary',
    'account-plan-badge', 'account-active-pill', 'account-row-radio', 'account-row-edit',
    '_accountUsageRowHtml', 'data-account-id',
  ].forEach((s) => assert(row.includes(s), 'renderProviderAccountRow missing ' + s));
  assert(!row.includes('data-profile-id'), 'provider rows must never carry data-profile-id');
  assert(!row.includes('_machineSegmentsHtml'), 'no machine segments on provider rows (Claude-only in v1)');
});

check('provider rows get the same delete button with the same active-row guard', () => {
  const row = extractMethod('renderProviderAccountRow');
  const guardIdx = row.indexOf('if (!isActive) {');
  assert(guardIdx !== -1, 'render-time !isActive guard missing');
  assert(row.indexOf('account-delete-btn', guardIdx) !== -1, 'delete button must sit inside the !isActive guard');
  const del = extractMethod('deleteProviderAccount');
  assert(del.includes('pa.activeId'), 'deleteProviderAccount must re-check the active-row guard');
  assert(del.includes("_credApi('DELETE'"), 'must call the DELETE route');
  assert(del.includes('showConfirmModal'), 'must confirm before deleting');
  assert(del.includes('btn-danger'), 'destructive confirm styling');
  assert(del.includes('resp.status !== 404'), '404 treated as success');
});

check('the delegated list handler routes provider rows before the legacy branches', () => {
  const handlerIdx = APP_JS.indexOf("els.accountPanelList.addEventListener('click'");
  assert(handlerIdx !== -1, 'delegated list click handler not found');
  const handler = APP_JS.slice(handlerIdx, handlerIdx + 6000);
  const provIdx = handler.indexOf('.account-row[data-account-id]');
  const legacyDelIdx = handler.indexOf("closest('.account-delete-btn')");
  const legacyEditIdx = handler.indexOf("closest('.account-row-edit')");
  assert(provIdx !== -1, 'provider row branch missing');
  assert(provIdx < legacyDelIdx && provIdx < legacyEditIdx, 'provider branch must run before the legacy branches');
  assert(handler.includes('#account-capture-provider-btn'), 'provider capture CTA branch missing');
});

check('apply confirm carries the new-sessions-only note and never offers restartAllSessions', () => {
  const apply = extractMethod('applyStagedProviderAccount');
  assert(apply.includes('showConfirmModal'), 'confirm modal missing');
  assert(apply.includes('only new'), 'restart-semantics copy missing');
  assert(!apply.includes('restartAllSessions'), 'provider apply must NOT offer restartAllSessions (restarts every session)');
});

// ─── 3. SSE cases ──────────────────────────────────────────────────────────

check('both provider-accounts SSE cases exist in the event switch', () => {
  assert(APP_JS.includes("case 'provider-accounts:changed':"), 'changed case missing (loadAll storm risk)');
  assert(APP_JS.includes("case 'provider-accounts:usage':"), 'usage case missing (loadAll storm risk)');
});

check('server.js registers both provider-accounts types in GLOBAL_EVENT_TYPES', () => {
  const setIdx = SERVER_JS.indexOf('const GLOBAL_EVENT_TYPES');
  assert(setIdx !== -1, 'GLOBAL_EVENT_TYPES not found');
  const block = SERVER_JS.slice(setIdx, SERVER_JS.indexOf(']);', setIdx));
  assert(block.includes("'provider-accounts:changed'"), 'changed type not registered');
  assert(block.includes("'provider-accounts:usage'"), 'usage type not registered');
});

check('server.js wires the codex account manager and its watcher lifecycle', () => {
  assert(SERVER_JS.includes("require('../providers/codex/accounts')"), 'capability require missing');
  assert(SERVER_JS.includes('createProviderAccountManager'), 'manager factory missing');
  assert(SERVER_JS.includes('setupProviderAccountRoutes'), 'routes setup missing');
  assert(SERVER_JS.includes('codexAccountManager.startWatcher()'), 'watcher start missing');
  assert(SERVER_JS.includes('codexAccountManager.stopWatcher()'), 'watcher stop missing from cleanup');
});

// ─── 4. CSS ────────────────────────────────────────────────────────────────

check('styles.css defines the .account-tabs block with provider accent tokens', () => {
  const idx = STYLES_CSS.indexOf('.account-tabs {');
  assert(idx !== -1, '.account-tabs rule missing');
  assert(STYLES_CSS.includes('.account-tab.is-active[data-provider-tab="claude"]'), 'claude accent rule missing');
  assert(STYLES_CSS.includes('.account-tab.is-active[data-provider-tab="codex"]'), 'codex accent rule missing');
  assert(STYLES_CSS.includes('--provider-claude-accent') && STYLES_CSS.includes('--provider-codex-accent'), 'accent tokens missing');
});

check('the account-tabs CSS block uses theme tokens only (no hardcoded hex)', () => {
  const start = STYLES_CSS.indexOf('.account-tabs {');
  const end = STYLES_CSS.indexOf('.account-empty-hint');
  assert(start !== -1 && end > start, 'tab CSS block bounds');
  const block = STYLES_CSS.slice(start, end);
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'no hardcoded hex in the tab bar CSS');
  assert(block.includes('var(--transition-fast)'), 'shared 150-200ms transition token used');
});

// ─── Results ───────────────────────────────────────────────────────────────

console.log('  ' + '-'.repeat(60));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
