/**
 * migrate/launch.js: pausing the source and launching the takeover through
 * B2's launch path (PROTOCOL.md 4.12.2; R08 section 8 "Launch"; critic F14;
 * W2).
 *
 * WHY: no free text ever reaches a command line (W2: Workbook runs spawns
 * through cmd.exe /c, which splits quoted text and runs "&" as a second
 * command, R08 section 2). The Claude takeover is started by B2's
 * createSession with the minted session id, the model, permission mode
 * plan, and exactly two extra flags (append-system-prompt-file and add-dir)
 * whose values are paths into the pack, checked as single safe tokens; the
 * focus note lives in FOCUS.md and the kickoff is a fixed sentence delivered
 * as a system send through B2's send gate. The Codex takeover starts with a
 * read only sandbox and approval never, and its fixed kickoff names
 * START.md. "Pause" is defined (F14): wait for the source's turn to end, or
 * interrupt it only when the phone said start anyway, stop its process, mark
 * it handed off, which makes B2 refuse sends to it until "Resume here
 * anyway".
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const charter = require('./charter');

/** Longest wait for a source turn to end after an interrupt. */
const TURN_END_WAIT_MS = 60 * 1000;
/** Poll interval while waiting. */
const WAIT_POLL_MS = 250;
/** Default workspace when nothing else can hold the target (B2's words). */
const PHONE_WORKSPACE_NAME = 'From the phone';

/**
 * Sleep.
 *
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
}

/**
 * Create the launcher.
 *
 * @param {object} deps - {ctx, log}
 * @returns {object}
 */
