/**
 * Claude parse helpers.
 *
 * extractCustomTitle and extractSessionName are MOVED VERBATIM from
 * src/web/server.js (formerly lines 7016-7083) in Plan 14-03 (ABST-03).
 * No logic change.
 *
 * parseTranscript is a NEW minimum-viable implementation introduced in
 * Plan 14-03 to satisfy the Provider contract surface (ABST-02). No
 * Phase 14 route consumes parseTranscript yet; Phase 15 will rewrite
 * /api/transcript through it. The body returns [] on missing/empty/
 * malformed JSONL and never throws on bad input (per Provider contract).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/claude/parse
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * The literal a transcript line must contain before it can carry a rename.
 * Named because two readers (the synchronous one and the asynchronous one
 * the discovery walk uses) and one buffer pre-filter all key off it, and a
 * silent drift between those three would turn renames into null titles.
 */
const CUSTOM_TITLE_MARKER = '"custom-title"';

/**
 * How many bytes of the END of a transcript the custom-title reader looks at.
 * A rename is appended, so the tail is where it lives; the cap is what stops
 * a multi-hundred-megabyte transcript from being read in full.
 */
const CUSTOM_TITLE_TAIL_BYTES = 131072;

/**
 * How many bytes of the START of a transcript the fallback name reader looks
 * at. The first meaningful message is the name, so the head is enough.
 */
const SESSION_NAME_HEAD_BYTES = 10 * 1024;

/**
 * Cheap byte-level pre-filter for the custom-title scan.
 *
 * The marker is pure ASCII, and UTF-8 never encodes a non-ASCII codepoint
 * using ASCII bytes, so a byte search over the window is EXACTLY equivalent
 * to a substring search over the decoded window. When it misses we can skip
 * the decode and the newline split entirely, which is the common case: a
 * transcript that was never renamed has no marker anywhere in its tail.
 *
 * Measured on the real corpus (182 transcripts, zero of them renamed) this
 * is the difference between decoding 16MB of tail on every discovery pass
 * and decoding none of it.
 *
 * @param {Buffer} buf - The raw window read from disk.
 * @param {number} [length] - Valid byte count in buf, when it is shorter
 *   than the allocation. Defaults to the whole buffer.
 * @returns {boolean} True when the window MIGHT contain a custom title.
 */
function windowMayContainCustomTitle(buf, length) {
  if (!buf || buf.length === 0) return false;
  const view = (typeof length === 'number' && length < buf.length) ? buf.subarray(0, length) : buf;
  return view.indexOf(CUSTOM_TITLE_MARKER, 0, 'utf8') !== -1;
}

/**
 * Pure parser for the custom-title scan: given the decoded tail window,
 * return the most recent rename or null.
 *
 * Extracted from extractCustomTitle so the synchronous reader, the
 * asynchronous reader and any future reader share ONE parse. Scans from the
 * end so the LAST rename wins, which is what "renamed twice" means.
 *
 * @param {string} text - Decoded tail window of a transcript.
 * @returns {string|null} The custom title, or null when there is none.
 */
function parseCustomTitleFromWindow(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(CUSTOM_TITLE_MARKER)) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.customTitle) return obj.customTitle;
      } catch (_) {}
    }
  }
  return null;
}

/**
 * Pure parser for the fallback name scan: given the decoded head window,
 * return a human-readable name derived from the first meaningful message,
 * or the session id when nothing qualifies.
 *
 * Extracted from extractSessionName; body unchanged.
 *
 * @param {string} text - Decoded head window of a transcript.
 * @param {string} sessionId - Fallback returned when no message qualifies.
 * @returns {string} A human-readable session name, or sessionId.
 */
function parseSessionNameFromWindow(text, sessionId) {
  const lines = String(text || '').split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const inner = entry.message || entry;
      const role = entry.type || inner.role;
      if (role !== 'user' && role !== 'human' && role !== 'assistant') continue;

      const c = inner.content;
      let text2 = '';
      if (typeof c === 'string') {
        text2 = c;
      } else if (Array.isArray(c)) {
        const textBlocks = c.filter(b => b.type === 'text' && b.text);
        text2 = textBlocks.map(b => b.text).join(' ');
      }
      // Skip system-generated and very short messages
      if (!text2 || text2.length < 5) continue;
      if (text2.startsWith('<') && text2.includes('system-reminder')) continue;

      // Clean up and truncate to 50 chars
      text2 = text2.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (text2.length > 50) {
        text2 = text2.substring(0, 50).replace(/\s+\S*$/, '') + '...';
      }
      return text2;
    } catch (_) {
      // Skip unparseable lines
    }
  }
  return sessionId;
}

/**
 * Extract a session name from the first user or assistant message content
 * in a JSONL file (first 50 chars), or fall back to the session UUID.
 * @param {string} filePath - Path to the .jsonl file
 * @param {string} sessionId - Fallback UUID
 * @returns {string} A human-readable session name
 */
function extractCustomTitle(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const tailSize = Math.min(CUSTOM_TITLE_TAIL_BYTES, size);
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, size - tailSize);
      // Byte pre-filter before the decode. Equivalent result, no decode on a
      // window that cannot possibly hold a rename. See windowMayContainCustomTitle.
      if (!windowMayContainCustomTitle(buf)) return null;
      return parseCustomTitleFromWindow(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}
  return null;
}

/**
 * Asynchronous twin of extractCustomTitle.
 *
 * Same window, same pre-filter, same parse; the reads go to the libuv thread
 * pool instead of blocking the main thread. The discovery walk uses this one
 * so a slow or cold-cache transcript stalls a worker thread rather than the
 * event loop. The synchronous twin above is untouched and still serves every
 * caller that is not on a request path (search, server-side helpers).
 *
 * @param {string} jsonlPath - Path to the .jsonl file.
 * @returns {Promise<string|null>} The custom title, or null.
 */
