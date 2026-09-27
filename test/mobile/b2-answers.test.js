/**
 * B2: answers with the dialog's own keys against the fake CLIs in real
 * Workbook PTYs (PROTOCOL.md 4.4.7, 8.5): approval by decision, question by
 * option and by Other text, multi select with the review screen, plan keep
 * planning with feedback, dismiss, Codex letter keys, first answer wins
 * (409 PROMPT_ALREADY_RESOLVED by desktop), PROMPT_CHANGED, and 504 when
 * the keys do not close the dialog. The exact key bytes are asserted from a
 * pty.write spy.
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

const sb = kit.sandbox();
let env;
let sid;
let pty;
let writes = [];
let stream;

async function startSession(provider) {
  const cwd = path.join(sb.work, provider + '-answers-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(cwd, { recursive: true });
  const rec = kit.trackedSession(env.store, { provider, workingDir: cwd, command: provider });
  env.chat.internals.index.invalidate();
  const res = await env.chat.launch.start('wb_' + rec.id, {});
  kit.ok(res.status === 'spawned', JSON.stringify(res));
  const p = env.pm.getSession(rec.id);
  const orig = p.pty.write.bind(p.pty);
  p.pty.write = (d) => { writes.push(String(d)); return orig(d); };
  env.chat.internals.index.invalidate();
  await kit.until(async () => { const s = await env.chat.internals.runtime.freshScreen(env.chat.internals.index.idForWorkbookSession(rec.id) || 'wb_' + rec.id, 0); return s && s.cls.kind === 'idlePrompt'; }, 15000, 'idle');
  return { id: env.chat.internals.index.idForWorkbookSession(rec.id) || 'wb_' + rec.id, pty: p };
}

async function sendText(text) {
  const r = await kit.api(env.base, 'POST', '/sessions/' + sid + '/send', { clientMessageId: crypto.randomUUID(), text }, env.device.token);
  kit.eq(r.status, 202);
}

async function openPrompt(kind) {
  let p = null;
  await kit.until(async () => {
    await env.chat.internals.runtime.freshScreen(sid, 0);
    const list = env.chat.prompts.openFor(sid);
    p = list.find((x) => x.kind === kind && (x.source === 'screenAndTranscript' || kind === 'unknown' || !x.toolCallId && sid.startsWith('wb_'))) || null;
    return !!p;
  }, 20000, kind + ' prompt');
  return p;
}

async function answer(p, body) {
  writes = [];
  return kit.api(env.base, 'POST', '/sessions/' + sid + '/prompts/' + p.promptId + '/answer', Object.assign({ clientRequestId: crypto.randomUUID() }, body), env.device.token);
}

async function waitIdle() {
  await kit.until(async () => { const s = await env.chat.internals.runtime.freshScreen(sid, 0); return s && s.cls.kind === 'idlePrompt' && !env.chat.internals.turns.isTurnOpen(sid); }, 20000, 'idle');
}

// ── PROMPT_CHANGED with real golden screens and a scripted screen (PROTOCOL.md 8.5 step 1) ──

/**
 * The answer service over the real prompt service and a scripted screen.
 * @returns {object}
 */
function scriptedAnswers() {
  const { classify, createPromptService } = require('../../src/web/mobile/chat/prompt-detect');
  const { createAnswers } = require('../../src/web/mobile/chat/prompt-answer');
  const screens = path.join(__dirname, 'fixtures', 'screens');
  const load = (n) => JSON.parse(fs.readFileSync(path.join(screens, 'claude-2.1.283-' + n + '.json'), 'utf8'));
  const w = { snap: null, writes: [] };
  const SID = 'cl_' + crypto.randomUUID();
  const index = { resolve: () => ({ sessionId: SID, owner: 'workbook', provider: 'claude', workingDir: null }), computerName: () => 'PC' };
  const prompts = createPromptService({ ctx: { mobile: {} }, index, lazy: { turns: () => ({ openToolsOf: () => [] }) } });
  const runtime = {
    hasScreen: () => true,
    freshScreen: async () => (w.snap ? { cls: classify(w.snap, 'claude'), snap: w.snap } : null),
    withLock: async (sid, fn) => fn(),
    write: (sid, bytes) => { w.writes.push(bytes); return true; },
  };
  const answers = createAnswers({ ctx: { mobile: {} }, index, runtime, lazy: { prompts: () => prompts, interrupts: () => null }, timings: { resolveWaitMs: 200, keyGapMs: 1 } });
  /** Show a golden screen and let the prompt service read it. */
  w.show = (name) => { w.snap = load(name); prompts.onClassified(SID, classify(w.snap, 'claude')); };
  return Object.assign(w, { SID, prompts, answers });
}

