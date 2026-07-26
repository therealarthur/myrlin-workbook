#!/usr/bin/env node
/**
 * Mobile UX fixes regression gate (branch fix/mobile-ux).
 *
 * Pure string-match gate over styles.css, styles-mobile.css, and app.js. No
 * DOM, no jsdom, no browser (mirrors css-tokens.test.js and the source-harvest
 * approach of idle-signal-dispatch.test.js). It locks the shape of the mobile
 * fixes so a future refactor cannot silently revert them:
 *
 *   P0-1  Tab strip is touch-scrollable (no touch-action:none on the tab; the
 *         strip and folder header opt into pan-x) and scroll is preserved
 *         across re-renders with the active tab scrolled into view.
 *   P0-2  The More sheet exposes Settings / Appearance / Pair / All sessions.
 *   P0-3  The More sheet routes to secondary, contextual views. Tasks is a
 *          first-level destination in the focused mobile shell.
 *   P1-1  The Settings panel becomes a full-screen sheet on phones.
 *   P1-2  Pane long-press skips the terminal surface; sidebar long-press timers
 *         are cleared on dragstart.
 *   P1-3  Tab groups have a touch long-press context path routed through
 *         _renderContextItems (not the broken session-id overload).
 *   P1-4  The pane context menu can move a terminal to another tab group.
 *   P2    Tab strip edge-fade + scroll-snap, breakpoint-crossing re-render,
 *         and an enlarged mobile tab-close hit area.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');

/**
 * Strip CSS block comments so property assertions never match prose inside a
 * comment (e.g. a comment that mentions the old "touch-action:none" value).
 * @param {string} css Raw stylesheet text.
 * @returns {string} Stylesheet with block comments removed.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const styles = stripCssComments(fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8'));
const stylesMobile = stripCssComments(fs.readFileSync(path.join(PUBLIC, 'styles-mobile.css'), 'utf8'));
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const terminalJs = fs.readFileSync(path.join(PUBLIC, 'terminal.js'), 'utf8');

/**
 * Extract the body of a JS method by name from terminal.js (brace-balanced
 * slice starting at `name(`). Used to assert selection-mode detection logic
 * lives inside the intended method, not merely somewhere in the file. Returns
 * '' when the method cannot be located or balanced.
 * @param {string} src Full source text.
 * @param {string} name Method name preceding the parameter list.
 * @returns {string} The method body between its outermost braces, or ''.
 */
