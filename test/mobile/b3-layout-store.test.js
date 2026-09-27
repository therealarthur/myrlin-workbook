/**
 * b3-layout-store.test.js: layout.json with revisions, the phone op log and
 * the rebase of desktop saves (PROTOCOL.md 4.8.1; BUILD-CONTRACT S8, 3.7.2
 * "Tabs").
 *
 * The desktop's GET and PUT /api/layout keep their shape with a revision
 * added; a PUT without baseRevision behaves as before; a PUT with the
 * current revision stores (and skips the write when nothing changed); a PUT
 * with an older baseRevision re-applies the phone operations logged since,
 * so a stale desktop save never overwrites a phone edit, and answers
 * merged: true with the layout; operations whose target is gone are
 * skipped; layout:updated fires once per change; the op log is capped.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./b3-kit');
const layoutStoreMod = require('../../src/web/mobile/workspace/layout-store');
const { createDiscoveryCache } = require('../../src/web/mobile/chat/discovery-cache');

const sb = kit.sandbox();
const discovery = createDiscoveryCache({ registry: { getProvider: () => null } });
const dir = path.join(sb.work, 'layout');
const ids = { a: crypto.randomUUID(), b: crypto.randomUUID() };
let env;
let ls;
let recA;

/** A desktop terminal pane for a store session. */
function pane(slot, rec) {
  return { slot, sessionId: rec.id, sessionName: rec.name, provider: 'claude', spawnOpts: {}, viewType: null, viewData: {} }; // gsd:provider-literal-allowed (test fixture)
}

/** SSE broadcasts of one type since an index. */
function sseOf(type, from) {
  return env.sse.slice(from || 0).filter((e) => e.type === type);
}

kit.test('boot; an empty data folder reads as an empty layout at revision 0', async () => {
  env = await kit.bootWorkspace({ chat: { discovery } });
  ls = env.ws.internals.layoutStore;
  kit.eq(ls, layoutStoreMod.forDataDir(process.env.CWM_DATA_DIR), 'server.js and the workspace share one store per data folder');
  kit.eq(ls.getForDesktop(), { revision: 0 });
  const ws = env.store.createWorkspace({ name: 'Layout' });
  for (const id of [ids.a, ids.b]) kit.writeClaude(sb.projects, dir, id, kit.claudeExchange('layout ' + id.slice(0, 4)));
  recA = kit.tracked(env.store, { workspaceId: ws.id, provider: 'claude', workingDir: dir, resumeSessionId: ids.a, name: 'Layout A' });
  discovery._seed('claude', [ids.a, ids.b].map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: dir, lastActive: new Date(), sizeBytes: 100 })));
  env.chat.internals.index.invalidate();
});

kit.test('a desktop PUT without baseRevision stores as before and the revision increments', () => {
  const from = env.sse.length;
  const r = ls.putFromDesktop({ tabGroups: [{ id: 'tg_main', name: 'Main', panes: [pane(0, recA)] }], activeGroupId: 'tg_main' });
  kit.eq(r, { success: true, revision: 1 });
  const disk = JSON.parse(fs.readFileSync(ls.layoutFile, 'utf8'));
  kit.eq([disk.revision, disk.activeGroupId, disk.tabGroups[0].name], [1, 'tg_main', 'Main']);
  kit.ok(!('baseRevision' in disk), 'never stores baseRevision');
  kit.eq(ls.getForDesktop().revision, 1);
  kit.eq(sseOf('layout:updated', from).length, 1, 'layout:updated once');
  kit.eq(sseOf('layout:updated', from)[0].data, { revision: 1, changedBy: { kind: 'desktop', deviceId: null } });
});

kit.test('a PUT at the current revision stores; an identical one writes nothing', () => {
  const from = env.sse.length;
  const cur = ls.getForDesktop();
  const again = ls.putFromDesktop(Object.assign({}, cur, { baseRevision: cur.revision }));
  kit.eq(again, { success: true, revision: 1 }, 'unchanged blob, no new revision');
  kit.eq(sseOf('layout:updated', from).length, 0, 'no broadcast when nothing changed');
  const changed = ls.putFromDesktop(Object.assign({}, cur, { baseRevision: 1, activeGroupId: 'tg_main', extraDesktopKey: 7 }));
  kit.eq(changed, { success: true, revision: 2 });
  kit.eq(ls.getForDesktop().extraDesktopKey, 7, 'unknown desktop keys are kept');
  kit.eq(sseOf('layout:updated', from).length, 1);
});

