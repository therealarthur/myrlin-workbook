/**
 * audit.js: per device audit lines at <dataDir>/mobile/audit.jsonl.
 *
 * WHY (critic F9): a paired phone reaches a shell through the agents, so the
 * desktop Devices tab shows what each phone did. PROTOCOL.md 11.4: one JSON
 * line per action, rotated at 10 MB with 3 files kept, `detail` a short string
 * that never holds message text or secrets.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Rotate when the live file passes this size. */
const ROTATE_BYTES = 10 * 1024 * 1024;
/** Files kept in total: audit.jsonl, audit.jsonl.1, audit.jsonl.2. */
const FILES_KEPT = 3;
/** Longest detail string stored. */
const DETAIL_MAX_CHARS = 200;
/** Default and maximum page size for the admin read. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Actions of PROTOCOL.md 11.4. */
const ACTIONS = Object.freeze([
  'pair', 'revoke', 'scopeChange', 'sessionSignatureFailed', 'send', 'interrupt', 'answer', 'rename',
  'settings', 'restart', 'stop', 'newSession', 'branch', 'continueHere', 'resumeAnyway', 'tabsPatch',
  'swap', 'accountLogin', 'accountLabel', 'upload', 'migrationStart', 'migrationApprove', 'migrationCancel',
]);

/**
 * Create the audit log.
 *
 * @param {object} opts - {dataDir, now, log}.
 * @returns {{write: Function, read: Function, file: string}}
 */
function createAudit(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const dir = path.join(opts.dataDir, 'mobile');
  const file = path.join(dir, 'audit.jsonl');

  /** Shift audit.jsonl to .1, .1 to .2, dropping the oldest. */
  function rotate() {
    for (let i = FILES_KEPT - 1; i >= 1; i -= 1) {
      const from = i === 1 ? file : file + '.' + (i - 1);
      const to = file + '.' + i;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch (_) { /* best effort */ }
    }
  }

  /**
   * Append one audit line. Never throws into the caller.
   *
   * @param {{deviceId: string, action: string, sessionId?: string, detail?: string, ok?: boolean}} entry
   */
  function write(entry) {
    try {
      if (!entry || !entry.deviceId || !entry.action) return;
      let detail = entry.detail == null ? null : String(entry.detail).replace(/[\r\n]+/g, ' ');
      if (detail && detail.length > DETAIL_MAX_CHARS) detail = detail.slice(0, DETAIL_MAX_CHARS);
      const line = JSON.stringify({
        ts: now(),
        deviceId: entry.deviceId,
        action: entry.action,
        sessionId: entry.sessionId || null,
        detail,
        ok: entry.ok !== false,
      }) + '\n';
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { size = 0; }
      if (size + line.length > ROTATE_BYTES) rotate();
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (err) {
      log('[mobile] audit write failed: ' + (err && err.message));
    }
  }

  /**
   * Read a device's audit lines, newest first.
   *
   * @param {string} deviceId - Device.
   * @param {number} [limit=100] - Maximum entries.
   * @returns {object[]}
   */
  function read(deviceId, limit) {
    const max = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const out = [];
    for (let i = 0; i < FILES_KEPT && out.length < max; i += 1) {
      const f = i === 0 ? file : file + '.' + i;
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const lines = text.split('\n');
      for (let j = lines.length - 1; j >= 0 && out.length < max; j -= 1) {
        if (!lines[j]) continue;
        try {
          const e = JSON.parse(lines[j]);
          if (!deviceId || e.deviceId === deviceId) out.push(e);
        } catch (_) { /* skip a torn line */ }
      }
    }
    return out;
  }

  return { write, read, file, ACTIONS };
}

module.exports = { createAudit, ACTIONS, ROTATE_BYTES, FILES_KEPT };
