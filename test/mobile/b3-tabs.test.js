/**
 * b3-tabs.test.js: GET and PATCH /tabs (PROTOCOL.md 3.9, 4.8; BUILD-CONTRACT
 * 3.7.2 "Tabs"; P9).
 *
 * The desktop's panes map to phone ids (terminal panes through B2's index,
 * mirror panes by provider and upstream id; shells and duplicates count as
 * hiddenPanes); every operation applies, all or nothing; TAB_GROUP_FULL at
 * 6, LAST_TAB_GROUP, TABS_OP_INVALID with opIndex and current, strict
 * If-Match answers 412; tempIds resolve inside one patch; tabs.updated and
 * layout:updated fire once per change; sessions whose groups changed are
 * announced as updated; addSessionToGroup and tabGroupIdsFor serve B2.
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
const dir = path.join(sb.work, 'tabs');
const up = Array.from({ length: 8 }, () => crypto.randomUUID());
const pid = (i) => 'cl_' + up[i];
let env;
let ls;
const recs = [];
let shell;
let stream;

/** A desktop terminal pane for a store session. */
function pane(slot, rec) {
  return { slot, sessionId: rec.id, sessionName: rec.name, provider: rec.provider || null, spawnOpts: {}, viewType: null, viewData: {} };
}

/** Current revision. */
async function rev() {
  return (await env.api('GET', '/tabs')).body.tabs.revision;
}

kit.test('boot; the desktop layout maps to TabsState with hidden panes counted', async () => {
  env = await kit.bootWorkspace({ chat: { discovery } });
  ls = env.ws.internals.layoutStore;
  const ws = env.store.createWorkspace({ name: 'Tabs' });
  for (let i = 0; i < up.length; i++) kit.writeClaude(sb.projects, dir, up[i], kit.claudeExchange('tabs ' + i));
  // Sessions 0 to 3 are tracked, 4 to 7 discovered.
  for (let i = 0; i < 4; i++) recs.push(kit.tracked(env.store, { workspaceId: ws.id, provider: 'claude', workingDir: dir, resumeSessionId: up[i], name: 'Tab ' + i }));
  shell = kit.tracked(env.store, { workspaceId: ws.id, provider: 'shell', workingDir: dir, name: 'A shell', command: 'powershell' });
  discovery._seed('claude', up.map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: dir, lastActive: new Date(), sizeBytes: 100 })));
  env.chat.internals.index.invalidate();
  ls.putFromDesktop({
    tabGroups: [
      { id: 'tg_main', name: 'Main', panes: [pane(0, recs[0]), pane(1, shell), pane(2, recs[1]), pane(3, recs[0])] },
      { id: 'tg_side', name: 'Side', panes: [{ slot: 0, sessionId: null, sessionName: 'Mirror', provider: 'claude', spawnOpts: {}, viewType: 'mirror', viewData: { provider: 'claude', providerSessionId: up[4] } }] }, // gsd:provider-literal-allowed (test fixture)
    ],
    tabFolders: [],
    activeGroupId: 'tg_side',
  });
  const r = await env.api('GET', '/tabs');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'workspace/tabs-response.json');
  const t = r.body.tabs;
  kit.eq(t.groups.map((g) => [g.id, g.sessionIds, g.hiddenPanes, g.capacity]), [['tg_main', [pid(0), pid(1)], 2, 6], ['tg_side', [pid(4)], 0, 6]]);
  kit.eq(t.desktopActiveGroupId, 'tg_side');
  kit.eq(env.ws.tabs.tabGroupIdsFor(pid(0)), ['tg_main']);
  kit.eq(env.chat.sessions.summary(pid(4)).tabGroupIds, ['tg_side'], 'B2 summaries carry the groups');
  stream = await kit.openStream(env.base, env.device.token);
  await stream.next((f) => f.type === 'ready');
  stream.send({ type: 'subscribe', id: 'c1', epoch: null, topics: [{ topic: 'tabs', sinceSeq: null }, { topic: 'sessions', sinceSeq: null }] });
  await stream.next((f) => f.type === 'subscribed');
  // Let B2's sessions.changed batch of the boot ("added") go out first.
  await kit.sleep(700);
});

