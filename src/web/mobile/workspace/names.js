/**
 * workspace/names.js: PATCH /sessions/:sessionId (name, pinned, archived),
 * PATCH /projects/:projectId and PATCH /folders/:folderId
 * (PROTOCOL.md 4.5.1, 4.5.2), and titleEventFor, the payload of the main
 * server's new session:title SSE event (BUILD-CONTRACT S9).
 *
 * WHY: A13 and critic F23 settle which of the three name stores a rename
 * writes: Workbook's session name for tracked sessions, Workbook's provider
 * title store for discovered ones, and never the provider's own title or
 * the transcript. Both screens hear about it: the phone through
 * session.meta and sessions.changed, the desktop through the existing
 * session:updated event (tracked) or session:title (title store), which the
 * store already emits as providerSessionTitles:updated but nobody forwarded
 * (R02:201).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const common = require('./common');

/** Longest session name (PROTOCOL.md 4.5.1). */
const SESSION_NAME_MAX = 200;
/** Longest project or folder name (PROTOCOL.md 4.5.2). */
const NODE_NAME_MAX = 100;
/** Request fields of SessionPatch. */
const SESSION_PATCH_FIELDS = Object.freeze(['name', 'pinned', 'archived']);

/**
 * The session:title payload for a store providerSessionTitles:updated event:
 * {provider, upstreamId, title}, title null after a delete. Never carries a
 * field named id, workspaceId or workspace (PROTOCOL.md 11.3), so the event
 * reaches every desktop page.
 *
 * @param {{providerId: string, upstreamSessionId: string, deleted: boolean}} d - Store event.
 * @param {object} [store] - Store (defaults to the Workbook store singleton).
 * @returns {{provider: string, upstreamId: string, title: (string|null)}}
 */
function titleEventFor(d, store) {
  const ev = d || {};
  let title = null;
  if (!ev.deleted) {
    try {
      const s = store || require('../../../state/store').getStore();
      title = s.getProviderSessionTitle(ev.providerId, ev.upstreamSessionId) || null;
    } catch (_) {
      title = null;
    }
  }
  return { provider: String(ev.providerId || ''), upstreamId: String(ev.upstreamSessionId || ''), title };
}

/**
 * Create the names service.
 *
 * @param {object} deps - {ctx, flags, tree}
 * @returns {{patchSession: Function, patchProject: Function, patchFolder: Function}}
 */
function createNames(deps) {
  const ctx = deps.ctx;
  const flags = deps.flags;
  const tree = deps.tree;
  const p = common.parts(ctx);
  const log = common.logger(ctx);

  /**
   * Validate a trimmed name.
   *
   * @param {*} raw - Candidate.
   * @param {number} min - Minimum length after trimming.
   * @param {number} max - Maximum length.
   * @returns {string}
   */
  function checkName(raw, min, max) {
    if (typeof raw !== 'string' || /[\r\n]/.test(raw)) common.fail('INVALID_FIELD', 'A name is one line of text.', { field: 'name' });
    const name = raw.trim();
    if (name.length < min || name.length > max) common.fail('INVALID_FIELD', 'A name has ' + min + ' to ' + max + ' characters.', { field: 'name' });
    return name;
  }

  /**
   * Write a session name to the right store (A13): the tracked session's
   * name, else the provider title store for (provider, upstreamId). Never
   * the transcript, never the provider's own title.
   *
   * @param {object} ref - SessionRef.
   * @param {string} name - Trimmed name (empty clears).
   */
  function writeName(ref, name) {
    const s = ctx.store;
    if (ref.tracked && ref.workbookSessionId) {
      s.updateSession(ref.workbookSessionId, { name });
      return;
    }
    if (!ref.upstreamId) common.fail('SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    s.setProviderSessionTitle(ref.provider, ref.upstreamId, name);
  }

  /**
   * PATCH /sessions/:sessionId (PROTOCOL.md 4.5.1).
   *
   * @param {string} sessionId - Phone id.
   * @param {object} body - SessionPatch.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {object} SessionMeta.
   */
  function patchSession(sessionId, body, who) {
    const chat = p.chat();
    const ref = chat && chat.sessions ? chat.sessions.resolve(sessionId) : null;
    if (!ref) common.fail('SESSION_NOT_FOUND', 'That session does not exist on this computer.');
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
    if (has('pinned') && typeof b.pinned !== 'boolean') common.fail('INVALID_FIELD', 'pinned is true or false.', { field: 'pinned' });
    if (has('archived') && typeof b.archived !== 'boolean') common.fail('INVALID_FIELD', 'archived is true or false.', { field: 'archived' });
    let name = null;
    if (has('name')) name = checkName(b.name, 0, SESSION_NAME_MAX);
    if (has('name')) {
      writeName(ref, name);
      common.audit(ctx, { deviceId: who && who.deviceId, action: 'rename', sessionId: ref.sessionId, detail: ref.tracked ? 'workbook' : 'titleStore', ok: true });
    }
    if (has('pinned') || has('archived')) {
      const patch = {};
      if (has('pinned')) patch.pinned = b.pinned;
      if (has('archived')) patch.archived = b.archived;
      flags.set(ref.sessionId, patch);
    }
    // Both screens hear it: the phone through the session topic and the
    // sessions topic (flags.set already did both for a flag change).
    try {
      if (chat.internals && chat.internals.index) chat.internals.index.invalidate();
      chat.sessions.noteChanged(ref.sessionId, 'updated');
    } catch (err) {
      log('rename announce failed: ' + (err && err.message));
    }
    const meta = chat.sessions.meta(ref.sessionId);
    if (meta) common.publish(ctx, 'session:' + ref.sessionId, 'session.meta', meta);
    return meta;
  }

  /**
   * PATCH /projects/:projectId (PROTOCOL.md 4.5.2).
   *
   * @param {string} projectId - Workspace id.
   * @param {object} body - NamePatch.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {object} ProjectNode.
   */
  function patchProject(projectId, body, who) {
    if (projectId === require('./tree').UNASSIGNED_ID) common.fail('NOT_RENAMABLE', 'This group of working directories cannot be renamed.');
    const s = ctx.store;
    if (!s.getWorkspace(projectId)) common.fail('PROJECT_NOT_FOUND', 'That project does not exist on this computer.');
    const name = checkName(body && body.name, 1, NODE_NAME_MAX);
    s.updateWorkspace(projectId, { name });
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'rename', sessionId: null, detail: 'project', ok: true });
    return tree.projectNode(projectId);
  }

  /**
   * PATCH /folders/:folderId (PROTOCOL.md 4.5.2).
   *
   * @param {string} folderId - Workspace group id.
   * @param {object} body - NamePatch.
   * @param {{deviceId: (string|null)}} who - Caller.
   * @returns {object} FolderNode.
   */
  function patchFolder(folderId, body, who) {
    const s = ctx.store;
    const groups = (s.state && s.state.workspaceGroups) || {};
    if (!groups[folderId]) common.fail('FOLDER_NOT_FOUND', 'That folder does not exist on this computer.');
    const name = checkName(body && body.name, 1, NODE_NAME_MAX);
    s.updateGroup(folderId, { name });
    common.audit(ctx, { deviceId: who && who.deviceId, action: 'rename', sessionId: null, detail: 'folder', ok: true });
    return tree.folderNode(folderId);
  }

  return { patchSession, patchProject, patchFolder };
}

module.exports = { createNames, titleEventFor, SESSION_NAME_MAX, NODE_NAME_MAX, SESSION_PATCH_FIELDS };
