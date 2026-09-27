/**
 * Claude Code transcript records to mobile v2 Messages (PROTOCOL.md 3.6).
 *
 * What: the Claude mapper the transcript reader pages with. fragment() says
 * what one JSONL record becomes (nothing, or a fragment of a message);
 * consecutive assistant lines with the same message.id join one Message
 * whose parts keep the block order; build() turns a group into a Message
 * with typed parts, a stable id (the uuid of its first line) and a cursor.
 * It also exports the helpers the turn service and prompt completion share
 * (human prompt detection, tool call parts, tool kinds and titles).
 *
 * Why: Claude writes one transcript line per content block (R04:131) and
 * dozens of record types that are not conversation (R02:290, R08 1.3). The
 * format is internal to Claude Code and drifts, so every unknown type is
 * tolerated and simply produces no message.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const { truncateText, truncateToolInput, TEXT_TRUNC_REST } = require('./common');

/** The interrupt marker text (PROTOCOL.md 6.2 rule C3). */
const INTERRUPT_MARKER = '[Request interrupted by user';

/** Tool name to toolCall.kind (PROTOCOL.md 3.6). */
const TOOL_KINDS = Object.freeze({
  Bash: 'shell', PowerShell: 'shell', shell: 'shell', exec_command: 'shell', local_shell: 'shell', local_shell_call: 'shell',
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', apply_patch: 'edit',
  Write: 'write',
  Grep: 'search', Glob: 'search', tool_search_call: 'search',
  WebFetch: 'web', WebSearch: 'web', web_search_call: 'web',
  Task: 'task', Agent: 'task', 'collaboration.spawn_agent': 'task',
  AskUserQuestion: 'question', request_user_input: 'question',
  ExitPlanMode: 'plan',
  TodoWrite: 'todo',
});

/**
 * @param {string} name
 * @returns {string}
 */
function toolKind(name) {
  if (typeof name !== 'string') return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_KINDS[name] || 'other';
}

/**
 * First line of a string, cut to n characters.
 * @param {*} s
 * @param {number} n
 * @returns {string}
 */
