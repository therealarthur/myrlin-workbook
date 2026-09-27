/**
 * b3-migrate-lifecycle.test.js: a migration end to end in a sandbox, against
 * the fake Claude CLI's takeover scenario in a real PTY (PROTOCOL.md 4.12;
 * decision A20; critics F13 to F15; R08 sections 4 to 9; BUILD-CONTRACT
 * 3.7.2 "Migrations").
 *
 * Preview fills the sheet and builds the index in the background; start
 * needs an Idempotency-Key and a repeat returns the same migration; the job
 * runs snapshot, index (worker thread), pack, launch (the takeover session
 * through B2 with the charter flags and no free text on any command line),
 * reading progress from the target's MIGRATE lines, the report from the
 * ExitPlanMode plan, awaitingApproval with its push, approval through the
 * plan dialog, continuing and completed. Along the way: every
 * migration.progress frame validates, the source is paused and handed off
 * (sends refused), lineage links both sessions, the target lands in the
 * source's tab group right after it, the pack holds no secret shaped string
 * and no credentials.md, the report carries coveragePercent, and the
 * evidence turn reads from the pack. Then: a restart resumes a job from its
 * job.json, a cancel archives the target and clears the source's hand off
 * and both lineage links, MIGRATION_ACTIVE guards a second start, and a
 * fromMessageId start packs only the history up to that message.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
process.env.CWM_VT_SIDECAR = '1';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const kit = require('./b3-kit');

/** Longest wait for a takeover to reach a state (fake CLI turns take seconds). */
const STATE_WAIT_MS = 90 * 1000;

const sb = kit.sandbox();

// Secret shaped fixture values, built at run time (no literal token pattern in source).
const hex = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
const SECRETS = { anthropic: 'sk-' + 'ant-api03-' + hex(40), github: 'gh' + 'p_' + hex(36), dbPassword: 'Pw' + hex(14) };
const FOCUS = 'Check the pairing tests first & then "rm -rf" nothing; token ' + SECRETS.github;

// Standards: a fixture Claude home (with a credentials.md that must never be
// packed) and an upward walk that stops at the sandbox.
const claudeHome = path.join(sb.root, 'claude-home');
fs.mkdirSync(claudeHome, { recursive: true });
fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), '# Global rules\n\nNo em dashes in any output.\n');
fs.writeFileSync(path.join(claudeHome, 'credentials.md'), '# credentials\nSECRET=' + SECRETS.anthropic + '\n');
process.env.CWM_CLAUDE_DIR = claudeHome;
process.env.CWM_MIGRATE_STANDARDS_STOP = sb.root;

let env;
let spawns = [];
const repo = path.join(sb.work, 'repo');
const src = { id: crypto.randomUUID() };
const src2 = { id: crypto.randomUUID() };
const src3 = { id: crypto.randomUUID() };
let mig1;

/**
 * Wait until a migration reaches one of some states.
 *
 * @param {string} id - Migration id.
 * @param {string[]} states - Target states.
 * @param {number} [ms] - Timeout.
 * @returns {Promise<object>} The MigrationSnapshot.
 */
async function waitState(id, states, ms) {
  let last = null;
  await kit.until(async () => {
    const r = await env.api('GET', '/migrations/' + id);
    last = r.body;
    if (last && ['failed', 'needsAttention'].includes(last.state) && !states.includes(last.state)) throw new Error('migration stopped: ' + JSON.stringify(last.error) + ' steps ' + JSON.stringify(last.steps.map((s) => [s.key, s.state, s.detail])));
    return last && states.includes(last.state);
  }, ms || STATE_WAIT_MS, 'migration ' + id + ' to reach ' + states.join('|'));
  return last;
}

/**
 * Start a migration.
 *
 * @param {string} sessionId - Source phone id.
 * @param {object} body - MigrationStartRequest fields.
 * @param {string} [key] - Idempotency-Key.
 * @returns {Promise<object>}
 */
function start(sessionId, body, key) {
  return env.api('POST', '/sessions/' + sessionId + '/migrations', Object.assign({
    target: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', accountId: null },
    mode: 'takeover', depth: 'standard', focus: null, sourcePolicy: 'pause', readerModel: null, name: null, tabGroupId: null, startWhileBusy: false, confirmCost: false, fromMessageId: null,
  }, body), key === null ? {} : { 'Idempotency-Key': key || crypto.randomUUID() });
}