async function extractCustomTitleAsync(jsonlPath) {
  let handle = null;
  try {
    handle = await fs.promises.open(jsonlPath, 'r');
    const size = (await handle.stat()).size;
    const tailSize = Math.min(CUSTOM_TITLE_TAIL_BYTES, size);
    if (tailSize <= 0) return null;
    const buf = Buffer.alloc(tailSize);
    const { bytesRead } = await handle.read(buf, 0, tailSize, size - tailSize);
    if (!windowMayContainCustomTitle(buf, bytesRead)) return null;
    return parseCustomTitleFromWindow(buf.toString('utf8'));
  } catch (_) {
    return null;
  } finally {
    if (handle) { try { await handle.close(); } catch (_) {} }
  }
}

function extractSessionName(filePath, sessionId) {
  try {
    // Read just the first 10KB to find the first meaningful message
    const fd = fs.openSync(filePath, 'r');
    // The close moved into a finally: on the success path this is the same
    // ordering as before (the parse is pure and does not need the fd), and on
    // a read failure the descriptor is now released instead of leaked.
    try {
      const headSize = Math.min(SESSION_NAME_HEAD_BYTES, fs.fstatSync(fd).size);
      const buf = Buffer.alloc(headSize);
      fs.readSync(fd, buf, 0, headSize, 0);
      return parseSessionNameFromWindow(buf.toString('utf-8'), sessionId);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    // Fall through to UUID
  }
  return sessionId;
}

/**
 * Asynchronous twin of extractSessionName. Same head window, same parse,
 * pool-threaded reads. See extractCustomTitleAsync for the rationale.
 *
 * @param {string} filePath - Path to the .jsonl file.
 * @param {string} sessionId - Fallback returned when nothing qualifies.
 * @returns {Promise<string>} A human-readable session name, or sessionId.
 */
async function extractSessionNameAsync(filePath, sessionId) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const headSize = Math.min(SESSION_NAME_HEAD_BYTES, (await handle.stat()).size);
    if (headSize <= 0) return sessionId;
    const buf = Buffer.alloc(headSize);
    const { bytesRead } = await handle.read(buf, 0, headSize, 0);
    return parseSessionNameFromWindow(buf.toString('utf-8', 0, bytesRead), sessionId);
  } catch (_) {
    return sessionId;
  } finally {
    if (handle) { try { await handle.close(); } catch (_) {} }
  }
}

/**
 * Load and normalize a Claude transcript by session UUID.
 * Returns ProviderMessage[]: [{role, text, timestamp, model}].
 * Returns [] for missing/empty/malformed JSONL. Never throws on bad
 * input per Provider contract; only catastrophic IO errors surface.
 *
 * STATUS: minimum-viable implementation introduced in Plan 14-03.
 * No Phase 14 route consumes this yet; the function exists to satisfy
 * the Provider interface contract surface (ABST-02) so Codex (Phase 17)
 * has a shape-compatible reference implementation. Phase 15 will route
 * /api/transcript through this function and may extend it to cover
 * additional tool-call shapes.
 *
 * @param {string} providerSessionId - Claude session UUID
 * @returns {Promise<Array<{role:string,text:string,timestamp:string|null,model:string|null}>>}
 */
async function parseTranscript(providerSessionId) {
  try {
    if (!providerSessionId || typeof providerSessionId !== 'string') return [];
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeDir)) return [];

    let entries;
    try {
      entries = fs.readdirSync(claudeDir);
    } catch (_) {
      return [];
    }

    for (const dir of entries) {
      const jsonlPath = path.join(claudeDir, dir, providerSessionId + '.jsonl');
      let stat;
      try { stat = fs.statSync(jsonlPath); } catch (_) { continue; }
      if (!stat.isFile()) continue;

      let raw;
      try {
        raw = fs.readFileSync(jsonlPath, 'utf-8');
      } catch (_) {
        return [];
      }

      const lines = raw.split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          const inner = e.message || e;
          const role = inner.role || e.role || e.type || 'system';
          if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool' && role !== 'human') {
            // Non-message envelope (e.g. permission-mode, custom-title); skip
            continue;
          }
          const normalizedRole = role === 'human' ? 'user' : role;

          const content = inner.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.map(c => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object') {
                if (typeof c.text === 'string') return c.text;
                if (typeof c.content === 'string') return c.content;
              }
              return '';
            }).join('');
          }

          messages.push({
            role: normalizedRole,
            text: text,
            timestamp: e.timestamp || inner.timestamp || null,
            model: inner.model || e.model || null,
          });
        } catch (_) {
          // Skip unparseable line
        }
      }
      return messages;
    }
    return [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  parseTranscript,
  extractCustomTitle,
  extractSessionName,
  // Asynchronous twins used by the budgeted discovery walk (task #36). The
  // synchronous exports above are unchanged and still used by search.js and
  // by server.js's legacy re-export.
  extractCustomTitleAsync,
  extractSessionNameAsync,
  // Pure parsers and the byte pre-filter, exported so a test can prove the
  // two readers share one parse rather than two that happen to agree today.
  parseCustomTitleFromWindow,
  parseSessionNameFromWindow,
  windowMayContainCustomTitle,
  CUSTOM_TITLE_MARKER,
  CUSTOM_TITLE_TAIL_BYTES,
  SESSION_NAME_HEAD_BYTES,
};
