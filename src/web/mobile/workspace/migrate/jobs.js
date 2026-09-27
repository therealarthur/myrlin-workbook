/**
 * migrate/jobs.js: the migration engine (PROTOCOL.md 3.12, 4.12; R08
 * sections 4 to 9; decisions A20; critic F13 to F15).
 *
 * WHY: a takeover is a long job (minutes to hours) that must survive a
 * Workbook restart, so every job lives in its pack folder as job.json,
 * written atomically after every transition, and resumes from its stage on
 * start (R08:527). The lifecycle: queued, snapshotting (freeze the source:
 * pause it by default, record its length and hashes and the git state),
 * indexing (the deterministic index in a worker thread), packing (standards,
 * git.md, the charter), launching (the takeover session through B2, no free
 * text on a command line), reading and verifying (progress from the target's
 * own transcript), reporting, awaitingApproval (the report is the target's
 * first message; nothing is continued without approval, A20), continuing and
 * completed; failed, cancelled and needsAttention on the side. Every change
 * publishes migration.progress with the whole snapshot, and the states a
 * person must act on send a push (awaitingApproval, failed, needsAttention).
 *
 * Lineage (PROTOCOL.md 3.4.7): the target's migratedFrom and the source's
 * handedOffTo, kept in <dataDir>/mobile/lineage.json and served through
 * workspace.lineage.of for B2's session index.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const common = require('../common');
const pack = require('./pack');
const report = require('./report');
const charter = require('./charter');
const { createProgressWatcher } = require('./progress');
const { createMigrationLauncher } = require('./launch');
const { redact } = require('./redact');

/** Step keys and labels, in order (PROTOCOL.md 3.12, DESIGN-SPEC 16.3). */
const STEPS = Object.freeze([
  ['snapshot', 'Snapshot frozen'],
  ['index', 'Index built'],
  ['standards', 'Standards and git state'],
  ['reading', 'Reading history'],
  ['verifying', 'Checking claims against the repo'],
  ['report', 'Takeover report'],
]);
const STEP_KEYS = STEPS.map((s) => s[0]);
/** States after which nothing runs. */
const TERMINAL = new Set(['completed', 'cancelled']);
/** States the phone may cancel in (PROTOCOL.md 4.12.4: before continuing). */
const CANCELLABLE = new Set(['queued', 'snapshotting', 'indexing', 'packing', 'launching', 'reading', 'verifying', 'reporting', 'awaitingApproval', 'failed', 'needsAttention']);
/** States a retry starts from. */
const RETRYABLE = new Set(['failed', 'needsAttention']);
/** Size guard of "Continue as is" (R08:475, PROTOCOL.md 4.5.8). */
const FORK_MAX_BYTES = 200 * 1024 * 1024;
/** Longest focus note (PROTOCOL.md 4.12.2). */
const FOCUS_MAX = 4000;
/** Longest target name. */
const NAME_MAX = 200;
/** Model id rule (the settings schema's). */
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/** Stage timeouts without progress, by tier (R08 section 9.1 row 9). */
const STAGE_TIMEOUT_MS = Object.freeze({ S: 20 * 60 * 1000, M: 60 * 60 * 1000, L: 150 * 60 * 1000 });
/** How often the stage timeout and staleness are checked. */
const CHECK_MS = 30 * 1000;
/** Migrations listed per page (PROTOCOL.md 4.12.3). */
const LIST_DEFAULT = 20;
const LIST_MAX = 100;
/** Free disk needed before a start: this floor, or a share of the source. */
const DISK_FLOOR_BYTES = 512 * 1024 * 1024;
const DISK_SHARE = 0.25;
/** Headroom under which the preview warns (ACCOUNT_LOW). */
const ACCOUNT_LOW_HEADROOM = 25;
/** The fixed nudges (never free text). */
const CONTINUE_READING = 'Continue the takeover described in your instructions.';
const WRITE_REPORT_NOW = 'Write the takeover report now with what you have, then stop as your instructions say.';
const CODEX_APPROVED = 'Approved. Proceed with the plan.';
/** Option labels naming a Claude permission mode in the ExitPlanMode dialog (PROTOCOL.md 4.12.4). */
const MODE_OPTION_RES = Object.freeze({ bypassPermissions: /bypass permissions/i, acceptEdits: /auto-accept edits|accept edits/i });
const MANUAL_OPTION_RE = /manually approve edits/i;

/**
 * Create the migration engine.
 *
 * @param {object} deps - {ctx, now, flags, tabs, settings, accounts, schema, useWorker}
 * @returns {object}
 */
