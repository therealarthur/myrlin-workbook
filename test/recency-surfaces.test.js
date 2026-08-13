#!/usr/bin/env node
/**
 * recency-surfaces.test.js - the recency system's contract test.
 * Created: 2026-08-13 (Notion restyle phase P4, work packages P4.8 and P4.9).
 *
 * WHAT IT IS FOR
 *
 * BUILD-CONTRACT.md 2.13 makes recency a product feature with its own
 * acceptance criteria rather than a table sort. Section 2.13.1 says there is
 * exactly ONE recency field, ONE merge rule and ONE formatter, and 2.13.7
 * criterion 2 requires four surfaces to show the same session first at the
 * same moment. That property is only true if all four read one function, and
 * nothing but a test keeps them reading it a year from now.
 *
 * WHAT IT CHECKS
 *
 *   1. The merge itself, executed. getRecentSessions is lifted out of app.js
 *      and run against fixtures, so the sort order, the tie-break, the
 *      cross-provider interleave, the deduplication and every exclusion are
 *      verified behaviourally rather than by reading the source.
 *   2. The four surfaces all call it, and none of them re-implements a sort.
 *   3. The single formatter rule: relativeTime is the only time formatter and
 *      the sub-minute reduced-precision rule holds.
 *
 * WHY THE SOURCE IS LIFTED RATHER THAN IMPORTED
 *
 * app.js is a 26000-line browser class with no module boundary; requiring it
 * in Node would execute a DOM-dependent constructor. The same trick the other
 * frontend tests use applies here: read the file, cut out the one method by
 * balanced braces, and evaluate it against a hand-built `this`. That keeps the
 * assertion honest (it runs the shipped code) without pulling in a browser.
 *
 * MECHANICS: pure string parsing plus one Function() over an extracted method.
 * No DOM, no browser, no network, no server, no port.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8'
).replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  - ' + detail : '')); }
}

/**
 * Extract one balanced-brace method body by name.
 *
 * @param {string} src - Normalised source.
 * @param {string} name - Method name as it appears at its definition.
 * @returns {string} The body including its braces, or '' when not found.
 */
function methodBody(src, name) {
  const at = src.indexOf('\n  ' + name + '(');
  if (at === -1) return '';
  const paren = src.indexOf('(', at);
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { afterParams = i + 1; break; }
  }
  if (afterParams === -1) return '';
  const open = src.indexOf('{', afterParams);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

/**
 * Extract a method's parameter list plus body and build a callable function.
 *
 * @param {string} name - Method name.
 * @returns {Function|null} A function to call with an explicit `this`.
 */
function liftMethod(name) {
  const at = APP_JS.indexOf('\n  ' + name + '(');
  if (at === -1) return null;
  const paren = APP_JS.indexOf('(', at);
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < APP_JS.length; i++) {
    if (APP_JS[i] === '(') parens++;
    else if (APP_JS[i] === ')' && --parens === 0) { afterParams = i + 1; break; }
  }
  const params = APP_JS.slice(paren + 1, afterParams - 1);
  const body = methodBody(APP_JS, name);
  if (!body) return null;
  // eslint-disable-next-line no-new-func
  return new Function('CWMApp', 'return function (' + params + ') ' + body + ';')({
    RECENCY_QUICK_FIND_LIMIT: 8,
    RECENCY_SIDEBAR_LIMIT: 5,
    RECENCY_WORKBENCH_LIMIT: 4,
  });
}

/* ─── 1. The merge, executed ────────────────────────────────────────────── */

const getRecentSessions = liftMethod('getRecentSessions');
check('getRecentSessions can be lifted out of app.js and called', typeof getRecentSessions === 'function');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-13T12:00:00.000Z');

/**
 * Build the `this` getRecentSessions expects: the two state slices it reads
 * plus the two helpers it calls.
 *
 * @param {Object} over - State overrides.
 * @returns {Object} A stand-in for the app instance.
 */
function ctx(over) {
  return Object.assign({
    state: {
      allSessions: [],
      projectsByProvider: {},
      hiddenSessions: new Set(),
      hiddenProjectSessions: new Set(),
      hiddenProjects: new Set(),
    },
    projectLabelFromPath(dir) {
      if (!dir) return '';
      const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/);
      return parts[parts.length - 1] || dir;
    },
    getProjectSessionTitle() { return null; },
  }, over);
}

