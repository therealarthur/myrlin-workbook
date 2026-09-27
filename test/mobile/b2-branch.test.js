/**
 * B2: branch (PROTOCOL.md 4.5.8) against the fake CLIs. A Claude branch
 * spawns `resume <id>` with `fork-session` and a chosen `session-id`, so it
 * answers with its cl_ id at once and a 201 that validates; the source's
 * process and transcript are untouched; an external source can be branched;
 * fromMessageId answers 404 when unknown and 422 while branchFromMessage is
 * empty; a Codex branch runs `fork <thread id>` as a wb_ session.
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
const commands = [];
const srcId = crypto.randomUUID();
let srcFile;

kit.test('boot and wrap spawnSession to record commands', async () => {
  env = await kit.bootChat({ pty: true });
  const orig = env.pm.spawnSession.bind(env.pm);
  env.pm.spawnSession = (id, opts) => { commands.push((opts && opts.command) || ''); return orig(id, opts); };
  srcFile = kit.writeClaude(sb.projects, sb.work, srcId, kit.claudeExchange('source one').concat(kit.claudeExchange('source two')));
  kit.trackedSession(env.store, { provider: 'claude', resumeSessionId: srcId, workingDir: sb.work, name: 'E2E Claude' });
  env.chat.internals.index.invalidate();
});

kit.test('a Claude branch forks with a chosen session id and leaves the source untouched', async () => {
  const before = fs.statSync(srcFile);
  const r = await kit.api(env.base, 'POST', '/sessions/cl_' + srcId + '/branch', { clientRequestId: crypto.randomUUID(), fromMessageId: null, name: null, tabGroupId: null, afterSessionId: null }, env.device.token);
  kit.eq(r.status, 201, JSON.stringify(r.body));
  kit.validate(r.body, 'sessions/new-session-result.json');
  const cmd = commands[commands.length - 1];
  const m = new RegExp('^claude --resume ' + srcId + ' --fork-session --session-id ([0-9a-f-]{36})$').exec(cmd);
  kit.ok(m, cmd);
  kit.eq([r.body.session.sessionId, r.body.session.title, r.body.send], ['cl_' + m[1], 'E2E Claude branch', null]);
  await kit.until(() => fs.existsSync(path.join(path.dirname(srcFile), m[1] + '.jsonl')), 10000, 'forked transcript');
  const after = fs.statSync(srcFile);
  kit.eq([after.size, after.mtimeMs], [before.size, before.mtimeMs], 'source untouched');
  kit.ok(!env.pm.getSession(env.store.getAllSessionsList().find((s) => s.resumeSessionId === srcId).id), 'no process for the source');
  const send = await kit.api(env.base, 'POST', '/sessions/cl_' + m[1] + '/send', { clientMessageId: crypto.randomUUID(), text: 'hello from the branch' }, env.device.token);
  kit.eq(send.status, 202);
  await kit.until(() => fs.readFileSync(path.join(path.dirname(srcFile), m[1] + '.jsonl'), 'utf8').includes('Echo: hello from the branch'), 15000, 'echo in the branch');
  kit.ok(!fs.readFileSync(srcFile, 'utf8').includes('hello from the branch'), 'not in the source');
});

kit.test('an external source can be branched; the gate is never asked about the source', async () => {
  const ext = crypto.randomUUID();
  kit.writeClaude(sb.projects, sb.work, ext, kit.claudeExchange('external'));
  fs.writeFileSync(path.join(sb.state, 'claude-' + ext + '.json'), JSON.stringify({ id: 'ext12345', sessionId: ext, pid: process.pid, kind: 'interactive', status: 'busy', cwd: sb.work }));
  env.chat.internals.index.invalidate();
  const r = await kit.api(env.base, 'POST', '/sessions/cl_' + ext + '/branch', { clientRequestId: crypto.randomUUID() }, env.device.token);
  kit.eq(r.status, 201, JSON.stringify(r.body));
});

kit.test('fromMessageId: unknown is 404 MESSAGE_NOT_FOUND; a real assistant message is 422 while unsupported', async () => {
  const a = await kit.api(env.base, 'POST', '/sessions/cl_' + srcId + '/branch', { clientRequestId: crypto.randomUUID(), fromMessageId: crypto.randomUUID() }, env.device.token);
  kit.eq([a.status, a.body.code], [404, 'MESSAGE_NOT_FOUND']);
  const page = await kit.api(env.base, 'GET', '/sessions/cl_' + srcId + '/messages', null, env.device.token);
  const assistant = page.body.messages.find((m) => m.role === 'assistant');
  const b = await kit.api(env.base, 'POST', '/sessions/cl_' + srcId + '/branch', { clientRequestId: crypto.randomUUID(), fromMessageId: assistant.id }, env.device.token);
  kit.eq([b.status, b.body.code], [422, 'BRANCH_POINT_UNSUPPORTED']);
  kit.eq(env.chat.capabilities().branchFromMessage, []);
});

kit.test('a Codex branch runs fork <thread id> and starts as wb_; fromMessageId is refused', async () => {
  const thread = crypto.randomUUID();
  kit.writeCodex(sb.codexHome, thread, kit.codexExchange('codex source'), { cwd: sb.work });
  env.chat.internals.index.invalidate();
  const bad = await kit.api(env.base, 'POST', '/sessions/cx_' + thread + '/branch', { clientRequestId: crypto.randomUUID(), fromMessageId: 'o0' }, env.device.token);
  kit.eq([bad.status, bad.body.code], [422, 'BRANCH_POINT_UNSUPPORTED']);
  const r = await kit.api(env.base, 'POST', '/sessions/cx_' + thread + '/branch', { clientRequestId: crypto.randomUUID() }, env.device.token);
  kit.eq(r.status, 201, JSON.stringify(r.body));
  kit.eq(commands[commands.length - 1], 'codex fork ' + thread);
  kit.ok(/^(wb_|cx_)/.test(r.body.session.sessionId), r.body.session.sessionId);
});

kit.run(async () => { if (env) await env.close(); });
