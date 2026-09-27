/**
 * The phone's session index (PROTOCOL.md 3.4, 9.1).
 *
 * What: one entry per conversation, merged from Workbook's tracked store
 * sessions and the discovered transcripts of both providers. Phone ids are
 * upstream first (cl_<transcript uuid>, cx_<thread id>) with wb_<Workbook id>
 * only until an upstream id is known. It resolves titles (3.4.2), owners
 * (9.1), transcript paths, SessionSummary and SessionMeta, batches
 * sessions.changed events (500 ms) and re-keys wb_ ids (idChanged).
 *
 * Why: the phone never sees two entries for one conversation, and every
 * route and topic resolves ids here, which is also the shell isolation rule:
 * a tracked session whose provider is not claude or codex (a plain shell)
 * resolves to nothing, so no phone route can reach its PTY (3.4.1).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson, readJson, mobileDir, warn } = require('./common');
const { normalizeCwd } = require('../../../providers/claude/live-sessions');
const { isLiveBackground } = require('./agents-poller');

const PROVIDERS = new Set(['claude', 'codex']); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
const CHANGE_BATCH_MS = 500;
const ACTIVE_UPDATE_MIN_MS = 10000;
const REBUILD_TTL_MS = 1000;
const TITLE_MAX = 60;
const PREVIEW_MAX = 140;
const HEAD_READ_BYTES = 64 * 1024;
const CODEX_WALK_TTL_MS = 5000;
const UNTITLED = 'Untitled session';

/**
 * The agent provider of a tracked store session, or null for shells and anything else.
 * @param {object} s - store session
 * @returns {'claude'|'codex'|null} gsd:provider-literal-allowed
 */
function agentProviderOf(s) {
  if (!s) return null;
  const cmd = String(s.command || '').trim();
  const firstTok = cmd ? path.basename(cmd.split(/\s+/)[0]).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '') : '';
  const p = s.provider || (PROVIDERS.has(firstTok) ? firstTok : (cmd ? null : 'claude')); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
  if (!PROVIDERS.has(p)) return null;
  if (cmd && firstTok !== p) return null;
  return p;
}

/**
 * Prefix of a provider's phone id.
 * @param {string} provider
 * @returns {string}
 */
function prefixOf(provider) { return provider === 'codex' ? 'cx_' : 'cl_'; } // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)

/**
 * Parse a phone id.
 * @param {string} id
 * @returns {{kind: 'cl'|'cx'|'wb', raw: string}|null}
 */
function parseSessionId(id) {
  const m = /^(cl|cx|wb)_([A-Za-z0-9._:-]{1,120})$/.exec(String(id || ''));
  return m ? { kind: m[1], raw: m[2] } : null;
}

/**
 * First line cut to n characters.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function cutLine(s, n) {
  const t = String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * Milliseconds of a date-ish value.
 * @param {*} v
 * @returns {number|null}
 */
