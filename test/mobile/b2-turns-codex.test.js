/**
 * B2: the Codex turn rules X1 to X7 (PROTOCOL.md 6.3) from rollout markers:
 * task_started, tool calls without output (working), outputs (tool.end),
 * task_complete, an error that fails the turn, turn_aborted (interrupted),
 * the ChatGPT owner from session_meta.originator, a PTY exit, X6 with the
 * real codex-cli 0.153.4 approval and trust screens, the turn_aborted record
 * as captured from 0.153.4, and the X3 fallback (a phone ESC, an idle
 * composer and no end marker for 5 s).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const fs = require('fs');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');

const sb = kit.sandbox();
let env;
const events = [];

function rollout(meta) {
  const id = crypto.randomUUID();
  const file = kit.writeCodex(sb.codexHome, id, [{ type: 'turn_context', payload: { cwd: sb.work, model: 'gpt-test', approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' } } }], meta);
  const sid = 'cx_' + id;
  env.chat.internals.turns.watch(sid, 'subscriber');
  const add = (type, payload) => { fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n'); env.chat.internals.turns.readNow(sid); };
  return { id, sid, add, ev: (t) => events.filter((e) => e.topic === 'session:' + sid && e.type === t).map((e) => e.data) };
}

kit.test('boot', async () => {
  env = await kit.bootChat();
  const hub = env.chat.internals.hub;
  const orig = hub.publish;
  hub.publish = (topic, type, data) => { events.push({ topic, type, data }); return orig(topic, type, data); };
});

kit.test('X1, X5, X2: task_started, a tool without output is working, task_complete ends completed', async () => {
  const r = rollout();
  r.add('event_msg', { type: 'task_started', turn_id: 'T1' });
  kit.eq(r.ev('turn.start')[0].turnId, 't_T1');
  r.add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  r.add('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'c1' });
  const st = env.chat.internals.turns.stateOf(r.sid);
  kit.eq([st.state, st.toolName, st.source], ['working', 'shell', 'rollout']);
  r.add('response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) });
  kit.eq([r.ev('tool.end')[0].status, r.ev('tool.end')[0].summary], ['ok', 'Exited with 0']);
  r.add('event_msg', { type: 'task_complete', turn_id: 'T1', duration_ms: 777 });
  const end = r.ev('turn.end')[0];
  kit.eq([end.status, end.endSource, end.durationMs], ['completed', 'taskComplete', 777]);
  kit.validate(end, 'sessions/turn.json');
});

kit.test('X4: an error event fails the turn at task_complete', async () => {
  const r = rollout();
  r.add('event_msg', { type: 'task_started', turn_id: 'T2' });
  r.add('event_msg', { type: 'error', message: 'stream disconnected' });
  r.add('event_msg', { type: 'task_complete', turn_id: 'T2', duration_ms: 5 });
  const end = r.ev('turn.end')[0];
  kit.eq([end.status, end.error.code], ['failed', 'API_ERROR']);
});

kit.test('X3: turn_aborted ends the turn interrupted', async () => {
  const r = rollout();
  r.add('event_msg', { type: 'task_started', turn_id: 'T3' });
  r.add('event_msg', { type: 'turn_aborted', turn_id: 'T3', reason: 'interrupted' });
  const end = r.ev('turn.end')[0];
  kit.eq([end.status, end.endSource], ['interrupted', 'turnAborted']);
  kit.eq(env.chat.internals.turns.stateOf(r.sid).state, 'interrupted');
});

kit.test('a Codex Desktop rollout is owned by chatgpt and read only', async () => {
  const r = rollout({ originator: 'Codex Desktop' });
  const meta = env.chat.sessions.meta(r.sid);
  kit.eq([meta.owner, meta.ownerDetail], ['chatgpt', 'In ChatGPT']);
  kit.ok(/ChatGPT app/.test(meta.readOnlyReason), meta.readOnlyReason);
  const send = await kit.api(env.base, 'POST', '/sessions/' + r.sid + '/send', { clientMessageId: crypto.randomUUID(), text: 'hi' }, env.device.token);
  kit.eq([send.status, send.body.code, send.body.owner], [409, 'SESSION_READ_ONLY', 'chatgpt']);
});

kit.test('X7: the PTY exits while a turn is open', async () => {
  const id = crypto.randomUUID();
  kit.writeCodex(sb.codexHome, id, []);
  const rec = kit.trackedSession(env.store, { provider: 'codex', resumeSessionId: id, command: 'codex' });
  env.chat.internals.index.invalidate();
  const sid = 'cx_' + id;
  env.chat.internals.turns.watch(sid, 'subscriber');
  const file = env.chat.internals.index.transcriptPathFor(sid);
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'T9' } }) + '\n');
  env.chat.internals.turns.readNow(sid);
  env.chat.internals.turns.onPtyExit(rec.id, 1);
  const end = events.filter((e) => e.topic === 'session:' + sid && e.type === 'turn.end').map((e) => e.data)[0];
  kit.eq([end.status, end.endSource], ['failed', 'processExit']);
});

/**
 * A golden screen from the real codex-cli 0.153.4 capture.
 * @param {string} name
 * @returns {object}
 */
