/**
 * workspace/tabs.js: GET and PATCH /tabs, the TabsState view of the
 * desktop layout, the tab operations, and the helpers B2 calls
 * (tabGroupIdsFor, addSessionToGroup) (PROTOCOL.md 3.9, 4.8; BUILD-CONTRACT
 * 3.4.4).
 *
 * WHY: A11. The phone edits the desktop's own tab groups with intent
 * operations ("move this session to that group"), not whole blobs, so an
 * edit made against an older revision still applies when its targets exist
 * (rebased), and the same operations re-apply on top of a stale desktop
 * save (layout-store.js). A tracked session becomes a terminal pane; a
 * discovered session with no store session becomes a read only mirror pane
 * (P9), so a phone edit never starts a process on the desktop by itself.
 *
 * Mapping between desktop panes and phone ids: terminal panes by their
 * Workbook session id through B2's session index, mirror panes by their
 * viewData {provider, providerSessionId}. Panes the phone cannot map (plain
 * shells, unknown providers, a duplicate of a listed session) stay in the
 * group, count in hiddenPanes and keep taking capacity.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const common = require('./common');
const layoutStoreMod = require('./layout-store');

/** Panes per tab group (the desktop's MAX_PANES, app.js:165). */
const CAPACITY = 6;
/** Operations per PATCH (PROTOCOL.md 4.8). */
const OPS_MAX = 50;
/** Longest group or folder name (tabs-patch.json). */
const NAME_MAX = 60;
/** The desktop's default group (app.js loadTerminalLayout). */
const DEFAULT_GROUP = Object.freeze({ id: 'tg_default', name: 'Main', panes: [] });
/** Random bytes behind a new tg_ or tf_ id (8 base64url characters). */
const NEW_ID_BYTES = 6;
/** Characters of a new id after its prefix. */
const NEW_ID_CHARS = 8;
/** Every operation name (PROTOCOL.md 4.8). */
const OP_NAMES = Object.freeze(['createGroup', 'renameGroup', 'deleteGroup', 'moveGroup', 'moveSession', 'removeSession', 'reorderSessions', 'createFolder', 'renameFolder', 'deleteFolder']);

/**
 * An operation failure carrying the protocol code it should answer with.
 */
class OpError extends Error {
  /**
   * @param {string} code - TABS_OP_INVALID, TAB_GROUP_FULL, LAST_TAB_GROUP or INVALID_FIELD.
   * @param {string} message - Sentence.
   * @param {object} [extra] - Extra fields (groupId, field).
   */
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || {};
  }
}

/**
 * Create the tabs service.
 *
 * @param {object} deps - {ctx, now, layoutStore}
 * @returns {object}
 */
