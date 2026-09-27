/**
 * migrate/progress.js: follows the takeover session's own transcript and
 * turns what it shows into migration events (PROTOCOL.md 4.12.5; R08
 * section 8, "How Workbook knows what the target is doing").
 *
 * WHY: the new session reports its own progress in provider neutral lines
 * ("MIGRATE: reading 34/96", "MIGRATE: verifying 3/9", the charter's rule),
 * starts its readers with the Agent tool (Claude) or collaboration tools
 * (Codex), and delivers the report through ExitPlanMode (Claude) or as its
 * final answer (Codex). Reading the transcript by byte offset needs no hook
 * and works the same whether the target runs in a Workbook pane or not; the
 * offset is kept on the job so a Workbook restart continues where it was.
 * Reader reports are copied into the pack's readers/ folder as they land,
 * so they survive the lead's own compaction (R08 section 4.5).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

/** Poll interval. */
const TICK_MS = 750;
/** Most bytes read per tick. */
const READ_MAX_BYTES = 8 * 1024 * 1024;
/** The newline byte that ends a transcript record. */
const NEWLINE = 10;
/** Progress lines (R08:538). */
const MIGRATE_RE = /^\s*MIGRATE:\s*(reading|verifying)\s+(\d+)\s*\/\s*(\d+)\s*$/gm;
/** Claude tools that start a reader. */
const CLAUDE_READER_TOOLS = new Set(['Agent', 'Task']);
/** Codex tool names that start and collect readers (R08 section 1.5). */
const CODEX_SPAWN_RE = /spawn_agent/;
const CODEX_WAIT_RE = /wait_agent/;
/** The ExitPlanMode tool (the Claude report). */
const EXIT_PLAN_TOOL = 'ExitPlanMode';
/** A header in a Codex final answer. */
const HEADER_HINT_RE = /takeover_report|claims_checked/;

/**
 * Create a watcher.
 *
 * @param {object} o - {provider, pathOf: () => (string|null), startOffset, packDir, onEvent, now}
 * @returns {{start: Function, stop: Function, tick: Function, offset: Function}}
 */
