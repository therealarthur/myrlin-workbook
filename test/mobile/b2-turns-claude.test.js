/**
 * B2: the Claude turn rules C1 to C7 (PROTOCOL.md 6.2) from transcript
 * fixtures, a scripted clock, injected screens and agents listings: the em
 * dash case of critic F6 (exactly one turn.end, after turn_duration), the
 * interrupt marker, API errors, a process exit, the confirmed idle fallback
 * for a pane and for an external session, 11 minutes of silence that ends
 * nothing, C6 (queue-operation records), rule 6 as measured on 2.1.283
 * (asleep background sessions, and C5 when one loses its process), and the
 * agents poller: live-sessions' runner (profile env, account home, tree kill
 * by PID, the next candidate) and the blind listing check.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');

const sb = kit.sandbox();
const clock = { t: Date.parse('2026-09-27T10:00:00Z') };
const now = () => clock.t;
const agentFns = [];
const agentEntries = new Map();
const agents = {
  watch: () => () => {},
  entryFor: (id) => agentEntries.get(id) || null,
  onPoll: (fn) => { agentFns.push(fn); return () => {}; },
  refreshSoon() {},
  latest: () => null,
  onDemand: async () => ({ at: now(), entries: Array.from(agentEntries.values()) }),
  stop() {},
};
let env;
let events = [];

/** A new session transcript with one prompt; returns helpers. */
function session(opts = {}) {
  const id = crypto.randomUUID();
  const cwd = path.join(sb.work, 'turns');
  const file = kit.writeClaude(sb.projects, cwd, id, [{ type: 'permission-mode', permissionMode: 'default' }]);
  const sid = 'cl_' + id;
  let last = null;
  const add = (rec) => {
    const r = Object.assign({ uuid: crypto.randomUUID(), timestamp: new Date(now()).toISOString(), sessionId: id, cwd, parentUuid: last }, rec);
    last = r.uuid;
    fs.appendFileSync(file, JSON.stringify(r) + '\n');
    env.chat.internals.turns.readNow(sid);
    return r;
  };
  if (opts.tracked) kit.trackedSession(env.store, { provider: 'claude', resumeSessionId: id, workingDir: cwd });
  env.chat.internals.index.invalidate();
  env.chat.internals.turns.watch(sid, 'subscriber');
  return {
    id, sid, file, add,
    prompt: (text) => add({ type: 'user', message: { role: 'user', content: text } }),
    text: (text, mid) => add({ type: 'assistant', requestId: 'r', message: { id: mid || 'm_' + crypto.randomUUID(), role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }] } }),
    tool: (tid, cmd) => add({ type: 'assistant', requestId: 'r', message: { id: 'm_' + tid, role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: cmd } }] } }),
    result: (tid, isError) => add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'done', is_error: !!isError }] } }),
    sys: (subtype, extra) => add(Object.assign({ type: 'system', subtype }, extra || {})),
    ev: (type) => events.filter((e) => e.topic === 'session:' + sid && e.type === type).map((e) => e.data),
  };
}

kit.test('boot with a scripted clock and a hub recorder', async () => {
  env = await kit.bootChat({ options: { now, agents } });
  const hub = env.chat.internals.hub;
  const orig = hub.publish;
  hub.publish = (topic, type, data) => { events.push({ topic, type, data }); return orig(topic, type, data); };
});

kit.test('C1 and C2: a prompt starts a turn, a tool runs, turn_duration ends it', async () => {
  const s = session();
  const p = s.prompt('run the tests');
  const start = s.ev('turn.start');
  kit.eq(start.length, 1);
  kit.eq(start[0].turnId, 't_' + p.uuid);
  kit.validate({ topic: 'session:' + s.sid, seq: 1, epoch: env.chat.internals.hub.epoch, ts: now(), type: 'turn.start', data: start[0] }, 'stream/events/turn.start.json');
  s.tool('toolu_1', 'npm test');
  kit.eq(s.ev('tool.start')[0].detail, 'npm test');
  const st = env.chat.internals.turns.stateOf(s.sid);
  kit.eq([st.state, st.toolName], ['working', 'Bash']);
  s.result('toolu_1');
  kit.eq(s.ev('tool.end')[0].status, 'ok');
  s.text('done');
  kit.eq(s.ev('turn.end').length, 0);
  s.sys('stop_hook_summary');
  kit.eq(s.ev('turn.end').length, 0, 'a stop hook summary never ends a turn');
  s.sys('turn_duration', { durationMs: 4321 });
  const end = s.ev('turn.end');
  kit.eq(end.length, 1);
  kit.eq([end[0].status, end[0].endSource, end[0].durationMs], ['completed', 'turnDuration', 4321]);
  kit.validate(end[0], 'sessions/turn.json');
});