kit.test('every operation applies, with tempIds inside one patch', async () => {
  const base = await rev();
  const sseFrom = env.sse.length;
  const frameFrom = stream.frames.length;
  const r = await env.api('PATCH', '/tabs', { baseRevision: base, ops: [
    { op: 'createFolder', tempId: 'f1', name: 'Work', color: 'blue' },
    { op: 'createGroup', tempId: 'g1', name: 'Research', afterGroupId: 'tg_main', folderId: 'f1' },
    { op: 'moveSession', sessionId: pid(2), toGroupId: 'g1', index: 0 },
    { op: 'moveSession', sessionId: pid(5), toGroupId: 'g1', index: 0 },
    { op: 'moveSession', sessionId: pid(1), toGroupId: 'g1' },
    { op: 'reorderSessions', groupId: 'g1', sessionIds: [pid(2), pid(1), pid(5)] },
    { op: 'renameGroup', groupId: 'tg_side', name: 'Side renamed' },
    { op: 'moveGroup', groupId: 'tg_side', afterGroupId: null, folderId: 'f1' },
    { op: 'renameFolder', folderId: 'f1', name: 'Work stuff' },
    { op: 'removeSession', sessionId: pid(4), groupId: 'tg_side' },
  ] });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'workspace/tabs-patch-result.json');
  kit.eq(r.body.rebased, false);
  const g1 = r.body.tempIds.g1;
  const f1 = r.body.tempIds.f1;
  const t = r.body.tabs;
  kit.eq(t.revision, base + 1, 'one revision per patch');
  kit.eq(t.groups.map((g) => [g.id, g.name, g.folderId]), [['tg_side', 'Side renamed', f1], ['tg_main', 'Main', null], [g1, 'Research', f1]]);
  kit.eq(t.groups[2].sessionIds, [pid(2), pid(1), pid(5)]);
  kit.eq(t.groups[1].sessionIds, [pid(0)], 'moved sessions left Main; the shell and duplicate stay hidden');
  kit.eq(t.groups[1].hiddenPanes, 2);
  kit.eq(t.groups[0].sessionIds, []);
  kit.eq(t.folders, [{ id: f1, name: 'Work stuff', color: 'blue', collapsed: false }]);
  // Panes the phone made: a terminal pane for a tracked session, a mirror for a discovered one.
  const stored = ls.read().layout.tabGroups.find((g) => g.id === g1).panes;
  const byUp = (u) => stored.find((p) => p.sessionId === recs.find((x) => x.resumeSessionId === u)?.id || (p.viewData && p.viewData.providerSessionId === u));
  kit.eq([byUp(up[2]).viewType, byUp(up[2]).sessionId], [null, recs[2].id]);
  kit.eq([byUp(up[5]).viewType, byUp(up[5]).viewData.provider], ['mirror', 'claude']);
  kit.eq(stored.map((p) => p.slot).sort(), [0, 1, 2]);
  // Once per change on both screens.
  const tu = await stream.next((f) => f.type === 'tabs.updated', 3000, frameFrom);
  kit.validateFrame(tu);
  kit.eq([tu.data.tabs.revision, tu.data.changedBy.kind], [base + 1, 'device']);
  await kit.sleep(150);
  kit.eq(stream.frames.slice(frameFrom).filter((f) => f.type === 'tabs.updated').length, 1, 'tabs.updated once');
  kit.eq(env.sse.slice(sseFrom).filter((e) => e.type === 'layout:updated').length, 1, 'layout:updated once');
  // B2 batches sessions.changed (500 ms), so wait for the batch.
  const changedNow = () => stream.frames.slice(frameFrom).filter((f) => f.type === 'sessions.changed').flatMap((f) => f.data.changes).filter((c) => c.change === 'updated').map((c) => c.sessionId);
  await kit.until(() => [pid(1), pid(2), pid(4), pid(5)].every((id) => changedNow().includes(id)), 3000, 'sessions.changed for the moved sessions');
  const changed = changedNow();
  kit.ok(!changed.includes(pid(0)), 'a session whose groups did not change is not announced');
  kit.eq(env.ws.tabs.tabGroupIdsFor(pid(5)), [g1]);
  kit.ok(env.auditEntries.some((a) => a.action === 'tabsPatch'), 'audited');
});

kit.test('TAB_GROUP_FULL at 6, all or nothing', async () => {
  const t = (await env.api('GET', '/tabs')).body.tabs;
  const g1 = t.groups[2].id;
  const ok = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [pid(0), pid(3), pid(6)].map((s) => ({ op: 'moveSession', sessionId: s, toGroupId: g1 })) });
  kit.eq([ok.status, ok.body.tabs.groups[2].sessionIds.length], [200, 6]);
  const before = await rev();
  const full = await env.api('PATCH', '/tabs', { baseRevision: before, ops: [{ op: 'renameGroup', groupId: g1, name: 'Changed' }, { op: 'moveSession', sessionId: pid(7), toGroupId: g1 }] });
  kit.eq([full.status, full.body.code, full.body.groupId], [409, 'TAB_GROUP_FULL', g1]);
  kit.eq(await rev(), before, 'nothing stored');
  kit.eq((await env.api('GET', '/tabs')).body.tabs.groups[2].name, 'Research', 'the first op did not land either');
  kit.eq(env.ws.internals.tabs.hasRoom(g1), false);
});

