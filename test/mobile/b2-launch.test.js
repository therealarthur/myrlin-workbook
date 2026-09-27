/**
 * B2: launching without a socket (pty-manager P5 launchDetached, PROTOCOL.md
 * 4.5.4 to 4.5.6, 9.3). launchDetached spawns from the store record,
 * attaches to a live background session with `claude attach <shortId>`,
 * refuses a live interactive one with SESSION_LIVE_ELSEWHERE and never
 * spawns, and never spawns twice for one transcript. POST /sessions creates
 * and starts a session and delivers its first message; restart and stop
 * follow their owner rules. Fix round: a phone body can never set argsExtra
 * or any field outside NewSessionRequest (W2, PROTOCOL.md 0.1), a model id
 * cannot start with a hyphen, the in process createSession of 3.4.3, the
 * _liveChecked bypass is gone, a record that changes during the lookup is
 * checked again, and a refused relaunch is never answered 202.
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
const spawns = [];
const fakePty = () => ({ pid: 4242, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, on() {} });
const spy = (shell, args) => { spawns.push(args.join(' ')); return fakePty(); };

function stateEntry(sessionId, kind, shortId) {
  fs.writeFileSync(path.join(sb.state, 'claude-' + sessionId + '.json'), JSON.stringify({ id: shortId, sessionId, pid: process.pid, kind, status: 'idle', waitingFor: null, cwd: sb.work, name: 'x', startedAt: Date.now(), state: kind === 'background' ? 'working' : null }));
}

kit.test('boot', async () => { env = await kit.bootChat({ pty: true }); });

kit.test('launchDetached spawns a fresh tracked session from its record', async () => {
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work });
  const r = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy });
  kit.eq(r.status, 'spawned');
  kit.ok(/claude --session-id [0-9a-f-]{36}/.test(spawns[spawns.length - 1]), spawns[spawns.length - 1]);
  const again = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy });
  kit.eq(again.status, 'alreadyRunning');
  env.pm.killSession(rec.id);
});

kit.test('a live background match attaches with claude attach <shortId>', async () => {
  const transcript = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, transcript, kit.claudeExchange('bg'));
  stateEntry(transcript, 'background', 'bg12ab34');
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work, resumeSessionId: transcript });
  const before = spawns.length;
  const r = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy });
  kit.eq(r.status, 'attached', JSON.stringify(r));
  kit.eq(spawns.length, before + 1);
  kit.ok(/claude attach bg12ab34/.test(spawns[spawns.length - 1]), spawns[spawns.length - 1]);
  env.pm.killSession(rec.id);
});

kit.test('a live interactive match is refused with SESSION_LIVE_ELSEWHERE and nothing spawns', async () => {
  const transcript = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, transcript, kit.claudeExchange('ext'));
  stateEntry(transcript, 'interactive', 'ex12ab34');
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work, resumeSessionId: transcript });
  const before = spawns.length;
  const r = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy, _liveFresh: true });
  kit.eq([r.status, r.code], ['refused', 'SESSION_LIVE_ELSEWHERE']);
  kit.eq(spawns.length, before, 'no spawn on refusal');
  env.chat.internals.index.invalidate();
  const sid = 'cl_' + transcript;
  const send = await kit.api(env.base, 'POST', '/sessions/' + sid + '/send', { clientMessageId: crypto.randomUUID(), text: 'hi' }, env.device.token);
  kit.eq([send.status, send.body.code, send.body.owner], [409, 'SESSION_READ_ONLY', 'external']);
});

kit.test('two concurrent launches of one transcript spawn once', async () => {
  const transcript = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, transcript, kit.claudeExchange('twice'));
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work, resumeSessionId: transcript });
  const before = spawns.length;
  const [a, b] = await Promise.all([env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy }), env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy })]);
  kit.eq([a.status, b.status].sort(), ['alreadyRunning', 'spawned']);
  kit.eq(spawns.length, before + 1);
  kit.ok(new RegExp('claude --resume ' + transcript).test(spawns[spawns.length - 1]), spawns[spawns.length - 1]);
  env.pm.killSession(rec.id);
});

let newSid;
kit.test('POST /sessions creates, starts and delivers the first message', async () => {
  const cwd = path.join(sb.work, 'new-session');
  fs.mkdirSync(cwd, { recursive: true });
  const ws = env.store.getAllWorkspacesList()[0];
  const body = { clientRequestId: crypto.randomUUID(), provider: 'claude', workingDir: cwd, projectId: ws.id, name: null, settings: { permissionMode: 'default' }, tabGroupId: null, afterSessionId: null, message: { clientMessageId: crypto.randomUUID(), text: 'first words', attachments: [] } };
  const r = await kit.api(env.base, 'POST', '/sessions', body, env.device.token);
  kit.eq(r.status, 201, JSON.stringify(r.body));
  kit.validate(r.body, 'sessions/new-session-result.json');
  newSid = r.body.session.sessionId;
  kit.ok(/^cl_[0-9a-f-]{36}$/.test(newSid), newSid);
  kit.eq([r.body.session.title, r.body.send.state, r.body.send.reason], ['new-session', 'queued', 'starting']);
  const again = await kit.api(env.base, 'POST', '/sessions', body, env.device.token);
  kit.eq(again.body.session.sessionId, newSid, 'idempotent by clientRequestId');
  await kit.until(async () => {
    const s = await kit.api(env.base, 'GET', '/sessions/' + newSid + '/sends', null, env.device.token);
    return s.body.sends.some((x) => x.state === 'confirmed');
  }, 20000, 'first message confirmed');
});

kit.test('new session errors: WORKING_DIR_NOT_FOUND, PROJECT_REQUIRED, INVALID_SETTING', async () => {
  const base = { clientRequestId: crypto.randomUUID(), provider: 'claude', workingDir: path.join(sb.work, 'nope'), projectId: null };
  const a = await kit.api(env.base, 'POST', '/sessions', base, env.device.token);
  kit.eq([a.status, a.body.code], [422, 'WORKING_DIR_NOT_FOUND']);
  const lonely = path.join(sb.work, 'lonely');
  fs.mkdirSync(lonely, { recursive: true });
  const b = await kit.api(env.base, 'POST', '/sessions', Object.assign({}, base, { clientRequestId: crypto.randomUUID(), workingDir: lonely }), env.device.token);
  kit.eq([b.status, b.body.code], [422, 'PROJECT_REQUIRED']);
  const c = await kit.api(env.base, 'POST', '/sessions', Object.assign({}, base, { clientRequestId: crypto.randomUUID(), workingDir: lonely, projectId: env.store.getAllWorkspacesList()[0].id, settings: { effort: 'enormous' } }), env.device.token);
  kit.eq([c.status, c.body.code, c.body.field], [422, 'INVALID_SETTING', 'effort']);
});

kit.test('restart now during a turn is SESSION_BUSY; stop kills the pane', async () => {
  await kit.api(env.base, 'POST', '/sessions/' + newSid + '/send', { clientMessageId: crypto.randomUUID(), text: 'long: busy' }, env.device.token);
  await kit.until(() => env.chat.internals.turns.isTurnOpen(newSid), 15000, 'turn open');
  const r = await kit.api(env.base, 'POST', '/sessions/' + newSid + '/restart', { clientRequestId: crypto.randomUUID(), when: 'now' }, env.device.token);
  kit.eq([r.status, r.body.code], [409, 'SESSION_BUSY']);
  const w = await kit.api(env.base, 'POST', '/sessions/' + newSid + '/restart', { clientRequestId: crypto.randomUUID(), when: 'whenIdle' }, env.device.token);
  kit.eq([w.status, w.body.status], [202, 'scheduled']);
  const s = await kit.api(env.base, 'POST', '/sessions/' + newSid + '/stop', { clientRequestId: crypto.randomUUID() }, env.device.token);
  kit.eq([s.status, s.body.status], [200, 'stopped']);
  kit.validate(s.body, 'sessions/status-result.json');
  const s2 = await kit.api(env.base, 'POST', '/sessions/' + newSid + '/stop', { clientRequestId: crypto.randomUUID() }, env.device.token);
  kit.eq(s2.body.status, 'notRunning');
});

// ── Fix round: the phone body never reaches a command line (W2, PROTOCOL.md 0.1) ──

/**
 * Record every launchDetached call's options and spawn through the argv spy.
 * @returns {{calls: object[], restore: () => void}}
 */
