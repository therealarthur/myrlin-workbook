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
 * (b3-desktop-layout-browser.test.js) proves the behaviour end to end.
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
  kit.eq(token, '20260927-mobile-v2-b3');
  for (const t of ['test/terminal-select-mode.test.js', 'test/copy-secure-context-fallback.test.js', 'test/browser/workbook-shell.test.js']) kit.ok(read(t).includes('?v=' + token), t + ' pins the new token');
});

kit.run();
