/**
 * Byte offset paging over JSONL transcripts for the mobile v2 messages API
 * (PROTOCOL.md 4.4.3), shared by both providers.
 *
 * What: backward and forward line iterators that read a transcript in
 * 256 KiB blocks from a byte offset, never the whole file; opaque cursors
 * that encode the file and the byte offset of a message's first line; the
 * page builder that groups provider fragments into messages (a provider
 * mapper decides what a record becomes and which records join one message);
 * and search anchors that turn a hit's line number into a byte offset by a
 * streaming count.
 *
 * Why: transcripts reach multiple gigabytes (R08:104), a whole file read
 * would block the event loop or throw on the string length limit (R08 1.7),
 * and the phone must be able to page back to the first message of every
 * session with every message exactly once (brief 4.5, W10).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const { b64url, fromB64url, sha256b64url } = require('./common');

/** Read block size (PROTOCOL.md 4.4.3). */
const BLOCK_BYTES = 256 * 1024;
/** Lines longer than this are not parsed (PROTOCOL.md 4.4.3, R08:548). */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** A page stops early once its JSON passes this size (PROTOCOL.md 4.4.3). */
const PAGE_JSON_MAX = 2 * 1024 * 1024;
/** Bounded look back to name the turn of the oldest messages of a page. */
const TURN_LOOKBACK_BYTES = 512 * 1024;
/** Cursor format version. */
const CURSOR_VERSION = 1;
const NEWLINE = 0x0a;

/**
 * Stable short tag for a transcript file: its path plus its birth time, so a
 * file that was replaced (same path, new file) no longer matches old cursors.
 * @param {string} file
 * @param {fs.Stats} [st]
 * @returns {string}
 */
function fileTag(file, st) {
  let birth = 0;
  try { birth = Math.round((st || fs.statSync(file)).birthtimeMs || 0); } catch (_) { birth = 0; }
  return sha256b64url(String(file).toLowerCase() + '\n' + birth).slice(0, 10);
}

/**
 * Encode a cursor (PROTOCOL.md 3.6): {v, f, o}.
 * @param {string} tag
 * @param {number} offset
 * @returns {string}
 */
function encodeCursor(tag, offset) {
  return b64url(Buffer.from(JSON.stringify({ v: CURSOR_VERSION, f: tag, o: offset })));
}

/**
 * Decode a cursor; null when it is not one of ours.
 * @param {string} cursor
 * @returns {{f: string, o: number}|null}
 */
function decodeCursor(cursor) {
  try {
    const obj = JSON.parse(fromB64url(cursor).toString('utf8'));
    if (!obj || obj.v !== CURSOR_VERSION || typeof obj.f !== 'string' || !Number.isInteger(obj.o) || obj.o < 0) return null;
    return { f: obj.f, o: obj.o };
  } catch (_) {
    return null;
  }
}

/**
 * Encode a search anchor (PROTOCOL.md 4.9.2): provider, upstream id, 1 based line number.
 * B3's message search mints these; this module resolves them.
 * @param {{provider: string, upstreamId: string, lineNumber: number}} a
 * @returns {string}
 */
function encodeAnchor(a) {
  return b64url(Buffer.from(JSON.stringify({ v: 1, p: a.provider, u: a.upstreamId, l: a.lineNumber })));
}

/**
 * @param {string} anchor
 * @returns {{provider: string, upstreamId: string, lineNumber: number}|null}
 */
function decodeAnchor(anchor) {
  try {
    const o = JSON.parse(fromB64url(anchor).toString('utf8'));
    if (!o || o.v !== 1 || typeof o.p !== 'string' || typeof o.u !== 'string' || !Number.isInteger(o.l) || o.l < 1) return null;
    return { provider: o.p, upstreamId: o.u, lineNumber: o.l };
  } catch (_) {
    return null;
  }
}

/**
 * Build a yielded line from collected segments.
 * @param {number} start - Byte offset of the line's first byte.
 * @param {number} end - Byte offset of the terminating newline.
 * @param {Buffer[]} parts - Segments, newest first.
 * @param {boolean} oversize
 * @returns {{offset: number, length: number, text: (string|null)}}
 */
function makeLine(start, end, parts, oversize) {
  if (oversize) return { offset: start, length: end - start, text: null };
  const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts.slice().reverse());
  let text = buf.toString('utf8');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return { offset: start, length: end - start, text };
}

