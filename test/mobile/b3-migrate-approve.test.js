/**
 * b3-migrate-approve.test.js: approval, cancel, retry and the states a person
 * must act on (PROTOCOL.md 4.12.4 to 4.12.6; decision A20; critic F13, F14;
 * BUILD-CONTRACT 3.7.1 item 7).
 *
 * The migration engine runs against a stub of B2's chat interface
 * (BUILD-CONTRACT 3.4.3: prompts.openFor and answer, sends.enqueueSystem,
 * launch.start and stop, sessions.setHandedOff) and against target
 * transcripts this suite writes, with jobs loaded from job.json as after a
 * restart. It checks that a Claude approval answers the ExitPlanMode dialog
 * with the option that restores the source's own permission mode (bypass,
 * auto-accept edits, manual approvals, else the first allow option) with
 * origin migration and then delivers the note as a send; that a Codex
 * approval stops the read only pane, restarts it with the source's sandbox
 * and approval settings and says "Approved. Proceed with the plan."; that
 * continuing becomes completed only when the transcript confirms the go
 * ahead; MIGRATION_NOT_AWAITING for a closed or changed dialog; the Codex
 * report from the final answer, and needsAttention (with its push) when a
 * Codex turn ends without one; the stage timeout; retry nudges with fixed
 * sentences; and cancel from awaitingApproval (target stopped and archived,
 * hand off and lineage cleared, pack kept).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./b3-kit');
const { createMigrations, STEPS } = require('../../src/web/mobile/workspace/migrate/jobs');

/** The watcher polls every 750 ms; a confirmation arrives within a few ticks. */
const WATCH_WAIT_MS = 8000;
const MINUTE = 60 * 1000;
/** Tier S stage timeout without progress (R08 section 9.1 row 9). */
const TIER_S_TIMEOUT_MS = 20 * MINUTE;

const sb = kit.sandbox();
const dataDir = path.join(sb.root, 'data');
const root = path.join(dataDir, 'migrations');
fs.mkdirSync(root, { recursive: true });
const clock = { t: Date.now() };

// ── The stub of B2's chat interface ───────────────────────────────────────

const calls = [];
const prompts = new Map();
const refs = new Map();
const handoffs = new Map();
const settingsValues = {};
const published = [];
const pushes = [];
const audits = [];
const chat = {
  answerError: null,
  sessions: {
    resolve: (id) => refs.get(id) || null,
    meta: (id) => (refs.has(id) ? { sessionId: id, lineage: null } : null),
    noteChanged: () => {},
    setHandedOff: (id, info) => { calls.push(['setHandedOff', id, info ? 'set' : null]); if (info) handoffs.set(id, info); else handoffs.delete(id); },
    handoffOf: (id) => handoffs.get(id) || null,
    onChanged: () => () => {},
  },
  prompts: {
    openFor: (id) => prompts.get(id) || [],
    async answer(id, promptId, req, who) {
      calls.push(['answer', id, promptId, req.optionIndex, who && who.origin]);
      if (chat.answerError) throw chat.answerError;
      return { promptId, status: 'resolved', by: 'phone' };
    },
  },
  sends: { async enqueueSystem(id, text, o) { calls.push(['send', id, text, o && o.origin]); return { state: 'queued' }; } },
  launch: {
    async start(id, o) { calls.push(['start', id, o && o.reason]); return { status: 'spawned' }; },
    async stop(id) { calls.push(['stop', id]); return { status: 'stopped' }; },
  },
  turns: { stateOf: () => ({ state: 'idle' }) },
};
const ctx = {
  dataDir,
  log: () => {},
  mobile: {
    chat,
    hub: { publish: (topic, type, data) => { published.push({ topic, type, data }); return published.length; }, currentSeq: () => published.length, epoch: 'e_testtesttesttest' },
    push: { notify: (e) => { pushes.push(e); return Promise.resolve(); } },
    audit: { write: (e) => audits.push(e) },
  },
};
const deps = {
  flags: { set: (id, patch) => { calls.push(['flags', id, patch]); return Object.assign({ pinned: false, archived: false }, patch); }, get: () => ({ pinned: false, archived: false }) },
  tabs: { current: () => ({ groups: [] }), hasRoom: () => true, tabGroupIdsFor: () => [] },
  settings: { valuesOf: (id) => settingsValues[id] || {}, applyValues: (id, v) => { calls.push(['apply', id, v]); return v; } },
  accounts: { snapshot: () => ({ providers: [] }) },
  schema: { suggestions: () => [] },
};
let engine;

