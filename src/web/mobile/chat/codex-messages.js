/**
 * Codex rollout records to mobile v2 Messages (PROTOCOL.md 3.6).
 *
 * What: the Codex mapper for the transcript reader. Each response_item line
 * is one message (user and assistant text, redacted reasoning, tool calls,
 * tool outputs); event_msg lines produce system messages only for errors,
 * task_complete (turn end) and turn_aborted (interrupted); compacted records
 * say the conversation was compacted. Ids are "o" plus the byte offset of
 * the line, which never changes once written.
 *
 * Why: rollouts moved between shapes month to month (R08 1.3); a tolerant
 * mapper that ignores unknown records keeps history readable across drift.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const { truncateText, TEXT_TRUNC_REST } = require('./common');
const { toolCallPart, workedFor, firstLine, tsOf } = require('./claude-messages');

/** Injected context blocks Codex stores as user messages; they are not human turns. */
const INJECTED_USER_RE = /^\s*<(environment_context|user_instructions|recommended_plugins|permissions[^>]*|INSTRUCTIONS|user_shell_command|turn_aborted)\b/;

/**
 * Text of a Codex message content array.
 * @param {Array} content
 * @param {string} kind - 'input' or 'output'
 * @returns {string}
 */
function codexText(content, kind) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === kind + '_text' || c.type === 'text') && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Parse a function_call arguments string into an object.
 * @param {*} args
 * @returns {object|null}
 */
function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string') return null;
  try { return JSON.parse(args); } catch (_) { return { raw: args }; }
}

/**
 * Output text of a Codex tool output payload.
 * @param {*} out
 * @returns {{text: string, ok: boolean, exitCode: (number|null)}}
 */
function outputText(out) {
  if (typeof out === 'string') {
    try {
      const o = JSON.parse(out);
      if (o && typeof o === 'object' && typeof o.output === 'string') {
        const code = o.metadata && Number.isInteger(o.metadata.exit_code) ? o.metadata.exit_code : null;
        return { text: o.output, ok: code === null || code === 0, exitCode: code };
      }
    } catch (_) { /* plain text */ }
    return { text: out, ok: true, exitCode: null };
  }
  if (out && typeof out === 'object') {
    const text = typeof out.content === 'string' ? out.content : JSON.stringify(out);
    return { text, ok: out.success !== false, exitCode: null };
  }
  return { text: '', ok: true, exitCode: null };
}

/**
 * Create the Codex mapper.
 * @returns {object}
 */
