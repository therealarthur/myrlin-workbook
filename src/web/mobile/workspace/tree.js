/**
 * workspace/tree.js: GET /tree and GET /tree/projects/:projectId
 * (PROTOCOL.md 4.6, decision A12).
 *
 * WHY: the phone mirrors the desktop exactly (folder, project, working
 * directory, session) and merges discovered sessions into their working
 * directory so nothing on the computer is missing, without ever calling the
 * heavy /api/discover walk (R02:345). Folders are Workbook workspace groups,
 * projects are workspaces, rootOrder follows workspaceOrder (which mixes
 * both kinds). Sessions come from B2's merged session index, which is built
 * from caches, so the route never starts a cold discovery walk.
 *
 * Placement rule (A12): a discovered session goes under the project whose
 * working directories (the distinct workingDir values of its tracked
 * sessions) contain its path, compared after normalization; when several
 * projects share the directory, the first in rootOrder (folders expanded in
 * their order) wins; a session no project claims goes to the synthetic
 * project "unassigned", always last and only when non empty.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const common = require('./common');

/** The synthetic project id and name (PROTOCOL.md 4.6). */
const UNASSIGNED_ID = 'unassigned';
const UNASSIGNED_NAME = 'Other working directories';
/** Working directories per page (PROTOCOL.md 14). */
const DIRS_DEFAULT = 20;
const DIRS_MAX = 100;
/** Sessions listed per working directory (PROTOCOL.md 4.6). */
const SESSIONS_PER_DIR = 100;
/** How long a branch read from .git/HEAD is reused. */
const BRANCH_TTL_MS = 30 * 1000;
/** How many parent folders are searched for a .git entry. */
const GIT_SEARCH_DEPTH = 8;
/** Cursor format version. */
const CURSOR_VERSION = 1;

/**
 * Create the tree service.
 *
 * @param {object} deps - {ctx, now}
 * @returns {{tree: Function, project: Function, projectNode: Function, folderNode: Function, placement: Function}}
 */
