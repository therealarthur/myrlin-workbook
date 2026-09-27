/**
 * B2: the session index (PROTOCOL.md 3.4, 4.4.1, 4.4.2, 9.1): one entry per
 * conversation across tracked and discovered sessions, upstream first ids
 * with wb_ only until linked, title precedence, owners (workbook,
 * background, external, chatgpt, handedOff, none), sessions.changed
 * batching, idChanged re-keying, and schema valid recent and detail answers.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const crypto = require('crypto');
const path = require('path');
const kit = require('./fakes/b2-kit');
const { createDiscoveryCache } = require('../../src/web/mobile/chat/discovery-cache');

const sb = kit.sandbox();
const agentEntries = new Map();
const agents = { watch: () => () => {}, entryFor: (id) => agentEntries.get(id) || null, onPoll: () => () => {}, refreshSoon() {}, onDemand: async () => null, stop() {} };
const discovery = createDiscoveryCache({ registry: { getProvider: () => null } });
let env;
const cwd = path.join(sb.work, 'idx');
const ids = { tracked: crypto.randomUUID(), discovered: crypto.randomUUID(), bg: crypto.randomUUID(), ext: crypto.randomUUID(), desk: crypto.randomUUID() };
let trackedRec;
let freshRec;

kit.test('boot with seeded discovery and transcripts', async () => {
  env = await kit.bootChat({ options: { agents, discovery } });
  kit.writeClaude(sb.projects, cwd, ids.tracked, kit.claudeExchange('first tracked prompt'));
  kit.writeClaude(sb.projects, cwd, ids.discovered, [{ type: 'ai-title', aiTitle: 'Provider made title' }].concat(kit.claudeExchange('discovered prompt')));
  kit.writeClaude(sb.projects, cwd, ids.bg, kit.claudeExchange('background one'));
  kit.writeClaude(sb.projects, cwd, ids.ext, kit.claudeExchange('external one'));
  kit.writeCodex(sb.codexHome, ids.desk, kit.codexExchange('desktop thread'), { originator: 'Codex Desktop' });
  trackedRec = kit.trackedSession(env.store, { provider: 'claude', resumeSessionId: ids.tracked, workingDir: cwd, name: 'Named in Workbook' });
  freshRec = kit.trackedSession(env.store, { provider: 'codex', workingDir: cwd, name: 'Fresh codex', command: 'codex' });
  discovery._seed('claude', [ids.tracked, ids.discovered, ids.bg, ids.ext].map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: cwd, title: null, lastActive: new Date(), sizeBytes: 100 })));
  discovery._seed('codex', [{ provider: 'codex', providerSessionId: ids.desk, projectPath: cwd, title: 'Desk thread', lastActive: new Date(), sizeBytes: 50 }]);
  agentEntries.set(ids.bg, { sessionId: ids.bg, id: 'abcd1234', kind: 'background', status: 'idle', state: 'working' });
  agentEntries.set(ids.ext, { sessionId: ids.ext, kind: 'interactive', status: 'busy' });
  env.chat.internals.index.invalidate();
});

kit.test('one entry per conversation: the tracked session wins its upstream id; a fresh pane is wb_', async () => {
  const list = env.chat.sessions.list();
  const clTracked = list.filter((s) => s.sessionId === 'cl_' + ids.tracked);
  kit.eq(clTracked.length, 1);
  kit.eq([clTracked[0].tracked, clTracked[0].workbookSessionId, clTracked[0].title, clTracked[0].titleSource], [true, trackedRec.id, 'Named in Workbook', 'workbook']);
  kit.ok(list.some((s) => s.sessionId === 'wb_' + freshRec.id), 'wb_ for the unlinked Codex pane');
  kit.ok(!list.some((s) => s.sessionId === 'wb_' + trackedRec.id), 'no duplicate wb_ entry');
});

kit.test('titles: title store beats provider title beats first message', async () => {
  const d = env.chat.sessions.summary('cl_' + ids.discovered);
  kit.eq([d.title, d.titleSource], ['Provider made title', 'provider']);
  env.store.setProviderSessionTitle('claude', ids.discovered, 'Renamed on the desktop');
  const d2 = env.chat.sessions.summary('cl_' + ids.discovered);
  kit.eq([d2.title, d2.titleSource], ['Renamed on the desktop', 'titleStore']);
  const bg = env.chat.sessions.summary('cl_' + ids.bg);
  kit.eq([bg.title, bg.titleSource], ['background one', 'firstMessage']);
});

kit.test('owners: background, external, chatgpt, handedOff, none, and their read only reasons', async () => {
  const own = (id) => env.chat.sessions.meta(id);
  kit.eq(own('cl_' + ids.bg).owner, 'background');
  const ext = own('cl_' + ids.ext);
  kit.eq([ext.owner, ext.ownerDetail !== null], ['external', true]);
  kit.ok(/Open in a terminal on .*\. You can read it live here\./.test(ext.readOnlyReason), ext.readOnlyReason);
  kit.eq(own('cx_' + ids.desk).owner, 'chatgpt');
  kit.eq(own('cl_' + ids.tracked).owner, 'none');
  env.chat.sessions.setHandedOff('cl_' + ids.discovered, { targetSessionId: 'cl_x', targetTitle: 'Takeover', migrationId: 'mg_x' });
  const h = own('cl_' + ids.discovered);
  kit.eq([h.owner, h.readOnlyReason], ['handedOff', 'Handed off to Takeover. This session is paused.']);
  const r = await kit.api(env.base, 'POST', '/sessions/cl_' + ids.discovered + '/resume-anyway', { clientRequestId: crypto.randomUUID(), confirm: true }, env.device.token);
  kit.eq([r.status, r.body.owner], [200, 'none']);
  kit.validate(r.body, 'sessions/session-meta.json');
});

kit.test('GET /sessions/recent pages from memory and validates; GET /sessions/:id is a snapshot', async () => {
  const r = await kit.api(env.base, 'GET', '/sessions/recent?limit=2', null, env.device.token);
  kit.eq(r.status, 200);
  kit.validate(r.body, 'sessions/recent-sessions.json');
  kit.ok(r.body.nextCursor, 'next page');
  const r2 = await kit.api(env.base, 'GET', '/sessions/recent?limit=200&cursor=' + r.body.nextCursor, null, env.device.token);
  kit.ok(r2.body.sessions.length >= 4, 'rest');
  const d = await kit.api(env.base, 'GET', '/sessions/cl_' + ids.tracked, null, env.device.token);
  kit.eq(d.status, 200);
  kit.validate(d.body, 'sessions/session-detail.json');
  kit.eq(d.body.streamEpoch, env.chat.internals.hub.epoch);
  const missing = await kit.api(env.base, 'GET', '/sessions/cl_' + crypto.randomUUID(), null, env.device.token);
  kit.eq([missing.status, missing.body.code], [404, 'SESSION_NOT_FOUND']);
});

kit.test('sessions.changed is batched into one event and idChanged re-keys wb_ to cx_', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  s.send({ type: 'subscribe', id: 'x', epoch: null, topics: [{ topic: 'sessions', sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const idx = env.chat.internals.index;
  idx.noteChanged('cl_' + ids.bg, 'updated');
  idx.noteChanged('cl_' + ids.ext, 'updated');
  const thread = crypto.randomUUID();
  kit.writeCodex(sb.codexHome, thread, kit.codexExchange('linked'));
  env.store.updateSession(freshRec.id, { resumeSessionId: thread });
  idx.rekey('wb_' + freshRec.id, 'cx_' + thread);
  const ev = await s.next((f) => f.type === 'sessions.changed', 3000);
  kit.validateFrame(ev);
  const byId = new Map(ev.data.changes.map((c) => [c.sessionId, c.change]));
  kit.eq([byId.get('cl_' + ids.bg), byId.get('cl_' + ids.ext), byId.get('cx_' + thread)], ['updated', 'updated', 'idChanged']);
  await kit.sleep(700);
  kit.eq(s.frames.filter((f) => f.type === 'sessions.changed').length, 1, 'one batched event');
  const idc = ev.data.changes.find((c) => c.change === 'idChanged');
  kit.eq([idc.previousSessionId, idc.sessionId], ['wb_' + freshRec.id, 'cx_' + thread]);
  const old = await kit.api(env.base, 'GET', '/sessions/wb_' + freshRec.id, null, env.device.token);
  kit.eq([old.status, old.body.meta.supersededBy], [200, 'cx_' + thread]);
  s.close();
});

kit.run(async () => { if (env) await env.close(); });