/**
 * Register a session the stub resolves, with a transcript file.
 *
 * @param {string} id - Phone id.
 * @param {string} provider - claude or codex.
 * @returns {string} The transcript path.
 */
function session(id, provider) {
  const file = path.join(sb.root, 'transcripts', id + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  refs.set(id, { sessionId: id, provider, transcriptPath: file, owner: 'none', title: id, workingDir: null });
  return file;
}

/**
 * Write a job.json as the engine persists it.
 *
 * @param {object} o - Fields over a Claude job waiting for approval.
 * @returns {object} The job.
 */
function writeJob(o) {
  const n = crypto.randomBytes(4).toString('hex');
  const job = Object.assign({
    migrationId: 'mg_' + crypto.randomBytes(16).toString('base64url'),
    sourceSessionId: 'cl_src_' + n,
    targetSessionId: 'cl_tgt_' + n,
    target: { provider: 'claude', model: 'claude-opus-5-5', effort: null, accountId: null },
    mode: 'takeover',
    depth: 'standard',
    sourcePolicy: 'pause',
    state: 'awaitingApproval',
    steps: STEPS.map(([key, label]) => ({ key, label, state: 'done', detail: null, done: null, total: null, startedAtMs: clock.t, endedAtMs: clock.t })),
    plan: { tier: 'S', ranges: 1, maxReaders: 0, readerModel: null },
    coverage: null,
    stale: false,
    report: { ready: true, header: null },
    tripwire: null,
    error: null,
    createdAtMs: clock.t,
    updatedAtMs: clock.t,
  }, o);
  job._ = Object.assign({ idempotencyKey: 'k_' + n, deviceId: null, name: 'Takeover ' + n, sourcePath: null, cwd: null, tailOffset: 0, reportToolUseId: 'toolu_' + n, approvedAtMs: null, placement: { tabGroupId: null, afterSessionId: null }, git: null }, o._ || {});
  if (!refs.has(job.sourceSessionId)) session(job.sourceSessionId, 'claude');
  if (job.targetSessionId && !refs.has(job.targetSessionId)) session(job.targetSessionId, job.target.provider);
  fs.mkdirSync(path.join(root, job.migrationId), { recursive: true });
  fs.writeFileSync(path.join(root, job.migrationId, 'job.json'), JSON.stringify(job));
  return job;
}

/**
 * Append records to a session's transcript.
 *
 * @param {string} id - Phone id.
 * @param {object[]} records - Records.
 */
function append(id, records) {
  fs.appendFileSync(refs.get(id).transcriptPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * The plan prompt B2 would report for the ExitPlanMode dialog.
 *
 * @param {string[]} labels - Allow option labels, then "Tell Claude what to change".
 * @returns {object}
 */
function planPrompt(labels) {
  const options = labels.map((label, index) => ({ index, label, role: 'allow' }));
  options.push({ index: labels.length, label: 'Tell Claude what to change', role: 'keepPlanning' });
  return { promptId: 'p_' + crypto.randomBytes(15).toString('base64url'), kind: 'plan', options };
}

/**
 * Expect a MobileError.
 *
 * @param {Function} fn - Work.
 * @param {string} code - Expected code.
 * @returns {Promise<object>} The error.
 */
async function rejects(fn, code) {
  try { await fn(); } catch (err) {
    kit.eq(err.code, code, err.message);
    return err;
  }
  throw new Error('expected ' + code);
}

const FULL_OPTIONS = ['Yes, and bypass permissions', 'Yes, auto-accept edits', 'Yes, manually approve edits'];
const jobs = {};

kit.test('load jobs from job.json as after a restart', async () => {
  jobs.bypass = writeJob({});
  jobs.accept = writeJob({});
  jobs.manual = writeJob({});
  jobs.fallback = writeJob({});
  jobs.closed = writeJob({});
  jobs.changed = writeJob({});
  jobs.codex = writeJob({ target: { provider: 'codex', model: 'gpt-6-astra', effort: null, accountId: null } });
  jobs.codexReading = writeJob({ state: 'reading', target: { provider: 'codex', model: 'gpt-6-astra', effort: null, accountId: null }, report: { ready: false, header: null } });
  jobs.codexNoReport = writeJob({ state: 'reading', target: { provider: 'codex', model: 'gpt-6-astra', effort: null, accountId: null }, report: { ready: false, header: null } });
  jobs.stuck = writeJob({ state: 'reading', report: { ready: false, header: null } });
  jobs.failed = writeJob({ state: 'failed', error: { code: 'MIGRATION_STEP_FAILED', error: 'The step failed.', retryable: true } });
  jobs.cancel = writeJob({});
  for (const j of [jobs.codexReading, jobs.codexNoReport, jobs.stuck, jobs.failed]) {
    const st = JSON.parse(fs.readFileSync(path.join(root, j.migrationId, 'job.json'), 'utf8'));
    st.steps = st.steps.map((x) => (['reading', 'verifying', 'report'].includes(x.key) ? Object.assign({}, x, { state: x.key === 'reading' ? (j === jobs.failed ? 'failed' : 'running') : 'pending', endedAtMs: null }) : x));
    fs.writeFileSync(path.join(root, j.migrationId, 'job.json'), JSON.stringify(st));
  }
  handoffs.set(jobs.cancel.sourceSessionId, { targetSessionId: jobs.cancel.targetSessionId });
  settingsValues[jobs.bypass.sourceSessionId] = { permissionMode: 'bypassPermissions' };
  settingsValues[jobs.accept.sourceSessionId] = { permissionMode: 'acceptEdits' };
  settingsValues[jobs.manual.sourceSessionId] = { permissionMode: 'default' };
  settingsValues[jobs.fallback.sourceSessionId] = { permissionMode: 'auto' };
  settingsValues[jobs.codex.sourceSessionId] = { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  engine = createMigrations(Object.assign({ ctx, now: () => clock.t, useWorker: false }, deps));
  engine.load();
  kit.eq(engine.list({}).migrations.length, 12);
  kit.validate(engine.list({}), 'migrate/migrations-list.json');
});

kit.test('Claude: the option that restores the source permission mode, with origin migration', async () => {
  const cases = [[jobs.bypass, 0], [jobs.accept, 1], [jobs.manual, 2], [jobs.fallback, 0]];
  for (const [job, want] of cases) {
    const p = planPrompt(job === jobs.fallback ? ['Yes', 'Yes, keep going'] : FULL_OPTIONS);
    prompts.set(job.targetSessionId, [p]);
    const snap = await engine.approve(job.migrationId, { note: job === jobs.manual ? 'Start with the tests.' : null }, { deviceId: 'd_test' });
    kit.validate(snap, 'migrate/migration.json');
    kit.eq(snap.state, 'continuing');
    const a = calls.filter((c) => c[0] === 'answer' && c[1] === job.targetSessionId);
    kit.eq(a, [['answer', job.targetSessionId, p.promptId, want, 'migration']], job._.name);
  }
  await kit.until(() => calls.some((c) => c[0] === 'send' && c[1] === jobs.manual.targetSessionId), 2000, 'the note');
  kit.eq(calls.find((c) => c[0] === 'send' && c[1] === jobs.manual.targetSessionId).slice(2), ['Start with the tests.', 'migration']);
  kit.ok(audits.some((e) => e.action === 'migrationApprove'), 'audit');
});

kit.test('continuing becomes completed only when the transcript confirms the go ahead', async () => {
  const job = jobs.manual;
  await kit.sleep(1500);
  kit.eq(engine.get(job.migrationId).state, 'continuing', 'nothing confirmed yet');
  append(job.targetSessionId, [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: job._.reportToolUseId, content: 'User has approved your plan.', is_error: false }] } }]);
  await kit.until(() => engine.get(job.migrationId).state === 'completed', WATCH_WAIT_MS, 'completed');
  const progress = published.filter((e) => e.type === 'migration.progress' && e.data.migration.migrationId === job.migrationId).map((e) => e.data.migration.state);
  kit.ok(progress.includes('continuing') && progress[progress.length - 1] === 'completed', progress.join(','));
});

