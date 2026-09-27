/**
 * B2: the send guard (PROTOCOL.md 7, critic F1). With a scripted runtime:
 * each of G1 to G8 holds a send with its reason; delivery writes exactly
 * ESC[200~ text ESC[201~ and, at least 80 ms later, a lone CR; a dialog that
 * opens between paste and submit fails the send with DIALOG_OPENED and no
 * CR; the queue survives a restart from its file and writing records become
 * WRITE_INTERRUPTED; confirmation replaces the provisional message. Then the
 * real path through the fake Claude CLI in a Workbook PTY, with spies proving
 * requestSizeOwnership and applyViewport are never called.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
process.env.CWM_VT_SIDECAR = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');
const { createSendQueue, PASTE_START, PASTE_END } = require('../../src/web/mobile/chat/send-queue');

const sb = kit.sandbox();
const DEV = 'd_' + 'A'.repeat(20);
const SID = 'cl_' + crypto.randomUUID();
const idle = { kind: 'idlePrompt', input: { inputText: '', placeholder: true }, busy: false };

/** A scripted world for the queue. */
function world(dataDir) {
  const w = { cls: idle, turnOpen: false, prompt: false, paste: true, pty: { lastDesktopInputAt: 0 }, writes: [], events: [], onWrite: null };
  const hub = { publish: (topic, type, data) => { w.events.push({ type, data }); return 1; } };
  const ctx = { mobile: { hub }, dataDir };
  const index = { resolve: () => ({ sessionId: SID, owner: 'workbook', provider: 'claude', upstreamId: SID.slice(3) }), meta: () => ({}), computerName: () => 'PC' };
  const runtime = {
    ptyOf: () => w.pty,
    hasScreen: () => true,
    freshScreen: async () => ({ cls: w.cls, snap: null }),
    bracketedPaste: () => w.paste,
    write: (sid, bytes) => { w.writes.push({ bytes, at: Date.now() }); if (w.onWrite) w.onWrite(bytes); return true; },
    withLock: async (sid, fn) => fn(),
    onScreen: () => () => {},
  };
  const lazy = {
    turns: () => ({ isTurnOpen: () => w.turnOpen, refresh() {} }),
    prompts: () => ({ openFor: () => (w.prompt ? [{ promptId: 'p_x' }] : []) }),
    uploads: () => ({ getOwned: () => null }),
  };
  w.q = createSendQueue({ ctx, index, runtime, lazy, timings: { gateTickMs: 20, typingGuardMs: 300 } });
  return w;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'b2-sq-'));
const send = (w, text) => w.q.accept(SID, { clientMessageId: crypto.randomUUID(), text }, { deviceId: DEV });
const rec = (w, r) => w.q._records.get(SID + '|' + r.send.clientMessageId);

const holds = [
  ['G1 an open prompt', (w) => { w.prompt = true; }, 'promptOpen'],
  ['G2 an unknown modal', (w) => { w.cls = { kind: 'unknownModal', dialog: {}, input: null, busy: false }; }, 'promptOpen'],
  ['G3 a desktop draft', (w) => { w.cls = { kind: 'idlePrompt', input: { inputText: 'half typed', placeholder: false }, busy: false }; }, 'desktopDraft'],
  ['G4 desktop typing in the last 2 s', (w) => { w.pty.lastDesktopInputAt = Date.now(); }, 'desktopTyping'],
  ['G5 an open turn', (w) => { w.turnOpen = true; }, 'busy'],
  ['G6 a screen that is not the idle input', (w) => { w.cls = { kind: 'none', input: null, busy: false }; }, 'screenUnknown'],
  ['G7 bracketed paste mode off', (w) => { w.paste = false; }, 'pasteModeOff'],
];
for (const [name, setup, reason] of holds) {
  kit.test(name + ' holds the send with reason ' + reason + ' and writes nothing', async () => {
    const w = world(tmp());
    setup(w);
    const r = send(w, 'held');
    kit.eq(r.status, 202);
    kit.validate(r.send, 'sessions/send-record.json');
    await kit.until(() => rec(w, r).reason === reason, 1000, reason);
    await kit.sleep(100);
    kit.eq(w.writes.length, 0);
    kit.eq(rec(w, r).state, 'queued');
  });
}

