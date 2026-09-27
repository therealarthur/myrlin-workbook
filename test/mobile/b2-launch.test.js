/**
 * B2: launching without a socket (pty-manager P5 launchDetached, PROTOCOL.md
 * 4.5.4 to 4.5.6, 9.3). launchDetached spawns from the store record,
 * attaches to a live background session with `claude attach <shortId>`,
 * refuses a live interactive one with SESSION_LIVE_ELSEWHERE and never
 * spawns, and never spawns twice for one transcript. POST /sessions creates
 * and starts a session and delivers its first message; restart and stop
 * follow their owner rules.
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

kit.run(async () => { if (env) await env.close(); });
