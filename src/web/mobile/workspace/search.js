/**
 * workspace/search.js: GET /search/names and GET /search/messages
 * (PROTOCOL.md 4.9, decision A15, critic F4).
 *
 * WHY: name search answers from memory (session titles, projects, folders,
 * tab groups, working directories) so the phone's stage one is instant.
 * Message search runs Workbook's existing content search (the same
 * racedSearch the desktop's GET /api/search uses, with its 5 s budget split
 * across providers) once per query and provider filter with limit 200,
 * caches the run for 60 s and pages over it, so paging costs nothing and
 * every page of one query reports the same totals. Hits are mapped from
 * upstream ids to phone ids through B2's session index (hits it cannot
 * resolve, such as subagent transcripts and plain shells, are dropped
 * before counting), and every answer states its coverage honestly: files
 * over 8 MiB are searched only in their last 2 MiB (E6), which the
 * coverage block counts from file sizes.
 *
 * Anchors: a hit opens with GET /sessions/:id/messages?around=<anchor>,
 * which B2 resolves by a whole file line number. For a tail read file the
 * provider's line number counts from the start of its 2 MiB window, so this
 * module converts it to a whole file line (checking that the line holds the
 * query, and caching newline counts per file) before minting the anchor.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const common = require('./common');

/** Hits one message search run collects (PROTOCOL.md 4.9.2). */
const RUN_LIMIT = 200;
/** How long a run is reused for paging (PROTOCOL.md 14). */
const RUN_TTL_MS = 60 * 1000;
/** Page sizes. */
const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 100;
const NAMES_DEFAULT = 30;
const NAMES_MAX = 100;
/** Search budget across providers when ctx.search does not say (server.js). */
const DEFAULT_BUDGET_MS = 5000;
const DEFAULT_GRACE_MS = 100;
/** Files over this are searched only in their tail (claude/search.js, codex/search.js). */
const TAIL_ONLY_BYTES = 8 * 1024 * 1024;
/** The tail window those files are searched in. */
const TAIL_WINDOW_BYTES = 2 * 1024 * 1024;
/** Extra bytes read before the window when a line must be found again. */
const TAIL_SLACK_BYTES = 1024 * 1024;
/** Chunk size for newline counting. */
const COUNT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Name index reuse window (name search answers within 100 ms). */
const NAME_INDEX_TTL_MS = 2000;
/**
 * How long a built index may keep answering while a fresh one is built in
 * the background (change events rebuild it sooner, see warmSoon).
 */
const NAME_INDEX_STALE_OK_MS = 30 * 1000;
/** Delay before a background rebuild after a change (coalesces bursts). */
const NAME_INDEX_WARM_DELAY_MS = 250;
/** Store events that change a name the index holds. */
const NAME_STORE_EVENTS = Object.freeze(['session:created', 'session:updated', 'session:deleted', 'workspace:created', 'workspace:updated', 'workspace:deleted', 'group:created', 'group:updated', 'group:deleted', 'providerSessionTitles:updated', 'state:reloaded']);
/** The coverage sentence (PROTOCOL.md 4.9.2, A15). */
const COVERAGE_NOTE = 'Files over 8 MB are searched in their last 2 MB.';
/** Cursor format version. */
const CURSOR_VERSION = 1;
/** Most runs kept in memory at once. */
const RUNS_MAX = 50;
/** Newline byte. */
const NEWLINE = 10;

/**
 * Every [start, end) UTF-16 range of a case insensitive query in a text.
 *
 * @param {string} text - Text.
 * @param {string} query - Query.
 * @returns {number[][]}
 */
function matchRanges(text, query) {
  const out = [];
  if (!text || !query) return out;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.length !== text.length) {
    // Lower casing changed the length (rare scripts): fall back to one exact search.
    const i = text.indexOf(query);
    if (i >= 0) out.push([i, i + query.length]);
    return out;
  }
  let from = 0;
  for (;;) {
    const i = t.indexOf(q, from);
    if (i === -1) break;
    out.push([i, i + q.length]);
    from = i + Math.max(1, q.length);
  }
  return out;
}

/**
 * Rank of a title for a query: 0 prefix, 1 word start, 2 substring, -1 none.
 *
 * @param {string} title - Title.
 * @param {string} q - Lower cased query.
 * @returns {number}
 */