kit.test('G8 a second send waits behindEarlier while the first is held', async () => {
  const w = world(tmp());
  w.turnOpen = true;
  send(w, 'one');
  const b = send(w, 'two');
  await kit.until(() => rec(w, b).reason === 'behindEarlier', 1000, 'behindEarlier');
  kit.eq(w.q.list(SID).map((s) => s.position), [1, 2]);
});

kit.test('delivery: one bracketed paste, then after at least 80 ms a lone CR, then delivered', async () => {
  const w = world(tmp());
  const r = send(w, 'Run the tests again.');
  await kit.until(() => rec(w, r).state === 'delivered', 2000, 'delivered');
  kit.eq(w.writes.map((x) => x.bytes), [PASTE_START + 'Run the tests again.' + PASTE_END, '\r']);
  kit.ok(w.writes[1].at - w.writes[0].at >= 80, 'gap ' + (w.writes[1].at - w.writes[0].at));
  kit.eq(w.events.filter((e) => e.type === 'send.update').map((e) => e.data.send.state).filter((s, i, a) => a.indexOf(s) === i), ['queued', 'writing', 'delivered']);
  const prov = w.events.find((e) => e.type === 'message.add').data.message;
  kit.eq([prov.id, prov.status, prov.origin.kind], ['pm_' + r.send.clientMessageId, 'pending', 'phone']);
});

kit.test('a dialog that opens between paste and submit fails the send with DIALOG_OPENED and no CR', async () => {
  const w = world(tmp());
  w.onWrite = (bytes) => { if (bytes.startsWith(PASTE_START)) w.cls = { kind: 'prompt', dialog: {}, input: null, busy: false }; };
  const r = send(w, 'hello');
  await kit.until(() => rec(w, r).state === 'failed', 2000, 'failed');
  kit.eq(rec(w, r).error.code, 'DIALOG_OPENED');
  kit.eq(w.writes.length, 1);
  kit.ok(!w.writes.some((x) => x.bytes === '\r'), 'no submit');
});

kit.test('the text is sanitised: CRLF to LF, paste markers and controls removed', async () => {
  const w = world(tmp());
  const r = send(w, 'a\r\nb\x1b[201~c\x07');
  await kit.until(() => rec(w, r).state === 'delivered', 2000, 'delivered');
  kit.eq(w.writes[0].bytes, PASTE_START + 'a\nbc' + PASTE_END);
});

