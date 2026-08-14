#!/usr/bin/env node
/**
 * Round 1 post-launch gate: the provider switcher filters the Discovered list,
 * and nothing else.
 *
 * THE BUG THIS FILE EXISTS FOR. The user reported "chatgpt codex is showing
 * claude sessions - not the actual codex sessions happening on my machine",
 * then diagnosed the cause himself: "put the claude code chatgpt all switcher
 * under discover - thats why it was confusing". The discovery data was never
 * wrong (codexProvider.discover returns 128 correctly tagged sessions, the
 * route tags every bucket and every session with provider.id). The PLACEMENT
 * was wrong: the strip sat at the top of the sidebar, above the tracked
 * Projects section, so it read as a global scope control. Selecting ChatGPT
 * Codex filtered the tracked sessions out from under the project rows while
 * leaving the rows on screen, which reads exactly like a Codex tab full of
 * Claude projects.
 *
 * The contract this file locks:
 *   1. PLACEMENT. #sidebar-provider-tabs is a child of the Discovered section:
 *      after #projects-header, before #projects-list, and no longer above
 *      #sidebar-projects-header.
 *   2. SCOPE. renderProjects reads the DISCOVERED scope; renderWorkspaces
 *      reads the WORKSPACES scope, which always resolves to 'all'.
 *   3. ROW-LEVEL. A project row's sessions are filtered by the same scope, so
 *      a merged cross-provider folder shows only the selected provider's
 *      threads.
 *   4. COUNTS. The badges count DISCOVERED sessions per provider, with the
 *      tracked counters as the pre-discovery fallback.
 *
 * Idiom follows provider-tabs.test.js: source-string assertions for wiring
 * that needs a DOM, plus a real extraction of the countable helpers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'web', 'public');
const src = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
const queue = [];

/**
 * Register a named assertion.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void|Promise<void>} fn Function that throws on failure.
 */
function check(name, fn) {
  queue.push({ name, fn });
}

async function runQueue() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + err.message + '\x1b[0m');
    }
  }
}

console.log('\n  \x1b[1mRound 1: provider switcher scope\x1b[0m');
console.log('  ' + '─'.repeat(42));

// ───────────────────────────────────────────────────────────────────────
// SECTION A: placement
// ───────────────────────────────────────────────────────────────────────

check('the switcher node survives verbatim (id, class, role)', () => {
  assert.ok(
    /<div class="sidebar-tabs" id="sidebar-provider-tabs" role="tablist"><\/div>/.test(html),
    'the same node must be relocated, not replaced: JS binds it by id'
  );
  const occurrences = html.match(/id="sidebar-provider-tabs"/g) || [];
  assert.strictEqual(occurrences.length, 1, 'exactly one switcher mount may exist');
});

check('the switcher sits inside the Discovered section', () => {
  const tabsIdx = html.indexOf('id="sidebar-provider-tabs"');
  const discoveredHeaderIdx = html.indexOf('id="projects-header"');
  const searchBarIdx = html.indexOf('id="projects-search-bar"');
  const listIdx = html.indexOf('id="projects-list"');
  assert.ok(discoveredHeaderIdx > -1 && searchBarIdx > -1 && listIdx > -1, 'Discovered section markup not found');
  assert.ok(tabsIdx > discoveredHeaderIdx, 'the switcher must come after the Discovered header');
  assert.ok(tabsIdx < listIdx, 'the switcher must come before the discovered list it filters');
});

check('the switcher no longer sits above the tracked Projects header', () => {
  const tabsIdx = html.indexOf('id="sidebar-provider-tabs"');
  const trackedHeaderIdx = html.indexOf('id="sidebar-projects-header"');
  assert.ok(trackedHeaderIdx > -1, 'tracked Projects header not found');
  assert.ok(
    tabsIdx > trackedHeaderIdx,
    'a switcher above the tracked Projects section is the placement the user called confusing'
  );
});

// ───────────────────────────────────────────────────────────────────────
// SECTION B: scope wiring
// ───────────────────────────────────────────────────────────────────────

check('the two scopes are named constants, not inline strings', () => {
  assert.ok(
    /static\s+PROVIDER_FILTER_SCOPE_DISCOVERED\s*=\s*'discovered'/.test(src),
    'PROVIDER_FILTER_SCOPE_DISCOVERED must be declared'
  );
  assert.ok(
    /static\s+PROVIDER_FILTER_SCOPE_WORKSPACES\s*=\s*'workspaces'/.test(src),
    'PROVIDER_FILTER_SCOPE_WORKSPACES must be declared'
  );
});

