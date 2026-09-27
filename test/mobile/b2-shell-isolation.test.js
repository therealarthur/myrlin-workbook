/**
 * B2: shell isolation (PROTOCOL.md 3.4.1, BUILD-CONTRACT 3.6.1 item 8b). A
 * tracked plain shell session does not exist for the phone: send,
 * interrupt, answer, messages, session detail and a stream subscribe all
 * answer SESSION_NOT_FOUND, and no pty.write reaches its PTY (a spy).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');
const { agentProviderOf } = require('../../src/web/mobile/chat/session-index');

kit.sandbox();
let env;
let ids;
const writes = [];

kit.test('a shell, a shell tagged claude, and a custom command are not agent sessions', async () => {
  kit.eq(agentProviderOf({ command: 'powershell.exe' }), null);
  kit.eq(agentProviderOf({ provider: 'claude', command: 'bash' }), null);
  kit.eq(agentProviderOf({ provider: 'shell', command: '' }), null);
  kit.eq(agentProviderOf({ provider: 'claude', command: 'claude' }), 'claude');
  kit.eq(agentProviderOf({ command: 'codex' }), 'codex');
});

kit.test('boot with a tracked shell whose PTY has a write spy', async () => {
  env = await kit.bootChat();
  const ws = env.store.getAllWorkspacesList()[0] || env.store.createWorkspace({ name: 'W' });
  const shell = env.store.createSession({ name: 'shell', workspaceId: ws.id, workingDir: '', command: 'powershell.exe' });
  const tagged = env.store.createSession({ name: 'tagged', workspaceId: ws.id, workingDir: '', command: 'cmd.exe' });
  env.store.updateSession(tagged.id, { provider: 'claude' });
  ids = ['wb_' + shell.id, 'wb_' + tagged.id];
  const fakePty = { alive: true, pty: { write: (d) => writes.push(d) }, vt: null, sessionId: shell.id };
  env.ctx.getPtyManager = () => ({ getSession: () => fakePty, sessions: new Map(), onSessionData: () => () => {} });
  env.chat.internals.index.invalidate();
});

kit.test('every route answers 404 SESSION_NOT_FOUND', async () => {
  for (const sid of ids) {
    const calls = [
      ['POST', '/sessions/' + sid + '/send', { clientMessageId: crypto.randomUUID(), text: 'rm -rf /' }],
      ['POST', '/sessions/' + sid + '/interrupt', { clientRequestId: crypto.randomUUID() }],
      ['POST', '/sessions/' + sid + '/prompts/p_' + 'x'.repeat(20) + '/answer', { dismiss: true }],
      ['GET', '/sessions/' + sid + '/messages', null],
      ['GET', '/sessions/' + sid, null],
      ['GET', '/sessions/' + sid + '/sends', null],
      ['GET', '/sessions/' + sid + '/prompts', null],
      ['POST', '/sessions/' + sid + '/branch', { clientRequestId: crypto.randomUUID() }],
      ['POST', '/sessions/' + sid + '/stop', { clientRequestId: crypto.randomUUID() }],
    ];
    for (const [m, p, b] of calls) {
      const r = await kit.api(env.base, m, p, b, env.device.token);
      kit.eq([m + ' ' + p.replace(sid, ':id'), r.status, r.body && r.body.code], [m + ' ' + p.replace(sid, ':id'), 404, 'SESSION_NOT_FOUND']);
      kit.validate(r.body, 'common/error.json');
    }
  }
});

kit.test('a stream subscribe to the shell gets the SESSION_NOT_FOUND control error', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  s.send({ type: 'subscribe', id: 'x', epoch: null, topics: [{ topic: 'session:' + ids[0], sinceSeq: null }] });
  const err = await s.next((f) => f.type === 'error');
  kit.eq(err.data.code, 'SESSION_NOT_FOUND');
  s.close();
});

kit.test('the shell is not listed and no byte reached its PTY', async () => {
  const r = await kit.api(env.base, 'GET', '/sessions/recent', null, env.device.token);
  kit.ok(!r.body.sessions.some((x) => ids.includes(x.sessionId)), 'not listed');
  kit.eq(writes.length, 0);
});

kit.run(async () => { if (env) await env.close(); });