function firstLine(s, n) {
  const t = String(s == null ? '' : s).split(/\r?\n/)[0].trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Count lines of a text block (0 for empty).
 * @param {*} s
 * @returns {number}
 */
function lineCount(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  return s.split(/\r?\n/).length;
}

/**
 * Detail, title, file path and diff stat of a tool call.
 * @param {string} name
 * @param {object} input
 * @returns {{kind: string, title: string, detail: (string|null), filePath: (string|null), diffStat: (object|null)}}
 */
function describeTool(name, input) {
  const kind = toolKind(name);
  const inp = input && typeof input === 'object' ? input : {};
  const filePath = typeof inp.file_path === 'string' ? inp.file_path : (typeof inp.notebook_path === 'string' ? inp.notebook_path : (typeof inp.path === 'string' ? inp.path : null));
  const base = filePath ? path.basename(filePath.replace(/\\/g, '/')) : null;
  let command = null;
  if (typeof inp.command === 'string') command = inp.command;
  else if (Array.isArray(inp.command)) command = inp.command.join(' ');
  else if (inp.action && Array.isArray(inp.action.command)) command = inp.action.command.join(' ');
  let detail = null;
  let title = 'Used ' + (name || 'a tool');
  let diffStat = null;
  switch (kind) {
    case 'shell':
      detail = command;
      title = 'Ran ' + firstLine(command || name, 60);
      break;
    case 'read':
      detail = filePath;
      title = 'Read ' + (base || 'a file');
      break;
    case 'edit': {
      detail = filePath;
      title = 'Edited ' + (base || 'files');
      if (name === 'Edit') diffStat = { added: lineCount(inp.new_string), removed: lineCount(inp.old_string), files: 1 };
      else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
        diffStat = { added: 0, removed: 0, files: 1 };
        for (const e of inp.edits) { diffStat.added += lineCount(e && e.new_string); diffStat.removed += lineCount(e && e.old_string); }
      } else if (name === 'apply_patch') {
        const patch = typeof inp.input === 'string' ? inp.input : (typeof inp.patch === 'string' ? inp.patch : '');
        diffStat = { added: 0, removed: 0, files: 0 };
        for (const l of patch.split(/\r?\n/)) {
          if (/^\*\*\* (Update|Add|Delete) File:/.test(l)) diffStat.files += 1;
          else if (l.startsWith('+') && !l.startsWith('+++')) diffStat.added += 1;
          else if (l.startsWith('-') && !l.startsWith('---')) diffStat.removed += 1;
        }
        if (!detail) {
          const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch);
          if (m) { detail = m[1].trim(); title = 'Edited ' + path.basename(detail.replace(/\\/g, '/')); }
        }
      }
      break;
    }
    case 'write':
      detail = filePath;
      title = 'Wrote ' + (base || 'a file');
      diffStat = { added: lineCount(inp.content), removed: 0, files: 1 };
      break;
    case 'search':
      detail = typeof inp.pattern === 'string' ? inp.pattern : (typeof inp.query === 'string' ? inp.query : null);
      title = 'Searched ' + firstLine(detail || '', 60);
      break;
    case 'web':
      detail = typeof inp.url === 'string' ? inp.url : (typeof inp.query === 'string' ? inp.query : (inp.action && typeof inp.action.query === 'string' ? inp.action.query : null));
      title = (typeof inp.url === 'string' ? 'Fetched ' : 'Searched the web for ') + firstLine(detail || '', 60);
      break;
    case 'task':
      detail = typeof inp.description === 'string' ? inp.description : (typeof inp.prompt === 'string' ? firstLine(inp.prompt, 120) : null);
      title = 'Ran a subagent';
      break;
    case 'question':
      title = 'Asked a question';
      detail = Array.isArray(inp.questions) && inp.questions[0] && typeof inp.questions[0].question === 'string' ? inp.questions[0].question : null;
      break;
    case 'plan':
      title = 'Proposed a plan';
      break;
    case 'todo':
      title = 'Updated the task list';
      break;
    default:
      title = 'Used ' + (name || 'a tool');
  }
  return { kind, title, detail: detail === null ? null : String(detail), filePath, diffStat };
}

/**
 * A toolCall part (PROTOCOL.md 3.6).
 * @param {string} id
 * @param {string} name
 * @param {object} input
 * @returns {object}
 */
function toolCallPart(id, name, input) {
  const d = describeTool(name, input);
  const cut = input === undefined || input === null ? { value: null, truncated: false } : truncateToolInput(input);
  return {
    type: 'toolCall',
    toolCallId: String(id || ''),
    name: String(name || 'tool'),
    kind: d.kind,
    title: d.title,
    detail: d.detail,
    input: cut.value,
    inputTruncated: cut.truncated,
    filePath: d.filePath,
    diffStat: d.diffStat,
  };
}

/**
 * Plain text of Claude message content (string or blocks).
 * @param {*} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * Is this record a human prompt (PROTOCOL.md 6.2 rule C1)?
 * @param {object} r
 * @returns {boolean}
 */
function isHumanPrompt(r) {
  if (!r || r.type !== 'user' || r.isMeta || r.isCompactSummary || !r.message) return false;
  const c = r.message.content;
  if (typeof c === 'string') return c.length > 0 && !c.startsWith(INTERRUPT_MARKER);
  if (!Array.isArray(c) || c.length === 0) return false;
  if (c.every((b) => b && b.type === 'tool_result')) return false;
  const text = contentText(c);
  if (text.startsWith(INTERRUPT_MARKER)) return false;
  return c.some((b) => b && (b.type === 'text' || b.type === 'image'));
}

/**
 * Is this record the interrupt marker (rule C3)?
 * @param {object} r
 * @returns {boolean}
 */
function isInterruptMarker(r) {
  if (!r || r.type !== 'user' || !r.message) return false;
  return contentText(r.message.content).startsWith(INTERRUPT_MARKER);
}

/**
 * Duration words for a turn end ("Worked for 2m 14s").
 * @param {number} ms
 * @returns {string}
 */
function workedFor(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return 'Worked for ' + h + 'h ' + m + 'm';
  if (m > 0) return 'Worked for ' + m + 'm ' + sec + 's';
  return 'Worked for ' + sec + 's';
}

