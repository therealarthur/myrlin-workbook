/**
 * migrate/indexer-worker.js: the deterministic, streaming migration indexer
 * (R08 sections 4.2 to 4.3, Appendix A), run in a worker_thread.
 *
 * WHY: histories on this computer reach 2.67 GB (R08 section 1.1), far past
 * what any request thread may read, and a whole file string throws past
 * 536 million characters (R08 section 1.7). So the indexer streams the
 * transcript from byte 0 to the snapshot length in 4 MiB blocks, never holds
 * more than one line at a time (lines over 16 MiB are counted and skipped,
 * never buffered), and runs in a worker thread so the HTTP thread never
 * blocks (R08:196). It writes the pack's index layer: manifest.json,
 * timeline.md (L0), user-messages.md, decisions.md, checkpoints.md,
 * last-tasks.md, agent-reports.md, digest.md (L1), chunks/cNNN.md (L2),
 * files.tsv, commands.tsv, errors.md, and turns.jsonl with turns-index.json
 * for the evidence sheet. Every text is redacted (redact.js). The output
 * depends only on the input bytes (no clock), so the same snapshot always
 * gives the same index.
 *
 * Messages to the parent: {type: 'progress', bytes, total, turns},
 * {type: 'done', manifest}, {type: 'error', message}.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

/** Bump when the output format changes (index cache key, R08 section 4.8). */
const INDEXER_VERSION = 3;
/** Read block size. */
const BLOCK_BYTES = 4 * 1024 * 1024;
/** Lines longer than this are counted and skipped (R08:548). */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** L2 chunk size in characters, about 80K tokens at 2.5 chars per token (R08:691). */
const DEFAULT_CHUNK_CHARS = 200000;
/** Human message cap in user-messages.md (R08 section 4.3). */
const USER_MESSAGE_CAP = 2000;
/** Caps of the digest (L1). */
const DIGEST_USER_CAP = 4000;
const DIGEST_ANSWER_CAP = 3000;
/** Tool result cut: head and tail (R08:179). */
const RESULT_HEAD = 350;
const RESULT_TAIL = 300;
/** Evidence sheet caps per turn. */
const EVIDENCE_EVENTS_MAX = 200;
const EVIDENCE_TEXT_CAP = 700;
/** Progress messages at most this often (in bytes read). */
const PROGRESS_EVERY_BYTES = 32 * 1024 * 1024;
/** A file larger than this must yield a human turn and assistant text. */
const HEALTH_MIN_BYTES = 100 * 1024;
/** Unreadable conversation lines above this share raise formatDrift. */
const DRIFT_BAD_SHARE = 0.1;
/** Newline byte. */
const NEWLINE = 10;

/** Claude record types that carry no conversation (skipped, but recognized). */
const CLAUDE_META_TYPES = new Set(['file-history-snapshot', 'file-history-delta', 'queue-operation', 'last-prompt', 'mode', 'agent-name', 'ai-title', 'custom-title', 'pr-link', 'progress', 'summary', 'system', 'atis-latch', 'cost-state', 'worktree-state', 'relocated', 'frame-link', 'bridge-session', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'history-suppression']);
/** Codex envelope types this indexer knows (R08 Appendix A). */
const CODEX_KNOWN = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata']);
/** Codex user texts that are injected context, not the person (R08:917). */
const CODEX_INJECTED_RE = /^\s*<(environment_context|recommended_plugins|heartbeat|user_instructions|turn_aborted|subagent_notification)/;

/**
 * Create an indexer bound to an output folder.
 *
 * @param {object} o - {provider, outDir, chunkChars}
 * @returns {object} {line(record, offset), badLine(), oversizeLine(offset, length), finish()}
 */