kit.test('MIGRATION_NOT_AWAITING: no open plan dialog, a changed dialog, or the wrong state', async () => {
  prompts.set(jobs.closed.targetSessionId, []);
  const e1 = await rejects(() => engine.approve(jobs.closed.migrationId, {}, null), 'MIGRATION_NOT_AWAITING');
  kit.eq(e1.status, 409);
  prompts.set(jobs.changed.targetSessionId, [planPrompt(FULL_OPTIONS)]);
  chat.answerError = Object.assign(new Error('changed'), { code: 'PROMPT_CHANGED' });
  const e2 = await rejects(() => engine.approve(jobs.changed.migrationId, {}, null), 'MIGRATION_NOT_AWAITING');
  kit.ok(/PROMPT_CHANGED/.test(e2.message), e2.message);
  chat.answerError = null;
  kit.eq(engine.get(jobs.changed.migrationId).state, 'awaitingApproval', 'still waiting');
  await rejects(() => engine.approve(jobs.manual.migrationId, {}, null), 'MIGRATION_NOT_AWAITING');
  await rejects(() => engine.approve('mg_unknown', {}, null), 'MIGRATION_NOT_FOUND');
});

kit.test('Codex: stop the read only pane, restart with the source settings, then the fixed go ahead', async () => {
  const job = jobs.codex;
  const n = calls.length;
  const snap = await engine.approve(job.migrationId, { note: 'Mind the flaky test.' }, { deviceId: 'd_test' });
  kit.eq(snap.state, 'continuing');
  kit.eq(calls.slice(n).map((c) => c.slice(0, 3)), [
    ['stop', job.targetSessionId],
    ['apply', job.targetSessionId, { sandbox: 'workspace-write', approvalPolicy: 'on-request' }],
    ['start', job.targetSessionId, 'migration'],
    ['send', job.targetSessionId, 'Approved. Proceed with the plan.\n\nMind the flaky test.'],
  ]);
  append(job.targetSessionId, [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }]);
  await kit.until(() => engine.get(job.migrationId).state === 'completed', WATCH_WAIT_MS, 'completed on the next turn');
});

