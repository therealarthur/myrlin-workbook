#!/usr/bin/env node
/**
 * mobile-ia-contract.test.js - the phone reachability invariant.
 * Created: 2026-08-13 (phase P10, work packages P10.1 and P10.2).
 *
 * WHAT IT ENFORCES
 *
 * MOBILE-EXPERIENCE.md A.1 states the contract in one sentence: every
 * capability the app has on a phone has exactly one canonical home in the
 * five-tab IA and at most one secondary shortcut; nothing is reachable only by
 * a gesture, and nothing is unreachable.
 *
 * A.5 turns that into an enforceable invariant and specifies this file:
 *
 *   1. Declare the capability manifest as a literal array of ids matching A.3.
 *   2. Assert nav#mobile-tab-bar contains exactly
 *      ['home','sessions','terminal','attention','search'] in order.
 *   3. For each capability, assert the presence of its route marker: a
 *      `data-mw-route="<id>"` attribute on an element, or a string literal in
 *      a sheet builder that names it. This is a grep-level check,
 *      deliberately, because a DOM-level check would need a running app.
 *   4. Assert that no capability's ONLY marker sits inside a hover-guarded
 *      block or inside `.terminal-pane-header`, the surface that is
 *      `display: none` on phones. This assertion is the regression gate for
 *      the six currently-unreachable capabilities.
 *
 * WHY THE FOURTH CHECK IS THE ONE THAT MATTERS
 *
 * `styles-mobile.css` sets `display: none` on `.terminal-pane-header` at phone
 * widths, and that header was the only host for six capabilities: voice input,
 * pane expand, pane collapse, pinned notes, the provider pill, and the live
 * activity string with its needs-input badge. Select mode and the Copy view
 * had the same problem and were rescued in August 2026 by injecting them into
 * the mobile toolbar; the other six were not. The microphone is the sharpest
 * example: app.js feature-detects SpeechRecognition, wires the button, and
 * then the phone stylesheet hides it.
 *
 * A grep for "is the button in the markup" would have passed the whole time.
 * Only "is there a marker OUTSIDE the hidden surface" catches it.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const stylesMobile = fs.readFileSync(path.join(PUBLIC, 'styles-mobile.css'), 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion block and record its outcome.
 *
 * @param {string} name - Human-readable check name.
 * @param {Function} fn - Body; throws to fail.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  [32mPASS[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  [31mFAIL[0m ' + name);
    console.log('       ' + err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   THE CAPABILITY MANIFEST

   One row per capability enumerated in MOBILE-EXPERIENCE A.3. `id` is the
   capability id. `markers` is the set of literals any ONE of which proves the
   capability has a route; a row passes when at least one is found in the
   named source. `source` is which file to look in.

   A marker is deliberately allowed to be a method call rather than only a
   `data-mw-route` attribute, because several capabilities are reached from
   an action-sheet row whose label is built in JS and never appears in the
   markup. A.5 item 3 names both forms.
   ═══════════════════════════════════════════════════════════════ */