kit.test('PROMPT_CHANGED: the dialog on screen was replaced in place by another dialog before the answer arrived', async () => {
  const w = scriptedAnswers();
  w.show('permission');
  const p = w.prompts.openFor(w.SID)[0];
  w.show('plan-dialog');
  kit.ok(w.prompts.openFor(w.SID)[0].promptId !== p.promptId, 'a new prompt');
  const err = await w.answers.answer(w.SID, p.promptId, { decision: 'allow' }, { deviceId: 'd_x' }).then(() => null, (e) => e);
  kit.eq([err && err.status, err && err.code], [409, 'PROMPT_CHANGED']);
  kit.eq(w.writes, [], 'no key reached the other dialog');
});

kit.test('PROMPT_CHANGED: the dialog changed between the card and the answer route\'s own screen read', async () => {
  const w = scriptedAnswers();
  w.show('permission');
  const p = w.prompts.openFor(w.SID)[0];
  // The screen reader has not noticed yet; the route's fresh read sees the other dialog.
  w.snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'screens', 'claude-2.1.283-plan-dialog.json'), 'utf8'));
  const err = await w.answers.answer(w.SID, p.promptId, { decision: 'allow' }, { deviceId: 'd_x' }).then(() => null, (e) => e);
  kit.eq([err && err.status, err && err.code], [409, 'PROMPT_CHANGED']);
  kit.eq(w.writes, []);
});

kit.test('a dialog that closed (no dialog on screen) is PROMPT_ALREADY_RESOLVED by desktop, not PROMPT_CHANGED', async () => {
  const w = scriptedAnswers();
  w.show('permission');
  const p = w.prompts.openFor(w.SID)[0];
  w.show('permission-after-cr');
  await kit.sleep(160);
  w.show('permission-after-cr');
  kit.eq(w.prompts.openFor(w.SID).length, 0);
  const err = await w.answers.answer(w.SID, p.promptId, { decision: 'allow' }, { deviceId: 'd_x' }).then(() => null, (e) => e);
  kit.eq([err && err.status, err && err.code, err && err.extra && err.extra.by], [409, 'PROMPT_ALREADY_RESOLVED', 'desktop']);
});

kit.test('boot with a fake Claude pane', async () => {
  env = await kit.bootChat({ pty: true });
  const s = await startSession('claude');
  sid = s.id;
  pty = s.pty;
  stream = await kit.openStream(env.base, env.device.token);
  stream.send({ type: 'subscribe', id: 's', epoch: null, topics: [{ topic: 'session:' + sid, sinceSeq: null }] });
  await stream.next((f) => f.type === 'subscribed');
});

kit.test('approval: decision allow writes Enter on the highlighted Yes and resolves by phone', async () => {
  await sendText('approve: run the tests');
  const p = await openPrompt('approval');
  kit.validate(p, 'sessions/prompt.json');
  kit.eq([p.detail, p.toolName, p.options.map((o) => o.role).join()], ['npm test', 'Bash', 'allow,allowAlways,deny']);
  const r = await answer(p, { decision: 'allow' });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'sessions/answer-result.json');
  kit.eq([r.body.status, r.body.by], ['resolved', 'phone']);
  kit.eq(writes, ['\r']);
  const res = await stream.next((f) => f.type === 'prompt.resolved' && f.data.promptId === p.promptId, 5000);
  kit.eq([res.data.by, res.data.deviceId], ['phone', env.device.deviceId]);
  await waitIdle();
});

kit.test('question: optionIndexes [1] writes Down then Enter; the answer reaches the transcript', async () => {
  await sendText('ask: pick');
  const p = await openPrompt('question');
  kit.eq(p.questions[0].options.map((o) => o.label), ['Red (Recommended)', 'Blue']);
  kit.eq(p.questions[0].options[0].recommended, true);
  const r = await answer(p, { answers: [{ questionIndex: 0, optionIndexes: [1], otherText: null }] });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(writes, ['\x1b[B', '\r']);
  await stream.next((f) => f.type === 'message.add' && JSON.stringify(f.data.message.parts).includes('You chose Blue'), 10000);
  await waitIdle();
});