function ms(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Create the session index.
 * @param {object} o
 * @param {object} o.ctx - mobile context
 * @param {object} o.discovery - discovery cache
 * @param {object} [o.agents] - agents poller
 * @param {() => number} [o.now]
 * @returns {object}
 */
function createSessionIndex({ ctx, discovery, agents = null, now = Date.now }) {
  const listeners = new Set();
  const pendingChanges = new Map();
  const lastActivePublished = new Map();
  let batchTimer = null;
  let built = null;
  let builtAt = 0;
  let stateOf = () => null;
  const claudePathCache = new Map();
  const headCache = new Map();
  let codexWalk = { at: 0, map: new Map() };
  const codexMisses = new Map();
  const handoffsFile = path.join(mobileDir(ctx), 'handoffs.json');
  const handoffs = readJson(handoffsFile, {}) || {};
  const aliases = new Map();

  const store = () => (ctx && ctx.store) || null;
  const ptyManager = () => { try { return ctx && typeof ctx.getPtyManager === 'function' ? ctx.getPtyManager() : null; } catch (_) { return null; } };
  const workspace = () => (ctx && ctx.mobile && ctx.mobile.workspace) || null;

  /** @returns {string} */
  function claudeProjectsDir() {
    try { return require('../../../providers/claude/path-decode').resolveClaudeProjectsDir(); } catch (_) { return path.join(require('os').homedir(), '.claude', 'projects'); }
  }

  /** @returns {string} */
  function codexHome() {
    return process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
  }

  /**
   * Claude transcript of an upstream id: the working dir's folder first, then a scan.
   * @param {string} upstreamId
   * @param {string|null} workingDir
   * @returns {string|null}
   */
  function claudeTranscriptPath(upstreamId, workingDir) {
    const cached = claudePathCache.get(upstreamId);
    if (cached && fs.existsSync(cached)) return cached;
    const root = claudeProjectsDir();
    const tryPath = (p) => { try { return fs.statSync(p).isFile() ? p : null; } catch (_) { return null; } };
    let found = null;
    if (workingDir) {
      try {
        const enc = require('../../../providers/claude/path-decode').encodeClaudeProjectDir(workingDir);
        found = tryPath(path.join(root, enc, upstreamId + '.jsonl'));
      } catch (_) { found = null; }
    }
    if (!found) {
      try {
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const p = tryPath(path.join(root, d.name, upstreamId + '.jsonl'));
          if (p) { found = p; break; }
        }
      } catch (_) { found = null; }
    }
    if (found) claudePathCache.set(upstreamId, found);
    return found;
  }

  /**
   * Codex rollout of a thread id: the state db cache, discovery, then a cached walk.
   * @param {string} threadId
   * @returns {string|null}
   */
  function codexRolloutPath(threadId) {
    const id = String(threadId).toLowerCase();
    try {
      const p = require('../../../providers/codex/state-db').resolveRolloutPathSync(id);
      if (p) return p;
    } catch (_) { /* fall through */ }
    const d = (discovery ? discovery.entries('codex') : []).find((e) => String(e.providerSessionId).toLowerCase() === id); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    if (d && d.rolloutPath && fs.existsSync(d.rolloutPath)) return d.rolloutPath;
    const hit = codexWalk.map.get(id);
    if (hit && fs.existsSync(hit)) return hit;
    // A miss re-walks at once (new rollouts appear all the time), but one id
    // that keeps missing is only looked for again after the TTL.
    const missedAt = codexMisses.get(id) || 0;
    if (now() - missedAt > CODEX_WALK_TTL_MS) {
      const map = new Map();
      const walk = (dir, depth) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && depth < 4) walk(full, depth + 1);
          else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
            const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(e.name);
            if (m) map.set(m[1].toLowerCase(), full);
          }
        }
      };
      walk(path.join(codexHome(), 'sessions'), 0);
      codexWalk = { at: now(), map };
      if (!map.has(id)) codexMisses.set(id, now()); else codexMisses.delete(id);
      return map.get(id) || null;
    }
    return null;
  }

  /**
   * Cheap facts from the head of a transcript: first human prompt, provider
   * titles, Codex originator. Cached by path, size and mtime.
   * @param {string} file
   * @param {string} provider
   * @returns {{firstMessage: (string|null), title: (string|null), originator: (string|null), cwd: (string|null), model: (string|null)}}
   */
  function headFacts(file, provider) {
    let st;
    try { st = fs.statSync(file); } catch (_) { return { firstMessage: null, title: null, originator: null, cwd: null, model: null }; }
    const key = file + '|' + st.size + '|' + st.mtimeMs;
    const hit = headCache.get(file);
    if (hit && hit.key === key) return hit.facts;
    const facts = { firstMessage: null, title: null, originator: null, cwd: null, model: null };
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(HEAD_READ_BYTES, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      lines.pop();
      const { isHumanPrompt, contentText } = require('./claude-messages');
      for (const l of lines) {
        let r;
        try { r = JSON.parse(l); } catch (_) { continue; }
        if (provider === 'claude') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
          if (!facts.cwd && typeof r.cwd === 'string') facts.cwd = r.cwd;
          if (r.type === 'custom-title' && r.customTitle) facts.title = String(r.customTitle);
          if (r.type === 'ai-title' && r.aiTitle && !facts.title) facts.title = String(r.aiTitle);
          if (!facts.firstMessage && isHumanPrompt(r)) facts.firstMessage = cutLine(contentText(r.message.content), TITLE_MAX);
        } else {
          const p = r.payload || {};
          if (r.type === 'session_meta') { facts.originator = p.originator || null; facts.cwd = p.cwd || null; }
          if (r.type === 'turn_context' && p.model && !facts.model) facts.model = p.model;
          if (r.type === 'event_msg' && p.type === 'thread_name_updated' && p.thread_name) facts.title = String(p.thread_name);
          if (!facts.firstMessage && r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
            const { codexText, INJECTED_USER_RE } = require('./codex-messages');
            const t = codexText(p.content, 'input');
            if (t && !INJECTED_USER_RE.test(t)) facts.firstMessage = cutLine(t, TITLE_MAX);
          }
        }
      }
    } catch (_) { /* partial facts are fine */ }
    headCache.set(file, { key, facts });
    return facts;
  }

  /**
   * Build the merged entries (refs keyed by phone id).
   * @returns {Map<string, object>}
   */
  function build() {
    const refs = new Map();
    const s = store();
    const pm = ptyManager();
    const tracked = s && typeof s.getAllSessionsList === 'function' ? s.getAllSessionsList() : [];
    const byUpstream = new Map();
    const cwdProject = new Map();
    const order = (s && s.state && Array.isArray(s.state.workspaceOrder)) ? s.state.workspaceOrder : [];
    const rank = (wid) => { const i = order.indexOf(wid); return i === -1 ? 1e9 : i; };
    for (const t of tracked) {
      const provider = agentProviderOf(t);
      if (!provider) continue;
      const live = !!(pm && pm.getSession && pm.getSession(t.id) && pm.getSession(t.id).alive);
      const upstream = t.resumeSessionId || null;
      const sid = upstream ? prefixOf(provider) + upstream : 'wb_' + t.id;
      const cand = { t, provider, live, upstream, sid };
      const prev = byUpstream.get(sid);
      if (!prev || (live && !prev.live) || (live === prev.live && (ms(t.lastActive) || 0) > (ms(prev.t.lastActive) || 0))) byUpstream.set(sid, cand);
      const nc = t.workingDir ? normalizeCwd(t.workingDir) : null;
      if (nc && t.workspaceId) {
        const prevW = cwdProject.get(nc);
        if (!prevW || rank(t.workspaceId) < rank(prevW)) cwdProject.set(nc, t.workspaceId);
      }
    }
    for (const c of byUpstream.values()) {
      const t = c.t;
      refs.set(c.sid, {
        sessionId: c.sid,
        provider: c.provider,
        upstreamId: c.upstream,
        workbookSessionId: t.id,
        tracked: true,
        workingDir: t.workingDir || null,
        projectId: t.workspaceId || null,
        name: t.name || null,
        model: t.model || null,
        lastActiveAtMs: ms(t.lastActive),
        createdAtMs: ms(t.createdAt),
        live: c.live,
        discovered: null,
      });
    }
    for (const provider of ['claude', 'codex']) { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const entries = discovery ? discovery.entries(provider) : [];
      for (const e of entries) {
        if (!e || !e.providerSessionId) continue;
        const sid = prefixOf(provider) + e.providerSessionId;
        const ref = refs.get(sid);
        if (ref) { ref.discovered = e; continue; }
        const cwd = e.projectPath || null;
        const nc = cwd ? normalizeCwd(cwd) : null;
        refs.set(sid, {
          sessionId: sid,
          provider,
          upstreamId: e.providerSessionId,
          workbookSessionId: null,
          tracked: false,
          workingDir: cwd,
          projectId: nc && cwdProject.has(nc) ? cwdProject.get(nc) : 'unassigned',
          name: null,
          model: e.model || null,
          lastActiveAtMs: ms(e.lastActive),
          createdAtMs: null,
          live: false,
          discovered: e,
        });
      }
    }
    return refs;
  }

  /** @returns {Map<string, object>} */
  function refs() {
    if (!built || now() - builtAt > REBUILD_TTL_MS) {
      built = build();
      builtAt = now();
    }
    return built;
  }

  /** Force a rebuild on the next read. */
  function invalidate() { built = null; }

  /**
   * Transcript path of a ref (cached on the ref).
   * @param {object} ref
   * @returns {string|null}
   */
  function transcriptPathOf(ref) {
    if (!ref || !ref.upstreamId) return null;
    if (ref._path && fs.existsSync(ref._path)) return ref._path;
    ref._path = ref.provider === 'claude' ? claudeTranscriptPath(ref.upstreamId, ref.workingDir) : codexRolloutPath(ref.upstreamId); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    return ref._path;
  }

  /**
   * Owner of a ref (PROTOCOL.md 9.1).
   * @param {object} ref
   * @returns {string}
   */
  function ownerOf(ref) {
    if (handoffs[ref.sessionId]) return 'handedOff';
    if (ref.workbookSessionId) {
      const pm = ptyManager();
      const ps = pm && pm.getSession ? pm.getSession(ref.workbookSessionId) : null;
      if (ps && ps.alive) return 'workbook';
    }
    if (ref.provider === 'claude' && ref.upstreamId && agents) { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const e = agents.entryFor(ref.upstreamId);
      if (agents.refreshSoon) agents.refreshSoon();
      // A background session counts only while its process runs (a pid or a
      // status in the listing, rule 6 measured on 2.1.283): an idle running one
      // reads state done, and one without a process is asleep, so owner none.
      if (isLiveBackground(e)) return 'background';
      if (e && e.kind === 'interactive') return 'external';
    }
    if (ref.provider === 'codex') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const file = transcriptPathOf(ref);
      if (file && headFacts(file, 'codex').originator === 'Codex Desktop') return 'chatgpt'; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    }
    return 'none';
  }

  /**
   * Title and its source (PROTOCOL.md 3.4.2).
   * @param {object} ref
   * @returns {{title: string, titleSource: string}}
   */
  function titleOf(ref) {
    if (ref.tracked && ref.name) return { title: ref.name, titleSource: 'workbook' };
    const s = store();
    if (ref.upstreamId && s && typeof s.getProviderSessionTitle === 'function') {
      const t = s.getProviderSessionTitle(ref.provider, ref.upstreamId);
      if (t) return { title: String(t), titleSource: 'titleStore' };
    }
    const file = transcriptPathOf(ref);
    const facts = file ? headFacts(file, ref.provider) : null;
    if (facts && facts.title) return { title: facts.title, titleSource: 'provider' };
    if (ref.discovered && ref.discovered.title && ref.discovered.titleSource !== 'firstMessage') return { title: String(ref.discovered.title), titleSource: 'provider' };
    if (facts && facts.firstMessage) return { title: facts.firstMessage, titleSource: 'firstMessage' };
    return { title: UNTITLED, titleSource: 'none' };
  }

  /** @param {string} projectId @returns {string|null} */
  function folderOf(projectId) {
    const s = store();
    const groups = s && s.state && s.state.workspaceGroups ? Object.values(s.state.workspaceGroups) : [];
    const g = groups.find((x) => x && Array.isArray(x.workspaceIds) && x.workspaceIds.includes(projectId));
    return g ? g.id : null;
  }

  /**
   * Resolve a phone id to a SessionRef, following re-keys.
   * @param {string} sessionId
   * @returns {object|null}
   */
  function resolve(sessionId) {
    const parsed = parseSessionId(sessionId);
    if (!parsed) return null;
    const map = refs();
    let ref = map.get(sessionId);
    if (!ref && aliases.has(sessionId)) ref = map.get(aliases.get(sessionId));
    if (!ref && parsed.kind === 'wb') {
      // A wb_ id of a tracked agent session that now has an upstream id.
      for (const r of map.values()) if (r.workbookSessionId === parsed.raw) { ref = r; break; }
    }
    if (!ref && parsed.kind !== 'wb') {
      // A transcript that exists but is not in the discovery cache yet.
      const provider = parsed.kind === 'cl' ? 'claude' : 'codex'; // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const probe = { sessionId, provider, upstreamId: parsed.raw, workbookSessionId: null, tracked: false, workingDir: null, projectId: 'unassigned', name: null, model: null, lastActiveAtMs: null, createdAtMs: null, live: false, discovered: null };
      const file = transcriptPathOf(probe);
      if (!file) return null;
      const facts = headFacts(file, provider);
      probe.workingDir = facts.cwd || null;
      try { probe.lastActiveAtMs = fs.statSync(file).mtimeMs; } catch (_) {}
      map.set(sessionId, probe);
      ref = probe;
    }
    if (!ref) return null;
    const t = titleOf(ref);
    return {
      sessionId: ref.sessionId,
      provider: ref.provider,
      upstreamId: ref.upstreamId,
      workbookSessionId: ref.workbookSessionId,
      owner: ownerOf(ref),
      workingDir: ref.workingDir,
      projectId: ref.projectId,
      title: t.title,
      titleSource: t.titleSource,
      transcriptPath: transcriptPathOf(ref),
      tracked: ref.tracked,
      supersededBy: ref.sessionId !== sessionId ? ref.sessionId : null,
    };
  }

  /**
   * SessionSummary (PROTOCOL.md 3.4.3).
   * @param {string} sessionId
   * @returns {object|null}
   */
  function summary(sessionId) {
    const ref = resolve(sessionId);
    if (!ref) return null;
    const raw = refs().get(ref.sessionId) || {};
    const st = stateOf(ref.sessionId) || {};
    const ws = workspace();
    let flags = { pinned: false, archived: false };
    try { if (ws && ws.flags && ws.flags.get) flags = Object.assign(flags, ws.flags.get(ref.sessionId) || {}); } catch (_) {}
    let tabGroupIds = [];
    try { if (ws && ws.tabs && ws.tabs.tabGroupIdsFor) tabGroupIds = ws.tabs.tabGroupIdsFor(ref.sessionId) || []; } catch (_) {}
    let size = raw.discovered && Number.isFinite(raw.discovered.sizeBytes) ? raw.discovered.sizeBytes : null;
    let mtime = null;
    if (ref.transcriptPath) { try { const sst = fs.statSync(ref.transcriptPath); size = sst.size; mtime = sst.mtimeMs; } catch (_) {} }
    const lastActive = Math.max(raw.lastActiveAtMs || 0, mtime || 0) || now();
    const stateName = st.state || 'idle';
    const preview = raw.discovered && raw.discovered.preview ? cutLine(raw.discovered.preview, PREVIEW_MAX) : null;
    return {
      sessionId: ref.sessionId,
      provider: ref.provider,
      title: ref.title,
      titleSource: ref.titleSource,
      projectId: ref.projectId,
      folderId: ref.projectId ? folderOf(ref.projectId) : null,
      workingDir: ref.workingDir,
      branch: null,
      owner: ref.owner,
      state: stateName,
      stateEnteredAtMs: st.enteredAtMs || lastActive,
      needsYou: stateName === 'needsAnswer' || stateName === 'needsApproval',
      lastActiveAtMs: Math.round(lastActive),
      createdAtMs: raw.createdAtMs ? Math.round(raw.createdAtMs) : null,
      model: raw.model || null,
      tracked: !!ref.tracked,
      workbookSessionId: ref.workbookSessionId,
      upstreamId: ref.upstreamId,
      pinned: !!flags.pinned,
      archived: !!(flags.archived || (raw.discovered && raw.discovered.archived === true)),
      tabGroupIds,
      lineage: null,
      preview,
      sizeBytes: size,
    };
  }

  /**
   * SessionMeta (PROTOCOL.md 3.4.4). Settings values come from B3 when present.
   * @param {string} sessionId
   * @param {object} [extra] - {formatDrift, model, effort, permissionMode, sandbox, approvalPolicy, settingsPendingRestart}
   * @returns {object|null}
   */
  function meta(sessionId, extra = {}) {
    const sum = summary(sessionId);
    if (!sum) return null;
    const ref = resolve(sessionId);
    const owner = sum.owner;
    const reasons = {
      external: 'Open in a terminal on ' + computerName() + '. You can read it live here.',
      chatgpt: 'This thread lives in the ChatGPT app. You can read it here.',
      handedOff: 'Handed off to ' + ((handoffs[sum.sessionId] && handoffs[sum.sessionId].targetTitle) || 'another session') + '. This session is paused.',
    };
    const details = {
      external: 'Open in a terminal on ' + computerName(),
      chatgpt: 'In ChatGPT',
      background: 'Running in the background',
      handedOff: 'Handed off to ' + ((handoffs[sum.sessionId] && handoffs[sum.sessionId].targetTitle) || 'another session'),
    };
    const pm = ptyManager();
    const live = owner === 'workbook' || owner === 'background' || owner === 'external' || owner === 'chatgpt' || !!(ref.workbookSessionId && pm && pm.getSession && pm.getSession(ref.workbookSessionId) && pm.getSession(ref.workbookSessionId).alive);
    return {
      sessionId: sum.sessionId,
      title: sum.title,
      titleSource: sum.titleSource,
      provider: sum.provider,
      model: extra.model !== undefined ? extra.model : sum.model,
      effort: extra.effort || null,
      permissionMode: extra.permissionMode || null,
      sandbox: extra.sandbox || null,
      approvalPolicy: extra.approvalPolicy || null,
      workingDir: sum.workingDir,
      branch: sum.branch,
      owner,
      ownerDetail: details[owner] || null,
      live,
      projectId: sum.projectId,
      folderId: sum.folderId,
      tabGroupIds: sum.tabGroupIds,
      pinned: sum.pinned,
      archived: sum.archived,
      lineage: sum.lineage,
      settingsPendingRestart: !!extra.settingsPendingRestart,
      readOnlyReason: reasons[owner] || null,
      supersededBy: ref.supersededBy,
      sizeBytes: sum.sizeBytes,
      formatDrift: !!extra.formatDrift,
    };
  }

  /** @returns {string} */
  function computerName() {
    try {
      const s = store();
      const n = s && s.state && s.state.settings && s.state.settings.serverName;
      return n || require('os').hostname();
    } catch (_) { return 'this computer'; }
  }

  /**
   * Merged list of summaries, newest first.
   * @param {{provider?: string, includeArchived?: boolean}} [o]
   * @returns {object[]}
   */
  function list(o = {}) {
    const out = [];
    for (const id of refs().keys()) {
      const sum = summary(id);
      if (!sum) continue;
      if (o.provider && sum.provider !== o.provider) continue;
      if (!o.includeArchived && sum.archived) continue;
      out.push(sum);
    }
    out.sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs || (a.sessionId < b.sessionId ? -1 : 1));
    return out;
  }

  /**
   * Queue a sessions.changed entry; flushed in one event per 500 ms.
   * @param {string} sessionId
   * @param {'added'|'updated'|'removed'|'idChanged'} change
   * @param {object} [o] - {previousSessionId, reason}
   */
  function noteChanged(sessionId, change, o = {}) {
    if (change === 'updated' && o.reason === 'lastActive') {
      const last = lastActivePublished.get(sessionId) || 0;
      if (now() - last < ACTIVE_UPDATE_MIN_MS) return;
      lastActivePublished.set(sessionId, now());
    }
    const prev = pendingChanges.get(sessionId);
    if (prev && prev.change !== 'updated' && change === 'updated') return;
    pendingChanges.set(sessionId, { change, previousSessionId: o.previousSessionId || null });
    if (!batchTimer) {
      batchTimer = setTimeout(flush, CHANGE_BATCH_MS);
      if (batchTimer.unref) batchTimer.unref();
    }
  }

  /** Publish the batched changes. */
  function flush() {
    batchTimer = null;
    if (!pendingChanges.size) return;
    invalidate();
    const changes = [];
    for (const [sessionId, c] of pendingChanges) {
      changes.push({ change: c.change, sessionId, previousSessionId: c.change === 'idChanged' ? c.previousSessionId : null, summary: c.change === 'removed' ? null : summary(sessionId) });
    }
    pendingChanges.clear();
    const hub = ctx && ctx.mobile && ctx.mobile.hub;
    if (hub) {
      try { hub.publish('sessions', 'sessions.changed', { changes }); } catch (err) { warn('sessions.changed publish failed', err && err.message); }
    }
    for (const fn of listeners) {
      try { fn({ changes }); } catch (_) { /* listener errors are theirs */ }
    }
  }

  /**
   * A wb_ session learned its upstream id: alias the old id and announce it.
   * @param {string} oldId
   * @param {string} newId
   */
  function rekey(oldId, newId) {
    if (oldId === newId) return;
    aliases.set(oldId, newId);
    invalidate();
    noteChanged(newId, 'idChanged', { previousSessionId: oldId });
  }

  /**
   * Mark or clear a hand off (B3's migration pause; B2's resume anyway).
   * @param {string} sessionId
   * @param {object|null} info - {targetSessionId, targetTitle, migrationId} or null to clear
   */
  function setHandedOff(sessionId, info) {
    if (info) handoffs[sessionId] = Object.assign({ atMs: now() }, info);
    else delete handoffs[sessionId];
    try { atomicWriteJson(handoffsFile, handoffs); } catch (err) { warn('handoffs write failed', err && err.message); }
    invalidate();
    noteChanged(sessionId, 'updated');
  }

  // Store events keep the index fresh.
  try {
    const s = store();
    if (s && typeof s.on === 'function') {
      s.on('session:created', (x) => { invalidate(); const p = x && agentProviderOf(x); if (p) noteChanged(x.resumeSessionId ? prefixOf(p) + x.resumeSessionId : 'wb_' + x.id, 'added'); });
      s.on('session:updated', () => invalidate());
      s.on('session:deleted', () => invalidate());
    }
  } catch (_) { /* store without events */ }
  if (discovery && discovery.onChanged) discovery.onChanged(() => invalidate());

  return {
    resolve,
    summary,
    meta,
    list,
    ownerOfId: (id) => { const r = resolve(id); return r ? r.owner : null; },
    transcriptPathFor: (id) => { const r = resolve(id); return r ? r.transcriptPath : null; },
    idForWorkbookSession(workbookId) {
      for (const r of refs().values()) if (r.workbookSessionId === workbookId) return r.sessionId;
      return null;
    },
    onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    noteChanged,
    flush,
    rekey,
    setHandedOff,
    handoffOf: (id) => handoffs[id] || null,
    invalidate,
    isPartial: () => (discovery ? discovery.isPartial() : false),
    setStateSource(fn) { if (typeof fn === 'function') stateOf = fn; },
    computerName,
    headFacts,
  };
}

module.exports = { createSessionIndex, agentProviderOf, parseSessionId, prefixOf, UNTITLED };