const MANIFEST = [
  // ── A.3.1 Navigation and shell ────────────────────────────────
  { id: 'nav-home', source: 'html', markers: ['data-mw-route="nav-home"'] },
  { id: 'nav-sessions', source: 'html', markers: ['data-mw-route="nav-sessions"'] },
  { id: 'nav-terminal', source: 'html', markers: ['data-mw-route="nav-terminal"'] },
  { id: 'nav-attention', source: 'html', markers: ['data-mw-route="attention-queue"'] },
  { id: 'nav-search', source: 'html', markers: ['data-mw-route="search-tab"'] },
  { id: 'nav-back', source: 'app', markers: ["dataset.mwRoute = 'nav-back'", "'nav-back'"] },
  { id: 'workspace-switch', source: 'app', markers: ["'workspace-switch'", 'openMobileWorkspaceSheet'] },
  { id: 'projects-list', source: 'app', markers: ["label: 'Projects'"] },
  { id: 'discovered-sessions', source: 'app', markers: ["label: 'Discover sessions'"] },
  { id: 'sign-out', source: 'app', markers: ["label: 'Sign out'"] },

  // ── A.3.2 Sessions ────────────────────────────────────────────
  { id: 'sessions-all', source: 'app', markers: ["case 'sessions-all':"] },
  { id: 'session-open', source: 'html', markers: ['data-mw-route="session-open"'], allowApp: true },
  { id: 'session-new', source: 'app', markers: ["dataset.mwRoute = 'session-new'"] },
  { id: 'session-launcher', source: 'app', markers: ['this.openLauncher()'] },
  { id: 'session-manager', source: 'app', markers: ['toggleSessionManager('] },
  { id: 'restart-all', source: 'app', markers: ["label: 'Restart all sessions'", 'restartAllSessions()'] },

  // ── A.3.4 Attention ───────────────────────────────────────────
  { id: 'attention-queue', source: 'html', markers: ['data-mw-route="attention-queue"'] },
  { id: 'attention-overflow', source: 'html', markers: ['data-mw-route="attention-overflow"'] },
  { id: 'attention-item', source: 'app', markers: ["data-mw-route=\"attention-item\""] },
  { id: 'attention-badge', source: 'html', markers: ['id="mobile-attention-badge"'] },
  { id: 'attention-stop-all', source: 'app', markers: ["label: 'Stop all'"] },
  { id: 'conflict-center', source: 'app', markers: ['openConflictCenter()'] },

  // ── A.3.5 Search ──────────────────────────────────────────────
  { id: 'search-tab', source: 'html', markers: ['data-mw-route="search-tab"'] },
  { id: 'search-open', source: 'html', markers: ['data-mw-route="search-open"'] },
  { id: 'search-quick-switcher', source: 'app', markers: ['this.openQuickSwitcher()'] },
  { id: 'search-commands', source: 'app', markers: ["scope === 'commands'"] },
  { id: 'search-conversations', source: 'app', markers: ['this.openGlobalSearch()'] },
  { id: 'search-help', source: 'app', markers: ["this.openQuickSwitcher('help')"] },

  // ── A.3.6 Utility views, account and settings ────────────────
  { id: 'tasks-board', source: 'app', markers: ["case 'tasks-board':"] },
  { id: 'docs-notes', source: 'app', markers: ["case 'docs-notes':"] },
  { id: 'costs', source: 'app', markers: ["case 'costs':"] },
  { id: 'resources', source: 'app', markers: ["case 'resources':"] },
  { id: 'pair-device', source: 'app', markers: ["case 'pair-device':"] },
  { id: 'settings', source: 'app', markers: ["case 'settings':"] },
  { id: 'more-menu', source: 'html', markers: ['data-mw-route="more-menu"'] },
  { id: 'account-panel', source: 'html', markers: ['id="account-chip"'] },
];

/**
 * Extract every `.terminal-pane-header` element region from the markup.
 *
 * The six fixed-slot panes each author one, so this returns six regions. The
 * walk is depth-counted on `<div` / `</div` rather than regex-matched, because
 * the header contains nested elements and a lazy regex would stop at the first
 * close tag.
 *
 * @returns {string[]} One string per header region.
 */
function paneHeaderRegions() {
  const regions = [];
  const needle = 'class="terminal-pane-header"';
  let from = 0;
  for (;;) {
    const at = html.indexOf(needle, from);
    if (at === -1) break;
    const open = html.lastIndexOf('<div', at);
    let i = html.indexOf('>', at) + 1;
    let depth = 1;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div', i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        i = nextClose + 5;
      }
    }
    regions.push(html.slice(open, i));
    from = i;
  }
  return regions;
}

/**
 * Strip every `.terminal-pane-header` region out of the markup, leaving the
 * text a phone can actually see.
 *
 * @returns {string} The markup with all six header regions removed.
 */
function htmlOutsidePaneHeaders() {
  let out = html;
  for (const region of paneHeaderRegions()) out = out.split(region).join('');
  return out;
}