function captureLaunches() {
  const orig = env.pm.launchDetached;
  const calls = [];
  env.pm.launchDetached = function capture(id, opts, depth) {
    calls.push(Object.assign({}, opts || {}));
    return orig.call(env.pm, id, Object.assign({}, opts || {}, { _ptySpawnForTesting: spy }), depth);
  };
  return { calls, restore: () => { env.pm.launchDetached = orig; } };
}

kit.test('NEW_SESSION_FIELDS equals the NewSessionRequest schema properties', async () => {
  const { NEW_SESSION_FIELDS } = require('../../src/web/mobile/chat/launch');
  const schema = JSON.parse(fs.readFileSync(path.join(kit.SCHEMA_ROOT, 'sessions', 'new-session-request.json'), 'utf8'));
  kit.eq(NEW_SESSION_FIELDS.slice().sort(), Object.keys(schema.properties).sort());
});

kit.test('a phone POST /sessions cannot set argsExtra or any other field outside the schema', async () => {
  const cwd = path.join(sb.work, 'no-args-extra');
  fs.mkdirSync(cwd, { recursive: true });
  const ws = env.store.getAllWorkspacesList()[0];
  const cap = captureLaunches();
  const before = spawns.length;
  let r;
  try {
    r = await kit.api(env.base, 'POST', '/sessions', {
      clientRequestId: crypto.randomUUID(), provider: 'claude', workingDir: cwd, projectId: ws.id, name: null, settings: null, tabGroupId: null, afterSessionId: null,
      argsExtra: ['--dangerously-skip-permissions', '--add-dir', 'C:\\'],
      command: 'claude --dangerously-skip-permissions',
      flags: ['dangerously-skip-permissions'],
      _liveChecked: true,
      attachShortId: 'abcd1234',
    }, env.device.token);
  } finally { cap.restore(); }
  kit.eq(r.status, 201, JSON.stringify(r.body));
  kit.eq(cap.calls.length, 1);
  for (const k of ['argsExtra', 'command', 'flags', '_liveChecked', 'attachShortId']) kit.ok(!(k in cap.calls[0]), k + ' must not reach launchDetached: ' + JSON.stringify(cap.calls[0]));
  kit.eq(spawns.length, before + 1);
  const argv = spawns[spawns.length - 1];
  kit.ok(!/dangerously|add-dir|attach/.test(argv), 'argv carries nothing from the body: ' + argv);
  const rec = env.store.getAllSessionsList().find((x) => x.workingDir === cwd);
  kit.eq([rec.command, !!rec.bypassPermissions, (rec.flags || []).length], ['claude', false, 0]);
  env.pm.killSession(rec.id);
});