kit.test('Codex: the report is the final answer; a turn without one needs attention (with its push)', async () => {
  const header = { takeover_report: 1, verdict: 'Holds.', claims_checked: 4, claims_held: 3, claims_failed: 1, claims_unverifiable: 0, suspected_mistakes: 1, open_issues: 2, solved_verified: 1, learned: 2, coverage: 'every turn', confidence: 'high' };
  append(jobs.codexReading.targetSessionId, [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MIGRATE: reading 1/1' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '```json\n' + JSON.stringify(header) + '\n```\n\n# Takeover report\n' } },
  ]);
  await kit.until(() => engine.get(jobs.codexReading.migrationId).state === 'awaitingApproval', WATCH_WAIT_MS, 'the Codex report');
  const snap = engine.get(jobs.codexReading.migrationId);
  kit.eq([snap.report.ready, snap.report.header.claimsFailed, snap.report.header.learned, snap.coverage], [true, 1, 2, 'every turn']);
  const rep = engine.getReport(jobs.codexReading.migrationId);
  kit.validate(rep, 'migrate/migration-report.json');
  kit.eq(rep.coveragePercent, 100);
  kit.ok(pushes.some((e) => e.kind === 'migration' && e.migrationId === jobs.codexReading.migrationId && e.state === 'awaitingApproval' && e.claimsFailed === 1), 'report push');
  append(jobs.codexNoReport.targetSessionId, [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: 'I looked around.' } }]);
  await kit.until(() => engine.get(jobs.codexNoReport.migrationId).state === 'needsAttention', WATCH_WAIT_MS, 'needs attention');
  const na = engine.get(jobs.codexNoReport.migrationId);
  kit.eq([na.error.code, na.error.retryable], ['REPORT_MISSING', true]);
  const push = pushes.find((e) => e.migrationId === jobs.codexNoReport.migrationId && e.state === 'needsAttention');
  kit.eq(push.failedStepLabel, 'Reading history');
});

