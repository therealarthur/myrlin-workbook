/**
 * The phone's send path: the send guard, the server side queue, delivery
 * and confirmation (PROTOCOL.md 4.4.5 and 7).
 *
 * What: POST send stores a SendRecord (idempotent by clientMessageId),
 * publishes the provisional message, and a per session pump delivers queued
 * sends in order once every gate check passes (G1 to G8 on a screen no older
 * than 250 ms). Delivery writes the composed text as one bracketed paste,
 * waits 80 ms, re-reads the screen, and only then writes the submit as its
 * own write, so a dialog that opened in between receives nothing. A human
 * prompt record in the transcript whose text matches confirms the send and
 * replaces the provisional message. The queue persists to
 * <dataDir>/mobile/send-queue.json after every transition.
 *
 * Why: a phone message must never land in an open TUI dialog, never merge
 * into a desktop draft and never take the desktop pane's geometry (critic
 * F1, A7). The writes go straight to pty.write, like the scheduler's, never
 * through the terminal socket that claims size ownership (R02:191).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const { atomicWriteJson, readJson, mobileDir, truncateText, TEXT_TRUNC_STREAM, delay, warn } = require('./common');

const ESC = '\x1b';
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';
const SUBMIT_DELAY_MS = 80;
const GATE_TICK_MS = 250;
const NO_SCREEN_TICK_MS = 5000;
const PASTE_MODE_FAIL_MS = 10000;
const SEND_EXPIRE_MS = 24 * 60 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 60000;
const TYPING_GUARD_MS = 2000;
const CODEX_IMAGE_GAP_MS = 150;
const FINAL_KEEP_MS = 10 * 60 * 1000;
const QUEUE_MAX = 10;
const TEXT_MAX = 100000;
const ATTACHMENTS_MAX = 20;
const VIDEO_TRANSCRIPT_MAX = 20000;
const PREVIEW_MAX = 140;
const MATCH_CHARS = 200;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINAL_STATES = new Set(['confirmed', 'failed', 'cancelled']);
const HELD_STATES = new Set(['queued', 'writing']);

const FAIL_WORDS = {
  DIALOG_OPENED: 'Your message is in the input line on {pc} but was not sent, because a dialog opened.',
  SEND_EXPIRED: 'The message waited 24 hours and was not sent.',
  LAUNCH_FAILED: 'The session could not be started.',
  LAUNCH_TIMEOUT: 'The session did not become ready within a minute.',
  PASTE_MODE_OFF: 'The terminal on {pc} is not accepting pasted text.',
  SESSION_LIVE_ELSEWHERE: 'This session is open in a terminal on {pc}.',
  SESSION_READ_ONLY: 'This session can no longer be sent to from the phone.',
  WRITE_FAILED: 'The message could not be written to the session.',
  WRITE_INTERRUPTED: 'Workbook restarted while the message was being written.',
  SESSION_EXITED: 'The session ended before the message was sent.',
  CANCELLED_BY_USER: 'You cancelled this message.',
  DEVICE_REVOKED: 'This iPhone was removed from {pc}.',
  HANDED_OFF: 'This session was handed off.',
};

/**
 * Normalise text for the PTY (PROTOCOL.md 7.3 step 4).
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(PASTE_START).join('')
    .split(PASTE_END).join('')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/**
 * Text used to match a transcript prompt to a send: trimmed, LF only, first 200 chars.
 * @param {string} text
 * @param {string[]} [dropLines]
 * @returns {string}
 */
function matchKey(text, dropLines) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  if (dropLines && dropLines.length) t = t.split('\n').filter((l) => !dropLines.includes(l.trim())).join('\n');
  return t.trim().slice(0, MATCH_CHARS);
}

/**
 * Create the send queue.
 * @param {object} deps - {ctx, index, runtime, lazy: {turns, prompts, launch, uploads, audit}, now, timings}
 * @returns {object}
 */