check('renderProjects filters through the DISCOVERED scope', () => {
  const idx = src.indexOf('  renderProjects() {');
  assert.ok(idx > -1, 'renderProjects not found');
  const body = src.slice(idx, idx + 2500);
  assert.ok(
    /const\s+activeTab\s*=\s*this\._providerFilterFor\(CWMApp\.PROVIDER_FILTER_SCOPE_DISCOVERED\)/.test(body),
    'renderProjects must resolve its filter through the discovered scope'
  );
  assert.ok(
    /projects\.filter\(p\s*=>\s*\(p\s*&&\s*\(p\.provider\s*\|\|\s*'claude'\)\)\s*===\s*activeTab\)/.test(body),
    'the project-level filter clause must survive'
  );
});

check('renderWorkspaces resolves the WORKSPACES scope, which never filters', () => {
  const idx = src.indexOf('const matchesActiveProvider');
  assert.ok(idx > -1, 'matchesActiveProvider helper not found');
  const before = src.slice(Math.max(0, idx - 1200), idx);
  assert.ok(
    /const\s+activeTab\s*=\s*this\._providerFilterFor\(CWMApp\.PROVIDER_FILTER_SCOPE_WORKSPACES\)/.test(before),
    'renderWorkspaces must resolve the workspaces scope, not state.activeProviderTab'
  );
  // The helper itself is preserved so the seam stays reversible.
  assert.ok(
    /matchesActiveProvider\s*=\s*\(s\)\s*=>\s*activeTab\s*===\s*'all'/.test(src),
    'the matchesActiveProvider helper must survive intact'
  );
});

check('a project row filters its own sessions by the active scope', () => {
  const idx = src.indexOf('const allSessions = (p.sessions || []).filter(');
  assert.ok(idx > -1, 'row-level session filter not found');
  const body = src.slice(idx, idx + 400);
  assert.ok(
    /activeTab === 'all' \|\| \(s && \(s\.provider \|\| p\.provider \|\| 'claude'\)\) === activeTab/.test(body),
    'a merged cross-provider row must show only the selected provider threads'
  );
});