function codexScreen(name) {
  return JSON.parse(fs.readFileSync(require('path').join(__dirname, 'fixtures', 'screens', 'codex-0.153.4-' + name + '.json'), 'utf8'));
}

kit.test('X6: the real Codex approval dialog on a pane sets needsApproval with a Prompt; an unknown dialog sets needsAnswer', async () => {
  const { classify } = require('../../src/web/mobile/chat/prompt-detect');
  const r = rollout();
  r.add('event_msg', { type: 'task_started', turn_id: 'T6' });
  r.add('response_item', { type: 'custom_tool_call', name: 'exec', input: 'echo myrlin-check > probe.txt', call_id: 'c6' });
  const cls = classify(codexScreen('approval'), 'codex');
  env.chat.internals.prompts.onClassified(r.sid, cls);
  env.chat.internals.turns.onScreen(r.sid, cls);
  const st = env.chat.internals.turns.stateOf(r.sid);
  kit.eq([st.state, st.source], ['needsApproval', 'screen']);
  const p = env.chat.prompts.openFor(r.sid)[0];
  kit.validate(p, 'sessions/prompt.json');
  kit.eq([p.kind, p.options.map((o) => o.key).join(), p.options.map((o) => o.role).join()], ['approval', 'y,p,esc', 'allow,allowAlways,deny']);
  const trust = classify(codexScreen('trust-dialog'), 'codex');
  kit.eq(trust.kind, 'unknownModal');
  env.chat.internals.prompts.onClassified(r.sid, trust);
  env.chat.internals.turns.onScreen(r.sid, trust);
  kit.eq(env.chat.internals.turns.stateOf(r.sid).state, 'needsAnswer');
  r.add('response_item', { type: 'custom_tool_call_output', call_id: 'c6', output: 'ok' });
  r.add('event_msg', { type: 'task_complete', turn_id: 'T6', duration_ms: 10 });
});

kit.test('X3 as captured from codex-cli 0.153.4: turn_aborted with reason interrupted ends it turnAborted', async () => {
  const ev = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'fixtures', 'scratch', 'codex-0.153.4-live-evidence.json'), 'utf8')).results.X3;
  kit.eq([ev.endRecord.payloadType, ev.endRecord.reason], ['turn_aborted', 'interrupted']);
  const r = rollout();
  r.add('event_msg', { type: 'task_started', turn_id: 'T7' });
  r.add('event_msg', { type: 'turn_aborted', turn_id: 'T7', reason: 'interrupted', started_at: 1, completed_at: 2, duration_ms: 1 });
  const end = r.ev('turn.end');
  kit.eq([end.length, end[0].status, end[0].endSource], [1, 'interrupted', 'turnAborted']);
});

kit.test('X3 fallback: after a phone ESC, an idle composer and no end marker for 5 s ends it interrupted (interruptMarker, by phone); without the ESC nothing ends', async () => {
  const idleCls = { kind: 'idlePrompt', input: { inputText: '', placeholder: true }, busy: false };
  const esc = rollout();
  esc.add('event_msg', { type: 'task_started', turn_id: 'T8' });
  const plain = rollout();
  plain.add('event_msg', { type: 'task_started', turn_id: 'T9b' });
  env.chat.internals.interrupts.notePhoneEsc(esc.sid);
  env.chat.internals.turns.onScreen(esc.sid, idleCls);
  env.chat.internals.turns.onScreen(plain.sid, idleCls);
  env.chat.internals.turns._check();
  kit.eq(esc.ev('turn.end').length, 0, 'not before 5 s');
  await kit.sleep(5300);
  env.chat.internals.turns._check();
  const end = esc.ev('turn.end');
  kit.eq([end.length, end[0] && end[0].status, end[0] && end[0].endSource, end[0] && end[0].stoppedBy], [1, 'interrupted', 'interruptMarker', 'phone']);
  kit.validate(end[0], 'sessions/turn.json');
  kit.eq(plain.ev('turn.end').length, 0, 'an idle composer alone ends nothing');
  plain.add('event_msg', { type: 'task_complete', turn_id: 'T9b', duration_ms: 1 });
});

kit.run(async () => { if (env) await env.close(); });
