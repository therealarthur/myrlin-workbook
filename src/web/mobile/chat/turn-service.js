/**
 * The turn state service for the mobile v2 chat (PROTOCOL.md 6).
 *
 * What: per watched session, a byte offset tailer over the transcript (own
 * tailers, at most 24, never the mirror service's), the Claude rules C1 to
 * C7 and the Codex rules X1 to X7, the SessionState evaluation of 6.2, and
 * the stream events they produce: session.state (coalesced to 4 per second),
 * turn.start, turn.end, message.add, message.update, tool.start, tool.end.
 * It also takes the screen classification (prompt service) and the shared
 * `claude agents` listing as signals.
 *
 * Why: the phone never infers state from timing. Only an explicit end signal
 * (turn_duration, task_complete, an interrupt marker, a process exit) or two
 * independent idle signals held over time end a turn (R04:204, critic F6:
 * Stop is never used because a blocking Stop hook continues the turn).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { TEXT_TRUNC_STREAM, warn } = require('./common');
const reader = require('./transcript-reader');
const claudeMsg = require('./claude-messages');
const { createClaudeMapper } = claudeMsg;
const { createCodexMapper } = require('./codex-messages');
const { isSleepingBackground } = require('./agents-poller');

const MAX_TAILERS = 24;
const TAIL_DEBOUNCE_MS = 200;
const TAIL_POLL_MS = 2000;
const INITIAL_SCAN_BYTES = 4 * 1024 * 1024;
const STATE_MIN_INTERVAL_MS = 250;
const UPDATE_MIN_INTERVAL_MS = 250;
const QUEUED_AFTER_DELIVERY_MS = 3000;
const IDLE_CONFIRM_SPAN_MS = 6000;
const IDLE_CONFIRM_READS = 3;
const IDLE_GRACE_MS = 30000;
const API_ERROR_IDLE_MS = 10000;
const NO_ACTIVITY_MS = 10 * 60 * 1000;
const STOPPED_BY_PHONE_WINDOW_MS = 5000;
/** X3 fallback (PROTOCOL.md 6.3): idle composer this long after a phone ESC with no end marker. */
const CODEX_INTERRUPT_FALLBACK_MS = 5000;
const CHECK_TICK_MS = 1000;
const USAGE_LIMIT_RE = /usage limit|rate limit|limit reached|limit will reset|resets? (at|in)/i;

/**
 * The cause phrase of a failed turn (PROTOCOL.md 3.5 Turn.error).
 * @param {string} text
 * @returns {{code: string, error: string}}
 */
function apiErrorOf(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (USAGE_LIMIT_RE.test(t)) return { code: 'USAGE_LIMIT', error: 'the usage limit was reached' + (/(reset[^.]*)/i.test(t) ? ', ' + /(reset[^.]*)/i.exec(t)[1].toLowerCase() : '') };
  const short = t.replace(/^API Error:?\s*/i, '').replace(/[.]+$/, '');
  return { code: 'API_ERROR', error: 'the API answered ' + (short ? short.slice(0, 120).replace(/^./, (c) => c.toLowerCase()) : 'with an error') };
}

/**
 * Create the turn service.
 * @param {object} deps
 * @returns {object}
 */
