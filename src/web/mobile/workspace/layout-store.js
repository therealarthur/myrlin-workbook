/**
 * workspace/layout-store.js: the desktop tab layout (layout.json) with
 * revisions, the phone operation log, and the rebase of desktop saves
 * (PROTOCOL.md 4.8, 4.8.1; BUILD-CONTRACT S8).
 *
 * WHY: A11 ("tabs like the desktop" means the same tabs). The desktop page
 * rewrites the whole layout 500 ms after any change (app.js
 * saveTerminalLayout), so before this module a phone edit made between two
 * desktop saves was simply overwritten (R02:339). Every writer now goes
 * through here: the desktop's PUT /api/layout (S8) and the phone's
 * PATCH /tabs (tabs.js). Each change increments one revision, stored inside
 * layout.json as a top level "revision" so a single atomic write keeps the
 * blob and its revision together. The last 200 phone operations are kept
 * with the revision each produced; a desktop save based on an older
 * revision gets them re-applied on top of its blob (skipping any whose
 * target is gone), so the desktop can never overwrite a phone edit, and
 * the page is told (merged: true plus the stored layout) to replace its
 * tabs with the result.
 *
 * The module is a per data folder singleton: server.js reaches it with
 * require() for the layout routes even when the mobile listener is off,
 * and B3's tabs module registers the operation replayer and the change
 * listeners when the workspace mounts.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fsAtomic = require('../fs-atomic');

/** The layout file the desktop has always used (server.js LAYOUT_FILE). */
const LAYOUT_FILE_NAME = 'layout.json';
/** The phone operation log, under <dataDir>/mobile/. */
const OPLOG_FILE_NAME = 'layout-ops.json';
/** Phone operations kept for rebasing desktop saves (PROTOCOL.md 4.8.1). */
const OPLOG_MAX = 200;
/** Op log format version. */
const OPLOG_VERSION = 1;
/** Mode of layout.json (the desktop wrote it with the default mode before). */
const LAYOUT_FILE_MODE = 0o644;
/** Keys the store owns and strips from any incoming blob. */
const RESERVED_KEYS = Object.freeze(['revision', 'baseRevision']);

/** dataDir -> store instance */
const instances = new Map();

/**
 * Whether a value is a plain JSON object.
 *
 * @param {*} v - Candidate.
 * @returns {boolean}
 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A copy of a layout blob without the keys the store owns.
 *
 * @param {object} blob - Layout object.
 * @returns {object}
 */
function stripReserved(blob) {
  const out = {};
  for (const [k, v] of Object.entries(blob || {})) if (!RESERVED_KEYS.includes(k)) out[k] = v;
  return JSON.parse(JSON.stringify(out));
}

/**
 * Create a layout store for one data folder.
 *
 * @param {object} o - {dataDir, now}
 * @returns {object}
 */