kit.test('question: Send as the Other answer moves to Type something, pastes the text and submits', async () => {
  await sendText('ask: again');
  const p = await openPrompt('question');
  const r = await answer(p, { answers: [{ questionIndex: 0, optionIndexes: [], otherText: 'green please' }] });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(writes, ['\x1b[B', '\x1b[B', '\r', '\x1b[200~green please\x1b[201~', '\r']);
  try {
    await stream.next((f) => f.type === 'message.add' && JSON.stringify(f.data.message.parts).includes('You chose green please'), 10000);
  } catch (e) {
    const texts = stream.frames.filter((f) => f.type === 'message.add' || f.type === 'message.update').slice(-6).map((f) => JSON.stringify(f.data.message.parts).slice(0, 120));
    throw new Error('no answer message; recent: ' + texts.join(' || '));
  }
  await waitIdle();
});

kit.test('multi select: Space on each choice, Right to the review, Enter on Submit answers', async () => {
  await sendText('askmulti: two');
  const p = await openPrompt('question');
  kit.eq([p.questions.length, p.questions[1].multiSelect], [2, true]);
  const r = await answer(p, { answers: [{ questionIndex: 0, optionIndexes: [0], otherText: null }, { questionIndex: 1, optionIndexes: [0, 1], otherText: null }] });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  await stream.next((f) => f.type === 'message.add' && JSON.stringify(f.data.message.parts).includes('Small, Large'), 10000);
  await waitIdle();
});

kit.test('plan: keepPlanning with text selects the option, waits for the input, pastes the feedback', async () => {
  await sendText('plan: make it');
  const p = await openPrompt('plan');
  const r = await answer(p, { decision: 'keepPlanning', text: 'smaller steps' });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(writes.slice(0, 3), ['\x1b[B', '\x1b[B', '\r']);
  kit.ok(writes.includes('\x1b[200~smaller steps\x1b[201~'), JSON.stringify(writes));
  await stream.next((f) => f.type === 'message.add' && JSON.stringify(f.data.message.parts).includes('Echo: smaller steps'), 10000);
  await waitIdle();
});

kit.test('dismiss writes one ESC alone', async () => {
  await sendText('approve: again');
  const p = await openPrompt('approval');
  const r = await answer(p, { dismiss: true });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(writes, ['\x1b']);
  await waitIdle();
});

kit.test('a desktop answer first yields 409 PROMPT_ALREADY_RESOLVED by desktop', async () => {
  await sendText('approve: desktop wins');
  const p = await openPrompt('approval');
  pty.pty.write('\r');
  await kit.until(async () => { await env.chat.internals.runtime.freshScreen(sid, 0); await kit.sleep(160); await env.chat.internals.runtime.freshScreen(sid, 0); return env.chat.prompts.openFor(sid).length === 0; }, 5000, 'desktop resolved');
  const r = await answer(p, { decision: 'allow' });
  kit.eq([r.status, r.body.code, r.body.by], [409, 'PROMPT_ALREADY_RESOLVED', 'desktop']);
  await waitIdle();
});

kit.test('invalid answers are 422 with a field; unknown ids 404', async () => {
  await sendText('approve: invalid');
  const p = await openPrompt('approval');
  const a = await answer(p, { decision: 'approvePlan' });
  kit.eq([a.status, a.body.code, a.body.field], [422, 'INVALID_ANSWER', 'decision']);
  const b = await answer(p, { decision: 'allow', optionIndex: 0 });
  kit.eq([b.status, b.body.code], [422, 'INVALID_ANSWER']);
  const c = await answer({ promptId: 'p_' + 'Z'.repeat(20) }, { decision: 'allow' });
  kit.eq([c.status, c.body.code], [404, 'PROMPT_NOT_FOUND']);
});

kit.test('keys that do not close the dialog answer 504 PROMPT_ANSWER_UNCONFIRMED', async () => {
  const p = env.chat.prompts.openFor(sid)[0];
  const orig = pty.pty.write;
  pty.pty.write = (d) => { writes.push(String(d)); };
  const r = await answer(p, { decision: 'allow' });
  pty.pty.write = orig;
  kit.eq([r.status, r.body.code], [504, 'PROMPT_ANSWER_UNCONFIRMED']);
  const again = await answer(env.chat.prompts.openFor(sid)[0], { decision: 'deny' });
  kit.eq(again.status, 200, JSON.stringify(again.body));
  await waitIdle();
});

kit.test('Codex approval answers with the letter key', async () => {
  const s = await startSession('codex');
  sid = s.id;
  stream.send({ type: 'subscribe', id: 'c', epoch: null, topics: [{ topic: 'session:' + sid, sinceSeq: null }] });
  await sendText('approve: codex');
  const p = await openPrompt('approval');
  kit.eq(p.options.map((o) => o.key), ['y', 'p', 'esc']);
  const r = await answer(p, { decision: 'allow' });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(writes, ['y']);
});

kit.run(async () => { if (stream) stream.close(); if (env) await env.close(); });
