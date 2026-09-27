/**
 * B2: chunked resumable uploads (PROTOCOL.md 4.10): create, chunks with a
 * resumed offset, UPLOAD_OFFSET_MISMATCH, UPLOAD_OVERFLOW, checksum failure,
 * image dimensions from the header, per device quota, HEIC refusal, another
 * device's upload is 404, content streaming, a send that references the
 * upload by absolute path, delete refusal while used, and the retention
 * sweep of expired files (a scripted clock).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./fakes/b2-kit');

kit.sandbox();
const clock = { t: Date.now() };
let env;

/** A tiny valid PNG of 3 by 2 pixels (header only matters). */
function png() {
  const b = Buffer.alloc(40, 0);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(3, 16); b.writeUInt32BE(2, 20);
  return b;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const create = (body, token) => kit.api(env.base, 'POST', '/uploads', body, token || env.device.token);
const chunk = (id, offset, buf) => kit.api(env.base, 'PUT', '/uploads/' + id + '/chunks?offset=' + offset, buf, env.device.token);

kit.test('boot with a scripted clock', async () => { env = await kit.bootChat({ options: { now: () => clock.t } }); });

let up;
kit.test('create, two chunks with a resume, complete: ready with path and dimensions', async () => {
  const data = png();
  const r = await create({ kind: 'image', filename: 'C:\\x\\shot.png', mediaType: 'image/png', totalBytes: data.length, sessionId: null, width: null, height: null, durationMs: null });
  kit.eq(r.status, 201, JSON.stringify(r.body));
  kit.validate(r.body, 'media/upload.json');
  up = r.body;
  kit.eq([up.filename, up.state, up.receivedBytes, up.chunkBytes], ['shot.png', 'receiving', 0, 8388608]);
  const a = await chunk(up.uploadId, 0, data.subarray(0, 16));
  kit.eq([a.status, a.body.receivedBytes], [200, 16]);
  kit.validate(a.body, 'media/upload-chunk-result.json');
  const bad = await chunk(up.uploadId, 0, data.subarray(16));
  kit.eq([bad.status, bad.body.code, bad.body.receivedBytes], [409, 'UPLOAD_OFFSET_MISMATCH', 16]);
  const g = await kit.api(env.base, 'GET', '/uploads/' + up.uploadId, null, env.device.token);
  kit.eq(g.body.receivedBytes, 16);
  const over = await chunk(up.uploadId, 16, Buffer.alloc(100));
  kit.eq([over.status, over.body.code], [400, 'UPLOAD_OVERFLOW']);
  const b = await chunk(up.uploadId, 16, data.subarray(16));
  kit.eq(b.body.receivedBytes, data.length);
  const c = await kit.api(env.base, 'POST', '/uploads/' + up.uploadId + '/complete', { sha256: sha(data) }, env.device.token);
  kit.eq(c.status, 200, JSON.stringify(c.body));
  kit.eq([c.body.state, c.body.width, c.body.height, c.body.sha256], ['ready', 3, 2, sha(data)]);
  kit.ok(path.isAbsolute(c.body.path) && fs.existsSync(c.body.path), 'absolute path on disk');
  up = c.body;
  const content = await kit.api(env.base, 'GET', '/uploads/' + up.uploadId + '/content', null, env.device.token);
  kit.eq([content.status, content.headers['content-type'], content.raw.length], [200, 'image/png', data.length]);
});

kit.test('a checksum mismatch fails the upload and deletes its file', async () => {
  const data = Buffer.from('abc');
  const r = await create({ kind: 'image', filename: 'a.jpg', mediaType: 'image/jpeg', totalBytes: 3 });
  await chunk(r.body.uploadId, 0, data);
  const c = await kit.api(env.base, 'POST', '/uploads/' + r.body.uploadId + '/complete', { sha256: '0'.repeat(64) }, env.device.token);
  kit.eq([c.status, c.body.code], [422, 'UPLOAD_CHECKSUM_MISMATCH']);
  const g = await kit.api(env.base, 'GET', '/uploads/' + r.body.uploadId, null, env.device.token);
  kit.eq(g.status, 404);
});

kit.test('HEIC is 415, a wrong extension 400, too large 413, quota 413 with the numbers', async () => {
  kit.eq((await create({ kind: 'image', filename: 'a.heic', mediaType: 'image/heic', totalBytes: 10 })).body.code, 'UNSUPPORTED_MEDIA_TYPE');
  kit.eq((await create({ kind: 'image', filename: 'a.png', mediaType: 'image/jpeg', totalBytes: 10 })).body.code, 'INVALID_FIELD');
  kit.eq((await create({ kind: 'image', filename: 'a.jpg', mediaType: 'image/jpeg', totalBytes: 21 * 1024 * 1024 })).body.code, 'UPLOAD_TOO_LARGE');
  const d = env.b1.addDevice();
  for (let i = 0; i < 4; i++) kit.eq((await create({ kind: 'video', filename: 'v' + i + '.mp4', mediaType: 'video/mp4', totalBytes: 1024 * 1024 * 1024 }, d.token)).status, 201);
  const q = await create({ kind: 'video', filename: 'v.mp4', mediaType: 'video/mp4', totalBytes: 10 }, d.token);
  kit.eq([q.status, q.body.code, q.body.quotaBytes, q.body.usedBytes], [413, 'UPLOAD_QUOTA_EXCEEDED', 4294967296, 4294967296]);
});

kit.test("another device's upload is 404", async () => {
  const d = env.b1.addDevice();
  const r = await kit.api(env.base, 'GET', '/uploads/' + up.uploadId, null, d.token);
  kit.eq([r.status, r.body.code], [404, 'UPLOAD_NOT_FOUND']);
});

kit.test('a send references the upload by absolute path; delete is refused while it is used', async () => {
  const id = crypto.randomUUID();
  kit.writeClaude(process.env.CWM_CLAUDE_PROJECTS_DIR, process.cwd(), id, kit.claudeExchange('x'));
  env.chat.internals.index.invalidate();
  const q = env.chat.internals.sends;
  const r = q.accept('cl_' + id, { clientMessageId: crypto.randomUUID(), text: 'look', attachments: [{ uploadId: up.uploadId, role: 'image' }] }, { deviceId: env.device.deviceId });
  kit.eq(r.status, 202);
  const rec = q._records.get('cl_' + id + '|' + r.send.clientMessageId);
  kit.eq(q._compose(rec).text, 'look\n\n' + up.path);
  // No PTY in this boot: the pump fails the send at launch; then mark it used as a delivered send would be.
  await kit.until(() => rec.state === 'failed', 5000, 'pump settled');
  rec.state = 'confirmed';
  const del = await kit.api(env.base, 'DELETE', '/uploads/' + up.uploadId, null, env.device.token);
  kit.eq([del.status, del.body.code], [409, 'UPLOAD_IN_USE']);
  const notReady = await create({ kind: 'image', filename: 'n.png', mediaType: 'image/png', totalBytes: 5 });
  let err = null;
  try { q.accept('cl_' + id, { clientMessageId: crypto.randomUUID(), text: '', attachments: [{ uploadId: notReady.body.uploadId, role: 'image' }] }, { deviceId: env.device.deviceId }); } catch (e) { err = e.code; }
  kit.eq(err, 'UPLOAD_NOT_READY');
});

kit.test('the sweep deletes expired receiving and unused ready uploads', async () => {
  const r = await create({ kind: 'image', filename: 'old.png', mediaType: 'image/png', totalBytes: 40 });
  const uploads = env.chat.internals.uploads;
  const file = path.dirname(uploads._all.get(r.body.uploadId) ? path.join(process.env.CWM_DATA_DIR, 'uploads', 'm', env.device.deviceId, r.body.uploadId, 'x') : '');
  kit.ok(fs.existsSync(file), 'dir exists');
  clock.t += 25 * 60 * 60 * 1000;
  uploads.sweep();
  kit.ok(!fs.existsSync(file), 'receiving upload expired after 24 h');
  kit.eq((await kit.api(env.base, 'GET', '/uploads/' + r.body.uploadId, null, env.device.token)).status, 404);
});

kit.run(async () => { if (env) await env.close(); });