function createTree(deps) {
  const ctx = deps.ctx;
  const now = deps.now || Date.now;
  const p = common.parts(ctx);
  const branchCache = new Map();
  const store = () => ctx.store;
  const state = () => (store() && store().state) || {};

  /**
   * The ordered root entries: workspaceOrder, then any workspace or group
   * the order does not mention (newest first), projects inside a folder
   * removed from the root.
   *
   * @returns {Array<{kind: string, id: string}>}
   */
  function rootEntries() {
    const st = state();
    const groups = st.workspaceGroups || {};
    const workspaces = st.workspaces || {};
    const inFolder = new Set();
    for (const g of Object.values(groups)) for (const w of (g && g.workspaceIds) || []) inFolder.add(w);
    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(st.workspaceOrder) ? st.workspaceOrder : []) {
      if (seen.has(id)) continue;
      if (groups[id]) { out.push({ kind: 'folder', id }); seen.add(id); } else if (workspaces[id] && !inFolder.has(id)) { out.push({ kind: 'project', id }); seen.add(id); }
    }
    for (const g of Object.values(groups).sort((a, b) => (a.order || 0) - (b.order || 0))) {
      if (g && !seen.has(g.id)) { out.push({ kind: 'folder', id: g.id }); seen.add(g.id); }
    }
    const rest = Object.values(workspaces).filter((w) => w && !seen.has(w.id) && !inFolder.has(w.id));
    rest.sort((a, b) => (common.toMs(b.lastActive) || 0) - (common.toMs(a.lastActive) || 0));
    for (const w of rest) { out.push({ kind: 'project', id: w.id }); seen.add(w.id); }
    return out;
  }

  /**
   * Every project id in tree order: root projects, and folder projects in
   * their folder's order at the folder's place.
   *
   * @returns {string[]}
   */
  function projectOrder() {
    const st = state();
    const groups = st.workspaceGroups || {};
    const workspaces = st.workspaces || {};
    const out = [];
    for (const e of rootEntries()) {
      if (e.kind === 'project') out.push(e.id);
      else for (const w of (groups[e.id] && groups[e.id].workspaceIds) || []) if (workspaces[w] && !out.includes(w)) out.push(w);
    }
    return out;
  }

  /**
   * The folder id holding a project, or null.
   *
   * @param {string} projectId - Workspace id.
   * @returns {string|null}
   */
  function folderOf(projectId) {
    const groups = state().workspaceGroups || {};
    for (const g of Object.values(groups)) if (g && Array.isArray(g.workspaceIds) && g.workspaceIds.includes(projectId)) return g.id;
    return null;
  }

  /**
   * normalized working directory -> the first project (in tree order) with
   * a tracked session there.
   *
   * @returns {Map<string, string>}
   */
  function dirOwners() {
    const rank = new Map(projectOrder().map((id, i) => [id, i]));
    const owners = new Map();
    const s = store();
    const tracked = s && typeof s.getAllSessionsList === 'function' ? s.getAllSessionsList() : [];
    for (const t of tracked) {
      const key = common.normalizePath(t && t.workingDir);
      if (!key || !t.workspaceId || !rank.has(t.workspaceId)) continue;
      const prev = owners.get(key);
      if (prev === undefined || rank.get(t.workspaceId) < rank.get(prev)) owners.set(key, t.workspaceId);
    }
    return owners;
  }

  /**
   * Every listed session with its tree project (A12), archived excluded.
   *
   * @returns {Array<{summary: object, projectId: string, dirKey: (string|null)}>}
   */
  function placement() {
    const chat = p.chat();
    let list = [];
    try { list = chat && chat.sessions && typeof chat.sessions.list === 'function' ? chat.sessions.list() : []; } catch (_) { list = []; }
    const owners = dirOwners();
    const workspaces = state().workspaces || {};
    const out = [];
    for (const s of list) {
      if (!s || s.archived) continue;
      const dirKey = common.normalizePath(s.workingDir);
      let projectId;
      if (s.tracked && s.projectId && workspaces[s.projectId]) projectId = s.projectId;
      else projectId = (dirKey && owners.get(dirKey)) || UNASSIGNED_ID;
      out.push({ summary: s.projectId === projectId ? s : Object.assign({}, s, { projectId, folderId: projectId === UNASSIGNED_ID ? null : folderOf(projectId) }), projectId, dirKey });
    }
    return out;
  }

  /**
   * ProjectNode for a project id from a placement (PROTOCOL.md 4.6).
   *
   * @param {string} projectId - Workspace id or unassigned.
   * @param {Array} placed - placement() output.
   * @returns {object|null}
   */
  function projectNodeFrom(projectId, placed) {
    const workspaces = state().workspaces || {};
    const ws = workspaces[projectId];
    if (!ws && projectId !== UNASSIGNED_ID) return null;
    const mine = placed.filter((x) => x.projectId === projectId);
    const dirs = new Set(mine.map((x) => x.dirKey || ''));
    let last = null;
    for (const x of mine) if (x.summary.lastActiveAtMs && (!last || x.summary.lastActiveAtMs > last)) last = x.summary.lastActiveAtMs;
    if (last === null && ws) last = common.toMs(ws.lastActive);
    return {
      projectId,
      name: ws ? String(ws.name || 'Untitled project') : UNASSIGNED_NAME,
      color: ws && typeof ws.color === 'string' && ws.color ? ws.color : null,
      folderId: ws ? folderOf(projectId) : null,
      kind: ws ? 'project' : 'synthetic',
      sessionCount: mine.length,
      workingDirCount: dirs.size,
      needsYouCount: mine.filter((x) => x.summary.needsYou).length,
      lastActiveAtMs: last,
    };
  }

  /**
   * FolderNode for a workspace group (PROTOCOL.md 4.6).
   *
   * @param {string} folderId - Group id.
   * @returns {object|null}
   */
  function folderNode(folderId) {
    const st = state();
    const g = (st.workspaceGroups || {})[folderId];
    if (!g) return null;
    const workspaces = st.workspaces || {};
    return {
      folderId: g.id,
      name: String(g.name || 'Untitled folder'),
      color: typeof g.color === 'string' && g.color ? g.color : null,
      projectIds: (g.workspaceIds || []).filter((w) => workspaces[w]),
    };
  }

  /**
   * GET /tree (snapshot of topic sessions).
   *
   * @returns {object}
   */
  function tree() {
    const placed = placement();
    const root = rootEntries();
    const folders = root.filter((e) => e.kind === 'folder').map((e) => folderNode(e.id)).filter(Boolean);
    const projects = projectOrder().map((id) => projectNodeFrom(id, placed)).filter(Boolean);
    const rootOrder = root.slice();
    if (placed.some((x) => x.projectId === UNASSIGNED_ID)) {
      projects.push(projectNodeFrom(UNASSIGNED_ID, placed));
      rootOrder.push({ kind: 'project', id: UNASSIGNED_ID });
    }
    return Object.assign({ folders, projects, rootOrder }, common.snapshotSeq(ctx, 'sessions'));
  }

  /**
   * The ProjectNode of one project (404 when unknown).
   *
   * @param {string} projectId - Workspace id or unassigned.
   * @returns {object}
   */
  function projectNode(projectId) {
    const node = projectNodeFrom(projectId, placement());
    if (!node) common.fail('PROJECT_NOT_FOUND', 'That project does not exist on this computer.');
    return node;
  }

  /**
   * The current branch of a working directory from .git/HEAD (no git
   * spawn on the request path), cached 30 s.
   *
   * @param {string} dir - Working directory.
   * @returns {string|null}
   */
  function branchOf(dir) {
    if (!dir) return null;
    const hit = branchCache.get(dir);
    if (hit && now() - hit.at < BRANCH_TTL_MS) return hit.branch;
    let branch = null;
    try {
      let cur = path.resolve(dir);
      for (let i = 0; i < GIT_SEARCH_DEPTH && cur; i++) {
        const dotGit = path.join(cur, '.git');
        let st = null;
        try { st = fs.statSync(dotGit); } catch (_) { st = null; }
        if (st) {
          let gitDir = dotGit;
          if (st.isFile()) {
            const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
            gitDir = m ? path.resolve(cur, m[1].trim()) : null;
          }
          if (gitDir) {
            const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
            const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
            branch = m ? m[1] : null;
          }
          break;
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    } catch (_) {
      branch = null;
    }
    branchCache.set(dir, { at: now(), branch });
    return branch;
  }

  /**
   * A path with the home folder shown as "~" (PROTOCOL.md 4.6 displayPath).
   *
   * @param {string} dir - Absolute path.
   * @returns {string}
   */
  function displayPath(dir) {
    const home = os.homedir();
    if (!dir || !home) return dir || '';
    const a = common.normalizePath(dir);
    const h = common.normalizePath(home);
    if (a && h && (a === h || a.startsWith(h + '/'))) return '~' + dir.slice(home.length);
    return dir;
  }

  /**
   * Decode a working directory page cursor.
   *
   * @param {string|undefined} cursor - Opaque cursor.
   * @returns {number} Offset.
   */
  function decodeCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    try {
      const o = JSON.parse(Buffer.from(String(cursor).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (o && o.v === CURSOR_VERSION && Number.isInteger(o.o) && o.o >= 0) return o.o;
    } catch (_) { /* fall through */ }
    common.fail('CURSOR_EXPIRED', 'That page is no longer available. Start again from the top.');
    return 0;
  }

  /**
   * GET /tree/projects/:projectId.
   *
   * @param {string} projectId - Workspace id or unassigned.
   * @param {object} q - {limit, cursor}
   * @returns {object}
   */
  function project(projectId, q) {
    const placed = placement();
    const node = projectNodeFrom(projectId, placed);
    if (!node) common.fail('PROJECT_NOT_FOUND', 'That project does not exist on this computer.');
    let limit = DIRS_DEFAULT;
    if (q && q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > DIRS_MAX) common.fail('INVALID_FIELD', 'limit must be 1 to 100.', { field: 'limit' });
    }
    const offset = decodeCursor(q && q.cursor);
    const byDir = new Map();
    for (const x of placed) {
      if (x.projectId !== projectId) continue;
      const key = x.dirKey || '';
      if (!byDir.has(key)) byDir.set(key, { path: x.summary.workingDir || '', sessions: [] });
      byDir.get(key).sessions.push(x.summary);
    }
    const dirs = Array.from(byDir.values()).map((d) => {
      d.sessions.sort((a, b) => (b.lastActiveAtMs || 0) - (a.lastActiveAtMs || 0) || (a.sessionId < b.sessionId ? -1 : 1));
      return d;
    });
    dirs.sort((a, b) => (b.sessions[0].lastActiveAtMs || 0) - (a.sessions[0].lastActiveAtMs || 0) || (a.path < b.path ? -1 : 1));
    const page = dirs.slice(offset, offset + limit).map((d) => ({
      path: d.path,
      displayPath: displayPath(d.path),
      branch: branchOf(d.path),
      sessionCount: d.sessions.length,
      lastActiveAtMs: d.sessions[0].lastActiveAtMs || null,
      sessions: d.sessions.slice(0, SESSIONS_PER_DIR),
      moreSessions: Math.max(0, d.sessions.length - SESSIONS_PER_DIR),
    }));
    const next = offset + limit < dirs.length ? common.b64url(Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: offset + limit }))) : null;
    return { project: node, workingDirs: page, nextCursor: next };
  }

  return { tree, project, projectNode, folderNode, placement, rootEntries, projectOrder, UNASSIGNED_ID };
}

module.exports = { createTree, UNASSIGNED_ID, UNASSIGNED_NAME };