function createLayoutStore(o) {
  const dataDir = o.dataDir;
  const now = o.now || Date.now;
  const layoutFile = path.join(dataDir, LAYOUT_FILE_NAME);
  const oplogFile = path.join(dataDir, 'mobile', OPLOG_FILE_NAME);
  const listeners = new Set();
  let replayer = null;
  let broadcaster = null;
  let log = (msg) => { try { console.log('[mobile] layout: ' + msg); } catch (_) { /* never throws */ } };

  /**
   * Read layout.json: the blob (without revision) and its revision. A
   * missing or unreadable file is an empty layout at revision 0, as the
   * route answered {} before.
   *
   * @returns {{layout: object, revision: number, raw: *}}
   */
  function read() {
    let raw = null;
    try {
      if (fs.existsSync(layoutFile)) raw = JSON.parse(fs.readFileSync(layoutFile, 'utf-8'));
    } catch (_) {
      raw = null;
    }
    if (!isPlainObject(raw)) return { layout: {}, revision: 0, raw };
    const revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    return { layout: stripReserved(raw), revision, raw };
  }

  /**
   * Write a layout with its revision atomically (temp file, then rename).
   *
   * @param {object} layout - Blob without revision.
   * @param {number} revision - New revision.
   * @returns {object} What was stored (blob plus revision).
   */
  function write(layout, revision) {
    const stored = Object.assign(stripReserved(layout), { revision });
    fs.mkdirSync(dataDir, { recursive: true });
    fsAtomic.writeFileAtomic(layoutFile, JSON.stringify(stored, null, 2), LAYOUT_FILE_MODE);
    return stored;
  }

  /** @returns {Array<{revision: number, atMs: number, deviceId: (string|null), op: object}>} the op log */
  function readOps() {
    const doc = fsAtomic.readJson(oplogFile);
    return doc && Array.isArray(doc.ops) ? doc.ops.filter((e) => e && Number.isInteger(e.revision) && isPlainObject(e.op)) : [];
  }

  /**
   * Append operations to the log, keeping the newest OPLOG_MAX.
   *
   * @param {Array} entries - {revision, atMs, deviceId, op}.
   */
  function appendOps(entries) {
    const all = readOps().concat(entries);
    const kept = all.slice(Math.max(0, all.length - OPLOG_MAX));
    try {
      fsAtomic.writeJsonAtomic(oplogFile, { version: OPLOG_VERSION, ops: kept });
    } catch (err) {
      log('op log write failed: ' + (err && err.message));
    }
  }

  /**
   * The revision the next write takes: one above both the stored revision
   * and the newest logged phone operation, so revisions never go back even
   * when layout.json was replaced by something without one (a non object
   * body, a hand edit), and a later rebase never replays an old operation.
   *
   * @param {{revision: number}} cur - What read() returned.
   * @returns {number}
   */
  function nextRevision(cur) {
    let top = cur.revision;
    for (const e of readOps()) if (e.revision > top) top = e.revision;
    return top + 1;
  }

  /**
   * Tell listeners and the desktop pages about a change.
   *
   * @param {{revision: number, changedBy: object, layout: object}} change - What changed.
   */
  function emit(change) {
    for (const fn of listeners) {
      try { fn(change); } catch (err) { log('listener failed: ' + (err && err.message)); }
    }
    if (broadcaster) {
      try {
        broadcaster('layout:updated', { revision: change.revision, changedBy: change.changedBy });
      } catch (err) {
        log('layout:updated broadcast failed: ' + (err && err.message));
      }
    }
  }

  /**
   * GET /api/layout (S8): the stored object plus its revision.
   *
   * @returns {object}
   */
  function getForDesktop() {
    const cur = read();
    return Object.assign(cur.layout, { revision: cur.revision });
  }

  /**
   * PUT /api/layout (S8, PROTOCOL.md 4.8.1).
   *
   * - baseRevision equal to the current revision: stored as today, the
   *   revision increments (nothing is written when the blob is unchanged).
   * - baseRevision older: every phone operation recorded after it is
   *   re-applied, in order, on top of the desktop's blob (operations whose
   *   target is gone are skipped); the result is stored, the revision
   *   increments, and the answer carries merged: true and the layout.
   * - no baseRevision (an old page): stored as today, revision increments.
   *
   * @param {*} body - The request body.
   * @returns {object} The response body.
   */
  function putFromDesktop(body) {
    const cur = read();
    if (!isPlainObject(body)) {
      // Not an object: stored exactly as the route always stored it.
      fs.mkdirSync(dataDir, { recursive: true });
      fsAtomic.writeFileAtomic(layoutFile, JSON.stringify(body, null, 2), LAYOUT_FILE_MODE);
      return { success: true };
    }
    const base = Number.isInteger(body.baseRevision) ? body.baseRevision : null;
    const blob = stripReserved(body);
    const changedBy = { kind: 'desktop', deviceId: null };
    if (base !== null && base < cur.revision) {
      const layout = rebase(blob, base);
      const revision = nextRevision(cur);
      const stored = write(layout, revision);
      emit({ revision, changedBy, layout: stripReserved(stored) });
      return { success: true, revision, merged: true, layout: stored };
    }
    if (JSON.stringify(blob) === JSON.stringify(cur.layout) && cur.raw !== null) {
      return { success: true, revision: cur.revision };
    }
    const revision = nextRevision(cur);
    const stored = write(blob, revision);
    emit({ revision, changedBy, layout: stripReserved(stored) });
    return { success: true, revision };
  }

  /**
   * Re-apply the logged phone operations newer than a revision on a blob.
   *
   * @param {object} blob - The desktop's layout.
   * @param {number} base - The revision the desktop last saw.
   * @returns {object} The merged layout.
   */
  function rebase(blob, base) {
    let layout = JSON.parse(JSON.stringify(blob));
    const ops = readOps().filter((e) => e.revision > base).sort((a, b) => a.revision - b.revision);
    if (!ops.length) return layout;
    if (typeof replayer !== 'function') {
      log('desktop save rebased with no replayer; ' + ops.length + ' phone operations could not be re-applied');
      return layout;
    }
    for (const e of ops) {
      try {
        const next = replayer(JSON.parse(JSON.stringify(layout)), e.op);
        if (isPlainObject(next)) layout = next;
      } catch (_) {
        // The operation's target no longer exists in the desktop's blob:
        // skipped, as PROTOCOL.md 4.8.1 says.
      }
    }
    return layout;
  }

  /**
   * Store a layout the phone produced (tabs.js), log its operations with
   * the new revision, and announce the change.
   *
   * @param {object} layout - The new blob.
   * @param {{deviceId: (string|null), ops: object[], expectRevision: number}} o - Who and what.
   * @returns {{revision: number, layout: object}}
   */
  function commitPhone(layout, o) {
    const cur = read();
    if (Number.isInteger(o.expectRevision) && o.expectRevision !== cur.revision) {
      // Another writer landed between the caller's read and this write; the
      // caller re-runs its operations (never happens inside one tick).
      const err = new Error('layout moved on');
      err.layoutMoved = true;
      throw err;
    }
    const revision = nextRevision(cur);
    const stored = write(layout, revision);
    const atMs = now();
    appendOps((o.ops || []).map((op) => ({ revision, atMs, deviceId: o.deviceId || null, op })));
    emit({ revision, changedBy: { kind: 'device', deviceId: o.deviceId || null }, layout: stripReserved(stored) });
    return { revision, layout: stripReserved(stored) };
  }

  return {
    read,
    getForDesktop,
    putFromDesktop,
    commitPhone,
    readOps,
    layoutFile,
    oplogFile,
    /** Register the function that re-applies one logged phone operation. */
    setReplayer(fn) { replayer = typeof fn === 'function' ? fn : null; },
    /** Register the main server SSE broadcaster (layout:updated). */
    setBroadcaster(fn) { broadcaster = typeof fn === 'function' ? fn : null; },
    setLogger(fn) { if (typeof fn === 'function') log = fn; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Drop the hooks of an earlier mount (one workspace per process; tests remount). */
    resetHooks() { listeners.clear(); replayer = null; broadcaster = null; },
  };
}

/**
 * The store of a data folder (one per folder per process).
 *
 * @param {string} dataDir - Data folder.
 * @returns {object}
 */
function forDataDir(dataDir) {
  const key = path.resolve(dataDir);
  let s = instances.get(key);
  if (!s) {
    s = createLayoutStore({ dataDir: key });
    instances.set(key, s);
  }
  return s;
}

/** @returns {object} the store of Workbook's data folder (server.js) */
function defaultStore() {
  return forDataDir(require('../../../utils/data-dir').getDataDir());
}

/**
 * GET /api/layout body (S8).
 *
 * @returns {object}
 */
function getForDesktop() {
  return defaultStore().getForDesktop();
}

/**
 * PUT /api/layout body (S8).
 *
 * @param {*} body - Request body.
 * @returns {object}
 */
function putFromDesktop(body) {
  return defaultStore().putFromDesktop(body);
}

/** For tests: forget every instance. */
function _resetForTests() {
  instances.clear();
}

module.exports = {
  createLayoutStore,
  forDataDir,
  defaultStore,
  getForDesktop,
  putFromDesktop,
  OPLOG_MAX,
  LAYOUT_FILE_NAME,
  OPLOG_FILE_NAME,
  _resetForTests,
};