function createProgressWatcher(o) {
  const provider = o.provider;
  let offset = Number.isInteger(o.startOffset) ? o.startOffset : 0;
  let timer = null;
  // Bytes after the last newline read so far.
  let carry = Buffer.alloc(0);
  let file = null;
  const readerCalls = new Map();
  let readerSeq = 0;
  // The report's ExitPlanMode call, remembered across a Workbook restart
  // (the job keeps it), so the approval that answers it is still seen.
  let exitPlanId = o.exitPlanId || null;
  try { readerSeq = o.packDir ? fs.readdirSync(path.join(o.packDir, 'readers')).length : 0; } catch (_) { readerSeq = 0; }
  let lastAssistantText = '';
  let busy = false;

  /**
   * Emit an event to the job.
   *
   * @param {object} e - Event.
   */
  function emit(e) {
    try { o.onEvent(e); } catch (_) { /* the job logs its own failures */ }
  }

  /**
   * Save one reader report into readers/NNN.md (redacted).
   *
   * @param {string} text - Report text.
   */
  function saveReader(text) {
    if (!o.packDir) return;
    readerSeq += 1;
    try {
      const dir = path.join(o.packDir, 'readers');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, String(readerSeq).padStart(3, '0') + '.md'), redact(String(text || '')));
    } catch (_) { /* best effort */ }
  }

  /**
   * MIGRATE lines in an assistant text.
   *
   * @param {string} text - Text.
   */
  function scanProgress(text) {
    MIGRATE_RE.lastIndex = 0;
    let m;
    while ((m = MIGRATE_RE.exec(String(text || ''))) !== null) {
      emit({ type: 'progress', stage: m[1], done: Number(m[2]), total: Number(m[3]) });
    }
  }

  /**
   * One Claude record.
   *
   * @param {object} r - Record.
   */
  function claude(r) {
    const m = r.message || {};
    if (r.type === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') scanProgress(b.text);
        else if (b.type === 'tool_use') {
          if (CLAUDE_READER_TOOLS.has(b.name)) { readerCalls.set(b.id, true); emit({ type: 'reader', state: 'started', live: readerCalls.size }); }
          if (b.name === EXIT_PLAN_TOOL && b.input && typeof b.input.plan === 'string') {
            exitPlanId = b.id;
            emit({ type: 'report', markdown: b.input.plan, toolUseId: b.id });
          }
        }
      }
      return;
    }
    if (r.type === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'tool_result') continue;
        if (readerCalls.has(b.tool_use_id)) {
          readerCalls.delete(b.tool_use_id);
          const text = Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : String(b.content || '');
          saveReader(text);
          emit({ type: 'reader', state: 'done', live: readerCalls.size });
        }
        if (exitPlanId && b.tool_use_id === exitPlanId) {
          emit({ type: b.is_error === true ? 'planRejected' : 'approved' });
          exitPlanId = null;
        }
      }
    }
  }

  /**
   * One Codex record.
   *
   * @param {object} r - Record.
   */
  function codex(r) {
    const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
    if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (p.content || []).map((b) => (b && b.text) || '').join('\n');
      scanProgress(text);
      if (text.trim()) lastAssistantText = text;
      return;
    }
    if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      if (CODEX_SPAWN_RE.test(String(p.name || ''))) { readerCalls.set(p.call_id, true); emit({ type: 'reader', state: 'started', live: readerCalls.size }); }
      if (CODEX_WAIT_RE.test(String(p.name || ''))) readerCalls.set('wait:' + p.call_id, true);
      return;
    }
    if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      if (readerCalls.has('wait:' + p.call_id)) {
        readerCalls.delete('wait:' + p.call_id);
        saveReader(typeof p.output === 'string' ? p.output : JSON.stringify(p.output));
        for (const k of readerCalls.keys()) { if (!String(k).startsWith('wait:')) { readerCalls.delete(k); break; } }
        emit({ type: 'reader', state: 'done', live: Array.from(readerCalls.keys()).filter((k) => !String(k).startsWith('wait:')).length });
      }
      return;
    }
    if (r.type === 'event_msg' && p.type === 'task_started') { emit({ type: 'turnStarted' }); lastAssistantText = ''; return; }
    if (r.type === 'event_msg' && p.type === 'task_complete') {
      const text = typeof p.last_agent_message === 'string' && p.last_agent_message ? p.last_agent_message : lastAssistantText;
      if (HEADER_HINT_RE.test(text)) emit({ type: 'report', markdown: text, toolUseId: null });
      else emit({ type: 'turnEnded' });
      lastAssistantText = '';
    }
  }

  /** Read what the transcript gained since the last tick. */
  function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!file) file = o.pathOf();
      if (!file) return;
      let st;
      try { st = fs.statSync(file); } catch (_) { return; }
      if (st.size < offset) { offset = 0; carry = Buffer.alloc(0); }
      if (st.size === offset) return;
      const len = Math.min(READ_MAX_BYTES, st.size - offset);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
      // Split on the newline byte, so a read that ends inside a multibyte
      // character never corrupts a line or the offset.
      const bytes = carry.length ? Buffer.concat([carry, buf]) : buf;
      const lastNl = bytes.lastIndexOf(NEWLINE);
      const complete = lastNl === -1 ? '' : bytes.subarray(0, lastNl).toString('utf8');
      carry = Buffer.from(lastNl === -1 ? bytes : bytes.subarray(lastNl + 1));
      offset += len;
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch (_) { continue; }
        if (provider === 'codex') codex(r); else claude(r); // gsd:provider-literal-allowed (mobile v2 migration progress)
      }
      emit({ type: 'offset', offset: offset - carry.length });
    } catch (_) {
      // A transient read error: the next tick tries again.
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, o.tickMs || TICK_MS);
      if (timer.unref) timer.unref();
      tick();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    offset: () => offset,
    resetPath() { file = null; },
  };
}

module.exports = { createProgressWatcher, MIGRATE_RE };