kit.test('a phone edit then a stale desktop PUT: the phone edit survives (rebase, merged: true)', async () => {
  const phone = await env.api('PATCH', '/tabs', { baseRevision: 2, ops: [
    { op: 'renameGroup', groupId: 'tg_main', name: 'Main from phone' },
    { op: 'createGroup', tempId: 't1', name: 'Research', afterGroupId: 'tg_main', folderId: null },
    { op: 'moveSession', sessionId: 'cl_' + ids.b, toGroupId: 't1', index: 0 },
  ] });
  kit.eq(phone.status, 200, JSON.stringify(phone.body));
  kit.eq(phone.body.tabs.revision, 3);
  const research = phone.body.tempIds.t1;
  kit.ok(/^tg_/.test(research), research);
  const ops = ls.readOps();
  kit.eq(ops.map((e) => [e.revision, e.op.op]), [[3, 'renameGroup'], [3, 'createGroup'], [3, 'moveSession']]);
  kit.eq(ops[1].op.realId, research, 'the log carries the real id, so a replay makes the same group');

  // The desktop still thinks it is at revision 2 and saves its own edit
  // (it moved the active group and added a key), as an old tab would.
  const from = env.sse.length;
  const r = ls.putFromDesktop({ baseRevision: 2, tabGroups: [{ id: 'tg_main', name: 'Main', panes: [pane(0, recA)] }], activeGroupId: 'tg_main', desktopOnly: 'kept' });
  kit.eq([r.success, r.revision, r.merged], [true, 4, true]);
  const names = r.layout.tabGroups.map((g) => g.name);
  kit.eq(names, ['Main from phone', 'Research'], 'the phone rename and the new group survive');
  const researchGroup = r.layout.tabGroups.find((g) => g.id === research);
  kit.eq(researchGroup.panes.map((p) => [p.viewType, p.viewData.providerSessionId]), [['mirror', ids.b]], 'the moved session too');
  kit.eq([r.layout.desktopOnly, r.layout.revision], ['kept', 4], 'the desktop edit survives as well');
  kit.eq(JSON.parse(fs.readFileSync(ls.layoutFile, 'utf8')).tabGroups.length, 2, 'what was answered is what was stored');
  kit.eq(sseOf('layout:updated', from).length, 1, 'layout:updated once for the merge');
  const tabs = await env.api('GET', '/tabs');
  kit.eq(tabs.body.tabs.groups.map((g) => g.name), ['Main from phone', 'Research']);
});

kit.test('an operation whose target the desktop removed is skipped, the rest apply', async () => {
  const cur = ls.getForDesktop();
  const phone = await env.api('PATCH', '/tabs', { baseRevision: cur.revision, ops: [
    { op: 'createFolder', tempId: 'f1', name: 'Clients', color: null },
    { op: 'renameGroup', groupId: cur.tabGroups[1].id, name: 'Research two' },
  ] });
  kit.eq(phone.status, 200, JSON.stringify(phone.body));
  // The desktop, still at the old revision, deleted Research meanwhile.
  const r = ls.putFromDesktop({ baseRevision: cur.revision, tabGroups: [cur.tabGroups[0]], activeGroupId: cur.tabGroups[0].id });
  kit.eq(r.merged, true);
  kit.eq(r.layout.tabGroups.map((g) => g.name), ['Main from phone'], 'the rename of a removed group is skipped');
  kit.eq(r.layout.tabFolders.map((f) => f.name), ['Clients'], 'the folder the phone made is kept');
});

kit.test('a body that is not an object is stored exactly as before', () => {
  const r = ls.putFromDesktop([1, 2]);
  kit.eq(r, { success: true });
  kit.eq(JSON.parse(fs.readFileSync(ls.layoutFile, 'utf8')), [1, 2]);
  kit.eq(ls.getForDesktop(), { revision: 0 }, 'an unreadable shape reads as empty');
  const back = ls.putFromDesktop({ tabGroups: [{ id: 'tg_main', name: 'Main', panes: [] }] });
  kit.ok(back.revision > ls.readOps().reduce((m, e) => Math.max(m, e.revision), 0), 'revisions never go back, so no old phone operation replays later');
});

kit.test('the op log keeps the newest 200 entries', () => {
  const store = layoutStoreMod.createLayoutStore({ dataDir: path.join(sb.root, 'oplog') });
  let revision = 0;
  for (let i = 0; i < 70; i++) {
    const r = store.commitPhone({ tabGroups: [{ id: 'g', name: 'n' + i, panes: [] }] }, { deviceId: 'd', ops: [{ op: 'renameGroup', groupId: 'g', name: 'a' }, { op: 'renameGroup', groupId: 'g', name: 'b' }, { op: 'renameGroup', groupId: 'g', name: 'c' }], expectRevision: revision });
    revision = r.revision;
  }
  const ops = store.readOps();
  kit.eq(ops.length, layoutStoreMod.OPLOG_MAX);
  kit.eq(ops[ops.length - 1].revision, 70);
  let threw = null;
  try { store.commitPhone({}, { ops: [], expectRevision: 3 }); } catch (err) { threw = err; }
  kit.ok(threw && threw.layoutMoved, 'a commit on a moved layout is refused');
});

kit.test('server.js serves GET and PUT /api/layout through the layout store (S8)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'web', 'server.js'), 'utf8');
  kit.ok(/layoutStore\.getForDesktop\(\)/.test(src) || /getForDesktop\(\)/.test(src), 'GET uses getForDesktop');
  kit.ok(/putFromDesktop\(req\.body\)/.test(src), 'PUT uses putFromDesktop');
});

kit.run(async () => { if (env) await env.close(); });
