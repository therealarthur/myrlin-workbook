/**
 * B2: the /ws/m/v2 stream (PROTOCOL.md 5): upgrade checks, ready, live
 * subscribe, replay within the ring, RING_EXPIRED, EPOCH_CHANGED, SEQ_AHEAD,
 * scope loss, auth renewal, 4001, 4409, 4500, 4429, 4400, topic errors, the
 * SCREEN_MODEL_OFF notice once per connection (PROTOCOL.md 1.6) and the
 * WORKBOOK_SHUTTING_DOWN notice before a 1001 close (5.6), and every frame
 * validated against the envelope and its event or control schema.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const kit = require('./fakes/b2-kit');

kit.sandbox();
let env;

kit.test('boot the chat track on the B1 stub', async () => {
  env = await kit.bootChat({ options: { hub: { ringSizes: { tabs: 4 }, tokenGraceMs: 300, heartbeatMs: 100, deadPeerMs: 200 } } });
});

kit.test('upgrade refusals answer plain HTTP error bodies', async () => {
  const noToken = await kit.openStream(env.base, null).catch((e) => e);
  kit.eq([noToken.status, noToken.body && noToken.body.code], [401, 'AUTH_REQUIRED']);
  const noProto = await kit.openStream(env.base, env.device.token, { protocol: null }).catch((e) => e);
  kit.eq([noProto.status, noProto.body && noProto.body.code], [400, 'SUBPROTOCOL_REQUIRED']);
  const origin = await kit.openStream(env.base, env.device.token, { origin: 'https://evil.example' }).catch((e) => e);
  kit.eq([origin.status, origin.body && origin.body.code], [403, 'WEB_ORIGIN_REFUSED']);
});

let s1;
kit.test('ready frame first, with the automatic topics', async () => {
  s1 = await kit.openStream(env.base, env.device.token);
  const ready = await s1.next((f) => f.type === 'ready');
  kit.validateFrame(ready);
  kit.eq(ready.data.topics.map((t) => t.topic), ['computer', 'device']);
  kit.eq(ready.data.streamEpoch, env.chat.internals.hub.epoch);
  kit.eq(ready.seq, 0);
});

kit.test('live subscribe, then published events arrive with seq 1, 2, 3', async () => {
  s1.send({ type: 'subscribe', id: 'c1', epoch: null, topics: [{ topic: 'tabs', sinceSeq: null }] });
  const sub = await s1.next((f) => f.type === 'subscribed' && f.data.id === 'c1');
  kit.validateFrame(sub);
  kit.eq(sub.data.topics[0].mode, 'live');
  const hub = env.chat.internals.hub;
  for (let i = 0; i < 3; i++) hub.publish('tabs', 'tabs.updated', { tabs: { revision: i, groups: [], folders: [], desktopActiveGroupId: null }, changedBy: { kind: 'desktop', deviceId: null } });
  await kit.until(() => s1.frames.filter((f) => f.topic === 'tabs').length === 3, 2000, 'three events');
  kit.eq(s1.frames.filter((f) => f.topic === 'tabs').map((f) => f.seq), [1, 2, 3]);
  for (const f of s1.frames) kit.validateFrame(f);
});

kit.test('replay after a gap within the ring, before any live event', async () => {
  const s2 = await kit.openStream(env.base, env.b1.addDevice().token);
  await s2.next((f) => f.type === 'ready');
  s2.send({ type: 'subscribe', id: 'r', epoch: env.chat.internals.hub.epoch, topics: [{ topic: 'tabs', sinceSeq: 1 }] });
  const sub = await s2.next((f) => f.type === 'subscribed');
  kit.eq([sub.data.topics[0].mode, sub.data.topics[0].replayed], ['replay', 2]);
  await kit.until(() => s2.frames.filter((f) => f.topic === 'tabs').length === 2, 2000, 'replayed');
  kit.eq(s2.frames.filter((f) => f.topic === 'tabs').map((f) => f.seq), [2, 3]);
  s2.close();
});

kit.test('RING_EXPIRED beyond the ring, EPOCH_CHANGED with another epoch, SEQ_AHEAD above current', async () => {
  const hub = env.chat.internals.hub;
  for (let i = 0; i < 6; i++) hub.publish('tabs', 'tabs.updated', { tabs: { revision: 10 + i, groups: [], folders: [], desktopActiveGroupId: null }, changedBy: { kind: 'desktop', deviceId: null } });
  const s3 = await kit.openStream(env.base, env.b1.addDevice().token);
  await s3.next((f) => f.type === 'ready');
  s3.send({ type: 'subscribe', id: 'x', epoch: hub.epoch, topics: [{ topic: 'tabs', sinceSeq: 1 }] });
  const rx = await s3.next((f) => f.type === 'resync');
  kit.eq(rx.data.reason, 'RING_EXPIRED');
  kit.validateFrame(rx);
  s3.send({ type: 'subscribe', id: 'y', epoch: 'e_AAAAAAAAAAAAAAAA', topics: [{ topic: 'tabs', sinceSeq: 5 }] });
  const ex = await s3.next((f) => f.type === 'resync' && f.data.reason === 'EPOCH_CHANGED');
  kit.ok(ex, 'epoch changed');
  s3.send({ type: 'subscribe', id: 'z', epoch: hub.epoch, topics: [{ topic: 'tabs', sinceSeq: 999 }] });
  await s3.next((f) => f.type === 'resync' && f.data.reason === 'SEQ_AHEAD');
  s3.close();
});

kit.test('topic errors: unknown topic, unknown session, no scope', async () => {
  s1.send({ type: 'subscribe', id: 'e1', epoch: null, topics: [{ topic: 'nope', sinceSeq: null }, { topic: 'session:cl_00000000-0000-4000-8000-000000000000', sinceSeq: null }] });
  await s1.next((f) => f.type === 'error' && f.data.code === 'TOPIC_NOT_FOUND');
  await s1.next((f) => f.type === 'error' && f.data.code === 'SESSION_NOT_FOUND');
  const narrow = env.b1.addDevice(['chat']);
  const s4 = await kit.openStream(env.base, narrow.token);
  await s4.next((f) => f.type === 'ready');
  s4.send({ type: 'subscribe', id: 'a', epoch: null, topics: [{ topic: 'accounts', sinceSeq: null }] });
  const err = await s4.next((f) => f.type === 'error');
  kit.eq([err.data.code, err.data.scope], ['SCOPE_REQUIRED', 'accounts.read']);
  kit.validateFrame(err);
  s4.close();
});

kit.test('scope loss removes topics with error and unsubscribed, socket stays open', async () => {
  const d = env.b1.addDevice();
  const s5 = await kit.openStream(env.base, d.token);
  await s5.next((f) => f.type === 'ready');
  s5.send({ type: 'subscribe', id: 's', epoch: null, topics: [{ topic: 'tabs', sinceSeq: null }, { topic: 'accounts', sinceSeq: null }] });
  await s5.next((f) => f.type === 'subscribed');
  env.b1.setScopes(d.deviceId, ['accounts.read']);
  const err = await s5.next((f) => f.type === 'error' && f.data.code === 'SCOPE_REQUIRED');
  kit.eq(err.data.scope, 'chat');
  const uns = await s5.next((f) => f.type === 'unsubscribed');
  kit.eq([uns.data.id, uns.data.topics], [null, ['tabs']]);
  kit.ok(s5.closeInfo() === null, 'still open');
  s5.close();
});

kit.test('ping answers pong; auth renews with a newer token of the same device', async () => {
  s1.send({ type: 'ping', id: 'p', ts: 123 });
  const pong = await s1.next((f) => f.type === 'pong');
  kit.eq([pong.data.id, pong.data.ts], ['p', 123]);
  const fresh = env.b1.mintToken(env.device.deviceId);
  s1.send({ type: 'auth', id: 'au', token: fresh });
  const authed = await s1.next((f) => f.type === 'authed');
  kit.ok(authed.data.expiresAtMs > Date.now(), 'expiry');
  const other = env.b1.addDevice();
  s1.send({ type: 'auth', id: 'bad', token: other.token });
  const err = await s1.next((f) => f.type === 'error' && f.data.id === 'bad');
  kit.eq(err.data.code, 'AUTH_FAILED');
});

kit.test('a token expired past the grace without auth closes 4001', async () => {
  const d = env.b1.addDevice(null, 200);
  const s = await kit.openStream(env.base, d.token);
  const info = await s.closed;
  kit.eq(info.code, 4001);
});

kit.test('a third socket of one device closes the oldest with 4409', async () => {
  const d = env.b1.addDevice();
  const a = await kit.openStream(env.base, d.token);
  await kit.sleep(20);
  const b = await kit.openStream(env.base, d.token);
  const c = await kit.openStream(env.base, d.token);
  const info = await a.closed;
  kit.eq(info.code, 4409);
  kit.ok(b.closeInfo() === null && c.closeInfo() === null, 'newer sockets open');
  b.close(); c.close();
});

kit.test('three unparseable commands close 4400; more than 50 commands in 10 s close 4429', async () => {
  const d = env.b1.addDevice();
  const a = await kit.openStream(env.base, d.token);
  a.send('not json'); a.send('{'); a.send('[]');
  kit.eq((await a.closed).code, 4400);
  const b = await kit.openStream(env.base, d.token);
  for (let i = 0; i < 52; i++) b.send({ type: 'ping', id: 'x' + i, ts: i });
  kit.eq((await b.closed).code, 4429);
});

kit.test('a slow reader closes 4500', async () => {
  const saved = env.chat;
  await env.close();
  env = await kit.bootChat({ options: { hub: { sendBufferLimit: 1 } } });
  const s = await kit.openStream(env.base, env.device.token);
  s.send({ type: 'subscribe', id: 't', epoch: null, topics: [{ topic: 'tabs', sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const big = 'x'.repeat(200000);
  for (let i = 0; i < 5; i++) env.chat.internals.hub.publish('tabs', 'tabs.updated', { tabs: { revision: i, groups: [], folders: [], desktopActiveGroupId: null, pad: big }, changedBy: { kind: 'desktop', deviceId: null } });
  const info = await s.closed;
  kit.eq(info.code, 4500);
  void saved;
});

kit.test('revocation closes the device sockets with 4401', async () => {
  const d = env.b1.addDevice();
  const s = await kit.openStream(env.base, d.token);
  await s.next((f) => f.type === 'ready');
  env.b1.revoke(d.deviceId);
  kit.eq((await s.closed).code, 4401);
});

kit.test('screen model off: every stream connection gets one SCREEN_MODEL_OFF computer.notice (PROTOCOL.md 1.6)', async () => {
  await env.close();
  env = await kit.bootChat({ options: { screenModel: false } });
  const a = await kit.openStream(env.base, env.device.token);
  const n1 = await a.next((f) => f.type === 'computer.notice');
  kit.validateFrame(n1);
  kit.eq([n1.topic, n1.data.notice.code, n1.data.notice.level, n1.data.notice.sessionId], ['computer', 'SCREEN_MODEL_OFF', 'warn', null]);
  kit.ok(/questions and approvals show only on /.test(n1.data.notice.message), n1.data.notice.message);
  kit.ok(a.frames.findIndex((f) => f.type === 'ready') < a.frames.indexOf(n1), 'after ready');
  await kit.sleep(200);
  kit.eq(a.frames.filter((f) => f.type === 'computer.notice').length, 1, 'one for this connection');
  const b = await kit.openStream(env.base, env.b1.addDevice().token);
  const n2 = await b.next((f) => f.type === 'computer.notice');
  kit.eq([n2.data.notice.noticeId, n2.seq], [n1.data.notice.noticeId, n1.seq + 1], 'stable id within the epoch, gapless seq');
  a.close();
  b.close();
});

kit.test('screen model on: a connection gets no SCREEN_MODEL_OFF notice', async () => {
  await env.close();
  env = await kit.bootChat({ options: { screenModel: true } });
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  await kit.sleep(300);
  kit.eq(s.frames.filter((f) => f.type === 'computer.notice').length, 0);
  kit.eq(env.chat.capabilities().screenModel, true);
  s.close();
});

kit.test('hub close sends WORKBOOK_SHUTTING_DOWN, then closes 1001 (PROTOCOL.md 5.6)', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  env.chat.internals.hub.close();
  const info = await s.closed;
  kit.eq(info.code, 1001);
  const n = s.frames.find((f) => f.type === 'computer.notice' && f.data.notice.code === 'WORKBOOK_SHUTTING_DOWN');
  kit.ok(n, 'shutdown notice before the close');
  kit.validateFrame(n);
  kit.eq(s.frames[s.frames.length - 1], n, 'the last frame before 1001');
  kit.ok(/^Workbook is restarting on .+\.$/.test(n.data.notice.message), n.data.notice.message);
});

kit.run(async () => { if (env) await env.close(); });