function createTurnService(deps) {
  const { ctx, index, agents } = deps;
  const now = deps.now || Date.now;
  const lazy = deps.lazy || {};
  const watchers = new Map();
  const turnListeners = new Set();
  const stateListeners = new Set();
  const lastStates = new Map();
  const claudeMapper = createClaudeMapper();
  const codexMapper = createCodexMapper();
  let tick = null;

  const hub = () => (ctx && ctx.mobile && ctx.mobile.hub) || null;
  const sends = () => (lazy.sends ? lazy.sends() : null);
  const prompts = () => (lazy.prompts ? lazy.prompts() : null);
  const interrupts = () => (lazy.interrupts ? lazy.interrupts() : null);

  /**
   * Publish on a session topic.
   * @param {string} sessionId
   * @param {string} type
   * @param {object} data
   */
  function pub(sessionId, type, data) {
    const h = hub();
    if (!h) return;
    try { h.publish('session:' + sessionId, type, data); } catch (err) { warn('publish failed', type, err && err.message); }
  }

  /**
   * Mapper context for stream messages of a watcher.
   * @param {object} w
   * @returns {object}
   */
  function mctx(w) {
    return {
      sessionId: w.sessionId,
      truncateAt: TEXT_TRUNC_STREAM,
      originFor: (rec, id) => originFor(w, rec, id),
    };
  }

  /**
   * Origin of a human prompt record.
   * @param {object} w
   * @param {object} rec
   * @param {string} id
   * @returns {object}
   */
  function originFor(w, rec, id) {
    const s = sends();
    const hit = s && s.originForMessage ? s.originForMessage(w.sessionId, id) : null;
    if (hit) return hit;
    if (w.migrationKickoff && w.migrationKickoff(rec)) return { kind: 'migration', deviceId: null, clientMessageId: null };
    const ref = index.resolve(w.sessionId);
    return { kind: ref && ref.owner === 'workbook' ? 'desktop' : 'terminal', deviceId: null, clientMessageId: null };
  }

  /**
   * A new empty watcher for a session.
   * @param {object} ref
   * @returns {object}
   */
  function newWatcher(ref) {
    return {
      sessionId: ref.sessionId,
      provider: ref.provider,
      upstreamId: ref.upstreamId,
      workbookSessionId: ref.workbookSessionId,
      file: null,
      tag: null,
      offset: 0,
      reasons: new Set(),
      subscribers: 0,
      lastUsedAt: now(),
      turn: null,
      lastTurn: null,
      openTools: new Map(),
      lastRecordAt: 0,
      lastAssistant: null,
      pendingUpdate: null,
      c1aAt: 0,
      screen: null,
      screenIdleSince: 0,
      screenIdleReads: 0,
      idleConfirmedAt: 0,
      agentsIdle: [],
      permissionMode: null,
      model: null,
      effort: null,
      formatDrift: false,
      unwatchAgents: null,
      fsw: null,
      debounce: null,
      poll: null,
      exited: false,
      exitCode: null,
    };
  }

  // ── State evaluation (PROTOCOL.md 6.2) ────────────────────────────────

  /**
   * Compute a watcher's SessionState.
   * @param {object} w
   * @returns {object}
   */
  function evaluate(w) {
    const ref = index.resolve(w.sessionId);
    const owner = ref ? ref.owner : 'none';
    const s = sends();
    const queuedSends = s && s.heldCount ? s.heldCount(w.sessionId) : 0;
    const promptList = prompts() ? prompts().openFor(w.sessionId) : [];
    const p = promptList[0] || null;
    let state = 'idle';
    let toolName = null;
    let detail = null;
    let source = 'none';
    const agentEntry = agents && w.provider === 'claude' && w.upstreamId && (owner === 'external' || owner === 'background') ? agents.entryFor(w.upstreamId) : null; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    if (p && (p.kind === 'approval' || p.kind === 'plan')) {
      state = 'needsApproval'; detail = p.title; toolName = p.toolName || null; source = 'screen';
    } else if (p) {
      state = 'needsAnswer'; detail = p.title; toolName = p.toolName || null; source = 'screen';
    } else if (w.screen && w.screen.kind === 'unknownModal') {
      state = 'needsAnswer'; detail = 'A dialog is open on ' + index.computerName(); source = 'screen';
    } else if (agentEntry && /permission prompt|sandbox request|worker request/i.test(agentEntry.waitingFor || '')) {
      state = 'needsApproval'; detail = 'Answer on ' + index.computerName(); source = 'agents';
    } else if (agentEntry && /input needed|dialog open/i.test(agentEntry.waitingFor || '')) {
      state = 'needsAnswer'; detail = 'Answer on ' + index.computerName(); source = 'agents';
    } else if (w.turn) {
      const tools = Array.from(w.openTools.values());
      if (tools.length) {
        const t = tools[tools.length - 1];
        state = 'working'; toolName = t.name; detail = t.detail || t.title; source = w.provider === 'codex' ? 'rollout' : 'transcript'; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      } else {
        state = 'thinking'; source = w.provider === 'codex' ? 'rollout' : 'transcript'; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      }
      if (now() - Math.max(w.lastRecordAt, w.turn.startedAtMs) >= NO_ACTIVITY_MS) detail = 'No activity for 10 minutes';
    } else if (w.c1aAt && now() - w.c1aAt < QUEUED_AFTER_DELIVERY_MS * 20) {
      state = 'thinking'; source = 'screen';
    } else if (owner === 'none' && w.provider === 'claude' && isSleeping(w)) { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      state = 'sleeping'; source = 'agents';
    } else if (w.lastTurn && w.lastTurn.status === 'interrupted') {
      state = 'interrupted'; source = w.provider === 'codex' ? 'rollout' : 'transcript'; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    } else if (w.lastTurn && w.lastTurn.status === 'failed') {
      state = 'failed'; detail = w.lastTurn.error ? w.lastTurn.error.error : null; source = w.lastTurn.endSource === 'processExit' ? 'process' : 'transcript';
    } else if (queuedSends > 0 || (s && s.deliveredWithoutTurn && s.deliveredWithoutTurn(w.sessionId, QUEUED_AFTER_DELIVERY_MS))) {
      state = 'queued'; source = 'none';
    }
    const prev = lastStates.get(w.sessionId);
    const enteredAtMs = prev && prev.state === state ? prev.enteredAtMs : now();
    return {
      sessionId: w.sessionId,
      state,
      enteredAtMs,
      turnId: w.turn ? w.turn.turnId : null,
      turnStartedAtMs: w.turn ? w.turn.startedAtMs : null,
      toolName,
      detail,
      source,
      lastActivityAtMs: w.lastRecordAt || null,
      queuedSends,
      estimatedThinkingTokens: null,
    };
  }

  /**
   * Whether a Claude session was a background session the supervisor reaped (rule 6).
   * Measured on 2.1.283 (claude-2.1.283-live-evidence.json, rule6): a background
   * entry without pid and status is asleep; one that left the listing is asleep
   * when the poller or the desktop gate saw it running in the background.
   * @param {object} w
   * @returns {boolean}
   */
  function isSleeping(w) {
    const e = agents && w.upstreamId && agents.entryFor ? agents.entryFor(w.upstreamId) : null;
    if (e) return isSleepingBackground(e);
    if (agents && w.upstreamId && typeof agents.wasBackground === 'function' && agents.wasBackground(w.upstreamId)) return true;
    try {
      const lookup = require('../../../providers/claude/live-sessions').getDefaultLookup();
      const marker = lookup && lookup.seenStore && lookup.seenStore.get ? lookup.seenStore.get(w.upstreamId) : null;
      return !!(marker && marker.kind === 'background');
    } catch (_) { return false; }
  }

  /**
   * Re-evaluate and publish session.state when it changed (4 per second at most).
   * @param {object} w
   */
  function refresh(w) {
    const st = evaluate(w);
    const prev = lastStates.get(w.sessionId);
    const changed = !prev || prev.state !== st.state || prev.turnId !== st.turnId || prev.toolName !== st.toolName || prev.detail !== st.detail || prev.queuedSends !== st.queuedSends;
    lastStates.set(w.sessionId, st);
    if (!changed) return;
    const doPublish = () => {
      w.stateTimer = null;
      const latest = lastStates.get(w.sessionId);
      w.statePublishedAt = now();
      pub(w.sessionId, 'session.state', latest);
      index.noteChanged(w.sessionId, 'updated');
      for (const fn of stateListeners) {
        try { fn(latest, prev || null); } catch (_) { /* listener errors are theirs */ }
      }
    };
    const since = now() - (w.statePublishedAt || 0);
    if (since >= STATE_MIN_INTERVAL_MS) doPublish();
    else if (!w.stateTimer) {
      w.stateTimer = setTimeout(doPublish, STATE_MIN_INTERVAL_MS - since);
      if (w.stateTimer.unref) w.stateTimer.unref();
    }
  }

  // ── Turns ─────────────────────────────────────────────────────────────

  /**
   * Open a turn (C1, X1).
   * @param {object} w
   * @param {string} turnId
   * @param {number} startedAtMs
   * @param {object} origin - {kind, deviceId, clientMessageId}
   */
  function startTurn(w, turnId, startedAtMs, origin) {
    if (w.turn && w.turn.turnId === turnId) return;
    if (w.turn) endTurn(w, 'completed', null, null, null);
    const src = origin && ['phone', 'desktop', 'terminal', 'scheduler', 'migration'].includes(origin.kind) ? origin.kind : 'unknown';
    w.turn = {
      sessionId: w.sessionId,
      turnId,
      source: src,
      deviceId: src === 'phone' ? origin.deviceId : null,
      clientMessageId: src === 'phone' ? origin.clientMessageId : null,
      startedAtMs: startedAtMs || now(),
      endedAtMs: null,
      status: 'running',
      durationMs: null,
      endSource: null,
      stoppedBy: null,
      error: null,
      _failed: null,
    };
    w.c1aAt = 0;
    w.idleConfirmedAt = 0;
    w.agentsIdle = [];
    w.lastTurn = null;
    const data = publicTurn(w.turn);
    pub(w.sessionId, 'turn.start', data);
    for (const fn of turnListeners) { try { fn(data); } catch (_) {} }
    const s = sends();
    if (s && s.onTurnStart) s.onTurnStart(w.sessionId, data);
  }

  /**
   * The Turn object as published (without private fields).
   * @param {object} t
   * @returns {object}
   */
  function publicTurn(t) {
    return {
      sessionId: t.sessionId, turnId: t.turnId, source: t.source, deviceId: t.deviceId, clientMessageId: t.clientMessageId,
      startedAtMs: t.startedAtMs, endedAtMs: t.endedAtMs, status: t.status, durationMs: t.durationMs,
      endSource: t.endSource, stoppedBy: t.stoppedBy, error: t.error,
    };
  }

  /**
   * Close the open turn (C2 to C7, X2 to X7).
   * @param {object} w
   * @param {'completed'|'interrupted'|'failed'} status
   * @param {string|null} endSource
   * @param {number|null} durationMs
   * @param {object|null} error
   * @param {{stoppedBy?: ('phone'|'desktop')}} [o] - who stopped an interrupted turn, when the caller knows
   */
  function endTurn(w, status, endSource, durationMs, error, o) {
    const t = w.turn;
    if (!t) return;
    const endedAtMs = now();
    let st = status;
    let err = error;
    if (st === 'completed' && t._failed) { st = 'failed'; err = t._failed; }
    t.status = st;
    t.endedAtMs = endedAtMs;
    t.durationMs = Number.isFinite(durationMs) ? durationMs : Math.max(0, endedAtMs - t.startedAtMs);
    t.endSource = endSource;
    t.error = st === 'failed' ? (err || { code: 'API_ERROR', error: 'the API answered with an error' }) : null;
    if (st === 'interrupted') {
      const i = interrupts();
      const escAt = i && i.lastPhoneEscAt ? i.lastPhoneEscAt(w.sessionId) : 0;
      t.stoppedBy = o && o.stoppedBy ? o.stoppedBy : (escAt && endedAtMs - escAt <= STOPPED_BY_PHONE_WINDOW_MS ? 'phone' : 'desktop');
    }
    for (const [id, tool] of w.openTools) {
      pub(w.sessionId, 'tool.end', { sessionId: w.sessionId, turnId: t.turnId, toolCallId: id, status: 'interrupted', durationMs: Math.max(0, endedAtMs - tool.startedAtMs), summary: null, exitCode: null, diffStat: null });
    }
    w.openTools.clear();
    w.lastTurn = t;
    w.turn = null;
    w.c1aAt = 0;
    const data = publicTurn(t);
    pub(w.sessionId, 'turn.end', data);
    for (const fn of turnListeners) { try { fn(data); } catch (_) {} }
  }

  // ── Records ───────────────────────────────────────────────────────────

  /**
   * Flush a coalesced message.update.
   * @param {object} w
   */
  function flushUpdate(w) {
    const pu = w.pendingUpdate;
    if (!pu) return;
    w.pendingUpdate = null;
    if (pu.timer) clearTimeout(pu.timer);
    pu.publishedAt = now();
    w.lastUpdateAt = pu.publishedAt;
    pub(w.sessionId, 'message.update', { message: pu.message, replacesId: null });
  }

  /**
   * Handle one parsed Claude record.
   * @param {object} w
   * @param {object} rec
   * @param {{offset: number, length: number}} line
   * @param {boolean} oversize
   */
  function onClaudeRecord(w, rec, line, oversize) {
    w.lastRecordAt = now();
    const frag = claudeMapper.fragment(rec, line, oversize);
    const cursorOf = (off) => reader.encodeCursor(w.tag, off);
    if (rec && rec.type === 'permission-mode' && rec.permissionMode && rec.permissionMode !== w.permissionMode) {
      w.permissionMode = rec.permissionMode;
      w.metaDirty = true;
    }
    if (rec && (rec.type === 'ai-title' || rec.type === 'custom-title')) { w.metaDirty = true; index.noteChanged(w.sessionId, 'updated'); }
    if (!frag) return;
    // Assistant blocks of one API message join one Message.
    if (frag.kind === 'assistant' && w.lastAssistant && w.lastAssistant.key === frag.key) {
      w.lastAssistant.frags.push(frag);
      const msg = claudeMapper.build(w.lastAssistant.frags, Object.assign({ cursor: cursorOf(w.lastAssistant.frags[0].offset) }, mctx(w)));
      if (msg && msg.model) w.model = msg.model;
      scheduleUpdate(w, msg);
      toolStarts(w, rec);
      return;
    }
    flushUpdate(w);
    w.lastAssistant = frag.kind === 'assistant' ? { key: frag.key, frags: [frag] } : null;
    const msg = claudeMapper.build([frag], Object.assign({ cursor: cursorOf(frag.offset) }, mctx(w)));
    switch (frag.kind) {
      case 'user': {
        const origin = msg ? msg.origin : { kind: 'unknown' };
        startTurn(w, 't_' + rec.uuid, claudeMsg.tsOf(rec) || now(), origin);
        if (msg) {
          msg.turnId = 't_' + rec.uuid;
          const s = sends();
          const consumed = s && s.onPromptMessage ? s.onPromptMessage(w.sessionId, msg, rec) : false;
          if (!consumed) pub(w.sessionId, 'message.add', { message: msg });
        }
        break;
      }
      case 'assistant':
        if (msg) { msg.turnId = w.turn ? w.turn.turnId : null; if (msg.model) w.model = msg.model; pub(w.sessionId, 'message.add', { message: msg }); }
        toolStarts(w, rec);
        break;
      case 'apiError':
        if (w.turn) { w.turn._failed = apiErrorOf(claudeMsg.contentText(rec.message && rec.message.content)); w.apiErrorAt = now(); }
        if (msg) { msg.turnId = w.turn ? w.turn.turnId : null; pub(w.sessionId, 'message.add', { message: msg }); }
        break;
      case 'tool':
        if (msg) { msg.turnId = w.turn ? w.turn.turnId : null; pub(w.sessionId, 'message.add', { message: msg }); }
        toolEnds(w, msg);
        break;
      case 'turnEnd':
        if (msg) { msg.turnId = w.turn ? w.turn.turnId : null; pub(w.sessionId, 'message.add', { message: msg }); }
        if (w.turn) endTurn(w, 'completed', 'turnDuration', Number.isFinite(rec.durationMs) ? rec.durationMs : null, null);
        break;
      case 'interrupted':
        if (msg) { msg.turnId = w.turn ? w.turn.turnId : null; pub(w.sessionId, 'message.add', { message: msg }); }
        if (w.turn) endTurn(w, 'interrupted', 'interruptMarker', null, null);
        break;
      default:
        if (msg) { msg.turnId = w.turn ? w.turn.turnId : null; pub(w.sessionId, 'message.add', { message: msg }); }
    }
  }

  /**
   * Queue a coalesced message.update for the growing assistant message.
   * @param {object} w
   * @param {object} msg
   */
  function scheduleUpdate(w, msg) {
    if (!msg) return;
    msg.turnId = w.turn ? w.turn.turnId : null;
    const since = now() - (w.lastUpdateAt || 0);
    if (!w.pendingUpdate) w.pendingUpdate = { message: msg, timer: null };
    else w.pendingUpdate.message = msg;
    if (since >= UPDATE_MIN_INTERVAL_MS) { flushUpdate(w); return; }
    if (!w.pendingUpdate.timer) {
      w.pendingUpdate.timer = setTimeout(() => flushUpdate(w), UPDATE_MIN_INTERVAL_MS - since);
      if (w.pendingUpdate.timer.unref) w.pendingUpdate.timer.unref();
    }
  }

  /**
   * tool.start for every tool_use block of a Claude assistant record.
   * @param {object} w
   * @param {object} rec
   */
  function toolStarts(w, rec) {
    const blocks = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use' || w.openTools.has(b.id)) continue;
      const part = claudeMsg.toolCallPart(b.id, b.name, b.input);
      const t = { name: part.name, kind: part.kind, title: part.title, detail: part.detail, startedAtMs: claudeMsg.tsOf(rec) || now(), diffStat: part.diffStat, input: b.input };
      w.openTools.set(b.id, t);
      pub(w.sessionId, 'tool.start', { sessionId: w.sessionId, turnId: w.turn ? w.turn.turnId : null, toolCallId: String(b.id), name: t.name, kind: t.kind, title: t.title, detail: t.detail, startedAtMs: t.startedAtMs });
    }
  }

  /**
   * tool.end for each toolResult part of a tool message.
   * @param {object} w
   * @param {object|null} msg
   */
  function toolEnds(w, msg) {
    if (!msg) return;
    for (const part of msg.parts) {
      if (part.type !== 'toolResult') continue;
      const t = w.openTools.get(part.toolCallId);
      w.openTools.delete(part.toolCallId);
      const durationMs = t ? Math.max(0, (msg.ts || now()) - t.startedAtMs) : null;
      let summary = null;
      if (part.exitCode !== null && part.exitCode !== undefined) summary = 'Exited with ' + part.exitCode;
      else if (t && t.diffStat) summary = '+' + t.diffStat.added + ' -' + t.diffStat.removed;
      else if (part.status === 'error') summary = 'Failed';
      pub(w.sessionId, 'tool.end', { sessionId: w.sessionId, turnId: w.turn ? w.turn.turnId : null, toolCallId: part.toolCallId, status: part.status, durationMs, summary, exitCode: part.exitCode, diffStat: t ? t.diffStat : null });
    }
  }

  /**
   * Handle one parsed Codex record.
   * @param {object} w
   * @param {object} rec
   * @param {{offset: number, length: number}} line
   * @param {boolean} oversize
   */
  function onCodexRecord(w, rec, line, oversize) {
    w.lastRecordAt = now();
    const p = (rec && rec.payload) || {};
    if (rec && rec.type === 'turn_context') {
      if (p.model && p.model !== w.model) { w.model = p.model; w.metaDirty = true; }
      if (p.sandbox_policy) { w.sandbox = typeof p.sandbox_policy === 'string' ? p.sandbox_policy : (p.sandbox_policy.mode || p.sandbox_policy.type || null); w.metaDirty = true; }
      if (p.approval_policy) { w.approvalPolicy = p.approval_policy; w.metaDirty = true; }
    }
    if (rec && rec.type === 'event_msg') {
      if (p.type === 'task_started') {
        startTurn(w, 't_' + (p.turn_id || ('o' + line.offset)), claudeMsg.tsOf(rec) || now(), w.pendingOrigin || { kind: 'unknown' });
        w.pendingOrigin = null;
      } else if (p.type === 'error' && w.turn) {
        w.turn._failed = apiErrorOf(p.message || '');
      } else if (p.type === 'token_count' && p.rate_limits && w.turn) {
        const rl = p.rate_limits;
        const full = [rl.primary, rl.secondary].some((x) => x && Number(x.used_percent) >= 100);
        if (full) w.turn._limit = true;
      }
    }
    const frag = codexMapper.fragment(rec, line, oversize);
    let msg = null;
    if (frag) {
      msg = codexMapper.build([frag], Object.assign({ cursor: reader.encodeCursor(w.tag, frag.offset) }, mctx(w)));
      if (msg) msg.turnId = w.turn ? w.turn.turnId : null;
    }
    if (frag && frag.kind === 'user' && msg) {
      const s = sends();
      if (!w.turn) w.pendingOrigin = msg.origin;
      const consumed = s && s.onPromptMessage ? s.onPromptMessage(w.sessionId, msg, rec) : false;
      if (!consumed) pub(w.sessionId, 'message.add', { message: msg });
    } else if (msg) {
      pub(w.sessionId, 'message.add', { message: msg });
    }
    if (frag && frag.kind === 'toolCall' && msg) {
      const part = msg.parts[0];
      w.openTools.set(part.toolCallId, { name: part.name, kind: part.kind, title: part.title, detail: part.detail, startedAtMs: msg.ts || now(), diffStat: part.diffStat, input: part.input });
      pub(w.sessionId, 'tool.start', { sessionId: w.sessionId, turnId: w.turn ? w.turn.turnId : null, toolCallId: part.toolCallId, name: part.name, kind: part.kind, title: part.title, detail: part.detail, startedAtMs: msg.ts || now() });
    }
    if (frag && frag.kind === 'toolOutput') toolEnds(w, msg);
    if (rec && rec.type === 'event_msg' && w.turn) {
      if (p.type === 'task_complete') {
        let err = null;
        if (w.turn._failed && w.turn._limit) err = { code: 'USAGE_LIMIT', error: 'the usage limit was reached' };
        endTurn(w, 'completed', 'taskComplete', Number.isFinite(p.duration_ms) ? p.duration_ms : null, err);
      } else if (p.type === 'turn_aborted') {
        endTurn(w, 'interrupted', 'turnAborted', null, null);
      }
    }
  }

  // ── Tailing ───────────────────────────────────────────────────────────

  /**
   * Find the open turn from the transcript tail when watching starts.
   * @param {object} w
   */
  function initialScan(w) {
    let fd;
    try {
      const size = fs.statSync(w.file).size;
      fd = fs.openSync(w.file, 'r');
      const limitOffset = Math.max(0, size - INITIAL_SCAN_BYTES);
      for (const line of reader.backwardLines(fd, size, null)) {
        if (line.offset < limitOffset) break;
        const { record } = reader.parseLine(line);
        if (!record) continue;
        if (w.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
          if (record.type === 'permission-mode' && !w.permissionMode) w.permissionMode = record.permissionMode || null;
          if (record.type === 'assistant' && record.message && record.message.model && !w.model) w.model = record.message.model;
          if (record.type === 'system' && record.subtype === 'turn_duration') break;
          if (claudeMsg.isInterruptMarker(record)) { w.lastTurn = { status: 'interrupted' }; break; }
          if (claudeMsg.isHumanPrompt(record)) {
            w.turn = { sessionId: w.sessionId, turnId: 't_' + record.uuid, source: 'unknown', deviceId: null, clientMessageId: null, startedAtMs: claudeMsg.tsOf(record) || now(), endedAtMs: null, status: 'running', durationMs: null, endSource: null, stoppedBy: null, error: null, _failed: null };
            break;
          }
          if (record.type === 'assistant' && record.message && Array.isArray(record.message.content)) {
            for (const b of record.message.content) if (b && b.type === 'tool_use') w._pendingToolScan = (w._pendingToolScan || []).concat([{ b, rec: record }]);
          }
          if (record.type === 'user' && record.message && Array.isArray(record.message.content)) {
            for (const b of record.message.content) if (b && b.type === 'tool_result') (w._doneTools = w._doneTools || new Set()).add(b.tool_use_id);
          }
        } else {
          const p = record.payload || {};
          if (record.type === 'turn_context' && p.model && !w.model) w.model = p.model;
          if (record.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) { if (p.type === 'turn_aborted') w.lastTurn = { status: 'interrupted' }; break; }
          if (record.type === 'event_msg' && p.type === 'task_started') {
            w.turn = { sessionId: w.sessionId, turnId: 't_' + (p.turn_id || 'o' + line.offset), source: 'unknown', deviceId: null, clientMessageId: null, startedAtMs: claudeMsg.tsOf(record) || now(), endedAtMs: null, status: 'running', durationMs: null, endSource: null, stoppedBy: null, error: null, _failed: null };
            break;
          }
        }
      }
      if (w.turn && w._pendingToolScan) {
        for (const { b, rec } of w._pendingToolScan) {
          if (w._doneTools && w._doneTools.has(b.id)) continue;
          const part = claudeMsg.toolCallPart(b.id, b.name, b.input);
          w.openTools.set(b.id, { name: part.name, kind: part.kind, title: part.title, detail: part.detail, startedAtMs: claudeMsg.tsOf(rec) || now(), diffStat: part.diffStat, input: b.input });
        }
      }
      w._pendingToolScan = null;
      w._doneTools = null;
      w.offset = size;
      w.lastRecordAt = now();
    } catch (_) {
      /* unreadable now; the poll retries */
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
  }

  /**
   * Read new complete lines since the offset.
   * @param {object} w
   */
  function readNew(w) {
    if (!w.file) {
      const p = index.transcriptPathFor(w.sessionId);
      if (!p) return;
      w.file = p;
      w.tag = reader.fileTag(p);
      w.offset = 0;
      armFsWatch(w);
    }
    let size;
    try { size = fs.statSync(w.file).size; } catch (_) { return; }
    if (size < w.offset) { w.offset = size; return; }
    if (size === w.offset) return;
    let fd;
    try {
      fd = fs.openSync(w.file, 'r');
      for (const line of reader.forwardLines(fd, w.offset, size, null)) {
        const { record, oversize } = reader.parseLine(line);
        try {
          if (w.provider === 'claude') onClaudeRecord(w, record, line, oversize); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
          else onCodexRecord(w, record, line, oversize);
        } catch (err) { warn('record handling failed', err && err.message); }
        w.offset = line.offset + line.length + 1;
      }
    } catch (err) {
      warn('tail read failed', err && err.message);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
    if (w.metaDirty) { w.metaDirty = false; publishMeta(w); }
    const pr = prompts();
    if (pr && pr.recomplete) pr.recomplete(w.sessionId);
    refresh(w);
  }

  /**
   * Publish session.meta for a watcher.
   * @param {object} w
   */
  function publishMeta(w) {
    const m = index.meta(w.sessionId, metaExtra(w));
    if (m) pub(w.sessionId, 'session.meta', m);
  }

  /**
   * Meta fields only the tailer knows.
   * @param {object} w
   * @returns {object}
   */
  function metaExtra(w) {
    return { model: w.model || undefined, permissionMode: w.permissionMode, sandbox: w.sandbox || null, approvalPolicy: w.approvalPolicy || null, formatDrift: w.formatDrift };
  }

  /**
   * fs.watch on the transcript's folder with a debounce; the poll covers drops.
   * @param {object} w
   */
  function armFsWatch(w) {
    if (w.fsw || !w.file) return;
    try {
      const base = path.basename(w.file);
      w.fsw = fs.watch(path.dirname(w.file), (ev, name) => {
        if (name && name !== base) return;
        if (w.debounce) return;
        w.debounce = setTimeout(() => { w.debounce = null; readNew(w); }, TAIL_DEBOUNCE_MS);
        if (w.debounce.unref) w.debounce.unref();
      });
      w.fsw.on('error', () => { try { w.fsw.close(); } catch (_) {} w.fsw = null; });
    } catch (_) { w.fsw = null; }
  }

  /**
   * Start or extend watching a session.
   * @param {string} sessionId
   * @param {'hosted'|'subscriber'} reason
   * @returns {object|null} watcher
   */
  function watch(sessionId, reason) {
    const ref = index.resolve(sessionId);
    if (!ref) return null;
    const id = ref.sessionId;
    let w = watchers.get(id);
    if (!w) {
      evictIfNeeded();
      w = newWatcher(ref);
      watchers.set(id, w);
      w.file = ref.transcriptPath || null;
      if (w.file) {
        w.tag = reader.fileTag(w.file);
        initialScan(w);
        armFsWatch(w);
      }
      w.poll = setInterval(() => readNew(w), TAIL_POLL_MS);
      if (w.poll.unref) w.poll.unref();
      refresh(w);
    }
    if (reason === 'subscriber') w.subscribers += 1;
    w.reasons.add(reason);
    w.lastUsedAt = now();
    updateAgentsWatch(w);
    ensureTick();
    return w;
  }

  /**
   * Keep the shared agents poll running only for watched external or background Claude sessions.
   * @param {object} w
   */
  function updateAgentsWatch(w) {
    if (!agents || w.provider !== 'claude' || !w.upstreamId) return; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    const ref = index.resolve(w.sessionId);
    const want = w.subscribers > 0 && ref && (ref.owner === 'external' || ref.owner === 'background');
    if (want && !w.unwatchAgents) w.unwatchAgents = agents.watch(w.upstreamId);
    if (!want && w.unwatchAgents) { w.unwatchAgents(); w.unwatchAgents = null; }
  }

  /**
   * Drop one reason for watching; stop when none is left.
   * @param {string} sessionId
   * @param {'hosted'|'subscriber'} reason
   */
  function unwatch(sessionId, reason) {
    const ref = index.resolve(sessionId);
    const w = ref ? watchers.get(ref.sessionId) : watchers.get(sessionId);
    if (!w) return;
    if (reason === 'subscriber') { w.subscribers = Math.max(0, w.subscribers - 1); if (w.subscribers === 0) w.reasons.delete('subscriber'); }
    else w.reasons.delete(reason);
    updateAgentsWatch(w);
    if (w.reasons.size === 0) stop(w);
  }

  /** @param {object} w */
  function stop(w) {
    if (w.poll) clearInterval(w.poll);
    if (w.debounce) clearTimeout(w.debounce);
    if (w.stateTimer) clearTimeout(w.stateTimer);
    if (w.fsw) { try { w.fsw.close(); } catch (_) {} }
    if (w.unwatchAgents) w.unwatchAgents();
    flushUpdate(w);
    watchers.delete(w.sessionId);
  }

  /** Keep at most 24 tailers: drop the least recently used without a subscriber. */
  function evictIfNeeded() {
    if (watchers.size < MAX_TAILERS) return;
    const candidates = Array.from(watchers.values()).filter((w) => w.subscribers === 0 && !w.reasons.has('hosted')).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const victim = candidates[0] || Array.from(watchers.values()).filter((w) => w.subscribers === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (victim) stop(victim);
  }

  // ── Screen, agents, exits, timers ─────────────────────────────────────

  /**
   * Screen classification from the prompt service (PROTOCOL.md 8.1).
   * @param {string} sessionId
   * @param {{kind: string}} cls
   */
  function onScreen(sessionId, cls) {
    const w = watchers.get(sessionId);
    if (!w) return;
    w.screen = Object.assign({ at: now() }, cls);
    const idle = cls.kind === 'idlePrompt';
    if (idle) {
      if (!w.screenIdleSince) w.screenIdleSince = now();
      w.screenIdleReads += 1;
    } else {
      w.screenIdleSince = 0;
      w.screenIdleReads = 0;
      w.idleConfirmedAt = 0;
    }
    // C1a: the busy line right after a phone send was delivered.
    if (cls.kind === 'busy' && !w.turn) {
      const s = sends();
      if (s && s.deliveredWithoutTurn && s.deliveredWithoutTurn(sessionId, Infinity)) w.c1aAt = now();
    }
    refresh(w);
  }

  /**
   * Agents listing arrived (C5 background exit, C7 agents idle).
   * @param {{entries: object[]}} listing
   */
  function onAgents(listing) {
    for (const w of watchers.values()) {
      if (w.provider !== 'claude' || !w.upstreamId || !w.unwatchAgents) continue; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const e = (listing.entries || []).find((x) => String(x.sessionId).toLowerCase() === String(w.upstreamId).toLowerCase());
      // C5: the session left the listing, or (rule 6) is still listed as a
      // background session but without its process, while a turn is open.
      const gone = !e || isSleepingBackground(e);
      if (w.turn && gone && w.seenInAgents) endTurn(w, 'failed', 'processExit', null, { code: 'PROCESS_EXITED', error: 'Claude Code exited' });
      if (!gone) w.seenInAgents = true;
      if (e && e.status === 'idle' && !e.waitingFor) w.agentsIdle.push(now()); else w.agentsIdle = [];
      refresh(w);
    }
  }

  /**
   * A Workbook PTY exited (C5, X7).
   * @param {string} workbookSessionId
   * @param {number} exitCode
   */
  function onPtyExit(workbookSessionId, exitCode) {
    const phoneId = index.idForWorkbookSession(workbookSessionId);
    const w = phoneId ? watchers.get(phoneId) : null;
    if (!w) return;
    readNew(w);
    if (w.turn) {
      endTurn(w, 'failed', 'processExit', null, { code: 'PROCESS_EXITED', error: 'the process on ' + index.computerName() + ' exited with code ' + (Number.isFinite(exitCode) ? exitCode : 'unknown') });
    }
    w.screen = null;
    refresh(w);
  }

  /** Per second checks: confirmed idle (C7), API error idle end (C4), no activity detail. */
  function check() {
    const t = now();
    for (const w of watchers.values()) {
      if (!w.turn) continue;
      const quietRecords = t - w.lastRecordAt >= IDLE_CONFIRM_SPAN_MS;
      // C4: an API error followed by an idle screen for 10 s.
      if (w.turn._failed && w.screen && w.screen.kind === 'idlePrompt' && w.screenIdleSince && t - w.screenIdleSince >= API_ERROR_IDLE_MS && quietRecords) {
        endTurn(w, 'failed', 'apiError', null, w.turn._failed);
        refresh(w);
        continue;
      }
      // X3 fallback (PROTOCOL.md 6.3): after an interrupt this phone sent, the
      // Codex screen shows the idle composer and neither task_complete nor
      // turn_aborted arrives within 5 s: the turn ended interrupted. Without
      // it a Codex whose abort record is named differently would end as
      // completed through C7 about 36 s later.
      if (w.provider === 'codex' && w.screen && w.screen.kind === 'idlePrompt' && w.screenIdleSince) { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        const i = interrupts();
        const escAt = i && i.lastPhoneEscAt ? i.lastPhoneEscAt(w.sessionId) : 0;
        if (escAt && escAt >= w.turn.startedAtMs && t - Math.max(escAt, w.screenIdleSince) >= CODEX_INTERRUPT_FALLBACK_MS) {
          endTurn(w, 'interrupted', 'interruptMarker', null, null, { stoppedBy: 'phone' });
          refresh(w);
          continue;
        }
      }
      // C7 for a Workbook pane: idle screen held 6 s over 3 reads (or unchanged since), then 30 s.
      const screenHeld = w.screen && w.screen.kind === 'idlePrompt' && w.screenIdleSince && t - w.screenIdleSince >= IDLE_CONFIRM_SPAN_MS;
      if (screenHeld && quietRecords) {
        if (!w.idleConfirmedAt) w.idleConfirmedAt = t;
        if (t - w.idleConfirmedAt >= IDLE_GRACE_MS) { endTurn(w, 'completed', 'screenIdle', null, null); refresh(w); continue; }
      } else if (!w.agentsIdle.length) {
        w.idleConfirmedAt = 0;
      }
      // C7 for external or background: agents idle on 3 polls over 6 s, then 30 s.
      const ai = w.agentsIdle;
      if (ai.length >= IDLE_CONFIRM_READS && ai[ai.length - 1] - ai[ai.length - IDLE_CONFIRM_READS] >= IDLE_CONFIRM_SPAN_MS && quietRecords) {
        if (!w.agentsIdleConfirmedAt) w.agentsIdleConfirmedAt = t;
        if (t - w.agentsIdleConfirmedAt >= IDLE_GRACE_MS) { endTurn(w, 'completed', 'agentsIdle', null, null); w.agentsIdleConfirmedAt = 0; refresh(w); continue; }
      } else {
        w.agentsIdleConfirmedAt = 0;
      }
      refresh(w);
    }
  }

  function ensureTick() {
    if (tick) return;
    tick = setInterval(check, deps.checkTickMs || CHECK_TICK_MS);
    if (tick.unref) tick.unref();
  }

  if (agents && agents.onPoll) agents.onPoll(onAgents);

  return {
    watch,
    unwatch,
    onScreen,
    onPtyExit,
    readNow: (sessionId) => { const w = watchers.get(sessionId); if (w) readNew(w); },
    /** The SessionState of a session (watched or not). */
    stateOf(sessionId) {
      const ref = index.resolve(sessionId);
      if (!ref) return null;
      const w = watchers.get(ref.sessionId);
      if (w) return lastStates.get(ref.sessionId) || evaluate(w);
      return { sessionId: ref.sessionId, state: 'idle', enteredAtMs: now(), turnId: null, turnStartedAtMs: null, toolName: null, detail: null, source: 'none', lastActivityAtMs: null, queuedSends: 0, estimatedThinkingTokens: null };
    },
    /** The running turn, else the last one, of a watched session. */
    turnOf(sessionId) {
      const w = watchers.get(sessionId);
      if (!w) return null;
      if (w.turn) return publicTurn(w.turn);
      return w.lastTurn && w.lastTurn.turnId ? publicTurn(w.lastTurn) : null;
    },
    isTurnOpen(sessionId) { const w = watchers.get(sessionId); return !!(w && w.turn); },
    metaExtra(sessionId) { const w = watchers.get(sessionId); return w ? metaExtra(w) : {}; },
    /** Latest open tool_use of the open turn (prompt completion). */
    openToolsOf(sessionId) { const w = watchers.get(sessionId); return w ? Array.from(w.openTools.entries()) : []; },
    refresh(sessionId) { const w = watchers.get(sessionId); if (w) refresh(w); },
    publishMeta(sessionId) { const w = watchers.get(sessionId); if (w) publishMeta(w); else { const m = index.meta(sessionId); if (m) pub(sessionId, 'session.meta', m); } },
    onTurn(fn) { turnListeners.add(fn); return () => turnListeners.delete(fn); },
    onState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    watching: (sessionId) => watchers.has(sessionId),
    watcherCount: () => watchers.size,
    _watcher: (sessionId) => watchers.get(sessionId),
    _check: check,
    stopAll() { for (const w of Array.from(watchers.values())) stop(w); if (tick) clearInterval(tick); tick = null; },
  };
}

module.exports = { createTurnService, apiErrorOf, MAX_TAILERS, NO_ACTIVITY_MS, IDLE_GRACE_MS };