/**
 * Timestamp of a record in ms.
 * @param {object} r
 * @returns {number}
 */
function tsOf(r) {
  const t = r && r.timestamp ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Bytes in words ("9.9 MB").
 * @param {number} n
 * @returns {string}
 */
function bytesWords(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' bytes';
}

/**
 * Tool result text of a tool_result block.
 * @param {object} b
 * @returns {string}
 */
function toolResultText(b) {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
  return '';
}

/**
 * Create the Claude mapper.
 * @returns {object}
 */
function createClaudeMapper() {
  return {
    provider: 'claude',
    format: 'claudeJsonl',

    /**
     * What one record contributes to the conversation.
     * @param {object|null} r
     * @param {{offset: number, length: number}} line
     * @param {boolean} oversize
     * @returns {object|null}
     */
    fragment(r, line, oversize) {
      if (oversize) return { offset: line.offset, key: null, kind: 'oversize', bytes: line.length, record: null };
      if (!r || typeof r.type !== 'string') return null;
      if (r.type === 'assistant' && r.message) {
        if (r.isApiErrorMessage) return { offset: line.offset, key: null, kind: 'apiError', record: r };
        const mid = r.message.id || r.requestId || null;
        return { offset: line.offset, key: mid ? 'a:' + mid : null, kind: 'assistant', record: r };
      }
      if (r.type === 'user' && r.message) {
        if (isInterruptMarker(r)) return { offset: line.offset, key: null, kind: 'interrupted', record: r };
        if (r.isMeta || r.isCompactSummary) return null;
        const c = r.message.content;
        if (Array.isArray(c) && c.length && c.every((b) => b && b.type === 'tool_result')) {
          return { offset: line.offset, key: null, kind: 'tool', record: r };
        }
        if (isHumanPrompt(r)) return { offset: line.offset, key: null, kind: 'user', record: r };
        return null;
      }
      if (r.type === 'system') {
        if (r.subtype === 'turn_duration') return { offset: line.offset, key: null, kind: 'turnEnd', record: r };
        if (r.subtype === 'compact_boundary') return { offset: line.offset, key: null, kind: 'compacted', record: r };
      }
      return null;
    },

    /**
     * Build one Message from a group of fragments.
     * @param {Array} frags
     * @param {object} m - {sessionId, cursor, full, truncateAt, originFor, contentBase}
     * @returns {object|null}
     */
    build(frags, m) {
      const first = frags[0];
      const r = first.record;
      const max = m.full ? Infinity : (m.truncateAt || TEXT_TRUNC_REST);
      const cut = (s) => (max === Infinity ? { text: s || '', truncated: false, fullLength: (s || '').length } : truncateText(s || '', max));
      const id = (r && typeof r.uuid === 'string' && r.uuid) ? r.uuid : 'o' + first.offset;
      const base = {
        id,
        sessionId: m.sessionId,
        turnId: null,
        role: 'system',
        ts: r ? tsOf(r) : 0,
        model: null,
        status: 'final',
        origin: { kind: 'provider', deviceId: null, clientMessageId: null },
        parts: [],
        attachments: [],
        usage: null,
        cursor: m.cursor,
      };
      const sys = (subtype, text, durationMs) => { base.parts = [{ type: 'system', subtype, text, durationMs: durationMs === undefined ? null : durationMs }]; return base; };
      switch (first.kind) {
        case 'oversize':
          return sys('other', 'A record of ' + bytesWords(first.bytes) + ' was not loaded.');
        case 'apiError':
          return sys('apiError', firstLine(contentText(r.message.content) || 'The API answered with an error.', 400));
        case 'interrupted':
          return sys('interrupted', 'Interrupted');
        case 'turnEnd':
          return sys('turnEnd', workedFor(r.durationMs), Number.isFinite(r.durationMs) ? r.durationMs : null);
        case 'compacted':
          return sys('compacted', 'Conversation compacted');
        case 'tool': {
          base.role = 'tool';
          for (const b of r.message.content) {
            const t = cut(toolResultText(b));
            const ex = r.toolUseResult && typeof r.toolUseResult === 'object' && Number.isInteger(r.toolUseResult.exitCode) ? r.toolUseResult.exitCode : null;
            base.parts.push({ type: 'toolResult', toolCallId: String(b.tool_use_id || ''), status: b.is_error ? 'error' : 'ok', text: t.text, truncated: t.truncated, fullLength: t.fullLength, exitCode: ex, durationMs: null });
          }
          return base;
        }
        case 'user': {
          base.role = 'user';
          base.turnId = 't_' + id;
          base.origin = (typeof m.originFor === 'function' ? m.originFor(r, id) : null) || { kind: 'unknown', deviceId: null, clientMessageId: null };
          const c = r.message.content;
          const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : c;
          blocks.forEach((b, i) => {
            if (!b) return;
            if (b.type === 'text') {
              const t = cut(b.text);
              base.parts.push({ type: 'text', text: t.text, format: 'plain', truncated: t.truncated, fullLength: t.fullLength });
            } else if (b.type === 'image' && b.source) {
              const data = typeof b.source.data === 'string' ? b.source.data : '';
              base.parts.push({
                type: 'image',
                mediaType: b.source.media_type || null,
                width: null,
                height: null,
                byteSize: data ? Math.floor(data.length * 3 / 4) : null,
                uploadId: null,
                contentPath: '/sessions/' + m.sessionId + '/messages/' + id + '/parts/' + base.parts.length + '/content',
              });
            }
            void i;
          });
          if (Array.isArray(m.attachmentsFor ? m.attachmentsFor(id) : null)) base.attachments = m.attachmentsFor(id);
          return base;
        }
        case 'assistant': {
          base.role = 'assistant';
          let prevTs = null;
          for (const f of frags) {
            const rec = f.record;
            const msg = rec.message || {};
            if (msg.model) base.model = msg.model;
            if (msg.usage) {
              const u = msg.usage;
              base.usage = {
                inputTokens: Number.isFinite(u.input_tokens) ? u.input_tokens : null,
                outputTokens: Number.isFinite(u.output_tokens) ? u.output_tokens : null,
                cacheReadTokens: Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : null,
                cacheCreationTokens: Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : null,
              };
            }
            const blocks = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
            for (const b of blocks) {
              if (!b) continue;
              if (b.type === 'text') {
                const t = cut(b.text);
                base.parts.push({ type: 'text', text: t.text, format: 'markdown', truncated: t.truncated, fullLength: t.fullLength });
              } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
                const raw = typeof b.thinking === 'string' ? b.thinking : '';
                const t = cut(raw);
                const ts = tsOf(rec);
                base.parts.push({ type: 'thinking', text: raw ? t.text : null, redacted: !raw, durationMs: prevTs && ts ? Math.max(0, ts - prevTs) : null, truncated: raw ? t.truncated : false, fullLength: raw ? t.fullLength : 0 });
              } else if (b.type === 'tool_use') {
                const tc = toolCallPart(b.id, b.name, b.input);
                if (m.full) { tc.input = b.input === undefined ? null : b.input; tc.inputTruncated = false; }
                base.parts.push(tc);
              }
            }
            prevTs = tsOf(rec) || prevTs;
          }
          return base;
        }
        default:
          return null;
      }
    },

    /**
     * For the leading turn look back: a turn id when the record opens a turn,
     * false when it closes one, null otherwise.
     * @param {object} r
     * @returns {string|false|null}
     */
    turnIdOf(r) {
      if (isHumanPrompt(r) && r.uuid) return 't_' + r.uuid;
      if (r && r.type === 'system' && r.subtype === 'turn_duration') return false;
      if (isInterruptMarker(r)) return false;
      return null;
    },

    /**
     * @param {object} r
     * @param {string} id
     * @returns {boolean}
     */
    idMatches(r, id) {
      return !!r && r.uuid === id;
    },
  };
}

module.exports = {
  createClaudeMapper,
  isHumanPrompt,
  isInterruptMarker,
  contentText,
  toolCallPart,
  toolKind,
  describeTool,
  workedFor,
  firstLine,
  tsOf,
  INTERRUPT_MARKER,
};
