/**
 * B2: Codex message pages on a synthetic 200 MB rollout: newest page under
 * 200 ms, paging back to the first message with every message once and in
 * order, at most 2 MiB read per page, ids "o" plus the byte offset stable
 * across reads, typed parts (redacted reasoning, tool calls and outputs,
 * turn end), injected context blocks skipped, schema valid pages.
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
const TARGET_BYTES = Number(process.env.B2_BIG_TRANSCRIPT_BYTES || 200 * 1024 * 1024);
const PAD = 'r'.repeat(20000);
const MIB2 = 2 * 1024 * 1024;
let env;
let sid;
let file;
let turns = 0;

async function measure(fn) {
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = function spy(...a) { const n = orig.apply(fs, a); bytes += n; return n; };
  try { const r = await fn(); return { r, bytes }; } finally { fs.readSync = orig; }
}

kit.test('generate a 200 MB rollout', async () => {
  const id = crypto.randomUUID();
  sid = 'cx_' + id;
  const dir = path.join(sb.codexHome, 'sessions', '2026', '09', '21');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'rollout-2026-09-21T10-00-00-' + id + '.jsonl');
  const fd = fs.openSync(file, 'w');
  let t = Date.parse('2026-02-01T00:00:00Z');
  const ts = () => new Date(t += 1000).toISOString();
  let size = 0;
  const w = (o) => { const b = Buffer.from(JSON.stringify(Object.assign({ timestamp: ts() }, o)) + '\n'); fs.writeSync(fd, b); size += b.length; };
  w({ type: 'session_meta', payload: { id, cwd: sb.work, originator: 'codex_cli_rs', cli_version: '0.153.4' } });
  w({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>' }] } });
  while (size < TARGET_BYTES) {
    const i = turns++;
    const turn = 'turn-' + i;
    w({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
    w({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ask ' + i }] } });
    w({ type: 'event_msg', payload: { type: 'user_message', message: 'ask ' + i } });
    w({ type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA' } });
    w({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }), call_id: 'c' + i } });
    w({ type: 'event_msg', payload: { type: 'token_count', info: { pad: PAD } } });
    w({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c' + i, output: JSON.stringify({ output: 'a b', metadata: { exit_code: 0 } }) } });
    w({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply ' + i }] } });
    w({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, duration_ms: 1500 } });
  }
  fs.closeSync(fd);
  env = await kit.bootChat();
});

let newest;
kit.test('newest page under 200 ms, typed parts, schema valid', async () => {
  await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=50', null, env.device.token);
  const t0 = Date.now();
  const { r, bytes } = await measure(() => kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=50', null, env.device.token));
  const ms = Date.now() - t0;
  kit.eq(r.status, 200);
  kit.ok(ms < 200, 'took ' + ms);
  kit.ok(bytes <= MIB2, 'read ' + bytes);
  kit.validate(r.body, 'sessions/message-page.json');
  newest = r.body;
  kit.eq(newest.source.format, 'codexRollout');
  const kinds = newest.messages.slice(-6).map((m) => m.role + ':' + m.parts[0].type + (m.parts[0].subtype ? ':' + m.parts[0].subtype : ''));
  kit.eq(kinds, ['user:text', 'assistant:thinking', 'assistant:toolCall', 'tool:toolResult', 'assistant:text', 'system:system:turnEnd']);
  const think = newest.messages[newest.messages.length - 5];
  kit.ok(think.parts[0].redacted === true && think.parts[0].text === null, 'redacted reasoning');
  const call = newest.messages[newest.messages.length - 4].parts[0];
  kit.eq([call.kind, call.detail], ['shell', 'bash -lc ls']);
  kit.ok(newest.messages.every((m) => /^o\d+$/.test(m.id)), 'offset ids');
});

kit.test('ids stable across reads; paging back reaches the first message with every message once', async () => {
  const again = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=50', null, env.device.token);
  kit.eq(again.body.messages.map((m) => m.id), newest.messages.map((m) => m.id));
  const seen = new Set(newest.messages.map((m) => m.id));
  let order = newest.messages.slice();
  let cursor = newest.beforeCursor;
  let pages = 1;
  for (;;) {
    const { r, bytes } = await measure(() => kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=200&before=' + encodeURIComponent(cursor), null, env.device.token));
    kit.ok(bytes <= MIB2, 'page read ' + bytes);
    for (const m of r.body.messages) { kit.ok(!seen.has(m.id), 'dup'); seen.add(m.id); }
    order = r.body.messages.concat(order);
    pages++;
    if (!r.body.hasMoreBefore) break;
    cursor = r.body.beforeCursor;
  }
  kit.eq(seen.size, turns * 6, 'six messages per turn, the injected context skipped');
  const asks = order.filter((m) => m.role === 'user').map((m) => m.parts[0].text);
  for (let i = 0; i < turns; i++) if (asks[i] !== 'ask ' + i) throw new Error('order at ' + i);
  const offs = order.map((m) => Number(m.id.slice(1)));
  for (let i = 1; i < offs.length; i++) if (offs[i] <= offs[i - 1]) throw new Error('offset order at ' + i);
  console.log('    pages=' + pages + ' turns=' + turns);
});

kit.test('the part text of a tool call is its input as indented JSON', async () => {
  const callMsg = newest.messages[newest.messages.length - 4];
  const r = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages/' + callMsg.id + '/parts/0/text', null, env.device.token);
  kit.eq(r.status, 200);
  kit.ok(r.body.text.includes('\n  "command"'), r.body.text.slice(0, 80));
});

kit.run(async () => {
  if (env) await env.close();
  try { fs.unlinkSync(file); } catch (_) {}
});
