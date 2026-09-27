/**
 * B2: the Codex thread linker (critic F17). A new Codex session started from
 * the phone runs the fake codex in a PTY as wb_<id>; once the fake writes its
 * thread (state_5.sqlite row and rollout) the linker stores the thread id,
 * sessions.changed announces idChanged, the old topic gets a final
 * session.meta with supersededBy, and the history reads under cx_<thread>.
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

kit.test('a phone started Codex session is linked from wb_ to cx_', async () => {
  env = await kit.bootChat({ pty: true });
  const s = await kit.openStream(env.base, env.device.token);
  s.send({ type: 'subscribe', id: 's', epoch: null, topics: [{ topic: 'sessions', sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const cwd = path.join(sb.work, 'codex-new');
  fs.mkdirSync(cwd, { recursive: true });
  const ws = env.store.getAllWorkspacesList()[0] || env.store.createWorkspace({ name: 'W' });
  const r = await kit.api(env.base, 'POST', '/sessions', { clientRequestId: crypto.randomUUID(), provider: 'codex', workingDir: cwd, projectId: ws.id, message: { clientMessageId: crypto.randomUUID(), text: 'link me please' } }, env.device.token);
  kit.eq(r.status, 201, JSON.stringify(r.body));
  const wb = r.body.session.sessionId;
  kit.ok(/^wb_/.test(wb), wb);
  s.send({ type: 'subscribe', id: 'o', epoch: null, topics: [{ topic: 'session:' + wb, sinceSeq: null }] });
  const ev = await s.next((f) => f.type === 'sessions.changed' && f.data.changes.some((c) => c.change === 'idChanged' && c.previousSessionId === wb), 30000);
  const cx = ev.data.changes.find((c) => c.change === 'idChanged').sessionId;
  kit.ok(/^cx_[0-9a-f-]{36}$/.test(cx), cx);
  const meta = await s.next((f) => f.type === 'session.meta' && f.topic === 'session:' + wb && f.data.supersededBy === cx, 5000);
  kit.validateFrame(meta);
  kit.eq(env.store.getSession(wb.slice(3)).resumeSessionId, cx.slice(3));
  await kit.until(async () => {
    const page = await kit.api(env.base, 'GET', '/sessions/' + cx + '/messages', null, env.device.token);
    return page.status === 200 && page.body.messages.some((m) => m.role === 'user' && m.parts[0].text === 'link me please');
  }, 20000, 'history under the cx_ id');
  kit.eq(env.chat.capabilities().codexLinker, true);
  s.close();
});

kit.run(async () => { if (env) await env.close(); });
