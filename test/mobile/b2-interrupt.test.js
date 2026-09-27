/**
 * B2: interrupt (PROTOCOL.md 4.4.6, 7.5): exactly one 0x1b written alone,
 * a debounce of 1500 ms that answers "debounced" with the earlier time,
 * NOT_RUNNING when idle, PROMPT_OPEN when a prompt is open, idempotency by
 * clientRequestId, and stoppedBy phone on the turn that ends interrupted
 * (against the fake Claude in a PTY).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
process.env.CWM_VT_SIDECAR = '1';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');
const { createInterrupts } = require('../../src/web/mobile/chat/interrupt');

const sb = kit.sandbox();

function stubbed(state) {
  const writes = [];
  const w = { turnOpen: false, prompt: null };
  const svc = createInterrupts({
    ctx: { mobile: {} },
    index: { resolve: (id) => ({ sessionId: id, owner: 'workbook' }), meta: () => ({}), computerName: () => 'PC' },
    runtime: { write: (sid, b) => { writes.push(b); return true; }, withLock: async (sid, fn) => fn() },
    lazy: { turns: () => ({ isTurnOpen: () => w.turnOpen, stateOf: () => ({ state: w.turnOpen ? 'thinking' : 'idle' }) }), prompts: () => ({ openFor: () => (w.prompt ? [w.prompt] : []) }) },
  });
  return { svc, writes, w, state };
}
const code = async (p) => { try { await p; return null; } catch (e) { return [e.status, e.code, e.extra]; } };

kit.test('idle: 409 NOT_RUNNING and nothing written', async () => {
  const s = stubbed();
  kit.eq((await code(s.svc.interrupt('cl_a', {}, { deviceId: null })))[1], 'NOT_RUNNING');
  kit.eq(s.writes.length, 0);
});

kit.test('a prompt is open: 409 PROMPT_OPEN with its id', async () => {
  const s = stubbed();
  s.w.turnOpen = true;
  s.w.prompt = { promptId: 'p_12345678901234567890' };
  const c = await code(s.svc.interrupt('cl_a', {}, { deviceId: null }));
  kit.eq([c[0], c[1], c[2].promptId], [409, 'PROMPT_OPEN', 'p_12345678901234567890']);
});

kit.test('one ESC alone, then a second tap within 1500 ms is debounced; the same request id repeats its result', async () => {
  const s = stubbed();
  s.w.turnOpen = true;
  const a = await s.svc.interrupt('cl_a', { clientRequestId: 'r1' }, { deviceId: null });
  kit.eq(a.status, 'sent');
  kit.validate(a, 'sessions/interrupt-result.json');
  const b = await s.svc.interrupt('cl_a', { clientRequestId: 'r2' }, { deviceId: null });
  kit.eq([b.status, b.sentAtMs], ['debounced', a.sentAtMs]);
  const again = await s.svc.interrupt('cl_a', { clientRequestId: 'r1' }, { deviceId: null });
  kit.eq(again, a);
  kit.eq(s.writes, ['\x1b']);
  kit.ok(s.svc.lastPhoneEscAt('cl_a') === a.sentAtMs, 'remembered for stoppedBy');
});

let env;
kit.test('against the fake Claude: the turn ends interrupted with stoppedBy phone', async () => {
  env = await kit.bootChat({ pty: true });
  const cwd = path.join(sb.work, 'int');
  fs.mkdirSync(cwd, { recursive: true });
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: cwd });
  env.chat.internals.index.invalidate();
  await env.chat.launch.start('wb_' + rec.id, {});
  env.chat.internals.index.invalidate();
  const sid = env.chat.internals.index.idForWorkbookSession(rec.id);
  const pty = env.pm.getSession(rec.id);
  const writes = [];
  const orig = pty.pty.write.bind(pty.pty);
  pty.pty.write = (d) => { writes.push(String(d)); return orig(d); };
  const st = await kit.openStream(env.base, env.device.token);
  st.send({ type: 'subscribe', id: 's', epoch: null, topics: [{ topic: 'session:' + sid, sinceSeq: null }] });
  await st.next((f) => f.type === 'subscribed');
  await kit.api(env.base, 'POST', '/sessions/' + sid + '/send', { clientMessageId: crypto.randomUUID(), text: 'long: work' }, env.device.token);
  await st.next((f) => f.type === 'turn.start', 15000);
  const r = await kit.api(env.base, 'POST', '/sessions/' + sid + '/interrupt', { clientRequestId: crypto.randomUUID() }, env.device.token);
  kit.eq([r.status, r.body.status], [200, 'sent']);
  const end = await st.next((f) => f.type === 'turn.end', 10000);
  kit.eq([end.data.status, end.data.endSource, end.data.stoppedBy], ['interrupted', 'interruptMarker', 'phone']);
  kit.eq(writes.filter((w) => w === '\x1b').length, 1);
  st.close();
});

kit.run(async () => { if (env) await env.close(); });