function methodBody(src, name) {
  const sig = src.indexOf(name + '(');
  if (sig === -1) return '';
  const open = src.indexOf('{', sig);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

let passed = 0;
let failed = 0;

/**
 * Run a single named assertion, tallying pass/fail so the exit code reflects
 * the worst outcome instead of bailing on the first failure.
 * @param {string} name Human-readable test name.
 * @param {() => void} fn Function that throws on failure.
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Extract the body of the FIRST top-level CSS rule whose header exactly equals
 * `selector` (a brace-balanced slice). Used to assert a property lives inside a
 * specific rule, not merely somewhere in the file. Returns '' when not found.
 * @param {string} css Full stylesheet text.
 * @param {string} selector Exact selector text preceding the opening brace.
 * @returns {string} The rule body between the braces, or ''.
 */
function ruleBody(css, selector) {
  const needle = selector + ' {';
  const start = css.indexOf(needle);
  if (start === -1) return '';
  const bodyStart = start + needle.length;
  const end = css.indexOf('}', bodyStart);
  if (end === -1) return '';
  return css.slice(bodyStart, end);
}

console.log('\n  \x1b[1mMobile UX fixes (fix/mobile-ux)\x1b[0m');
console.log('  ' + '-'.repeat(48));

// ─── P0-1: tab strip touch-scroll ───────────────────────────────────────────

check('P0-1: .terminal-group-tab no longer sets touch-action: none', () => {
  const body = ruleBody(styles, '.terminal-group-tab');
  assert.ok(body, '.terminal-group-tab rule must exist in styles.css');
  assert.ok(
    !/touch-action:\s*none/.test(body),
    '.terminal-group-tab must NOT use touch-action:none (it forbids strip panning)'
  );
  assert.ok(
    /touch-action:\s*pan-x/.test(body),
    '.terminal-group-tab must use touch-action:pan-x so a finger can pan the strip'
  );
});

check('P0-1: .terminal-groups-tabs opts into pan-x + momentum scrolling', () => {
  const body = ruleBody(styles, '.terminal-groups-tabs');
  assert.ok(body, '.terminal-groups-tabs rule must exist');
  assert.ok(/touch-action:\s*pan-x/.test(body), '.terminal-groups-tabs needs touch-action:pan-x');
  assert.ok(
    /-webkit-overflow-scrolling:\s*touch/.test(body),
    '.terminal-groups-tabs needs -webkit-overflow-scrolling:touch for iOS momentum'
  );
});

check('P0-1: .tab-folder-header opts into pan-x', () => {
  const body = ruleBody(styles, '.tab-folder-header');
  assert.ok(/touch-action:\s*pan-x/.test(body), '.tab-folder-header needs touch-action:pan-x');
});

check('P0-1: renderTerminalGroupTabs preserves scrollLeft across the innerHTML swap', () => {
  assert.ok(
    /const prevScrollLeft = this\.els\.terminalGroupsTabs\.scrollLeft;/.test(appJs),
    'must capture scrollLeft before the innerHTML swap'
  );
  assert.ok(
    /this\.els\.terminalGroupsTabs\.scrollLeft = prevScrollLeft;/.test(appJs),
    'must restore scrollLeft after the innerHTML swap'
  );
});

check('P0-1: _ensureActiveTabVisible scrolls the active tab into view', () => {
  assert.ok(/_ensureActiveTabVisible\(\)\s*\{/.test(appJs), 'helper method must be defined');
  assert.ok(
    /scrollIntoView\(\{\s*inline:\s*'nearest',\s*block:\s*'nearest'\s*\}\)/.test(appJs),
    'must scroll active tab with inline/block nearest (no page jump)'
  );
});

// ─── P0-2 / P0-3: More sheet entries ─────────────────────────────────────────

/**
 * Slice the body of a named method for scoped assertions. Balanced-brace aware
 * enough for these single-method checks (finds the method header then walks to
 * the matching closing brace by counting braces).
 * @param {string} src JS source.
 * @param {string} methodName Method name as it appears before its paren.
 * @returns {string} The method body text, or '' when not found.
 */
function methodBody(src, methodName) {
  const re = new RegExp('\\n  ' + methodName + '\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

check('P0-2: More sheet exposes Settings / Appearance / Pair / All sessions', () => {
  const body = methodBody(appJs, 'showMoreMenu');
  assert.ok(body, 'showMoreMenu must exist');
  assert.ok(/label: 'Settings'.*this\.openSettings\(\)/s.test(body), 'Settings entry missing');
  assert.ok(/label: 'Appearance'.*_buildThemeMenuItems\(\)/s.test(body), 'Appearance submenu missing');
  assert.ok(/label: 'Pair device'.*showPairMobileModal\(\)/s.test(body), 'Pair device entry missing');
  assert.ok(/label: 'All sessions'.*toggleSessionManager\(/s.test(body), 'All sessions entry missing');
});

check('P0-2: mobile submenus open a second sheet instead of flattening', () => {
  const body = methodBody(appJs, 'showActionSheet');
  assert.ok(
    /item\.submenu[\s\S]*this\.showActionSheet\(item\.label,\s*item\.submenu\)/.test(body),
    'submenu rows must open their own action sheet'
  );
  assert.ok(
    !/item\.submenu\.forEach/.test(body),
    'submenus must not be expanded inline into the parent sheet'
  );
  assert.ok(
    /actionSheetOverlay\.hidden\s*=\s*false[\s\S]*actionSheet\.scrollTop\s*=\s*0[\s\S]*requestAnimationFrame/.test(body),
    'each nested sheet must start at its header and first option'
  );
  assert.ok(/_actionSheetReturnFocus/.test(body), 'the sheet must remember its trigger');
  assert.ok(
    /firstItem\.focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(body),
    'each sheet must focus its first enabled command'
  );
});

check('P0-2: Conflicts entry is conditional on active conflict count', () => {
  const body = methodBody(appJs, 'showMoreMenu');
  assert.ok(
    /_currentConflicts \|\| \[\]\)\.length/.test(body),
    'Conflicts entry must read the active conflict count'
  );
  assert.ok(/Conflicts \(\$\{conflictCount\}\)/.test(body), 'Conflicts label must show the count');
});

check('P0-3: More sheet routes to secondary and contextual views', () => {
  const body = methodBody(appJs, 'showMoreMenu');
  assert.ok(/label: 'Recent activity'.*setViewMode\('recent'\)/s.test(body), 'Recent activity entry missing');
  assert.ok(/label: 'Costs'.*setViewMode\('costs'\)/s.test(body), 'Costs entry missing');
  assert.ok(/label: 'System resources'.*setViewMode\('resources'\)/s.test(body), 'System resources entry missing');
  assert.ok(/Project notes.*setViewMode\('docs'\)/s.test(body), 'Project notes entry missing');
});

// ─── P1-1: settings full-screen sheet ────────────────────────────────────────

check('P0-3: secondary mobile views cannot leak terminal or keyboard state', () => {
  assert.ok(
    /\.terminal-grid\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s.test(stylesMobile),
    'the mobile flex terminal grid must still honor its hidden attribute'
  );
  const body = methodBody(appJs, 'setViewMode');
  assert.ok(
    /else\s*\{[\s\S]*classList\.remove\('terminal-active'\)[\s\S]*classList\.remove\('keyboard-open'\)/.test(body),
    'leaving Workbench must clear stale terminal and soft-keyboard layout state'
  );
  assert.ok(
    /tab\.dataset\.view\s*===\s*'more'\s*&&\s*isMoreDestination/.test(body),
    'routes reached through More must leave that bottom destination selected'
  );
});

check('P0-3: focused mobile Sessions opens the list, not the project drawer', () => {
  assert.ok(
    /view === 'workspace'[\s\S]{0,300}dataset\.uiShell === 'focused'/.test(appJs),
    'the workspace handler must distinguish the focused Sessions destination'
  );
  assert.ok(
    /this\.isMobile && focusedShell && this\.state\.sidebarOpen[\s\S]{0,80}this\.toggleSidebar\(\)/.test(appJs),
    'focused Sessions must close an open project drawer'
  );
  assert.ok(
    /this\.isMobile && !focusedShell && !this\.state\.sidebarOpen/.test(appJs),
    'classic mobile must retain its legacy workspace-drawer behavior'
  );
});

check('P1-1: settings panel becomes a full-screen sheet on mobile', () => {
  assert.ok(
    /#settings-overlay \.settings-panel\s*\{[^}]*height:\s*100dvh/s.test(stylesMobile),
    'settings-panel must be 100dvh tall on mobile'
  );
  assert.ok(
    /#settings-overlay \.settings-panel\s*\{[^}]*border-radius:\s*0/s.test(stylesMobile),
    'settings-panel must drop its border-radius on mobile'
  );
  assert.ok(
    /#settings-overlay \.settings-content\s*\{[^}]*grid-template-columns:\s*1fr/s.test(stylesMobile),
    'settings-content must collapse to a single column on mobile'
  );
  assert.ok(
    /#settings-overlay \.settings-nav\s*\{[^}]*display:\s*flex/s.test(stylesMobile),
    'settings-nav must become a horizontal flex strip on mobile'
  );
});

// ─── P1-2: long-press collisions ─────────────────────────────────────────────

check('P1-2(a): pane long-press skips the terminal surface on mobile', () => {
  assert.ok(
    /TERMINAL_SURFACE_SELECTOR = '\.terminal-container, \.xterm'/.test(appJs),
    'terminal surface selector constant must be defined'
  );
  assert.ok(
    /this\.isMobile[\s\S]{0,120}closest\(TERMINAL_SURFACE_SELECTOR\)/.test(appJs),
    'pane touchstart must early-return on mobile when over the terminal surface'
  );
});

check('P1-2(b): sidebar long-press timers cleared on dragstart', () => {
  // Each list's dragstart handler must clear its own long-press timer. Scope
  // the match to the specific list so a stray clearTimeout elsewhere cannot
  // satisfy it; allow a generous window for the explaining comment.
  assert.ok(
    /wsList\.addEventListener\('dragstart'[\s\S]{0,400}?clearTimeout\(wsLPTimer\)/.test(appJs),
    'wsList dragstart must clear wsLPTimer'
  );
  assert.ok(
    /sessList\.addEventListener\('dragstart'[\s\S]{0,400}?clearTimeout\(sessLPTimer\)/.test(appJs),
    'sessList dragstart must clear sessLPTimer'
  );
  assert.ok(
    /projList\.addEventListener\('dragstart'[\s\S]{0,400}?clearTimeout\(projLPTimer\)/.test(appJs),
    'projList dragstart must clear projLPTimer'
  );
});

// ─── P1-3: tab group touch path ──────────────────────────────────────────────

check('P1-3: shared tab-group context builder exists', () => {
  assert.ok(/_buildTerminalTabContextItems\(groupId, tabEl\)\s*\{/.test(appJs), 'builder method must exist');
});

check('P1-3: tab context menu routes through _renderContextItems (not the session overload)', () => {
  // The right-click handler must call the shared builder + _renderContextItems.
  assert.ok(
    /const items = this\._buildTerminalTabContextItems\(groupId, tab\);\s*\n\s*this\._renderContextItems\(/.test(appJs),
    'contextmenu handler must build items and route through _renderContextItems'
  );
  // And the delegated long-press must exist on the strip container.
  assert.ok(
    /tabStrip\.addEventListener\('touchstart'/.test(appJs),
    'a delegated touchstart long-press must be bound on the tab strip'
  );
  assert.ok(
    /tabStrip\.addEventListener\('dragstart', \(\) => clearTimeout\(tabLPTimer\)\)/.test(appJs),
    'the tab long-press timer must be cleared on dragstart'
  );
});

check('P1-3: taller tab + visible close on mobile', () => {
  assert.ok(
    /\.terminal-group-tab-close\s*\{[^}]*opacity:\s*0\.5/s.test(stylesMobile),
    'terminal-group-tab-close must be visible (opacity 0.5) on mobile'
  );
  assert.ok(
    /\.terminal-group-tab\s*\{[^}]*min-height:\s*40px/s.test(stylesMobile),
    'terminal-group-tab must have a taller touch target on mobile'
  );
});

// ─── P1-4: move terminal to another tab group ────────────────────────────────

check('P1-4: pane context menu offers Move to Tab...', () => {
  const body = methodBody(appJs, 'showTerminalContextMenu');
  assert.ok(body, 'showTerminalContextMenu must exist');
  assert.ok(/label: 'Move to Tab\.\.\.'/.test(body), 'Move to Tab entry missing');
  assert.ok(/moveTerminalToGroup\(slotIdx, g\.id\)/.test(body), 'Move to Tab must call moveTerminalToGroup');
  assert.ok(/g\.id !== this\._activeGroupId/.test(body), 'submenu must exclude the current group');
});

// ─── P2: polish bundle ───────────────────────────────────────────────────────

check('P2: tab strip has an edge-fade mask + scroll-snap on mobile', () => {
  assert.ok(/mask-image:\s*linear-gradient\(90deg/.test(stylesMobile), 'edge-fade mask missing');
  assert.ok(/scroll-snap-type:\s*x proximity/.test(stylesMobile), 'scroll-snap-type missing');
  assert.ok(/scroll-snap-align:\s*start/.test(stylesMobile), 'scroll-snap-align missing on tabs');
});

check('P2: breakpoint-crossing listener rebuilds both tab strips', () => {
  assert.ok(
    /matchMedia\('\(max-width: 768px\)'\)/.test(appJs),
    'must observe the 768px media query'
  );
  assert.ok(
    /addEventListener\('change', onBreakpointChange\)/.test(appJs),
    'must listen for the change event'
  );
  assert.ok(
    /onBreakpointChange = \(\) => \{[\s\S]*updateTerminalTabs\(\)[\s\S]*renderTerminalGroupTabs\(\)/.test(appJs),
    'the handler must call both updateTerminalTabs and renderTerminalGroupTabs'
  );
});

check('P2: mobile tab-close has an enlarged hit area', () => {
  assert.ok(
    /\.terminal-tab-close::before\s*\{[^}]*inset:\s*-12px/s.test(stylesMobile),
    'terminal-tab-close::before must extend the tap target by 12px'
  );
});

// ─── P3: desktop mouse selection + copy regression (2026-07-25) ─────────────
// _isMobile() must NOT treat a fine-pointer desktop as mobile. The old test
// used `'ontouchstart' in window`, which is true on desktop Chrome/Edge with
// zero touch hardware. That flipped mobile mode on, which set
// `.xterm-screen { pointer-events: none }` and killed xterm's mousedown-based
// selection, so hasSelection() stayed false, a native highlight could not be
// copied, and Ctrl+C fell through to SIGINT. Lock the tightened detection.

check('P3: _isMobile requires a coarse primary pointer (no ontouchstart-only)', () => {
  const body = methodBody(terminalJs, '_isMobile');
  assert.ok(body, '_isMobile method must exist in terminal.js');
  assert.ok(
    /matchMedia\(\s*['"]\(pointer:\s*coarse\)['"]\s*\)/.test(body),
    '_isMobile must gate on matchMedia("(pointer: coarse)")'
  );
  assert.ok(
    /maxTouchPoints\s*>\s*0/.test(body),
    '_isMobile must still require real touch points (maxTouchPoints > 0)'
  );
  // Strip JS comments before the negative assertion: the method's own
  // explanatory comment quotes the retired `'ontouchstart' in window`
  // expression, and we must assert on executable code, not prose.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(
    !/['"]ontouchstart['"]\s+in\s+window/.test(code),
    '_isMobile must NOT use `\'ontouchstart\' in window` (true on no-touch desktops)'
  );
});

check('P3: _isMobile combines coarse pointer AND touch points (not OR)', () => {
  const body = methodBody(terminalJs, '_isMobile');
  assert.ok(
    /coarsePrimary\s*&&\s*hasTouchPoints/.test(body),
    '_isMobile must return coarsePrimary && hasTouchPoints so a mouse desktop is never mobile'
  );
});

console.log('  ' + '-'.repeat(48));
console.log('  [mobile-ux-fixes] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