/**
 * Iterate complete lines backwards from a byte offset (exclusive). Only lines
 * terminated by a newline are yielded, so a partial line still being written
 * at the end of the file is never parsed.
 * @param {number} fd
 * @param {number} fromOffset
 * @param {{bytes: number}} [counter] - Accumulates bytes read.
 * @returns {Generator<{offset: number, length: number, text: (string|null)}>}
 */
function* backwardLines(fd, fromOffset, counter) {
  let pos = fromOffset;
  let started = false;
  let lineEnd = -1;
  let parts = [];
  let partLen = 0;
  let oversize = false;
  const addPart = (seg) => {
    if (oversize || seg.length === 0) { partLen += seg.length; return; }
    partLen += seg.length;
    if (partLen > MAX_LINE_BYTES) { oversize = true; parts = []; return; }
    parts.push(seg);
  };
  while (pos > 0) {
    const start = Math.max(0, pos - BLOCK_BYTES);
    const len = pos - start;
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    if (counter) counter.bytes += n;
    let hi = len;
    for (let i = len - 1; i >= 0; i--) {
      if (buf[i] !== NEWLINE) continue;
      const abs = start + i;
      if (!started) {
        started = true;
      } else {
        addPart(buf.subarray(i + 1, hi));
        if (lineEnd - (abs + 1) > 0) yield makeLine(abs + 1, lineEnd, parts, oversize);
      }
      lineEnd = abs;
      hi = i;
      parts = [];
      partLen = 0;
      oversize = false;
    }
    if (started) addPart(buf.subarray(0, hi));
    pos = start;
  }
  if (started && lineEnd > 0) yield makeLine(0, lineEnd, parts, oversize);
}

/**
 * Iterate complete lines forwards from a line start.
 * @param {number} fd
 * @param {number} fromOffset
 * @param {number} fileSize
 * @param {{bytes: number}} [counter]
 * @returns {Generator<{offset: number, length: number, text: (string|null)}>}
 */
function* forwardLines(fd, fromOffset, fileSize, counter) {
  let pos = fromOffset;
  let lineStart = fromOffset;
  let parts = [];
  let partLen = 0;
  let oversize = false;
  while (pos < fileSize) {
    const len = Math.min(BLOCK_BYTES, fileSize - pos);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    if (counter) counter.bytes += n;
    if (n <= 0) break;
    let lo = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] !== NEWLINE) continue;
      const seg = buf.subarray(lo, i);
      partLen += seg.length;
      if (!oversize) {
        if (partLen > MAX_LINE_BYTES) { oversize = true; parts = []; } else parts.push(seg);
      }
      const abs = pos + i;
      if (abs - lineStart > 0) {
        const text = oversize ? null : (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('utf8').replace(/\r$/, '');
        yield { offset: lineStart, length: abs - lineStart, text };
      }
      lineStart = abs + 1;
      parts = [];
      partLen = 0;
      oversize = false;
      lo = i + 1;
    }
    const rest = buf.subarray(lo, n);
    partLen += rest.length;
    if (!oversize) {
      if (partLen > MAX_LINE_BYTES) { oversize = true; parts = []; } else if (rest.length) parts.push(Buffer.from(rest));
    }
    pos += n;
  }
}

/**
 * Parse one line into a record for a mapper.
 * @param {{offset:number, length:number, text:(string|null)}} line
 * @returns {{record: (object|null), oversize: boolean, unparsed: boolean}}
 */
function parseLine(line) {
  if (line.text === null) return { record: null, oversize: true, unparsed: false };
  try {
    const record = JSON.parse(line.text);
    if (!record || typeof record !== 'object') return { record: null, oversize: false, unparsed: true };
    return { record, oversize: false, unparsed: false };
  } catch (_) {
    return { record: null, oversize: false, unparsed: true };
  }
}

/**
 * A transcript opened for one page: fd, size, tag and a byte counter.
 */
class TranscriptFile {
  /**
   * @param {string} file
   */
  constructor(file) {
    this.file = file;
    this.st = fs.statSync(file);
    this.size = this.st.size;
    this.tag = fileTag(file, this.st);
    this.fd = fs.openSync(file, 'r');
    this.counter = { bytes: 0 };
  }

  /** Release the descriptor. */
  close() {
    try { fs.closeSync(this.fd); } catch (_) {}
  }

