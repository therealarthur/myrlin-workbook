/**
 * Interrupt from the phone (PROTOCOL.md 4.4.6 and 7.5).
 *
 * What: writes exactly one ESC byte as its own pty.write under the session's
 * write lock, only while a turn is open and no prompt is open, debounced to
 * one ESC per 1500 ms per session, idempotent by clientRequestId for 10
 * minutes. A background session is attached first and the ESC is written
 * only if the turn is still open.
 *
 * Why: two ESCs in Claude Code clear the draft or open rewind (R04:263), so a
 * repeated tap must never become a second ESC, and an ESC must never be
 * joined to other bytes (it is the prefix of every escape sequence).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const DEBOUNCE_MS = 1500;
const IDEMPOTENCY_MS = 10 * 60 * 1000;
const ESC = '\x1b';

/**
 * @param {object} deps - {ctx, index, runtime, lazy: {turns, prompts, launch}, now}
 * @returns {object}
 */
function createInterrupts(deps) {
  const { ctx, index, runtime } = deps;
  const now = deps.now || Date.now;
  const lazy = deps.lazy || {};
  const lastEsc = new Map();
  const phoneEsc = new Map();
  const done = new Map();
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };

  /**
   * POST /sessions/:sessionId/interrupt
   * @param {string} sessionId
   * @param {{clientRequestId?: string}} body
   * @param {{deviceId: string}} who
   * @returns {Promise<{status: string, sentAtMs: number}>}
   */
  async function interrupt(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    const sid = ref.sessionId;
    const reqId = body && typeof body.clientRequestId === 'string' ? body.clientRequestId : null;
    if (reqId) {
      const prev = done.get(sid + '|' + reqId);
      if (prev && now() - prev.at <= IDEMPOTENCY_MS) return prev.result;
    }
    if (['external', 'chatgpt', 'handedOff'].includes(ref.owner)) {
      const meta = index.meta(sid);
      fail(409, 'SESSION_READ_ONLY', (meta && meta.readOnlyReason) || 'This session is read only on the phone.', { owner: ref.owner, reason: (meta && meta.readOnlyReason) || null });
    }
    const prompts = lazy.prompts && lazy.prompts();
    const open = prompts ? prompts.openFor(sid) : [];
    if (open.length) fail(409, 'PROMPT_OPEN', 'A question or approval is open. Answer or deny it instead.', { promptId: open[0].promptId });
    const turns = lazy.turns && lazy.turns();
    const running = () => {
      const st = turns ? turns.stateOf(sid) : null;
      return !!(turns && turns.isTurnOpen(sid)) || !!(st && ['thinking', 'working', 'streaming'].includes(st.state));
    };
    if (!running()) fail(409, 'NOT_RUNNING', 'Nothing is running in this session.');
    const last = lastEsc.get(sid);
    if (last && now() - last < DEBOUNCE_MS) {
      const result = { status: 'debounced', sentAtMs: last };
      if (reqId) done.set(sid + '|' + reqId, { at: now(), result });
      return result;
    }
    if (ref.owner === 'background') {
      const launch = lazy.launch && lazy.launch();
      const res = launch ? await launch.start(sid, { reason: 'interrupt' }) : { status: 'refused' };
      if (res.status === 'refused') fail(409, 'SESSION_LIVE_ELSEWHERE', 'Workbook could not attach to this session.');
      if (!running()) fail(409, 'NOT_RUNNING', 'Nothing is running in this session.');
    }
    const result = await runtime.withLock(sid, async () => {
      const again = lastEsc.get(sid);
      if (again && now() - again < DEBOUNCE_MS) return { status: 'debounced', sentAtMs: again };
      if (!runtime.write(sid, ESC)) fail(409, 'NOT_RUNNING', 'The session is not running on this computer.');
      const at = now();
      lastEsc.set(sid, at);
      phoneEsc.set(sid, at);
      return { status: 'sent', sentAtMs: at };
    });
    if (reqId) done.set(sid + '|' + reqId, { at: now(), result });
    const a = ctx && ctx.mobile && ctx.mobile.audit;
    if (a && a.write) { try { a.write({ deviceId: who.deviceId, action: 'interrupt', sessionId: sid, detail: result.status, ok: true }); } catch (_) {} }
    return result;
  }

  return {
    interrupt,
    /** When a phone ESC (interrupt or dismiss) was last written, for Turn.stoppedBy. */
    lastPhoneEscAt: (sessionId) => phoneEsc.get(sessionId) || 0,
    /** A phone dismiss answer wrote an ESC. */
    notePhoneEsc(sessionId) { const t = now(); phoneEsc.set(sessionId, t); lastEsc.set(sessionId, t); },
  };
}

module.exports = { createInterrupts, DEBOUNCE_MS };