function createMigrations(deps) {
  const ctx = deps.ctx;
  const now = deps.now || Date.now;
  const log = common.logger(ctx);
  const launcher = createMigrationLauncher({ ctx, log });
  const root = path.join(ctx.dataDir || require('../../../../utils/data-dir').getDataDir(), 'migrations');
  const lineageFile = path.join(common.mobileDir(ctx), 'lineage.json');
  const lineage = common.readJson(lineageFile, {}) || {};
  const jobs = new Map();
  const watchers = new Map();
  const running = new Set();
  const lastProgressAt = new Map();
  const unsubs = [];
  const chat = () => (ctx.mobile && ctx.mobile.chat) || null;

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * The wire MigrationSnapshot of a job (private fields removed).
   *
   * @param {object} job - Job.
   * @returns {object}
   */
  function snapshotOf(job) {
    const out = {};
    for (const [k, v] of Object.entries(job)) if (k !== '_') out[k] = v;
    return JSON.parse(JSON.stringify(out));
  }

  /**
   * Persist, publish migration.progress, and send the push a state needs.
   *
   * @param {object} job - Job.
   * @param {string|null} [prevState] - The state before this change.
   */
  function save(job, prevState) {
    job.updatedAtMs = now();
    try {
      fs.mkdirSync(job._.packDir, { recursive: true });
      common.writeJson(path.join(job._.packDir, 'job.json'), job);
    } catch (err) {
      log('job write failed: ' + (err && err.code));
    }
    common.publish(ctx, 'migrations', 'migration.progress', { migration: snapshotOf(job) });
    if (prevState !== undefined && prevState !== job.state && ['awaitingApproval', 'failed', 'needsAttention'].includes(job.state)) {
      const failedStep = job.steps.find((s) => s.state === 'failed');
      common.notify(ctx, {
        kind: 'migration',
        migrationId: job.migrationId,
        targetSessionId: job.targetSessionId,
        targetTitle: job._.name,
        state: job.state,
        claimsFailed: job.report && job.report.header ? job.report.header.claimsFailed : 0,
        failedStepLabel: failedStep ? failedStep.label : null,
      });
    }
  }

  /**
   * Change state and save.
   *
   * @param {object} job - Job.
   * @param {string} state - New state.
   */
  function setState(job, state) {
    const prev = job.state;
    job.state = state;
    save(job, prev);
  }

  /**
   * Update a step and save.
   *
   * @param {object} job - Job.
   * @param {string} key - Step key.
   * @param {object} patch - Fields.
   */
  function step(job, key, patch) {
    const s = job.steps.find((x) => x.key === key);
    if (!s) return;
    if (patch.state === 'running' && s.state !== 'running') { s.startedAtMs = now(); s.endedAtMs = null; }
    if ((patch.state === 'done' || patch.state === 'failed' || patch.state === 'skipped') && !s.endedAtMs) s.endedAtMs = now();
    Object.assign(s, patch);
    save(job);
  }

  // ── Lineage ─────────────────────────────────────────────────────────────

  /** Persist lineage atomically. */
  function saveLineage() {
    try { common.writeJson(lineageFile, lineage); } catch (err) { log('lineage write failed: ' + (err && err.code)); }
  }

  /**
   * The Lineage of a session (PROTOCOL.md 3.4.7), or null.
   *
   * @param {string} sessionId - Phone id.
   * @returns {{migratedFrom: (object|null), handedOffTo: (object|null)}|null}
   */
  function lineageOf(sessionId) {
    const l = lineage[sessionId];
    if (!l || (!l.migratedFrom && !l.handedOffTo)) return null;
    return { migratedFrom: l.migratedFrom || null, handedOffTo: l.handedOffTo || null };
  }

  /**
   * Link a migration's source and target.
   *
   * @param {object} job - Job with targetSessionId.
   */
  function link(job) {
    const atMs = now();
    lineage[job.targetSessionId] = Object.assign({}, lineage[job.targetSessionId] || {}, { migratedFrom: { sessionId: job.sourceSessionId, migrationId: job.migrationId, atMs } });
    lineage[job.sourceSessionId] = Object.assign({}, lineage[job.sourceSessionId] || {}, { handedOffTo: { sessionId: job.targetSessionId, migrationId: job.migrationId, atMs } });
    saveLineage();
    announce(job.targetSessionId);
    announce(job.sourceSessionId);
  }

  /**
   * Remove both links of a migration (cancel).
   *
   * @param {object} job - Job.
   */
  function unlink(job) {
    for (const id of [job.sourceSessionId, job.targetSessionId]) {
      const l = id && lineage[id];
      if (!l) continue;
      if (l.migratedFrom && l.migratedFrom.migrationId === job.migrationId) l.migratedFrom = null;
      if (l.handedOffTo && l.handedOffTo.migrationId === job.migrationId) l.handedOffTo = null;
      if (!l.migratedFrom && !l.handedOffTo) delete lineage[id];
    }
    saveLineage();
    if (job.targetSessionId) announce(job.targetSessionId);
    announce(job.sourceSessionId);
  }

  /**
   * session.meta and sessions.changed for a session whose lineage or owner changed.
   *
   * @param {string} sessionId - Phone id.
   */
  function announce(sessionId) {
    const c = chat();
    if (!c || !c.sessions || !sessionId) return;
    try {
      c.sessions.noteChanged(sessionId, 'updated');
      const meta = c.sessions.meta(sessionId);
      if (meta) {
        if (!meta.lineage) meta.lineage = lineageOf(sessionId);
        common.publish(ctx, 'session:' + sessionId, 'session.meta', meta);
      }
    } catch (_) { /* announce is best effort */ }
  }

  /**
   * A wb_ target learned its upstream id: move lineage and the job's id.
   *
   * @param {string} oldId - Previous id.
   * @param {string} newId - New id.
   */
  function rekey(oldId, newId) {
    let changed = false;
    if (lineage[oldId]) { lineage[newId] = Object.assign({}, lineage[oldId], lineage[newId] || {}); delete lineage[oldId]; changed = true; }
    for (const l of Object.values(lineage)) {
      for (const k of ['migratedFrom', 'handedOffTo']) if (l[k] && l[k].sessionId === oldId) { l[k].sessionId = newId; changed = true; }
    }
    if (changed) saveLineage();
    for (const job of jobs.values()) {
      if (job.targetSessionId === oldId) {
        job.targetSessionId = newId;
        const w = watchers.get(job.migrationId);
        if (w) w.resetPath();
        if (job.sourceSessionId && job.sourcePolicy === 'pause' && !TERMINAL.has(job.state)) {
          try { chat().sessions.setHandedOff(job.sourceSessionId, { targetSessionId: newId, targetTitle: job._.name, migrationId: job.migrationId }); } catch (_) { /* best effort */ }
        }
        save(job);
      }
    }
  }

  // ── Sources ─────────────────────────────────────────────────────────────

  /**
   * Resolve a session or answer 404.
   *
   * @param {string} sessionId - Phone id.
   * @returns {object} SessionRef.
   */
  function resolveSource(sessionId) {
    const c = chat();
    const ref = c && c.sessions ? c.sessions.resolve(sessionId) : null;
    if (!ref) common.fail('SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    return ref;
  }

  /**
   * The end offset of a message (the end of its last transcript line), for
   * a fromMessageId cut (PROTOCOL.md 4.12.1). 404 MESSAGE_NOT_FOUND.
   *
   * @param {object} ref - SessionRef.
   * @param {string} messageId - Message id.
   * @returns {number}
   */
  function cutOffset(ref, messageId) {
    if (typeof messageId !== 'string' || !messageId) common.fail('MESSAGE_NOT_FOUND', 'That message does not exist in this session.');
    let off = null;
    try {
      const reader = require('../../chat/transcript-reader');
      const mapper = ref.provider === 'codex' ? require('../../chat/codex-messages').createCodexMapper() : require('../../chat/claude-messages').createClaudeMapper(); // gsd:provider-literal-allowed (mobile v2 migrations)
      off = reader.findMessageOffset(ref.transcriptPath, messageId, mapper);
    } catch (_) {
      off = null;
    }
    if (off === null || off === undefined) common.fail('MESSAGE_NOT_FOUND', 'That message does not exist in this session.');
    // Extend over the lines of the same message (Claude writes one line per
    // content block of an assistant message, sharing message.id).
    const fd = fs.openSync(ref.transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      let pos = off;
      let key = null;
      let end = off;
      const buf = Buffer.alloc(4 * 1024 * 1024);
      let carry = Buffer.alloc(0);
      let base = off;
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        if (n <= 0) break;
        const data = Buffer.concat([carry, buf.subarray(0, n)]);
        pos += n;
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl === -1) break;
          let r = null;
          try { r = JSON.parse(data.subarray(start, nl).toString('utf8')); } catch (_) { r = null; }
          const k = r && r.type === 'assistant' && r.message && r.message.id ? 'a:' + r.message.id : null;
          if (key === null) { key = k || 'single'; end = base + nl + 1; if (!k || ref.provider === 'codex') return end; } // gsd:provider-literal-allowed (mobile v2 migrations)
          else if (k && k === key) end = base + nl + 1;
          else if (r && (r.type === 'assistant' || r.type === 'user')) return end;
          start = nl + 1;
        }
        base += start;
        carry = Buffer.from(data.subarray(start));
      }
      return end;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Whether a session's process runs or its turn is open.
   *
   * @param {object} ref - SessionRef.
   * @returns {boolean}
   */
  function running_(ref) {
    return ['workbook', 'background', 'external', 'chatgpt'].includes(ref.owner) || launcher.turnOpen(ref.sessionId);
  }

  // ── Preview ─────────────────────────────────────────────────────────────

  /**
   * Accounts of the target provider for the sheet (PROTOCOL.md 4.12.1).
   *
   * @param {string} provider - Target provider.
   * @returns {object[]}
   */
  function previewAccounts(provider) {
    let snap = null;
    try { snap = deps.accounts ? deps.accounts.snapshot() : null; } catch (_) { snap = null; }
    const pr = snap ? snap.providers.find((x) => x.provider === provider) : null;
    if (!pr) return [];
    const usable = pr.accounts.filter((a) => a.swappable);
    let rec = pr.recommendation ? pr.recommendation.accountId : null;
    if (!rec && usable.length) rec = usable.slice().sort((a, b) => (b.headroom || 0) - (a.headroom || 0))[0].accountId;
    return pr.accounts.map((a) => {
      const ringed = a.windows.filter((w) => w.ring !== 'none');
      const worst = ringed.slice().sort((x, y) => y.percent - x.percent)[0] || null;
      return { provider, accountId: a.accountId, displayName: a.displayName, headroom: a.headroom, resetsAtMs: worst ? worst.resetsAtMs || null : null, recommended: a.accountId === rec };
    });
  }

  /**
   * Model choices for the target provider (PROTOCOL.md 4.12.1 models).
   *
   * @param {string} provider - Target provider.
   * @returns {object[]}
   */
  function models(provider) {
    const schemaMod = require('../settings-schema');
    const out = [];
    const seen = new Set();
    const add = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const k = schemaMod.KNOWN_MODELS[id];
      out.push({ provider, id, label: k ? k.label : id, contextTokens: k ? k.contextTokens : null });
    };
    try { for (const o of deps.schema.suggestions(provider)) add(o.value); } catch (_) { /* no suggestions */ }
    for (const [id, k] of Object.entries(schemaMod.KNOWN_MODELS)) if (k.provider === provider) add(id);
    return out;
  }

  /**
   * POST /sessions/:sessionId/migrations/preview (PROTOCOL.md 4.12.1):
   * fills the sheet and starts (or reuses) the index in the background.
   *
   * @param {string} sessionId - Source phone id.
   * @param {object} body - MigrationPreviewRequest.
   * @returns {object} MigrationPreview.
   */
  function preview(sessionId, body) {
    const ref = resolveSource(sessionId);
    const b = body && typeof body === 'object' ? body : {};
    const target = b.target && typeof b.target === 'object' ? b.target : {};
    if (!common.AGENT_PROVIDERS.includes(target.provider)) common.fail('INVALID_TARGET', 'Choose Claude or Codex for the takeover.');
    if (target.model !== undefined && target.model !== null && (typeof target.model !== 'string' || !MODEL_RE.test(target.model))) common.fail('INVALID_TARGET', 'That model name is not valid.');
    const depth = ['quick', 'standard', 'exhaustive'].includes(b.depth) ? b.depth : 'standard';
    if (!ref.transcriptPath || !fs.existsSync(ref.transcriptPath)) common.fail('INVALID_TARGET', 'This session has no history to migrate yet.');
    const cut = b.fromMessageId ? cutOffset(ref, b.fromMessageId) : null;
    const snap = pack.snapshotSource(ref.transcriptPath, cut);
    const entry = pack.ensureIndex({ dataDir: path.dirname(root), provider: ref.provider, snap, useWorker: deps.useWorker !== false });
    const m = entry.state === 'ready' ? entry.manifest : null;
    const chunkChars = m ? m.chunkChars : pack.estimateChunkChars(snap.bytes);
    const plan = pack.planFor({ chunkChars, chunks: m ? m.chunks : [], targetProvider: target.provider, targetModel: target.model, depth });
    if (!m) plan.ranges = Math.max(1, Math.ceil(chunkChars / 200000 / (plan.tier === 'L' ? 2 : 1)));
    const est = pack.estimate({ plan, chunkChars, depth, targetProvider: target.provider, targetModel: target.model });
    const accountsList = previewAccounts(target.provider);
    const warnings = [];
    if (target.provider !== ref.provider) warnings.push({ code: 'CROSS_PROVIDER', message: 'This history will be read by ' + (target.provider === 'codex' ? 'OpenAI' : 'Anthropic') + ' models.' }); // gsd:provider-literal-allowed (mobile v2 migrations)
    if (m && m.formatDrift) warnings.push({ code: 'FORMAT_DRIFT', message: 'This history uses a format Workbook does not fully read yet. The new session will search the raw file instead.' });
    if (running_(ref)) warnings.push({ code: 'SOURCE_RUNNING', message: 'The source is running. It is paused when the takeover starts.' });
    const active = accountsList.find((a) => a.recommended) || null;
    let activeAcc = null;
    try { const s = deps.accounts.snapshot(); const pr = s.providers.find((x) => x.provider === target.provider); activeAcc = pr ? pr.accounts.find((a) => a.active) : null; } catch (_) { activeAcc = null; }
    if (activeAcc && activeAcc.headroom !== null && activeAcc.headroom < ACCOUNT_LOW_HEADROOM) {
      warnings.push({ code: 'ACCOUNT_LOW', message: activeAcc.displayName + ' has ' + activeAcc.headroom + '% of its window left.' + (active && active.accountId !== activeAcc.accountId ? ' Glass suggests ' + active.displayName + '.' : '') });
    }
    const forkReason = target.provider !== ref.provider ? 'Continue as is keeps the same provider.' : (snap.bytes > FORK_MAX_BYTES ? 'Continue as is works for histories under 200 MB.' : null);
    const subagents = ref.provider === 'claude' ? pack.subagentsOf(ref.transcriptPath) : { count: 0, bytes: 0 }; // gsd:provider-literal-allowed (mobile v2 migrations)
    return {
      source: {
        sessionId: ref.sessionId,
        title: ref.title,
        provider: ref.provider,
        bytes: snap.bytes,
        turns: m ? m.turns : null,
        firstAtMs: m ? common.toMs(m.firstTs) : null,
        lastAtMs: m ? common.toMs(m.lastTs) : null,
        running: running_(ref),
        compactions: m ? m.checkpoints : null,
        subagents,
      },
      index: { state: entry.state === 'ready' ? 'ready' : (entry.state === 'failed' ? 'failed' : 'building'), coverage: m ? Math.round((m.coverage || 0) * 100) + ' percent of records recognized' : null, formatDrift: !!(m && m.formatDrift) },
      plan: est,
      models: models(target.provider),
      accounts: accountsList,
      forkAllowed: !forkReason,
      forkDisallowedReason: forkReason,
      secondConfirmRequired: !!pack.needsCostConfirm(depth, est),
      warnings,
    };
  }

  // ── Start ───────────────────────────────────────────────────────────────

  /**
   * POST /sessions/:sessionId/migrations (PROTOCOL.md 4.12.2).
   *
   * @param {string} sessionId - Source phone id.
   * @param {object} body - MigrationStartRequest.
   * @param {string} key - Idempotency-Key.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {object} MigrationSnapshot.
   */
  function start(sessionId, body, key, who) {
    const ref = resolveSource(sessionId);
    for (const j of jobs.values()) if (j._.idempotencyKey === key && j.sourceSessionId === ref.sessionId) return snapshotOf(j);
    const b = body && typeof body === 'object' ? body : {};
    const t = b.target && typeof b.target === 'object' ? b.target : null;
    if (!t || !common.AGENT_PROVIDERS.includes(t.provider)) common.fail('INVALID_TARGET', 'Choose Claude or Codex for the takeover.');
    if (typeof t.model !== 'string' || !MODEL_RE.test(t.model)) common.fail('INVALID_TARGET', 'Choose a model for the takeover.');
    if (t.effort !== undefined && t.effort !== null && (typeof t.effort !== 'string' || !/^[a-z-]{1,32}$/.test(t.effort))) common.fail('INVALID_TARGET', 'That effort is not valid.');
    const mode = b.mode === undefined || b.mode === null ? 'takeover' : b.mode;
    if (!['takeover', 'fork'].includes(mode)) common.fail('INVALID_FIELD', 'mode is takeover or fork.', { field: 'mode' });
    const depth = b.depth === undefined || b.depth === null ? 'standard' : b.depth;
    if (!['quick', 'standard', 'exhaustive'].includes(depth)) common.fail('INVALID_FIELD', 'depth is quick, standard or exhaustive.', { field: 'depth' });
    const sourcePolicy = b.sourcePolicy === undefined || b.sourcePolicy === null ? 'pause' : b.sourcePolicy;
    if (!['pause', 'leave'].includes(sourcePolicy)) common.fail('INVALID_FIELD', 'sourcePolicy is pause or leave.', { field: 'sourcePolicy' });
    if (b.focus !== undefined && b.focus !== null && (typeof b.focus !== 'string' || b.focus.length > FOCUS_MAX)) common.fail('INVALID_FIELD', 'The focus note has at most 4,000 characters.', { field: 'focus' });
    if (b.name !== undefined && b.name !== null && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > NAME_MAX || /[\r\n]/.test(b.name))) common.fail('INVALID_FIELD', 'A name has 1 to 200 characters on one line.', { field: 'name' });
    for (const active of jobs.values()) {
      if (active.sourceSessionId === ref.sessionId && !TERMINAL.has(active.state) && !RETRYABLE.has(active.state)) common.fail('MIGRATION_ACTIVE', 'A migration is already running for this session.');
    }
    if (ref.owner === 'handedOff') common.fail('INVALID_TARGET', 'This session was handed off. Migrate its successor instead.');
    if (sourcePolicy === 'pause' && (ref.owner === 'external' || ref.owner === 'chatgpt')) common.fail('INVALID_TARGET', 'This session runs outside Workbook, so it cannot be paused. Choose Leave running.');
    if (!ref.transcriptPath || !fs.existsSync(ref.transcriptPath)) common.fail('INVALID_TARGET', 'This session has no history to migrate yet.');
    const cut = b.fromMessageId ? cutOffset(ref, b.fromMessageId) : null;
    const size = cut !== null ? cut : fs.statSync(ref.transcriptPath).size;
    if (mode === 'fork') {
      if (t.provider !== ref.provider) common.fail('INVALID_TARGET', 'Continue as is keeps the same provider.');
      if (size > FORK_MAX_BYTES) common.fail('FORK_TOO_LARGE', 'Continue as is works for histories under 200 MB.');
    }
    if (launcher.turnOpen(ref.sessionId) && b.startWhileBusy !== true) common.fail('SOURCE_BUSY', 'The session is running a turn. Wait for it to finish, or start anyway.');
    // The cost guard, from the same estimate the preview showed.
    const chunkChars = pack.estimateChunkChars(size);
    const plan = pack.planFor({ chunkChars, chunks: [], targetProvider: t.provider, targetModel: t.model, depth });
    plan.ranges = Math.max(1, Math.ceil(chunkChars / 200000 / (plan.tier === 'L' ? 2 : 1)));
    const est = pack.estimate({ plan, chunkChars, depth, targetProvider: t.provider, targetModel: t.model });
    if (pack.needsCostConfirm(depth, est) && b.confirmCost !== true) common.fail('COST_CONFIRM_REQUIRED', 'Confirm the cost of this takeover to start it.');
    // Placement (R08:489): an explicit group must have room; the default is
    // the source's first tab group, right after the source, when it has room.
    let placement = { tabGroupId: null, afterSessionId: null };
    if (b.tabGroupId !== undefined && b.tabGroupId !== null) {
      if (typeof b.tabGroupId !== 'string') common.fail('INVALID_FIELD', 'tabGroupId is a tab group id.', { field: 'tabGroupId' });
      const tabsNow = deps.tabs.current();
      if (!tabsNow.groups.some((g) => g.id === b.tabGroupId)) common.fail('INVALID_FIELD', 'That tab group does not exist.', { field: 'tabGroupId' });
      if (!deps.tabs.hasRoom(b.tabGroupId)) common.fail('TAB_GROUP_FULL', 'That tab group is full.', { groupId: b.tabGroupId });
      placement = { tabGroupId: b.tabGroupId, afterSessionId: ref.sessionId };
    } else {
      const groups = deps.tabs.tabGroupIdsFor(ref.sessionId);
      if (groups.length && deps.tabs.hasRoom(groups[0])) placement = { tabGroupId: groups[0], afterSessionId: ref.sessionId };
    }
    // The account: the takeover runs under the provider's active account.
    if (t.accountId !== undefined && t.accountId !== null) {
      let acc = null;
      try { const s = deps.accounts.snapshot(); const pr = s.providers.find((x) => x.provider === t.provider); acc = pr ? pr.accounts.find((a) => a.accountId === t.accountId) : null; } catch (_) { acc = null; }
      if (!acc) common.fail('ACCOUNT_NOT_READY', 'That account is not known on this computer.');
      if (!acc.swappable) common.fail('ACCOUNT_NOT_READY', acc.displayName + ' needs a new sign-in first.');
      if (!acc.active) common.fail('ACCOUNT_NOT_READY', 'Switch ' + (t.provider === 'codex' ? 'Codex' : 'Claude') + ' to ' + acc.displayName + ' first; the takeover runs under the active account.'); // gsd:provider-literal-allowed (mobile v2 migrations)
    }
    // Disk (R08 section 4.3: the pack is a few percent of the source).
    try {
      if (typeof fs.statfsSync === 'function') {
        fs.mkdirSync(root, { recursive: true });
        const st = fs.statfsSync(root);
        const free = Number(st.bavail) * Number(st.bsize);
        if (Number.isFinite(free) && free < Math.max(DISK_FLOOR_BYTES, size * DISK_SHARE)) common.fail('DISK_FULL', 'The disk of this computer is too full for the migration pack.');
      }
    } catch (err) {
      if (err && err.name === 'MobileError') throw err;
    }
    const migrationId = 'mg_' + common.b64url(crypto.randomBytes(16));
    const packDir = path.join(root, migrationId);
    const nowMs = now();
    const job = {
      migrationId,
      sourceSessionId: ref.sessionId,
      targetSessionId: null,
      target: { provider: t.provider, model: t.model, effort: t.effort || null, accountId: t.accountId || null },
      mode,
      depth,
      sourcePolicy,
      state: 'queued',
      steps: STEPS.map(([key, label]) => ({ key, label, state: 'pending', detail: null, done: null, total: null, startedAtMs: null, endedAtMs: null })),
      plan: { tier: plan.tier, ranges: plan.ranges, maxReaders: plan.maxReaders, readerModel: plan.readerModel },
      coverage: null,
      stale: false,
      report: { ready: false, header: null },
      tripwire: null,
      error: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      _: {
        idempotencyKey: key,
        deviceId: (who && who.deviceId) || null,
        name: (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : ((ref.title || 'Session') + ' takeover')).slice(0, NAME_MAX),
        // Redacted before it is stored: job.json lives in the pack, which
        // never holds a secret shaped string (R08 section 4.7).
        focus: typeof b.focus === 'string' && b.focus.trim() ? redact(b.focus) : null,
        startWhileBusy: b.startWhileBusy === true,
        fromMessageId: b.fromMessageId || null,
        cut,
        readerModel: typeof b.readerModel === 'string' && MODEL_RE.test(b.readerModel) ? b.readerModel : null,
        placement,
        sourceProvider: ref.provider,
        sourcePath: ref.transcriptPath,
        sourceTitle: ref.title,
        sourceProjectId: ref.projectId || null,
        sourceUpstreamId: ref.upstreamId,
        cwd: ref.workingDir || null,
        packDir,
        charterPath: path.join(packDir, 'CHARTER.md'),
        startPath: path.join(packDir, 'START.md'),
        tailOffset: 0,
        reportToolUseId: null,
        approvedAtMs: null,
      },
    };
    jobs.set(migrationId, job);
    save(job, null);
    common.audit(ctx, { deviceId: job._.deviceId, action: 'migrationStart', sessionId: ref.sessionId, detail: mode + ' ' + t.provider, ok: true });
    run(job, 'snapshot');
    return snapshotOf(job);
  }

  // ── The pipeline ────────────────────────────────────────────────────────

  /**
   * Run the pipeline from a step; failures mark the step and the job.
   *
   * @param {object} job - Job.
   * @param {string} from - Step key to start at.
   */
  function run(job, from) {
    if (running.has(job.migrationId)) return;
    running.add(job.migrationId);
    const idx = STEP_KEYS.indexOf(from);
    (async () => {
      let current = from;
      try {
        if (idx <= 0) { current = 'snapshot'; await stepSnapshot(job); }
        if (stopped(job)) return;
        if (idx <= 1) { current = 'index'; await stepIndex(job); }
        if (stopped(job)) return;
        if (idx <= 2) { current = 'standards'; await stepPack(job); }
        if (stopped(job)) return;
        if (!job.targetSessionId) { current = 'reading'; await stepLaunch(job); }
        if (stopped(job)) return;
        watch(job);
      } catch (err) {
        fail(job, current, err);
      } finally {
        running.delete(job.migrationId);
      }
    })();
  }

  /** @returns {boolean} the job was cancelled meanwhile */
  function stopped(job) {
    return job.state === 'cancelled';
  }

  /**
   * Mark a failure (PROTOCOL.md 3.12 error {code, error, retryable}).
   *
   * @param {object} job - Job.
   * @param {string} key - Step key.
   * @param {*} err - Error.
   */
  function fail(job, key, err) {
    if (stopped(job)) return;
    const code = err && typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : 'MIGRATION_STEP_FAILED';
    const message = err && err.message ? common.oneLine(String(err.message).split('\n')[0]) || 'The step failed.' : 'The step failed.';
    const s = job.steps.find((x) => x.key === key);
    if (s) { s.state = 'failed'; s.endedAtMs = now(); s.detail = message; }
    job.error = { code, error: /[.!?]$/.test(message) ? message : message + '.', retryable: true };
    log('migration step ' + key + ' failed: ' + code);
    setState(job, 'failed');
  }

  /**
   * Snapshot: pause the source (policy pause), record the snapshot and
   * the git state.
   *
   * @param {object} job - Job.
   * @returns {Promise<void>}
   */
  async function stepSnapshot(job) {
    job.state = 'snapshotting';
    step(job, 'snapshot', { state: 'running', detail: null });
    const ref = resolveSource(job.sourceSessionId);
    let paused = 'source left running';
    if (job.sourcePolicy === 'pause') paused = await launcher.pauseSource(job, ref);
    const snap = pack.snapshotSource(job._.sourcePath, job._.cut);
    job._.snap = snap;
    const g = await pack.gitState(job._.cwd, null);
    // job.json keeps the git state for the tripwire; the free text parts
    // (commit subjects, remote URLs) are redacted like every pack file.
    job._.git = g ? Object.assign({}, g, { log: redact(g.log), remotes: redact(g.remotes) }) : null;
    job._.gitTop = g ? g.top : null;
    step(job, 'snapshot', { state: 'done', detail: 'at byte ' + snap.bytes.toLocaleString('en-US') + ' · ' + paused });
  }

  /**
   * Index: the deterministic index in a worker thread (reused when the
   * preview already built it).
   *
   * @param {object} job - Job.
   * @returns {Promise<void>}
   */
  async function stepIndex(job) {
    job.state = 'indexing';
    step(job, 'index', { state: 'running', detail: null });
    const started = now();
    const entry = pack.ensureIndex({
      dataDir: path.dirname(root),
      provider: job._.sourceProvider,
      snap: job._.snap,
      useWorker: deps.useWorker !== false,
      onProgress: (p) => { step(job, 'index', { detail: Math.round(p.bytes / 1048576).toLocaleString('en-US') + ' of ' + Math.round(p.total / 1048576).toLocaleString('en-US') + ' MB' }); },
    });
    const m = await entry.promise;
    job._.indexDir = entry.dir;
    job._.indexKey = entry.key;
    const secs = Math.max(1, Math.round((now() - started) / 1000));
    if (m.formatDrift) {
      const hub = ctx.mobile && ctx.mobile.hub;
      if (hub && typeof hub.publishNotice === 'function') {
        try { hub.publishNotice({ noticeId: 'n_drift_' + common.sha8(job.migrationId), level: 'warn', code: 'FORMAT_DRIFT', message: 'Some records in this history use a format Workbook does not know. The report lists them.', sessionId: job.sourceSessionId }); } catch (_) { /* best effort */ }
      }
    }
    step(job, 'index', { state: 'done', detail: m.turns.toLocaleString('en-US') + ' turns · ' + m.toolCalls.toLocaleString('en-US') + ' tools · ' + secs + ' s' });
  }

  /**
   * Pack: plan by tier, standards, git.md, the charter.
   *
   * @param {object} job - Job.
   * @returns {Promise<void>}
   */
  async function stepPack(job) {
    job.state = 'packing';
    step(job, 'standards', { state: 'running', detail: null });
    const m = JSON.parse(fs.readFileSync(path.join(job._.indexDir, 'index-manifest.json'), 'utf8'));
    const p = pack.planFor({ chunkChars: m.chunkChars, chunks: m.chunks, targetProvider: job.target.provider, targetModel: job.target.model, depth: job.depth, readerModel: job._.readerModel });
    if (job.depth === 'quick' && p.rangeList.length > 1) p.rangeList = p.rangeList.slice(-1);
    job.plan = { tier: p.tier, ranges: job.depth === 'quick' ? p.rangeList.length || 1 : p.ranges, maxReaders: p.maxReaders, readerModel: p.readerModel };
    const standards = pack.collectStandards({ cwd: job._.cwd, claudeDir: pack.claudeDir(), codexHome: pack.codexHome(), stopAt: process.env.CWM_MIGRATE_STANDARDS_STOP || null });
    if (!job._.cwd && m.lastCwd) job._.cwd = m.lastCwd;
    const res = pack.writePack({
      packDir: job._.packDir,
      indexDir: job._.indexDir,
      manifest: m,
      snap: job._.snap,
      provider: job._.sourceProvider,
      targetProvider: job.target.provider,
      sourceName: job._.sourceTitle || 'Untitled session',
      rawPath: job._.sourcePath,
      cwd: job._.cwd,
      focus: job._.focus,
      git: job._.git,
      plan: Object.assign({}, p, { ranges: job.plan.ranges }),
      depth: job.depth,
      standards,
      subagents: job._.sourceProvider === 'claude' ? pack.subagentsOf(job._.sourcePath) : { count: 0, bytes: 0 }, // gsd:provider-literal-allowed (mobile v2 migrations)
      cutAtMessage: job._.fromMessageId,
      charterPath: job.target.provider === 'codex' ? job._.startPath : job._.charterPath, // gsd:provider-literal-allowed (mobile v2 migrations)
    });
    step(job, 'standards', { state: 'done', detail: res.detail });
  }

  /**
   * Launch: the takeover session through B2, lineage, the kickoff.
   *
   * @param {object} job - Job.
   * @returns {Promise<void>}
   */
  async function stepLaunch(job) {
    setState(job, 'launching');
    const ref = resolveSource(job.sourceSessionId);
    let placement = job._.placement || { tabGroupId: null, afterSessionId: null };
    if (placement.tabGroupId && !deps.tabs.hasRoom(placement.tabGroupId)) placement = { tabGroupId: null, afterSessionId: null };
    await launcher.launch(job, ref, placement);
    link(job);
    if (job.sourcePolicy === 'pause') {
      try { chat().sessions.setHandedOff(job.sourceSessionId, { targetSessionId: job.targetSessionId, targetTitle: job._.name, migrationId: job.migrationId }); } catch (_) { /* best effort */ }
    }
    await launcher.kickoff(job);
    job.state = 'reading';
    step(job, 'reading', { state: 'running', detail: null, done: job.plan.tier === 'S' ? 0 : 0, total: job.plan.ranges });
  }

  // ── Watching the target ─────────────────────────────────────────────────

  /**
   * Start following the target transcript.
   *
   * @param {object} job - Job.
   */
  function watch(job) {
    if (watchers.has(job.migrationId) || TERMINAL.has(job.state)) return;
    const w = createProgressWatcher({
      provider: job.target.provider,
      pathOf: () => {
        const c = chat();
        const r = c && c.sessions && job.targetSessionId ? c.sessions.resolve(job.targetSessionId) : null;
        if (r && r.sessionId !== job.targetSessionId) rekey(job.targetSessionId, r.sessionId);
        return r ? r.transcriptPath : null;
      },
      startOffset: job._.tailOffset || 0,
      exitPlanId: job._.reportToolUseId,
      packDir: job._.packDir,
      onEvent: (e) => onEvent(job, e),
    });
    watchers.set(job.migrationId, w);
    lastProgressAt.set(job.migrationId, now());
    w.start();
  }

  /** Stop following a job's target. */
  function unwatch(job) {
    const w = watchers.get(job.migrationId);
    if (w) w.stop();
    watchers.delete(job.migrationId);
  }

  /**
   * One event from the target transcript.
   *
   * @param {object} job - Job.
   * @param {object} e - Event.
   */
  function onEvent(job, e) {
    if (TERMINAL.has(job.state)) return;
    if (e.type === 'offset') { if (job._.tailOffset !== e.offset) { job._.tailOffset = e.offset; persistQuietly(job); } return; }
    lastProgressAt.set(job.migrationId, now());
    if (e.type === 'progress') {
      if (e.stage === 'reading') {
        if (job.state !== 'reading' && ['launching', 'reading'].includes(job.state) === false && job.state !== 'needsAttention') return;
        job.state = 'reading';
        step(job, 'reading', { state: 'running', done: Math.min(e.done, e.total), total: e.total, detail: e.done + ' of ' + e.total + ' ranges' + readersWords(job) });
      } else {
        const r = job.steps.find((s) => s.key === 'reading');
        if (r && r.state !== 'done') { r.state = 'done'; r.endedAtMs = now(); }
        job.state = 'verifying';
        step(job, 'verifying', { state: 'running', done: Math.min(e.done, e.total), total: e.total, detail: e.done + ' of ' + e.total + ' checks' });
      }
      return;
    }
    if (e.type === 'reader') {
      job._.readersLive = e.live;
      const r = job.steps.find((s) => s.key === 'reading');
      if (r && r.state === 'running') step(job, 'reading', { detail: (r.done !== null ? r.done + ' of ' + r.total + ' ranges' : 'reading') + readersWords(job) });
      return;
    }
    if (e.type === 'report') { onReport(job, e).catch((err) => fail(job, 'report', err)); return; }
    if (e.type === 'planRejected') {
      // "Ask" (keepPlanning) or a refusal on the desktop: the review goes on
      // and a revised report will follow.
      if (job.state === 'awaitingApproval') setState(job, 'reporting');
      return;
    }
    if (e.type === 'approved') { onApproved(job); return; }
    if (e.type === 'turnStarted' && job.target.provider === 'codex' && job.state === 'continuing' && job._.approvedAtMs) { onApproved(job); return; } // gsd:provider-literal-allowed (mobile v2 migrations)
    if (e.type === 'turnEnded' && ['reading', 'verifying'].includes(job.state)) {
      const s = job.steps.find((x) => x.key === (job.state === 'reading' ? 'reading' : 'verifying'));
      if (s) { s.state = 'failed'; s.endedAtMs = now(); s.detail = 'The takeover ended its turn without a report.'; }
      job.error = { code: 'REPORT_MISSING', error: 'The takeover ended its turn without a report.', retryable: true };
      setState(job, 'needsAttention');
    }
  }

  /** @returns {string} " · N readers live" or nothing */
  function readersWords(job) {
    const n = job._.readersLive || 0;
    return n > 0 ? ' · ' + n + (n === 1 ? ' reader live' : ' readers live') : '';
  }

  /** Persist the tail offset without publishing (no visible change). */
  function persistQuietly(job) {
    try { common.writeJson(path.join(job._.packDir, 'job.json'), job); } catch (_) { /* next save writes it */ }
  }

  /**
   * The report arrived: save it, map the header, check the tripwire, wait
   * for approval (A20).
   *
   * @param {object} job - Job.
   * @param {{markdown: string, toolUseId: (string|null)}} e - Report event.
   * @returns {Promise<void>}
   */
  async function onReport(job, e) {
    for (const key of ['reading', 'verifying']) {
      const s = job.steps.find((x) => x.key === key);
      if (s && s.state !== 'done') { s.state = 'done'; s.endedAtMs = now(); if (s.startedAtMs === null) s.startedAtMs = now(); }
    }
    job.state = 'reporting';
    step(job, 'report', { state: 'running', detail: null });
    const raw = report.findHeader(e.markdown);
    const reading = job.steps.find((x) => x.key === 'reading');
    const header = report.mapHeader(raw, e.markdown, charter.coverageWords(job.plan.tier, job.depth, null));
    const trip = await pack.tripwire(job._.cwd, job._.git);
    const savedAtMs = now();
    const cov = report.coveragePercent(job.plan.tier, reading);
    report.saveReport(job._.packDir, e.markdown, { header, savedAtMs, coveragePercent: cov, tripwire: trip });
    job._.reportToolUseId = e.toolUseId || null;
    job.report = { ready: true, header };
    job.coverage = header.coverage;
    job.tripwire = trip;
    job.error = null;
    const r = job.steps.find((x) => x.key === 'report');
    r.state = 'done';
    r.endedAtMs = now();
    r.detail = header.claimsFailed + (header.claimsFailed === 1 ? ' claim did not hold' : ' claims did not hold');
    setState(job, 'awaitingApproval');
  }

  /**
   * The go ahead is confirmed in the transcript: completed.
   *
   * @param {object} job - Job.
   */
  function onApproved(job) {
    if (!['awaitingApproval', 'continuing'].includes(job.state)) return;
    if (job.state === 'awaitingApproval') { job.state = 'continuing'; save(job); }
    setState(job, 'completed');
    unwatch(job);
  }

  /** Stage timeouts and staleness (R08 section 9.1 rows 3 and 9). */
  function check() {
    for (const job of jobs.values()) {
      if (TERMINAL.has(job.state)) continue;
      if (job.sourcePolicy === 'leave' && job._.snap && !job.stale) {
        try { if (fs.statSync(job._.sourcePath).size > job._.snap.bytes) { job.stale = true; save(job); } } catch (_) { /* source gone */ }
      }
      if (!['reading', 'verifying', 'reporting'].includes(job.state)) continue;
      const limit = STAGE_TIMEOUT_MS[job.plan.tier] || STAGE_TIMEOUT_MS.M;
      if (now() - (lastProgressAt.get(job.migrationId) || job.updatedAtMs) > limit) {
        job.error = { code: 'STAGE_TIMEOUT', error: 'The takeover made no progress for a long time.', retryable: true };
        setState(job, 'needsAttention');
      }
    }
  }
  const checkTimer = setInterval(check, CHECK_MS);
  if (checkTimer.unref) checkTimer.unref();

  // ── Approve, cancel, retry ──────────────────────────────────────────────

  /**
   * The source's normal Claude permission mode (to leave plan mode into).
   *
   * @param {object} job - Job.
   * @returns {string}
   */
  function sourceMode(job) {
    try {
      const v = deps.settings.valuesOf(job.sourceSessionId);
      if (v && v.permissionMode) return v.permissionMode;
    } catch (_) { /* fall through */ }
    try {
      const m = JSON.parse(fs.readFileSync(path.join(job._.packDir, 'index-manifest.json'), 'utf8'));
      if (m.lastPermissionMode && m.lastPermissionMode !== 'plan') return m.lastPermissionMode;
    } catch (_) { /* fall through */ }
    return 'default';
  }

  /**
   * POST /migrations/:migrationId/approve (PROTOCOL.md 4.12.4, F13).
   *
   * @param {string} id - Migration id.
   * @param {object} body - {note}.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {Promise<object>} MigrationSnapshot.
   */
  async function approve(id, body, who) {
    const job = getJob(id);
    if (job.state !== 'awaitingApproval') common.fail('MIGRATION_NOT_AWAITING', 'That migration is not waiting for approval.');
    const note = body && typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    const c = chat();
    if (job.target.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 migrations)
      const prompts = c.prompts.openFor(job.targetSessionId) || [];
      const plan = prompts.filter((x) => x.kind === 'plan').pop();
      if (!plan) common.fail('MIGRATION_NOT_AWAITING', 'The plan dialog is not open. Approve it on the computer.');
      const mode = sourceMode(job);
      const allow = (plan.options || []).filter((o) => o.role === 'allow');
      const re = MODE_OPTION_RES[mode] || MANUAL_OPTION_RE;
      const chosen = allow.find((o) => re.test(o.label)) || allow[0];
      if (!chosen) common.fail('MIGRATION_NOT_AWAITING', 'The plan dialog has no option to approve.');
      try {
        await c.prompts.answer(job.targetSessionId, plan.promptId, { clientRequestId: crypto.randomUUID(), decision: null, optionIndex: chosen.index, answers: null, text: null, dismiss: false }, { deviceId: (who && who.deviceId) || null, origin: 'migration' });
      } catch (err) {
        common.fail('MIGRATION_NOT_AWAITING', 'The plan dialog changed before the approval reached it (' + ((err && err.code) || 'error') + ').');
      }
      job._.approvedAtMs = now();
      // The target may have written the approval while the answer was being
      // confirmed, and the watcher may already have completed the job; a
      // later state is never moved back.
      if (job.state === 'awaitingApproval') {
        job.state = 'continuing';
        save(job, 'awaitingApproval');
      } else {
        save(job);
      }
      if (note) c.sends.enqueueSystem(job.targetSessionId, note, { origin: 'migration' }).catch(() => {});
    } else {
      // Codex: restart the pane with the source's own sandbox and approval
      // settings, resuming the same thread, then say go (F13).
      const src = (() => { try { return deps.settings.valuesOf(job.sourceSessionId); } catch (_) { return {}; } })();
      await c.launch.stop(job.targetSessionId, { clientRequestId: crypto.randomUUID() }).catch(() => {});
      deps.settings.applyValues(job.targetSessionId, { sandbox: src.sandbox || null, approvalPolicy: src.approvalPolicy || null });
      const r = await c.launch.start(job.targetSessionId, { reason: 'migration' });
      if (r && r.status === 'refused') common.fail('MIGRATION_NOT_AWAITING', 'The takeover could not be restarted (' + (r.code || 'refused') + ').');
      job._.approvedAtMs = now();
      job.state = 'continuing';
      save(job, 'awaitingApproval');
      await c.sends.enqueueSystem(job.targetSessionId, CODEX_APPROVED + (note ? '\n\n' + note : ''), { origin: 'migration' });
    }
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'migrationApprove', sessionId: job.targetSessionId, detail: job.migrationId, ok: true });
    return snapshotOf(job);
  }

  /**
   * POST /migrations/:migrationId/cancel (PROTOCOL.md 4.12.4, P27).
   *
   * @param {string} id - Migration id.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {Promise<object>} MigrationSnapshot.
   */
  async function cancel(id, who) {
    const job = getJob(id);
    if (!CANCELLABLE.has(job.state)) common.fail('MIGRATION_NOT_CANCELLABLE', 'That migration can no longer be cancelled.');
    const prev = job.state;
    job.state = 'cancelled';
    unwatch(job);
    const c = chat();
    if (job.targetSessionId && c) {
      try { await c.launch.stop(job.targetSessionId, { clientRequestId: crypto.randomUUID() }); } catch (_) { /* not running */ }
      try { deps.flags.set(job.targetSessionId, { archived: true }); } catch (_) { /* best effort */ }
    }
    if (c && c.sessions && c.sessions.handoffOf && c.sessions.handoffOf(job.sourceSessionId)) {
      try { c.sessions.setHandedOff(job.sourceSessionId, null); } catch (_) { /* best effort */ }
    }
    unlink(job);
    for (const s of job.steps) if (s.state === 'running' || s.state === 'pending') { s.state = 'skipped'; s.endedAtMs = s.endedAtMs || now(); }
    save(job, prev);
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'migrationCancel', sessionId: job.sourceSessionId, detail: job.migrationId, ok: true });
    return snapshotOf(job);
  }

  /**
   * POST /migrations/:migrationId/retry (PROTOCOL.md 4.12.4).
   *
   * @param {string} id - Migration id.
   * @param {object} body - {fromStage}.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {object} MigrationSnapshot.
   */
  function retry(id, body, who) {
    const job = getJob(id);
    if (!RETRYABLE.has(job.state)) common.fail('MIGRATION_NOT_RETRYABLE', 'That migration cannot be retried.');
    let from = body && typeof body.fromStage === 'string' ? body.fromStage : null;
    if (from !== null && !STEP_KEYS.includes(from)) common.fail('INVALID_FIELD', 'fromStage is a step key.', { field: 'fromStage' });
    if (!from) {
      const failed = job.steps.find((s) => s.state === 'failed');
      from = failed ? failed.key : (job.targetSessionId ? 'reading' : 'snapshot');
    }
    // A launched takeover is never launched twice: earlier steps rerun only
    // before the launch.
    if (job.targetSessionId && STEP_KEYS.indexOf(from) < STEP_KEYS.indexOf('reading')) from = 'reading';
    job.error = null;
    for (const s of job.steps.slice(STEP_KEYS.indexOf(from))) { if (s.state !== 'done' || s.key === from) { s.state = 'pending'; s.detail = null; s.startedAtMs = null; s.endedAtMs = null; } }
    lastProgressAt.set(job.migrationId, now());
    const prev = job.state;
    if (job.targetSessionId && STEP_KEYS.indexOf(from) >= STEP_KEYS.indexOf('reading')) {
      const nudge = from === 'reading' ? CONTINUE_READING : WRITE_REPORT_NOW;
      job.state = from === 'reading' ? 'reading' : 'verifying';
      step(job, from === 'report' ? 'verifying' : from, { state: 'running' });
      save(job, prev);
      const c = chat();
      Promise.resolve()
        .then(() => (c.launch.start(job.targetSessionId, { reason: 'migration' })))
        .then(() => c.sends.enqueueSystem(job.targetSessionId, nudge, { origin: 'migration' }))
        .catch((err) => fail(job, from, err));
      watch(job);
    } else {
      job.state = 'queued';
      save(job, prev);
      run(job, from);
    }
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'migrationStart', sessionId: job.sourceSessionId, detail: 'retry ' + from, ok: true });
    return snapshotOf(job);
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  /**
   * A job or 404.
   *
   * @param {string} id - Migration id.
   * @returns {object}
   */
  function getJob(id) {
    const job = jobs.get(id);
    if (!job) common.fail('MIGRATION_NOT_FOUND', 'That migration is not known on this computer.');
    return job;
  }

  /**
   * GET /migrations (PROTOCOL.md 4.12.3), newest first.
   *
   * @param {object} q - {sessionId, state, limit, cursor}
   * @returns {object}
   */
  function list(q) {
    let limit = LIST_DEFAULT;
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) common.fail('INVALID_FIELD', 'limit must be 1 to 100.', { field: 'limit' });
    }
    let offset = 0;
    if (q.cursor) {
      try { const c = JSON.parse(Buffer.from(String(q.cursor).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); offset = Number.isInteger(c.o) && c.o >= 0 ? c.o : NaN; } catch (_) { offset = NaN; }
      if (!Number.isInteger(offset)) common.fail('CURSOR_EXPIRED', 'That page is no longer available. Start again from the top.');
    }
    let all = Array.from(jobs.values());
    if (q.sessionId) all = all.filter((j) => j.sourceSessionId === q.sessionId || j.targetSessionId === q.sessionId);
    if (q.state) all = all.filter((j) => j.state === q.state);
    all.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.migrationId < b.migrationId ? -1 : 1));
    const page = all.slice(offset, offset + limit).map(snapshotOf);
    const next = offset + limit < all.length ? common.b64url(Buffer.from(JSON.stringify({ o: offset + limit }))) : null;
    return Object.assign({ migrations: page, nextCursor: next }, common.snapshotSeq(ctx, 'migrations'));
  }

  /**
   * GET /migrations/:migrationId/report (PROTOCOL.md 4.12.6).
   *
   * @param {string} id - Migration id.
   * @returns {object}
   */
  function getReport(id) {
    const job = getJob(id);
    const r = job.report && job.report.ready ? report.readReport(job._.packDir) : null;
    if (!r) common.fail('REPORT_NOT_READY', 'The takeover report is not ready yet.');
    return { migrationId: job.migrationId, header: r.header, markdown: r.markdown, savedAtMs: r.savedAtMs, coveragePercent: r.coveragePercent, tripwire: r.tripwire || { changed: false, diffStat: null } };
  }

  /**
   * GET /migrations/:migrationId/turns/:turnNumber (PROTOCOL.md 4.12.7).
   *
   * @param {string} id - Migration id.
   * @param {string} n - Turn number.
   * @returns {object}
   */
  function getTurn(id, n) {
    const job = getJob(id);
    const num = Number(n);
    const t = Number.isInteger(num) ? report.readTurn(job._.packDir, num) : null;
    if (!t) common.fail('TURN_NOT_FOUND', 'That turn is not in this migration pack.');
    return { turn: t.turn, ts: t.ts, user: t.user, events: t.events, rawPath: job._.sourcePath, rawOffset: t.offset };
  }

  // ── Load and resume (restart) ───────────────────────────────────────────

  /** Load every job.json and resume the unfinished ones (R08:527). */
  function load() {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^mg_/.test(d.name)); } catch (_) { dirs = []; }
    for (const d of dirs) {
      const job = common.readJson(path.join(root, d.name, 'job.json'), null);
      if (!job || !job.migrationId || !job._) continue;
      job._.packDir = path.join(root, d.name);
      // The pack's own files, wherever the data folder lives now.
      job._.charterPath = path.join(job._.packDir, 'CHARTER.md');
      job._.startPath = path.join(job._.packDir, 'START.md');
      jobs.set(job.migrationId, job);
    }
    for (const job of jobs.values()) {
      if (TERMINAL.has(job.state) || job.state === 'failed') continue;
      if (['queued', 'snapshotting', 'indexing', 'packing'].includes(job.state)) {
        const stepKey = job.state === 'queued' || job.state === 'snapshotting' ? 'snapshot' : (job.state === 'indexing' ? 'index' : 'standards');
        log('resuming migration ' + job.migrationId + ' at ' + stepKey);
        run(job, stepKey);
      } else if (job.state === 'launching' && !job.targetSessionId) {
        run(job, 'reading');
      } else {
        watch(job);
      }
    }
  }

  // Follow re-keys of wb_ targets (the Codex thread linker, F17).
  try {
    const c = chat();
    if (c && c.sessions && typeof c.sessions.onChanged === 'function') {
      unsubs.push(c.sessions.onChanged((ev) => {
        for (const ch of (ev && ev.changes) || []) if (ch.change === 'idChanged' && ch.previousSessionId) rekey(ch.previousSessionId, ch.sessionId);
      }));
    }
  } catch (_) { /* no session index */ }

  return {
    preview,
    start,
    list,
    get: (id) => snapshotOf(getJob(id)),
    getReport,
    getTurn,
    approve,
    cancel,
    retry,
    load,
    lineageOf,
    rekey,
    jobs: () => Array.from(jobs.values()).map(snapshotOf),
    _job: (id) => jobs.get(id) || null,
    _check: check,
    stop() {
      clearInterval(checkTimer);
      for (const w of watchers.values()) w.stop();
      watchers.clear();
      for (const u of unsubs.splice(0)) { try { u(); } catch (_) { /* ignore */ } }
    },
  };
}

module.exports = { createMigrations, STEPS, FORK_MAX_BYTES };