function createIndexer(o) {
  const provider = o.provider;
  const OUT = o.outDir;
  const CHUNK_CHARS = o.chunkChars || DEFAULT_CHUNK_CHARS;
  fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true });
  const redactions = {};
  const R = (s) => redact(String(s === null || s === undefined ? '' : s), redactions);

  const out = {};
  for (const f of ['timeline.md', 'digest.md', 'user-messages.md', 'decisions.md', 'checkpoints.md', 'errors.md', 'agent-reports.md', 'turns.jsonl']) {
    out[f] = fs.openSync(path.join(OUT, f), 'w');
  }
  const cmds = fs.openSync(path.join(OUT, 'commands.tsv'), 'w');
  fs.writeSync(cmds, 'turn\toffset\terror\tcommand\n');
  const w = (fd, text) => { fs.writeSync(fd, text); };
  w(out['user-messages.md'], '# Every message the user typed\n\nLong pastes are cut at 2,000 characters; the byte offset of the full record is given.\n');
  w(out['timeline.md'], '# Timeline: one line per user turn\n\n');
  w(out['digest.md'], '# Digest: per turn, the user message, tool counts, files written and the final answer\n');
  w(out['decisions.md'], '# Decisions: questions the previous session asked, and the answers\n');
  w(out['checkpoints.md'], "# Checkpoints: the previous session's own summaries of itself. Every line is a claim, unverified.\n");
  w(out['errors.md'], '# Failed tool calls\n\n');
  w(out['agent-reports.md'], "# Reports the previous session's subagents returned\n");

  const manifest = {
    indexerVersion: INDEXER_VERSION,
    provider,
    lines: 0, badLines: 0, oversizeLines: 0, recognized: 0,
    turns: 0, toolCalls: 0, toolErrors: 0, checkpoints: 0, images: 0, decisions: 0, agentReports: 0,
    assistantTexts: 0, humanChars: 0,
    firstTs: null, lastTs: null, models: {}, cwds: {}, gitBranches: {}, unknownTypes: {},
    lastCwd: null, lastPermissionMode: null, chunks: [], chunkChars: 0,
  };
  const files = new Map();
  const turnOffsets = [];
  let turnsBytes = 0;
  let turn = 0;
  let cur = null;
  let chunkBuf = '';
  let chunkIdx = 0;
  let chunkFirstTurn = 1;
  let lastTasks = null;
  const pendingAsk = new Map();
  const claudeTools = new Map();
  const codexCalls = new Map();

  const cap = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + ' [+' + (s.length - n) + ' chars]' : s; };
  const oneLine = (s, n) => cap(String(s || '').replace(/\s+/g, ' ').trim(), n);
  const clean = (s) => String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const tsMs = (ts) => { const t = Date.parse(ts); return Number.isFinite(t) ? t : null; };
  const stamp = (ts) => { if (!ts) return; if (!manifest.firstTs) manifest.firstTs = ts; manifest.lastTs = ts; };
  const touch = (p, kind) => {
    if (!p) return;
    const e = files.get(p) || { w: 0, r: 0, first: turn, last: turn };
    e[kind] += 1; e.last = turn; files.set(p, e);
  };

  /** Write the current L2 chunk when it is full (or at the end). */
  function flushChunk(force) {
    if (!chunkBuf) return;
    if (!force && chunkBuf.length < CHUNK_CHARS) return;
    chunkIdx += 1;
    const name = 'c' + String(chunkIdx).padStart(3, '0') + '.md';
    const text = '# Chunk ' + chunkIdx + ': turns ' + chunkFirstTurn + ' to ' + turn + '\n\n' + chunkBuf;
    fs.writeFileSync(path.join(OUT, 'chunks', name), text);
    manifest.chunks.push({ file: 'chunks/' + name, fromTurn: chunkFirstTurn, toTurn: turn, chars: text.length });
    manifest.chunkChars += text.length;
    chunkBuf = '';
    chunkFirstTurn = turn + 1;
  }

  /** Close the current turn: L0, L1, L2 and the evidence record. */
  function endTurn() {
    if (!cur) return;
    const errs = cur.tools.filter((t) => t.err).length;
    w(out['timeline.md'], 'T' + cur.n + ' ' + (cur.ts || '') + ' tools=' + cur.tools.length + ' err=' + errs + ' @' + cur.off + ' "' + oneLine(cur.user, 160) + '"\n');
    const kinds = {};
    for (const t of cur.tools) kinds[t.name] = (kinds[t.name] || 0) + 1;
    const toolSummary = Object.entries(kinds).map(([k, v]) => k + 'x' + v).join(', ');
    const finalText = cur.asst.length ? cur.asst[cur.asst.length - 1] : '';
    w(out['digest.md'], '\n## T' + cur.n + ' ' + (cur.ts || '') + ' @' + cur.off + '\n**User:** ' + cap(cur.user, DIGEST_USER_CAP) + '\n' +
      (toolSummary ? '**Tools:** ' + toolSummary + (errs ? ' (' + errs + ' errors)' : '') + '\n' : '') +
      (cur.touched.size ? '**Files:** ' + Array.from(cur.touched).slice(0, 25).join(', ') + '\n' : '') +
      (finalText ? '**Final answer:** ' + cap(finalText, DIGEST_ANSWER_CAP) + '\n' : ''));
    let l2 = '\n## T' + cur.n + ' ' + (cur.ts || '') + ' @' + cur.off + '\nUSER: ' + cur.user + '\n';
    for (const ev of cur.events) l2 += ev.line + '\n';
    chunkBuf += l2;
    const evidence = { turn: cur.n, ts: tsMs(cur.ts), user: cap(cur.user, DIGEST_USER_CAP), offset: cur.off, events: cur.events.slice(0, EVIDENCE_EVENTS_MAX).map((ev) => ({ kind: ev.kind, text: cap(ev.text, EVIDENCE_TEXT_CAP), ts: ev.ts })) };
    const line = JSON.stringify(evidence) + '\n';
    turnOffsets.push(turnsBytes);
    turnsBytes += Buffer.byteLength(line);
    w(out['turns.jsonl'], line);
    flushChunk(false);
    cur = null;
  }

  /**
   * Classify a user role text: only "human" opens a turn (R08:759).
   *
   * @param {string} text - Text.
   * @returns {string}
   */
  function userKind(text) {
    const t = text.trimStart();
    if (t.startsWith('<task-notification>')) return 'agent-report';
    if (t.startsWith('<command-name>') || t.startsWith('<local-command-stdout>') || t.startsWith('<command-message>')) return 'slash';
    if (t.startsWith('This session is being continued from a previous conversation')) return 'continuation';
    return 'human';
  }

  /**
   * Push an event on the current turn.
   *
   * @param {string} kind - assistant, tool, result or system.
   * @param {string} lineText - The L2 line.
   * @param {string} text - The evidence text.
   * @param {string|null} ts - Timestamp.
   */
  function event(kind, lineText, text, ts) {
    cur.events.push({ kind, line: lineText, text, ts: tsMs(ts) });
  }

  /** Open a turn at a human message, or record a non human user text. */
  function startTurn(rawText, ts, off) {
    const text = R(rawText);
    const kind = userKind(text);
    if (kind !== 'human') {
      ensureTurn(ts, off);
      if (kind === 'agent-report') {
        manifest.agentReports += 1;
        w(out['agent-reports.md'], '\n### During T' + turn + ' ' + (ts || '') + ' @' + off + '\n' + text + '\n');
        event('system', 'AGENT REPORT: ' + oneLine(text, 1500), oneLine(text, EVIDENCE_TEXT_CAP), ts);
      } else if (kind === 'slash') {
        event('system', 'SLASH: ' + oneLine(text, 300), oneLine(text, 300), ts);
      } else {
        event('system', 'CONTINUATION SUMMARY (' + text.length + ' chars, see checkpoints.md)', 'Continuation summary', ts);
        manifest.checkpoints += 1;
        w(out['checkpoints.md'], '\n## Continuation summary before T' + (turn + 1) + ' ' + (ts || '') + ' @' + off + "\n(The previous model's own summary. Unverified.)\n\n" + text + '\n');
      }
      return;
    }
    endTurn();
    turn += 1;
    manifest.turns = turn;
    manifest.humanChars += text.length;
    cur = { n: turn, ts, off, user: text, asst: [], tools: [], events: [], touched: new Set() };
    w(out['user-messages.md'], '\n### T' + turn + ' ' + (ts || '') + ' @' + off + '\n' + cap(text, USER_MESSAGE_CAP) + '\n');
  }
  function ensureTurn(ts, off) { if (!cur) startTurn('(no user message; continuation)', ts, off); }

  function addTool(name, summary, off, ts) {
    ensureTurn(ts, off);
    manifest.toolCalls += 1;
    const s = R(summary);
    const t = { name, summary: s, err: false, off };
    cur.tools.push(t);
    event('tool', 'TOOL ' + name + ': ' + oneLine(s, 300) + ' @' + off, name + ': ' + oneLine(s, 300), ts);
    return t;
  }

  function addResult(t, raw, isErr, off, ts) {
    if (!cur) return;
    const s = R(raw);
    if (t) t.err = !!isErr;
    if (isErr) {
      manifest.toolErrors += 1;
      w(out['errors.md'], '- T' + turn + ' @' + off + ' ' + (t ? t.name : '?') + ': ' + oneLine(s, 400) + '\n');
    }
    const body = s.length > RESULT_HEAD + RESULT_TAIL + 50 ? s.slice(0, RESULT_HEAD) + ' ... [' + s.length + ' chars] ... ' + s.slice(-RESULT_TAIL) : s;
    event('result', '  -> ' + (isErr ? 'ERROR ' : '') + oneLine(body, 700), (isErr ? 'Error: ' : '') + oneLine(body, EVIDENCE_TEXT_CAP), ts);
  }

  function addAssistant(text, ts, off) {
    ensureTurn(ts, off);
    const c = R(clean(text));
    if (!c) return;
    manifest.assistantTexts += 1;
    cur.asst.push(c);
    event('assistant', 'ASSISTANT: ' + c, c, ts);
  }

  // ── Claude records ────────────────────────────────────────────────────
  function claudeLine(r, off) {
    const ts = r.timestamp;
    stamp(ts);
    if (r.type === 'attachment') {
      const a = r.attachment || {};
      // The task list re-attached every turn is 60 percent of the largest
      // file (R08:59); only the newest is kept.
      if (a.type === 'task_reminder') lastTasks = { ts, off, turn, body: R(JSON.stringify(a.content || a.tasks || a).slice(0, 200000)) };
      manifest.recognized += 1;
      return;
    }
    if (r.type === 'permission-mode' && typeof r.permissionMode === 'string') manifest.lastPermissionMode = r.permissionMode;
    if (CLAUDE_META_TYPES.has(r.type) || r.type === 'permission-mode') { manifest.recognized += 1; return; }
    if (r.type !== 'user' && r.type !== 'assistant') {
      manifest.unknownTypes[String(r.type)] = (manifest.unknownTypes[String(r.type)] || 0) + 1;
      return;
    }
    manifest.recognized += 1;
    if (r.cwd) { manifest.cwds[r.cwd] = (manifest.cwds[r.cwd] || 0) + 1; manifest.lastCwd = r.cwd; }
    if (r.gitBranch) manifest.gitBranches[r.gitBranch] = (manifest.gitBranches[r.gitBranch] || 0) + 1;
    if (typeof r.permissionMode === 'string') manifest.lastPermissionMode = r.permissionMode;
    const m = r.message || {};
    if (r.type === 'assistant' && m.model) manifest.models[m.model] = (manifest.models[m.model] || 0) + 1;
    if (r.isCompactSummary) {
      manifest.checkpoints += 1;
      const c = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((b) => (b && b.text) || '').join('\n') : '');
      w(out['checkpoints.md'], '\n## Checkpoint ' + manifest.checkpoints + ' before T' + (turn + 1) + ' ' + (ts || '') + ' @' + off + "\n(The previous model's own summary. Unverified.)\n\n" + R(c) + '\n');
      return;
    }
    if (r.type === 'user') {
      const c = m.content;
      if (typeof c === 'string') { if (!r.isMeta) { const t = clean(c); if (t) startTurn(t, ts, off); } return; }
      if (!Array.isArray(c)) return;
      const texts = [];
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && !r.isMeta) texts.push(clean(b.text));
        else if (b.type === 'image') { manifest.images += 1; texts.push('[image]'); }
        else if (b.type === 'tool_result') {
          const t = claudeTools.get(b.tool_use_id);
          let body = b.content;
          if (Array.isArray(body)) body = body.map((x) => (x && x.type === 'text' ? x.text : (x && x.type === 'image' ? (manifest.images++, '[image]') : ''))).join('\n');
          addResult(t, typeof body === 'string' ? body : JSON.stringify(body || ''), b.is_error === true, off, ts);
          if (pendingAsk.has(b.tool_use_id)) {
            w(out['decisions.md'], '\n## T' + turn + ' ' + (ts || '') + ' @' + off + '\n' + pendingAsk.get(b.tool_use_id) + '\n**Answer:** ' + R(String(body)) + '\n');
            manifest.decisions += 1;
            pendingAsk.delete(b.tool_use_id);
          }
        }
      }
      const t = texts.filter(Boolean).join('\n');
      if (t && t !== '[image]') startTurn(t, ts, off);
      return;
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') addAssistant(b.text, ts, off);
        else if (b.type === 'tool_use') {
          const i = b.input || {};
          const summary = i.command || i.file_path || i.pattern || i.url || i.description || i.prompt || JSON.stringify(i).slice(0, 2000);
          const t = addTool(String(b.name || 'tool'), summary, off, ts);
          claudeTools.set(b.id, t);
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) { const fp = i.file_path || i.notebook_path; touch(fp, 'w'); if (fp) cur.touched.add(fp); }
          if (b.name === 'Read') touch(i.file_path, 'r');
          if (b.name === 'Bash' || b.name === 'PowerShell') fs.writeSync(cmds, turn + '\t' + off + '\t\t' + oneLine(R(i.command), 400) + '\n');
          if (b.name === 'AskUserQuestion') {
            const qs = (i.questions || []).map((q) => '- Q: ' + (q && q.question) + ' Options: ' + ((q && q.options) || []).map((x) => x && x.label).join(' | ')).join('\n');
            pendingAsk.set(b.id, R(qs || JSON.stringify(i)));
          }
        }
      }
    }
  }

  // ── Codex records ─────────────────────────────────────────────────────
  function codexLine(r, off) {
    const ts = r.timestamp;
    stamp(ts);
    if (CODEX_KNOWN.has(r.type)) manifest.recognized += 1;
    else manifest.unknownTypes[String(r.type)] = (manifest.unknownTypes[String(r.type)] || 0) + 1;
    const p = (r.payload && typeof r.payload === 'object') ? r.payload : {};
    if (r.type === 'session_meta') { if (p.cwd) { manifest.cwds[p.cwd] = (manifest.cwds[p.cwd] || 0) + 1; manifest.lastCwd = p.cwd; } return; }
    if (r.type === 'turn_context') {
      if (p.model) manifest.models[p.model] = (manifest.models[p.model] || 0) + 1;
      if (p.cwd) { manifest.cwds[p.cwd] = (manifest.cwds[p.cwd] || 0) + 1; manifest.lastCwd = p.cwd; }
      return;
    }
    if (r.type === 'compacted') {
      manifest.checkpoints += 1;
      w(out['checkpoints.md'], '\n## Checkpoint ' + manifest.checkpoints + ' before T' + (turn + 1) + ' ' + (ts || '') + ' @' + off + '\n(Codex compaction. The summary text is encrypted and not readable; earlier user messages were carried forward verbatim.)\n');
      return;
    }
    if (r.type === 'event_msg' && p.type === 'user_message') { const t = clean(p.message); if (t && !CODEX_INJECTED_RE.test(t)) startTurn(t, ts, off); return; }
    if (r.type === 'event_msg' && p.type === 'agent_message') { addAssistant(p.message, ts, off); return; }
    if (r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const parts = (p.content || []).map((b) => (b && (b.text || (b.type === 'input_image' ? '[image]' : ''))) || '');
      const human = parts.filter((t) => t && !CODEX_INJECTED_RE.test(t) && !/^# AGENTS\.md instructions/.test(t));
      const t = clean(human.join('\n'));
      if (t) startTurn(t, ts, off);
      return;
    }
    if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      addAssistant((p.content || []).map((b) => (b && b.text) || '').join('\n'), ts, off);
      return;
    }
    if (r.type === 'event_msg' && p.type === 'item_completed' && p.item) {
      const it = p.item;
      if (it.type === 'CommandExecution') {
        const cmd = Array.isArray(it.command) ? it.command.join(' ') : String(it.command || '');
        const bad = (it.exit_code !== undefined && it.exit_code !== null && it.exit_code !== 0) || (it.status && it.status !== 'completed');
        fs.writeSync(cmds, turn + '\t' + off + '\t' + (bad ? 'ERR' : '') + '\t' + oneLine(R(cmd), 400) + '\n');
        if (bad) {
          manifest.toolErrors += 1;
          w(out['errors.md'], '- T' + turn + ' @' + off + ' exec exit=' + it.exit_code + ': ' + oneLine(R(cmd), 200) + ' :: ' + oneLine(R(it.aggregated_output || it.stderr || ''), 300) + '\n');
        }
      } else if (it.type === 'FileChange' && it.changes && typeof it.changes === 'object') {
        ensureTurn(ts, off);
        for (const fp of Object.keys(it.changes)) { touch(fp, 'w'); cur.touched.add(fp); }
      }
      return;
    }
    if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call')) {
      const args = p.arguments || p.input || '';
      let summary = String(typeof args === 'string' ? args : JSON.stringify(args));
      try { const a = JSON.parse(summary); summary = Array.isArray(a.command) ? a.command.join(' ') : (a.command || a.cmd || a.path || summary); } catch (_) { /* keep text */ }
      const t = addTool(String(p.name || p.type), summary, off, ts);
      codexCalls.set(p.call_id, t);
      if (/shell|exec|command/i.test(p.name || '')) fs.writeSync(cmds, turn + '\t' + off + '\t\t' + oneLine(R(summary), 400) + '\n');
      const argText = String(typeof args === 'string' ? args : JSON.stringify(args));
      if ((p.name || '') === 'apply_patch' || /\*\*\* (Update|Add|Delete) File: /.test(argText)) {
        for (const mm of argText.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)/g)) { touch(mm[1].trim(), 'w'); cur.touched.add(mm[1].trim()); }
      }
      return;
    }
    if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const o2 = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      const m = /Exit code: (\d+)|"exit_code":\s*(\d+)/.exec(o2 || '');
      const code = m ? Number(m[1] || m[2]) : 0;
      addResult(codexCalls.get(p.call_id), o2, code !== 0, off, ts);
    }
  }

  const handle = provider === 'codex' ? codexLine : claudeLine; // gsd:provider-literal-allowed (mobile v2 migration indexer)

  return {
    /**
     * One parsed record.
     *
     * @param {object} record - JSON record.
     * @param {number} offset - Byte offset of its line.
     */
    line(record, offset) {
      manifest.lines += 1;
      if (!record || typeof record !== 'object') { manifest.badLines += 1; return; }
      handle(record, offset);
    },
    /** A line that is not JSON. */
    badLine() { manifest.lines += 1; manifest.badLines += 1; },
    /** A line over the size cap (counted, never parsed). */
    oversizeLine() { manifest.lines += 1; manifest.oversizeLines += 1; },
    /**
     * Close everything and write the remaining files.
     *
     * @param {number} bytes - Bytes read (the snapshot length).
     * @returns {object} manifest
     */
    finish(bytes) {
      endTurn();
      flushChunk(true);
      fs.writeFileSync(path.join(OUT, 'last-tasks.md'), lastTasks
        ? '# Newest task list the previous model kept (T' + lastTasks.turn + ', ' + lastTasks.ts + ', @' + lastTasks.off + ")\n(Its own view of what was open. Unverified.)\n\n" + lastTasks.body + '\n'
        : '# Newest task list the previous model kept\n\nNone was recorded.\n');
      const ftsv = ['path\twrites\treads\tfirstTurn\tlastTurn'];
      for (const [p, e] of Array.from(files.entries()).sort((a, b) => b[1].w - a[1].w || (a[0] < b[0] ? -1 : 1))) ftsv.push(R(p) + '\t' + e.w + '\t' + e.r + '\t' + e.first + '\t' + e.last);
      fs.writeFileSync(path.join(OUT, 'files.tsv'), ftsv.join('\n') + '\n');
      for (const fd of Object.values(out)) fs.closeSync(fd);
      fs.closeSync(cmds);
      fs.writeFileSync(path.join(OUT, 'turns-index.json'), JSON.stringify(turnOffsets));
      manifest.bytes = bytes;
      manifest.redactions = redactions;
      const conversation = manifest.lines - manifest.oversizeLines;
      manifest.coverage = manifest.lines ? Number(((manifest.recognized) / manifest.lines).toFixed(4)) : 1;
      manifest.formatDrift = (bytes > HEALTH_MIN_BYTES && (manifest.turns === 0 || manifest.assistantTexts === 0)) ||
        (conversation > 0 && manifest.badLines / conversation > DRIFT_BAD_SHARE);
      fs.writeFileSync(path.join(OUT, 'index-manifest.json'), JSON.stringify(manifest, null, 2));
      return manifest;
    },
    manifest,
  };
}

