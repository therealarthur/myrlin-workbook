/**
 * b3-names.test.js: renames, pin and archive (PROTOCOL.md 4.5.1, 4.5.2;
 * decision A13; critic F23; BUILD-CONTRACT 3.7.2 "Renames", S9).
 *
 * A tracked session's rename writes the store session's name, a discovered
 * session's rename writes Workbook's title store, an empty name clears it so
 * the title falls back, and no rename ever touches a transcript or the
 * provider's own title. Both screens hear about it: the phone through
 * session.meta and sessions.changed, the desktop through the store's
 * session:updated event (tracked) or the new session:title event (S9).
 * Pin and archive live in <dataDir>/mobile/session-flags.json. Project and
 * folder renames call the store and answer their nodes.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./b3-kit');
const { createDiscoveryCache } = require('../../src/web/mobile/chat/discovery-cache');
const names = require('../../src/web/mobile/workspace/names');

const sb = kit.sandbox();
const discovery = createDiscoveryCache({ registry: { getProvider: () => null } });
const dir = path.join(sb.work, 'names');
const ids = { tracked: crypto.randomUUID(), disc: crypto.randomUUID() };
let env;
let ws;
let group;
let files;
const storeEvents = [];

kit.test('boot with a tracked and a discovered session', async () => {
  env = await kit.bootWorkspace({ chat: { discovery } });
  ws = env.store.createWorkspace({ name: 'Names project' });
  group = env.store.createGroup({ name: 'Names folder' });
  env.store.moveWorkspaceToGroup(ws.id, group.id);
  files = {
    tracked: kit.writeClaude(sb.projects, dir, ids.tracked, [{ type: 'custom-title', customTitle: 'Provider custom' }].concat(kit.claudeExchange('tracked one'))),
    disc: kit.writeClaude(sb.projects, dir, ids.disc, [{ type: 'ai-title', aiTitle: 'Provider ai title' }].concat(kit.claudeExchange('discovered one'))),
  };
  kit.tracked(env.store, { workspaceId: ws.id, provider: 'claude', workingDir: dir, resumeSessionId: ids.tracked, name: 'Tracked name' });
  discovery._seed('claude', [ids.tracked, ids.disc].map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: dir, lastActive: new Date(), sizeBytes: 100 })));
  env.chat.internals.index.invalidate();
  env.store.on('session:updated', (s) => storeEvents.push({ type: 'session:updated', name: s && s.name }));
  env.store.on('providerSessionTitles:updated', (d) => storeEvents.push({ type: 'providerSessionTitles:updated', d }));
});

kit.test('renaming a tracked session writes the store name, never the transcript', async () => {
  const before = fs.readFileSync(files.tracked);
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  s.send({ type: 'subscribe', id: 'c1', epoch: null, topics: [{ topic: 'session:cl_' + ids.tracked, sinceSeq: null }, { topic: 'sessions', sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const r = await env.api('PATCH', '/sessions/cl_' + ids.tracked, { name: '  Renamed on the phone  ' });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'sessions/session-meta.json');
  kit.eq([r.body.title, r.body.titleSource], ['Renamed on the phone', 'workbook']);
  const rec = env.store.getAllSessionsList().find((x) => x.resumeSessionId === ids.tracked);
  kit.eq(rec.name, 'Renamed on the phone');
  kit.ok(storeEvents.some((e) => e.type === 'session:updated' && e.name === 'Renamed on the phone'), 'the store emitted session:updated (the desktop event)');
  kit.ok(Buffer.compare(before, fs.readFileSync(files.tracked)) === 0, 'transcript untouched');
  const meta = await s.next((f) => f.type === 'session.meta' && f.data.title === 'Renamed on the phone', 3000);
  kit.validateFrame(meta);
  const changed = await s.next((f) => f.type === 'sessions.changed' && f.data.changes.some((c) => c.sessionId === 'cl_' + ids.tracked && c.summary && c.summary.title === 'Renamed on the phone'), 3000);
  kit.validateFrame(changed);
  s.close();
});

kit.test('renaming a discovered session writes the title store; session:title reaches the desktop', async () => {
  const before = fs.readFileSync(files.disc);
  const r = await env.api('PATCH', '/sessions/cl_' + ids.disc, { name: 'Phone title' });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq([r.body.title, r.body.titleSource], ['Phone title', 'titleStore']);
  kit.eq(env.store.getProviderSessionTitle('claude', ids.disc), 'Phone title');
  kit.ok(Buffer.compare(before, fs.readFileSync(files.disc)) === 0, 'transcript untouched, provider title untouched');
  const ev = storeEvents.find((e) => e.type === 'providerSessionTitles:updated');
  kit.ok(ev, 'the store emitted providerSessionTitles:updated');
  // S9: the payload server.js broadcasts as session:title.
  kit.eq(names.titleEventFor(ev.d, env.store), { provider: 'claude', upstreamId: ids.disc, title: 'Phone title' });
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'web', 'server.js'), 'utf8');
  kit.ok(/store\.on\('providerSessionTitles:updated', \(d\) => broadcastSSE\('session:title', require\('\.\/mobile\/workspace\/names'\)\.titleEventFor\(d\)\)\)/.test(src), 'server.js forwards the event (S9)');
  // An empty name clears the title store: the provider title comes back.
  const c = await env.api('PATCH', '/sessions/cl_' + ids.disc, { name: '' });
  kit.eq([c.status, c.body.title, c.body.titleSource], [200, 'Provider ai title', 'provider']);
  kit.eq(env.store.getProviderSessionTitle('claude', ids.disc), null);
  kit.eq(names.titleEventFor({ providerId: 'claude', upstreamSessionId: ids.disc, deleted: true }, env.store).title, null);
});

kit.test('names are validated: one line, at most 200 characters', async () => {
  const a = await env.api('PATCH', '/sessions/cl_' + ids.tracked, { name: 'two\nlines' });
  kit.eq([a.status, a.body.code, a.body.field], [400, 'INVALID_FIELD', 'name']);
  const b = await env.api('PATCH', '/sessions/cl_' + ids.tracked, { name: 'x'.repeat(201) });
  kit.eq([b.status, b.body.code], [400, 'INVALID_FIELD']);
  const c = await env.api('PATCH', '/sessions/cl_nope', { name: 'x' });
  kit.eq([c.status, c.body.code], [404, 'SESSION_NOT_FOUND']);
  const d = await env.api('PATCH', '/sessions/cl_' + ids.tracked, { pinned: 'yes' });
  kit.eq([d.status, d.body.code, d.body.field], [400, 'INVALID_FIELD', 'pinned']);
});

kit.test('pin and archive persist in session-flags.json; archived leaves the lists', async () => {
  const r = await env.api('PATCH', '/sessions/cl_' + ids.disc, { pinned: true, archived: true });
  kit.eq([r.status, r.body.pinned, r.body.archived], [200, true, true]);
  const file = path.join(process.env.CWM_DATA_DIR, 'mobile', 'session-flags.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  kit.eq(doc.flags['cl_' + ids.disc].pinned, true);
  const recent = await env.api('GET', '/sessions/recent');
  kit.ok(!recent.body.sessions.some((s) => s.sessionId === 'cl_' + ids.disc), 'archived is not in recent');
  const all = await env.api('GET', '/sessions/recent?includeArchived=true');
  const s = all.body.sessions.find((x) => x.sessionId === 'cl_' + ids.disc);
  kit.eq([s.pinned, s.archived], [true, true]);
  const back = await env.api('PATCH', '/sessions/cl_' + ids.disc, { archived: false });
  kit.eq([back.body.pinned, back.body.archived], [true, false]);
});

kit.test('project and folder renames call the store and answer their nodes', async () => {
  const p = await env.api('PATCH', '/projects/' + ws.id, { name: 'Renamed project' });
  kit.eq(p.status, 200, JSON.stringify(p.body));
  kit.validate(p.body, 'workspace/project-node.json');
  kit.eq([p.body.name, env.store.getWorkspace(ws.id).name], ['Renamed project', 'Renamed project']);
  const f = await env.api('PATCH', '/folders/' + group.id, { name: 'Renamed folder' });
  kit.eq(f.status, 200, JSON.stringify(f.body));
  kit.validate(f.body, 'workspace/folder-node.json');
  kit.eq([f.body.name, f.body.projectIds], ['Renamed folder', [ws.id]]);
  const u = await env.api('PATCH', '/projects/unassigned', { name: 'x' });
  kit.eq([u.status, u.body.code], [409, 'NOT_RENAMABLE']);
  const n = await env.api('PATCH', '/projects/nope', { name: 'x' });
  kit.eq([n.status, n.body.code], [404, 'PROJECT_NOT_FOUND']);
  const g = await env.api('PATCH', '/folders/nope', { name: 'x' });
  kit.eq([g.status, g.body.code], [404, 'FOLDER_NOT_FOUND']);
  const e = await env.api('PATCH', '/projects/' + ws.id, { name: '' });
  kit.eq([e.status, e.body.code], [400, 'INVALID_FIELD']);
  kit.ok(env.auditEntries.some((a) => a.action === 'rename'), 'renames are audited');
});

kit.run(async () => { if (env) await env.close(); });