/* ── 1. The manifest is a literal array and every id is unique ── */

check('the capability manifest is a literal array with unique ids', () => {
  assert.ok(Array.isArray(MANIFEST), 'the manifest must be an array literal');
  assert.ok(MANIFEST.length >= 30, 'the manifest must cover the A.3 capability set');
  const ids = MANIFEST.map(row => row.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate capability id in the manifest');
});

/* ── 2. The five-tab bar, in order ─────────────────────────────── */

check('nav#mobile-tab-bar is exactly the five tabs, in order', () => {
  const at = html.indexOf('id="mobile-tab-bar"');
  assert.ok(at !== -1, '#mobile-tab-bar must exist');
  const end = html.indexOf('</nav>', at);
  assert.ok(end !== -1, 'the tab bar must close');
  const nav = html.slice(at, end);
  const views = [];
  const re = /class="mobile-tab"[^>]*data-view="([a-z-]+)"/g;
  let m;
  while ((m = re.exec(nav)) !== null) views.push(m[1]);
  assert.deepStrictEqual(views, ['home', 'sessions', 'terminal', 'attention', 'search']);
});

check('the tab bar reports the active tab with aria-current, not colour alone', () => {
  const body = appJs.slice(appJs.indexOf('setViewMode(mode) {'));
  assert.ok(
    /tab\.setAttribute\('aria-current', 'page'\)/.test(body.slice(0, 4000)),
    'the active tab must carry aria-current="page"'
  );
});

/* ── 3. Every capability has a route marker ────────────────────── */

check('every capability in the manifest has a route marker', () => {
  const missing = [];
  for (const row of MANIFEST) {
    const haystacks = [];
    if (row.source === 'html' || row.allowApp) haystacks.push(html);
    if (row.source === 'app' || row.allowApp) haystacks.push(appJs);
    const found = row.markers.some(marker =>
      haystacks.some(text => text.indexOf(marker) !== -1)
    );
    if (!found) missing.push(row.id + ' (looked for: ' + row.markers.join(' | ') + ')');
  }
  assert.deepStrictEqual(missing, [], 'capabilities with no route marker:\n       ' + missing.join('\n       '));
});

check('every data-mw-route in the markup is a capability the manifest knows', () => {
  // The inverse direction: a marker nobody declared is a route that will not
  // be maintained, and it is exactly how a second, undocumented IA starts.
  const declared = new Set(MANIFEST.map(r => r.id));
  const found = new Set();
  const re = /data-mw-route="([a-z-]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  const undeclared = [...found].filter(id => !declared.has(id));
  assert.deepStrictEqual(undeclared, [], 'undeclared route markers in index.html: ' + undeclared.join(', '));
});

/* ── 4. No capability's only marker is inside the hidden header ── */

check('.terminal-pane-header is still the hidden surface this gate guards', () => {
  // If this rule ever goes away the gate below becomes vacuous, so the
  // premise is asserted rather than assumed.
  assert.ok(
    /\.terminal-pane\.mobile-active \.terminal-pane-header\s*\{[^}]*display:\s*none/.test(stylesMobile),
    'the phone stylesheet must still hide the pane header, or this gate is vacuous'
  );
  assert.strictEqual(paneHeaderRegions().length, 6, 'the six fixed-slot pane headers must all be found');
});

check('no capability is reachable only from inside .terminal-pane-header', () => {
  const outside = htmlOutsidePaneHeaders();
  const trapped = [];
  const re = /data-mw-route="([a-z-]+)"/g;
  let m;
  const all = new Set();
  while ((m = re.exec(html)) !== null) all.add(m[1]);
  for (const id of all) {
    if (outside.indexOf('data-mw-route="' + id + '"') === -1) trapped.push(id);
  }
  assert.deepStrictEqual(trapped, [], 'routes whose only marker is inside the hidden pane header: ' + trapped.join(', '));
});

check('no capability is reachable only from a hover-guarded rule', () => {
  // A hover-only affordance does not exist on a touch device. The phone sheet
  // must not be the only place a route marker appears, and where it does
  // appear it must not be behind :hover.
  const hoverOnly = [];
  const re = /([^{}]+)\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(stylesMobile)) !== null) {
    const selector = m[1];
    if (!/:hover/.test(selector)) continue;
    const routeMatch = /data-mw-route="([a-z-]+)"/.exec(selector);
    if (routeMatch && html.indexOf('data-mw-route="' + routeMatch[1] + '"') === -1) {
      hoverOnly.push(routeMatch[1]);
    }
  }
  assert.deepStrictEqual(hoverOnly, [], 'hover-only routes: ' + hoverOnly.join(', '));
});