  /**
   * Validate a cursor against this file; returns the offset or null (expired).
   * @param {string} cursor
   * @returns {number|null}
   */
  offsetOf(cursor) {
    const c = decodeCursor(cursor);
    if (!c || c.f !== this.tag || c.o > this.size) return null;
    if (c.o > 0) {
      const b = Buffer.alloc(1);
      fs.readSync(this.fd, b, 0, 1, c.o - 1);
      this.counter.bytes += 1;
      if (b[0] !== NEWLINE) return null;
    }
    return c.o;
  }

  /**
   * Byte offset of a 1 based line number by a streaming newline count.
   * @param {number} lineNumber
   * @returns {number|null}
   */
  offsetOfLine(lineNumber) {
    if (lineNumber === 1) return 0;
    let seen = 1;
    let pos = 0;
    while (pos < this.size) {
      const len = Math.min(BLOCK_BYTES, this.size - pos);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(this.fd, buf, 0, len, pos);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) {
        if (buf[i] === NEWLINE) {
          seen += 1;
          if (seen === lineNumber) return pos + i + 1 < this.size ? pos + i + 1 : null;
        }
      }
      pos += n;
    }
    return null;
  }

  /** @returns {string} */
  cursorAt(offset) { return encodeCursor(this.tag, offset); }
}

/**
 * Whether a fragment joins the group being built.
 * @param {{key: (string|null)}} group
 * @param {{key: (string|null)}} frag
 * @returns {boolean}
 */
function joins(group, frag) {
  return !!(group && group.key && frag.key && group.key === frag.key);
}

/**
 * Collect message groups going backwards from an offset.
 * @param {TranscriptFile} tf
 * @param {object} mapper - {fragment(record, line) => frag|null}
 * @param {number} fromOffset
 * @param {number} limit
 * @param {object} stats - {total, unparsed}
 * @returns {{groups: Array, hasMore: boolean}} groups newest first
 */
function collectBackward(tf, mapper, fromOffset, limit, stats) {
  const groups = [];
  let cur = null;
  let hasMore = false;
  for (const line of backwardLines(tf.fd, fromOffset, tf.counter)) {
    const p = parseLine(line);
    stats.total += 1;
    if (p.unparsed) { stats.unparsed += 1; continue; }
    const frag = mapper.fragment(p.record, line, p.oversize);
    if (!frag) continue;
    if (cur && joins(cur, frag)) { cur.frags.unshift(frag); continue; }
    if (cur) {
      groups.push(cur);
      if (groups.length >= limit) { hasMore = true; cur = null; break; }
    }
    cur = { key: frag.key, frags: [frag] };
  }
  if (cur) groups.push(cur);
  return { groups, hasMore };
}

/**
 * Collect message groups going forwards from an offset.
 * @param {TranscriptFile} tf
 * @param {object} mapper
 * @param {number} fromOffset
 * @param {number} limit
 * @param {boolean} skipFirst - Skip the group starting at fromOffset (the cursor's own message).
 * @param {object} stats
 * @returns {{groups: Array, hasMore: boolean}} groups oldest first
 */
function collectForward(tf, mapper, fromOffset, limit, skipFirst, stats) {
  const groups = [];
  let cur = null;
  let skipping = skipFirst;
  let skipGroup = null;
  let hasMore = false;
  for (const line of forwardLines(tf.fd, fromOffset, tf.size, tf.counter)) {
    const p = parseLine(line);
    stats.total += 1;
    if (p.unparsed) { stats.unparsed += 1; continue; }
    const frag = mapper.fragment(p.record, line, p.oversize);
    if (!frag) continue;
    if (skipping) {
      if (!skipGroup) { skipGroup = { key: frag.key }; continue; }
      if (joins(skipGroup, frag)) continue;
      skipping = false;
    }
    if (cur && joins(cur, frag)) { cur.frags.push(frag); continue; }
    if (cur) {
      groups.push(cur);
      if (groups.length >= limit) { hasMore = true; cur = null; break; }
    }
    cur = { key: frag.key, frags: [frag] };
  }
  if (cur) groups.push(cur);
  return { groups, hasMore };
}

/**
 * Turn groups into messages, stopping when the page JSON would pass 2 MiB.
 * @param {Array} groups - In the order to emit.
 * @param {object} mapper
 * @param {TranscriptFile} tf
 * @param {object} mctx - Mapper context (sessionId, originFor, ...).
 * @returns {{messages: Array, cut: boolean}}
 */
