/**
 * b3-desktop-layout-source.test.js: the desktop edits S17 to S20 are in
 * place (BUILD-CONTRACT 3.7.2 "Tabs": "a source test proves app.js sends
 * baseRevision and handles layout:updated and merged").
 *
 * What: reads src/web/public/app.js and src/web/server.js and checks the
 * pieces that keep a desktop page from overwriting a phone's tab edit: the
 * page remembers the revision it loaded (S17), sends it as baseRevision
 * and applies a merged answer (S18), can replace its groups with a server
 * layout (S19), and reacts to layout:updated and session:title (S20); the
 * server broadcasts through the layout store. It also runs the event
 * handler's payload rule on the real SSE envelope shape, so the page reads
 * the revision from data.data. The browser test
 * (test/mobile/e2e/desktop-layout-browser.js) proves the behaviour end to end.
 *
 * Why: app.js is a 30,000 line browser file with no module seams; a source
 * check is the cheap guard the contract asks for against a later edit
 * dropping one of these lines.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kit = require('./b3-kit');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'src', 'web', 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'web', 'server.js'), 'utf8');

/**
 * The body of a class method of app.js (from its signature to the next
 * method at the same indentation).
 *
 * @param {string} name - Method name.
 * @returns {string}
 */
function methodBody(name) {
  const re = new RegExp('\\n  (async )?' + name + '\\(([^)]*)\\) \\{');
  const m = re.exec(app);
  if (!m) throw new Error('method not found: ' + name);
  const start = m.index;
  const next = /\n  (async )?[A-Za-z_$][\w$]*\([^)]*\) \{/g;
  next.lastIndex = start + m[0].length;
  const n = next.exec(app);
  return app.slice(start, n ? n.index : app.length);
}