kit.test('LAST_TAB_GROUP, TABS_OP_INVALID with opIndex and current, INVALID_FIELD', async () => {
  let t = (await env.api('GET', '/tabs')).body.tabs;
  const del = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: t.groups.slice(1).map((g) => ({ op: 'deleteGroup', groupId: g.id })) });
  kit.eq(del.status, 200, JSON.stringify(del.body));
  t = del.body.tabs;
  kit.eq(t.groups.length, 1);
  const last = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'deleteGroup', groupId: t.groups[0].id }] });
  kit.eq([last.status, last.body.code], [409, 'LAST_TAB_GROUP']);
  const bad = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'renameGroup', groupId: t.groups[0].id, name: 'Fine' }, { op: 'renameGroup', groupId: 'tg_gone', name: 'x' }] });
  kit.eq([bad.status, bad.body.code, bad.body.opIndex], [409, 'TABS_OP_INVALID', 1]);
  kit.validate(bad.body.current, 'workspace/tabs.json');
  kit.eq(bad.body.current.revision, t.revision);
  const unknown = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'explode' }] });
  kit.eq([unknown.body.code, unknown.body.opIndex], ['TABS_OP_INVALID', 0]);
  const reorder = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'reorderSessions', groupId: t.groups[0].id, sessionIds: [pid(0), pid(0)] }] });
  kit.eq(reorder.body.code, 'TABS_OP_INVALID');
  const empty = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [] });
  kit.eq([empty.status, empty.body.code, empty.body.field], [400, 'INVALID_FIELD', 'ops']);
  const many = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: new Array(51).fill({ op: 'renameGroup', groupId: t.groups[0].id, name: 'x' }) });
  kit.eq(many.body.code, 'INVALID_FIELD');
  const nm = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'renameGroup', groupId: t.groups[0].id, name: 'x'.repeat(61) }] });
  kit.eq([nm.body.code, nm.body.field], ['INVALID_FIELD', 'name']);
  const noBase = await env.api('PATCH', '/tabs', { ops: [{ op: 'renameGroup', groupId: t.groups[0].id, name: 'x' }] });
  kit.eq([noBase.body.code, noBase.body.field], ['INVALID_FIELD', 'baseRevision']);
});

kit.test('strict If-Match answers 412 with current; without it an older base rebases', async () => {
  const t = (await env.api('GET', '/tabs')).body.tabs;
  const gid = t.groups[0].id;
  const stale = await env.api('PATCH', '/tabs', { baseRevision: t.revision - 1, ops: [{ op: 'renameGroup', groupId: gid, name: 'Strict' }] }, { 'If-Match': '"' + (t.revision - 1) + '"' });
  kit.eq([stale.status, stale.body.code], [412, 'REVISION_MISMATCH']);
  kit.validate(stale.body.current, 'workspace/tabs.json');
  const good = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'renameGroup', groupId: gid, name: 'Strict' }] }, { 'If-Match': '"' + t.revision + '"' });
  kit.eq([good.status, good.body.tabs.groups[0].name, good.body.rebased], [200, 'Strict', false]);
  const loose = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'renameGroup', groupId: gid, name: 'Loose' }] });
  kit.eq([loose.status, loose.body.rebased, loose.body.tabs.groups[0].name], [200, true, 'Loose']);
});

kit.test('addSessionToGroup places a new session after another; full groups refuse', async () => {
  const t = (await env.api('GET', '/tabs')).body.tabs;
  const gid = t.groups[0].id;
  const r = await env.api('PATCH', '/tabs', { baseRevision: t.revision, ops: [{ op: 'moveSession', sessionId: pid(0), toGroupId: gid }, { op: 'moveSession', sessionId: pid(1), toGroupId: gid }] });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  const listed = r.body.tabs.groups[0].sessionIds.slice();
  const res = env.ws.tabs.addSessionToGroup(gid, pid(7), listed[0], { deviceId: env.device.deviceId });
  kit.eq(res.groups[0].sessionIds.indexOf(pid(7)), 1, 'right after the named session');
  kit.eq(env.ws.tabs.tabGroupIdsFor(pid(7)), [gid]);
  let threw = null;
  try { env.ws.tabs.addSessionToGroup('tg_nope', pid(6), null); } catch (err) { threw = err; }
  kit.eq(threw && threw.code, 'INVALID_FIELD');
  stream.close();
});

kit.run(async () => { if (env) await env.close(); });