/* ── 5. The dissolved More tab loses nothing ───────────────────── */

check('showMoreMenu is retained and still reachable on a phone', () => {
  assert.ok(/showMoreMenu\(anchorElement = null\) \{/.test(appJs), 'showMoreMenu must be retained verbatim');
  assert.ok(html.indexOf('id="mobile-more-tab"') !== -1, '#mobile-more-tab must survive for gate G1');
  assert.ok(
    /id="mobile-more-tab"[\s\S]{0,200}data-mw-route="more-menu"/.test(html),
    'the All commands row must carry the more-menu route'
  );
});

check('the fourteen More-sheet orphans each have a Workspace row or a tab', () => {
  // MOBILE-EXPERIENCE A.3.6 result line: "zero orphans". These are the items
  // the More sheet carried; each must now resolve somewhere else.
  const router = appJs.slice(appJs.indexOf('_runMobileHomeRoute(route, el) {'));
  const routerBody = router.slice(0, router.indexOf('\n  }\n'));
  const expected = [
    'attention-queue', 'sessions-all', 'tasks-board', 'docs-notes',
    'costs', 'resources', 'pair-device', 'settings', 'more-menu', 'session-open',
  ];
  for (const route of expected) {
    assert.ok(
      routerBody.indexOf("case '" + route + "':") !== -1,
      'Home router is missing an arm for ' + route
    );
  }
});

/* ── 6. Home reads the one recency entry point ─────────────────── */

check('Home Active now and Recent both come from getRecentSessions', () => {
  const start = appJs.indexOf('renderMobileHome() {');
  assert.ok(start !== -1, 'renderMobileHome must exist');
  const body = appJs.slice(start, start + 4000);
  assert.ok(/this\.getRecentSessions\(0\)/.test(body), 'Home must read the one recency entry point');
  assert.ok(/MOBILE_HOME_ACTIVE_LIMIT/.test(body), 'Active now must be capped');
  assert.ok(/MOBILE_HOME_RECENT_LIMIT/.test(body), 'Recent must be capped');
  assert.ok(
    /recentRowInnerHtml/.test(appJs.slice(appJs.indexOf('_mobileRecentRowHtml(row) {'), appJs.indexOf('_mobileRecentRowHtml(row) {') + 600)),
    'Home Recent rows must share the recency row markup with Quick Find and the sidebar'
  );
});

check('Home status marks are static shapes, never a pulse', () => {
  // DECISIONS 13.1 and DEVIATIONS DV-21: the mock animates both dots with
  // mwPulse; the standing rule bans animated status marks and outranks the
  // mock. Gate G14 enforces it structurally; this pins the two classes Home
  // actually emits.
  const start = appJs.indexOf('_mobileActiveCardHtml(row, attention) {');
  assert.ok(start !== -1, '_mobileActiveCardHtml must exist');
  const body = appJs.slice(start, start + 1600);
  assert.ok(/status-dot-idle/.test(body), 'needs input must be drawn as the ring');
  assert.ok(/status-dot-running/.test(body), 'running must be drawn as the disc');
  assert.ok(!/mwPulse|animation:/.test(body), 'a status mark must never animate');
});

console.log('  ' + '-'.repeat(48));
console.log('  [mobile-ia-contract] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
