/**
 * Scheduled messages engine.
 *
 * Fires shell commands into a pty session on a delay (one-off) or on repeat
 * (recurring). State persists to ~/.myrlin/schedules.json so schedules survive
 * server restarts. The engine is HTTP-agnostic: the route handlers in server.js
 * are thin adapters.
 *
 * Constructor dependencies are injectable so the engine is unit-testable:
 *   - ptyManager: must expose getSession(id) → { alive, pty: { write(s) } }
 *   - store:      EventEmitter (the existing src/state/store Store), for session:deleted
 *   - clock:      { now(): number }, defaults to Date
 *   - schedule:   schedule(fn, ms) → handle; schedule.cancel(handle), defaults to setTimeout
 *   - dataFile:   absolute path to schedules.json, defaults to ~/.myrlin/schedules.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('../utils/data-dir');

const MAX_DELAY_MS = 30 * 86_400_000; // 30 days
const MIN_DELAY_MS = 1_000;           // 1 second
const MAX_COMMAND_BYTES = 2048;
const HISTORY_CAP_PER_SESSION = 50;
const SAVE_DEBOUNCE_MS = 200;
// Gap between writing the message text and writing the Enter key. TUIs that
// support bracketed-paste mode (Claude Code, etc) treat a single fast burst
// ending in \r as a paste, and \r inside a paste becomes a literal newline
// rather than a submit. Splitting the writes makes the second one register
// as a real Enter keypress.
const SUBMIT_DELAY_MS = 80;

const DEFAULT_CLOCK = { now: () => Date.now() };
function defaultSchedule(fn, ms) { return setTimeout(fn, ms); }
defaultSchedule.cancel = (h) => clearTimeout(h);

class Scheduler {
  constructor({ dataFile, ptyManager, store, clock = DEFAULT_CLOCK, schedule = defaultSchedule } = {}) {
    this.dataFile = dataFile || path.join(getDataDir(), 'schedules.json');
    this.ptyManager = ptyManager;
    this.store = store;
    this.clock = clock;
    this.schedule = schedule;

    /** @type {Object.<string, Schedule>} */
    this._schedules = {};
    /** @type {Object.<string, HistoryRow[]>} */
    this._history = {};
    /** @type {Object.<string, any>} */
    this._timers = {}; // scheduleId -> timer handle

    this._saveTimer = null;
    this._load();
  }

  // ── Persistence ────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        this._schedules = raw.schedules || {};
        this._history = raw.history || {};
      }
    } catch (_) {
      this._schedules = {};
      this._history = {};
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = this.schedule(() => {
      this._saveTimer = null;
      this._writeSync();
    }, SAVE_DEBOUNCE_MS);
  }

  flushSync() {
    if (this._saveTimer) {
      this.schedule.cancel(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeSync();
  }

  _writeSync() {
    const dir = path.dirname(this.dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.dataFile + '.tmp';
    const payload = JSON.stringify({ schedules: this._schedules, history: this._history }, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.dataFile);
  }

  // ── CRUD ───────────────────────────────────────────────────────

  /**
   * Validate and create a schedule. Persists asynchronously (debounced).
   * @param {string} sessionId
   * @param {{command:string, kind:'once'|'recurring', delayMs?:number, fireAt?:number}} def
   * @returns {Schedule}
   */
  create(sessionId, def) {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId required');
    if (!def || typeof def !== 'object') throw new Error('def required');

    const command = def.command;
    if (typeof command !== 'string' || command.length === 0) throw new Error('command must be a non-empty string');
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) throw new Error('command exceeds 2KB');

    const kind = def.kind;
    if (kind !== 'once' && kind !== 'recurring') throw new Error('kind must be "once" or "recurring"');

    const hasDelay = Number.isFinite(def.delayMs);
    const hasFireAt = Number.isFinite(def.fireAt);
    if (kind === 'recurring' && !hasDelay) throw new Error('recurring requires delayMs');
    if (kind === 'recurring' && hasFireAt) throw new Error('recurring cannot use fireAt');
    if (kind === 'once' && hasDelay && hasFireAt) throw new Error('exactly one of delayMs/fireAt for once');
    if (kind === 'once' && !hasDelay && !hasFireAt) throw new Error('once requires delayMs or fireAt');

    if (hasDelay) {
      if (def.delayMs < MIN_DELAY_MS) throw new Error(`delayMs must be ≥ ${MIN_DELAY_MS}`);
      if (def.delayMs > MAX_DELAY_MS) throw new Error(`delayMs must be ≤ ${MAX_DELAY_MS}`);
    }

    const now = this.clock.now();
    if (hasFireAt && def.fireAt <= now) throw new Error('fireAt must be in the future');

    const id = crypto.randomUUID();
    const nextFireAt = hasFireAt ? def.fireAt : now + def.delayMs;
    const s = {
      id, sessionId, command, kind,
      delayMs: hasDelay ? def.delayMs : undefined,
      fireAt: hasFireAt ? def.fireAt : undefined,
      nextFireAt,
      createdAt: now,
    };
    this._schedules[id] = s;
    this._scheduleSave();
    // If the engine is already running, arm a timer for this new schedule.
    // Without this, schedules created at runtime via the HTTP API would sit
    // idle until the next server restart's boot-recovery loop.
    if (this._started) this._armOne(id);
    return s;
  }

  delete(scheduleId) {
    if (!this._schedules[scheduleId]) return false;
    const timer = this._timers[scheduleId];
    if (timer) {
      this.schedule.cancel(timer);
      delete this._timers[scheduleId];
    }
    delete this._schedules[scheduleId];
    this._scheduleSave();
    return true;
  }

  listActive(sessionId) {
    return Object.values(this._schedules)
      .filter(s => s.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listHistory(sessionId) {
    const rows = this._history[sessionId] || [];
    // Stored newest-last; return newest-first
    return [...rows].reverse();
  }

  clearHistory(sessionId) {
    delete this._history[sessionId];
    this._scheduleSave();
  }

  /**
   * Active-schedule count per session id, for driving UI indicators
   * (pane badges, sidebar clock icons) without requiring the frontend to
   * fan out N requests across every visible session.
   * @returns {Object<string, number>}
   */
  activeCounts() {
    const out = {};
    for (const s of Object.values(this._schedules)) {
      out[s.sessionId] = (out[s.sessionId] || 0) + 1;
    }
    return out;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;

    // Boot recovery: pre-process schedules whose nextFireAt has elapsed.
    const now = this.clock.now();
    for (const id of Object.keys(this._schedules)) {
      const s = this._schedules[id];
      if (s.nextFireAt < now) {
        if (s.kind === 'once') {
          this._appendHistory(s.sessionId, {
            id: s.id, command: s.command,
            firedAt: now, scheduledAt: s.nextFireAt,
            status: 'skipped', skipReason: 'missed-while-down', skipCount: 1,
          });
          delete this._schedules[id];
        } else {
          // recurring: no catch-up, advance to now + delayMs
          s.nextFireAt = now + s.delayMs;
        }
      }
    }
    this._scheduleSave();

    // Arm timers for everything still active
    for (const id of Object.keys(this._schedules)) {
      this._armOne(id);
    }

    // Subscribe to store cleanup
    if (this.store && typeof this.store.on === 'function') {
      this._onSessionDeleted = ({ id }) => this._handleSessionDeleted(id);
      this.store.on('session:deleted', this._onSessionDeleted);
    }
  }

  stop() {
    this._started = false;
    for (const id of Object.keys(this._timers)) {
      this.schedule.cancel(this._timers[id]);
    }
    this._timers = {};
    if (this._saveTimer) {
      this.schedule.cancel(this._saveTimer);
      this._saveTimer = null;
      this._writeSync();
    }
    if (this.store && this._onSessionDeleted) {
      this.store.off('session:deleted', this._onSessionDeleted);
      this._onSessionDeleted = null;
    }
  }

  _armOne(scheduleId) {
    const s = this._schedules[scheduleId];
    if (!s) return;
    const delay = Math.max(0, s.nextFireAt - this.clock.now());
    this._timers[scheduleId] = this.schedule(() => this._fire(scheduleId), delay);
  }

  // ── Fire flow ─────────────────────────────────────────────────

  _fire(scheduleId) {
    const s = this._schedules[scheduleId];
    if (!s) return;
    delete this._timers[scheduleId];

    const session = this.ptyManager && this.ptyManager.getSession(s.sessionId);
    const alive = !!(session && session.alive);
    const scheduledAt = s.nextFireAt;
    const firedAt = this.clock.now();

    if (!alive) {
      this._appendHistory(s.sessionId, {
        id: s.id, command: s.command, firedAt, scheduledAt,
        status: 'skipped', skipReason: 'session-not-running', skipCount: 1,
      });
      if (s.kind === 'once') {
        delete this._schedules[s.id];
      } else {
        s.nextFireAt = firedAt + s.delayMs;
        this._armOne(s.id);
      }
      this._scheduleSave();
      return;
    }

    // Success path. Write the message text first, then fire the Enter
    // key as a separate write after a short gap (see SUBMIT_DELAY_MS comment).
    try {
      session.pty.write(s.command);
    } catch (err) {
      console.error('[Scheduler] pty.write failed:', err.message);
    }
    this.schedule(() => {
      const live = this.ptyManager && this.ptyManager.getSession(s.sessionId);
      if (!live || !live.alive) return;
      try { live.pty.write('\r'); }
      catch (err) { console.error('[Scheduler] pty.write \\r failed:', err.message); }
    }, SUBMIT_DELAY_MS);

    this._appendHistory(s.sessionId, {
      id: s.id, command: s.command, firedAt, scheduledAt,
      status: 'success', skipReason: null, skipCount: 1,
    });

    if (s.kind === 'once') {
      delete this._schedules[s.id];
    } else {
      s.nextFireAt = firedAt + s.delayMs;
      this._armOne(s.id);
    }
    this._scheduleSave();
  }

  _appendHistory(sessionId, row) {
    if (!this._history[sessionId]) this._history[sessionId] = [];
    const arr = this._history[sessionId];
    const last = arr[arr.length - 1];
    const canCollapse =
      last
      && last.status === 'skipped'
      && row.status === 'skipped'
      && last.id === row.id
      && last.skipReason === row.skipReason;
    if (canCollapse) {
      last.skipCount = (last.skipCount || 1) + 1;
      last.firedAt = row.firedAt;
    } else {
      arr.push(row);
    }
    if (arr.length > HISTORY_CAP_PER_SESSION) {
      this._history[sessionId] = arr.slice(-HISTORY_CAP_PER_SESSION);
    }
  }

  _handleSessionDeleted(sessionId) {
    let changed = false;
    for (const id of Object.keys(this._schedules)) {
      if (this._schedules[id].sessionId === sessionId) {
        const timer = this._timers[id];
        if (timer) this.schedule.cancel(timer);
        delete this._timers[id];
        delete this._schedules[id];
        changed = true;
      }
    }
    if (this._history[sessionId]) {
      delete this._history[sessionId];
      changed = true;
    }
    if (changed) this._scheduleSave();
  }
}

module.exports = { Scheduler, MIN_DELAY_MS, MAX_DELAY_MS, MAX_COMMAND_BYTES, HISTORY_CAP_PER_SESSION };