kit.test('a model id that starts with a hyphen is INVALID_SETTING, so it can never read as a flag', async () => {
  const cwd = path.join(sb.work, 'hyphen-model');
  fs.mkdirSync(cwd, { recursive: true });
  const r = await kit.api(env.base, 'POST', '/sessions', { clientRequestId: crypto.randomUUID(), provider: 'claude', workingDir: cwd, projectId: env.store.getAllWorkspacesList()[0].id, settings: { model: '--dangerously-skip-permissions' } }, env.device.token);
  kit.eq([r.status, r.body.code, r.body.field], [422, 'INVALID_SETTING', 'model']);
});

kit.test('in process createSession (B3) takes launchOptions and argsExtra and resolves to a SessionSummary', async () => {
  const cwd = path.join(sb.work, 'migration-target');
  fs.mkdirSync(cwd, { recursive: true });
  const cap = captureLaunches();
  let summary;
  try {
    summary = await env.chat.launch.createSession({
      provider: 'claude', workingDir: cwd, projectId: env.store.getAllWorkspacesList()[0].id, name: 'Takeover target',
      launchOptions: { model: 'haiku', effort: 'low', permissionMode: 'plan', bypassPermissions: false, codex: null },
      argsExtra: ['--append-system-prompt-file', path.join(cwd, 'CHARTER.md'), '--add-dir', cwd],
    });
  } finally { cap.restore(); }
  kit.validate(summary, 'sessions/session-summary.json');
  kit.ok(!('session' in summary) && !('send' in summary), 'a SessionSummary, not the route body');
  kit.eq(summary.title, 'Takeover target');
  kit.eq(cap.calls[0].argsExtra, ['--append-system-prompt-file', path.join(cwd, 'CHARTER.md'), '--add-dir', cwd]);
  const rec = env.store.getAllSessionsList().find((x) => x.workingDir === cwd);
  kit.eq([rec.model, rec.effort, rec.permissionMode], ['haiku', 'low', 'plan']);
  env.pm.killSession(rec.id);
});

