/**
 * workspace/session-settings.js: GET and PATCH /sessions/:sessionId/settings,
 * the stored values behind them, and launchOptionsFor, which B2 reads every
 * time it starts a session (PROTOCOL.md 4.5.3, BUILD-CONTRACT 3.4.4).
 *
 * WHY: A14 and F16. Settings change what the next launch uses, never the
 * running process, so a PATCH on a live session answers pendingRestart and
 * "Restart with these settings" (B2's restart route) applies them. Values
 * live where Workbook already keeps them, so the desktop and the phone see
 * one truth: tracked Claude sessions on the store record (model, effort,
 * permissionMode, bypassPermissions), Codex sessions in the provider
 * settings bundle (the store record, or the ad hoc per upstream id bundle
 * the existing provider settings route writes for discovered threads), and
 * discovered Claude sessions in <dataDir>/mobile/session-settings.json until
 * Workbook first creates a store session for them (B2's ensureStoreSession
 * applies launchOptionsFor then).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const common = require('./common');

/** File for discovered Claude sessions, under <dataDir>/mobile/. */
const FILE_NAME = 'session-settings.json';
/** File format version. */
const FILE_VERSION = 1;
/** Owners whose settings cannot be changed from the phone (PROTOCOL.md 9.2). */
const SETTINGS_READ_ONLY_OWNERS = new Set(['chatgpt', 'handedOff']);
/** Owners that may restart now (PROTOCOL.md 4.5.3 canRestartNow). */
const RESTARTABLE_OWNERS = new Set(['workbook', 'none']);
/** Owners with a running process (PROTOCOL.md 3.4.4 live). */
const LIVE_OWNERS = new Set(['workbook', 'background', 'external', 'chatgpt']);
/** Codex bundle keys the provider settings route accepts (server.js CODEX_ALLOWED_KEYS). */
const CODEX_KEYS = Object.freeze(['model', 'reasoningEffort', 'sandbox', 'approvalPolicy', 'bypassApprovalsAndSandbox']);

/**
 * Create the session settings service.
 *
 * @param {object} deps - {ctx, schema, now}
 * @returns {object}
 */
