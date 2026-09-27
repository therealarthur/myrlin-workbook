/**
 * Push triggers of the chat track (PROTOCOL.md 10.2 and 10.4).
 *
 * What: turns chat events into B1's push.notify events: question (also for
 * unknown dialogs), approval and plan when a prompt opens; resolved when it
 * closes; finished when a turn ends completed or failed (B1 applies the
 * device preferences, finishedMinMinutes and the open socket rule); and the
 * Live Activity content (at most 4 running or waiting sessions, waiting
 * first) on every change of that set.
 *
 * Why: B1 owns payloads, preferences and APNs; the chat track only knows
 * when something happened. Callers never build payloads (BUILD-CONTRACT
 * 3.4.2).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const { warn } = require('./common');

const RUNNING = new Set(['thinking', 'working', 'streaming', 'queued']);
const WAITING = new Set(['needsAnswer', 'needsApproval']);
const ACTIVITY_MAX = 4;

/**
 * @param {object} deps - {ctx, index, prompts, turns}
 * @returns {object}
 */
function createPushTriggers(deps) {
  const { ctx, index, prompts, turns } = deps;
  const states = new Map();
  let lastActivityKey = null;
  let lastWaiting = new Set();
  const unsubs = [];

  function notify(event) {
    const push = ctx.mobile && ctx.mobile.push;
    if (!push || typeof push.notify !== 'function') return;
    try {
      const r = push.notify(event);
      if (r && typeof r.catch === 'function') r.catch((err) => warn('push notify failed', err && err.message));
    } catch (err) { warn('push notify failed', err && err.message); }
  }

  const titleOf = (sessionId) => { const r = index.resolve(sessionId); return r ? r.title : 'Session'; };
  const providerOf = (sessionId) => { const r = index.resolve(sessionId); return r ? r.provider : null; };

  if (prompts && prompts.onEvent) {
    unsubs.push(prompts.onEvent((kind, p) => {
      if (kind === 'open') {
        const k = p.kind === 'approval' ? 'approval' : p.kind === 'plan' ? 'plan' : 'question';
        notify({ kind: k, sessionId: p.sessionId, sessionTitle: titleOf(p.sessionId), provider: providerOf(p.sessionId), promptId: p.promptId });
      } else if (kind === 'resolved') {
        notify({ kind: 'resolved', sessionId: p.sessionId, promptId: p.promptId });
      }
    }));
  }

  if (turns && turns.onTurn) {
    unsubs.push(turns.onTurn((t) => {
      if (t.status !== 'completed' && t.status !== 'failed') return;
      notify({
        kind: 'finished',
        sessionId: t.sessionId,
        sessionTitle: titleOf(t.sessionId),
        provider: providerOf(t.sessionId),
        durationMs: t.durationMs,
        status: t.status,
        errorWords: t.error ? t.error.error : null,
      });
    }));
  }

  /**
   * Publish the Live Activity content when the running or waiting set changed.
   */
  function activity() {
    const list = [];
    for (const [sessionId, st] of states) {
      if (RUNNING.has(st.state) || WAITING.has(st.state)) list.push({ sessionId, title: titleOf(sessionId), provider: providerOf(sessionId), state: st.state, enteredAtMs: st.enteredAtMs });
    }
    list.sort((a, b) => (WAITING.has(b.state) - WAITING.has(a.state)) || a.enteredAtMs - b.enteredAtMs);
    const sessions = list.slice(0, ACTIVITY_MAX);
    const key = JSON.stringify(sessions.map((s) => [s.sessionId, s.state]));
    if (key === lastActivityKey) return;
    lastActivityKey = key;
    const waiting = new Set(sessions.filter((s) => WAITING.has(s.state)).map((s) => s.sessionId));
    const needsYouChanged = Array.from(waiting).some((id) => !lastWaiting.has(id));
    lastWaiting = waiting;
    notify({ kind: 'activity', computerName: index.computerName(), sessions, urgentSessionId: sessions.length ? sessions[0].sessionId : null, needsYouChanged });
  }

  if (turns && turns.onState) {
    unsubs.push(turns.onState((st) => {
      states.set(st.sessionId, st);
      activity();
    }));
  }

  return {
    activity,
    stop() { for (const u of unsubs) { try { u(); } catch (_) {} } },
  };
}

module.exports = { createPushTriggers, ACTIVITY_MAX };