kit.test('in process createSession refuses argsExtra that are not a short list of plain arguments', async () => {
  const cwd = path.join(sb.work, 'bad-args');
  fs.mkdirSync(cwd, { recursive: true });
  const base = { provider: 'claude', workingDir: cwd, projectId: env.store.getAllWorkspacesList()[0].id, name: 'x' };
  for (const bad of ['--add-dir x', ['ok', 'two\nlines'], ['a\u0007'], [42], new Array(33).fill('x')]) {
    const err = await env.chat.launch.createSession(Object.assign({}, base, { argsExtra: bad })).then(() => null, (e) => e);
    kit.ok(err && err.status === 400 && err.code === 'INVALID_FIELD' && err.extra && err.extra.field === 'argsExtra', 'refused ' + JSON.stringify(bad) + ': ' + (err && err.code));
  }
});

kit.test('launchDetached ignores a caller supplied _liveChecked: a live interactive match is still refused', async () => {
  const transcript = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, transcript, kit.claudeExchange('bypass'));
  stateEntry(transcript, 'interactive', 'by12ab34');
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work, resumeSessionId: transcript });
  const before = spawns.length;
  const r = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy, _liveFresh: true, _liveChecked: true });
  kit.eq([r.status, r.code], ['refused', 'SESSION_LIVE_ELSEWHERE']);
  kit.eq(spawns.length, before, 'nothing spawned');
});

kit.test('launchDetached checks again when the record changes during the lookup (attachClient rule)', async () => {
  const quiet = crypto.randomUUID();
  const live = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, quiet, kit.claudeExchange('quiet'));
  kit.writeClaude(sb.projects, sb.work, live, kit.claudeExchange('live'));
  stateEntry(live, 'interactive', 'lv12ab34');
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work, resumeSessionId: quiet });
  const orig = env.pm._decideLive;
  let decisions = 0;
  env.pm._decideLive = async function decideThenChange(id, gate) {
    decisions += 1;
    const d = await orig.call(env.pm, id, gate);
    // The record moves to another transcript while the first lookup ran.
    if (decisions === 1) env.store.updateSession(rec.id, { resumeSessionId: live });
    return d;
  };
  const before = spawns.length;
  let r;
  try { r = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy, _liveFresh: true }); } finally { env.pm._decideLive = orig; }
  kit.eq([r.status, r.code, decisions], ['refused', 'SESSION_LIVE_ELSEWHERE', 2]);
  kit.eq(spawns.length, before, 'the changed target was checked, never spawned unchecked');
});

kit.test('restart answers the refusal instead of 202 when the relaunch is refused (owner none and workbook)', async () => {
  const transcript = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, transcript, kit.claudeExchange('restart me'));
  const rec = kit.trackedSession(env.store, { provider: 'claude', workingDir: sb.work, resumeSessionId: transcript });
  env.chat.internals.index.invalidate();
  const sid = 'cl_' + transcript;
  const orig = env.pm.launchDetached;
  env.pm.launchDetached = async () => ({ status: 'refused', code: 'SESSION_LIVE_ELSEWHERE', message: 'It is open in a terminal.' });
  let none;
  try { none = await kit.api(env.base, 'POST', '/sessions/' + sid + '/restart', { clientRequestId: crypto.randomUUID(), when: 'now' }, env.device.token); } finally { env.pm.launchDetached = orig; }
  kit.eq([none.status, none.body.code], [409, 'SESSION_LIVE_ELSEWHERE']);
  const up = await env.pm.launchDetached(rec.id, { _ptySpawnForTesting: spy });
  kit.eq(up.status, 'spawned');
  env.chat.internals.index.invalidate();
  kit.eq(env.chat.sessions.resolve(sid).owner, 'workbook');
  env.pm.launchDetached = async () => ({ status: 'refused', code: 'LAUNCH_FAILED', message: null });
  let wb;
  try { wb = await kit.api(env.base, 'POST', '/sessions/' + sid + '/restart', { clientRequestId: crypto.randomUUID(), when: 'now' }, env.device.token); } finally { env.pm.launchDetached = orig; }
  kit.eq([wb.status, wb.body.code], [500, 'INTERNAL']);
  kit.ok(/LAUNCH_FAILED/.test(wb.body.error), wb.body.error);
});

kit.run(async () => { if (env) await env.close(); });
