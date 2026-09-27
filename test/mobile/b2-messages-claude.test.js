/**
 * B2: Claude message pages (PROTOCOL.md 3.6, 4.4.3, 4.4.4) on a synthetic
 * 200 MB transcript: the newest page in under 200 ms, paging back to the
 * first message with every message exactly once and in order, never more
 * than 2 MiB read per page (an fs.readSync spy), stable ids, schema valid
 * pages, the part text route, oversize lines, unknown record types, after
 * paging and CURSOR_EXPIRED.
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
const PAD = 'n'.repeat(20000);
const MIB2 = 2 * 1024 * 1024;
let env;
let sid;
let file;
let exchanges = 0;

/** Count bytes read by fs.readSync while fn runs. */
async function measure(fn) {
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = function spy(...a) { const n = orig.apply(fs, a); bytes += n; return n; };
  try { const r = await fn(); return { r, bytes }; } finally { fs.readSync = orig; }
}

kit.test('generate a 200 MB transcript with padded non message records', async () => {
  const id = crypto.randomUUID();
  sid = 'cl_' + id;
  const cwd = path.join(sb.work, 'big');
  const dir = path.join(sb.projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, id + '.jsonl');
  const fd = fs.openSync(file, 'w');
  let size = 0;
  let t = Date.parse('2026-01-01T00:00:00Z');
  const ts = () => new Date(t += 1000).toISOString();
  while (size < TARGET_BYTES) {
    const i = exchanges++;
    const mid = 'msg_' + i;
    const lines = [
      { type: 'user', uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd, message: { role: 'user', content: 'prompt ' + i } },
      { type: 'attachment', uuid: crypto.randomUUID(), timestamp: ts(), attachment: { type: 'task_reminder', content: PAD } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: ts(), requestId: 'r' + i, message: { id: mid, role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: '', signature: 's' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: ts(), requestId: 'r' + i, message: { id: mid, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'answer ' + i }] } },
      { type: 'brand-new-record-type', uuid: crypto.randomUUID(), timestamp: ts() },
      { type: 'system', subtype: 'turn_duration', durationMs: 1000, uuid: crypto.randomUUID(), timestamp: ts() },
    ];
    const buf = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.writeSync(fd, buf);
    size += buf.length;
  }
  // One long assistant text at the end for the part text route.
  const long = { type: 'user', uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd, message: { role: 'user', content: 'give me a lot' } };
  const longA = { type: 'assistant', uuid: crypto.randomUUID(), timestamp: ts(), requestId: 'rl', message: { id: 'msg_long', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'L'.repeat(40000) }] } };
  fs.writeSync(fd, Buffer.from(JSON.stringify(long) + '\n' + JSON.stringify(longA) + '\n'));
  fs.closeSync(fd);
  kit.ok(fs.statSync(file).size >= TARGET_BYTES, 'size');
  env = await kit.bootChat();
});

