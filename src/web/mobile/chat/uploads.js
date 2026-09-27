/**
 * Chunked, resumable uploads from the phone (PROTOCOL.md 4.10, A16).
 *
 * What: POST /uploads creates an upload owned by the device; PUT chunks
 * append at exactly receivedBytes (a resumed upload continues from there);
 * complete checks SHA-256 and reads image dimensions from the JPEG or PNG
 * header; content streams the bytes. Files live at
 * <dataDir>/uploads/m/<deviceId>/<uploadId>/<filename> with an upload.json
 * beside them. Per device quota 4 GiB; an hourly sweep deletes expired
 * uploads (receiving 24 h, ready and unused 7 days, used 30 days after the
 * send). upload.progress goes to the device topic at most every 500 ms.
 *
 * Why: a phone send references uploads by absolute path in the message text
 * (7.3 step 4), so the file must be on the computer, whole and verified,
 * before the send is accepted; background uploads must survive suspension.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJson, randomId, warn } = require('./common');

const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_MAX = 16 * 1024 * 1024;
const IMAGE_MAX = 20 * 1024 * 1024;
const VIDEO_MAX = 1024 * 1024 * 1024;
const QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
const RECEIVING_TTL_MS = 24 * 60 * 60 * 1000;
const READY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000;
const PROGRESS_MS = 500;
const FILENAME_MAX = 100;
const IMAGE_TYPES = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/gif': ['gif'], 'image/webp': ['webp'] };
const VIDEO_TYPES = { 'video/mp4': ['mp4', 'm4v'], 'video/quicktime': ['mov', 'qt'] };
const HEIC_RE = /^image\/hei[cf]/i;

/**
 * Reduce a filename to its last segment and safe characters.
 * @param {string} name
 * @returns {string}
 */
function safeFilename(name) {
  const last = String(name || '').split(/[\\/]/).pop();
  return last.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, FILENAME_MAX);
}

/**
 * Width and height from a JPEG or PNG header.
 * @param {string} file
 * @returns {{width: number, height: number}|null}
 */
function imageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(65536);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n >= 24 && head.readUInt32BE(0) === 0x89504e47) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    if (n >= 4 && head[0] === 0xff && head[1] === 0xd8) {
      let i = 2;
      while (i + 9 < n) {
        if (head[i] !== 0xff) { i++; continue; }
        const marker = head[i + 1];
        const len = head.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (_) { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
  return null;
}

/**
 * @param {object} deps - {ctx, now, lazy: {sends}, uploadsRoot}
 * @returns {object}
 */
function createUploads(deps) {
  const { ctx } = deps;
  const now = deps.now || Date.now;
  const lazy = deps.lazy || {};
  const root = deps.uploadsRoot || path.join(ctx.dataDir || require('../../../utils/data-dir').getDataDir(), 'uploads', 'm');
  const uploads = new Map();
  const lastProgress = new Map();
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };

  // Load existing uploads.
  try {
    for (const dev of fs.readdirSync(root)) {
      for (const id of fs.readdirSync(path.join(root, dev))) {
        const meta = readJson(path.join(root, dev, id, 'upload.json'), null);
        if (meta && meta.uploadId) uploads.set(meta.uploadId, meta);
      }
    }
  } catch (_) { /* nothing yet */ }

  const dirOf = (u) => path.join(root, u.deviceId, u.uploadId);
  const fileOf = (u) => path.join(dirOf(u), u.filename);

  function save(u) {
    try { atomicWriteJson(path.join(dirOf(u), 'upload.json'), u); } catch (err) { warn('upload meta write failed', err && err.message); }
  }

  /**
   * Public Upload object.
   * @param {object} u
   * @returns {object}
   */
  function pub(u) {
    return {
      uploadId: u.uploadId, kind: u.kind, filename: u.filename, mediaType: u.mediaType, totalBytes: u.totalBytes,
      receivedBytes: u.receivedBytes, state: u.state, sha256: u.sha256 || null, path: u.state === 'ready' ? fileOf(u) : null,
      width: u.width === undefined ? null : u.width, height: u.height === undefined ? null : u.height,
      durationMs: u.durationMs === undefined ? null : u.durationMs, sessionId: u.sessionId || null,
      chunkBytes: CHUNK_BYTES, createdAtMs: u.createdAtMs, expiresAtMs: expiresAt(u),
    };
  }

  function expiresAt(u) {
    if (u.state === 'receiving') return u.createdAtMs + RECEIVING_TTL_MS;
    if (u.usedAtMs) return u.usedAtMs + USED_TTL_MS;
    return (u.completedAtMs || u.createdAtMs) + READY_TTL_MS;
  }

  function progress(u, force) {
    const t = now();
    if (!force && t - (lastProgress.get(u.uploadId) || 0) < PROGRESS_MS) return;
    lastProgress.set(u.uploadId, t);
    const hub = ctx.mobile && ctx.mobile.hub;
    if (hub && hub.publishDevice) { try { hub.publishDevice(u.deviceId, 'upload.progress', { upload: pub(u) }); } catch (_) {} }
  }

  /**
   * An upload of this device, or 404.
   * @param {string} uploadId
   * @param {string} deviceId
   * @returns {object}
   */
  function owned(uploadId, deviceId) {
    const u = uploads.get(uploadId);
    if (!u || u.deviceId !== deviceId || u.state === 'expired') fail(404, 'UPLOAD_NOT_FOUND', 'That upload does not exist on this computer.');
    return u;
  }

  function usedBytes(deviceId) {
    let n = 0;
    for (const u of uploads.values()) if (u.deviceId === deviceId && u.state !== 'expired' && u.state !== 'failed') n += u.totalBytes;
    return n;
  }

  /** POST /uploads */
  function create(body, deviceId) {
    const b = body || {};
    if (!['image', 'video'].includes(b.kind)) fail(400, 'INVALID_FIELD', 'kind must be image or video.', { field: 'kind' });
    if (typeof b.mediaType !== 'string') fail(400, 'INVALID_FIELD', 'mediaType is required.', { field: 'mediaType' });
    if (HEIC_RE.test(b.mediaType)) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Convert HEIC photos to JPEG before uploading.');
    const table = b.kind === 'image' ? IMAGE_TYPES : VIDEO_TYPES;
    const exts = table[b.mediaType];
    if (!exts) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'That media type is not accepted.');
    const filename = safeFilename(b.filename);
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    if (!filename || !exts.includes(ext)) fail(400, 'INVALID_FIELD', 'The file name must end with an extension that matches its type.', { field: 'filename' });
    if (!Number.isInteger(b.totalBytes) || b.totalBytes < 1) fail(400, 'INVALID_FIELD', 'totalBytes must be a positive integer.', { field: 'totalBytes' });
    if (b.totalBytes > (b.kind === 'image' ? IMAGE_MAX : VIDEO_MAX)) fail(413, 'UPLOAD_TOO_LARGE', 'That file is too large.');
    const used = usedBytes(deviceId);
    if (used + b.totalBytes > QUOTA_BYTES) fail(413, 'UPLOAD_QUOTA_EXCEEDED', 'Uploads from this iPhone use their whole allowance on this computer.', { quotaBytes: QUOTA_BYTES, usedBytes: used });
    const u = {
      uploadId: randomId('u_', 16), deviceId, kind: b.kind, filename, mediaType: b.mediaType, totalBytes: b.totalBytes,
      receivedBytes: 0, state: 'receiving', sha256: null, width: Number.isInteger(b.width) ? b.width : null,
      height: Number.isInteger(b.height) ? b.height : null, durationMs: Number.isInteger(b.durationMs) ? b.durationMs : null,
      sessionId: typeof b.sessionId === 'string' ? b.sessionId : null, createdAtMs: now(), completedAtMs: null, usedAtMs: null,
    };
    fs.mkdirSync(dirOf(u), { recursive: true });
    fs.writeFileSync(fileOf(u), Buffer.alloc(0));
    uploads.set(u.uploadId, u);
    save(u);
    const a = ctx.mobile && ctx.mobile.audit;
    if (a && a.write) { try { a.write({ deviceId, action: 'upload', sessionId: u.sessionId, detail: u.kind, ok: true }); } catch (_) {} }
    return pub(u);
  }

  /** PUT /uploads/:uploadId/chunks?offset=n */
  function writeChunk(uploadId, deviceId, offset, buf) {
    const u = owned(uploadId, deviceId);
    if (u.state !== 'receiving') fail(409, 'UPLOAD_OFFSET_MISMATCH', 'That upload is not receiving bytes.', { receivedBytes: u.receivedBytes });
    if (!Number.isInteger(offset) || offset !== u.receivedBytes) fail(409, 'UPLOAD_OFFSET_MISMATCH', 'Continue the upload from the received byte count.', { receivedBytes: u.receivedBytes });
    if (!buf || buf.length < 1 || buf.length > CHUNK_MAX) fail(400, 'INVALID_FIELD', 'A chunk is 1 byte to 16 MiB.', { field: 'body' });
    if (offset + buf.length > u.totalBytes) fail(400, 'UPLOAD_OVERFLOW', 'That chunk goes past the end of the file.');
    fs.appendFileSync(fileOf(u), buf);
    u.receivedBytes += buf.length;
    save(u);
    progress(u, false);
    return { uploadId, receivedBytes: u.receivedBytes };
  }

  /** POST /uploads/:uploadId/complete */
  function complete(uploadId, deviceId, body) {
    const u = owned(uploadId, deviceId);
    if (u.state === 'ready') return pub(u);
    const want = body && typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : null;
    if (!want || !/^[0-9a-f]{64}$/.test(want)) fail(400, 'INVALID_FIELD', 'sha256 must be 64 lowercase hex characters.', { field: 'sha256' });
    if (u.receivedBytes < u.totalBytes) fail(409, 'UPLOAD_INCOMPLETE', 'Some bytes of this upload are missing.');
    const got = crypto.createHash('sha256').update(fs.readFileSync(fileOf(u))).digest('hex');
    if (got !== want) {
      u.state = 'failed';
      try { fs.rmSync(dirOf(u), { recursive: true, force: true }); } catch (_) {}
      progress(u, true);
      uploads.delete(u.uploadId);
      fail(422, 'UPLOAD_CHECKSUM_MISMATCH', 'The file arrived damaged. Upload it again.');
    }
    u.sha256 = got;
    u.state = 'ready';
    u.completedAtMs = now();
    if (u.kind === 'image' && (u.width === null || u.height === null)) {
      const sz = imageSize(fileOf(u));
      if (sz) { u.width = sz.width; u.height = sz.height; }
    }
    save(u);
    progress(u, true);
    return pub(u);
  }

  /** DELETE /uploads/:uploadId */
  function remove(uploadId, deviceId) {
    const u = owned(uploadId, deviceId);
    const sends = lazy.sends && lazy.sends();
    if (sends && sends.usesUpload(uploadId)) fail(409, 'UPLOAD_IN_USE', 'A sent message uses this upload.');
    try { fs.rmSync(dirOf(u), { recursive: true, force: true }); } catch (_) {}
    uploads.delete(uploadId);
  }

  /** Hourly retention sweep; also marks uploads a send used. */
  function sweep() {
    const t = now();
    const sends = lazy.sends && lazy.sends();
    for (const u of Array.from(uploads.values())) {
      if (sends && !u.usedAtMs && sends.usesUpload(u.uploadId)) { u.usedAtMs = t; save(u); }
      if (t < expiresAt(u)) continue;
      u.state = 'expired';
      progress(u, true);
      try { fs.rmSync(dirOf(u), { recursive: true, force: true }); } catch (_) {}
      uploads.delete(u.uploadId);
    }
  }
  const timer = setInterval(sweep, SWEEP_MS);
  if (timer.unref) timer.unref();

  return {
    create,
    writeChunk,
    complete,
    remove,
    get(uploadId, deviceId) { return pub(owned(uploadId, deviceId)); },
    /** For the send path: the internal record of an upload this device owns, or null. */
    getOwned(uploadId, deviceId) { const u = uploads.get(uploadId); return u && u.deviceId === deviceId && u.state !== 'expired' ? pub(u) : null; },
    /** Content stream info. */
    contentOf(uploadId, deviceId) { const u = owned(uploadId, deviceId); if (u.state !== 'ready') fail(409, 'UPLOAD_NOT_READY', 'That upload has not finished.'); return { file: fileOf(u), mediaType: u.mediaType, size: u.totalBytes }; },
    /** Revocation: drop in progress uploads and their files. */
    cancelDevice(deviceId) {
      for (const u of Array.from(uploads.values())) {
        if (u.deviceId !== deviceId || u.state !== 'receiving') continue;
        try { fs.rmSync(dirOf(u), { recursive: true, force: true }); } catch (_) {}
        uploads.delete(u.uploadId);
      }
    },
    sweep,
    stop() { clearInterval(timer); },
    _all: uploads,
  };
}

module.exports = { createUploads, safeFilename, imageSize, CHUNK_BYTES, QUOTA_BYTES };
