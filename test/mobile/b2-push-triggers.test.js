/**
 * B2: push triggers (PROTOCOL.md 10.2, 10.4) as B1 notify events: question
 * for question and unknown prompts, approval, plan, resolved, finished on a
 * turn end, and the Live Activity content (at most 4 sessions, waiting
 * first, needsYouChanged when a session starts to need you, an empty list
 * when nothing runs), all through the B1 stub's recorder.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const kit = require('./fakes/b2-kit');
const { createPushTriggers } = require('../../src/web/mobile/chat/push-triggers');

const events = [];
const promptFns = [];
const turnFns = [];
const stateFns = [];
const ctx = { mobile: { push: { notify: async (e) => { events.push(e); } } } };
const index = { resolve: (id) => ({ sessionId: id, title: 'Title ' + id, provider: 'claude' }), computerName: () => 'TEST-PC' };
const prompts = { onEvent: (fn) => { promptFns.push(fn); return () => {}; } };
const turns = { onTurn: (fn) => { turnFns.push(fn); return () => {}; }, onState: (fn) => { stateFns.push(fn); return () => {}; } };
createPushTriggers({ ctx, index, prompts, turns });
const last = (k) => events.filter((e) => e.kind === k).slice(-1)[0];
const state = (sessionId, s, at) => { for (const fn of stateFns) fn({ sessionId, state: s, enteredAtMs: at }); };

kit.test('prompt kinds map to question, approval and plan; unknown is a question; resolved follows', async () => {
  for (const [kind, want] of [['question', 'question'], ['approval', 'approval'], ['plan', 'plan'], ['unknown', 'question']]) {
    for (const fn of promptFns) fn('open', { sessionId: 'cl_a', promptId: 'p_' + kind.padEnd(20, 'x'), kind });
    const e = events[events.length - 1];
    kit.eq([e.kind, e.sessionId, e.sessionTitle, e.provider, e.promptId], [want, 'cl_a', 'Title cl_a', 'claude', 'p_' + kind.padEnd(20, 'x')]);
  }
  for (const fn of promptFns) fn('resolved', { sessionId: 'cl_a', promptId: 'p_q' }, { by: 'phone' });
  kit.eq(last('resolved'), { kind: 'resolved', sessionId: 'cl_a', promptId: 'p_q' });
});

kit.test('finished on completed and failed turns with duration and error words; not on interrupted', async () => {
  const n = events.length;
  for (const fn of turnFns) fn({ sessionId: 'cl_b', status: 'interrupted', durationMs: 5 });
  kit.eq(events.length, n);
  for (const fn of turnFns) fn({ sessionId: 'cl_b', status: 'failed', durationMs: 180000, error: { code: 'API_ERROR', error: 'the API answered overloaded' } });
  kit.eq(last('finished'), { kind: 'finished', sessionId: 'cl_b', sessionTitle: 'Title cl_b', provider: 'claude', durationMs: 180000, status: 'failed', errorWords: 'the API answered overloaded' });
});

kit.test('activity: start with one running session, waiting first, at most 4, then empty', async () => {
  state('cl_1', 'thinking', 1);
  let a = last('activity');
  kit.eq([a.computerName, a.sessions.map((s) => s.sessionId), a.urgentSessionId, a.needsYouChanged], ['TEST-PC', ['cl_1'], 'cl_1', false]);
  state('cl_2', 'working', 2);
  state('cl_3', 'queued', 3);
  state('cl_4', 'thinking', 4);
  state('cl_5', 'needsApproval', 5);
  a = last('activity');
  kit.eq(a.sessions.length, 4);
  kit.eq([a.sessions[0].sessionId, a.urgentSessionId, a.needsYouChanged], ['cl_5', 'cl_5', true]);
  const count = events.filter((e) => e.kind === 'activity').length;
  state('cl_5', 'needsApproval', 5);
  kit.eq(events.filter((e) => e.kind === 'activity').length, count, 'no event without a change');
  for (const id of ['cl_1', 'cl_2', 'cl_3', 'cl_4', 'cl_5']) state(id, 'idle', 9);
  a = last('activity');
  kit.eq([a.sessions, a.urgentSessionId], [[], null]);
});

kit.run();
