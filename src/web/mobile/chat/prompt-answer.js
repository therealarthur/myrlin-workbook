/**
 * Answers to open TUI dialogs from the phone (PROTOCOL.md 4.4.7 and 8.5).
 *
 * What: under the session's write lock, re-read the screen, check the
 * dialog is still the one the phone saw (fingerprint), validate the answer,
 * and write the dialog's own keys one per pty.write 40 ms apart, checking
 * after every navigation step that the highlight moved where expected. Then
 * wait up to 3 s for the dialog to close. First answer wins: a dialog the
 * desktop already answered is 409 PROMPT_ALREADY_RESOLVED with `by`.
 *
 * Why: the desktop dialog stays live while the phone shows the card (A6),
 * so every key the phone writes must be justified by what is on screen at
 * that moment; any surprise stops the sequence and leaves the dialog to the
 * desktop.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const { sanitize, PASTE_START, PASTE_END, SUBMIT_DELAY_MS } = require('./send-queue');
const { delay } = require('./common');

const KEY_GAP_MS = 40;
const NAV_CHECK_MS = 500;
const NAV_POLL_MS = 60;
const RESOLVE_WAIT_MS = 3000;
const INPUT_WAIT_MS = 3000;
const IDEMPOTENCY_MS = 10 * 60 * 1000;
const RESOLVED_MEMORY = 200;
const KEYS = Object.freeze({ up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', enter: '\r', space: ' ', esc: '\x1b' });

/**
 * @param {object} deps - {ctx, index, runtime, lazy: {prompts, interrupts}, now, timings}
 * @returns {object}
 */