let newest;
kit.test('the newest page answers in under 200 ms and validates', async () => {
  await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=50', null, env.device.token);
  const t0 = Date.now();
  const { r, bytes } = await measure(() => kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=50', null, env.device.token));
  const ms = Date.now() - t0;
  kit.eq(r.status, 200);
  kit.ok(ms < 200, 'took ' + ms + ' ms');
  kit.ok(bytes <= MIB2, 'read ' + bytes);
  kit.validate(r.body, 'sessions/message-page.json');
  newest = r.body;
  kit.eq(newest.hasMoreBefore, true);
  kit.eq(newest.source.format, 'claudeJsonl');
  const last = newest.messages[newest.messages.length - 1];
  kit.eq(last.parts[0].text.length, 16384);
  kit.ok(last.parts[0].truncated && last.parts[0].fullLength === 40000, 'REST truncation');
});

kit.test('ids are stable across two reads and assistant blocks of one message group into one', async () => {
  const again = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=50', null, env.device.token);
  kit.eq(again.body.messages.map((m) => m.id), newest.messages.map((m) => m.id));
  const grouped = newest.messages.find((m) => m.role === 'assistant' && m.parts.length === 2);
  kit.ok(grouped && grouped.parts[0].type === 'thinking' && grouped.parts[0].redacted && grouped.parts[1].type === 'text', 'thinking plus text in one message');
});

kit.test('paging before reaches the first message, every message once and in order, at most 2 MiB per page', async () => {
  const seen = new Set();
  let cursor = newest.beforeCursor;
  let order = [];
  for (const m of newest.messages) { seen.add(m.id); order.push(m); }
  let pages = 1;
  let maxBytes = 0;
  for (;;) {
    const { r, bytes } = await measure(() => kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=200&before=' + encodeURIComponent(cursor), null, env.device.token));
    kit.eq(r.status, 200);
    maxBytes = Math.max(maxBytes, bytes);
    kit.ok(bytes <= MIB2, 'page ' + pages + ' read ' + bytes);
    if (pages === 3) kit.validate(r.body, 'sessions/message-page.json');
    for (const m of r.body.messages) { kit.ok(!seen.has(m.id), 'duplicate ' + m.id); seen.add(m.id); }
    order = r.body.messages.concat(order);
    pages += 1;
    if (!r.body.hasMoreBefore) break;
    cursor = r.body.beforeCursor;
  }
  // user, assistant, system turnEnd per exchange, plus the long pair.
  kit.eq(seen.size, exchanges * 3 + 2, 'message count');
  const prompts = order.filter((m) => m.role === 'user').map((m) => m.parts[0].text);
  kit.eq(prompts[0], 'prompt 0');
  for (let i = 1; i < exchanges; i++) if (prompts[i] !== 'prompt ' + i) throw new Error('order broken at ' + i);
  for (let i = 1; i < order.length; i++) if (order[i].ts < order[i - 1].ts) throw new Error('ts order at ' + i);
  kit.ok(order.filter((m) => m.role === 'assistant').every((m) => m.turnId && m.turnId.startsWith('t_')), 'assistant messages carry their turn');
  console.log('    pages=' + pages + ' maxBytesPerPage=' + maxBytes + ' exchanges=' + exchanges);
});

kit.test('after returns strictly newer messages', async () => {
  const mid = newest.messages[10];
  const r = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?limit=5&after=' + encodeURIComponent(mid.cursor), null, env.device.token);
  kit.eq(r.body.messages.map((m) => m.id), newest.messages.slice(11, 16).map((m) => m.id));
});

kit.test('the part text route returns the full text in windows', async () => {
  const last = newest.messages[newest.messages.length - 1];
  const a = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages/' + last.id + '/parts/0/text?offset=0&length=30000', null, env.device.token);
  kit.eq(a.status, 200);
  kit.validate(a.body, 'sessions/part-text.json');
  kit.eq([a.body.totalLength, a.body.text.length, a.body.nextOffset], [40000, 30000, 30000]);
  const b = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages/' + last.id + '/parts/0/text?offset=30000', null, env.device.token);
  kit.eq([b.body.text.length, b.body.nextOffset], [10000, null]);
  const bad = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages/nope/parts/0/text', null, env.device.token);
  kit.eq(bad.body.code, 'MESSAGE_NOT_FOUND');
});

kit.test('more than one position is 400; a shrunk file makes old cursors 410', async () => {
  const two = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?before=a&after=b', null, env.device.token);
  kit.eq([two.status, two.body.code], [400, 'INVALID_FIELD']);
  const cur = newest.messages[20].cursor;
  fs.truncateSync(file, 1000);
  const r = await kit.api(env.base, 'GET', '/sessions/' + sid + '/messages?before=' + encodeURIComponent(cur), null, env.device.token);
  kit.eq([r.status, r.body.code], [410, 'CURSOR_EXPIRED']);
});

kit.test('an oversize line becomes a system part and is never parsed', async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sb.work, 'over');
  const lines = [
    JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: id, cwd, message: { role: 'user', content: 'before' } }),
    JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'X'.repeat(5 * 1024 * 1024) }] } }),
    JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: id, cwd, message: { role: 'user', content: 'after' } }),
  ];
  kit.writeClaude(sb.projects, cwd, id, []);
  fs.writeFileSync(path.join(sb.projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl'), lines.join('\n') + '\n');
  const r = await kit.api(env.base, 'GET', '/sessions/cl_' + id + '/messages', null, env.device.token);
  kit.eq(r.status, 200);
  const sys = r.body.messages.find((m) => m.role === 'system');
  kit.ok(sys && /A record of 5\.0 MB was not loaded\./.test(sys.parts[0].text), JSON.stringify(sys && sys.parts));
  kit.eq(r.body.messages.map((m) => m.role), ['user', 'system', 'user']);
});

kit.run(async () => {
  if (env) await env.close();
  try { fs.unlinkSync(file); } catch (_) {}
});