kit.test('F6: an em dash reply with a blocking Stop hook, more tool use, one turn.end after turn_duration', async () => {
  const s = session();
  s.prompt('write it');
  s.text('first' + String.fromCharCode(0x2014) + 'draft');
  s.sys('stop_hook_summary', { preventedContinuation: false, hookErrors: ['blocked: em dash'] });
  s.tool('toolu_2', 'npm run lint');
  s.result('toolu_2');
  s.text('rewritten');
  kit.eq(s.ev('turn.end').length, 0, 'no end before turn_duration');
  s.sys('turn_duration', { durationMs: 9000 });
  kit.eq(s.ev('turn.end').length, 1);
  kit.eq(s.ev('turn.end')[0].endSource, 'turnDuration');
});

kit.test('C3: the interrupt marker ends the turn interrupted; a later turn_duration is ignored', async () => {
  const s = session();
  s.prompt('long work');
  s.tool('toolu_3', 'sleep 100');
  s.add({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  const end = s.ev('turn.end');
  kit.eq([end.length, end[0].status, end[0].endSource, end[0].stoppedBy], [1, 'interrupted', 'interruptMarker', 'desktop']);
  kit.eq(s.ev('tool.end')[0].status, 'interrupted');
  s.sys('turn_duration', { durationMs: 1 });
  kit.eq(s.ev('turn.end').length, 1);
  kit.eq(env.chat.internals.turns.stateOf(s.sid).state, 'interrupted');
});

kit.test('C4: an API error record fails the turn at turn_duration; a usage limit is USAGE_LIMIT', async () => {
  const s = session();
  s.prompt('go');
  s.add({ type: 'assistant', isApiErrorMessage: true, message: { id: 'e1', role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } });
  s.sys('turn_duration', { durationMs: 10 });
  const end = s.ev('turn.end')[0];
  kit.eq([end.status, end.error.code], ['failed', 'API_ERROR']);
  kit.ok(/^the API answered/.test(end.error.error), end.error.error);
  const u = session();
  u.prompt('go');
  u.add({ type: 'assistant', isApiErrorMessage: true, message: { id: 'e2', role: 'assistant', content: [{ type: 'text', text: 'Claude usage limit reached. Your limit will reset at 5pm.' }] } });
  u.sys('turn_duration', { durationMs: 10 });
  kit.eq(u.ev('turn.end')[0].error.code, 'USAGE_LIMIT');
});

kit.test('C4 without turn_duration: 10 s of idle screen after the error ends it failed', async () => {
  const s = session();
  s.prompt('go');
  s.add({ type: 'assistant', isApiErrorMessage: true, message: { id: 'e3', role: 'assistant', content: [{ type: 'text', text: 'API Error: 500' }] } });
  env.chat.internals.turns.onScreen(s.sid, { kind: 'idlePrompt', input: { inputText: '', placeholder: true }, busy: false });
  clock.t += 11000;
  env.chat.internals.turns._check();
  const end = s.ev('turn.end');
  kit.eq([end.length, end[0].status, end[0].endSource], [1, 'failed', 'apiError']);
});

kit.test('C5: the PTY exits while a turn is open', async () => {
  const s = session({ tracked: true });
  s.prompt('go');
  const rec = env.store.getAllSessionsList().find((x) => x.resumeSessionId === s.id);
  env.chat.internals.turns.onPtyExit(rec.id, 3);
  const end = s.ev('turn.end')[0];
  kit.eq([end.status, end.endSource, end.error.code], ['failed', 'processExit', 'PROCESS_EXITED']);
  kit.ok(/exited with code 3$/.test(end.error.error), end.error.error);
});

kit.test('C7 pane: idle screen held 6 s, then 30 s without turn_duration ends it screenIdle', async () => {
  const s = session();
  s.prompt('go');
  env.chat.internals.turns.onScreen(s.sid, { kind: 'idlePrompt', input: { inputText: '', placeholder: true }, busy: false });
  clock.t += 7000;
  env.chat.internals.turns._check();
  kit.eq(s.ev('turn.end').length, 0, 'not yet');
  clock.t += 29000;
  env.chat.internals.turns._check();
  kit.eq(s.ev('turn.end').length, 0, 'still inside 30 s');
  clock.t += 2000;
  env.chat.internals.turns._check();
  const end = s.ev('turn.end');
  kit.eq([end.length, end[0].endSource], [1, 'screenIdle']);
});

kit.test('C7 external: agents idle on 3 polls over 6 s, then 30 s, ends it agentsIdle; waitingFor sets needsApproval', async () => {
  const s = session();
  agentEntries.set(s.id, { sessionId: s.id, kind: 'interactive', status: 'waiting', waitingFor: 'permission prompt' });
  env.chat.internals.index.invalidate();
  env.chat.internals.turns.unwatch(s.sid, 'subscriber');
  env.chat.internals.turns.watch(s.sid, 'subscriber');
  s.prompt('go');
  const w = env.chat.internals.turns._watcher(s.sid);
  w.unwatchAgents = w.unwatchAgents || (() => {});
  for (const fn of agentFns) fn({ at: now(), entries: Array.from(agentEntries.values()) });
  kit.eq(env.chat.internals.turns.stateOf(s.sid).state, 'needsApproval');
  agentEntries.set(s.id, { sessionId: s.id, kind: 'interactive', status: 'idle', waitingFor: null });
  for (let i = 0; i < 3; i++) { for (const fn of agentFns) fn({ at: now(), entries: Array.from(agentEntries.values()) }); clock.t += 3000; }
  env.chat.internals.turns._check();
  clock.t += 31000;
  env.chat.internals.turns._check();
  const end = s.ev('turn.end');
  kit.eq([end.length, end[0] && end[0].endSource], [1, 'agentsIdle']);
  agentEntries.delete(s.id);
});

kit.test('11 minutes of silence ends nothing and says No activity for 10 minutes', async () => {
  const s = session();
  s.prompt('go');
  s.tool('toolu_9', 'sleep 9999');
  clock.t += 11 * 60 * 1000;
  env.chat.internals.turns._check();
  kit.eq(s.ev('turn.end').length, 0);
  const st = env.chat.internals.turns.stateOf(s.sid);
  kit.eq([st.state, st.detail], ['working', 'No activity for 10 minutes']);
  kit.validate(st, 'sessions/session-state.json');
});

kit.test('C6: queue-operation records change no turn; the queued prompt then starts its own turn by C1', async () => {
  const s = session();
  s.prompt('first');
  s.add({ type: 'queue-operation', operation: 'enqueue', content: 'second' });
  kit.eq([s.ev('turn.start').length, s.ev('turn.end').length], [1, 0], 'enqueue neither starts nor ends a turn');
  s.text('done with first');
  s.sys('turn_duration', { durationMs: 20 });
  s.add({ type: 'queue-operation', operation: 'dequeue' });
  kit.eq([s.ev('turn.start').length, s.ev('turn.end').length], [1, 1], 'dequeue starts nothing');
  const p2 = s.prompt('second');
  const starts = s.ev('turn.start');
  kit.eq([starts.length, starts[1].turnId], [2, 't_' + p2.uuid]);
  s.sys('turn_duration', { durationMs: 30 });
  kit.eq(s.ev('turn.end').length, 2);
});

kit.test('rule 6 as measured on 2.1.283: a running background entry (pid, status idle, state done) is owner background; one without pid and status is asleep, owner none, state sleeping', async () => {
  const s = session();
  agentEntries.set(s.id, { sessionId: s.id, id: 'bg12ab34', kind: 'background', status: 'idle', waitingFor: null, state: 'done', pid: 4242 });
  env.chat.internals.index.invalidate();
  kit.eq(env.chat.sessions.resolve(s.sid).owner, 'background');
  agentEntries.set(s.id, { sessionId: s.id, id: 'bg12ab34', kind: 'background', status: null, waitingFor: null, state: 'blocked', pid: null });
  env.chat.internals.index.invalidate();
  kit.eq(env.chat.sessions.resolve(s.sid).owner, 'none');
  env.chat.internals.turns.refresh(s.sid);
  const st = env.chat.internals.turns.stateOf(s.sid);
  kit.eq([st.state, st.source], ['sleeping', 'agents']);
  kit.validate(st, 'sessions/session-state.json');
  agentEntries.delete(s.id);
});

kit.test('rule 6 and C5: a watched background session that loses its process while a turn is open ends failed processExit', async () => {
  const s = session();
  agentEntries.set(s.id, { sessionId: s.id, id: 'bg56cd78', kind: 'background', status: 'busy', waitingFor: null, state: 'working', pid: 5151 });
  env.chat.internals.index.invalidate();
  env.chat.internals.turns.unwatch(s.sid, 'subscriber');
  env.chat.internals.turns.watch(s.sid, 'subscriber');
  const w = env.chat.internals.turns._watcher(s.sid);
  w.unwatchAgents = w.unwatchAgents || (() => {});
  s.prompt('go');
  for (const fn of agentFns) fn({ at: now(), entries: Array.from(agentEntries.values()) });
  kit.eq(s.ev('turn.end').length, 0);
  agentEntries.set(s.id, { sessionId: s.id, id: 'bg56cd78', kind: 'background', status: null, waitingFor: null, state: 'working', pid: null });
  for (const fn of agentFns) fn({ at: now(), entries: Array.from(agentEntries.values()) });
  const end = s.ev('turn.end');
  kit.eq([end.length, end[0] && end[0].status, end[0] && end[0].endSource], [1, 'failed', 'processExit']);
  agentEntries.delete(s.id);
});

// ── The agents poller (PROTOCOL.md 6.1): live-sessions' runner, the blind listing check ──

kit.test('the agents runner goes through runAgentsJsonOnce: profile env, account home cwd, keeps waitingFor, tries the next binary when one fails to start', async () => {
  const { runAgentsListing } = require('../../src/web/mobile/chat/agents-poller');
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'b2-home-'));
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => {
    calls.push({ file, args, cwd: opts.cwd, env: opts.env });
    if (/first/.test(file)) { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; setImmediate(() => cb(e, '', '')); }
    else setImmediate(() => cb(null, JSON.stringify([{ id: 'ab12cd34', sessionId: 's1', kind: 'background', status: 'waiting', waitingFor: 'permission prompt', state: 'blocked', pid: 7 }]), ''));
    return { pid: 99, stdin: { end() {} } };
  };
  const r = await runAgentsListing(5000, {
    execFileImpl,
    resolveCandidates: () => [{ path: 'C:\\bin\\first\\claude.exe', viaCmd: false }, { path: 'C:\\bin\\second\\claude.exe', viaCmd: false }],
    env: { PATH: 'x', CLAUDECODE: '1' },
    platform: 'win32',
    homedir: home,
  });
  kit.eq(r.ok, true, JSON.stringify(r));
  kit.eq([r.entries[0].waitingFor, r.entries[0].id, r.entries[0].pid], ['permission prompt', 'ab12cd34', 7]);
  kit.eq(calls.map((c) => c.file), ['C:\\bin\\first\\claude.exe', 'C:\\bin\\second\\claude.exe']);
  kit.eq(calls[1].args, ['agents', '--json']);
  kit.eq([calls[1].cwd, calls[1].env.USERPROFILE, 'CLAUDECODE' in calls[1].env], [home, home, false]);
});