function createAnswers(deps) {
  const { ctx, index, runtime } = deps;
  const now = deps.now || Date.now;
  const lazy = deps.lazy || {};
  const T = Object.assign({ keyGapMs: KEY_GAP_MS, resolveWaitMs: RESOLVE_WAIT_MS, navCheckMs: NAV_CHECK_MS }, deps.timings || {});
  const resolved = new Map();
  const done = new Map();
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };
  const prompts = () => lazy.prompts && lazy.prompts();

  if (prompts() && prompts().onEvent) {
    prompts().onEvent((kind, p, data, extra) => {
      if (kind !== 'resolved') return;
      // replacedBy: the dialog changed in place into another prompt (not closed).
      resolved.set(p.promptId, extra && extra.replacedBy ? Object.assign({}, data, { replacedBy: extra.replacedBy }) : data);
      if (resolved.size > RESOLVED_MEMORY) resolved.delete(resolved.keys().next().value);
    });
  }

  /**
   * Validate an AnswerRequest against a prompt and turn it into a plan.
   * @param {object} p - internal prompt
   * @param {object} a - AnswerRequest
   * @returns {object} plan
   */
  function planFor(p, a) {
    const has = (k) => a[k] !== undefined && a[k] !== null;
    if (a.dismiss === true) {
      if (['decision', 'optionIndex', 'answers', 'text'].some(has)) fail(422, 'INVALID_ANSWER', 'dismiss must be sent alone.', { field: 'dismiss' });
      return { type: 'dismiss', summary: 'Dismissed' };
    }
    if (p.kind === 'approval' || p.kind === 'plan' || p.kind === 'unknown') {
      if (has('answers')) fail(422, 'INVALID_ANSWER', 'This prompt takes a decision or an option.', { field: 'answers' });
      if (p.kind === 'unknown' && has('decision')) fail(422, 'INVALID_ANSWER', 'This dialog takes an option index.', { field: 'decision' });
      if (has('decision') === has('optionIndex')) fail(422, 'INVALID_ANSWER', 'Send exactly one of decision or optionIndex.', { field: has('decision') ? 'optionIndex' : 'decision' });
      let idx;
      let role = null;
      if (has('decision')) {
        const allowed = p.kind === 'plan' ? ['approvePlan', 'keepPlanning'] : ['allow', 'allowAlways', 'deny'];
        if (!allowed.includes(a.decision)) fail(422, 'INVALID_ANSWER', 'That decision does not fit this prompt.', { field: 'decision' });
        role = a.decision === 'approvePlan' ? 'allow' : a.decision;
        idx = p.options.findIndex((o) => o.role === role);
        if (idx === -1) fail(422, 'INVALID_ANSWER', 'This dialog has no option for that decision.', { field: 'decision' });
      } else {
        idx = a.optionIndex;
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.options.length) fail(422, 'INVALID_ANSWER', 'There is no option with that index.', { field: 'optionIndex' });
        role = p.options[idx].role;
      }
      if (has('text')) {
        const ok = (p.kind === 'approval' && role === 'deny') || (p.kind === 'plan' && role === 'keepPlanning');
        if (!ok || typeof a.text !== 'string') fail(422, 'INVALID_ANSWER', 'Text goes only with deny or keep planning.', { field: 'text' });
      }
      return { type: 'option', index: idx, text: has('text') ? a.text : null, summary: p.options[idx].label };
    }
    // question
    if (has('decision') || has('optionIndex')) fail(422, 'INVALID_ANSWER', 'A question takes answers.', { field: has('decision') ? 'decision' : 'optionIndex' });
    if (!Array.isArray(a.answers) || a.answers.length !== p.questions.length) fail(422, 'INVALID_ANSWER', 'Send one answer per question.', { field: 'answers' });
    const steps = a.answers.map((ans, qi) => {
      const q = p.questions[qi];
      if (!ans || ans.questionIndex !== qi) fail(422, 'INVALID_ANSWER', 'Answers must be in question order.', { field: 'answers[' + qi + '].questionIndex' });
      const idxs = Array.isArray(ans.optionIndexes) ? ans.optionIndexes : [];
      const other = ans.otherText === undefined || ans.otherText === null ? null : ans.otherText;
      if (other !== null && (typeof other !== 'string' || !q.allowOther)) fail(422, 'INVALID_ANSWER', 'This question does not take an Other answer.', { field: 'answers[' + qi + '].otherText' });
      for (const i of idxs) if (!Number.isInteger(i) || i < 0 || i >= q.options.length) fail(422, 'INVALID_ANSWER', 'There is no option with that index.', { field: 'answers[' + qi + '].optionIndexes' });
      if (!q.multiSelect) {
        if (!((idxs.length === 1 && other === null) || (idxs.length === 0 && other !== null))) fail(422, 'INVALID_ANSWER', 'A single choice question takes one option or an Other answer.', { field: 'answers[' + qi + '].optionIndexes' });
      } else if (!idxs.length && other === null) {
        fail(422, 'INVALID_ANSWER', 'Choose at least one option.', { field: 'answers[' + qi + '].optionIndexes' });
      }
      return { multi: q.multiSelect, idxs, other };
    });
    const first = steps[0];
    const summary = 'Answered: ' + (first.other !== null ? first.other : first.idxs.map((i) => p.questions[0].options[i].label).join(', '));
    return { type: 'question', steps, summary: summary.slice(0, 140) };
  }

  /**
   * Current internal prompt and a fresh classification.
   * @param {string} sessionId
   * @returns {Promise<{p: (object|null), cls: (object|null)}>}
   */
  async function look(sessionId) {
    const s = await runtime.freshScreen(sessionId, 0);
    const pr = prompts();
    if (s && pr) pr.onClassified(sessionId, s.cls);
    return { p: pr ? pr.internal(sessionId) : null, cls: s ? s.cls : null };
  }

  /**
   * Press a key and wait until the highlight shows the expected option.
   * @param {string} sessionId
   * @param {string} key
   * @param {number} expected
   * @param {string} promptId
   */
  async function navStep(sessionId, key, expected, promptId) {
    runtime.write(sessionId, key);
    await delay(T.keyGapMs);
    const start = now();
    for (;;) {
      const { p, cls } = await look(sessionId);
      const hl = cls && cls.dialog ? cls.dialog.highlighted : null;
      if (p && p.promptId === promptId && hl === expected) return;
      if (now() - start >= T.navCheckMs) fail(409, 'PROMPT_CHANGED', 'The dialog changed on the computer.');
      await delay(NAV_POLL_MS);
    }
  }

  /**
   * Move the highlight from its current option to a target, then optionally press a key.
   * @param {string} sessionId
   * @param {object} p
   * @param {number} target - screen option index
   */
  async function moveTo(sessionId, p, target) {
    const { cls } = await look(sessionId);
    let hl = cls && cls.dialog && cls.dialog.highlighted !== null ? cls.dialog.highlighted : 0;
    while (hl !== target) {
      const next = hl < target ? hl + 1 : hl - 1;
      await navStep(sessionId, hl < target ? KEYS.down : KEYS.up, next, p.promptId);
      hl = next;
    }
  }

  /**
   * Write one key and pause.
   * @param {string} sessionId
   * @param {string} k
   */
  async function key(sessionId, k) {
    runtime.write(sessionId, k);
    await delay(T.keyGapMs);
  }

  /**
   * Paste text as a bracketed paste, then submit after 80 ms.
   * @param {string} sessionId
   * @param {string} text
   */
  async function pasteSubmit(sessionId, text) {
    runtime.write(sessionId, PASTE_START + sanitize(text) + PASTE_END);
    await delay(SUBMIT_DELAY_MS);
    runtime.write(sessionId, KEYS.enter);
  }

  /**
   * Wait for the input line after a dialog closed (deny or keep planning with text).
   * @param {string} sessionId
   */
  async function waitInput(sessionId) {
    const start = now();
    while (now() - start < INPUT_WAIT_MS) {
      const { cls } = await look(sessionId);
      if (cls && cls.kind === 'idlePrompt') return true;
      await delay(NAV_POLL_MS * 2);
    }
    return false;
  }

  /**
   * Run a plan's keys.
   * @param {string} sessionId
   * @param {object} p - internal prompt
   * @param {object} plan
   * @param {string} deviceId
   */
  async function execute(sessionId, p, plan, deviceId) {
    const pr = prompts();
    const mark = () => pr && pr.notePhoneKeys(sessionId, p.promptId, deviceId, plan.summary);
    const ref = index.resolve(sessionId);
    if (plan.type === 'dismiss') {
      mark();
      runtime.write(sessionId, KEYS.esc);
      const i = lazy.interrupts && lazy.interrupts();
      if (i && i.notePhoneEsc) i.notePhoneEsc(sessionId);
      return;
    }
    if (plan.type === 'option') {
      const opt = p._screen.options[plan.index] || null;
      const letter = ref && ref.provider === 'codex' && opt && opt.key && /^[a-z]$/.test(opt.key) ? opt.key : null; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      if (letter) {
        mark();
        await key(sessionId, letter);
      } else {
        await moveTo(sessionId, p, plan.index);
        mark();
        await key(sessionId, KEYS.enter);
      }
      if (plan.text) {
        if (!(await waitInput(sessionId))) fail(409, 'PROMPT_CHANGED', 'The input line did not come back after the dialog.');
        await pasteSubmit(sessionId, plan.text);
      }
      return;
    }
    // question
    for (let qi = 0; qi < plan.steps.length; qi++) {
      const step = plan.steps[qi];
      const { p: cur, cls } = await look(sessionId);
      if (!cur || cur.promptId !== p.promptId || !cls || !cls.dialog) fail(409, 'PROMPT_CHANGED', 'The dialog changed on the computer.');
      const d = cls.dialog;
      if (step.other !== null) {
        if (d.otherIndex === null || d.otherIndex === undefined) fail(409, 'PROMPT_CHANGED', 'The dialog has no Other row.');
        await moveTo(sessionId, cur, d.otherIndex);
        if (qi === plan.steps.length - 1) mark();
        await key(sessionId, KEYS.enter);
        await delay(T.keyGapMs * 2);
        await pasteSubmit(sessionId, step.other);
      } else if (!step.multi) {
        await moveTo(sessionId, cur, step.idxs[0]);
        if (qi === plan.steps.length - 1) mark();
        await key(sessionId, KEYS.enter);
      } else {
        for (const i of step.idxs) {
          await moveTo(sessionId, cur, i);
          await key(sessionId, KEYS.space);
        }
        const nextRow = d.options.findIndex((o) => /^(Next|Submit|Continue|Done)/i.test(o.label));
        if (qi === plan.steps.length - 1) mark();
        if (nextRow !== -1) { await moveTo(sessionId, cur, nextRow); await key(sessionId, KEYS.enter); }
        else await key(sessionId, KEYS.right);
      }
      await delay(T.keyGapMs * 3);
    }
    // Final review screen.
    const { cls } = await look(sessionId);
    if (cls && cls.dialog && cls.dialog.review) {
      const submit = cls.dialog.options.findIndex((o) => /Submit/i.test(o.label));
      const cur = prompts() ? prompts().internal(sessionId) : null;
      if (submit !== -1 && cur) { mark(); await moveTo(sessionId, cur, submit); await key(sessionId, KEYS.enter); }
    }
  }

  /**
   * POST /sessions/:sessionId/prompts/:promptId/answer (also B3's migration approval).
   * @param {string} sessionId
   * @param {string} promptId
   * @param {object} body - AnswerRequest
   * @param {{deviceId: (string|null), origin?: string}} who
   * @returns {Promise<object>} AnswerResult
   */
  async function answer(sessionId, promptId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    const sid = ref.sessionId;
    const a = body && typeof body === 'object' ? body : {};
    const reqId = typeof a.clientRequestId === 'string' ? a.clientRequestId : null;
    if (reqId) {
      const prev = done.get(sid + '|' + reqId);
      if (prev && now() - prev.at <= IDEMPOTENCY_MS) return prev.result;
    }
    const result = await runtime.withLock(sid, async () => {
      const pr = prompts();
      let p = pr ? pr.internal(sid) : null;
      if (!p || p.promptId !== promptId) {
        const r = resolved.get(promptId);
        // PROTOCOL.md 8.5 step 1: a dialog still on screen whose fingerprint
        // differs is PROMPT_CHANGED; only a prompt that closed is already resolved.
        if (r && r.replacedBy && p && p.promptId === r.replacedBy) fail(409, 'PROMPT_CHANGED', 'The dialog changed on the computer.');
        if (r) fail(409, 'PROMPT_ALREADY_RESOLVED', 'Someone answered this already.', { by: r.by });
        fail(404, 'PROMPT_NOT_FOUND', 'That question or approval is not open.');
      }
      if (ref.owner !== 'workbook' || !runtime.hasScreen(sid) || !p.answerable && !(a.dismiss === true)) fail(409, 'PROMPT_NOT_ANSWERABLE', 'Answer this on ' + index.computerName() + '.');
      const seen = await look(sid);
      if (!seen.cls || (seen.cls.kind !== 'prompt' && seen.cls.kind !== 'unknownModal')) {
        const r = resolved.get(promptId);
        fail(409, 'PROMPT_ALREADY_RESOLVED', 'Someone answered this already.', { by: r ? r.by : 'desktop' });
      }
      p = pr.internal(sid);
      if (!p || p.promptId !== promptId) fail(409, 'PROMPT_CHANGED', 'The dialog changed on the computer.');
      const plan = planFor(p, a);
      await execute(sid, p, plan, who.deviceId);
      const start = now();
      while (now() - start < T.resolveWaitMs) {
        await delay(NAV_POLL_MS * 2);
        const { p: cur } = await look(sid);
        if (!cur || cur.promptId !== promptId) {
          const r = resolved.get(promptId);
          return { promptId, status: 'resolved', by: 'phone', resolvedAtMs: r ? r.resolvedAtMs : now() };
        }
      }
      fail(504, 'PROMPT_ANSWER_UNCONFIRMED', 'The keys were sent but the dialog is still open on ' + index.computerName() + '.');
      return null;
    });
    if (reqId) done.set(sid + '|' + reqId, { at: now(), result });
    const au = ctx && ctx.mobile && ctx.mobile.audit;
    if (au && au.write) { try { au.write({ deviceId: who.deviceId, action: 'answer', sessionId: sid, detail: who.origin || 'phone', ok: true }); } catch (_) {} }
    return result;
  }

  return { answer, planFor, KEYS };
}

module.exports = { createAnswers, KEYS, KEY_GAP_MS };
