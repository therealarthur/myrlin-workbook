#!/usr/bin/env node
/**
 * Focused-shell async ownership regressions.
 *
 * These tests harvest the real app.js methods and execute them against small
 * deterministic fakes. They protect the boundaries where a slow response for
 * project A previously overwrote or mutated the later project B/C selection.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const source = fs.readFileSync(APP_JS_PATH, 'utf8');

let passed = 0;
let failed = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function extractAsyncMethod(name, nextName, globals = {}) {
  const startToken = `  async ${name}(`;
  const endToken = `\n  ${nextName}(`;
  const start = source.indexOf(startToken);
  assert.notStrictEqual(start, -1, `missing ${startToken}`);
  const end = source.indexOf(endToken, start);
  assert.notStrictEqual(end, -1, `missing boundary ${endToken}`);
  const method = source.slice(start, end)
    .replace(new RegExp(`^  async ${name}\\(`), `async function ${name}(`);
  return new Function(
    'window',
    'localStorage',
    'document',
    `${method}\nreturn ${name};`
  )(
    globals.window || { confirm: () => true },
    globals.localStorage || {
      setItem() {},
      removeItem() {},
      getItem() { return null; },
    },
    globals.document || {
      querySelector() { return null; },
      getElementById() { return null; },
    }
  );
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}`);
  }
}

async function main() {
  console.log('\n  Workspace/session async ownership');
  console.log(`  ${'-'.repeat(58)}`);

  await check('A -> B -> C activation serializes writes, skips B, and finishes on C', async () => {
    const selectWorkspace = extractAsyncMethod('selectWorkspace', 'async createWorkspace');
    const activationA = deferred();
    const activationC = deferred();
    const calls = [];
    let sessionLoads = 0;
    const ctx = {
      state: {
        activeWorkspace: null,
        workspaces: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        viewMode: 'workspace',
        docsRawMode: false,
        docs: null,
        sidebarOpen: false,
      },
      els: {},
      renderWorkspaces() {},
      renderDocs() {},
      hideNotesEditor() {},
      async loadSessions() { sessionLoads++; return true; },
      api(method, route) {
        calls.push(`${method} ${route}`);
        if (route.includes('/A/')) return activationA.promise;
        if (route.includes('/C/')) return activationC.promise;
        throw new Error(`superseded activation unexpectedly started: ${route}`);
      },
    };

    const promiseA = selectWorkspace.call(ctx, 'A');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(calls, ['POST /api/workspaces/A/activate']);

    const promiseB = selectWorkspace.call(ctx, 'B');
    const promiseC = selectWorkspace.call(ctx, 'C');
    assert.strictEqual(ctx.state.activeWorkspace.id, 'C');

    activationA.resolve({});
    await promiseA;
    await promiseB;
    await Promise.resolve();
    assert.deepStrictEqual(calls, [
      'POST /api/workspaces/A/activate',
      'POST /api/workspaces/C/activate',
    ]);

    activationC.resolve({});
    await promiseC;
    assert.strictEqual(ctx.state.activeWorkspace.id, 'C');
    assert.strictEqual(calls.at(-1), 'POST /api/workspaces/C/activate');
    assert.strictEqual(sessionLoads, 1, 'only the winning selection may load sessions');
  });

  await check('failed latest activation restores the last server-confirmed project and reports it', async () => {
    const stored = new Map();
    const selectWorkspace = extractAsyncMethod(
      'selectWorkspace',
      'async createWorkspace',
      {
        localStorage: {
          setItem(key, value) { stored.set(key, value); },
          removeItem(key) { stored.delete(key); },
          getItem(key) { return stored.get(key) || null; },
        },
      }
    );
    const activationA = deferred();
    const calls = [];
    const toasts = [];
    let sessionLoads = 0;
    const ctx = {
      state: {
        activeWorkspace: null,
        workspaces: [
          { id: 'A', name: 'Alpha' },
          { id: 'C', name: 'Charlie' },
        ],
        viewMode: 'workspace',
        docsRawMode: false,
        docs: null,
        sidebarOpen: false,
      },
      els: {},
      renderWorkspaces() {},
      renderDocs() {},
      hideNotesEditor() {},
      showToast(message, kind) { toasts.push([message, kind]); },
      async loadSessions() { sessionLoads++; return true; },
      api(method, route) {
        calls.push(`${method} ${route}`);
        if (route.includes('/A/')) return activationA.promise;
        if (route.includes('/C/')) return Promise.reject(new Error('activation denied'));
        throw new Error(`unexpected activation: ${route}`);
      },
    };

    const promiseA = selectWorkspace.call(ctx, 'A');
    await Promise.resolve();
    await Promise.resolve();
    const promiseC = selectWorkspace.call(ctx, 'C');
    assert.strictEqual(ctx.state.activeWorkspace.id, 'C', 'selection is optimistic while queued');

    activationA.resolve({});
    await promiseA;
    await promiseC;

    assert.deepStrictEqual(calls, [
      'POST /api/workspaces/A/activate',
      'POST /api/workspaces/C/activate',
    ]);
    assert.strictEqual(
      ctx.state.activeWorkspace.id,
      'A',
      'failed C must roll back to server-confirmed A'
    );
    assert.strictEqual(stored.get('cwm_activeWorkspace'), 'A');
    assert.strictEqual(sessionLoads, 1, 'rollback project must refresh the active session view');
    assert.strictEqual(toasts.length, 1);
    assert.strictEqual(toasts[0][1], 'error');
    assert.match(toasts[0][0], /Failed to activate "Charlie"/);
    assert.match(toasts[0][0], /Restored "Alpha"/);
  });

  await check('slow project-A session response cannot overwrite project B', async () => {
    const loadSessions = extractAsyncMethod('loadSessions', 'async loadStats');
    const oldProjectResponse = deferred();
    let allRequestCount = 0;
    const calls = [];
    const reconciled = [];
    const ctx = {
      state: {
        viewMode: 'workspace',
        activeWorkspace: { id: 'A' },
        settings: { enableWorktreeTasks: false },
        sessions: [],
        allSessions: [],
        selectedSession: null,
      },
      api(method, route) {
        calls.push(route);
        if (route === '/api/sessions?mode=all') {
          allRequestCount++;
          return Promise.resolve({
            sessions: [{ id: allRequestCount === 1 ? 'all-A' : 'all-B', status: 'running' }],
          });
        }
        if (route.includes('workspaceId=A')) return oldProjectResponse.promise;
        if (route.includes('workspaceId=B')) {
          return Promise.resolve({ sessions: [{ id: 'session-B', status: 'running' }] });
        }
        throw new Error(`unexpected route ${route}`);
      },
      _reconcileAttentionFromSessionRoster(rows) { reconciled.push(rows.map(row => row.id)); },
      renderSessions() {},
      renderWorkspaces() {},
      renderSessionDetail() {},
      showToast() {},
    };

    const promiseA = loadSessions.call(ctx);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(calls.some(route => route.includes('workspaceId=A')));

    ctx.state.activeWorkspace = { id: 'B' };
    const promiseB = loadSessions.call(ctx);
    assert.strictEqual(await promiseB, true);
    assert.deepStrictEqual(ctx.state.sessions.map(row => row.id), ['session-B']);
    assert.deepStrictEqual(ctx.state.allSessions.map(row => row.id), ['all-B']);

    oldProjectResponse.resolve({ sessions: [{ id: 'late-session-A', status: 'failed' }] });
    assert.strictEqual(await promiseA, false);
    assert.deepStrictEqual(ctx.state.sessions.map(row => row.id), ['session-B']);
    assert.deepStrictEqual(ctx.state.allSessions.map(row => row.id), ['all-B']);
    assert.deepStrictEqual(reconciled, [['all-B']], 'stale rosters must not reconcile attention');
  });

  await check('stale Project Notes controls cannot mutate the newly selected project', async () => {
    const toggleDocsItem = extractAsyncMethod('toggleDocsItem', 'async removeDocsItem');
    const calls = [];
    let loads = 0;
    const ctx = {
      state: { activeWorkspace: { id: 'B' } },
      _docsRenderedWorkspaceId: 'A',
      async api(method, route) { calls.push(`${method} ${route}`); },
      async loadDocs() { loads++; },
      showToast() {},
    };

    await toggleDocsItem.call(ctx, 'tasks', 2);
    await toggleDocsItem.call(ctx, 'tasks', 2, 'A');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(loads, 0);

    ctx._docsRenderedWorkspaceId = 'B';
    await toggleDocsItem.call(ctx, 'tasks', 2);
    assert.deepStrictEqual(calls, ['PUT /api/workspaces/B/docs/tasks/2']);
    assert.strictEqual(loads, 1);
  });

  await check('slow project-A documentation cannot render after selecting B', async () => {
    const loadDocs = extractAsyncMethod('loadDocs', '_setDocsSectionExpanded');
    const responseA = deferred();
    const rendered = [];
    const ctx = {
      state: { activeWorkspace: { id: 'A' }, docs: null },
      api(method, route) {
        if (route.includes('/A/')) return responseA.promise;
        if (route.includes('/B/')) return Promise.resolve({ raw: '# B', tasks: [] });
        throw new Error(`unexpected route ${route}`);
      },
      renderDocs() { rendered.push(this.state.docs && this.state.docs.raw); },
      showToast() {},
    };

    const promiseA = loadDocs.call(ctx);
    ctx.state.activeWorkspace = { id: 'B' };
    const promiseB = loadDocs.call(ctx);
    await promiseB;
    assert.strictEqual(ctx.state.docs.raw, '# B');
    assert.deepStrictEqual(rendered, ['# B']);

    responseA.resolve({ raw: '# stale A', tasks: [] });
    await promiseA;
    assert.strictEqual(ctx.state.docs.raw, '# B');
    assert.deepStrictEqual(rendered, ['# B']);
  });

  await check('a note editor opened for A refuses to save after switching to B', async () => {
    const saveNotesEditor = extractAsyncMethod('saveNotesEditor', 'initAIInsights');
    const calls = [];
    const toasts = [];
    let hidden = 0;
    const ctx = {
      state: { activeWorkspace: { id: 'B' } },
      els: { notesEditorTextarea: { value: 'Keep this scoped to A' } },
      _notesEditorWorkspaceId: 'A',
      _notesEditorSection: 'notes',
      _notesEditorIndex: null,
      async api(method, route) { calls.push(`${method} ${route}`); },
      showToast(message, kind) { toasts.push([message, kind]); },
      hideNotesEditor() { hidden++; },
      async loadDocs() {},
    };

    await saveNotesEditor.call(ctx);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(hidden, 1);
    assert.deepStrictEqual(toasts, [[
      'Project changed. Reopen the note before saving.',
      'warning',
    ]]);
  });

  await check('slow resource roster cannot replace a newer resource render', async () => {
    const fetchResources = extractAsyncMethod('fetchResources', '_buildResourceSessionActions');
    const staleResponse = deferred();
    let requestCount = 0;
    const rendered = [];
    const body = { innerHTML: '' };
    const ctx = {
      els: { resourcesBody: body },
      state: { resourceData: null },
      api(method, route) {
        assert.strictEqual(route, '/api/resources');
        requestCount++;
        if (requestCount === 1) return staleResponse.promise;
        return Promise.resolve({ generation: 'new' });
      },
      renderResources(data) { rendered.push(data.generation); },
      escapeHtml(value) { return String(value); },
    };

    const staleLoad = fetchResources.call(ctx);
    const currentLoad = fetchResources.call(ctx);
    assert.strictEqual(await currentLoad, true);
    assert.strictEqual(ctx.state.resourceData.generation, 'new');

    staleResponse.resolve({ generation: 'stale' });
    assert.strictEqual(await staleLoad, false);
    assert.strictEqual(ctx.state.resourceData.generation, 'new');
    assert.deepStrictEqual(rendered, ['new']);
  });

  await check('stale quota, tunnel, and PTY supplements cannot fill replacement containers', async () => {
    const loadSupplements = extractAsyncMethod(
      '_loadResourceSupplements',
      'renderBackgroundPtySessions'
    );
    const stale = {
      '/api/quota-overview': deferred(),
      '/api/tunnels': deferred(),
      '/api/pty': deferred(),
    };
    const requestCounts = new Map();
    const rendered = [];
    const containers = new Map([
      ['#resources-quota', { id: 'quota-current' }],
      ['#resources-tunnels', { id: 'tunnels-current' }],
      ['#resources-pty-bg', { id: 'pty-current' }],
    ]);
    const body = {
      querySelector(selector) { return containers.get(selector) || null; },
    };
    const ctx = {
      els: { resourcesBody: body },
      _resourcesRenderSequence: 1,
      api(method, route) {
        const count = (requestCounts.get(route) || 0) + 1;
        requestCounts.set(route, count);
        if (count === 1) return stale[route].promise;
        return Promise.resolve({ generation: 'new', route });
      },
      renderQuotaOverview(data, container) {
        rendered.push(['quota', data.generation, container.id]);
      },
      renderTunnels(data, container) {
        rendered.push(['tunnels', data.generation, container.id]);
      },
      renderBackgroundPtySessions(data, container) {
        rendered.push(['pty', data.generation, container.id]);
      },
    };

    const oldSupplements = loadSupplements.call(ctx, 1, body);
    ctx._resourcesRenderSequence = 2;
    await loadSupplements.call(ctx, 2, body);
    assert.deepStrictEqual(rendered, [
      ['quota', 'new', 'quota-current'],
      ['tunnels', 'new', 'tunnels-current'],
      ['pty', 'new', 'pty-current'],
    ]);

    stale['/api/quota-overview'].resolve({ generation: 'stale' });
    stale['/api/tunnels'].resolve({ generation: 'stale' });
    stale['/api/pty'].resolve({ generation: 'stale' });
    await oldSupplements;
    assert.deepStrictEqual(
      rendered.map(row => row[1]),
      ['new', 'new', 'new'],
      'no stale supplement may render into the replacement DOM'
    );
  });

  await check('pinned-note badge ignores responses after workspace or pane replacement', async () => {
    let paneLookups = 0;
    const countEl = { textContent: '' };
    const pinButton = {
      hidden: true,
      querySelector(selector) {
        return selector === '.pane-pin-count' ? countEl : null;
      },
    };
    const paneElement = {
      querySelector(selector) {
        return selector === '.terminal-pane-pinnedoc' ? pinButton : null;
      },
    };
    const refreshPanePin = extractAsyncMethod(
      '_refreshPanePin',
      'async loadTdIssues',
      {
        document: {
          getElementById() {
            paneLookups++;
            return paneElement;
          },
          querySelector() { return null; },
        },
      }
    );
    const staleResponse = deferred();
    const originalPane = { sessionId: 'session-A' };
    const ctx = {
      state: { activeWorkspace: { id: 'A' } },
      terminalPanes: [originalPane],
      api() { return staleResponse.promise; },
    };

    const staleRefresh = refreshPanePin.call(ctx, 0);
    ctx.state.activeWorkspace = { id: 'B' };
    staleResponse.resolve({ 'session-A': [{ noteIndex: 0 }] });
    await staleRefresh;
    assert.strictEqual(
      paneLookups,
      0,
      'workspace-stale response must stop before touching pane DOM'
    );
    assert.strictEqual(pinButton.hidden, true);
    assert.strictEqual(countEl.textContent, '');

    const replacedPaneResponse = deferred();
    ctx.state.activeWorkspace = { id: 'B' };
    ctx.terminalPanes[0] = { sessionId: 'session-B' };
    ctx.api = () => replacedPaneResponse.promise;
    const replacedPaneRefresh = refreshPanePin.call(ctx, 0);
    ctx.terminalPanes[0] = { sessionId: 'session-B' };
    replacedPaneResponse.resolve({ 'session-B': [{ noteIndex: 0 }] });
    await replacedPaneRefresh;
    assert.strictEqual(
      paneLookups,
      0,
      'pane-replaced response must stop before touching pane DOM'
    );

    ctx.state.activeWorkspace = { id: 'B' };
    ctx.terminalPanes[0] = { sessionId: 'session-B' };
    ctx.api = async () => ({
      'session-B': [{ noteIndex: 0 }, { noteIndex: 1 }],
    });
    await refreshPanePin.call(ctx, 0);
    assert.strictEqual(paneLookups, 1);
    assert.strictEqual(pinButton.hidden, false);
    assert.strictEqual(countEl.textContent, 2);
  });

  await check('source retains attention and SSE race barriers', async () => {
    assert.match(source, /case 'workspace:activated':[\s\S]*?acknowledgement[\s\S]*?break;/);
    assert.match(source, /async loadSessions\(\)[\s\S]*?_sessionsRequestSequence[\s\S]*?_reconcileAttentionFromSessionRoster\(allSessions\)/);
    assert.match(source, /_getAttentionQueue\(\)[\s\S]*?resolvedState/);
    const openStart = source.indexOf('  openTerminalInPane(');
    assert.notStrictEqual(openStart, -1, 'openTerminalInPane method missing');
    const openEnd = source.indexOf('\n  async openViewInPane(', openStart + 5);
    assert.notStrictEqual(openEnd, -1, 'openTerminalInPane boundary missing');
    const openMethod = source.slice(openStart, openEnd);
    assert.doesNotMatch(
      openMethod,
      /_setAttentionState\(sessionId,\s*['"]running['"]\)/,
      'restoring a pane must not fabricate a durable running state'
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