function createCodexMapper() {
  return {
    provider: 'codex',
    format: 'codexRollout',

    /**
     * @param {object|null} r
     * @param {{offset: number, length: number}} line
     * @param {boolean} oversize
     * @returns {object|null}
     */
    fragment(r, line, oversize) {
      if (oversize) return { offset: line.offset, key: null, kind: 'oversize', bytes: line.length, record: null };
      if (!r || typeof r.type !== 'string') return null;
      const p = r.payload || {};
      if (r.type === 'response_item') {
        if (p.type === 'message') {
          if (p.role === 'user') {
            const text = codexText(p.content, 'input');
            const hasImage = Array.isArray(p.content) && p.content.some((c) => c && c.type === 'input_image');
            if (!hasImage && (!text || INJECTED_USER_RE.test(text))) return null;
            return { offset: line.offset, key: null, kind: 'user', record: r };
          }
          if (p.role === 'assistant') return { offset: line.offset, key: null, kind: 'assistant', record: r };
          return null;
        }
        if (p.type === 'agent_message') return { offset: line.offset, key: null, kind: 'assistant', record: r };
        if (p.type === 'reasoning') return { offset: line.offset, key: null, kind: 'reasoning', record: r };
        if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call'].includes(p.type)) {
          return { offset: line.offset, key: null, kind: 'toolCall', record: r };
        }
        if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_call_output'].includes(p.type)) {
          return { offset: line.offset, key: null, kind: 'toolOutput', record: r };
        }
        return null;
      }
      if (r.type === 'event_msg') {
        if (p.type === 'error') return { offset: line.offset, key: null, kind: 'apiError', record: r };
        if (p.type === 'task_complete') return { offset: line.offset, key: null, kind: 'turnEnd', record: r };
        if (p.type === 'turn_aborted') return { offset: line.offset, key: null, kind: 'interrupted', record: r };
        return null;
      }
      if (r.type === 'compacted') return { offset: line.offset, key: null, kind: 'compacted', record: r };
      return null;
    },

    /**
     * @param {Array} frags
     * @param {object} m
     * @returns {object|null}
     */
    build(frags, m) {
      const f = frags[0];
      const r = f.record;
      const p = (r && r.payload) || {};
      const max = m.full ? Infinity : (m.truncateAt || TEXT_TRUNC_REST);
      const cut = (s) => (max === Infinity ? { text: s || '', truncated: false, fullLength: (s || '').length } : truncateText(s || '', max));
      const id = 'o' + f.offset;
      const msg = {
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
      const sys = (subtype, text, durationMs) => { msg.parts = [{ type: 'system', subtype, text, durationMs: durationMs === undefined ? null : durationMs }]; return msg; };
      switch (f.kind) {
        case 'oversize':
          return sys('other', 'A record of ' + (f.bytes / (1024 * 1024)).toFixed(1) + ' MB was not loaded.');
        case 'apiError':
          return sys('apiError', firstLine(p.message || 'Codex reported an error.', 400));
        case 'turnEnd':
          return sys('turnEnd', workedFor(p.duration_ms), Number.isFinite(p.duration_ms) ? p.duration_ms : null);
        case 'interrupted':
          return sys('interrupted', 'Interrupted');
        case 'compacted':
          return sys('compacted', 'Conversation compacted');
        case 'user': {
          msg.role = 'user';
          msg.origin = (typeof m.originFor === 'function' ? m.originFor(r, id) : null) || { kind: 'unknown', deviceId: null, clientMessageId: null };
          const content = Array.isArray(p.content) ? p.content : [];
          for (const c of content) {
            if (!c) continue;
            if ((c.type === 'input_text' || c.type === 'text') && typeof c.text === 'string') {
              if (INJECTED_USER_RE.test(c.text)) continue;
              const t = cut(c.text);
              msg.parts.push({ type: 'text', text: t.text, format: 'plain', truncated: t.truncated, fullLength: t.fullLength });
            } else if (c.type === 'input_image') {
              msg.parts.push({ type: 'image', mediaType: null, width: null, height: null, byteSize: null, uploadId: null, contentPath: '/sessions/' + m.sessionId + '/messages/' + id + '/parts/' + msg.parts.length + '/content' });
            }
          }
          return msg;
        }
        case 'assistant': {
          msg.role = 'assistant';
          const t = cut(p.type === 'agent_message' ? (p.message || '') : codexText(p.content, 'output'));
          msg.parts.push({ type: 'text', text: t.text, format: 'markdown', truncated: t.truncated, fullLength: t.fullLength });
          return msg;
        }
        case 'reasoning': {
          msg.role = 'assistant';
          const summary = Array.isArray(p.summary) ? p.summary.map((s) => (s && typeof s.text === 'string' ? s.text : '')).filter(Boolean).join('\n') : '';
          const t = cut(summary);
          msg.parts.push({ type: 'thinking', text: summary ? t.text : null, redacted: !summary, durationMs: null, truncated: summary ? t.truncated : false, fullLength: summary ? t.fullLength : 0 });
          return msg;
        }
        case 'toolCall': {
          msg.role = 'assistant';
          let name = p.name || p.type;
          let input = null;
          if (p.type === 'function_call') input = parseArgs(p.arguments);
          else if (p.type === 'custom_tool_call') input = { input: p.input };
          else if (p.type === 'local_shell_call') { name = 'local_shell'; input = { command: p.action && Array.isArray(p.action.command) ? p.action.command.join(' ') : null }; }
          else if (p.type === 'web_search_call') { name = 'web_search_call'; input = { query: p.action && p.action.query ? p.action.query : null }; }
          else if (p.type === 'tool_search_call') { name = 'tool_search_call'; input = p.arguments ? parseArgs(p.arguments) : null; }
          if (name === 'shell' && input && Array.isArray(input.command)) input = Object.assign({}, input, { command: input.command.join(' ') });
          msg.parts.push(toolCallPart(p.call_id || p.id || id, name, input));
          return msg;
        }
        case 'toolOutput': {
          msg.role = 'tool';
          const o = outputText(p.output);
          const t = cut(o.text);
          msg.parts.push({ type: 'toolResult', toolCallId: String(p.call_id || ''), status: o.ok ? 'ok' : 'error', text: t.text, truncated: t.truncated, fullLength: t.fullLength, exitCode: o.exitCode, durationMs: null });
          return msg;
        }
        default:
          return null;
      }
    },

    /**
     * @param {object} r
     * @returns {string|false|null}
     */
    turnIdOf(r) {
      const p = r && r.payload;
      if (r && r.type === 'event_msg' && p) {
        if (p.type === 'task_started' && p.turn_id) return 't_' + p.turn_id;
        if (p.type === 'task_complete' || p.type === 'turn_aborted') return false;
      }
      return null;
    },

    idMatches() { return false; },
  };
}

module.exports = { createCodexMapper, codexText, INJECTED_USER_RE };