kit.test('the agents runner kills the whole tree by PID on a timeout (the K3 case), never by name', async () => {
  const { runAgentsListing } = require('../../src/web/mobile/chat/agents-poller');
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => {
    calls.push({ file, args });
    if (file === 'taskkill') { setImmediate(() => cb(null, '', '')); return { pid: 1 }; }
    return { pid: 4242, stdin: { end() {} } };
  };
  const r = await runAgentsListing(150, { execFileImpl, resolveCandidates: () => [{ path: 'C:\\bin\\claude.cmd', viaCmd: true }], env: { ComSpec: 'cmd.exe' }, platform: 'win32', homedir: require('os').tmpdir() });
  kit.eq([r.ok, r.error], [false, 'timeout']);
  const kill = calls.find((c) => c.file === 'taskkill');
  kit.eq(kill && kill.args, ['/PID', '4242', '/T', '/F']);
  kit.ok(!calls.some((c) => c.args.some((a) => /\/IM/i.test(a))), 'no kill by image name');
});

kit.test('a blind listing (empty while this Workbook runs a Claude pane) is a failed poll; an empty one without panes is accepted', async () => {
  const { createAgentsPoller, blindListingCheck } = require('../../src/web/mobile/chat/agents-poller');
  const t0 = Date.now();
  const pm = { sessions: new Map([['wb1', { alive: true, claudeTranscriptId: 'x', attachShortId: null, createdAt: t0 - 60000 }]]) };
  const blind = createAgentsPoller({ runOnce: async () => ({ ok: true, entries: [] }), sightCheck: blindListingCheck(() => pm) });
  kit.eq(await blind.onDemand(), null, 'not taken as the truth');
  const young = { sessions: new Map([['wb2', { alive: true, claudeTranscriptId: 'y', attachShortId: null, createdAt: t0 }]]) };
  const fine = createAgentsPoller({ runOnce: async () => ({ ok: true, entries: [] }), sightCheck: blindListingCheck(() => young) });
  const l = await fine.onDemand();
  kit.eq(l && l.entries, []);
  const bg = createAgentsPoller({ runOnce: async () => ({ ok: true, entries: [{ sessionId: 'S9', kind: 'background', pid: 3, status: 'idle', state: 'done' }] }) });
  await bg.onDemand();
  kit.eq([bg.wasBackground('s9'), bg.wasBackground('other')], [true, false]);
  blind.stop(); fine.stop(); bg.stop();
});

kit.test('message.add events carry typed messages and validate', async () => {
  const adds = events.filter((e) => e.type === 'message.add');
  kit.ok(adds.length > 10, 'adds');
  for (const a of adds.slice(0, 20)) kit.validate({ topic: a.topic, seq: 1, epoch: env.chat.internals.hub.epoch, ts: now(), type: 'message.add', data: a.data }, 'stream/events/message.add.json');
});

kit.run(async () => { if (env) await env.close(); });