const base = ctx({
  state: {
    allSessions: [
      { id: 's-old', name: 'Old Claude', provider: 'claude', workingDir: 'C:/w/alpha', status: 'stopped', lastActive: new Date(NOW - 3 * HOUR).toISOString() },
      { id: 's-new', name: 'New Claude', provider: 'claude', workingDir: 'C:/w/beta', status: 'running', lastActive: new Date(NOW - 1 * HOUR).toISOString() },
    ],
    projectsByProvider: {
      codex: [{
        encodedName: 'enc-gamma', realPath: 'C:/w/gamma', displayName: 'gamma',
        sessions: [
          { claudeSessionId: 'cx-1', provider: 'codex', lastActiveAt: null, lastActiveMs: NOW - 60 * 1000, title: 'Codex one' },
          { claudeSessionId: 'cx-archived', provider: 'codex', lastActiveMs: NOW, title: 'Archived', archived: true },
        ],
      }],
    },
    hiddenSessions: new Set(),
    hiddenProjectSessions: new Set(),
    hiddenProjects: new Set(),
  },
});

const merged = getRecentSessions.call(base, 0);

check('the merged list is one flat cross-provider array, newest first',
  merged.map(r => r.id).join(',') === 'cx-1,s-new,s-old',
  merged.map(r => r.id + '@' + r.lastActiveAt).join(' '));

check('a Codex session active a minute ago sorts above a Claude session active an hour ago (criterion 4)',
  merged[0].providerId === 'codex' && merged[1].providerId === 'claude');

check('an archived thread never appears',
  !merged.some(r => r.id === 'cx-archived'));

check('every row carries the fields the four surfaces render',
  merged.every(r => typeof r.key === 'string' && typeof r.title === 'string'
    && typeof r.providerId === 'string' && typeof r.lastActiveAt === 'number'
    && 'projectLabel' in r && 'status' in r));

check('the project label is the folder name, not the whole path',
  merged.find(r => r.id === 's-new').projectLabel === 'beta');

check('the limit argument slices, and 0 means everything',
  getRecentSessions.call(base, 1).length === 1 && getRecentSessions.call(base, 0).length === 3);

/* Deduplication: an adopted upstream session appears once, under its own name. */
const adopted = ctx({
  state: {
    allSessions: [
      { id: 's-1', name: 'Adopted', provider: 'codex', resumeSessionId: 'cx-1', workingDir: 'C:/w/gamma', status: 'stopped', lastActive: new Date(NOW - HOUR).toISOString() },
    ],
    projectsByProvider: {
      codex: [{ encodedName: 'e', realPath: 'C:/w/gamma', sessions: [
        { claudeSessionId: 'cx-1', provider: 'codex', lastActiveMs: NOW, title: 'Upstream copy' },
      ] }],
    },
    hiddenSessions: new Set(),
    hiddenProjectSessions: new Set(),
    hiddenProjects: new Set(),
  },
});
const dedup = getRecentSessions.call(adopted, 0);
check('an upstream session the workbook has adopted appears exactly once, under its own record',
  dedup.length === 1 && dedup[0].kind === 'session' && dedup[0].title === 'Adopted',
  JSON.stringify(dedup.map(r => r.title)));

/* Exclusions, all three (criterion 6). */
const hidden = ctx({
  state: {
    allSessions: [
      { id: 's-hidden', name: 'Hidden session', lastActive: new Date(NOW).toISOString() },
      { id: 's-shown', name: 'Shown', lastActive: new Date(NOW - HOUR).toISOString() },
    ],
    projectsByProvider: {
      claude: [
        { encodedName: 'hidden-proj', realPath: 'C:/w/h', sessions: [{ claudeSessionId: 'u-1', lastActiveMs: NOW }] },
        { encodedName: 'ok-proj', realPath: 'C:/w/o', sessions: [{ claudeSessionId: 'u-hidden', lastActiveMs: NOW }] },
      ],
    },
    hiddenSessions: new Set(['s-hidden']),
    hiddenProjectSessions: new Set(['u-hidden']),
    hiddenProjects: new Set(['hidden-proj']),
  },
});
const visible = getRecentSessions.call(hidden, 0).map(r => r.id);
check('hidden sessions, hidden project sessions and hidden projects are all excluded (criterion 6)',
  visible.length === 1 && visible[0] === 's-shown',
  visible.join(','));

/* The tie-break has to be deterministic or two surfaces disagree on refresh. */
const tied = ctx({
  state: {
    allSessions: [
      { id: 'aaa', name: 'A', lastActive: new Date(NOW).toISOString() },
      { id: 'zzz', name: 'Z', lastActive: new Date(NOW).toISOString() },
      { id: 'mmm', name: 'M', lastActive: new Date(NOW).toISOString() },
    ],
    projectsByProvider: {},
    hiddenSessions: new Set(),
    hiddenProjectSessions: new Set(),
    hiddenProjects: new Set(),
  },
});
const order1 = getRecentSessions.call(tied, 0).map(r => r.id).join(',');
const order2 = getRecentSessions.call(tied, 0).map(r => r.id).join(',');
check('equal timestamps break on id DESCENDING, stably across renders (2.13.1 merge rule)',
  order1 === 'zzz,mmm,aaa' && order1 === order2, order1);