/**
 * Stream a transcript from byte 0 to `end` through an indexer, one line at
 * a time, never buffering a line beyond MAX_LINE_BYTES.
 *
 * @param {object} o - {provider, source, outDir, end, chunkChars, onProgress}
 * @returns {Promise<object>} manifest
 */
function runIndex(o) {
  return new Promise((resolve, reject) => {
    let idx;
    try { idx = createIndexer(o); } catch (err) { reject(err); return; }
    const end = o.end;
    const stream = fs.createReadStream(o.source, { start: 0, end: Math.max(0, end - 1), highWaterMark: BLOCK_BYTES });
    let offset = 0;
    let parts = [];
    let partBytes = 0;
    let lineStart = 0;
    let oversize = false;
    let lastProgress = 0;
    const emitLine = (buf) => {
      if (oversize) { idx.oversizeLine(lineStart, partBytes); return; }
      if (!buf.length) return;
      let rec;
      try { rec = JSON.parse(buf.toString('utf8')); } catch (_) { idx.badLine(); return; }
      idx.line(rec, lineStart);
    };
    if (end <= 0) { try { resolve(idx.finish(0)); } catch (err) { reject(err); } return; }
    stream.on('data', (chunk) => {
      try {
        let pos = 0;
        while (pos < chunk.length) {
          const nl = chunk.indexOf(NEWLINE, pos);
          const stop = nl === -1 ? chunk.length : nl;
          if (!oversize) {
            if (partBytes + (stop - pos) > MAX_LINE_BYTES) { oversize = true; parts = []; } else parts.push(chunk.subarray(pos, stop));
          }
          partBytes += stop - pos;
          if (nl === -1) break;
          emitLine(parts.length === 1 ? parts[0] : Buffer.concat(parts));
          parts = [];
          partBytes = 0;
          oversize = false;
          lineStart = offset + nl + 1;
          pos = nl + 1;
        }
        offset += chunk.length;
        if (o.onProgress && offset - lastProgress >= PROGRESS_EVERY_BYTES) {
          lastProgress = offset;
          o.onProgress({ bytes: offset, total: end, turns: idx.manifest.turns });
        }
      } catch (err) {
        stream.destroy(err);
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      try {
        if (partBytes > 0 || parts.length) emitLine(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        resolve(idx.finish(Math.min(offset, end)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Worker thread entry: run with workerData, report through parentPort.
let workerThreads = null;
try { workerThreads = require('worker_threads'); } catch (_) { workerThreads = null; }
if (workerThreads && !workerThreads.isMainThread && workerThreads.workerData && workerThreads.workerData.__myrlinIndexer) {
  const wd = workerThreads.workerData;
  runIndex({
    provider: wd.provider,
    source: wd.source,
    outDir: wd.outDir,
    end: wd.end,
    chunkChars: wd.chunkChars,
    onProgress: (p) => workerThreads.parentPort.postMessage(Object.assign({ type: 'progress' }, p)),
  }).then((manifest) => {
    workerThreads.parentPort.postMessage({ type: 'done', manifest });
  }).catch((err) => {
    workerThreads.parentPort.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  });
}

module.exports = { runIndex, createIndexer, INDEXER_VERSION, DEFAULT_CHUNK_CHARS, MAX_LINE_BYTES };
