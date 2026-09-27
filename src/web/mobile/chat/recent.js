/**
 * Recent sessions and session detail (PROTOCOL.md 4.4.1 and 4.4.2).
 *
 * What: GET /sessions/recent pages the merged session list from memory
 * (never a cold discovery walk on the request path; partial true while a
 * provider cache is cold) and GET /sessions/:sessionId answers SessionDetail
 * with the state, the running or last turn, open prompts and pending sends.
 * Both are snapshots of their stream topic, so they carry streamEpoch and
 * the topic's streamSeq read before the snapshot was built.
 *
 * Why: the phone reads a snapshot, then subscribes with sinceSeq and misses
 * nothing (PROTOCOL.md 4.7).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const { b64url, fromB64url, intParam } = require('./common');

const RECENT_DEFAULT = 50;
const RECENT_MAX = 200;

/**
 * @param {object} deps - {ctx, index, turns, prompts, sends}
 * @returns {object} route functions
 */
function createRecent(deps) {
  const { ctx, index } = deps;
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };
  const hub = () => ctx.mobile && ctx.mobile.hub;

  /**
   * GET /sessions/recent
   * @param {object} q - query
   * @returns {object}
   */
  function recent(q) {
    const limit = intParam(q.limit, RECENT_DEFAULT, 1, RECENT_MAX);
    if (limit === null) fail(400, 'INVALID_FIELD', 'limit must be 1 to 200.', { field: 'limit' });
    if (q.provider !== undefined && !['claude', 'codex'].includes(q.provider)) fail(400, 'INVALID_FIELD', 'provider must be claude or codex.', { field: 'provider' });
    let offset = 0;
    if (q.cursor) {
      try { offset = JSON.parse(fromB64url(q.cursor).toString('utf8')).o; } catch (_) { offset = NaN; }
      if (!Number.isInteger(offset) || offset < 0) fail(410, 'CURSOR_EXPIRED', 'That page is no longer available. Start again.');
    }
    const h = hub();
    const streamSeq = h ? h.currentSeq('sessions') : 0;
    const all = index.list({ provider: q.provider || null, includeArchived: q.includeArchived === 'true' || q.includeArchived === true });
    const page = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? b64url(Buffer.from(JSON.stringify({ o: offset + limit }))) : null;
    return { sessions: page, nextCursor: next, partial: index.isPartial(), streamEpoch: h ? h.epoch : null, streamSeq };
  }

  /**
   * GET /sessions/:sessionId
   * @param {string} sessionId
   * @returns {object} SessionDetail
   */
  function detail(sessionId) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    const h = hub();
    const streamSeq = h ? h.currentSeq('session:' + sessionId) : 0;
    const turns = deps.turns();
    const extra = turns ? turns.metaExtra(ref.sessionId) : {};
    const summary = index.summary(sessionId);
    const meta = index.meta(sessionId, extra);
    if (ref.supersededBy && meta) meta.supersededBy = ref.supersededBy;
    return {
      summary,
      meta,
      state: turns ? turns.stateOf(ref.sessionId) : null,
      turn: turns ? turns.turnOf(ref.sessionId) : null,
      openPrompts: deps.prompts() ? deps.prompts().openFor(ref.sessionId) : [],
      sends: deps.sends() ? deps.sends().pending(ref.sessionId) : [],
      streamEpoch: h ? h.epoch : null,
      streamSeq,
    };
  }

  return { recent, detail };
}

module.exports = { createRecent, RECENT_MAX };
