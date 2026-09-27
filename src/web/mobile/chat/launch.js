/**
 * Launching sessions for the phone (PROTOCOL.md 4.5.4 to 4.5.8 and 9.3).
 *
 * What: start or attach a session through pty-manager's launchDetached (the
 * same live session gate as a desktop pane, with no socket), new session,
 * restart now or when idle, stop, continue here for a ChatGPT owned Codex
 * thread, resume anyway after a hand off, and branch (a native fork on the
 * same provider that never touches the source). Discovered conversations get
 * a tracked store session the first time Workbook starts them.
 *
 * Why: two processes must never write one transcript (R04:302, d70df18), so
 * every start the phone causes goes through the gate, and a branch is
 * evaluated for the new session only.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { warn, log } = require('./common');

const RESTART_IDLE_MS = 2000;
const FORK_MAX_BYTES = 200 * 1024 * 1024;
const IDEMPOTENCY_MS = 10 * 60 * 1000;
const NAME_MAX = 200;
const WORKDIR_UNSAFE_RE = /[;&|`$(){}[\]<>!#*?\n\r]/;
// A model id starts with a letter or digit: a leading hyphen would let a phone
// supplied value read as a CLI flag once it reaches the command line (W2).
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'];
const CODEX_SANDBOX = ['read-only', 'workspace-write', 'danger-full-access', 'disabled', 'managed'];
const CODEX_APPROVAL = ['untrusted', 'on-failure', 'on-request', 'never'];
const PHONE_WORKSPACE_NAME = 'From the phone';
/**
 * The fields of NewSessionRequest (protocol/schemas/sessions/new-session-request.json).
 * A phone's POST /sessions body is reduced to these before anything reads it:
 * PROTOCOL.md 0.1 says unknown request fields are ignored, and nothing in an
 * HTTP body may ever reach a command line (W2).
 */
const NEW_SESSION_FIELDS = Object.freeze(['clientRequestId', 'provider', 'workingDir', 'projectId', 'name', 'settings', 'tabGroupId', 'afterSessionId', 'message']);
/** Extra CLI arguments an in process caller (B3's migration launch) may pass. */
const ARGS_EXTRA_MAX = 32;
const ARG_EXTRA_MAX_LEN = 4096;
/** Control characters never belong in a CLI argument. */
const ARG_CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** Why a restart refused: the launch codes that mean a live copy elsewhere. */
const LIVE_ELSEWHERE_CODES = new Set(['SESSION_LIVE_ELSEWHERE']);

/**
 * Workbook's working directory screen (server.js sanitizeWorkingDir), repeated here.
 * @param {*} dir
 * @returns {string|null}
 */
function sanitizeWorkingDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const t = dir.trim();
  if (!t || t.length > 500 || WORKDIR_UNSAFE_RE.test(t)) return null;
  return t;
}

/**
 * @param {object} deps - {ctx, index, lazy: {turns, sends, linker}, now}
 * @returns {object}
 */