function rankOf(title, q) {
  const t = String(title || '').toLowerCase();
  const i = t.indexOf(q);
  if (i === -1) return -1;
  if (i === 0) return 0;
  const re = new RegExp('(^|[^a-z0-9])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return re.test(t) ? 1 : 2;
}

/**
 * Create the search service.
 *
 * @param {object} deps - {ctx, now, tabs, tree}
 * @returns {{names: Function, messages: Function, clearRuns: Function}}
 */
function createSearch(deps) {
  const ctx = deps.ctx;
  const now = deps.now || Date.now;
  const p = common.parts(ctx);
  const log = common.logger(ctx);
  const runs = new Map();
  const lineCounts = new Map();
  let nameIndex = { at: 0, entries: [], valid: false };

  // ── Name search ─────────────────────────────────────────────────────────

  /**
   * Build (or reuse) the in memory name index.
   *
   * @returns {object[]} Candidate results without match fields.
   */
  function names_index() {
    const age = now() - nameIndex.at;
    if (age < NAME_INDEX_TTL_MS) return nameIndex.entries;
    // A recent index answers at once while a fresh one is built after the
    // reply, so the phone's first keystroke never waits on B2's list (the
    // change events below rebuild it soon after anything is renamed).
    if (nameIndex.valid && age < NAME_INDEX_STALE_OK_MS) {
      warmSoon(0);
      return nameIndex.entries;
    }
    return buildNameIndex();
  }

  /**
   * Build the name index now.
   *
   * @returns {object[]} The entries.
   */
  function buildNameIndex() {
    const entries = [];
    const st = (ctx.store && ctx.store.state) || {};
    const workspaces = st.workspaces || {};
    const groups = st.workspaceGroups || {};
    const chat = p.chat();
    let list = [];
    try { list = chat && chat.sessions ? chat.sessions.list() : []; } catch (_) { list = []; }
    const dirs = new Map();
    for (const s of list) {
      if (!s || s.archived) continue;
      const projectName = s.projectId && workspaces[s.projectId] ? workspaces[s.projectId].name : null;
      entries.push({ kind: 'session', id: s.sessionId, title: s.title, subtitle: projectName || null, provider: s.provider, sessionId: s.sessionId, projectId: s.projectId || null, workingDir: s.workingDir || null, lastActiveAtMs: s.lastActiveAtMs || null, match: s.title });
      if (s.workingDir) {
        const key = common.normalizePath(s.workingDir);
        const prev = dirs.get(key);
        if (!prev || (s.lastActiveAtMs || 0) > (prev.lastActiveAtMs || 0)) dirs.set(key, { dir: s.workingDir, projectId: s.projectId || null, lastActiveAtMs: s.lastActiveAtMs || null });
      }
    }
    for (const w of Object.values(workspaces)) {
      if (!w || !w.name) continue;
      entries.push({ kind: 'project', id: w.id, title: String(w.name), subtitle: null, provider: null, sessionId: null, projectId: w.id, workingDir: null, lastActiveAtMs: common.toMs(w.lastActive), match: String(w.name) });
    }
    for (const g of Object.values(groups)) {
      if (!g || !g.name) continue;
      entries.push({ kind: 'folder', id: g.id, title: String(g.name), subtitle: null, provider: null, sessionId: null, projectId: null, workingDir: null, lastActiveAtMs: null, match: String(g.name) });
    }
    try {
      const t = deps.tabs ? deps.tabs.current() : null;
      for (const g of (t && t.groups) || []) {
        entries.push({ kind: 'tabGroup', id: g.id, title: g.name, subtitle: g.sessionIds.length + (g.sessionIds.length === 1 ? ' session' : ' sessions'), provider: null, sessionId: null, projectId: null, workingDir: null, lastActiveAtMs: null, match: g.name });
      }
    } catch (_) { /* tabs are optional here */ }
    for (const d of dirs.values()) {
      entries.push({ kind: 'workingDir', id: d.dir, title: d.dir, subtitle: d.projectId && workspaces[d.projectId] ? String(workspaces[d.projectId].name) : null, provider: null, sessionId: null, projectId: d.projectId, workingDir: d.dir, lastActiveAtMs: d.lastActiveAtMs, match: d.dir });
    }
    nameIndex = { at: now(), entries, valid: true };
    lastBuildAt = nameIndex.at;
    return entries;
  }

  let warmTimer = null;
  let lastBuildAt = 0;
  /**
   * Rebuild the name index in the background after a short delay (once per
   * burst of changes).
   *
   * @param {number} [delayMs] - Delay.
   */
  function warmSoon(delayMs) {
    if (warmTimer) return;
    // Background builds run at most once per NAME_INDEX_TTL_MS, so a busy
    // computer (store updates every second) never rebuilds in a loop.
    const wait = Math.max(Number.isFinite(delayMs) ? delayMs : NAME_INDEX_WARM_DELAY_MS, (lastBuildAt + NAME_INDEX_TTL_MS) - now());
    warmTimer = setTimeout(() => {
      warmTimer = null;
      try { buildNameIndex(); } catch (err) { log('name index build failed: ' + (err && err.message)); }
    }, Math.max(0, wait));
    if (warmTimer.unref) warmTimer.unref();
  }

  /**
   * Mark the index stale (it keeps answering through the stale path in
   * names_index) and rebuild it in the background, so a query after a change
   * never rebuilds on the request path (PROTOCOL.md 4.9.1).
   */
  function invalidateNames() {
    nameIndex = nameIndex.valid ? { at: now() - NAME_INDEX_TTL_MS, entries: nameIndex.entries, valid: true } : { at: 0, entries: [], valid: false };
    warmSoon(NAME_INDEX_WARM_DELAY_MS);
  }

  // Changes that alter names: B2's session changes and the store's events.
  const unsubs = [];
  const chatForNames = p.chat();
  if (chatForNames && chatForNames.sessions && typeof chatForNames.sessions.onChanged === 'function') {
    // Sessions added, removed or re-keyed (and lastActive updates, which
    // are frequent): the current index keeps answering until the rebuild.
    try { unsubs.push(chatForNames.sessions.onChanged(() => warmSoon(NAME_INDEX_WARM_DELAY_MS))); } catch (_) { /* optional */ }
  }
  if (ctx.store && typeof ctx.store.on === 'function') {
    const onStore = () => invalidateNames();
    for (const ev of NAME_STORE_EVENTS) ctx.store.on(ev, onStore);
    unsubs.push(() => { for (const ev of NAME_STORE_EVENTS) { try { ctx.store.removeListener(ev, onStore); } catch (_) { /* ignore */ } } });
  }
  warmSoon(0);

  /**
   * GET /search/names (PROTOCOL.md 4.9.1).
   *
   * @param {object} q - Query parameters.
   * @returns {object} NameSearchResult.
   */
  function names(q) {
    const started = now();
    const query = typeof (q && q.q) === 'string' ? q.q.trim() : '';
    if (query.length < 1) common.fail('QUERY_TOO_SHORT', 'Type at least one character.');
    let limit = NAMES_DEFAULT;
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > NAMES_MAX) common.fail('INVALID_FIELD', 'limit must be 1 to 100.', { field: 'limit' });
    }
    const ql = query.toLowerCase();
    const hits = [];
    for (const e of names_index()) {
      const r = rankOf(e.match, ql);
      if (r < 0) continue;
      hits.push({ e, r });
    }
    hits.sort((a, b) => a.r - b.r || (b.e.lastActiveAtMs || 0) - (a.e.lastActiveAtMs || 0) || (a.e.title < b.e.title ? -1 : 1));
    const results = hits.slice(0, limit).map(({ e }) => ({
      kind: e.kind, id: e.id, title: e.title || e.id, subtitle: e.subtitle, provider: e.provider, sessionId: e.sessionId, projectId: e.projectId, workingDir: e.workingDir, lastActiveAtMs: e.lastActiveAtMs, matchRanges: matchRanges(e.title || '', query),
    }));
    return { query, results, durationMs: Math.max(0, now() - started) };
  }

  // ── Message search ──────────────────────────────────────────────────────

  /** @returns {Array<object>} enabled provider objects of the registry */
  function enabledProviders() {
    const reg = ctx.registry;
    try {
      if (reg && typeof reg.listEnabled === 'function') return reg.listEnabled().filter((x) => x && common.AGENT_PROVIDERS.includes(x.id) && typeof x.search === 'function');
    } catch (_) { /* no registry */ }
    return [];
  }

  /**
   * Run one provider's search with Workbook's race (server.js racedSearch).
   *
   * @param {object} provider - Registry provider.
   * @param {string} query - Query.
   * @param {number} budget - Per provider budget.
   * @returns {Promise<object>}
   */
  function raced(provider, query, budget) {
    const s = ctx.search || {};
    const grace = Number.isFinite(s.SEARCH_TIMEOUT_GRACE_MS) ? s.SEARCH_TIMEOUT_GRACE_MS : DEFAULT_GRACE_MS;
    if (typeof s.racedSearch === 'function') return s.racedSearch(provider, query, RUN_LIMIT, budget, grace);
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true, providerId: provider.id }), budget + grace); if (timer.unref) timer.unref(); });
    return Promise.race([Promise.resolve().then(() => provider.search({ query, limit: RUN_LIMIT, timeBudgetMs: budget })), timeout]).then((v) => { clearTimeout(timer); return v; });
  }

  /**
   * The transcript files a provider's search walks, in its order (newest
   * modified first), with sizes: used to count the tail read files among
   * the first `searchedFiles` of them.
   *
   * @param {string} providerId - claude or codex.
   * @returns {Array<{filePath: string, size: number}>}
   */
  function searchableFiles(providerId) {
    const out = [];
    if (providerId === 'claude') { // gsd:provider-literal-allowed (mobile v2 search coverage)
      let root = null;
      try { root = require('../../../providers/claude/path-decode').resolveClaudeProjectsDir(); } catch (_) { root = null; }
      if (!root) return out;
      let dirs = [];
      try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { dirs = []; }
      for (const d of dirs) {
        let files = [];
        try { files = fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.jsonl')); } catch (_) { files = []; }
        for (const f of files) {
          const filePath = path.join(root, d.name, f);
          try { const st = fs.statSync(filePath); out.push({ filePath, size: st.size, mtimeMs: st.mtimeMs }); } catch (_) { out.push({ filePath, size: 0, mtimeMs: 0 }); }
        }
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return out;
    }
    try {
      const internal = require('../../../providers/codex/search')._internal;
      const files = internal && typeof internal.getSearchableFiles === 'function' ? internal.getSearchableFiles() : [];
      for (const f of files) {
        let size = 0;
        try { size = fs.statSync(f.filePath).size; } catch (_) { size = 0; }
        out.push({ filePath: f.filePath, size, mtimeMs: f.mtimeMs || 0 });
      }
    } catch (_) { /* no codex search module */ }
    return out;
  }

  /**
   * How many of a provider's first n searched files are tail read (E6).
   *
   * @param {string} providerId - Provider.
   * @param {number} searched - searchedFiles of the provider.
   * @returns {number}
   */
  function tailOnlyCount(providerId, searched) {
    if (!searched) return 0;
    return searchableFiles(providerId).slice(0, searched).filter((f) => f.size > TAIL_ONLY_BYTES).length;
  }

  /**
   * Newlines in [0, end) of a file, counted in chunks without blocking the
   * event loop, cached per file so a later count continues from the last.
   *
   * @param {string} file - Path.
   * @param {number} end - Byte offset.
   * @returns {Promise<number>}
   */
  async function countNewlines(file, end) {
    let points = lineCounts.get(file);
    let st = null;
    try { st = fs.statSync(file); } catch (_) { return 0; }
    const identity = st.ino + ':' + st.birthtimeMs;
    if (!points || points.identity !== identity) { points = { identity, list: [[0, 0]] }; lineCounts.set(file, points); }
    let best = points.list[0];
    for (const pt of points.list) if (pt[0] <= end && pt[0] > best[0]) best = pt;
    let pos = best[0];
    let count = best[1];
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
      while (pos < end) {
        const want = Math.min(COUNT_CHUNK_BYTES, end - pos);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        let i = buf.indexOf(NEWLINE, 0);
        while (i !== -1 && i < bytesRead) { count += 1; i = buf.indexOf(NEWLINE, i + 1); }
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
    points.list.push([end, count]);
    if (points.list.length > 64) points.list.splice(1, points.list.length - 64);
    return count;
  }

  /**
   * Split a buffer into lines with their byte offsets.
   *
   * @param {Buffer} buf - Bytes.
   * @param {number} base - File offset of buf[0].
   * @returns {Array<{offset: number, text: string}>}
   */
  function linesOf(buf, base) {
    const out = [];
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, start);
      if (nl === -1) { if (start < buf.length) out.push({ offset: base + start, text: buf.subarray(start).toString('utf8') }); break; }
      out.push({ offset: base + start, text: buf.subarray(start, nl).toString('utf8') });
      start = nl + 1;
    }
    return out;
  }

  /**
   * Whether a raw transcript line holds the query (raw or JSON escaped).
   *
   * @param {string} line - Raw JSONL line.
   * @param {string} ql - Lower cased query.
   * @returns {boolean}
   */
  function lineHolds(line, ql) {
    const l = line.toLowerCase();
    if (l.includes(ql)) return true;
    const escaped = JSON.stringify(ql).slice(1, -1);
    return escaped !== ql && l.includes(escaped);
  }

  /**
   * The whole file line number of a provider hit (1 based), or null when
   * the line holding the match cannot be found any more.
   *
   * @param {string} file - Transcript path.
   * @param {number} hitLine - The provider's lineNumber.
   * @param {string} ql - Lower cased query.
   * @param {Map} fileCache - Lines already read in this run, by file.
   * @returns {Promise<number|null>}
   */
  async function wholeFileLine(file, hitLine, ql, fileCache) {
    let cached = fileCache.get(file);
    if (!cached) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { return null; }
      if (size <= TAIL_ONLY_BYTES) {
        cached = { tail: false, lines: linesOf(await fsp.readFile(file), 0) };
      } else {
        // Tail read file: the provider's window started at (its cached
        // size - 2 MiB) and dropped the first partial line. Read a little
        // more before the window, so a file that grew since the provider's
        // stat still holds the line.
        const windowStart = Math.max(0, size - TAIL_WINDOW_BYTES);
        const readStart = Math.max(0, windowStart - TAIL_SLACK_BYTES);
        const fh = await fsp.open(file, 'r');
        let buf;
        try {
          buf = Buffer.alloc(size - readStart);
          await fh.read(buf, 0, buf.length, readStart);
        } finally {
          await fh.close();
        }
        cached = { tail: true, windowStart, lines: linesOf(buf, readStart).slice(1) }; // the first may be partial
      }
      fileCache.set(file, cached);
    }
    if (!cached.tail) {
      const lines = cached.lines;
      const exact = lines[hitLine - 1];
      if (exact && lineHolds(exact.text, ql)) return hitLine;
      return nearest(lines, hitLine - 1, ql, 0);
    }
    // Choose the matching line nearest the place the provider named.
    const lines = cached.lines;
    const windowStart = cached.windowStart;
    const firstInWindow = lines.findIndex((l) => l.offset > windowStart);
    const expected = (firstInWindow === -1 ? 0 : firstInWindow) + hitLine - 1;
    const idx = (lines[expected] && lineHolds(lines[expected].text, ql)) ? expected : nearestIndex(lines, expected, ql);
    if (idx === -1) return null;
    return 1 + await countNewlines(file, lines[idx].offset);
  }

  /**
   * The index of the line nearest `at` that holds the query, or -1.
   *
   * @param {Array<{text: string}>} lines - Lines.
   * @param {number} at - Expected index.
   * @param {string} ql - Lower cased query.
   * @returns {number}
   */
  function nearestIndex(lines, at, ql) {
    for (let d = 0; d < lines.length; d++) {
      if (at - d >= 0 && at - d < lines.length && lineHolds(lines[at - d].text, ql)) return at - d;
      if (at + d < lines.length && at + d >= 0 && lineHolds(lines[at + d].text, ql)) return at + d;
      if (at - d < 0 && at + d >= lines.length) break;
    }
    return -1;
  }

  /**
   * 1 based line number of the matching line nearest an index.
   *
   * @param {Array<{text: string}>} lines - Whole file lines.
   * @param {number} at - Expected index.
   * @param {string} ql - Lower cased query.
   * @param {number} base - Line number of lines[0] minus 1.
   * @returns {number|null}
   */
  function nearest(lines, at, ql, base) {
    const i = nearestIndex(lines, at, ql);
    return i === -1 ? null : base + i + 1;
  }

  /**
   * The phone session of a provider hit, or null (dropped hit).
   *
   * @param {object} hit - Provider result.
   * @param {Set<string>} listed - Ids B2 lists.
   * @returns {object|null} SessionRef.
   */
  function resolveHit(hit, listed) {
    if (!hit || !common.AGENT_PROVIDERS.includes(hit.provider) || typeof hit.sessionId !== 'string') return null;
    const id = (hit.provider === 'codex' ? 'cx_' : 'cl_') + hit.sessionId; // gsd:provider-literal-allowed (mobile v2 search)
    if (!common.isSessionId(id)) return null;
    const chat = p.chat();
    const ref = chat && chat.sessions ? chat.sessions.resolve(id) : null;
    if (!ref) return null;
    // Codex child threads resolve by file too; only listed ones count.
    if (ref.provider === 'codex' && !listed.has(ref.sessionId)) return null; // gsd:provider-literal-allowed (mobile v2 search)
    return ref;
  }

  /**
   * Run (or reuse) the search for one query and provider filter.
   *
   * @param {string} query - Trimmed query.
   * @param {string|null} providerFilter - claude, codex or null.
   * @returns {Promise<object>} The cached run.
   */
  async function run(query, providerFilter) {
    const key = query.toLowerCase() + '\u0000' + (providerFilter || '');
    const hit = runs.get(key);
    if (hit && now() - hit.at < RUN_TTL_MS) return hit;
    const providers = enabledProviders().filter((x) => !providerFilter || x.id === providerFilter);
    const s = ctx.search || {};
    const total = Number.isFinite(s.SEARCH_TOTAL_BUDGET_MS) ? s.SEARCH_TOTAL_BUDGET_MS : DEFAULT_BUDGET_MS;
    const budget = providers.length ? Math.floor(total / providers.length) : total;
    const settled = await Promise.allSettled(providers.map((pr) => raced(pr, query, budget)));
    const merged = [];
    const timedOut = [];
    let searchedFiles = 0;
    let tailOnlyFiles = 0;
    for (let i = 0; i < providers.length; i++) {
      const r = settled[i];
      const pid = providers[i].id;
      if (r.status === 'rejected' || (r.value && r.value.__timedOut)) { timedOut.push(pid); continue; }
      const v = r.value || {};
      if (Array.isArray(v.results)) for (const x of v.results) merged.push(x);
      const n = Number(v.searchedFiles) || 0;
      searchedFiles += n;
      try { tailOnlyFiles += tailOnlyCount(pid, n); } catch (_) { /* coverage stays a floor */ }
      if (v.timedOut === true) timedOut.push(pid);
    }
    merged.sort((a, b) => (common.toMs(b.timestamp) || 0) - (common.toMs(a.timestamp) || 0));
    const capped = merged.length >= RUN_LIMIT;
    const chat = p.chat();
    let listedSummaries = [];
    try { listedSummaries = chat && chat.sessions ? chat.sessions.list() : []; } catch (_) { listedSummaries = []; }
    const listed = new Set(listedSummaries.map((x) => x.sessionId));
    const summaries = new Map(listedSummaries.map((x) => [x.sessionId, x]));
    const workspaces = (ctx.store && ctx.store.state && ctx.store.state.workspaces) || {};
    const ql = query.toLowerCase();
    const results = [];
    // Resolve every hit first, then find whole file lines one file at a
    // time (each file is read once, and only one is held in memory).
    const kept = merged.slice(0, RUN_LIMIT).map((h) => ({ h, ref: resolveHit(h, listed), line: null })).filter((x) => x.ref && x.ref.transcriptPath);
    const byFile = new Map();
    for (const x of kept) {
      if (!byFile.has(x.ref.transcriptPath)) byFile.set(x.ref.transcriptPath, []);
      byFile.get(x.ref.transcriptPath).push(x);
    }
    for (const [file, xs] of byFile) {
      const fileCache = new Map();
      for (const x of xs) {
        try { x.line = Number.isInteger(x.h.lineNumber) && x.h.lineNumber >= 1 ? await wholeFileLine(file, x.h.lineNumber, ql, fileCache) : null; } catch (err) { x.line = null; log('search anchor lookup failed: ' + (err && err.code)); }
      }
    }
    for (const { h, ref, line } of kept) {
      if (!line) continue;
      const sum = summaries.get(ref.sessionId) || null;
      const projectId = (sum && sum.projectId) || ref.projectId || null;
      const snippet = typeof h.snippet === 'string' ? h.snippet : '';
      const role = ['user', 'assistant', 'tool', 'system'].includes(h.role) ? h.role : null;
      results.push({
        sessionId: ref.sessionId,
        title: ref.title || 'Untitled session',
        provider: ref.provider,
        projectName: projectId && workspaces[projectId] ? String(workspaces[projectId].name) : (projectId === 'unassigned' ? 'Other working directories' : (h.projectName || null)),
        workingDir: ref.workingDir || h.projectPath || null,
        ts: common.toMs(h.timestamp),
        role,
        snippet,
        matchRanges: matchRanges(snippet, query),
        anchor: encodeAnchor(ref.provider, ref.upstreamId, line),
      });
    }
    const entry = {
      id: crypto.randomBytes(9).toString('hex'),
      key,
      at: now(),
      query,
      results,
      totalHits: results.length,
      sessionCount: new Set(results.map((r) => r.sessionId)).size,
      hitsCapped: capped,
      coverage: { searchedFiles, tailOnlyFiles, partial: timedOut.length > 0, timedOutProviders: Array.from(new Set(timedOut)), budgetMs: total, note: COVERAGE_NOTE },
    };
    runs.set(key, entry);
    if (runs.size > RUNS_MAX) runs.delete(runs.keys().next().value);
    return entry;
  }

  /**
   * B2's anchor format (transcript-reader.js encodeAnchor).
   *
   * @param {string} provider - Provider.
   * @param {string} upstreamId - Upstream id.
   * @param {number} lineNumber - Whole file line, 1 based.
   * @returns {string}
   */
  function encodeAnchor(provider, upstreamId, lineNumber) {
    try {
      return require('../chat/transcript-reader').encodeAnchor({ provider, upstreamId, lineNumber });
    } catch (_) {
      return common.b64url(Buffer.from(JSON.stringify({ v: 1, p: provider, u: upstreamId, l: lineNumber })));
    }
  }

  /**
   * GET /search/messages (PROTOCOL.md 4.9.2).
   *
   * @param {object} q - Query parameters.
   * @returns {Promise<object>} MessageSearchResult.
   */
  async function messages(q) {
    const started = now();
    const query = typeof (q && q.q) === 'string' ? q.q.trim() : '';
    if (query.length < 2) common.fail('QUERY_TOO_SHORT', 'Type at least two characters.');
    let limit = MESSAGES_DEFAULT;
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGES_MAX) common.fail('INVALID_FIELD', 'limit must be 1 to 100.', { field: 'limit' });
    }
    let provider = null;
    if (q.provider !== undefined && q.provider !== '') {
      if (!common.AGENT_PROVIDERS.includes(q.provider)) common.fail('INVALID_FIELD', 'provider is claude or codex.', { field: 'provider' });
      provider = q.provider;
    }
    let entry;
    let offset = 0;
    if (q.cursor) {
      let c = null;
      try { c = JSON.parse(Buffer.from(String(q.cursor).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (_) { c = null; }
      const cached = c && c.v === CURSOR_VERSION ? Array.from(runs.values()).find((r) => r.id === c.r) : null;
      if (!cached || now() - cached.at >= RUN_TTL_MS || !Number.isInteger(c.o) || c.o < 0) common.fail('CURSOR_EXPIRED', 'Those results expired. Search again.');
      entry = cached;
      offset = c.o;
    } else {
      entry = await run(query, provider);
    }
    const page = entry.results.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < entry.results.length ? common.b64url(Buffer.from(JSON.stringify({ v: CURSOR_VERSION, r: entry.id, o: nextOffset }))) : null;
    return {
      query: entry.query,
      results: page,
      nextCursor,
      totalHits: entry.totalHits,
      sessionCount: entry.sessionCount,
      hitsCapped: entry.hitsCapped,
      coverage: entry.coverage,
      durationMs: Math.max(0, now() - started),
    };
  }

  return {
    names,
    messages,
    clearRuns: () => runs.clear(),
    invalidateNames,
    stop() {
      for (const u of unsubs.splice(0)) { try { u(); } catch (_) { /* ignore */ } }
      if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
    },
  };
}

module.exports = { createSearch, matchRanges, rankOf, COVERAGE_NOTE, TAIL_ONLY_BYTES };
