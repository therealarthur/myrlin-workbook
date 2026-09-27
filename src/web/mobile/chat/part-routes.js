/**
 * Message pages, full part text and part content (PROTOCOL.md 4.4.3, 4.4.4).
 *
 * What: GET /sessions/:sessionId/messages pages the transcript by cursor
 * (newest, before, after, around a search anchor) through the transcript
 * reader, never reading a whole file; the part text route returns the full
 * text of a truncated part in UTF-16 windows (a toolCall part's text is its
 * input as indented JSON); the part content route returns an inline image's
 * bytes with its own content type.
 *
 * Why: history back to the first message for both providers (brief 4.5, W10)
 * with truncated parts completed on demand, so a page stays under 2 MiB.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const reader = require('./transcript-reader');
const { createClaudeMapper } = require('./claude-messages');
const { createCodexMapper } = require('./codex-messages');
const { intParam } = require('./common');

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const TEXT_WINDOW_DEFAULT = 65536;
const TEXT_WINDOW_MAX = 262144;

/**
 * @param {object} deps - {ctx, index, sends}
 * @returns {object}
 */
function createPartRoutes(deps) {
  const { ctx, index } = deps;
  const mappers = { claude: createClaudeMapper(), codex: createCodexMapper() };
  const offsets = new Map();
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };
  const hub = () => ctx.mobile && ctx.mobile.hub;

  /**
   * Mapper context for REST pages.
   * @param {object} ref
   * @returns {object}
   */
  function mctx(ref) {
    const sends = deps.sends && deps.sends();
    return {
      sessionId: ref.sessionId,
      originFor: (rec, id) => (sends && sends.originForMessage(ref.sessionId, id)) || { kind: ref.tracked ? 'desktop' : 'terminal', deviceId: null, clientMessageId: null },
      attachmentsFor: (id) => (sends ? sends.attachmentsForMessage(ref.sessionId, id) : null),
    };
  }

  /**
   * The session and its transcript, or the protocol errors.
   * @param {string} sessionId
   * @returns {object} ref with transcriptPath
   */
  function transcriptRef(sessionId) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    if (!ref.transcriptPath || !fs.existsSync(ref.transcriptPath)) fail(409, 'TRANSCRIPT_UNAVAILABLE', 'This session has no history yet.');
    return ref;
  }

  /**
   * GET /sessions/:sessionId/messages
   * @param {string} sessionId
   * @param {object} q
   * @returns {object} MessagePage
   */
  function messages(sessionId, q) {
    const ref = transcriptRef(sessionId);
    const limit = intParam(q.limit, PAGE_DEFAULT, 1, PAGE_MAX);
    if (limit === null) fail(400, 'INVALID_FIELD', 'limit must be 1 to 200.', { field: 'limit' });
    const positions = ['before', 'after', 'around'].filter((k) => q[k] !== undefined && q[k] !== '');
    if (positions.length > 1) fail(400, 'INVALID_FIELD', 'Use only one of before, after or around.', { field: positions[1] });
    const h = hub();
    const streamSeq = h ? h.currentSeq('session:' + ref.sessionId) : 0;
    const req = { limit };
    if (q.before) req.before = q.before;
    if (q.after) req.after = q.after;
    if (q.around) {
      const a = reader.decodeAnchor(q.around);
      if (!a || a.provider !== ref.provider || String(a.upstreamId).toLowerCase() !== String(ref.upstreamId).toLowerCase()) fail(404, 'ANCHOR_NOT_FOUND', 'That search result is no longer in this session.');
      req.aroundLine = a.lineNumber;
    }
    const mapper = mappers[ref.provider];
    const page = reader.readPage(ref.transcriptPath, mapper, req, mctx(ref));
    if (page.expired) fail(410, 'CURSOR_EXPIRED', 'That position in the history is no longer available. Start again.');
    if (page.anchorMissing) fail(404, 'ANCHOR_NOT_FOUND', 'That search result is no longer in this session.');
    for (const m of page.messages) {
      const c = reader.decodeCursor(m.cursor);
      if (c) offsets.set(ref.sessionId + '|' + m.id, c.o);
    }
    if (offsets.size > 20000) offsets.clear();
    return {
      sessionId: ref.sessionId,
      messages: page.messages,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
      beforeCursor: page.beforeCursor,
      afterCursor: page.afterCursor,
      anchorMessageId: page.anchorMessageId,
      source: { provider: ref.provider, format: mapper.format, transcriptBytes: page.transcriptBytes, formatDrift: page.formatDrift },
      streamEpoch: h ? h.epoch : null,
      streamSeq,
      _bytesRead: page.bytesRead,
    };
  }

  /**
   * A whole message by id (untruncated).
   * @param {object} ref
   * @param {string} messageId
   * @returns {{msg: object, offset: number}}
   */
  function fullMessage(ref, messageId) {
    const mapper = mappers[ref.provider];
    let off = offsets.get(ref.sessionId + '|' + messageId);
    if (off === undefined) off = reader.findMessageOffset(ref.transcriptPath, messageId, mapper);
    const msg = off === null || off === undefined ? null : reader.readMessageAt(ref.transcriptPath, off, mapper, Object.assign({ full: true }, mctx(ref)));
    if (!msg || msg.id !== messageId) fail(404, 'MESSAGE_NOT_FOUND', 'That message does not exist in this session.');
    return { msg, offset: off };
  }

  /**
   * GET .../messages/:messageId/parts/:partIndex/text
   * @param {string} sessionId
   * @param {string} messageId
   * @param {string} partIndex
   * @param {object} q
   * @returns {object} PartText
   */
  function partText(sessionId, messageId, partIndex, q) {
    const ref = transcriptRef(sessionId);
    const { msg } = fullMessage(ref, messageId);
    const i = Number(partIndex);
    const part = Number.isInteger(i) ? msg.parts[i] : null;
    if (!part) fail(404, 'PART_NOT_FOUND', 'That part does not exist.');
    let text;
    if (part.type === 'text' || part.type === 'toolResult' || part.type === 'system') text = part.text || '';
    else if (part.type === 'thinking') text = part.text || '';
    else if (part.type === 'toolCall') text = JSON.stringify(part.input === undefined ? null : part.input, null, 2);
    else fail(400, 'PART_NOT_TEXT', 'That part is not text.');
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const length = intParam(q.length, TEXT_WINDOW_DEFAULT, 1, TEXT_WINDOW_MAX);
    if (offset === null) fail(400, 'INVALID_FIELD', 'offset must be a whole number.', { field: 'offset' });
    if (length === null) fail(400, 'INVALID_FIELD', 'length must be 1 to 262144.', { field: 'length' });
    const slice = text.slice(offset, offset + length);
    const end = offset + slice.length;
    return { messageId, partIndex: i, offset, length: slice.length, totalLength: text.length, text: slice, nextOffset: end < text.length ? end : null };
  }

  /**
   * GET .../messages/:messageId/parts/:partIndex/content
   * @param {string} sessionId
   * @param {string} messageId
   * @param {string} partIndex
   * @returns {{mediaType: string, bytes: Buffer}}
   */
  function partContent(sessionId, messageId, partIndex) {
    const ref = transcriptRef(sessionId);
    const { msg, offset } = fullMessage(ref, messageId);
    const i = Number(partIndex);
    const part = Number.isInteger(i) ? msg.parts[i] : null;
    if (!part) fail(404, 'PART_NOT_FOUND', 'That part does not exist.');
    if (part.type !== 'image') fail(400, 'PART_NOT_IMAGE', 'That part is not an image.');
    const fd = fs.openSync(ref.transcriptPath, 'r');
    let rec = null;
    try {
      const size = fs.fstatSync(fd).size;
      for (const line of reader.forwardLines(fd, offset, size, null)) { rec = reader.parseLine(line).record; break; }
    } finally { fs.closeSync(fd); }
    const blocks = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
    const images = blocks.filter((b) => b && b.type === 'image' && b.source && typeof b.source.data === 'string');
    const imageOrdinal = msg.parts.slice(0, i + 1).filter((p) => p.type === 'image').length - 1;
    const img = images[imageOrdinal];
    if (!img) fail(404, 'PART_NOT_FOUND', 'That image is not stored in the transcript.');
    return { mediaType: img.source.media_type || 'application/octet-stream', bytes: Buffer.from(img.source.data, 'base64') };
  }

  return { messages, partText, partContent };
}

module.exports = { createPartRoutes, PAGE_MAX };
