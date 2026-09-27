/**
 * Live session runtime for the mobile chat: PTY handles, screen readers and
 * the per session write lock.
 *
 * What: maps a phone session id to its Workbook PTY session, keeps one
 * ScreenReader per PTY (fed by the pty-manager data tap), classifies fresh
 * screens with the prompt detectors, and serialises every write to a session
 * (sends, answers, interrupts) through one lock (PROTOCOL.md 7.1).
 *
 * Why: the send guard, the answer route and interrupt all need "a screen no
 * older than 250 ms" and "nobody else is writing to this PTY right now"; one
 * owner of both keeps those guarantees true across modules.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const { ScreenReader } = require('./screen-reader');
const { classify } = require('./prompt-detect');
const { delay } = require('./common');

const FRESH_MAX_AGE_MS = 250;

/**
 * @param {object} deps - {ctx, index, now}
 * @returns {object}
 */
function createRuntime(deps) {
  const { ctx, index } = deps;
  const now = deps.now || Date.now;
  const readers = new Map();
  const locks = new Map();
  const screenListeners = new Set();
  const pm = () => { try { return ctx && typeof ctx.getPtyManager === 'function' ? ctx.getPtyManager() : null; } catch (_) { return null; } };

  /**
   * The live PtySession of a phone session, or null.
   * @param {string} sessionId
   * @returns {object|null}
   */
  function ptyOf(sessionId) {
    const ref = index.resolve(sessionId);
    if (!ref || !ref.workbookSessionId) return null;
    const m = pm();
    const s = m && m.getSession ? m.getSession(ref.workbookSessionId) : null;
    return s && s.alive ? s : null;
  }

  /**
   * The screen reader of a Workbook PTY session id (created on demand).
   * @param {string} workbookSessionId
   * @returns {ScreenReader|null}
   */
  function readerFor(workbookSessionId) {
    const m = pm();
    const s = m && m.getSession ? m.getSession(workbookSessionId) : null;
    if (!s) return null;
    let r = readers.get(workbookSessionId);
    if (r && r.session !== s) { r.dispose(); r = null; }
    if (!r) {
      r = new ScreenReader(s, {
        now,
        onScreen: (snap) => {
          const phoneId = index.idForWorkbookSession(workbookSessionId);
          if (!phoneId) return;
          const ref = index.resolve(phoneId);
          const cls = classify(snap, ref ? ref.provider : 'claude');
          for (const fn of screenListeners) { try { fn(phoneId, cls, snap); } catch (_) {} }
        },
      });
      readers.set(workbookSessionId, r);
    }
    return r;
  }

  return {
    ptyOf,
    readerFor,
    /** PTY output tap. */
    onPtyData(workbookSessionId) { const r = readerFor(workbookSessionId); if (r) r.onData(); },
    /** PTY exit tap. */
    onPtyExit(workbookSessionId) { const r = readers.get(workbookSessionId); if (r) r.dispose(); readers.delete(workbookSessionId); },
    /** Whether the session has a screen model right now. */
    hasScreen(sessionId) {
      const s = ptyOf(sessionId);
      return !!(s && s.vt && s.vt.term && !s.vt.disposed);
    },
    /**
     * A fresh classification of a session's screen.
     * @param {string} sessionId
     * @param {number} [maxAgeMs=250]
     * @returns {Promise<{cls: object, snap: object}|null>}
     */
    async freshScreen(sessionId, maxAgeMs = FRESH_MAX_AGE_MS) {
      const s = ptyOf(sessionId);
      if (!s || !s.vt) return null;
      const r = readerFor(s.sessionId);
      if (!r) return null;
      const snap = await r.fresh(maxAgeMs);
      if (!snap) return null;
      const ref = index.resolve(sessionId);
      const cls = classify(snap, ref ? ref.provider : 'claude');
      for (const fn of screenListeners) { try { fn(sessionId, cls, snap); } catch (_) {} }
      return { cls, snap };
    },
    /**
     * Bracketed paste mode of the PTY (G7).
     * @param {string} sessionId
     * @returns {boolean|null} null when unknown
     */
    bracketedPaste(sessionId) {
      const s = ptyOf(sessionId);
      if (!s || !s.vt) return null;
      try { const m = s.vt.getMode(); return m ? !!m.bracketedPaste : null; } catch (_) { return null; }
    },
    /**
     * Write bytes to the session's PTY as one write.
     * @param {string} sessionId
     * @param {string} bytes
     * @returns {boolean}
     */
    write(sessionId, bytes) {
      const s = ptyOf(sessionId);
      if (!s) return false;
      s.pty.write(bytes);
      return true;
    },
    /**
     * Run fn while holding the session's write lock.
     * @template T
     * @param {string} sessionId
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withLock(sessionId, fn) {
      const prev = locks.get(sessionId) || Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      const chain = prev.then(() => mine);
      locks.set(sessionId, chain);
      await prev.catch(() => {});
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(sessionId) === chain) locks.delete(sessionId);
      }
    },
    /** Listen to every classification. */
    onScreen(fn) { screenListeners.add(fn); return () => screenListeners.delete(fn); },
    delay,
    dispose() { for (const r of readers.values()) r.dispose(); readers.clear(); },
  };
}

module.exports = { createRuntime, FRESH_MAX_AGE_MS };