/* A session with no signal at all still sorts somewhere sane. */
const noStamp = ctx({
  state: {
    allSessions: [
      { id: 's-none', name: 'No stamp' },
      { id: 's-created', name: 'Created only', createdAt: new Date(NOW).toISOString() },
    ],
    projectsByProvider: {},
    hiddenSessions: new Set(),
    hiddenProjectSessions: new Set(),
    hiddenProjects: new Set(),
  },
});
check('a session with no lastActive falls back to its creation time, and one with neither sorts last',
  getRecentSessions.call(noStamp, 0).map(r => r.id).join(',') === 's-created,s-none');

/* ─── 2. All four surfaces read the one list ────────────────────────────── */

const qsBody = methodBody(APP_JS, 'renderQuickSwitcherResults');
check('Quick Find zero-query reads getRecentSessions, at the contract limit of 8',
  qsBody.includes('this.getRecentSessions(CWMApp.RECENCY_QUICK_FIND_LIMIT)'));
check('Quick Find highlights its first row on open, so Ctrl+K then Enter opens it (criterion 1)',
  /qsHighlightIndex\s*<\s*0\)\s*this\.qsHighlightIndex\s*=\s*0/.test(qsBody));
check('the zero-query branch lives INSIDE renderQuickSwitcherResults, not in a new method',
  qsBody.length > 0 && APP_JS.indexOf('renderQuickSwitcherResults(query)') !== -1);

const sidebarBody = methodBody(APP_JS, 'renderRecentSection');
check('the sidebar Recent section reads getRecentSessions, at the contract limit of 5',
  sidebarBody.includes('this.getRecentSessions(CWMApp.RECENCY_SIDEBAR_LIMIT)'));
check('the sidebar section hides itself rather than rendering an empty labelled box',
  /rows\.length === 0[\s\S]{0,120}section\.hidden = true/.test(sidebarBody));
check('the Recent section persists its collapsed state under cwm_recentCollapsed',
  APP_JS.includes("static RECENT_COLLAPSED_KEY = 'cwm_recentCollapsed'"));

const workbenchBody = methodBody(APP_JS, 'renderWorkbenchRecent');
check('the workbench continue row reads getRecentSessions, at the contract limit of 4',
  workbenchBody.includes('this.getRecentSessions(CWMApp.RECENCY_WORKBENCH_LIMIT)'));

const tableBody = methodBody(APP_JS, 'renderSessions');
check('the sessions table sorts through the shared sort helper, not a local comparator',
  tableBody.includes('this.sortSessionsBy(sessions, sort.key, sort.dir)'));
check('the sessions table default sort is last active, descending (2.13.4)',
  /fallback = \{ key: 'lastActive', dir: 'desc' \}/.test(methodBody(APP_JS, 'getSessionsSort')));
check('the sessions table persists its sort under cwm_sessionsSort',
  APP_JS.includes("static SESSIONS_SORT_KEY = 'cwm_sessionsSort'"));
check('the Last active column carries data-sort, matching the existing th[data-sort] idiom',
  /key: 'lastActive', label: 'Last active'/.test(tableBody) && /data-sort="\$\{c\.key\}"/.test(tableBody));

/* ─── 3. One formatter, and the reduced-precision rule ──────────────────── */

const relBody = methodBody(APP_JS, 'relativeTime');
check('relativeTime exists and is the only formatter of its kind',
  relBody.length > 0 && !/\brelativeTime2|formatRelative|timeAgo\s*\(/.test(APP_JS));
check('under one minute reads `just now`, never `{n}s ago` (2.13.1 reduced precision)',
  /if \(seconds < 60\) return 'just now';/.test(relBody) && !/\$\{seconds\}s ago/.test(relBody));
check('every recency surface formats through relativeTime',
  methodBody(APP_JS, 'recentRowInnerHtml').includes('this.relativeTime(')
  && workbenchBody.includes('this.relativeTime(')
  && tableBody.includes('this.relativeTime('));

/* ─── 4. The sidebar split constant is measured, not guessed (R12) ──────── */

const splitBody = methodBody(APP_JS, 'initSidebarSectionResize');
check('the sidebar splitter measures its chrome instead of subtracting a hard-coded 200',
  splitBody.includes('this.measureSidebarChromeHeight()') && !/sidebarRect\.height - 200/.test(splitBody));
const measureBody = methodBody(APP_JS, 'measureSidebarChromeHeight');
check('the measurement is the complement of the two lists, so a new section counts automatically',
  measureBody.includes('total - lists'));
check('an unusable measurement falls back rather than handing the splitter a negative range',
  measureBody.includes('CWMApp.SIDEBAR_CHROME_FALLBACK_PX'));

console.log('  ──────────────────────────────────────────');
console.log('  [recency-surfaces] ' + passed + '/' + (passed + failed) + ' tests passed');
if (failed > 0) process.exit(1);