kit.test('the queue survives a restart; writing records become WRITE_INTERRUPTED', async () => {
  const dir = tmp();
  const w1 = world(dir);
  w1.turnOpen = true;
  const r = send(w1, 'survive');
  await kit.until(() => rec(w1, r).reason === 'busy', 1000, 'held');
  const file = path.join(dir, 'mobile', 'send-queue.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.records.push(Object.assign({}, saved.records[0], { clientMessageId: crypto.randomUUID(), state: 'writing' }));
  fs.writeFileSync(file, JSON.stringify(saved));
  const w2 = world(dir);
  const recs = Array.from(w2.q._records.values());
  kit.eq(recs.map((x) => x.state).sort(), ['failed', 'queued']);
  kit.eq(recs.find((x) => x.state === 'failed').error.code, 'WRITE_INTERRUPTED');
  await kit.until(() => w2.writes.length === 2, 2000, 'restarted pump delivers');
});

kit.test('confirmation replaces the provisional message; the same clientMessageId answers 200', async () => {
  const w = world(tmp());
  const r = send(w, 'confirm me');
  await kit.until(() => rec(w, r).state === 'delivered', 2000, 'delivered');
  const msg = { id: 'uuid-1', role: 'user', origin: { kind: 'desktop' }, parts: [{ type: 'text', text: 'confirm me' }], attachments: [] };
  kit.ok(w.q.onPromptMessage(SID, msg), 'consumed');
  const upd = w.events.find((e) => e.type === 'message.update');
  kit.eq([upd.data.replacesId, upd.data.message.origin.kind, rec(w, r).state, rec(w, r).messageId], ['pm_' + r.send.clientMessageId, 'phone', 'confirmed', 'uuid-1']);
  const again = w.q.accept(SID, { clientMessageId: r.send.clientMessageId, text: 'confirm me' }, { deviceId: DEV });
  kit.eq(again.status, 200);
});

kit.test('validation: NOTHING_TO_SEND, TEXT_TOO_LONG, SEND_QUEUE_FULL, cancel rules', async () => {
  const w = world(tmp());
  w.turnOpen = true;
  const err = (fn) => { try { fn(); return null; } catch (e) { return [e.status, e.code]; } };
  kit.eq(err(() => send(w, '   ')), [422, 'NOTHING_TO_SEND']);
  kit.eq(err(() => send(w, 'x'.repeat(100001))), [413, 'TEXT_TOO_LONG']);
  const first = send(w, 'q0');
  for (let i = 1; i < 10; i++) send(w, 'q' + i);
  kit.eq(err(() => send(w, 'eleven')), [409, 'SEND_QUEUE_FULL']);
  kit.eq(err(() => w.q.cancel(SID, first.send.clientMessageId, 'd_' + 'B'.repeat(20))), [403, 'NOT_YOUR_SEND']);
  const c = w.q.cancel(SID, first.send.clientMessageId, DEV);
  kit.eq([c.state, c.error.code], ['cancelled', 'CANCELLED_BY_USER']);
});

let env;
kit.test('real path: HTTP send to the fake Claude in a PTY, echo arrives, geometry is never claimed', async () => {
  env = await kit.bootChat({ pty: true });
  const cwd = path.join(sb.work, 'send');
  fs.mkdirSync(cwd, { recursive: true });
  const rec0 = kit.trackedSession(env.store, { provider: 'claude', workingDir: cwd, name: 'E2E Claude' });
  env.chat.internals.index.invalidate();
  const started = await env.chat.launch.start('wb_' + rec0.id, {});
  kit.ok(['spawned', 'attached'].includes(started.status), JSON.stringify(started));
  const pty = env.pm.getSession(rec0.id);
  let claims = 0;
  const origClaim = pty.requestSizeOwnership.bind(pty);
  const origView = pty.applyViewport.bind(pty);
  pty.requestSizeOwnership = (...a) => { claims++; return origClaim(...a); };
  pty.applyViewport = (...a) => { claims++; return origView(...a); };
  env.chat.internals.index.invalidate();
  const sid = env.chat.internals.index.idForWorkbookSession(rec0.id);
  kit.ok(/^cl_/.test(sid), sid);
  const s = await kit.openStream(env.base, env.device.token);
  s.send({ type: 'subscribe', id: 's', epoch: null, topics: [{ topic: 'session:' + sid, sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const r = await kit.api(env.base, 'POST', '/sessions/' + sid + '/send', { clientMessageId: crypto.randomUUID(), text: 'hello from e2e' }, env.device.token);
  kit.eq(r.status, 202);
  const conf = await s.next((f) => f.type === 'send.update' && f.data.send.state === 'confirmed', 20000);
  kit.ok(conf.data.send.messageId, 'message id');
  const echo = await s.next((f) => f.type === 'message.add' && f.data.message.role === 'assistant' && JSON.stringify(f.data.message.parts).includes('Echo: hello from e2e'), 20000);
  kit.validateFrame(echo);
  const repl = s.frames.find((f) => f.type === 'message.update' && f.data.replacesId === 'pm_' + r.body.clientMessageId);
  kit.ok(repl && repl.data.message.origin.kind === 'phone', 'provisional replaced');
  await s.next((f) => f.type === 'turn.end' && f.data.status === 'completed', 20000);
  kit.eq(claims, 0, 'no size ownership or viewport calls');
  for (const f of s.frames) kit.validateFrame(f);
  s.close();
});

kit.run(async () => { if (env) await env.close(); });