/** Execute the real layout methods with controlled requests and retry timers. */
function layoutPage(api) {
  const timers = new Map();
  const delays = [];
  let timerId = 0;
  const methods = ['initTerminalGroups', 'loadTerminalLayout', 'saveTerminalLayout', '_retryTerminalLayoutLoad', 'applyRemoteLayout', '_fetchAndApplyRemoteLayout'];
  const page = vm.runInNewContext('({' + methods.map(methodBody).join(',') + '})', {
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, fn); delays.push(ms); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  Object.assign(page, {
    api, state: { token: 't' }, terminalPanes: [], _tabGroups: [], _tabFolders: [],
    renderTerminalGroupTabs() {}, renderWorkspaces() {}, saveCurrentGroupPanes() {},
    switchTerminalGroup(id) { this._activeGroupId = id; }, _disposeGroupCache() {},
  });
  return {
    page, timers, delays,
    async fire() {
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      await fn();
      if (page._layoutSaveChain) await page._layoutSaveChain;
    },
  };
}

kit.test('a signed out page stops retrying the layout load', async () => {
  let reads = 0;
  let showLoginCalls = 0;
  let password = 'typing';
  const h = layoutPage(async () => {
    reads += 1;
    h.page.state.token = null;
    showLoginCalls += 1;
    password = '';
    throw new Error('Unauthorized');
  });
  h.page._retryTerminalLayoutLoad();
  await h.fire();
  kit.eq(reads, 1);
  kit.eq(h.timers.size, 0);
  password = 'new password';
  h.page._retryTerminalLayoutLoad();
  kit.eq(h.timers.size, 0);
  kit.eq([showLoginCalls, password], [1, 'new password'], 'recovery cannot clear the password repeatedly');
});

kit.test('signing out before a layout retry prevents its request', async () => {
  let reads = 0;
  const h = layoutPage(async () => { reads += 1; });
  h.page._retryTerminalLayoutLoad();
  h.page.state.token = null;
  await h.fire();
  kit.eq([reads, h.timers.size], [0, 0]);
});

kit.test('layout load recovery backs off after consecutive network errors', async () => {
  const h = layoutPage(async () => { throw new Error('offline'); });
  await h.page.loadTerminalLayout();
  for (let i = 0; i < 3; i += 1) await h.fire();
  kit.eq(h.delays, [1000, 2000, 4000, 8000]);
});

kit.test('terminal group reinitialization after sign-in resets layout recovery and its first retry delay', async () => {
  const resets = [];
  const h = layoutPage(async () => {
    resets.push([h.page._layoutLoadRetryAttempt, h.page._layoutHeldEdits, h.page._layoutRevisionUnsupported]);
    throw new Error('offline');
  });
  h.page.state.token = null;
  h.page._layoutLoadRetryAttempt = 5;
  h.page._layoutHeldEdits = true;
  h.page._layoutRevisionUnsupported = true;
  h.page.state.token = 'signed-in-token';
  await h.page.initTerminalGroups();
  kit.eq(resets, [[0, false, false]], 'reinitialization resets recovery before loading the layout');
  kit.eq(h.delays, [1000], 'the first retry uses the initial backoff delay');
  kit.eq(h.page._layoutLoadRetryAttempt, 1);
  kit.eq([h.page._layoutHeldEdits, h.page._layoutRevisionUnsupported], [false, false]);
  kit.eq(h.timers.size, 1);
});

kit.test('failed initial layout reads hold saves until recovery loads the phone layout', async () => {
  const writes = [];
  let reads = 0;
  const h = layoutPage(async (method, route, body) => {
    kit.eq(route, '/api/layout');
    if (method === 'PUT') { writes.push(body); return { revision: 8 }; }
    reads += 1;
    if (reads <= 2) throw new Error('offline');
    return { revision: 7, tabGroups: [{ id: 'tg_phone', name: 'Phone edit', panes: [] }], tabFolders: [] };
  });
  await h.page.loadTerminalLayout();
  h.page.saveTerminalLayout();
  h.page.saveTerminalLayout();
  kit.eq(h.timers.size, 1, 'one retry owns recovery');
  await h.fire();
  h.page.saveTerminalLayout();
  kit.eq(writes.length, 0, 'no PUT after two failed GETs');
  kit.eq(h.timers.size, 1, 'another load is scheduled');
  await h.fire();
  kit.eq(h.page._layoutRevision, 7);
  kit.eq(h.page._tabGroups[0].name, 'Phone edit');
  h.page.saveTerminalLayout();
  await h.fire();
  kit.eq(writes.length, 1);
  kit.eq(writes[0].baseRevision, 7);
  kit.eq(writes[0].tabGroups[0].name, 'Phone edit', 'the provisional default never overwrites the phone');
  kit.eq(h.page._layoutRevision, 8);
});

kit.test('a revisionless layout permits a legacy save without a retry', async () => {
  const writes = [];
  const h = layoutPage(async (method, route, body) => {
    if (method === 'PUT') writes.push(body);
    return { tabGroups: [] };
  });
  await h.page.loadTerminalLayout();
  kit.eq(h.timers.size, 0);
  h.page.saveTerminalLayout();
  await h.fire();
  kit.eq(writes.length, 1);
  kit.eq(writes[0].baseRevision, null);
  kit.eq(h.page._layoutRevision, null);
  kit.eq(h.timers.size, 0);
});

for (const hasServerGroups of [false, true]) {
  kit.test('held desktop groups and panes survive recovery ' + (hasServerGroups ? 'with a conflicting server group' : 'with an empty server layout'), async () => {
    const recoveredRevision = hasServerGroups ? 7 : 0;
    const serverGroups = hasServerGroups ? [{ id: 'tg_default', name: 'Phone main', panes: [] }] : [];
    let reads = 0;
    const writes = [];
    const disposed = [];
    const switched = [];
    const h = layoutPage(async (method, route, body) => {
      if (method === 'PUT') {
        writes.push(JSON.parse(JSON.stringify(body)));
        return { revision: recoveredRevision + 1 };
      }
      reads += 1;
      if (reads === 1) throw new Error('offline');
      return { revision: recoveredRevision, tabGroups: serverGroups };
    });
    h.page._disposeGroupCache = id => disposed.push(id);
    h.page.switchTerminalGroup = id => { switched.push(id); h.page._activeGroupId = id; };
    await h.page.loadTerminalLayout();
    h.page._tabGroups[0].panes.push({ slot: 0, sessionId: 'local-session', sessionName: 'Local pane' });
    h.page._tabGroups.push({ id: 'tg_work', name: 'Work', panes: [] });
    h.page.saveTerminalLayout();
    kit.eq(writes.length, 0);
    await h.fire();
    kit.eq(h.page._layoutRevision, recoveredRevision);
    kit.eq(disposed, [], 'the active pane cache is preserved');
    kit.eq(switched, [], 'the active group is not reopened');
    const active = h.page._tabGroups.find(g => g.id === h.page._activeGroupId);
    kit.eq(active.panes[0].sessionId, 'local-session');
    kit.ok(h.page._tabGroups.some(g => g.id === 'tg_work' && g.name === 'Work'));
    if (hasServerGroups) kit.ok(active.id.startsWith('tg_offline_'), 'the conflicting local group gets its own id');
    await h.fire();
    kit.eq(writes.length, 1);
    kit.eq(writes[0].baseRevision, recoveredRevision);
    kit.eq(writes[0].tabGroups.length, serverGroups.length + 2);
    kit.ok(writes[0].tabGroups.some(g => g.panes.some(p => p.sessionId === 'local-session')));
    if (hasServerGroups) kit.ok(writes[0].tabGroups.some(g => g.id === 'tg_default' && g.name === 'Phone main'));
    kit.eq(h.timers.size, 0);
  });
}

kit.test('a layout retry can recover against a revisionless server', async () => {
  let reads = 0;
  const h = layoutPage(async () => {
    reads += 1;
    if (reads === 1) throw new Error('offline');
    return { tabGroups: [{ id: 'tg_legacy', name: 'Legacy', panes: [] }] };
  });
  await h.page.loadTerminalLayout();
  await h.fire();
  kit.eq(h.page._layoutRevisionUnsupported, true);
  kit.eq(h.page._tabGroups[0].name, 'Legacy');
  kit.eq(h.timers.size, 0);
});

kit.test('a 503 layout error keeps saves held', async () => {
  let writes = 0;
  const h = layoutPage(async (method) => {
    if (method === 'PUT') writes += 1;
    const error = new Error('Layout is unavailable');
    error.status = 503;
    error.code = 'LAYOUT_UNAVAILABLE';
    throw error;
  });
  await h.page.loadTerminalLayout();
  h.page.saveTerminalLayout();
  await h.fire();
  kit.eq(writes, 0);
  kit.eq(h.page._layoutRevision, null);
  kit.ok(!h.page._layoutRevisionUnsupported);
  kit.eq(h.timers.size, 1);
});

kit.test('the layout route reserves legacy fallback for module load failure', () => {
  const start = server.indexOf("app.get('/api/layout',");
  const route = server.slice(start, server.indexOf('\n});', start) + '\n});'.length);
  for (const moduleAvailable of [true, false]) {
    let handler;
    let fileReads = 0;
    vm.runInNewContext(route, {
      app: { get(name, auth, fn) { handler = fn; } }, requireAuth() {},
      require() {
        if (!moduleAvailable) throw new Error('module unavailable');
        return { getForDesktop() { throw new Error('read unavailable'); } };
      },
      console: { error() {} }, LAYOUT_FILE: 'layout.json',
      fs: { existsSync() { return true; }, readFileSync() { fileReads += 1; return '{}'; } },
    });
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler({}, response);
    kit.eq(response.statusCode, moduleAvailable ? 503 : 200);
    kit.eq(fileReads, moduleAvailable ? 0 : 1);
    if (moduleAvailable) kit.eq(response.body.code, 'LAYOUT_UNAVAILABLE');
  }
});

kit.test('a remote snapshot wins over an older initial layout retry in flight', async () => {
  let resolveRetry;
  const h = layoutPage(() => new Promise(resolve => { resolveRetry = resolve; }));
  h.page._layoutRevision = null;
  h.page._retryTerminalLayoutLoad();
  const retry = h.fire();
  h.page.applyRemoteLayout({ revision: 9, tabGroups: [{ id: 'tg_phone', name: 'Newest phone edit', panes: [] }] });
  resolveRetry({ revision: 8, tabGroups: [{ id: 'tg_phone', name: 'Older edit', panes: [] }] });
  await retry;
  kit.eq(h.page._layoutRevision, 9);
  kit.eq(h.page._tabGroups[0].name, 'Newest phone edit');
  kit.eq(h.timers.size, 0);
});

kit.test('S17: loadTerminalLayout remembers the revision it loaded', () => {
  const body = methodBody('loadTerminalLayout');
  kit.ok(/this\._layoutRevision = \(layout && typeof layout\.revision === 'number'\) \? layout\.revision : null;/.test(body), 'revision kept from GET /api/layout');
});

kit.test('S18: saveTerminalLayout sends baseRevision, keeps the answer and applies merged', () => {
  const body = methodBody('saveTerminalLayout');
  kit.ok(/baseRevision: this\._layoutRevision/.test(body), 'baseRevision in the PUT body');
  kit.ok(/tabGroups: this\._tabGroups,/.test(body) && /tabFolders: this\._tabFolders,/.test(body) && /activeGroupId: this\._activeGroupId,/.test(body), 'the old keys are still sent');
  kit.ok(/this\.api\('PUT', '\/api\/layout'/.test(body), 'same route');
  kit.ok(/if \(saved && typeof saved\.revision === 'number'\) this\._layoutRevision = saved\.revision;/.test(body), 'stores the answered revision');
  kit.ok(/if \(saved && saved\.merged === true && saved\.layout\) this\.applyRemoteLayout\(saved\.layout\);/.test(body), 'applies a merged answer');
  kit.ok(/this\._layoutSaveTimer = null;/.test(body), 'the debounce clears its timer');
  kit.ok(/this\._layoutSaveChain = previousSave/.test(body), 'saves are serialized');
  kit.ok(/this\._fetchAndApplyRemoteLayout\(missed\)/.test(body), 'a change announced during a save is fetched after it');
  kit.ok(/}, 500\);/.test(body), 'the 500 ms debounce is unchanged');
});

