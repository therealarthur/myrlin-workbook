/**
 * workspace/session-flags.js: the phone's pinned and archived flags,
 * persisted in <dataDir>/mobile/session-flags.json keyed by the phone
 * sessionId (PROTOCOL.md 4.5.1, P22).
 *
 * WHY: the desktop has no pin or archive flag today, so they live in a
 * mobile store of their own instead of the Workbook store. B2's session
 * index reads them through workspace.flags.get for every SessionSummary,
 * so the read path stays in memory; writes are atomic (BUILD-CONTRACT 3.1)
 * and publish session.meta and sessions.changed (BUILD-CONTRACT 3.4.4).
 * A wb_ id that re-keys to cl_ or cx_ keeps its flags (the aliases B2 hands
 * out on idChanged are followed on read).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const common = require('./common');

/** File name under <dataDir>/mobile/. */
const FILE_NAME = 'session-flags.json';
/** File format version. */
const FILE_VERSION = 1;

/**
 * Create the flags store.
 *
 * @param {object} deps - {ctx, now}
 * @returns {{get: Function, set: Function, onChanged: Function, rekey: Function, all: Function, file: string}}
 */
function createSessionFlags(deps) {
  const ctx = deps.ctx;
  const now = deps.now || Date.now;
  const log = common.logger(ctx);
  const file = path.join(common.mobileDir(ctx), FILE_NAME);
  const listeners = new Set();
  const doc = common.readJson(file, null);
  /** sessionId -> {pinned, archived, updatedAtMs} */
  const flags = new Map();
  if (doc && doc.flags && typeof doc.flags === 'object') {
    for (const [id, f] of Object.entries(doc.flags)) {
      if (common.isSessionId(id) && f && typeof f === 'object') {
        flags.set(id, { pinned: f.pinned === true, archived: f.archived === true, updatedAtMs: Number(f.updatedAtMs) || 0 });
      }
    }
  }

  /** Persist the whole map atomically. */
  function save() {
    const out = {};
    for (const [id, f] of flags) {
      if (f.pinned || f.archived) out[id] = f;
    }
    try {
      common.writeJson(file, { version: FILE_VERSION, flags: out });
    } catch (err) {
      log('flags write failed: ' + (err && err.message));
    }
  }

  /**
   * The flags of a session (false when never set).
   *
   * @param {string} sessionId - Phone id.
   * @returns {{pinned: boolean, archived: boolean}}
   */
  function get(sessionId) {
    const f = flags.get(sessionId);
    return { pinned: !!(f && f.pinned), archived: !!(f && f.archived) };
  }

  /**
   * Set pinned and or archived. Publishes session.meta and sessions.changed
   * through B2 when the value changed.
   *
   * @param {string} sessionId - Phone id (already resolved by the caller).
   * @param {{pinned?: boolean, archived?: boolean}} patch - Fields to set.
   * @returns {{pinned: boolean, archived: boolean}}
   */
  function set(sessionId, patch) {
    const cur = get(sessionId);
    const next = {
      pinned: typeof (patch && patch.pinned) === 'boolean' ? patch.pinned : cur.pinned,
      archived: typeof (patch && patch.archived) === 'boolean' ? patch.archived : cur.archived,
    };
    if (next.pinned === cur.pinned && next.archived === cur.archived) return next;
    flags.set(sessionId, { pinned: next.pinned, archived: next.archived, updatedAtMs: now() });
    save();
    for (const fn of listeners) {
      try { fn(sessionId, next); } catch (_) { /* listener errors are theirs */ }
    }
    announce(sessionId);
    return next;
  }

  /**
   * Tell the phone: session.meta on the session topic and sessions.changed
   * (updated) on the sessions topic (PROTOCOL.md 4.5.1).
   *
   * @param {string} sessionId - Phone id.
   */
  function announce(sessionId) {
    const chat = ctx.mobile && ctx.mobile.chat;
    if (!chat || !chat.sessions) return;
    try {
      if (typeof chat.sessions.noteChanged === 'function') chat.sessions.noteChanged(sessionId, 'updated');
      const meta = typeof chat.sessions.meta === 'function' ? chat.sessions.meta(sessionId) : null;
      if (meta) common.publish(ctx, 'session:' + sessionId, 'session.meta', meta);
    } catch (err) {
      log('flags announce failed: ' + (err && err.message));
    }
  }

  /**
   * Move flags from an old id to its new id (a wb_ session re-keyed).
   *
   * @param {string} oldId - Previous phone id.
   * @param {string} newId - New phone id.
   */
  function rekey(oldId, newId) {
    if (!flags.has(oldId) || oldId === newId) return;
    if (!flags.has(newId)) flags.set(newId, flags.get(oldId));
    flags.delete(oldId);
    save();
  }

  return {
    get,
    set,
    rekey,
    file,
    onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    all: () => Array.from(flags.entries()).map(([id, f]) => ({ sessionId: id, pinned: f.pinned, archived: f.archived })),
  };
}

module.exports = { createSessionFlags, FILE_NAME };