function createMigrationLauncher(deps) {
  const ctx = deps.ctx;
  const log = deps.log || (() => {});
  const chat = () => (ctx.mobile && ctx.mobile.chat) || null;

  /**
   * Whether a session has a turn open.
   *
   * @param {string} sessionId - Phone id.
   * @returns {boolean}
   */
  function turnOpen(sessionId) {
    const c = chat();
    try {
      if (c && c.internals && c.internals.turns && typeof c.internals.turns.isTurnOpen === 'function') return c.internals.turns.isTurnOpen(sessionId);
      const st = c && c.turns ? c.turns.stateOf(sessionId) : null;
      return !!(st && ['thinking', 'working', 'streaming', 'needsAnswer', 'needsApproval'].includes(st.state));
    } catch (_) {
      return false;
    }
  }

  /**
   * Pause the source (F14): wait for or interrupt its turn, stop its
   * process, mark it handed off.
   *
   * @param {object} job - The migration job.
   * @param {object} ref - Source SessionRef.
   * @returns {Promise<string>} Words for the snapshot step detail.
   */
  async function pauseSource(job, ref) {
    const c = chat();
    if (!c) return 'source left running';
    if (turnOpen(ref.sessionId)) {
      if (job._.startWhileBusy && c.internals && c.internals.interrupts) {
        try { await c.internals.interrupts.interrupt(ref.sessionId, { clientRequestId: crypto.randomUUID() }, { deviceId: job._.deviceId || null }); } catch (err) { log('source interrupt failed: ' + (err && err.code)); }
      }
      const until = Date.now() + TURN_END_WAIT_MS;
      while (turnOpen(ref.sessionId) && Date.now() < until) await sleep(WAIT_POLL_MS);
      if (turnOpen(ref.sessionId)) {
        const err = new Error('The source is still running a turn.');
        err.code = 'SOURCE_BUSY';
        throw err;
      }
    }
    try {
      if (['workbook', 'background'].includes(ref.owner)) await c.launch.stop(ref.sessionId, { clientRequestId: crypto.randomUUID() });
    } catch (err) {
      log('source stop failed: ' + (err && err.code));
    }
    c.sessions.setHandedOff(ref.sessionId, { targetSessionId: job.targetSessionId || null, targetTitle: job._.name, migrationId: job.migrationId });
    return 'source paused';
  }

  /**
   * A workspace that can hold the target session: the source's project,
   * else the project holding sessions in the directory, else the active or
   * first project, else a new one (B2's workspaceFor rule).
   *
   * @param {string|null} projectId - Source project.
   * @param {string} dir - Working directory.
   * @returns {string}
   */
  function projectFor(projectId, dir) {
    const s = ctx.store;
    const ws = (s.state && s.state.workspaces) || {};
    if (projectId && projectId !== 'unassigned' && ws[projectId]) return projectId;
    const common = require('../common');
    const want = common.normalizePath(dir);
    const holders = new Set(s.getAllSessionsList().filter((x) => x.workingDir && common.normalizePath(x.workingDir) === want).map((x) => x.workspaceId).filter((w) => ws[w]));
    if (holders.size) return Array.from(holders)[0];
    const active = s.getActiveWorkspace && s.getActiveWorkspace();
    if (active && active.id) return active.id;
    const all = s.getAllWorkspacesList ? s.getAllWorkspacesList() : [];
    if (all.length) return all[0].id;
    return s.createWorkspace({ name: PHONE_WORKSPACE_NAME }).id;
  }

  /**
   * The extra CLI arguments of a Claude takeover (and fork): only known
   * flags and pack paths, each checked by the S10 descriptor rules.
   *
   * @param {object} job - Job.
   * @param {object} ref - Source SessionRef.
   * @returns {string[]}
   */
  function claudeArgs(job, ref) {
    const args = [];
    if (job.mode === 'fork') args.push('--resume', ref.upstreamId, '--fork-session');
    args.push('--append-system-prompt-file', job._.charterPath, '--add-dir', job._.packDir);
    try {
      require('../../../../providers/claude/spawn').checkArgsExtra(args);
    } catch (_) {
      const err = new Error('The migration folder path has spaces or symbols a command line cannot carry safely. Move the Workbook data folder to a plain path and retry.');
      err.code = 'LAUNCH_FAILED';
      throw err;
    }
    return args;
  }

  /**
   * Launch the target session through B2 and deliver the fixed kickoff.
   *
   * @param {object} job - Job (mutated: targetSessionId).
   * @param {object} ref - Source SessionRef.
   * @param {object} placement - {tabGroupId, afterSessionId}
   * @returns {Promise<object>} The new SessionSummary.
   */
  async function launch(job, ref, placement) {
    const c = chat();
    if (!c || !c.launch || typeof c.launch.createSession !== 'function') {
      const err = new Error('Workbook cannot start sessions for the phone here.');
      err.code = 'LAUNCH_FAILED';
      throw err;
    }
    let dir = job._.cwd;
    if (!dir || !fs.existsSync(dir)) {
      if (job._.gitTop && fs.existsSync(job._.gitTop)) dir = job._.gitTop;
      else {
        const err = new Error('The working directory of the source no longer exists.');
        err.code = 'WORKING_DIR_NOT_FOUND';
        throw err;
      }
    }
    const t = job.target;
    const who = { deviceId: job._.deviceId || null };
    let summary;
    if (t.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 migration launch)
      const argsExtra = claudeArgs(job, ref);
      summary = await c.launch.createSession({
        clientRequestId: crypto.randomUUID(),
        provider: 'claude', // gsd:provider-literal-allowed (mobile v2 migration launch)
        workingDir: dir,
        projectId: projectFor(ref.projectId, dir),
        name: job._.name,
        settings: Object.assign({ model: t.model, permissionMode: 'plan' }, t.effort ? { effort: t.effort } : {}),
        tabGroupId: placement.tabGroupId || null,
        afterSessionId: placement.afterSessionId || null,
        argsExtra,
      }, who);
    } else if (job.mode === 'fork') {
      // Codex "Continue as is": the native fork (codex fork <thread>) through
      // B2's branch; the thread keeps its own model (a Codex fork cannot
      // change it from the command line in this build).
      const r = await c.internals.launch.branch(ref.sessionId, { clientRequestId: crypto.randomUUID(), fromMessageId: null, name: job._.name, tabGroupId: placement.tabGroupId || null, afterSessionId: placement.afterSessionId || null }, who);
      summary = r.session;
    } else {
      summary = await c.launch.createSession({
        clientRequestId: crypto.randomUUID(),
        provider: 'codex', // gsd:provider-literal-allowed (mobile v2 migration launch)
        workingDir: dir,
        projectId: projectFor(ref.projectId, dir),
        name: job._.name,
        settings: Object.assign({ model: t.model, sandbox: 'read-only', approvalPolicy: 'never' }, t.effort ? { reasoningEffort: t.effort } : {}),
        tabGroupId: placement.tabGroupId || null,
        afterSessionId: placement.afterSessionId || null,
      }, who);
    }
    if (!summary || !summary.sessionId) {
      const err = new Error('The takeover session did not start.');
      err.code = 'LAUNCH_FAILED';
      throw err;
    }
    job.targetSessionId = summary.sessionId;
    return summary;
  }

  /**
   * The fixed kickoff of a job (never free text, R08 section 4.4).
   *
   * @param {object} job - Job.
   * @returns {string}
   */
  function kickoffText(job) {
    if (job.target.provider === 'codex') { // gsd:provider-literal-allowed (mobile v2 migration launch)
      return job.mode === 'fork' ? charter.forkKickoff(job._.charterPath) : charter.codexKickoff(job._.startPath);
    }
    return charter.CLAUDE_KICKOFF;
  }

  /**
   * Deliver the kickoff as a system send (B2's gate: it waits for the TUI).
   *
   * @param {object} job - Job.
   * @returns {Promise<object>} SendRecord.
   */
  async function kickoff(job) {
    const c = chat();
    return c.sends.enqueueSystem(job.targetSessionId, kickoffText(job), { origin: 'migration' });
  }

  return { pauseSource, launch, kickoff, kickoffText, turnOpen, projectFor };
}

module.exports = { createMigrationLauncher };