kit.test('S19: applyRemoteLayout replaces groups and reopens the active group through the switch path', () => {
  const body = methodBody('applyRemoteLayout');
  kit.ok(/this\._tabGroups = layout\.tabGroups;/.test(body));
  kit.ok(/this\._tabFolders = Array\.isArray\(layout\.tabFolders\)/.test(body));
  kit.ok(/this\.switchTerminalGroup\(targetId\)/.test(body), 'reopens through switchTerminalGroup');
  kit.ok(/this\._disposeGroupCache\(cachedId\)/.test(body), 'drops cached groups whose panes changed');
  kit.ok(/this\.renderTerminalGroupTabs\(\)/.test(body), 're-renders the strip');
  const fetch = methodBody('_fetchAndApplyRemoteLayout');
  kit.ok(/if \(revision === this\._layoutRevision\) return;/.test(fetch), 'its own save is ignored');
  kit.ok(/if \(this\._layoutSaveTimer \|\| this\._layoutSaveInFlight\)/.test(fetch), 'waits while a save is pending');
  kit.ok(/this\.api\('GET', '\/api\/layout'\)/.test(fetch));
});

kit.test('S20: handleSSEEvent handles layout:updated from the envelope and session:title', () => {
  const at = app.indexOf("case 'layout:updated': {");
  kit.ok(at > 0, 'layout:updated case');
  const block = app.slice(at, app.indexOf("case 'session:started':", at));
  kit.ok(/const layoutEvent = \(data && data\.data && typeof data\.data === 'object'\) \? data\.data : data;/.test(block));
  kit.ok(/this\._fetchAndApplyRemoteLayout\(layoutEvent\.revision\)/.test(block));
  kit.ok(/case 'session:title':/.test(block), 'session:title case');
  kit.ok(/this\._throttledLoadSessions\(\)/.test(block) && /this\.loadProjects\(\)/.test(block));
  // The rule on the real envelope server.js sends ({type, data, timestamp}).
  const pick = (data) => ((data && data.data && typeof data.data === 'object') ? data.data : data);
  kit.eq(pick({ type: 'layout:updated', data: { revision: 7, changedBy: { kind: 'device', deviceId: 'd' } }, timestamp: 'x' }).revision, 7);
  kit.ok(/function broadcastSSE\(/.test(server) || /broadcastSSE = /.test(server), 'server.js broadcasts SSE');
  kit.ok(/type: eventType, data, timestamp|\{ type, data, timestamp|type: type, data: data/.test(server) || /JSON\.stringify\(\{ type/.test(server), 'the envelope carries data');
});

kit.test('app.js moved to a new cache token atomically; the added code has no em dash', () => {
  kit.ok(/loadTerminalLayout\(\)/.test(app) && /saveTerminalLayout\(\)/.test(app));
  const dashes = new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']');
  kit.ok(!dashes.test(methodBody('applyRemoteLayout') + methodBody('_fetchAndApplyRemoteLayout')), 'no em dash in the added code');
  // A page holding a cached app.js would save without baseRevision, so the
  // token moved with the change, in index.html and every pinning test (G10).
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  const token = (/<script src="app\.js\?v=([A-Za-z0-9._-]+)"/.exec(read('src/web/public/index.html')) || [])[1];
  kit.eq(token, '20260928-perf1');
  for (const t of ['test/terminal-select-mode.test.js', 'test/copy-secure-context-fallback.test.js', 'test/browser/workbook-shell.test.js']) kit.ok(read(t).includes('?v=' + token), t + ' pins the new token');
});

kit.run();