function buildMessages(groups, mapper, tf, mctx) {
  const messages = [];
  let bytes = 0;
  let cut = false;
  for (const g of groups) {
    const msg = mapper.build(g.frags, Object.assign({ cursor: tf.cursorAt(g.frags[0].offset) }, mctx));
    if (!msg) continue;
    const size = Buffer.byteLength(JSON.stringify(msg));
    if (messages.length > 0 && bytes + size > PAGE_JSON_MAX) { cut = true; break; }
    bytes += size;
    messages.push(msg);
  }
  return { messages, cut };
}

/**
 * Name the turn of messages that precede the page's first prompt by a bounded
 * look back for the prompt that opened their turn.
 * @param {TranscriptFile} tf
 * @param {object} mapper
 * @param {Array} messages - Oldest first.
 * @param {number} fromOffset - Offset of the first message's first line.
 */
function fillLeadingTurnIds(tf, mapper, messages, fromOffset) {
  if (!messages.length || messages[0].turnId || typeof mapper.turnIdOf !== 'function') return;
  const limitOffset = Math.max(0, fromOffset - TURN_LOOKBACK_BYTES);
  let found = null;
  let ended = false;
  for (const line of backwardLines(tf.fd, fromOffset, tf.counter)) {
    if (line.offset < limitOffset) break;
    const p = parseLine(line);
    if (!p.record) continue;
    const r = mapper.turnIdOf(p.record);
    if (r === false) { ended = true; break; }
    if (r) { found = r; break; }
  }
  if (!found || ended) return;
  for (const m of messages) {
    if (m.turnId) break;
    m.turnId = found;
  }
}

/**
 * Assign turn ids forwards within a page: a user prompt opens a turn.
 * @param {Array} messages - Oldest first.
 */
function propagateTurnIds(messages) {
  let current = null;
  for (const m of messages) {
    if (m.role === 'user' && m.turnId) { current = m.turnId; continue; }
    if (!m.turnId && current) m.turnId = current;
    if (m.role === 'system' && m.parts[0] && (m.parts[0].subtype === 'turnEnd' || m.parts[0].subtype === 'interrupted')) current = null;
  }
}

/**
 * Read one page of messages.
 *
 * @param {string} file - Transcript path.
 * @param {object} mapper - Provider mapper ({fragment, build, turnIdOf, format}).
 * @param {object} q - {limit, before, after, around (anchor already resolved to lineNumber)}
 * @param {object} mctx - Passed to mapper.build.
 * @returns {{messages: Array, hasMoreBefore: boolean, hasMoreAfter: boolean, beforeCursor: (string|null),
 *   afterCursor: (string|null), anchorMessageId: (string|null), transcriptBytes: number, formatDrift: boolean,
 *   bytesRead: number, expired?: boolean, anchorMissing?: boolean}}
 */
