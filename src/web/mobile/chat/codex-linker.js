/**
 * Links fresh Codex panes to their thread ids (critic F17, BUILD-CONTRACT
 * 3.6.1 item 9).
 *
 * What: after Workbook starts a Codex pane with no thread id (a new session
 * or a branch from the phone), look for the newest thread in Codex's
 * state_5.sqlite (read only, through providers/codex/state-db.js) whose
 * working directory matches and that was created after the launch; when the
 * phone sent the first message, confirm by that text. Then store the thread
 * id on the Workbook session and re-key its phone id from wb_ to cx_
 * (sessions.changed idChanged, and a final session.meta with supersededBy on
 * the old topic). Falls back to a walk of $CODEX_HOME/sessions when the
 * state database is unavailable.
 *
 * Why: a fresh Codex pane never learns its thread id otherwise (R02:288), so
 * the phone could not show its history.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeCwd } = require('../../../providers/claude/live-sessions');
const { log, warn } = require('./common');

const POLL_MS = 1000;
const GIVE_UP_MS = 120000;
const CREATED_SLACK_MS = 5000;
const MATCH_PREFIX = 40;
const HEAD_BYTES = 16384;

/**
 * Threads created after a time, from the state db, else from rollout heads.
 * @param {number} sinceMs
 * @returns {Promise<Array<{id: string, cwd: (string|null), createdAtMs: number, firstMessage: (string|null)}>>}
 */
async function recentThreads(sinceMs) {
  let rows = null;
  try {
    const db = require('../../../providers/codex/state-db');
    if (db.isAvailable && db.isAvailable()) rows = await db.listThreads({ includeHidden: true, includeArchived: true, force: true });
  } catch (_) { rows = null; }
  if (Array.isArray(rows)) {
    return rows.filter((r) => (r.createdAtMs || 0) >= sinceMs).map((r) => ({ id: r.id, cwd: r.cwd || r.cwdRaw || null, createdAtMs: r.createdAtMs || 0, firstMessage: r.rawFirstMessage || r.preview || null }));
  }
  const home = process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
  const out = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) { walk(full, depth + 1); continue; }
      if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.mtimeMs < sinceMs) continue;
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        fs.closeSync(fd);
        let meta = null;
        let first = null;
        for (const l of buf.toString('utf8', 0, n).split('\n')) {
          let r;
          try { r = JSON.parse(l); } catch (_) { continue; }
          if (r.type === 'session_meta' && r.payload) meta = r.payload;
          if (!first && r.type === 'response_item' && r.payload && r.payload.type === 'message' && r.payload.role === 'user') {
            first = require('./codex-messages').codexText(r.payload.content, 'input');
          }
        }
        if (meta && meta.id) out.push({ id: String(meta.id).toLowerCase(), cwd: meta.cwd || null, createdAtMs: Date.parse(meta.timestamp || '') || st.birthtimeMs || st.mtimeMs, firstMessage: first });
      } catch (_) { /* unreadable head */ }
    }
  };
  walk(path.join(home, 'sessions'), 0);
  return out.filter((r) => r.createdAtMs >= sinceMs);
}

/**
 * @param {object} deps - {ctx, index, now}
 * @returns {object}
 */
function createCodexLinker(deps) {
  const { ctx, index } = deps;
  const now = deps.now || Date.now;
  const jobs = new Map();
  const listeners = new Set();

  /**
   * Link one Workbook session to a thread.
   * @param {string} wbId
   * @param {string} threadId
   */
  function link(wbId, threadId) {
    const oldId = 'wb_' + wbId;
    const newId = 'cx_' + threadId;
    try { ctx.store.updateSession(wbId, { resumeSessionId: threadId }); } catch (err) { warn('linker could not store the thread id', err && err.message); return; }
    index.rekey(oldId, newId);
    const hub = ctx.mobile && ctx.mobile.hub;
    const meta = index.meta(newId);
    if (hub && meta) {
      try { hub.publish('session:' + oldId, 'session.meta', Object.assign({}, meta, { sessionId: oldId, supersededBy: newId })); } catch (_) {}
    }
    log('codex linker: linked a Workbook session to its thread');
    for (const fn of listeners) { try { fn(oldId, newId); } catch (_) {} }
  }

  /**
   * Poll until a thread matches or the job gives up.
   * @param {string} wbId
   */
  async function poll(wbId) {
    const job = jobs.get(wbId);
    if (!job) return;
    if (now() - job.launchAt > GIVE_UP_MS) { jobs.delete(wbId); return; }
    const rec = ctx.store.getSession(wbId);
    if (!rec || rec.resumeSessionId) { jobs.delete(wbId); return; }
    const taken = new Set(ctx.store.getAllSessionsList().map((s) => String(s.resumeSessionId || '').toLowerCase()).filter(Boolean));
    const want = job.cwd ? normalizeCwd(job.cwd) : null;
    const threads = (await recentThreads(job.launchAt - CREATED_SLACK_MS))
      .filter((t) => !taken.has(String(t.id).toLowerCase()) && t.id !== job.excludeThreadId && (!want || (t.cwd && normalizeCwd(t.cwd) === want)))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    let pick = null;
    if (job.firstText) {
      const key = String(job.firstText).trim().slice(0, MATCH_PREFIX);
      pick = threads.find((t) => t.firstMessage && String(t.firstMessage).trim().startsWith(key)) || null;
    } else if (threads.length) {
      pick = threads[0];
    }
    if (pick) { jobs.delete(wbId); link(wbId, pick.id); return; }
    job.timer = setTimeout(() => { poll(wbId).catch(() => {}); }, POLL_MS);
    if (job.timer.unref) job.timer.unref();
  }

  return {
    /**
     * Start linking a Codex pane Workbook just launched.
     * @param {string} wbId
     * @param {{cwd: (string|null), launchAt: number, firstText: (string|null), excludeThreadId?: string}} o
     */
    track(wbId, o) {
      if (jobs.has(wbId)) return;
      jobs.set(wbId, { cwd: o.cwd || null, launchAt: o.launchAt || now(), firstText: o.firstText || null, excludeThreadId: o.excludeThreadId || null, timer: null });
      poll(wbId).catch((err) => warn('codex linker failed', err && err.message));
    },
    /** A phone send to a still unlinked pane gives the confirmation text. */
    noteFirstText(wbId, text) { const j = jobs.get(wbId); if (j && !j.firstText) j.firstText = text; },
    pending: () => Array.from(jobs.keys()),
    onLinked(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    link,
    stop() { for (const j of jobs.values()) if (j.timer) clearTimeout(j.timer); jobs.clear(); },
  };
}

module.exports = { createCodexLinker, recentThreads };