function createTabs(deps) {
  const ctx = deps.ctx;
  const p = common.parts(ctx);
  const log = common.logger(ctx);
  const store = deps.layoutStore || layoutStoreMod.forDataDir(ctx.dataDir);
  let cache = { revision: -1, mtimeMs: -1, groupsBySession: new Map() };

  // ── Mapping ─────────────────────────────────────────────────────────────

  /**
   * The phone id of a Workbook session, or null for shells and unknowns.
   *
   * @param {string} wbId - Workbook session id.
   * @returns {string|null}
   */
  function phoneIdOfWorkbook(wbId) {
    if (!wbId) return null;
    const idx = p.index();
    if (idx && typeof idx.idForWorkbookSession === 'function') {
      const id = idx.idForWorkbookSession(wbId);
      if (id) return id;
    }
    const s = ctx.store;
    const rec = s && typeof s.getSession === 'function' ? s.getSession(wbId) : null;
    if (!rec) return null;
    let provider = null;
    try { provider = require('../chat/session-index').agentProviderOf(rec); } catch (_) { provider = null; }
    if (!provider) return null;
    if (rec.resumeSessionId) return (provider === 'codex' ? 'cx_' : 'cl_') + rec.resumeSessionId; // gsd:provider-literal-allowed (mobile v2 tabs)
    return 'wb_' + wbId;
  }

  /**
   * The phone id a pane shows, or null when the phone cannot list it.
   *
   * @param {object} pane - Layout pane.
   * @returns {string|null}
   */
  function paneSessionId(pane) {
    if (!pane || typeof pane !== 'object') return null;
    if (pane.sessionId) return phoneIdOfWorkbook(pane.sessionId);
    if (pane.viewType === 'mirror' && pane.viewData && typeof pane.viewData === 'object') {
      const prov = pane.viewData.provider;
      const up = pane.viewData.providerSessionId;
      if (!common.AGENT_PROVIDERS.includes(prov) || typeof up !== 'string' || !up) return null;
      const id = (prov === 'codex' ? 'cx_' : 'cl_') + up; // gsd:provider-literal-allowed (mobile v2 tabs)
      const chat = p.chat();
      const ref = chat && chat.sessions ? chat.sessions.resolve(id) : null;
      return ref ? ref.sessionId : (common.isSessionId(id) ? id : null);
    }
    return null;
  }

  /**
   * Does a pane show this phone session? Compares canonical ids, so a
   * re-keyed wb_ id and its cl_ or cx_ id match.
   *
   * @param {object} pane - Layout pane.
   * @param {string} sessionId - Canonical phone id.
   * @returns {boolean}
   */
  function paneShows(pane, sessionId) {
    return paneSessionId(pane) === sessionId;
  }

  /**
   * The groups of a layout, with the desktop's default when there are none.
   *
   * @param {object} layout - Layout blob.
   * @returns {object[]}
   */
  function groupsOf(layout) {
    return Array.isArray(layout.tabGroups) && layout.tabGroups.length ? layout.tabGroups : [JSON.parse(JSON.stringify(DEFAULT_GROUP))];
  }

  /**
   * The TabsState of a layout (PROTOCOL.md 3.9).
   *
   * @param {object} layout - Layout blob.
   * @param {number} revision - Its revision.
   * @returns {object}
   */
  function tabsState(layout, revision) {
    const groups = groupsOf(layout).map((g) => {
      const panes = (Array.isArray(g.panes) ? g.panes : []).slice().sort((a, b) => (a.slot || 0) - (b.slot || 0));
      const ids = [];
      let hidden = 0;
      for (const pane of panes) {
        const id = paneSessionId(pane);
        if (id && !ids.includes(id)) ids.push(id); else hidden += 1;
      }
      return { id: String(g.id), name: String(g.name || 'Untitled'), folderId: g.folderId || null, sessionIds: ids.slice(0, CAPACITY), capacity: CAPACITY, hiddenPanes: hidden };
    });
    const folders = (Array.isArray(layout.tabFolders) ? layout.tabFolders : []).filter((f) => f && f.id).map((f) => ({
      id: String(f.id), name: String(f.name || 'Untitled'), color: typeof f.color === 'string' && f.color ? f.color : null, collapsed: !!f.collapsed,
    }));
    const active = layout.activeGroupId && groups.some((g) => g.id === layout.activeGroupId) ? layout.activeGroupId : (groups[0] ? groups[0].id : null);
    return { revision, groups, folders, desktopActiveGroupId: active };
  }

  /** @returns {object} the current TabsState */
  function current() {
    const cur = store.read();
    return tabsState(cur.layout, cur.revision);
  }

  /**
   * The desktop tab groups holding a session (B2's SessionSummary.tabGroupIds).
   * Cached by revision and file time, because B2 asks for every summary.
   *
   * @param {string} sessionId - Phone id.
   * @returns {string[]}
   */
  function tabGroupIdsFor(sessionId) {
    let mtimeMs = 0;
    try { mtimeMs = require('fs').statSync(store.layoutFile).mtimeMs; } catch (_) { mtimeMs = 0; }
    if (cache.mtimeMs !== mtimeMs) {
      const t = current();
      const map = new Map();
      for (const g of t.groups) for (const id of g.sessionIds) { if (!map.has(id)) map.set(id, []); map.get(id).push(g.id); }
      cache = { revision: t.revision, mtimeMs, groupsBySession: map };
    }
    return (cache.groupsBySession.get(sessionId) || []).slice();
  }

  // ── Operations ──────────────────────────────────────────────────────────

  /**
   * The lowest free slot of a group (0 to 5), or -1 when full.
   *
   * @param {object} g - Group.
   * @returns {number}
   */
  function freeSlot(g) {
    const used = new Set((g.panes || []).map((x) => x.slot));
    for (let i = 0; i < CAPACITY; i++) if (!used.has(i)) return i;
    return -1;
  }

  /**
   * A new pane for a phone session: a terminal pane for a tracked session,
   * a mirror pane for a discovered one (P9).
   *
   * @param {string} sessionId - Canonical phone id.
   * @param {number} slot - Slot.
   * @returns {object}
   */
  function newPane(sessionId, slot) {
    const chat = p.chat();
    const ref = chat && chat.sessions ? chat.sessions.resolve(sessionId) : null;
    if (!ref) throw new OpError('TABS_OP_INVALID', 'That session does not exist on this computer.');
    if (ref.workbookSessionId) {
      return { slot, sessionId: ref.workbookSessionId, sessionName: ref.title || 'Terminal', provider: ref.provider, spawnOpts: {}, viewType: null, viewData: {} };
    }
    return { slot, sessionId: null, sessionName: ref.title || ref.upstreamId, provider: ref.provider, spawnOpts: {}, viewType: 'mirror', viewData: { provider: ref.provider, providerSessionId: ref.upstreamId, title: ref.title || ref.upstreamId } };
  }

  /**
   * Resolve a phone id to its canonical id (following re-keys).
   *
   * @param {string} sessionId - Phone id.
   * @returns {string}
   */
  function canonical(sessionId) {
    const chat = p.chat();
    const ref = chat && chat.sessions ? chat.sessions.resolve(sessionId) : null;
    if (!ref) throw new OpError('TABS_OP_INVALID', 'That session does not exist on this computer.');
    return ref.sessionId;
  }

  /**
   * Put the listed panes of a group in a given order: the listed sessions
   * take the slots the listed panes held, in the new order; hidden panes
   * keep their slots (PROTOCOL.md 4.8 reorderSessions).
   *
   * @param {object} g - Group.
   * @param {string[]} order - Canonical phone ids, exactly the listed ones.
   */
  function reorderGroup(g, order) {
    const panes = (g.panes || []).slice();
    const listed = [];
    const seen = new Set();
    for (const pane of panes.slice().sort((a, b) => a.slot - b.slot)) {
      const id = paneSessionId(pane);
      if (id && !seen.has(id)) { listed.push({ id, pane }); seen.add(id); }
    }
    const slots = listed.map((x) => x.pane.slot).sort((a, b) => a - b);
    const byId = new Map(listed.map((x) => [x.id, x.pane]));
    order.forEach((id, i) => { const pane = byId.get(id); if (pane) pane.slot = slots[i]; });
    g.panes = panes.sort((a, b) => a.slot - b.slot);
  }

  /**
   * Apply one operation to a layout in place.
   *
   * @param {object} layout - Layout blob (mutated).
   * @param {object} op - The operation, ids already resolved from tempIds.
   * @param {{tempIds: Map, replay: boolean}} st - Request state.
   * @returns {object} The operation as logged (real ids).
   */
  function applyOp(layout, op, st) {
    if (!op || typeof op !== 'object' || !OP_NAMES.includes(op.op)) throw new OpError('TABS_OP_INVALID', 'That is not a tab operation.');
    if (!Array.isArray(layout.tabGroups) || !layout.tabGroups.length) layout.tabGroups = groupsOf(layout);
    if (!Array.isArray(layout.tabFolders)) layout.tabFolders = [];
    const groups = layout.tabGroups;
    const folders = layout.tabFolders;
    const real = (id) => (id !== null && id !== undefined && st.tempIds.has(id) ? st.tempIds.get(id) : id);
    const group = (id) => {
      const g = groups.find((x) => x.id === real(id));
      if (!g) throw new OpError('TABS_OP_INVALID', 'That tab group no longer exists.');
      return g;
    };
    const folderRef = (id) => {
      if (id === null || id === undefined) return null;
      const f = folders.find((x) => x.id === real(id));
      if (!f) throw new OpError('TABS_OP_INVALID', 'That tab folder no longer exists.');
      return f.id;
    };
    const name = (v) => {
      const t = common.oneLine(v);
      if (!t || t.length > NAME_MAX) throw new OpError('INVALID_FIELD', 'A name has 1 to 60 characters on one line.', { field: 'name' });
      return t;
    };
    switch (op.op) {
      case 'createGroup': {
        const nm = name(op.name);
        const folderId = folderRef(op.folderId);
        let id = st.replay && typeof op.realId === 'string' ? op.realId : common.randomId('tg_', NEW_ID_BYTES, NEW_ID_CHARS);
        if (st.replay && groups.some((g) => g.id === id)) return op;
        while (groups.some((g) => g.id === id)) id = common.randomId('tg_', NEW_ID_BYTES, NEW_ID_CHARS);
        const g = { id, name: nm, panes: [] };
        if (folderId) g.folderId = folderId;
        const after = op.afterGroupId === null || op.afterGroupId === undefined ? -1 : groups.findIndex((x) => x.id === real(op.afterGroupId));
        if (op.afterGroupId !== null && op.afterGroupId !== undefined && after === -1) throw new OpError('TABS_OP_INVALID', 'That tab group no longer exists.');
        if (after === -1) groups.push(g); else groups.splice(after + 1, 0, g);
        if (typeof op.tempId === 'string') st.tempIds.set(op.tempId, id);
        return { op: 'createGroup', realId: id, name: nm, folderId, afterGroupId: op.afterGroupId === null || op.afterGroupId === undefined ? null : real(op.afterGroupId) };
      }
      case 'renameGroup': {
        const g = group(op.groupId);
        g.name = name(op.name);
        return { op: 'renameGroup', groupId: g.id, name: g.name };
      }
      case 'deleteGroup': {
        const g = group(op.groupId);
        if (groups.length <= 1) throw new OpError('LAST_TAB_GROUP', 'The last tab group cannot be removed.');
        layout.tabGroups = groups.filter((x) => x !== g);
        if (layout.activeGroupId === g.id) layout.activeGroupId = layout.tabGroups[0].id;
        return { op: 'deleteGroup', groupId: g.id };
      }
      case 'moveGroup': {
        const g = group(op.groupId);
        const folderId = folderRef(op.folderId);
        const rest = groups.filter((x) => x !== g);
        let at = 0;
        if (op.afterGroupId !== null && op.afterGroupId !== undefined) {
          const i = rest.findIndex((x) => x.id === real(op.afterGroupId));
          if (i === -1) throw new OpError('TABS_OP_INVALID', 'That tab group no longer exists.');
          at = i + 1;
        }
        rest.splice(at, 0, g);
        if (folderId) g.folderId = folderId; else delete g.folderId;
        layout.tabGroups = rest;
        return { op: 'moveGroup', groupId: g.id, afterGroupId: op.afterGroupId === null || op.afterGroupId === undefined ? null : real(op.afterGroupId), folderId };
      }
      case 'moveSession': {
        const sid = canonical(op.sessionId);
        const target = group(op.toGroupId);
        for (const g of groups) if (g !== target) g.panes = (g.panes || []).filter((pane) => !paneShows(pane, sid));
        target.panes = Array.isArray(target.panes) ? target.panes : [];
        const had = target.panes.some((pane) => paneShows(pane, sid));
        if (!had) {
          const slot = freeSlot(target);
          if (slot === -1) throw new OpError('TAB_GROUP_FULL', 'That tab group is full.', { groupId: target.id });
          target.panes.push(newPane(sid, slot));
        }
        const listed = [];
        for (const pane of target.panes.slice().sort((a, b) => a.slot - b.slot)) {
          const id = paneSessionId(pane);
          if (id && !listed.includes(id)) listed.push(id);
        }
        const order = listed.filter((id) => id !== sid);
        const index = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, order.length)) : order.length;
        order.splice(index, 0, sid);
        reorderGroup(target, order);
        return { op: 'moveSession', sessionId: sid, toGroupId: target.id, index: Number.isInteger(op.index) ? op.index : null };
      }
      case 'removeSession': {
        const sid = canonical(op.sessionId);
        const g = group(op.groupId);
        const before = (g.panes || []).length;
        g.panes = (g.panes || []).filter((pane) => !paneShows(pane, sid));
        if (g.panes.length === before && !st.replay) throw new OpError('TABS_OP_INVALID', 'That session is not in this tab group.');
        return { op: 'removeSession', sessionId: sid, groupId: g.id };
      }
      case 'reorderSessions': {
        const g = group(op.groupId);
        if (!Array.isArray(op.sessionIds)) throw new OpError('INVALID_FIELD', 'sessionIds is a list.', { field: 'sessionIds' });
        const order = op.sessionIds.map(canonical);
        const listed = [];
        for (const pane of (g.panes || []).slice().sort((a, b) => a.slot - b.slot)) {
          const id = paneSessionId(pane);
          if (id && !listed.includes(id)) listed.push(id);
        }
        const same = order.length === listed.length && order.every((id) => listed.includes(id)) && new Set(order).size === order.length;
        if (!same) throw new OpError('TABS_OP_INVALID', 'The order must list exactly the sessions of the tab group.');
        reorderGroup(g, order);
        return { op: 'reorderSessions', groupId: g.id, sessionIds: order };
      }
      case 'createFolder': {
        const nm = name(op.name);
        let id = st.replay && typeof op.realId === 'string' ? op.realId : common.randomId('tf_', NEW_ID_BYTES, NEW_ID_CHARS);
        if (st.replay && folders.some((f) => f.id === id)) return op;
        while (folders.some((f) => f.id === id)) id = common.randomId('tf_', NEW_ID_BYTES, NEW_ID_CHARS);
        const color = typeof op.color === 'string' && op.color ? op.color : null;
        const f = { id, name: nm, collapsed: false };
        if (color) f.color = color;
        folders.push(f);
        if (typeof op.tempId === 'string') st.tempIds.set(op.tempId, id);
        return { op: 'createFolder', realId: id, name: nm, color };
      }
      case 'renameFolder': {
        const fid = folderRef(op.folderId);
        const f = folders.find((x) => x.id === fid);
        f.name = name(op.name);
        return { op: 'renameFolder', folderId: fid, name: f.name };
      }
      case 'deleteFolder': {
        const fid = folderRef(op.folderId);
        layout.tabFolders = folders.filter((x) => x.id !== fid);
        for (const g of groups) if (g.folderId === fid) delete g.folderId;
        return { op: 'deleteFolder', folderId: fid };
      }
      default:
        throw new OpError('TABS_OP_INVALID', 'That is not a tab operation.');
    }
  }

  /**
   * Re-apply one logged operation on a desktop blob (layout-store rebase).
   *
   * @param {object} layout - Layout blob.
   * @param {object} loggedOp - An operation as applyOp logged it.
   * @returns {object} The layout.
   */
  function replay(layout, loggedOp) {
    applyOp(layout, loggedOp, { tempIds: new Map(), replay: true });
    return layout;
  }
  store.setReplayer(replay);

  /**
   * PATCH /tabs (PROTOCOL.md 4.8): 1 to 50 operations, all or nothing.
   *
   * @param {object} body - TabsPatch.
   * @param {object} o - {ifMatch: (string|undefined), deviceId}
   * @returns {object} TabsPatchResult.
   */
  function patch(body, o) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!Array.isArray(b.ops) || b.ops.length < 1 || b.ops.length > OPS_MAX) common.fail('INVALID_FIELD', 'Send 1 to 50 operations.', { field: 'ops' });
    if (!Number.isInteger(b.baseRevision) || b.baseRevision < 0) common.fail('INVALID_FIELD', 'baseRevision is the revision this iPhone last saw.', { field: 'baseRevision' });
    const cur = store.read();
    if (o && o.ifMatch !== undefined && o.ifMatch !== null && o.ifMatch !== '') {
      const want = Number(String(o.ifMatch).replace(/^W\//, '').replace(/"/g, '').trim());
      if (!Number.isInteger(want) || want !== cur.revision) {
        common.fail('REVISION_MISMATCH', 'The tabs changed on the computer. Reload them and try again.', { current: tabsState(cur.layout, cur.revision) });
      }
    }
    const layout = JSON.parse(JSON.stringify(cur.layout));
    if (!Array.isArray(layout.tabGroups) || !layout.tabGroups.length) layout.tabGroups = groupsOf(layout);
    const st = { tempIds: new Map(), replay: false };
    const logged = [];
    for (let i = 0; i < b.ops.length; i++) {
      try {
        logged.push(applyOp(layout, b.ops[i], st));
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        const current = tabsState(cur.layout, cur.revision);
        if (err.code === 'TAB_GROUP_FULL') common.fail('TAB_GROUP_FULL', err.message, { groupId: err.extra.groupId });
        if (err.code === 'LAST_TAB_GROUP') common.fail('LAST_TAB_GROUP', err.message);
        if (err.code === 'INVALID_FIELD') common.fail('INVALID_FIELD', err.message, { field: err.extra.field || 'ops' });
        common.fail('TABS_OP_INVALID', err.message, { opIndex: i, current });
      }
    }
    const committed = store.commitPhone(layout, { deviceId: o && o.deviceId, ops: logged, expectRevision: cur.revision });
    const tempIds = {};
    for (const [k, v] of st.tempIds) tempIds[k] = v;
    common.audit(ctx, { deviceId: o && o.deviceId, action: 'tabsPatch', sessionId: null, detail: b.ops.length + ' ops', ok: true });
    return { tabs: tabsState(committed.layout, committed.revision), tempIds, rebased: b.baseRevision !== cur.revision };
  }

  /**
   * GET /tabs (snapshot of topic tabs).
   *
   * @returns {object} TabsResponse.
   */
  function get() {
    return Object.assign({ tabs: current() }, common.snapshotSeq(ctx, 'tabs'));
  }

  /**
   * addSessionToGroup (BUILD-CONTRACT 3.4.4): place a new session in a
   * desktop tab group, right after afterSessionId when that session is
   * listed there (PROTOCOL.md 4.5.6). Throws MobileError TAB_GROUP_FULL.
   *
   * @param {string} groupId - Tab group id.
   * @param {string} sessionId - Phone id of the new session.
   * @param {string|null} afterSessionId - Place right after this session.
   * @param {{deviceId: (string|null)}} [who] - Who asked (for the log).
   * @returns {object} TabsState.
   */
  function addSessionToGroup(groupId, sessionId, afterSessionId, who) {
    const cur = store.read();
    const t = tabsState(cur.layout, cur.revision);
    const g = t.groups.find((x) => x.id === groupId);
    if (!g) common.fail('INVALID_FIELD', 'That tab group does not exist.', { field: 'tabGroupId' });
    let index = null;
    if (afterSessionId) {
      let after = afterSessionId;
      try { after = canonical(afterSessionId); } catch (_) { after = afterSessionId; }
      const i = g.sessionIds.indexOf(after);
      if (i !== -1) index = i + 1;
    }
    const layout = JSON.parse(JSON.stringify(cur.layout));
    if (!Array.isArray(layout.tabGroups) || !layout.tabGroups.length) layout.tabGroups = groupsOf(layout);
    let logged;
    try {
      logged = applyOp(layout, { op: 'moveSession', sessionId, toGroupId: groupId, index }, { tempIds: new Map(), replay: false });
    } catch (err) {
      if (err instanceof OpError && err.code === 'TAB_GROUP_FULL') common.fail('TAB_GROUP_FULL', 'That tab group is full.', { groupId });
      if (err instanceof OpError) common.fail('INVALID_FIELD', err.message, { field: 'tabGroupId' });
      throw err;
    }
    const committed = store.commitPhone(layout, { deviceId: who && who.deviceId, ops: [logged], expectRevision: cur.revision });
    return tabsState(committed.layout, committed.revision);
  }

  /**
   * Whether a group has a free slot (migration default placement).
   *
   * @param {string} groupId - Tab group id.
   * @returns {boolean}
   */
  function hasRoom(groupId) {
    const cur = store.read();
    const g = groupsOf(cur.layout).find((x) => x.id === groupId);
    return !!g && freeSlot(g) !== -1;
  }

  /**
   * Publish tabs.updated for every stored change (PROTOCOL.md 5.4), once.
   *
   * @param {{revision: number, changedBy: object, layout: object}} change - From the layout store.
   */
  function onStoreChange(change) {
    cache.mtimeMs = -1;
    const tabs = tabsState(change.layout, change.revision);
    common.publish(ctx, 'tabs', 'tabs.updated', { tabs, changedBy: change.changedBy });
    // Sessions whose tab groups changed are "updated" in sessions.changed
    // (PROTOCOL.md 5.4: updated fires for tab groups), only those.
    const next = membershipOf(tabs);
    const changed = new Set();
    for (const [id, groups] of next) if (lastMembership.get(id) !== groups) changed.add(id);
    for (const id of lastMembership.keys()) if (!next.has(id)) changed.add(id);
    lastMembership = next;
    const chat = p.chat();
    if (changed.size && chat && chat.sessions && typeof chat.sessions.noteChanged === 'function') {
      try {
        for (const id of changed) chat.sessions.noteChanged(id, 'updated');
      } catch (err) { log('tab membership announce failed: ' + (err && err.message)); }
    }
  }

  /**
   * session id -> its group ids joined, for change detection.
   *
   * @param {object} tabs - TabsState.
   * @returns {Map<string, string>}
   */
  function membershipOf(tabs) {
    const m = new Map();
    for (const g of tabs.groups) for (const id of g.sessionIds) m.set(id, (m.has(id) ? m.get(id) + ',' : '') + g.id);
    return m;
  }
  let lastMembership = new Map();
  try { lastMembership = membershipOf(current()); } catch (_) { lastMembership = new Map(); }
  const unsubscribe = store.onChange(onStoreChange);

  return {
    get,
    patch,
    current,
    tabsState,
    tabGroupIdsFor,
    addSessionToGroup,
    hasRoom,
    replay,
    applyOp,
    stop() { unsubscribe(); store.setReplayer(null); },
    CAPACITY,
  };
}

module.exports = { createTabs, OpError, CAPACITY, DEFAULT_GROUP };