function createSessionSettings(deps) {
  const ctx = deps.ctx;
  const schema = deps.schema;
  const now = deps.now || Date.now;
  const log = common.logger(ctx);
  const p = common.parts(ctx);
  const file = path.join(common.mobileDir(ctx), FILE_NAME);
  const doc = common.readJson(file, null);
  /** phone id -> {model, effort, permissionMode} for discovered Claude sessions */
  const discovered = new Map(Object.entries((doc && doc.sessions) || {}));
  /** phone id -> {atMs, wbId} while a live session waits for a restart */
  const pending = new Map();

  const store = () => ctx.store;

  /** Persist discovered Claude settings atomically. */
  function save() {
    const out = {};
    for (const [id, v] of discovered) out[id] = v;
    try { common.writeJson(file, { version: FILE_VERSION, sessions: out }); } catch (err) { log('settings write failed: ' + (err && err.message)); }
  }

  /**
   * Resolve a phone id or answer 404.
   *
   * @param {string} sessionId - Phone id.
   * @returns {object} SessionRef.
   */
  function resolveOr404(sessionId) {
    const chat = p.chat();
    const ref = chat && chat.sessions && typeof chat.sessions.resolve === 'function' ? chat.sessions.resolve(sessionId) : null;
    if (!ref) common.fail('SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    return ref;
  }

  /**
   * The store record of a tracked session, or null.
   *
   * @param {object} ref - SessionRef.
   * @returns {object|null}
   */
  function recordOf(ref) {
    const s = store();
    return ref && ref.workbookSessionId && s && typeof s.getSession === 'function' ? s.getSession(ref.workbookSessionId) : null;
  }

  /**
   * The Codex bundle of a session (record, else ad hoc by upstream id).
   *
   * @param {object} ref - SessionRef.
   * @returns {object}
   */
  function codexBundle(ref) {
    const s = store();
    const rec = recordOf(ref);
    if (rec && rec.providerSettings && rec.providerSettings.codex && typeof rec.providerSettings.codex === 'object') return rec.providerSettings.codex; // gsd:provider-literal-allowed (mobile v2 session settings)
    if (ref.upstreamId && s && typeof s.getProviderSessionSettings === 'function') {
      const b = s.getProviderSessionSettings('codex', ref.upstreamId); // gsd:provider-literal-allowed (mobile v2 session settings)
      if (b && typeof b === 'object') return b;
    }
    return {};
  }

  /**
   * The stored values of a session in the schema's keys (nulls for unset).
   *
   * @param {object} ref - SessionRef.
   * @returns {object}
   */
  function valuesOf(ref) {
    if (ref.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 session settings)
      const rec = recordOf(ref);
      const d = discovered.get(ref.sessionId) || {};
      if (rec) {
        // A discovered session that Workbook has just started tracking (B2's
        // ensureStoreSession creates the record, then reads launchOptionsFor
        // to fill it): until the record holds a value, the phone's stored
        // value still counts, so nothing set on the phone is lost in between.
        const mode = rec.permissionMode || (rec.bypassPermissions === true ? 'bypassPermissions' : null);
        return { model: rec.model || d.model || null, effort: rec.effort || d.effort || null, permissionMode: mode || d.permissionMode || null };
      }
      return { model: d.model || null, effort: d.effort || null, permissionMode: d.permissionMode || null };
    }
    const b = codexBundle(ref);
    return {
      model: typeof b.model === 'string' ? b.model : null,
      reasoningEffort: typeof b.reasoningEffort === 'string' ? b.reasoningEffort : null,
      sandbox: typeof b.sandbox === 'string' ? b.sandbox : null,
      approvalPolicy: typeof b.approvalPolicy === 'string' ? b.approvalPolicy : null,
      bypassApprovalsAndSandbox: typeof b.bypassApprovalsAndSandbox === 'boolean' ? b.bypassApprovalsAndSandbox : null,
    };
  }

  /**
   * Whether a session's process runs now.
   *
   * @param {object} ref - SessionRef.
   * @returns {boolean}
   */
  function isLive(ref) {
    if (LIVE_OWNERS.has(ref.owner)) return true;
    try {
      const pm = typeof ctx.getPtyManager === 'function' ? ctx.getPtyManager() : null;
      const s = pm && ref.workbookSessionId && pm.getSession ? pm.getSession(ref.workbookSessionId) : null;
      return !!(s && s.alive);
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether a turn is open (B2's turn state).
   *
   * @param {string} sessionId - Phone id.
   * @returns {boolean}
   */
  function turnOpen(sessionId) {
    const chat = p.chat();
    try {
      if (chat && chat.internals && chat.internals.turns && typeof chat.internals.turns.isTurnOpen === 'function') return chat.internals.turns.isTurnOpen(sessionId);
      const st = chat && chat.turns ? chat.turns.stateOf(sessionId) : null;
      return !!(st && ['thinking', 'working', 'streaming', 'needsAnswer', 'needsApproval'].includes(st.state));
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether settings wait for a restart of a live process.
   *
   * @param {object} ref - SessionRef.
   * @returns {boolean}
   */
  function pendingRestartOf(ref) {
    return pending.has(ref.sessionId) && isLive(ref);
  }

  /**
   * The SessionSettings answer (PROTOCOL.md 4.5.3).
   *
   * @param {object} ref - SessionRef.
   * @returns {object}
   */
  function answer(ref) {
    return {
      sessionId: ref.sessionId,
      provider: ref.provider,
      schemaRevision: require('./settings-schema').SCHEMA_REVISION,
      values: valuesOf(ref),
      pendingRestart: pendingRestartOf(ref),
      canRestartNow: RESTARTABLE_OWNERS.has(ref.owner) && !turnOpen(ref.sessionId),
    };
  }

  /**
   * GET /sessions/:sessionId/settings.
   *
   * @param {string} sessionId - Phone id.
   * @returns {object}
   */
  function get(sessionId) {
    return answer(resolveOr404(sessionId));
  }

  /**
   * Write validated values to where the session keeps them.
   *
   * @param {object} ref - SessionRef.
   * @param {object} values - Validated values (null resets).
   */
  function apply(ref, values) {
    const s = store();
    if (ref.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 session settings)
      const rec = recordOf(ref);
      if (rec) {
        const upd = {};
        if ('model' in values) upd.model = values.model;
        if ('effort' in values) upd.effort = values.effort;
        if ('permissionMode' in values) {
          upd.permissionMode = values.permissionMode;
          // The legacy boolean follows the mode, so old readers (the desktop
          // launcher, claude/spawn.js without S10) behave the same way.
          upd.bypassPermissions = values.permissionMode === 'bypassPermissions';
        }
        s.updateSession(rec.id, upd);
        // The record is the truth from now on; a leftover phone entry from
        // before the session was tracked must not bring a reset value back.
        if (discovered.delete(ref.sessionId)) save();
        return;
      }
      const cur = Object.assign({ model: null, effort: null, permissionMode: null }, discovered.get(ref.sessionId) || {});
      for (const k of ['model', 'effort', 'permissionMode']) if (k in values) cur[k] = values[k];
      if (cur.model || cur.effort || cur.permissionMode) discovered.set(ref.sessionId, cur);
      else discovered.delete(ref.sessionId);
      save();
      return;
    }
    // Codex: the same bundle the provider settings route writes (it
    // replaces the bundle, so the current one is merged first).
    const bundle = Object.assign({}, codexBundle(ref));
    for (const k of CODEX_KEYS) {
      if (!(k in values)) continue;
      if (values[k] === null) delete bundle[k];
      else bundle[k] = values[k];
    }
    const rec = recordOf(ref);
    if (rec) s.updateSessionProviderSettings(rec.id, 'codex', bundle); // gsd:provider-literal-allowed (mobile v2 session settings)
    else if (ref.upstreamId) s.setProviderSessionSettings('codex', ref.upstreamId, bundle); // gsd:provider-literal-allowed (mobile v2 session settings)
  }

  /**
   * PATCH /sessions/:sessionId/settings.
   *
   * @param {string} sessionId - Phone id.
   * @param {object} body - SessionSettingsPatch.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {object} SessionSettings.
   */
  function patch(sessionId, body, who) {
    const ref = resolveOr404(sessionId);
    const values = body && body.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
      common.fail('INVALID_FIELD', 'Send at least one setting in values.', { field: 'values' });
    }
    if (SETTINGS_READ_ONLY_OWNERS.has(ref.owner)) {
      const meta = metaOf(ref.sessionId);
      common.fail('SESSION_READ_ONLY', 'Settings of this session cannot be changed from the phone.', { owner: ref.owner, reason: (meta && meta.readOnlyReason) || null });
    }
    const check = schema.validate(ref.provider, values);
    if (!check.ok) common.fail('INVALID_SETTING', 'That value is not allowed for ' + check.field + '.', { field: check.field });
    const before = JSON.stringify(valuesOf(ref));
    apply(ref, check.values);
    const after = valuesOf(resolveOr404(sessionId));
    if (JSON.stringify(after) !== before && isLive(ref)) pending.set(ref.sessionId, { atMs: now(), wbId: ref.workbookSessionId || null });
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'settings', sessionId: ref.sessionId, detail: Object.keys(check.values).join(','), ok: true });
    announce(ref.sessionId);
    return answer(resolveOr404(sessionId));
  }

  /**
   * session.meta on the session topic after a change (settingsPendingRestart).
   *
   * @param {string} sessionId - Phone id.
   */
  function announce(sessionId) {
    const meta = metaOf(sessionId);
    if (meta) common.publish(ctx, 'session:' + sessionId, 'session.meta', meta);
  }

  /**
   * B2's SessionMeta with this module's settingsPendingRestart overlaid.
   *
   * @param {string} sessionId - Phone id.
   * @returns {object|null}
   */
  function metaOf(sessionId) {
    const chat = p.chat();
    if (!chat || !chat.sessions || typeof chat.sessions.meta !== 'function') return null;
    let meta = null;
    try { meta = chat.sessions.meta(sessionId); } catch (_) { meta = null; }
    if (!meta) return null;
    const ref = chat.sessions.resolve(sessionId);
    if (ref) meta.settingsPendingRestart = pendingRestartOf(ref);
    return meta;
  }

  /**
   * launchOptionsFor (BUILD-CONTRACT 3.4.4): what B2 starts a session with.
   * Nulls mean unset.
   *
   * @param {string} sessionId - Phone id.
   * @returns {{model: (string|null), effort: (string|null), permissionMode: (string|null), bypassPermissions: (boolean|null), codex: object}}
   */
  function launchOptionsFor(sessionId) {
    const empty = { model: null, effort: null, permissionMode: null, bypassPermissions: null, codex: { model: null, reasoningEffort: null, sandbox: null, approvalPolicy: null, bypassApprovalsAndSandbox: null } };
    const chat = p.chat();
    const ref = chat && chat.sessions ? chat.sessions.resolve(sessionId) : null;
    if (!ref) return empty;
    const v = valuesOf(ref);
    if (ref.provider === 'claude') { // gsd:provider-literal-allowed (mobile v2 session settings)
      return Object.assign(empty, { model: v.model, effort: v.effort, permissionMode: v.permissionMode, bypassPermissions: v.permissionMode ? v.permissionMode === 'bypassPermissions' : null });
    }
    empty.codex = { model: v.model, reasoningEffort: v.reasoningEffort, sandbox: v.sandbox, approvalPolicy: v.approvalPolicy, bypassApprovalsAndSandbox: v.bypassApprovalsAndSandbox };
    empty.model = v.model;
    return empty;
  }

  /**
   * A Workbook session's process started: settings waiting for it are
   * applied now (session.meta settingsPendingRestart false).
   *
   * @param {string} wbId - Workbook session id.
   */
  function onSpawn(wbId) {
    for (const [id, v] of pending) {
      if (v.wbId && v.wbId === wbId) {
        pending.delete(id);
        announce(id);
      }
    }
  }

  /**
   * Move stored values from a re-keyed wb_ id to its new id.
   *
   * @param {string} oldId - Previous id.
   * @param {string} newId - New id.
   */
  function rekey(oldId, newId) {
    if (discovered.has(oldId)) { if (!discovered.has(newId)) discovered.set(newId, discovered.get(oldId)); discovered.delete(oldId); save(); }
    if (pending.has(oldId)) { pending.set(newId, pending.get(oldId)); pending.delete(oldId); }
  }

  return {
    get,
    patch,
    launchOptionsFor,
    valuesOf: (sessionId) => valuesOf(resolveOr404(sessionId)),
    applyValues: (sessionId, values) => apply(resolveOr404(sessionId), values),
    pendingRestartFor: (sessionId) => {
      const chat = p.chat();
      const ref = chat && chat.sessions ? chat.sessions.resolve(sessionId) : null;
      return ref ? pendingRestartOf(ref) : false;
    },
    onSpawn,
    rekey,
    file,
  };
}

module.exports = { createSessionSettings, FILE_NAME, CODEX_KEYS };
