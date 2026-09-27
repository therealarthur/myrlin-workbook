/**
 * b3-tree.test.js: GET /tree and GET /tree/projects/:projectId
 * (PROTOCOL.md 4.6, decision A12; BUILD-CONTRACT 3.7.2 "Tree").
 *
 * Fixtures: two folders, four projects, a working directory shared by two
 * projects, a plain shell, tracked and discovered sessions of both
 * providers, and a discovered session no project claims. The tree follows
 * workspaceOrder with folders expanded, a shared directory goes to the first
 * project in rootOrder, "unassigned" appears only when needed and last, and
 * every answer validates against the vendored schemas.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const path = require('path');
const crypto = require('crypto');
const kit = require('./b3-kit');
const { createDiscoveryCache } = require('../../src/web/mobile/chat/discovery-cache');

const sb = kit.sandbox();
const discovery = createDiscoveryCache({ registry: { getProvider: () => null } });
const dirs = { x: path.join(sb.work, 'shared-x'), y: path.join(sb.work, 'codex-y'), z: path.join(sb.work, 'shell-z'), w: path.join(sb.work, 'nobody-w') };
const ids = { a1: crypto.randomUUID(), c1: crypto.randomUUID(), discX: crypto.randomUUID(), discW: crypto.randomUUID(), cx: crypto.randomUUID(), cxDisc: crypto.randomUUID() };
let env;
let ws;

kit.test('boot with two folders, four projects and mixed sessions', async () => {
  env = await kit.bootWorkspace({ chat: { discovery } });
  const s = env.store;
  ws = { A: s.createWorkspace({ name: 'Myrlin iOS' }), B: s.createWorkspace({ name: 'Workbook' }), C: s.createWorkspace({ name: 'Clients app' }), D: s.createWorkspace({ name: 'Solo' }) };
  const f1 = s.createGroup({ name: 'Work' });
  const f2 = s.createGroup({ name: 'Clients' });
  s.moveWorkspaceToGroup(ws.A.id, f1.id);
  s.moveWorkspaceToGroup(ws.B.id, f1.id);
  s.moveWorkspaceToGroup(ws.C.id, f2.id);
  s.reorderWorkspaces([f1.id, ws.D.id, f2.id]);
  ws.f1 = f1; ws.f2 = f2;
  for (const id of [ids.a1, ids.c1, ids.discX]) kit.writeClaude(sb.projects, dirs.x, id, kit.claudeExchange('prompt ' + id.slice(0, 4)));
  kit.writeClaude(sb.projects, dirs.w, ids.discW, kit.claudeExchange('lonely'));
  kit.writeCodex(sb.codexHome, ids.cx, kit.codexExchange('codex tracked'), { cwd: dirs.y });
  kit.writeCodex(sb.codexHome, ids.cxDisc, kit.codexExchange('codex discovered'), { cwd: dirs.y });
  kit.tracked(s, { workspaceId: ws.A.id, provider: 'claude', workingDir: dirs.x, resumeSessionId: ids.a1, name: 'A one' });
  kit.tracked(s, { workspaceId: ws.C.id, provider: 'claude', workingDir: dirs.x, resumeSessionId: ids.c1, name: 'C one' });
  kit.tracked(s, { workspaceId: ws.B.id, provider: 'codex', workingDir: dirs.y, resumeSessionId: ids.cx, name: 'B codex', command: 'codex' });
  kit.tracked(s, { workspaceId: ws.D.id, provider: 'shell', workingDir: dirs.z, name: 'A shell', command: 'powershell' });
  discovery._seed('claude', [ids.a1, ids.c1, ids.discX].map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: dirs.x, lastActive: new Date(), sizeBytes: 100 })).concat([{ provider: 'claude', providerSessionId: ids.discW, projectPath: dirs.w, lastActive: new Date(), sizeBytes: 100 }]));
  discovery._seed('codex', [ids.cx, ids.cxDisc].map((id) => ({ provider: 'codex', providerSessionId: id, projectPath: dirs.y, lastActive: new Date(), sizeBytes: 100 })));
  env.chat.internals.index.invalidate();
});

kit.test('GET /tree: folders, projects in tree order, rootOrder with unassigned last', async () => {
  const r = await env.api('GET', '/tree');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'workspace/tree.json');
  kit.eq(r.body.folders.map((f) => [f.name, f.projectIds]), [['Work', [ws.A.id, ws.B.id]], ['Clients', [ws.C.id]]]);
  kit.eq(r.body.projects.map((p) => p.name), ['Myrlin iOS', 'Workbook', 'Solo', 'Clients app', 'Other working directories']);
  kit.eq(r.body.rootOrder, [{ kind: 'folder', id: ws.f1.id }, { kind: 'project', id: ws.D.id }, { kind: 'folder', id: ws.f2.id }, { kind: 'project', id: 'unassigned' }]);
  const byName = Object.fromEntries(r.body.projects.map((p) => [p.name, p]));
  // A holds its tracked session and the discovered one in the shared dir
  // (A is first in rootOrder); C keeps only its own tracked session.
  kit.eq([byName['Myrlin iOS'].sessionCount, byName['Myrlin iOS'].workingDirCount, byName['Myrlin iOS'].folderId], [2, 1, ws.f1.id]);
  kit.eq(byName['Clients app'].sessionCount, 1);
  kit.eq(byName.Workbook.sessionCount, 2, 'tracked and discovered Codex in the same dir');
  kit.eq(byName.Solo.sessionCount, 0, 'a plain shell is never listed');
  const un = byName['Other working directories'];
  kit.eq([un.kind, un.sessionCount, un.folderId, un.color], ['synthetic', 1, null, null]);
  kit.eq(typeof r.body.streamSeq, 'number');
});

kit.test('GET /tree/projects/:projectId lists working dirs with sessions newest first', async () => {
  const r = await env.api('GET', '/tree/projects/' + ws.A.id);
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'workspace/tree-project.json');
  kit.eq(r.body.workingDirs.length, 1);
  const d = r.body.workingDirs[0];
  kit.eq([d.path, d.sessionCount, d.moreSessions], [dirs.x, 2, 0]);
  kit.eq(d.sessions.map((s) => s.sessionId).sort(), ['cl_' + ids.a1, 'cl_' + ids.discX].sort());
  kit.ok(d.sessions.every((s) => s.projectId === ws.A.id), 'placed sessions carry the tree project');
  const u = await env.api('GET', '/tree/projects/unassigned');
  kit.eq([u.status, u.body.workingDirs[0].sessions[0].sessionId], [200, 'cl_' + ids.discW]);
  kit.validate(u.body, 'workspace/tree-project.json');
});

kit.test('paging working directories with limit and cursor', async () => {
  // A second working directory for project A.
  const other = path.join(sb.work, 'a-second');
  const id = crypto.randomUUID();
  kit.writeClaude(sb.projects, other, id, kit.claudeExchange('second dir'));
  kit.tracked(env.store, { workspaceId: ws.A.id, provider: 'claude', workingDir: other, resumeSessionId: id, name: 'A two' });
  env.chat.internals.index.invalidate();
  const p1 = await env.api('GET', '/tree/projects/' + ws.A.id + '?limit=1');
  kit.eq([p1.status, p1.body.workingDirs.length, typeof p1.body.nextCursor], [200, 1, 'string']);
  const p2 = await env.api('GET', '/tree/projects/' + ws.A.id + '?limit=1&cursor=' + encodeURIComponent(p1.body.nextCursor));
  kit.eq([p2.status, p2.body.workingDirs.length, p2.body.nextCursor], [200, 1, null]);
  kit.ok(p1.body.workingDirs[0].path !== p2.body.workingDirs[0].path, 'distinct pages');
  const bad = await env.api('GET', '/tree/projects/' + ws.A.id + '?limit=0');
  kit.eq([bad.status, bad.body.code], [400, 'INVALID_FIELD']);
});

kit.test('unknown project answers 404 PROJECT_NOT_FOUND; unassigned disappears when empty', async () => {
  const r = await env.api('GET', '/tree/projects/nope');
  kit.eq([r.status, r.body.code], [404, 'PROJECT_NOT_FOUND']);
  // Claim the lonely directory with a tracked session in D: unassigned goes.
  kit.tracked(env.store, { workspaceId: ws.D.id, provider: 'claude', workingDir: dirs.w, resumeSessionId: ids.discW, name: 'Now tracked' });
  env.chat.internals.index.invalidate();
  const t = await env.api('GET', '/tree');
  kit.ok(!t.body.projects.some((p) => p.projectId === 'unassigned'), 'no unassigned project');
  kit.ok(!t.body.rootOrder.some((e) => e.id === 'unassigned'), 'not in rootOrder');
  const u = await env.api('GET', '/tree/projects/unassigned');
  kit.eq([u.status, u.body.project.sessionCount], [200, 0], 'the synthetic project still answers, empty');
});

kit.test('the sandbox seed builds the E2E workspace (seed-sandbox.js, then seed-workspace.js)', async () => {
  // BUILD-CONTRACT 6.1: run the two seed scripts as mac.sh wb-reset does,
  // on fresh sandbox folders, then read what they wrote.
  const fs = require('fs');
  const os = require('os');
  const childProcess = require('child_process');
  const seedRoot = kit.tmpDir('seed');
  const dirs = { home: path.join(seedRoot, 'home'), data: path.join(seedRoot, 'data'), codexHome: path.join(seedRoot, 'home', '.codex'), state: path.join(seedRoot, 'state') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const r = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'e2e', 'seed-sandbox.js'), dirs.home, dirs.data, dirs.codexHome, dirs.state], { encoding: 'utf8', env: Object.assign({}, process.env, { CWM_DATA_DIR: dirs.data }) });
  kit.eq(r.status, 0, r.stderr + r.stdout);
  kit.ok(/seed-workspace: computer Sandbox/.test(r.stdout), r.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(dirs.data, 'workspaces.json'), 'utf8'));
  kit.eq(state.settings.serverName, 'Sandbox');
  const groups = Object.values(state.workspaceGroups || {});
  const work = groups.find((g) => g.name === 'Work');
  const wsByName = (n) => Object.values(state.workspaces).find((w) => w.name === n);
  kit.ok(work && work.workspaceIds.includes(wsByName('Myrlin iOS').id) && work.workspaceIds.includes(wsByName('Workbook').id), 'both projects in the folder Work');
  const sessions = Object.values(state.sessions);
  const byName = (n) => sessions.find((x) => x.name === n);
  const manifest = JSON.parse(fs.readFileSync(path.join(dirs.data, 'e2e-fixtures.json'), 'utf8'));
  kit.eq([byName('E2E Claude').provider, byName('E2E Claude').resumeSessionId], ['claude', manifest.claude.find((c) => c.key === 'e2eClaude').sessionId]);
  kit.eq([byName('E2E Migrate').provider, byName('E2E Migrate').workspaceId], ['claude', wsByName('Myrlin iOS').id]);
  kit.eq([byName('E2E Codex').provider, byName('E2E Codex').resumeSessionId, byName('E2E Codex').workspaceId], ['codex', manifest.codex.find((c) => c.key === 'e2eCodex').threadId, wsByName('Workbook').id]);
  const layout = JSON.parse(fs.readFileSync(path.join(dirs.data, 'layout.json'), 'utf8'));
  kit.eq(layout.tabGroups.map((g) => [g.name, g.panes.length]), [['Main', 3], ['Research', 1]]);
  kit.eq([layout.revision, layout.tabGroups[1].panes[0].viewType], [1, 'mirror']);
  const fixture = JSON.parse(fs.readFileSync(path.join(dirs.data, 'accounts-fixture.json'), 'utf8'));
  kit.eq(fixture.codexRunning, true);
  kit.validate(fixture.accounts, 'accounts/accounts.json');
  kit.ok(Math.abs(fixture.accounts.generatedAtMs - Date.now()) < 60 * 1000, 'times moved to the seed time');
  kit.ok(fixture.accounts.providers[1].accounts.some((a) => a.displayName === 'alt'), 'the Codex chip alt of E2E_09');
  // The seed never writes Workbook's default data folder.
  const seedWs = require('./e2e/seed-workspace');
  kit.ok(/default/.test(seedWs.refusal(path.join(os.homedir(), '.myrlin'))), 'refuses ~/.myrlin');
  kit.eq(seedWs.refusal(dirs.data), null);
  fs.rmSync(seedRoot, { recursive: true, force: true });
});

kit.run(async () => { if (env) await env.close(); });