function createSendQueue(deps) {
  const { ctx, index, runtime } = deps;
  const now = deps.now || Date.now;
  const T = Object.assign({ submitDelayMs: SUBMIT_DELAY_MS, gateTickMs: GATE_TICK_MS, noScreenTickMs: NO_SCREEN_TICK_MS, pasteModeFailMs: PASTE_MODE_FAIL_MS, expireMs: SEND_EXPIRE_MS, launchTimeoutMs: LAUNCH_TIMEOUT_MS, typingGuardMs: TYPING_GUARD_MS }, deps.timings || {});
  const lazy = deps.lazy || {};
  const file = path.join(mobileDir(ctx), 'send-queue.json');
  const records = new Map();
  const pumps = new Map();
  const wakers = new Map();
  const listeners = new Set();
  const hub = () => (ctx && ctx.mobile && ctx.mobile.hub) || null;
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };
  const pc = () => index.computerName();

  // ── Persistence ──
  const saved = readJson(file, { records: [] }) || { records: [] };
  for (const r of Array.isArray(saved.records) ? saved.records : []) {
    if (!r || !r.clientMessageId || !r.sessionId) continue;
    if (r.state === 'writing') { r.state = 'failed'; r.error = errorOf('WRITE_INTERRUPTED'); r.reason = null; }
    records.set(key(r.sessionId, r.clientMessageId), r);
  }

  function key(sessionId, cmid) { return sessionId + '|' + cmid; }

  function errorOf(code) {
    return { code, error: (FAIL_WORDS[code] || 'The message was not sent.').replace('{pc}', pc()) };
  }

  function persist() {
    const t = now();
    const keep = [];
    for (const r of records.values()) {
      if (FINAL_STATES.has(r.state) && t - (r.finalAtMs || r.queuedAtMs) > FINAL_KEEP_MS) continue;
      keep.push(r);
    }
    try { atomicWriteJson(file, { v: 1, records: keep }); } catch (err) { warn('send queue persist failed', err && err.message); }
  }

  /**
   * The public SendRecord.
   * @param {object} r
   * @returns {object}
   */
  function pubRecord(r) {
    const queue = queueOf(r.sessionId).filter((x) => x.state === 'queued');
    const pos = r.state === 'queued' ? queue.indexOf(r) + 1 : null;
    return {
      clientMessageId: r.clientMessageId,
      sessionId: r.sessionId,
      deviceId: r.deviceId,
      state: r.state,
      reason: r.state === 'queued' ? (r.reason || 'busy') : null,
      position: pos && pos > 0 ? pos : null,
      textPreview: String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX),
      attachmentCount: (r.attachments || []).length,
      queuedAtMs: r.queuedAtMs,
      writtenAtMs: r.writtenAtMs || null,
      deliveredAtMs: r.deliveredAtMs || null,
      confirmedAtMs: r.confirmedAtMs || null,
      messageId: r.messageId || null,
      error: r.error || null,
    };
  }

  /** Records of a session in queue order. */
  function queueOf(sessionId) {
    return Array.from(records.values()).filter((r) => r.sessionId === sessionId).sort((a, b) => a.queuedAtMs - b.queuedAtMs || (a.seqNo || 0) - (b.seqNo || 0));
  }

  /**
   * Publish send.update and persist.
   * @param {object} r
   */
  function transition(r) {
    if (FINAL_STATES.has(r.state) && !r.finalAtMs) r.finalAtMs = now();
    persist();
    const h = hub();
    if (h && !r.system) {
      try { h.publish('session:' + r.sessionId, 'send.update', { send: pubRecord(r) }); } catch (_) {}
    }
    const turns = lazy.turns && lazy.turns();
    if (turns && turns.refresh) turns.refresh(r.sessionId);
    for (const fn of listeners) { try { fn(pubRecord(r), r); } catch (_) {} }
  }

  /**
   * Attachment refs of a record (PROTOCOL.md 3.6).
   * @param {object} r
   * @returns {object[]}
   */
  function attachmentRefs(r) {
    return (r.attachments || []).map((a) => ({
      uploadId: a.uploadId, kind: a.role, mediaType: a.mediaType || null, byteSize: Number.isFinite(a.byteSize) ? a.byteSize : null,
      width: Number.isFinite(a.width) ? a.width : null, height: Number.isFinite(a.height) ? a.height : null,
      durationMs: Number.isFinite(a.durationMs) ? a.durationMs : null, contentPath: '/uploads/' + a.uploadId + '/content',
    }));
  }

  /**
   * The provisional message of a send.
   * @param {object} r
   * @returns {object}
   */
  function provisional(r) {
    const t = truncateText(r.text || '', TEXT_TRUNC_STREAM);
    return {
      id: 'pm_' + r.clientMessageId,
      sessionId: r.sessionId,
      turnId: null,
      role: 'user',
      ts: r.queuedAtMs,
      model: null,
      status: 'pending',
      origin: { kind: 'phone', deviceId: r.deviceId, clientMessageId: r.clientMessageId },
      parts: r.text ? [{ type: 'text', text: t.text, format: 'plain', truncated: t.truncated, fullLength: t.fullLength }] : [],
      attachments: attachmentRefs(r),
      usage: null,
      cursor: 'pm_' + r.clientMessageId,
    };
  }

  /**
   * Validate a send body; resolve attachments against uploads.
   * @param {object} body
   * @param {string} deviceId
   * @returns {{text: string, attachments: object[]}}
   */
  function validate(body, deviceId) {
    if (!body || typeof body !== 'object') fail(400, 'INVALID_JSON', 'The request body is not JSON.');
    if (typeof body.clientMessageId !== 'string' || !UUID_V4_RE.test(body.clientMessageId)) fail(400, 'INVALID_FIELD', 'clientMessageId must be a lowercase UUID v4.', { field: 'clientMessageId' });
    const text = body.text === undefined || body.text === null ? '' : body.text;
    if (typeof text !== 'string') fail(400, 'INVALID_FIELD', 'text must be a string.', { field: 'text' });
    if (text.length > TEXT_MAX) fail(413, 'TEXT_TOO_LONG', 'The message is longer than 100,000 characters.');
    const atts = body.attachments === undefined || body.attachments === null ? [] : body.attachments;
    if (!Array.isArray(atts) || atts.length > ATTACHMENTS_MAX) fail(400, 'INVALID_FIELD', 'attachments must be a list of at most 20.', { field: 'attachments' });
    if (!text.trim() && atts.length === 0) fail(422, 'NOTHING_TO_SEND', 'There is nothing to send.');
    const uploads = lazy.uploads && lazy.uploads();
    const resolved = atts.map((a, i) => {
      if (!a || typeof a.uploadId !== 'string' || !['image', 'video', 'keyframe'].includes(a.role)) fail(400, 'INVALID_FIELD', 'Each attachment needs an uploadId and a role.', { field: 'attachments[' + i + ']' });
      if (a.transcript !== undefined && a.transcript !== null) {
        if (a.role !== 'video') fail(400, 'INVALID_FIELD', 'Only a video attachment may carry a transcript.', { field: 'attachments[' + i + '].transcript' });
        if (typeof a.transcript !== 'string' || a.transcript.length > VIDEO_TRANSCRIPT_MAX) fail(400, 'INVALID_FIELD', 'A video transcript is at most 20,000 characters.', { field: 'attachments[' + i + '].transcript' });
      }
      const up = uploads ? uploads.getOwned(a.uploadId, deviceId) : null;
      if (!up) fail(404, 'UPLOAD_NOT_FOUND', 'That upload does not exist on this computer.');
      if (up.state !== 'ready' || !up.path) fail(409, 'UPLOAD_NOT_READY', 'That upload has not finished.');
      return { uploadId: a.uploadId, role: a.role, transcript: a.transcript || null, path: up.path, mediaType: up.mediaType, byteSize: up.totalBytes, width: up.width, height: up.height, durationMs: up.durationMs };
    });
    return { text, attachments: resolved };
  }

  /**
   * The read only answer for owners the phone cannot send to (PROTOCOL.md 9.2).
   * @param {object} ref
   */
  function assertWritable(ref) {
    if (['external', 'chatgpt', 'handedOff'].includes(ref.owner)) {
      const meta = index.meta(ref.sessionId);
      fail(409, 'SESSION_READ_ONLY', (meta && meta.readOnlyReason) || 'This session is read only on the phone.', { owner: ref.owner, reason: (meta && meta.readOnlyReason) || null });
    }
  }

  /**
   * Accept a phone send (POST /sessions/:sessionId/send).
   * @param {string} sessionId
   * @param {object} body
   * @param {{deviceId: string, reason?: string}} who
   * @returns {{status: number, send: object}}
   */
  function accept(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    const sid = ref.sessionId;
    if (body && typeof body.clientMessageId === 'string') {
      const existing = records.get(key(sid, body.clientMessageId));
      if (existing) return { status: 200, send: pubRecord(existing) };
    }
    assertWritable(ref);
    const v = validate(body, who.deviceId);
    const queued = queueOf(sid).filter((r) => r.state === 'queued').length;
    if (queued >= QUEUE_MAX) fail(409, 'SEND_QUEUE_FULL', 'Ten messages are already waiting for this session.');
    const r = {
      clientMessageId: body.clientMessageId,
      sessionId: sid,
      deviceId: who.deviceId,
      state: 'queued',
      reason: who.reason || 'busy',
      text: v.text,
      attachments: v.attachments,
      provider: ref.provider,
      queuedAtMs: now(),
      seqNo: records.size,
      writtenAtMs: null,
      deliveredAtMs: null,
      confirmedAtMs: null,
      messageId: null,
      error: null,
    };
    records.set(key(sid, r.clientMessageId), r);
    persist();
    const h = hub();
    if (h) {
      try { h.publish('session:' + sid, 'message.add', { message: provisional(r) }); } catch (_) {}
    }
    transition(r);
    audit(who.deviceId, 'send', sid, 'queued', true);
    pump(sid);
    return { status: 202, send: pubRecord(r) };
  }

  /**
   * A system send (B3 migration kickoff and approval messages); same gate.
   * @param {string} sessionId
   * @param {string} text
   * @param {{origin: string}} o
   * @returns {Promise<object>}
   */
  async function enqueueSystem(sessionId, text, o = {}) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    const cmid = require('crypto').randomUUID();
    const r = { clientMessageId: cmid, sessionId: ref.sessionId, deviceId: null, system: true, origin: o.origin || 'migration', state: 'queued', reason: 'starting', text: String(text || ''), attachments: [], provider: ref.provider, queuedAtMs: now(), seqNo: records.size, writtenAtMs: null, deliveredAtMs: null, confirmedAtMs: null, messageId: null, error: null };
    records.set(key(r.sessionId, cmid), r);
    transition(r);
    pump(r.sessionId);
    return pubRecord(r);
  }

  function audit(deviceId, action, sessionId, detail, ok) {
    const a = ctx && ctx.mobile && ctx.mobile.audit;
    if (a && typeof a.write === 'function') { try { a.write({ deviceId, action, sessionId, detail, ok }); } catch (_) {} }
  }

  /**
   * Finish a record as failed or cancelled.
   * @param {object} r
   * @param {'failed'|'cancelled'} state
   * @param {string} code
   */
  function finish(r, state, code) {
    r.state = state;
    r.reason = null;
    r.error = errorOf(code);
    transition(r);
  }

  /**
   * Wake a session's pump early (screen or state change).
   * @param {string} sessionId
   */
  function wake(sessionId) {
    const w = wakers.get(sessionId);
    if (w) { wakers.delete(sessionId); w(); }
  }

  /**
   * Sleep until woken or the timeout.
   * @param {string} sessionId
   * @param {number} ms
   */
  function waitWake(sessionId, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { wakers.delete(sessionId); resolve(); }, ms);
      if (t.unref) t.unref();
      wakers.set(sessionId, () => { clearTimeout(t); resolve(); });
    });
  }

  /**
   * The first failing gate check (PROTOCOL.md 7.2), or null when the send may be written.
   * @param {object} r
   * @param {object|null} screen - freshScreen() result
   * @returns {string|null} reason
   */
  function gate(r, screen) {
    const turns = lazy.turns && lazy.turns();
    const prompts = lazy.prompts && lazy.prompts();
    const pty = runtime.ptyOf(r.sessionId);
    if (!screen) return 'screenUnknown';
    const cls = screen.cls;
    if ((prompts && prompts.openFor(r.sessionId).length) || cls.kind === 'prompt') return 'promptOpen';
    if (cls.kind === 'unknownModal') return 'promptOpen';
    if (cls.input && cls.input.inputText) return 'desktopDraft';
    if (pty && pty.lastDesktopInputAt && now() - pty.lastDesktopInputAt < T.typingGuardMs) return 'desktopTyping';
    // A delivered send that has not started its turn yet still owns the input line.
    if (queueOf(r.sessionId).some((x) => x !== r && x.state === 'delivered' && !x.turnStarted && now() - x.deliveredAtMs < 3000)) return 'busy';
    if ((turns && turns.isTurnOpen(r.sessionId)) || cls.busy) return 'busy';
    if (cls.kind !== 'idlePrompt') return 'screenUnknown';
    if (runtime.bracketedPaste(r.sessionId) === false) return 'pasteModeOff';
    return null;
  }

  /**
   * The degraded gate without a screen model (PROTOCOL.md 7.6).
   * @param {object} r
   * @returns {Promise<string|null>}
   */
  async function gateNoScreen(r) {
    const turns = lazy.turns && lazy.turns();
    const pty = runtime.ptyOf(r.sessionId);
    if (turns && turns.isTurnOpen(r.sessionId)) return 'busy';
    if (pty && pty.lastDesktopInputAt && now() - pty.lastDesktopInputAt < T.typingGuardMs) return 'desktopTyping';
    if (r.provider === 'claude' && lazy.agents) { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const ag = lazy.agents();
      const ref = index.resolve(r.sessionId);
      if (ag && ref && ref.upstreamId) {
        const l = await ag.onDemand();
        const e = l && (l.entries || []).find((x) => String(x.sessionId).toLowerCase() === String(ref.upstreamId).toLowerCase());
        if (!e || e.status !== 'idle' || e.waitingFor) return 'screenUnknown';
      }
    }
    return null;
  }

  /**
   * Compose the bytes to paste (PROTOCOL.md 7.3 step 4).
   * @param {object} r
   * @returns {{pastes: string[], text: string, attachmentLines: string[]}}
   */
  function compose(r) {
    const text = sanitize(r.text);
    const atts = r.attachments || [];
    const lines = [];
    const pre = [];
    const videoBlocks = [];
    const keyframes = atts.filter((a) => a.role === 'keyframe');
    for (const a of atts) {
      if (a.role === 'video') {
        let block = 'Video file: ' + a.path;
        if (a.transcript) block += "\n\nTranscript of the video's audio, made on the iPhone:\n" + sanitize(a.transcript);
        videoBlocks.push(block);
      }
    }
    if (r.provider === 'codex') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      for (const a of atts) if (a.role === 'image' || a.role === 'keyframe') pre.push(a.path);
      let body = text;
      if (videoBlocks.length) body = (body ? body + '\n\n' : '') + videoBlocks.join('\n\n');
      if (keyframes.length) body = (body ? body + '\n\n' : '') + 'Frames from the video, in order:';
      return { pastes: pre.concat([body]), text: body, attachmentLines: pre.concat(videoBlocks.join('\n').split('\n')).map((l) => l.trim()).filter(Boolean) };
    }
    for (const a of atts) if (a.role === 'image') lines.push(a.path);
    const tail = [];
    if (lines.length) tail.push(lines.join('\n'));
    if (videoBlocks.length) tail.push(videoBlocks.join('\n\n'));
    if (keyframes.length) tail.push('Frames from the video, in order:\n' + keyframes.map((k) => k.path).join('\n'));
    const body = tail.length ? (text ? text + '\n\n' : '') + tail.join('\n\n') : text;
    const attachmentLines = tail.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
    return { pastes: [body], text: body, attachmentLines };
  }

  /**
   * Deliver one send (PROTOCOL.md 7.3 steps 5 to 7) under the session lock.
   * @param {object} r
   */
  async function deliver(r) {
    const c = compose(r);
    r.attachmentLines = c.attachmentLines;
    r.state = 'writing';
    r.reason = null;
    r.writtenAtMs = now();
    transition(r);
    try {
      for (let i = 0; i < c.pastes.length; i++) {
        if (!runtime.write(r.sessionId, PASTE_START + c.pastes[i] + PASTE_END)) return finish(r, 'failed', 'SESSION_EXITED');
        if (i < c.pastes.length - 1) await delay(CODEX_IMAGE_GAP_MS);
      }
    } catch (_) {
      return finish(r, 'failed', 'WRITE_FAILED');
    }
    await delay(T.submitDelayMs);
    const screen = runtime.hasScreen(r.sessionId) ? await runtime.freshScreen(r.sessionId, 0) : null;
    const prompts = lazy.prompts && lazy.prompts();
    if (screen && (screen.cls.kind === 'prompt' || screen.cls.kind === 'unknownModal' || (prompts && prompts.openFor(r.sessionId).length))) {
      return finish(r, 'failed', 'DIALOG_OPENED');
    }
    try {
      if (!runtime.write(r.sessionId, '\r')) return finish(r, 'failed', 'SESSION_EXITED');
    } catch (_) {
      return finish(r, 'failed', 'WRITE_FAILED');
    }
    r.state = 'delivered';
    r.deliveredAtMs = now();
    transition(r);
  }

  /**
   * Make sure the session has an owner that can take input (step 2).
   * @param {object} r
   * @returns {Promise<boolean>} false when the record was failed
   */
  async function own(r) {
    const ref = index.resolve(r.sessionId);
    if (!ref) { finish(r, 'failed', 'SESSION_EXITED'); return false; }
    if (ref.owner === 'handedOff') { finish(r, 'cancelled', 'HANDED_OFF'); return false; }
    if (ref.owner === 'external' || ref.owner === 'chatgpt') { finish(r, 'failed', 'SESSION_READ_ONLY'); return false; }
    if (ref.owner === 'workbook') return true;
    const launch = lazy.launch && lazy.launch();
    if (!launch) { finish(r, 'failed', 'LAUNCH_FAILED'); return false; }
    r.reason = 'starting';
    transition(r);
    let res;
    try { res = await launch.start(r.sessionId, { reason: 'send' }); } catch (_) { res = { status: 'refused', code: 'LAUNCH_FAILED' }; }
    if (res.status === 'refused') { finish(r, 'failed', res.code === 'SESSION_LIVE_ELSEWHERE' ? 'SESSION_LIVE_ELSEWHERE' : 'LAUNCH_FAILED'); return false; }
    const start = now();
    while (now() - start < T.launchTimeoutMs) {
      if (!runtime.hasScreen(r.sessionId)) {
        if (runtime.ptyOf(r.sessionId)) return true;
      } else {
        const s = await runtime.freshScreen(r.sessionId, 0);
        if (s && s.cls.kind === 'idlePrompt') return true;
      }
      await waitWake(r.sessionId, T.gateTickMs);
    }
    finish(r, 'failed', 'LAUNCH_TIMEOUT');
    return false;
  }

  /**
   * The per session delivery loop.
   * @param {string} sessionId
   */
  function pump(sessionId) {
    if (pumps.has(sessionId)) { wake(sessionId); return; }
    const run = (async () => {
      for (;;) {
        const q = queueOf(sessionId).filter((r) => r.state === 'queued');
        if (!q.length) return;
        const head = q[0];
        for (const other of q.slice(1)) {
          if (other.reason !== 'behindEarlier' && other.reason !== 'starting') { other.reason = 'behindEarlier'; transition(other); }
        }
        if (now() - head.queuedAtMs > T.expireMs) { finish(head, 'failed', 'SEND_EXPIRED'); continue; }
        if (!(await own(head))) continue;
        let reason;
        let screen = null;
        if (runtime.hasScreen(sessionId)) {
          screen = await runtime.freshScreen(sessionId, 250);
          reason = gate(head, screen);
        } else {
          reason = await gateNoScreen(head);
        }
        if (reason === 'pasteModeOff') {
          head._pasteOffSince = head._pasteOffSince || now();
          if (now() - head._pasteOffSince >= T.pasteModeFailMs) { finish(head, 'failed', 'PASTE_MODE_OFF'); continue; }
        } else {
          head._pasteOffSince = 0;
        }
        if (reason) {
          if (head.reason !== reason) { head.reason = reason; transition(head); }
          await waitWake(sessionId, runtime.hasScreen(sessionId) ? T.gateTickMs : T.noScreenTickMs);
          continue;
        }
        await runtime.withLock(sessionId, async () => {
          if (head.state !== 'queued') return;
          const s2 = runtime.hasScreen(sessionId) ? await runtime.freshScreen(sessionId, 250) : null;
          if (s2 && gate(head, s2)) return;
          await deliver(head);
        });
      }
    })().catch((err) => warn('send pump failed', err && err.message)).finally(() => { pumps.delete(sessionId); });
    pumps.set(sessionId, run);
  }

  /**
   * A human prompt message arrived in the transcript: confirm the matching delivered send.
   * @param {string} sessionId
   * @param {object} msg - Message (user) built by the mapper
   * @returns {boolean} true when it replaced a provisional message
   */
  function onPromptMessage(sessionId, msg) {
    const text = msg.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const candidates = queueOf(sessionId).filter((r) => r.state === 'delivered');
    for (const r of candidates) {
      if (matchKey(text, r.attachmentLines) !== matchKey(sanitize(r.text), r.attachmentLines) && matchKey(text, r.attachmentLines) !== matchKey(compose(r).text, r.attachmentLines)) continue;
      r.state = 'confirmed';
      r.confirmedAtMs = now();
      r.messageId = msg.id;
      transition(r);
      if (r.system) {
        msg.origin = { kind: r.origin === 'migration' ? 'migration' : 'unknown', deviceId: null, clientMessageId: null };
        return false;
      }
      msg.origin = { kind: 'phone', deviceId: r.deviceId, clientMessageId: r.clientMessageId };
      msg.attachments = attachmentRefs(r);
      const h = hub();
      if (h) { try { h.publish('session:' + sessionId, 'message.update', { message: msg, replacesId: 'pm_' + r.clientMessageId }); } catch (_) {} }
      return true;
    }
    return false;
  }

  // Wake pumps on screen changes.
  if (runtime && runtime.onScreen) runtime.onScreen((sessionId) => { if (pumps.has(sessionId)) wake(sessionId); });

  // Restart pumps for sends that survived a restart.
  setImmediate(() => { for (const sid of new Set(Array.from(records.values()).filter((r) => r.state === 'queued').map((r) => r.sessionId))) pump(sid); });

  return {
    accept,
    enqueueSystem,
    /** GET /sessions/:sessionId/sends */
    list(sessionId) {
      const t = now();
      return queueOf(sessionId).filter((r) => !r.system && (!FINAL_STATES.has(r.state) || t - (r.finalAtMs || r.queuedAtMs) <= FINAL_KEEP_MS)).map(pubRecord);
    },
    /** SendRecords in queued, writing or delivered (session detail). */
    pending(sessionId) { return queueOf(sessionId).filter((r) => !r.system && ['queued', 'writing', 'delivered'].includes(r.state)).map(pubRecord); },
    /** DELETE /sessions/:sessionId/sends/:clientMessageId */
    cancel(sessionId, clientMessageId, deviceId) {
      const r = records.get(key(sessionId, clientMessageId));
      if (!r || r.system) fail(404, 'SEND_NOT_FOUND', 'That message does not exist.');
      if (r.deviceId !== deviceId) fail(403, 'NOT_YOUR_SEND', 'Another device sent that message.');
      if (r.state !== 'queued') fail(409, 'SEND_NOT_CANCELLABLE', 'That message is already being written.');
      finish(r, 'cancelled', 'CANCELLED_BY_USER');
      wake(sessionId);
      return pubRecord(r);
    },
    /** Revocation: cancel a device's queued sends. */
    cancelDevice(deviceId) {
      for (const r of records.values()) if (r.deviceId === deviceId && r.state === 'queued') finish(r, 'cancelled', 'DEVICE_REVOKED');
    },
    /** Hand off: cancel queued sends of a session. */
    cancelSession(sessionId, code) {
      for (const r of queueOf(sessionId)) if (r.state === 'queued') finish(r, 'cancelled', code || 'HANDED_OFF');
    },
    heldCount(sessionId) { return queueOf(sessionId).filter((r) => HELD_STATES.has(r.state)).length; },
    deliveredWithoutTurn(sessionId, windowMs) {
      return queueOf(sessionId).some((r) => r.state === 'delivered' && now() - r.deliveredAtMs <= windowMs && !r.turnStarted);
    },
    onTurnStart(sessionId) { for (const r of queueOf(sessionId)) if (r.state === 'delivered' || r.state === 'confirmed') r.turnStarted = true; },
    onPromptMessage,
    originForMessage(sessionId, messageId) {
      const r = queueOf(sessionId).find((x) => x.messageId === messageId);
      if (!r) return null;
      if (r.system) return { kind: r.origin === 'migration' ? 'migration' : 'unknown', deviceId: null, clientMessageId: null };
      return { kind: 'phone', deviceId: r.deviceId, clientMessageId: r.clientMessageId };
    },
    attachmentsForMessage(sessionId, messageId) { const r = queueOf(sessionId).find((x) => x.messageId === messageId); return r ? attachmentRefs(r) : null; },
    usesUpload(uploadId) { return Array.from(records.values()).some((r) => (r.attachments || []).some((a) => a.uploadId === uploadId) && ['delivered', 'confirmed', 'writing'].includes(r.state)); },
    pump,
    wake,
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _records: records,
    _compose: compose,
  };
}

module.exports = { createSendQueue, sanitize, matchKey, PASTE_START, PASTE_END, SUBMIT_DELAY_MS, QUEUE_MAX, FAIL_WORDS };