kit.test('a stage without progress past its timeout needs attention', async () => {
  clock.t += TIER_S_TIMEOUT_MS + MINUTE;
  engine._check();
  const s = engine.get(jobs.stuck.migrationId);
  kit.eq([s.state, s.error.code], ['needsAttention', 'STAGE_TIMEOUT']);
});

kit.test('retry nudges the takeover with fixed sentences; bad retries are refused', async () => {
  const n = calls.length;
  const r = engine.retry(jobs.stuck.migrationId, { fromStage: null }, { deviceId: 'd_test' });
  kit.eq(r.state, 'reading');
  await kit.until(() => calls.slice(n).some((c) => c[0] === 'send'), 2000, 'the nudge');
  kit.eq(calls.slice(n).map((c) => c.slice(0, 3)), [['start', jobs.stuck.targetSessionId, 'migration'], ['send', jobs.stuck.targetSessionId, 'Continue the takeover described in your instructions.']]);
  const m = calls.length;
  const r2 = engine.retry(jobs.codexNoReport.migrationId, { fromStage: 'report' }, null);
  kit.eq(r2.state, 'verifying');
  await kit.until(() => calls.slice(m).some((c) => c[0] === 'send'), 2000, 'the report nudge');
  kit.eq(calls.slice(m).find((c) => c[0] === 'send')[2], 'Write the takeover report now with what you have, then stop as your instructions say.');
  await rejects(() => engine.retry(jobs.failed.migrationId, { fromStage: 'nope' }, null), 'INVALID_FIELD');
  await rejects(() => engine.retry(jobs.cancel.migrationId, {}, null), 'MIGRATION_NOT_RETRYABLE');
});

kit.test('cancel from awaitingApproval: target stopped and archived, hand off and lineage cleared', async () => {
  const job = jobs.cancel;
  const n = calls.length;
  const snap = await engine.cancel(job.migrationId, { deviceId: 'd_test' });
  kit.eq(snap.state, 'cancelled');
  kit.eq(calls.slice(n).map((c) => c.slice(0, 3)), [['stop', job.targetSessionId], ['flags', job.targetSessionId, { archived: true }], ['setHandedOff', job.sourceSessionId, null]]);
  kit.eq([engine.lineageOf(job.sourceSessionId), engine.lineageOf(job.targetSessionId)], [null, null]);
  kit.ok(fs.existsSync(path.join(root, job.migrationId, 'job.json')), 'the pack stays');
  kit.ok(audits.some((e) => e.action === 'migrationCancel'), 'audit');
  await rejects(() => engine.cancel(job.migrationId, null), 'MIGRATION_NOT_CANCELLABLE');
});

kit.run(async () => { if (engine) engine.stop(); });