check('the badge count helpers are declared', () => {
  assert.ok(/\n\s*_providerFilterFor\(scope\)\s*\{/.test(src), '_providerFilterFor missing');
  assert.ok(/\n\s*_countDiscoveredSessions\(id\)\s*\{/.test(src), '_countDiscoveredSessions missing');
  assert.ok(/\n\s*_providerTabBadgeCount\(id\)\s*\{/.test(src), '_providerTabBadgeCount missing');
  // The Phase 18 tracked counters stay: they are the pre-discovery fallback.
  assert.ok(/\n\s*_countAllSessions\(\)\s*\{/.test(src), '_countAllSessions must be preserved');
  assert.ok(/\n\s*_countSessionsByProvider\(id\)\s*\{/.test(src), '_countSessionsByProvider must be preserved');
});

// ───────────────────────────────────────────────────────────────────────
// SECTION C: EXECUTED. Scope resolution and counts against a mixed payload.
// ───────────────────────────────────────────────────────────────────────

/**
 * Extract the switcher helpers from app.js and evaluate them as a standalone
 * class. Same technique as provider-tabs.test.js: the real class needs a DOM,
 * these methods need only `this.state`.
 *
 * @returns {Function} Harness class carrying the extracted methods.
 */
function buildHarness() {
  const startIdx = src.indexOf('async loadProviders()');
  assert.ok(startIdx > -1, 'loadProviders declaration not found');
  const patchIdx = src.indexOf('_patchProviderTabBadges()', startIdx);
  assert.ok(patchIdx > -1, '_patchProviderTabBadges declaration not found');
  const openBrace = src.indexOf('{', patchIdx);
  let depth = 1;
  let i = openBrace + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  // eslint-disable-next-line no-new-func
  return new Function('class Harness {\n' + src.slice(startIdx, i) + '\n}\nreturn Harness;\n')();
}

/**
 * A deterministic mixed discovery payload: two Claude projects carrying three
 * sessions between them, two Codex projects carrying five.
 *
 * @returns {object} The projectsByProvider map GET /api/discover returns.
 */
function mixedDiscoverPayload() {
  return {
    claude: [
      { provider: 'claude', encodedName: 'c1', realPath: 'C:/work/alpha', sessions: [
        { claudeSessionId: 'a1', provider: 'claude' },
        { claudeSessionId: 'a2', provider: 'claude' },
      ] },
      { provider: 'claude', encodedName: 'c2', realPath: 'C:/work/beta', sessions: [
        { claudeSessionId: 'a3', provider: 'claude' },
      ] },
    ],
    codex: [
      { provider: 'codex', encodedName: 'x1', realPath: 'C:/work/alpha', sessions: [
        { claudeSessionId: 'b1', provider: 'codex' },
        { claudeSessionId: 'b2', provider: 'codex' },
        { claudeSessionId: 'b3', provider: 'codex' },
      ] },
      { provider: 'codex', encodedName: 'x2', realPath: 'C:/work/gamma', sessions: [
        { claudeSessionId: 'b4', provider: 'codex' },
        { claudeSessionId: 'b5', provider: 'codex' },
      ] },
    ],
  };
}

/**
 * Build a harness instance with a mixed payload already loaded.
 *
 * @param {string} activeTab The selected provider tab.
 * @returns {object} Harness instance.
 */
function makeHarness(activeTab) {
  const Harness = buildHarness();
  const h = new Harness();
  const byProvider = mixedDiscoverPayload();
  h.state = {
    activeProviderTab: activeTab,
    providers: [
      { id: 'claude', displayName: 'Claude Code', enabled: true },
      { id: 'codex', displayName: 'ChatGPT Codex', enabled: true },
    ],
    // Tracked sessions are deliberately Claude-heavy: this is the shape that
    // produced the original report.
    allSessions: [
      { id: 's1', provider: 'claude' },
      { id: 's2', provider: 'claude' },
      { id: 's3', provider: 'claude' },
      { id: 's4', provider: 'codex' },
    ],
    sessions: [],
    projects: Object.values(byProvider).flat(),
    projectsByProvider: byProvider,
  };
  return h;
}

check('EXECUTED: the discovered scope carries the tab, every other scope is all', () => {
  const h = makeHarness('codex');
  assert.strictEqual(h._providerFilterFor('discovered'), 'codex');
  assert.strictEqual(h._providerFilterFor('workspaces'), 'all');
  assert.strictEqual(h._providerFilterFor('anything-else'), 'all');
});

check('EXECUTED: the All tab still reports all for the discovered scope', () => {
  const h = makeHarness('all');
  assert.strictEqual(h._providerFilterFor('discovered'), 'all');
});

check('EXECUTED: badge counts match the discovered payload per provider', () => {
  const h = makeHarness('codex');
  assert.strictEqual(h._countDiscoveredSessions('all'), 8, 'eight discovered sessions in total');
  assert.strictEqual(h._countDiscoveredSessions('claude'), 3, 'three discovered Claude sessions');
  assert.strictEqual(h._countDiscoveredSessions('codex'), 5, 'five discovered Codex sessions');
  assert.strictEqual(h._countDiscoveredSessions('gemini'), 0, 'an unknown provider counts zero');
  assert.strictEqual(h._providerTabBadgeCount('codex'), 5, 'the Codex badge shows its discovered count');
  assert.strictEqual(h._providerTabBadgeCount('all'), 8, 'the All badge shows every discovered session');
});

check('EXECUTED: counts fall back to tracked sessions before discovery answers', () => {
  const h = makeHarness('all');
  h.state.projectsByProvider = {};
  h.state.projects = [];
  assert.strictEqual(h._countDiscoveredSessions('all'), 0, 'nothing discovered yet');
  assert.strictEqual(h._providerTabBadgeCount('all'), 4, 'the strip falls back to tracked counts');
  assert.strictEqual(h._providerTabBadgeCount('codex'), 1, 'per-provider fallback too');
});

check('EXECUTED: the flat projects array is counted when the map is missing', () => {
  const h = makeHarness('codex');
  h.state.projectsByProvider = null; // a legacy or cached payload
  assert.strictEqual(h._countDiscoveredSessions('codex'), 5, 'flat fallback must agree with the map');
  assert.strictEqual(h._countDiscoveredSessions('all'), 8);
});

check('EXECUTED: the Codex tab renders a strip whose Codex badge is the codex count', () => {
  // renderProviderTabs needs a DOM host and escapeHtml; give it the minimum.
  const origLS = global.localStorage;
  const origDoc = global.document;
  const store = {};
  global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const host = { innerHTML: '', querySelectorAll: () => [] };
  global.document = { getElementById: (id) => (id === 'sidebar-provider-tabs' ? host : null) };
  try {
    const h = makeHarness('codex');
    h.els = { sidebarProviderTabs: host };
    h.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
    h.renderProviderTabs();
    assert.ok(/data-provider="codex"[^>]*>ChatGPT Codex<span class="sidebar-tab-badge">5<\/span>/.test(host.innerHTML),
      'the Codex tab badge must read 5, the discovered Codex session count: ' + host.innerHTML);
    assert.ok(/data-provider="all"[^>]*>All<span class="sidebar-tab-badge">8<\/span>/.test(host.innerHTML),
      'the All tab badge must read 8');
    assert.ok(/class="sidebar-tab active"[^>]*data-provider="codex"/.test(host.innerHTML),
      'the Codex tab must be the active one');
  } finally {
    global.localStorage = origLS;
    global.document = origDoc;
  }
});

(async () => {
  await runQueue();
  console.log('\n  ' + '─'.repeat(42));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('  ' + '─'.repeat(42) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