function readPage(file, mapper, q, mctx) {
  const tf = new TranscriptFile(file);
  const stats = { total: 0, unparsed: 0 };
  try {
    const limit = q.limit;
    let messages = [];
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    let anchorMessageId = null;
    if (q.before) {
      const off = tf.offsetOf(q.before);
      if (off === null) return { expired: true };
      const r = collectBackward(tf, mapper, off, limit, stats);
      // Groups arrive newest first; building in that order lets the 2 MiB cut drop the oldest.
      const b = buildMessages(r.groups, mapper, tf, mctx);
      messages = b.messages.reverse();
      hasMoreBefore = r.hasMore || b.cut;
      hasMoreAfter = off < tf.size;
    } else if (q.after) {
      const off = tf.offsetOf(q.after);
      if (off === null) return { expired: true };
      const r = collectForward(tf, mapper, off, limit, true, stats);
      const b = buildMessages(r.groups, mapper, tf, mctx);
      messages = b.messages;
      hasMoreAfter = r.hasMore || b.cut;
      hasMoreBefore = true;
    } else if (q.aroundLine) {
      const lineOff = tf.offsetOfLine(q.aroundLine);
      if (lineOff === null) return { anchorMissing: true };
      // The anchored message is the newest group that starts at or before the line.
      let endOff = tf.size;
      for (const line of forwardLines(tf.fd, lineOff, tf.size, tf.counter)) { endOff = line.offset + line.length + 1; break; }
      const half = Math.max(1, Math.floor(limit / 2));
      const back = collectBackward(tf, mapper, endOff, half + 1, stats);
      if (!back.groups.length) return { anchorMissing: true };
      const anchorGroup = back.groups[0];
      const fwd = collectForward(tf, mapper, anchorGroup.frags[0].offset, half, true, stats);
      const ordered = back.groups.slice().reverse().concat(fwd.groups);
      const b = buildMessages(ordered, mapper, tf, mctx);
      messages = b.messages;
      hasMoreBefore = back.hasMore;
      hasMoreAfter = fwd.hasMore || b.cut;
      const anchorMsg = mapper.build(anchorGroup.frags, Object.assign({ cursor: tf.cursorAt(anchorGroup.frags[0].offset) }, mctx));
      anchorMessageId = anchorMsg ? anchorMsg.id : null;
    } else {
      const r = collectBackward(tf, mapper, tf.size, limit, stats);
      const b = buildMessages(r.groups, mapper, tf, mctx);
      messages = b.messages.reverse();
      hasMoreBefore = r.hasMore || b.cut;
      hasMoreAfter = false;
    }
    propagateTurnIds(messages);
    if (messages.length) fillLeadingTurnIds(tf, mapper, messages, decodeCursor(messages[0].cursor).o);
    return {
      messages,
      hasMoreBefore,
      hasMoreAfter,
      beforeCursor: messages.length ? messages[0].cursor : null,
      afterCursor: messages.length ? messages[messages.length - 1].cursor : null,
      anchorMessageId,
      transcriptBytes: tf.size,
      formatDrift: stats.total >= 10 && stats.unparsed / stats.total > 0.1,
      bytesRead: tf.counter.bytes,
    };
  } finally {
    tf.close();
  }
}

/**
 * Find the byte offset of a message by id. Claude ids are record uuids, found
 * by a streaming scan (the page cache usually knows them); Codex ids are
 * "o" plus the offset itself.
 * @param {string} file
 * @param {string} messageId
 * @param {object} mapper - Needs idMatches(record, messageId) for uuid ids.
 * @returns {number|null}
 */
function findMessageOffset(file, messageId, mapper) {
  if (/^o\d+$/.test(messageId)) return Number(messageId.slice(1));
  let fd;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const needle = '"' + messageId + '"';
    for (const line of forwardLines(fd, 0, size, null)) {
      if (!line.text || line.text.indexOf(needle) === -1) continue;
      const p = parseLine(line);
      if (p.record && mapper.idMatches(p.record, messageId)) return line.offset;
    }
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  return null;
}

/**
 * Read the message group that starts at an offset (for part routes and branch).
 * @param {string} file
 * @param {number} offset
 * @param {object} mapper
 * @param {object} mctx
 * @returns {object|null} Message
 */
function readMessageAt(file, offset, mapper, mctx) {
  const tf = new TranscriptFile(file);
  try {
    const stats = { total: 0, unparsed: 0 };
    const r = collectForward(tf, mapper, offset, 1, false, stats);
    if (!r.groups.length || r.groups[0].frags[0].offset !== offset) return null;
    const g = r.groups[0];
    return mapper.build(g.frags, Object.assign({ cursor: tf.cursorAt(offset), full: true }, mctx));
  } finally {
    tf.close();
  }
}

/**
 * Iterate records of a byte range (BUILD-CONTRACT 3.4.3 readTranscriptRange).
 * @param {string} file
 * @param {number} fromOffset
 * @param {number} toOffset
 * @returns {AsyncGenerator<{offset: number, record: (object|null)}>}
 */
async function* readRange(file, fromOffset, toOffset) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(fs.fstatSync(fd).size, Number.isFinite(toOffset) ? toOffset : Infinity);
    for (const line of forwardLines(fd, fromOffset || 0, size, null)) {
      yield { offset: line.offset, record: parseLine(line).record };
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = {
  BLOCK_BYTES,
  MAX_LINE_BYTES,
  PAGE_JSON_MAX,
  TranscriptFile,
  backwardLines,
  forwardLines,
  parseLine,
  encodeCursor,
  decodeCursor,
  encodeAnchor,
  decodeAnchor,
  fileTag,
  readPage,
  readMessageAt,
  findMessageOffset,
  readRange,
};