/**
 * Every file under a folder.
 *
 * @param {string} dir - Folder.
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

kit.test('boot with PTYs, a git repo, three sources and a tab group', async () => {
  // Every PTY spawn is recorded (the argv of the shell), so the suite can
  // prove that no free text reaches a command line (W2).
  const nodePty = require('node-pty');
  const realSpawn = nodePty.spawn;
  nodePty.spawn = function recordSpawn(file, args, opts) {
    spawns.push({ file, args: Array.isArray(args) ? args.slice() : [String(args)] });
    return realSpawn.apply(this, arguments);
  };
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => childProcess.spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Project rules\n\nTests before commits.\n');
  git(['add', '.']);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  env = await kit.bootWorkspace({ pty: true, chat: { screenModel: true } });
  const ws = env.store.createWorkspace({ name: 'Migrate project' });
  const mk = (s, name, exchanges) => {
    s.file = kit.writeClaude(sb.projects, repo, s.id, [].concat(...exchanges.map((t) => kit.claudeExchange(t))));
    s.rec = kit.tracked(env.store, { workspaceId: ws.id, provider: 'claude', workingDir: repo, resumeSessionId: s.id, name });
    s.phone = 'cl_' + s.id;
  };
  mk(src, 'Pairing work', ['build the pairing screen with key ' + SECRETS.anthropic, 'connect to postgres://app:' + SECRETS.dbPassword + '@db.example.com/prod', 'ship it']);
  mk(src2, 'Cancel me', ['first ask', 'second ask']);
  mk(src3, 'Cut me', ['alpha question', 'beta question', 'gamma question', 'delta question']);
  env.chat.internals.index.invalidate();
  env.ws.internals.layoutStore.putFromDesktop({
    tabGroups: [{ id: 'tg_main', name: 'Main', panes: [{ slot: 0, sessionId: src.rec.id, sessionName: 'Pairing work', provider: 'claude', spawnOpts: {} }, { slot: 1, sessionId: src2.rec.id, sessionName: 'Cancel me', provider: 'claude', spawnOpts: {} }] }],
    tabFolders: [],
    activeGroupId: 'tg_main',
  });
  kit.eq((await env.api('GET', '/tabs')).body.tabs.groups[0].sessionIds, [src.phone, src2.phone]);
});

kit.test('preview fills the sheet and builds the index in the background', async () => {
  const body = { target: { provider: 'claude', model: null, effort: null }, depth: null, mode: null, fromMessageId: null };
  const r = await env.api('POST', '/sessions/' + src.phone + '/migrations/preview', body);
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'migrate/migration-preview.json');
  kit.eq([r.body.source.sessionId, r.body.source.bytes, r.body.forkAllowed], [src.phone, fs.statSync(src.file).size, true]);
  kit.ok(['building', 'ready'].includes(r.body.index.state), r.body.index.state);
  let ready = null;
  await kit.until(async () => {
    ready = (await env.api('POST', '/sessions/' + src.phone + '/migrations/preview', body)).body;
    return ready.index.state === 'ready';
  }, 20000, 'the index');
  kit.eq([ready.source.turns, ready.plan.tier, ready.index.formatDrift], [3, 'S', false]);
  kit.ok(ready.models.some((m) => m.id === 'claude-opus-5-5'), 'model choices');
  const cross = await env.api('POST', '/sessions/' + src.phone + '/migrations/preview', { target: { provider: 'codex', model: null, effort: null } });
  kit.eq([cross.body.forkAllowed, cross.body.forkDisallowedReason], [false, 'Continue as is keeps the same provider.']);
  kit.ok(cross.body.warnings.some((w) => w.code === 'CROSS_PROVIDER' && w.message === 'This history will be read by OpenAI models.'), JSON.stringify(cross.body.warnings));
  const unknown = await env.api('POST', '/sessions/' + src.phone + '/migrations/preview', Object.assign({}, body, { fromMessageId: crypto.randomUUID() }));
  kit.eq([unknown.status, unknown.body.code], [404, 'MESSAGE_NOT_FOUND']);
  const bad = await env.api('POST', '/sessions/' + src.phone + '/migrations/preview', { target: { provider: 'gemini' } });
  kit.eq([bad.status, bad.body.code], [422, 'INVALID_TARGET']);
  const none = await env.api('POST', '/sessions/cl_' + crypto.randomUUID() + '/migrations/preview', body);
  kit.eq([none.status, none.body.code], [404, 'SESSION_NOT_FOUND']);
});

kit.test('start needs an Idempotency-Key and valid fields', async () => {
  const noKey = await start(src.phone, {}, null);
  kit.eq([noKey.status, noKey.body.code], [428, 'IDEMPOTENCY_KEY_REQUIRED']);
  const noModel = await start(src.phone, { target: { provider: 'claude', model: null } });
  kit.eq([noModel.status, noModel.body.code], [422, 'INVALID_TARGET']);
  const longFocus = await start(src.phone, { focus: 'x'.repeat(4001) });
  kit.eq([longFocus.status, longFocus.body.code, longFocus.body.field], [400, 'INVALID_FIELD', 'focus']);
  const exhaustive = await start(src.phone, { depth: 'exhaustive' });
  kit.eq([exhaustive.status, exhaustive.body.code], [409, 'COST_CONFIRM_REQUIRED']);
});

kit.test('the takeover runs end to end to awaitingApproval', async () => {
  const s = await kit.openStream(env.base, env.device.token);
  await s.next((f) => f.type === 'ready');
  s.send({ type: 'subscribe', id: 'm1', epoch: null, topics: [{ topic: 'migrations', sinceSeq: null }, { topic: 'session:' + src.phone, sinceSeq: null }] });
  await s.next((f) => f.type === 'subscribed');
  const key = crypto.randomUUID();
  const r = await start(src.phone, { focus: FOCUS }, key);
  kit.eq(r.status, 202, JSON.stringify(r.body));
  kit.validate(r.body, 'migrate/migration.json');
  mig1 = r.body.migrationId;
  kit.ok(/^mg_[A-Za-z0-9_-]{22}$/.test(mig1), mig1);
  const repeat = await start(src.phone, { focus: FOCUS }, key);
  kit.eq([repeat.status, repeat.body.migrationId], [202, mig1], 'an Idempotency-Key repeat returns the same migration');
  const snap = await waitState(mig1, ['awaitingApproval']);
  kit.validate(snap, 'migrate/migration.json');
  kit.eq(snap.steps.map((x) => [x.key, x.state]), [['snapshot', 'done'], ['index', 'done'], ['standards', 'done'], ['reading', 'done'], ['verifying', 'done'], ['report', 'done']]);
  kit.eq([snap.plan.tier, snap.report.ready, snap.report.header.claimsChecked, snap.report.header.solvedVerified, snap.report.header.learned], ['S', true, 3, 1, 1]);
  kit.ok(/source paused/.test(snap.steps[0].detail), snap.steps[0].detail);
  const frames = s.frames.filter((f) => f.type === 'migration.progress' && f.data.migration.migrationId === mig1);
  for (const f of frames) kit.validateFrame(f);
  const states = Array.from(new Set(frames.map((f) => f.data.migration.state)));
  for (const want of ['queued', 'snapshotting', 'indexing', 'packing', 'launching', 'reading', 'awaitingApproval']) kit.ok(states.includes(want), 'state ' + want + ' seen in ' + states.join(','));
  kit.ok(frames.some((f) => f.data.migration.steps.find((x) => x.key === 'reading' && x.done === 2 && x.total === 2)), 'MIGRATE: reading 2/2 reached the step');
  // The source's session.meta carries its new lineage (B3 publishes it at the link).
  const meta = s.frames.find((f) => f.topic === 'session:' + src.phone && f.type === 'session.meta' && f.data.lineage && f.data.lineage.handedOffTo && f.data.lineage.handedOffTo.migrationId === mig1);
  kit.ok(meta, 'session.meta with lineage on the source topic');
  kit.validateFrame(meta);
  kit.eq(meta.data.lineage.handedOffTo.sessionId, snap.targetSessionId);
  const push = env.pushEvents.find((e) => e.kind === 'migration' && e.migrationId === mig1);
  kit.eq([push.state, push.targetSessionId, push.claimsFailed, push.targetTitle], ['awaitingApproval', snap.targetSessionId, 0, 'Pairing work takeover']);
  s.close();
});

kit.test('no command line carries the focus text; the Claude takeover flags are there', async () => {
  const lines = spawns.map((x) => x.args.join(' '));
  for (const l of lines) {
    kit.ok(!l.includes('pairing tests') && !l.includes('rm -rf') && !l.includes(SECRETS.github), 'no focus text in: ' + l);
    kit.ok(!l.includes('Begin the takeover'), 'the kickoff is a send, not an argument');
  }
  const snap = (await env.api('GET', '/migrations/' + mig1)).body;
  const packDir = path.join(process.env.CWM_DATA_DIR, 'migrations', mig1);
  const takeover = lines.find((l) => l.includes('--append-system-prompt-file'));
  kit.ok(takeover, 'the takeover spawn: ' + lines.join(' | '));
  kit.ok(takeover.includes('--append-system-prompt-file ' + path.join(packDir, 'CHARTER.md')), takeover);
  kit.ok(takeover.includes('--add-dir ' + packDir), takeover);
  kit.ok(/--permission-mode plan/.test(takeover) && /--effort high/.test(takeover), takeover);
  kit.ok(/--model claude-opus-5-5( |$)/.test(takeover), 'the model is bare on the cmd.exe line: ' + takeover);
  kit.ok(takeover.includes('--session-id ' + snap.targetSessionId.slice(3)), 'the minted session id is the target id');
  kit.ok(!/--dangerously-skip-permissions/.test(takeover), 'review never bypasses permissions');
});

kit.test('the pack: charter sections, focus as a file, standards without credentials, no secret anywhere', async () => {
  const root = path.join(process.env.CWM_DATA_DIR, 'migrations');
  const packDir = path.join(root, mig1);
  const job = JSON.parse(fs.readFileSync(path.join(packDir, 'job.json'), 'utf8'));
  kit.eq(job.state, 'awaitingApproval', 'job.json is written after every transition');
  const charterText = fs.readFileSync(path.join(packDir, 'CHARTER.md'), 'utf8');
  kit.ok(charterText.includes('Solved and verified') && charterText.includes('Learned (environment facts'), 'A20 and F15');
  kit.ok(!/\{\{[A-Z_]+\}\}/.test(charterText), 'filled');
  kit.ok(fs.readFileSync(path.join(packDir, 'FOCUS.md'), 'utf8').includes('Check the pairing tests first'), 'focus in FOCUS.md');
  const standards = fs.readdirSync(path.join(packDir, 'standards'));
  kit.ok(standards.includes('global-CLAUDE.md') && standards.includes('up00-CLAUDE.md'), standards.join(','));
  kit.ok(standards.every((n) => !/credentials/i.test(n)), 'no credentials.md');
  for (const file of walk(root)) {
    const t = fs.readFileSync(file, 'utf8');
    for (const v of Object.values(SECRETS)) kit.ok(!t.includes(v), 'secret in ' + path.relative(root, file));
    kit.ok(!t.includes('# credentials'), 'credentials.md content in ' + path.relative(root, file));
  }
  kit.ok(/\[redacted:anthropic:[0-9a-f]{8}\]/.test(fs.readFileSync(path.join(packDir, 'user-messages.md'), 'utf8')), 'redaction markers');
  kit.ok(fs.existsSync(path.join(packDir, 'TAKEOVER.md')), 'the report is saved in the pack');
});

kit.test('lineage, hand off, placement and the report', async () => {
  const snap = (await env.api('GET', '/migrations/' + mig1)).body;
  const target = snap.targetSessionId;
  const srcDetail = (await env.api('GET', '/sessions/' + src.phone)).body;
  kit.eq(srcDetail.meta.owner, 'handedOff');
  kit.ok(/^Handed off to Pairing work takeover/.test(srcDetail.meta.readOnlyReason || ''), srcDetail.meta.readOnlyReason);
  // Lineage as B3 keeps it (workspace.lineage.of; B2's session index is to read it, contract 3.6.1 item 2).
  const srcLineage = env.ws.lineage.of(src.phone);
  kit.eq([srcLineage.handedOffTo.sessionId, srcLineage.handedOffTo.migrationId, srcLineage.migratedFrom], [target, mig1, null]);
  kit.validate(srcLineage, 'sessions/lineage.json');
  const send = await env.api('POST', '/sessions/' + src.phone + '/send', { clientMessageId: crypto.randomUUID(), text: 'still there?' });
  kit.eq([send.status, send.body.code], [409, 'SESSION_READ_ONLY']);
  const tgt = (await env.api('GET', '/sessions/' + target)).body;
  const tgtLineage = env.ws.lineage.of(target);
  kit.eq([tgtLineage.migratedFrom.sessionId, tgtLineage.migratedFrom.migrationId, tgt.meta.title], [src.phone, mig1, 'Pairing work takeover']);
  kit.eq((await env.api('GET', '/tabs')).body.tabs.groups[0].sessionIds, [src.phone, target, src2.phone], 'right after the source in its tab group');
  const rep = await env.api('GET', '/migrations/' + mig1 + '/report');
  kit.eq(rep.status, 200, JSON.stringify(rep.body));
  kit.validate(rep.body, 'migrate/migration-report.json');
  kit.eq([rep.body.coveragePercent, rep.body.tripwire, rep.body.header.claimsFailed], [100, { changed: false, diffStat: null }, 0]);
  kit.ok(rep.body.markdown.includes('Takeover report'), 'markdown');
  const turn = await env.api('GET', '/migrations/' + mig1 + '/turns/1');
  kit.eq(turn.status, 200, JSON.stringify(turn.body));
  kit.validate(turn.body, 'migrate/migration-turn.json');
  kit.ok(turn.body.user.includes('build the pairing screen') && !turn.body.user.includes(SECRETS.anthropic), turn.body.user);
  kit.eq(turn.body.rawPath, src.file);
  const missing = await env.api('GET', '/migrations/' + mig1 + '/turns/99');
  kit.eq([missing.status, missing.body.code], [404, 'TURN_NOT_FOUND']);
  const list = await env.api('GET', '/migrations?sessionId=' + encodeURIComponent(src.phone));
  kit.validate(list.body, 'migrate/migrations-list.json');
  kit.eq(list.body.migrations.map((m) => m.migrationId), [mig1]);
  const byTarget = await env.api('GET', '/migrations?sessionId=' + encodeURIComponent(target));
  kit.eq(byTarget.body.migrations.length, 1, 'either side finds it');
  const nf = await env.api('GET', '/migrations/mg_nope');
  kit.eq([nf.status, nf.body.code], [404, 'MIGRATION_NOT_FOUND']);
});

kit.test('approve answers the plan dialog; the migration completes', async () => {
  const r = await env.api('POST', '/migrations/' + mig1 + '/approve', { note: null });
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'migrate/migration.json');
  kit.ok(['continuing', 'completed'].includes(r.body.state), r.body.state);
  await waitState(mig1, ['completed'], 30000);
  const target = r.body.targetSessionId;
  const ref = env.chat.sessions.resolve(target);
  await kit.until(() => fs.readFileSync(ref.transcriptPath, 'utf8').includes('User has approved your plan'), 15000, 'the approval in the target transcript');
  kit.ok(fs.readFileSync(ref.transcriptPath, 'utf8').includes('"permissionMode":"default"'), 'left plan mode for the source\'s normal mode (manual approvals)');
  const again = await env.api('POST', '/migrations/' + mig1 + '/approve', { note: null });
  kit.eq([again.status, again.body.code], [409, 'MIGRATION_NOT_AWAITING']);
  const late = await env.api('POST', '/migrations/' + mig1 + '/cancel');
  kit.eq([late.status, late.body.code], [409, 'MIGRATION_NOT_CANCELLABLE']);
  const retry = await env.api('POST', '/migrations/' + mig1 + '/retry', { fromStage: null });
  kit.eq([retry.status, retry.body.code], [409, 'MIGRATION_NOT_RETRYABLE']);
  kit.ok(env.auditEntries.some((e) => e.action === 'migrationStart') && env.auditEntries.some((e) => e.action === 'migrationApprove'), 'audit lines');
});

kit.test('a restart resumes a job from its job.json', async () => {
  const root = path.join(process.env.CWM_DATA_DIR, 'migrations');
  const job = JSON.parse(fs.readFileSync(path.join(root, mig1, 'job.json'), 'utf8'));
  const id = 'mg_' + crypto.randomBytes(16).toString('base64url');
  // As if Workbook stopped while this job was indexing: the snapshot is done,
  // nothing after it ran, no target exists yet.
  job.migrationId = id;
  job.state = 'indexing';
  job.targetSessionId = null;
  job.report = { ready: false, header: null };
  job.coverage = null;
  job.tripwire = null;
  job.steps = job.steps.map((st) => (st.key === 'snapshot' ? st : Object.assign({}, st, { state: 'pending', detail: null, done: null, total: null, startedAtMs: null, endedAtMs: null })));
  job._.idempotencyKey = crypto.randomUUID();
  job._.name = 'Resumed takeover';
  job._.tailOffset = 0;
  job._.reportToolUseId = null;
  job._.approvedAtMs = null;
  job._.placement = { tabGroupId: null, afterSessionId: null };
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'job.json'), JSON.stringify(job));
  const { createMigrations } = require('../../src/web/mobile/workspace/migrate/jobs');
  const i = env.ws.internals;
  const engine = createMigrations({ ctx: env.ctx, flags: i.flags, tabs: i.tabs, settings: i.settings, accounts: i.accounts, schema: i.schema, useWorker: true });
  try {
    engine.load();
    await kit.until(() => { const j = engine._job(id); if (j && j.state === 'failed') throw new Error(JSON.stringify(j.error)); return j && j.state === 'awaitingApproval'; }, STATE_WAIT_MS, 'the resumed job');
    const j = engine.get(id);
    kit.eq(j.steps.map((st) => st.state), ['done', 'done', 'done', 'done', 'done', 'done']);
    kit.ok(j.targetSessionId && j.targetSessionId.startsWith('cl_'), 'a new target launched');
    kit.eq(engine.get(mig1).state, 'completed', 'the finished job is loaded and left alone');
    await engine.cancel(id, { deviceId: null });
  } finally {
    engine.stop();
  }
});

kit.test('MIGRATION_ACTIVE, then cancel archives the target and clears the hand off and lineage', async () => {
  const r = await start(src2.phone, {});
  kit.eq(r.status, 202, JSON.stringify(r.body));
  const id = r.body.migrationId;
  const second = await start(src2.phone, {});
  kit.eq([second.status, second.body.code], [409, 'MIGRATION_ACTIVE']);
  const snap = await waitState(id, ['reading', 'verifying', 'reporting', 'awaitingApproval']);
  const target = snap.targetSessionId;
  kit.eq((await env.api('GET', '/sessions/' + src2.phone)).body.meta.owner, 'handedOff');
  const c = await env.api('POST', '/migrations/' + id + '/cancel');
  kit.eq(c.status, 200, JSON.stringify(c.body));
  kit.validate(c.body, 'migrate/migration.json');
  kit.eq(c.body.state, 'cancelled');
  const tgt = (await env.api('GET', '/sessions/' + target)).body.meta;
  kit.eq([tgt.archived, env.ws.lineage.of(target)], [true, null]);
  const srcMeta = (await env.api('GET', '/sessions/' + src2.phone)).body.meta;
  kit.ok(srcMeta.owner !== 'handedOff', 'the hand off is cleared: ' + srcMeta.owner);
  kit.eq([srcMeta.readOnlyReason, env.ws.lineage.of(src2.phone)], [null, null]);
  const tRef = env.chat.sessions.resolve(target);
  await kit.until(() => !env.pm.getSession(tRef.workbookSessionId) || !env.pm.getSession(tRef.workbookSessionId).alive, 15000, 'the target process stopped');
  kit.ok(fs.existsSync(path.join(process.env.CWM_DATA_DIR, 'migrations', id, 'CHARTER.md')), 'the pack is kept');
  const recent = await env.api('GET', '/sessions/recent');
  kit.ok(!recent.body.sessions.some((x) => x.sessionId === target), 'the archived target leaves the lists');
});

kit.test('a fromMessageId start packs only the history up to that message', async () => {
  const page = await env.api('GET', '/sessions/' + src3.phone + '/messages');
  const assistants = page.body.messages.filter((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && /Reply to beta question/.test(p.text || '')));
  kit.eq(assistants.length, 1, JSON.stringify(page.body.messages.map((m) => [m.role, m.parts.map((p) => p.type)])));
  const r = await start(src3.phone, { fromMessageId: assistants[0].id, sourcePolicy: 'leave' });
  kit.eq(r.status, 202, JSON.stringify(r.body));
  const id = r.body.migrationId;
  await waitState(id, ['reading', 'verifying', 'reporting', 'awaitingApproval']);
  const packDir = path.join(process.env.CWM_DATA_DIR, 'migrations', id);
  const um = fs.readFileSync(path.join(packDir, 'user-messages.md'), 'utf8');
  kit.ok(um.includes('alpha question') && um.includes('beta question'), 'up to the message');
  kit.ok(!um.includes('gamma question') && !um.includes('delta question'), 'nothing after it');
  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
  kit.ok(manifest.snapshot.bytes < fs.statSync(src3.file).size && manifest.snapshot.cutAtMessage === assistants[0].id, JSON.stringify(manifest.snapshot));
  kit.ok((await env.api('GET', '/sessions/' + src3.phone)).body.meta.owner !== 'handedOff', 'leave running: no hand off');
  await env.api('POST', '/migrations/' + id + '/cancel');
});

kit.run(async () => { if (env) await env.close(); });