function createLauncher(deps) {
  const { ctx, index } = deps;
  const now = deps.now || Date.now;
  const lazy = deps.lazy || {};
  const done = new Map();
  const pendingRestarts = new Map();
  const unknownLogged = new Set();
  let groupWarned = false;
  const fail = (status, code, message, extra) => { const E = require('./common').errorClass(ctx); throw new E(status, code, message, extra); };
  const store = () => ctx.store;
  const pm = () => (typeof ctx.getPtyManager === 'function' ? ctx.getPtyManager() : null);
  const ws = () => (ctx.mobile && ctx.mobile.workspace) || null;

  function audit(deviceId, action, sessionId, detail, ok) {
    const a = ctx.mobile && ctx.mobile.audit;
    if (a && a.write) { try { a.write({ deviceId, action, sessionId, detail, ok }); } catch (_) {} }
  }

  /**
   * Idempotency by clientRequestId (PROTOCOL.md 0.7).
   * @param {string} scope
   * @param {object} body
   * @param {() => Promise<object>} fn
   */
  async function once(scope, body, fn) {
    const id = body && typeof body.clientRequestId === 'string' ? scope + '|' + body.clientRequestId : null;
    if (id) {
      const prev = done.get(id);
      if (prev && now() - prev.at <= IDEMPOTENCY_MS) return prev.result;
    }
    const result = await fn();
    if (id) done.set(id, { at: now(), result });
    return result;
  }

  /**
   * A workspace to hold a new tracked session.
   * @param {string|null} projectId
   * @returns {string}
   */
  function workspaceFor(projectId) {
    const s = store();
    if (projectId && projectId !== 'unassigned' && s.state.workspaces && s.state.workspaces[projectId]) return projectId;
    const active = s.getActiveWorkspace && s.getActiveWorkspace();
    if (active && active.id) return active.id;
    const all = s.getAllWorkspacesList ? s.getAllWorkspacesList() : [];
    if (all.length) return all[0].id;
    return s.createWorkspace({ name: PHONE_WORKSPACE_NAME }).id;
  }

  /**
   * Launch options from B3 when present (model, effort, permission mode, Codex settings).
   * @param {string} sessionId
   * @returns {object}
   */
  function launchOptions(sessionId) {
    const w = ws();
    try { if (w && w.settings && w.settings.launchOptionsFor) return w.settings.launchOptionsFor(sessionId) || {}; } catch (_) {}
    return {};
  }

  /**
   * A tracked store session for a conversation (created for discovered ones).
   * @param {object} ref
   * @returns {string} Workbook session id
   */
  function ensureStoreSession(ref) {
    if (ref.workbookSessionId) return ref.workbookSessionId;
    const s = store();
    const rec = s.createSession({ name: ref.title || path.basename(ref.workingDir || '') || 'Session', workspaceId: workspaceFor(ref.projectId), workingDir: ref.workingDir || '', command: ref.provider, resumeSessionId: ref.upstreamId });
    if (!rec) fail(500, 'INTERNAL', 'Workbook could not create a session record.');
    const opts = launchOptions(ref.sessionId);
    const upd = { provider: ref.provider };
    if (opts.model) upd.model = opts.model;
    if (opts.effort) upd.effort = opts.effort;
    if (opts.permissionMode) { upd.permissionMode = opts.permissionMode; if (opts.permissionMode === 'bypassPermissions') upd.bypassPermissions = true; }
    s.updateSession(rec.id, upd);
    index.invalidate();
    return rec.id;
  }

  /**
   * Start or attach a session for the phone (send to none or background, interrupt of background).
   * @param {string} sessionId
   * @param {{reason?: string, spawnOpts?: object}} [o]
   * @returns {Promise<{status: string, code: (string|null)}>}
   */
  async function start(sessionId, o = {}) {
    const ref = index.resolve(sessionId);
    if (!ref) return { status: 'refused', code: 'SESSION_NOT_FOUND' };
    if (['external', 'chatgpt', 'handedOff'].includes(ref.owner)) return { status: 'refused', code: 'SESSION_READ_ONLY' };
    const m = pm();
    if (!m || typeof m.launchDetached !== 'function') return { status: 'refused', code: 'LAUNCH_FAILED' };
    const wbId = ensureStoreSession(ref);
    const res = await m.launchDetached(wbId, Object.assign({}, o.spawnOpts || {}));
    index.invalidate();
    if (res.status !== 'refused') index.noteChanged(index.idForWorkbookSession(wbId) || sessionId, 'updated');
    return { status: res.status, code: res.code || null };
  }

  /**
   * Validate new session settings (PROTOCOL.md 4.5.3 lists; B3 owns the schema).
   * @param {string} provider
   * @param {object} settings
   * @returns {object}
   */
  function validateSettings(provider, settings) {
    const v = settings && typeof settings === 'object' ? settings : {};
    const out = {};
    const bad = (field) => fail(422, 'INVALID_SETTING', 'That value is not allowed for ' + field + '.', { field });
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) continue;
      if (k === 'model') { if (typeof val !== 'string' || !MODEL_RE.test(val)) bad(k); out.model = val; continue; }
      if (provider === 'claude') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        if (k === 'effort') { if (!CLAUDE_EFFORTS.includes(val)) bad(k); out.effort = val; continue; }
        if (k === 'permissionMode') { if (!CLAUDE_MODES.includes(val)) bad(k); out.permissionMode = val; continue; }
      } else {
        if (k === 'reasoningEffort') { if (!CODEX_EFFORTS.includes(val)) bad(k); out.reasoningEffort = val; continue; }
        if (k === 'sandbox') { if (!CODEX_SANDBOX.includes(val)) bad(k); out.sandbox = val; continue; }
        if (k === 'approvalPolicy') { if (!CODEX_APPROVAL.includes(val)) bad(k); out.approvalPolicy = val; continue; }
        if (k === 'bypassApprovalsAndSandbox') { if (typeof val !== 'boolean') bad(k); out.bypassApprovalsAndSandbox = val; continue; }
      }
      bad(k);
    }
    return out;
  }

  /**
   * Store the validated settings on a new record.
   * @param {string} wbId
   * @param {string} provider
   * @param {object} st
   */
  function applySettings(wbId, provider, st) {
    const upd = { provider };
    if (st.model) upd.model = st.model;
    if (provider === 'claude') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      if (st.effort) upd.effort = st.effort;
      if (st.permissionMode) { upd.permissionMode = st.permissionMode; upd.bypassPermissions = st.permissionMode === 'bypassPermissions'; }
    } else {
      const ps = {};
      for (const k of ['model', 'reasoningEffort', 'sandbox', 'approvalPolicy', 'bypassApprovalsAndSandbox']) if (st[k] !== undefined) ps[k] = st[k];
      if (Object.keys(ps).length && store().updateSessionProviderSettings) store().updateSessionProviderSettings(wbId, 'codex', ps); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    }
    store().updateSession(wbId, upd);
  }

  /**
   * Place a new session in a desktop tab group through B3 (409 TAB_GROUP_FULL passes through).
   * @param {string|null} tabGroupId
   * @param {string} sessionId
   * @param {string|null} afterSessionId
   */
  function place(tabGroupId, sessionId, afterSessionId) {
    if (!tabGroupId) return;
    const w = ws();
    if (w && w.tabs && w.tabs.addSessionToGroup) { w.tabs.addSessionToGroup(tabGroupId, sessionId, afterSessionId || null); return; }
    if (!groupWarned) { groupWarned = true; log('tab group placement needs the workspace module; the group was ignored'); }
  }

  /**
   * The phone id of a Workbook session after launch (cl_ once minted).
   * @param {string} wbId
   * @returns {string}
   */
  function phoneIdOf(wbId) {
    index.invalidate();
    return index.idForWorkbookSession(wbId) || 'wb_' + wbId;
  }

  /**
   * Reduce a phone's POST /sessions body to the NewSessionRequest fields.
   * Unknown fields are dropped and logged once per route (PROTOCOL.md 0.1),
   * so a field such as argsExtra, command or flags in an HTTP body can never
   * reach launchDetached or a command line.
   * @param {*} body
   * @returns {object}
   */
  function pickRequestFields(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const out = {};
    const unknown = [];
    for (const k of Object.keys(b)) {
      if (NEW_SESSION_FIELDS.includes(k)) out[k] = b[k]; else unknown.push(k);
    }
    if (unknown.length && !unknownLogged.has('POST /sessions')) {
      unknownLogged.add('POST /sessions');
      log('POST /sessions ignored unknown request fields: ' + unknown.slice(0, 10).join(', '));
    }
    return out;
  }

  /**
   * Check extra CLI arguments from an in process caller: an array of at most
   * 32 plain strings with no control characters. Never fed from HTTP.
   * @param {*} argsExtra
   * @returns {string[]|null}
   */
  function checkArgsExtra(argsExtra) {
    if (argsExtra === undefined || argsExtra === null) return null;
    if (!Array.isArray(argsExtra) || argsExtra.length > ARGS_EXTRA_MAX) fail(400, 'INVALID_FIELD', 'argsExtra must be a short list of strings.', { field: 'argsExtra' });
    for (const a of argsExtra) {
      if (typeof a !== 'string' || !a || a.length > ARG_EXTRA_MAX_LEN || ARG_CONTROL_RE.test(a)) fail(400, 'INVALID_FIELD', 'argsExtra holds a value that is not a plain argument.', { field: 'argsExtra' });
    }
    return argsExtra.slice();
  }

  /**
   * Map B3's launch options shape (BUILD-CONTRACT 3.4.4 launchOptionsFor:
   * {model, effort, permissionMode, bypassPermissions, codex: {...}}) to the
   * NewSessionRequest settings shape; nulls mean unset.
   * @param {string} provider
   * @param {*} lo
   * @returns {object}
   */
  function settingsFromLaunchOptions(provider, lo) {
    const o = lo && typeof lo === 'object' ? lo : {};
    const out = {};
    const put = (k, v) => { if (v !== null && v !== undefined) out[k] = v; };
    if (provider === 'claude') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      put('model', o.model);
      put('effort', o.effort);
      put('permissionMode', o.permissionMode || (o.bypassPermissions === true ? 'bypassPermissions' : null));
    } else {
      const c = o.codex && typeof o.codex === 'object' ? o.codex : o;
      put('model', c.model !== undefined ? c.model : o.model);
      put('reasoningEffort', c.reasoningEffort);
      put('sandbox', c.sandbox);
      put('approvalPolicy', c.approvalPolicy);
      put('bypassApprovalsAndSandbox', c.bypassApprovalsAndSandbox);
    }
    return out;
  }

  /**
   * POST /sessions (PROTOCOL.md 4.5.6): the phone's request, reduced to its
   * schema fields first. It can never carry argsExtra.
   * @param {object} body
   * @param {{deviceId: (string|null)}} who
   * @returns {Promise<{session: object, send: (object|null)}>}
   */
  function createSessionFromRequest(body, who) {
    return launchNew(pickRequestFields(body), who, { argsExtra: null });
  }

  /**
   * chat.launch.createSession for in process callers (BUILD-CONTRACT 3.4.3):
   * ({provider, workingDir, projectId, name, launchOptions, argsExtra}) =>
   * Promise<SessionSummary>. B3's migration launch passes its charter flags
   * as argsExtra; this is the only path that can set them.
   * @param {object} o
   * @param {{deviceId: (string|null)}} [who]
   * @returns {Promise<object>} SessionSummary
   */
  async function createSession(o, who) {
    const opts = o && typeof o === 'object' ? o : {};
    const argsExtra = checkArgsExtra(opts.argsExtra);
    const fields = {
      clientRequestId: typeof opts.clientRequestId === 'string' ? opts.clientRequestId : undefined,
      provider: opts.provider,
      workingDir: opts.workingDir,
      projectId: opts.projectId || null,
      name: opts.name || null,
      settings: opts.settings && typeof opts.settings === 'object' ? opts.settings : settingsFromLaunchOptions(opts.provider, opts.launchOptions),
      tabGroupId: opts.tabGroupId || null,
      afterSessionId: opts.afterSessionId || null,
      message: null,
    };
    const r = await launchNew(fields, who || { deviceId: null }, { argsExtra });
    return r.session;
  }

  /**
   * Create a tracked session and start it (the shared body of both entry points).
   * @param {object} body - NewSessionRequest fields only
   * @param {{deviceId: (string|null)}} who
   * @param {{argsExtra: (string[]|null)}} trusted - set only by in process callers
   * @returns {Promise<{session: object, send: (object|null)}>}
   */
  async function launchNew(body, who, trusted) {
    return once('new', body, async () => {
      const b = body || {};
      if (!['claude', 'codex'].includes(b.provider)) fail(400, 'INVALID_FIELD', 'provider must be claude or codex.', { field: 'provider' }); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const dir = sanitizeWorkingDir(b.workingDir);
      if (!dir || !path.isAbsolute(dir)) fail(400, 'INVALID_FIELD', 'workingDir must be an absolute folder path.', { field: 'workingDir' });
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch (_) { isDir = false; }
      if (!isDir) fail(422, 'WORKING_DIR_NOT_FOUND', 'That folder does not exist on ' + index.computerName() + '.');
      const s = store();
      let projectId = b.projectId || null;
      if (projectId && !(s.state.workspaces && s.state.workspaces[projectId])) fail(404, 'PROJECT_NOT_FOUND', 'That project does not exist.');
      if (!projectId) {
        const { normalizeCwd } = require('../../../providers/claude/live-sessions');
        const want = normalizeCwd(dir);
        const holders = new Set(s.getAllSessionsList().filter((x) => x.workingDir && normalizeCwd(x.workingDir) === want).map((x) => x.workspaceId));
        if (holders.size !== 1) fail(422, 'PROJECT_REQUIRED', 'Choose a project for this session.');
        projectId = Array.from(holders)[0];
      }
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, NAME_MAX) : path.basename(dir.replace(/[\\/]+$/, ''));
      const st = validateSettings(b.provider, b.settings);
      const rec = s.createSession({ name, workspaceId: projectId, workingDir: dir, command: b.provider });
      if (!rec) fail(500, 'INTERNAL', 'Workbook could not create a session record.');
      applySettings(rec.id, b.provider, st);
      const m = pm();
      const spawnOpts = {};
      if (trusted && Array.isArray(trusted.argsExtra)) spawnOpts.argsExtra = trusted.argsExtra.slice();
      const launchAt = now();
      const res = m ? await m.launchDetached(rec.id, spawnOpts) : { status: 'refused', code: 'LAUNCH_FAILED' };
      if (res.status === 'refused') {
        if (res.code === 'SESSION_LIVE_ELSEWHERE') fail(409, 'SESSION_LIVE_ELSEWHERE', res.message || 'That conversation is open elsewhere.');
        fail(500, 'INTERNAL', 'The session could not be started.');
      }
      const sid = phoneIdOf(rec.id);
      if (b.provider === 'codex' && lazy.linker && lazy.linker()) lazy.linker().track(rec.id, { cwd: dir, launchAt, firstText: b.message && b.message.text ? b.message.text : null }); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      place(b.tabGroupId || null, sid, b.afterSessionId || null);
      let send = null;
      if (b.message && lazy.sends && lazy.sends()) {
        const r = lazy.sends().accept(sid, b.message, { deviceId: who.deviceId, reason: 'starting' });
        send = r.send;
      }
      index.noteChanged(sid, 'added');
      audit(who.deviceId, 'newSession', sid, b.provider, true);
      return { session: index.summary(sid), send };
    });
  }

  /**
   * POST /sessions/:sessionId/restart (PROTOCOL.md 4.5.4).
   * @param {string} sessionId
   * @param {object} body
   * @param {{deviceId: string}} who
   * @returns {Promise<{status: string}>}
   */
  async function restart(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    return once('restart|' + ref.sessionId, body, async () => {
      const when = body && body.when === 'whenIdle' ? 'whenIdle' : 'now';
      if (ref.owner === 'none') {
        const started = await start(ref.sessionId, {});
        if (started.status === 'refused') {
          audit(who.deviceId, 'restart', ref.sessionId, 'refused ' + (started.code || ''), false);
          failRefusal(started);
        }
        audit(who.deviceId, 'restart', ref.sessionId, 'start', true);
        return { status: 'restarting' };
      }
      if (ref.owner !== 'workbook') fail(409, 'SESSION_READ_ONLY', 'This session cannot be restarted from the phone.', { owner: ref.owner, reason: (index.meta(ref.sessionId) || {}).readOnlyReason || null });
      const turns = lazy.turns && lazy.turns();
      const busy = turns && turns.isTurnOpen(ref.sessionId);
      if (when === 'now' && busy) fail(409, 'SESSION_BUSY', 'A turn is running. Restart when it ends.');
      if (when === 'whenIdle') {
        if (!pendingRestarts.has(ref.sessionId)) scheduleIdleRestart(ref.sessionId);
        audit(who.deviceId, 'restart', ref.sessionId, 'scheduled', true);
        return { status: 'scheduled' };
      }
      const res = await doRestart(ref);
      if (res.status === 'refused') {
        audit(who.deviceId, 'restart', ref.sessionId, 'refused ' + (res.code || ''), false);
        failRefusal(res);
      }
      audit(who.deviceId, 'restart', ref.sessionId, 'now', true);
      return { status: 'restarting' };
    });
  }

  /**
   * Turn a launch refusal into the route's error: 409 SESSION_LIVE_ELSEWHERE
   * when the live gate found the transcript open elsewhere, else 500, so the
   * phone never hears "restarting" when nothing runs.
   * @param {{status: string, code: (string|null), message?: (string|null)}} res
   */
  function failRefusal(res) {
    if (res && LIVE_ELSEWHERE_CODES.has(res.code)) fail(409, 'SESSION_LIVE_ELSEWHERE', res.message || 'That conversation is open elsewhere.');
    fail(500, 'INTERNAL', 'The session could not be started' + (res && res.code ? ' (' + res.code + ').' : '.'));
  }

  /**
   * Kill and relaunch a Workbook hosted session with its stored settings.
   * @param {object} ref
   * @returns {Promise<{status: string, code: (string|null), message: (string|null)}>} the relaunch result
   */
  async function doRestart(ref) {
    const m = pm();
    m.killSession(ref.workbookSessionId);
    await new Promise((r) => setTimeout(r, 300));
    let res;
    try { res = await m.launchDetached(ref.workbookSessionId, {}); } catch (err) { res = { status: 'refused', code: 'LAUNCH_FAILED', message: err && err.message ? String(err.message) : null }; }
    if (!res || typeof res.status !== 'string') res = { status: 'refused', code: 'LAUNCH_FAILED', message: null };
    index.invalidate();
    index.noteChanged(ref.sessionId, 'updated');
    if (lazy.turns && lazy.turns()) lazy.turns().publishMeta(ref.sessionId);
    return res;
  }

  /**
   * Restart the first time the session has been idle for 2 s.
   * @param {string} sessionId
   */
  function scheduleIdleRestart(sessionId) {
    const turns = lazy.turns && lazy.turns();
    let idleSince = 0;
    const timer = setInterval(async () => {
      const st = turns ? turns.stateOf(sessionId) : null;
      if (st && st.state === 'idle' && !(turns && turns.isTurnOpen(sessionId))) {
        if (!idleSince) idleSince = now();
        if (now() - idleSince >= RESTART_IDLE_MS) {
          clearInterval(timer);
          pendingRestarts.delete(sessionId);
          const ref = index.resolve(sessionId);
          if (ref && ref.owner === 'workbook') {
            try {
              const res = await doRestart(ref);
              if (res.status === 'refused') warn('idle restart refused', sessionId, res.code);
            } catch (err) { warn('idle restart failed', err && err.message); }
          }
        }
      } else {
        idleSince = 0;
      }
    }, 250);
    if (timer.unref) timer.unref();
    pendingRestarts.set(sessionId, timer);
  }

  /**
   * POST /sessions/:sessionId/stop (PROTOCOL.md 4.5.5).
   * @param {string} sessionId
   * @param {object} body
   * @param {{deviceId: string}} who
   * @returns {Promise<{status: string}>}
   */
  async function stop(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    return once('stop|' + ref.sessionId, body, async () => {
      if (ref.owner === 'none') return { status: 'notRunning' };
      if (ref.owner === 'workbook') {
        pm().killSession(ref.workbookSessionId);
      } else if (ref.owner === 'background') {
        await claudeStop(ref.upstreamId);
      } else {
        fail(409, 'SESSION_READ_ONLY', 'This session cannot be stopped from the phone.', { owner: ref.owner, reason: (index.meta(ref.sessionId) || {}).readOnlyReason || null });
      }
      index.invalidate();
      index.noteChanged(ref.sessionId, 'updated');
      audit(who.deviceId, 'stop', ref.sessionId, ref.owner, true);
      return { status: 'stopped' };
    });
  }

  /**
   * Run `claude stop <id>` for a background session.
   * @param {string} upstreamId
   * @returns {Promise<void>}
   */
  function claudeStop(upstreamId) {
    return new Promise((resolve) => {
      if (!/^[A-Za-z0-9-]+$/.test(String(upstreamId || ''))) { resolve(); return; }
      const env = Object.assign({}, process.env);
      delete env.CLAUDECODE;
      const isWin = process.platform === 'win32';
      const cmd = isWin ? (env.ComSpec || 'cmd.exe') : 'claude'; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const args = isWin ? ['/d', '/s', '/c', 'claude stop ' + upstreamId] : ['stop', upstreamId];
      try {
        childProcess.execFile(cmd, args, { env, windowsHide: true, timeout: 15000 }, () => resolve());
      } catch (_) { resolve(); }
    });
  }

  /**
   * POST /sessions/:sessionId/continue-here (PROTOCOL.md 4.5.7).
   * @param {string} sessionId
   * @param {object} body
   * @param {{deviceId: string}} who
   * @returns {Promise<{session: object}>}
   */
  async function continueHere(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    return once('continue|' + ref.sessionId, body, async () => {
      if (ref.provider !== 'codex' || ref.owner !== 'chatgpt') fail(409, 'NOT_CHATGPT_THREAD', 'This session is not a ChatGPT thread.'); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      if (!body || body.confirmTwoWriters !== true) fail(422, 'CONFIRM_REQUIRED', 'Confirm that ChatGPT may also write to this thread.');
      const s = store();
      const rec = s.createSession({ name: ref.title, workspaceId: workspaceFor(ref.projectId), workingDir: ref.workingDir || '', command: 'codex', resumeSessionId: ref.upstreamId }); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      s.updateSession(rec.id, { provider: 'codex' }); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const res = await pm().launchDetached(rec.id, {});
      if (res.status === 'refused') fail(409, 'SESSION_LIVE_ELSEWHERE', res.message || 'Workbook could not open this thread.');
      index.invalidate();
      audit(who.deviceId, 'continueHere', ref.sessionId, 'codex', true); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      return { session: index.summary(phoneIdOf(rec.id)) };
    });
  }

  /**
   * POST /sessions/:sessionId/resume-anyway (PROTOCOL.md 4.5.7).
   * @param {string} sessionId
   * @param {object} body
   * @param {{deviceId: string}} who
   * @returns {object} SessionMeta
   */
  function resumeAnyway(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    if (ref.owner !== 'handedOff') fail(409, 'NOT_HANDED_OFF', 'This session was not handed off.');
    if (!body || body.confirm !== true) fail(422, 'CONFIRM_REQUIRED', 'Confirm resuming this session.');
    index.setHandedOff(ref.sessionId, null);
    audit(who.deviceId, 'resumeAnyway', ref.sessionId, null, true);
    return index.meta(ref.sessionId);
  }

  /**
   * POST /sessions/:sessionId/branch (PROTOCOL.md 4.5.8).
   * @param {string} sessionId
   * @param {object} body - BranchRequest
   * @param {{deviceId: string}} who
   * @returns {Promise<{session: object, send: null}>}
   */
  async function branch(sessionId, body, who) {
    const ref = index.resolve(sessionId);
    if (!ref) fail(404, 'SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    return once('branch|' + ref.sessionId, body, async () => {
      const b = body || {};
      if (!ref.upstreamId || !ref.transcriptPath) fail(409, 'TRANSCRIPT_UNAVAILABLE', 'This session has no history to branch yet.');
      if (b.fromMessageId !== undefined && b.fromMessageId !== null && ref.provider === 'codex') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        // Cutting Codex history needs thread/fork with lastTurnId (phase 5): always refused.
        fail(422, 'BRANCH_POINT_UNSUPPORTED', 'Branching a Codex session from a chosen message is not available yet.');
      }
      if (b.fromMessageId !== undefined && b.fromMessageId !== null) {
        const reader = require('./transcript-reader');
        const mapper = ref.provider === 'claude' ? require('./claude-messages').createClaudeMapper() : require('./codex-messages').createCodexMapper(); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        const off = reader.findMessageOffset(ref.transcriptPath, String(b.fromMessageId), mapper);
        const msg = off === null ? null : reader.readMessageAt(ref.transcriptPath, off, mapper, { sessionId: ref.sessionId });
        if (!msg) fail(404, 'MESSAGE_NOT_FOUND', 'That message does not exist in this session.');
        const allowed = (lazy.capabilities && lazy.capabilities().branchFromMessage) || [];
        if (msg.role !== 'assistant' || !allowed.includes(ref.provider)) fail(422, 'BRANCH_POINT_UNSUPPORTED', 'Branching from a chosen message is not available for this session.');
      }
      let size = 0;
      try { size = fs.statSync(ref.transcriptPath).size; } catch (_) { size = 0; }
      if (size > FORK_MAX_BYTES) fail(413, 'FORK_TOO_LARGE', 'This session is too large to branch.');
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, NAME_MAX) : (ref.title + ' branch').slice(0, NAME_MAX);
      const s = store();
      const rec = s.createSession({ name, workspaceId: workspaceFor(ref.projectId), workingDir: ref.workingDir || '', command: ref.provider });
      if (!rec) fail(500, 'INTERNAL', 'Workbook could not create a session record.');
      let spawnOpts;
      const launchAt = now();
      if (ref.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        const minted = crypto.randomUUID();
        s.updateSession(rec.id, { provider: 'claude' }); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        spawnOpts = { command: 'claude --resume ' + ref.upstreamId + ' --fork-session --session-id ' + minted };
        const res = await pm().launchDetached(rec.id, spawnOpts);
        if (res.status === 'refused') fail(409, 'SESSION_LIVE_ELSEWHERE', res.message || 'The branch could not be started.');
        s.updateSession(rec.id, { resumeSessionId: minted });
      } else {
        s.updateSession(rec.id, { provider: 'codex' }); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
        spawnOpts = { command: 'codex fork ' + ref.upstreamId };
        const res = await pm().launchDetached(rec.id, spawnOpts);
        if (res.status === 'refused') fail(409, 'SESSION_LIVE_ELSEWHERE', res.message || 'The branch could not be started.');
        if (lazy.linker && lazy.linker()) lazy.linker().track(rec.id, { cwd: ref.workingDir, launchAt, firstText: null, excludeThreadId: ref.upstreamId });
      }
      const sid = phoneIdOf(rec.id);
      place(b.tabGroupId || null, sid, b.afterSessionId || null);
      index.noteChanged(sid, 'added');
      audit(who.deviceId, 'branch', ref.sessionId, sid, true);
      return { session: index.summary(sid), send: null };
    });
  }

  return { start, createSession, createSessionFromRequest, restart, stop, continueHere, resumeAnyway, branch, ensureStoreSession, sanitizeWorkingDir };
}

module.exports = { createLauncher, sanitizeWorkingDir, FORK_MAX_BYTES, NEW_SESSION_FIELDS };
