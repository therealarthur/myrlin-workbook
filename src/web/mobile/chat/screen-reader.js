/**
 * ScreenSnapshot reads of a PTY's VT sidecar (PROTOCOL.md 8.1).
 *
 * What: snapshotFromTerminal() turns the visible rows of an @xterm/headless
 * terminal into a plain ScreenSnapshot {cols, rows, cursorX, cursorY,
 * altBuffer, lines: [{text, runs}]}, where runs mark the cells whose
 * attributes the detectors care about (dim, bold, inverse, foreground). A
 * ScreenReader per PTY session re-reads the screen after PTY output (150 ms
 * debounce, at most every 250 ms, never on a timer while the PTY is quiet),
 * waits for the sidecar to finish parsing, and tells listeners.
 *
 * Why: prompt detection, the send guard and part of the turn state machine
 * all decide from what the TUI shows (A6, A7). A plain, serialisable
 * snapshot is also exactly what the golden screen fixtures store, so the
 * detectors run identically on live screens, fakes and real captures.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const SCREEN_DEBOUNCE_MS = 150;
const SCREEN_MIN_INTERVAL_MS = 250;
/** How long to wait for the sidecar's parser to drain before reading anyway. */
const PARSE_WAIT_MAX_MS = 200;
const PARSE_POLL_MS = 10;

/**
 * Attribute runs of one buffer line.
 * @param {object} line - IBufferLine
 * @param {number} cols
 * @param {object} cellRef - reusable IBufferCell
 * @returns {Array<{s: number, e: number, dim: boolean, bold: boolean, inverse: boolean, fg: (number|null)}>}
 */
function runsOf(line, cols, cellRef) {
  const runs = [];
  let cur = null;
  for (let x = 0; x < cols; x++) {
    let cell = null;
    try { cell = line.getCell(x, cellRef); } catch (_) { cell = null; }
    if (!cell) break;
    if (cell.getWidth && cell.getWidth() === 0) continue;
    const dim = !!(cell.isDim && cell.isDim());
    const bold = !!(cell.isBold && cell.isBold());
    const inverse = !!(cell.isInverse && cell.isInverse());
    let fg = null;
    try { fg = cell.isFgDefault && cell.isFgDefault() ? null : cell.getFgColor(); } catch (_) { fg = null; }
    const plain = !dim && !bold && !inverse && fg === null;
    if (plain) { cur = null; continue; }
    if (cur && cur.dim === dim && cur.bold === bold && cur.inverse === inverse && cur.fg === fg && cur.e === x) {
      cur.e = x + 1;
    } else {
      cur = { s: x, e: x + 1, dim, bold, inverse, fg };
      runs.push(cur);
    }
  }
  return runs;
}

/**
 * Snapshot the visible screen of a headless terminal.
 * @param {object} term - @xterm/headless Terminal
 * @returns {object|null} ScreenSnapshot
 */
function snapshotFromTerminal(term) {
  if (!term) return null;
  try {
    const buf = term.buffer.active;
    const cols = term.cols;
    const rows = term.rows;
    const top = buf.viewportY;
    const lines = [];
    let cellRef = null;
    try { cellRef = buf.getNullCell(); } catch (_) { cellRef = undefined; }
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(top + y);
      if (!line) { lines.push({ text: '', runs: [] }); continue; }
      lines.push({ text: line.translateToString(true), runs: runsOf(line, cols, cellRef) });
    }
    return { cols, rows, cursorX: buf.cursorX, cursorY: buf.cursorY, altBuffer: buf.type === 'alternate', lines };
  } catch (_) {
    return null;
  }
}

/**
 * Whether the column range [s, e) of a line is entirely dim (placeholder text).
 * @param {{runs: Array}} line
 * @param {number} s
 * @param {number} e
 * @returns {boolean}
 */
function isRangeDim(line, s, e) {
  if (e <= s) return true;
  let covered = s;
  const runs = (line.runs || []).filter((r) => r.dim).sort((a, b) => a.s - b.s);
  for (const r of runs) {
    if (r.e <= covered) continue;
    if (r.s > covered) return false;
    covered = r.e;
    if (covered >= e) return true;
  }
  return covered >= e;
}

/**
 * Plain text of a snapshot (for rawScreen and logs of tests only).
 * @param {object} snap
 * @returns {string}
 */
function screenText(snap) {
  return snap && Array.isArray(snap.lines) ? snap.lines.map((l) => l.text).join('\n') : '';
}

/**
 * Per session screen reader over a PtySession (P1/P2 data taps feed it).
 */
class ScreenReader {
  /**
   * @param {object} session - PtySession with .vt (VtSidecar or null)
   * @param {object} [opts]
   * @param {(snap: object) => void} [opts.onScreen]
   * @param {() => number} [opts.now]
   */
  constructor(session, opts = {}) {
    this.session = session;
    this.onScreen = opts.onScreen || null;
    this.now = opts.now || Date.now;
    this.last = null;
    this.lastReadAt = 0;
    this._timer = null;
    this._disposed = false;
  }

  /** Whether a screen model exists for this session. */
  available() {
    return !!(this.session && this.session.vt && this.session.vt.term && !this.session.vt.disposed);
  }

  /** PTY output arrived: schedule a debounced, rate limited read. */
  onData() {
    if (this._disposed || this._timer) return;
    const wait = Math.max(SCREEN_DEBOUNCE_MS, SCREEN_MIN_INTERVAL_MS - (this.now() - this.lastReadAt));
    this._timer = setTimeout(() => { this._timer = null; this.readNow().catch(() => {}); }, wait);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Wait until the sidecar parsed everything queued so far.
   * @returns {Promise<void>}
   */
  async settle() {
    const vt = this.session && this.session.vt;
    const start = this.now();
    while (vt && vt._pendingBytes > 0 && this.now() - start < PARSE_WAIT_MAX_MS) {
      await new Promise((r) => setTimeout(r, PARSE_POLL_MS));
    }
  }

  /**
   * Read the screen now (after the parser drains) and notify.
   * @returns {Promise<object|null>}
   */
  async readNow() {
    if (!this.available()) return null;
    await this.settle();
    if (!this.available()) return null;
    const snap = snapshotFromTerminal(this.session.vt.term);
    if (!snap) return null;
    this.last = snap;
    this.lastReadAt = this.now();
    if (this.onScreen) {
      try { this.onScreen(snap); } catch (_) { /* listener errors are theirs */ }
    }
    return snap;
  }

  /**
   * A snapshot no older than maxAgeMs (PROTOCOL.md 7.1: at most 250 ms).
   * @param {number} [maxAgeMs=250]
   * @returns {Promise<object|null>}
   */
  async fresh(maxAgeMs = SCREEN_MIN_INTERVAL_MS) {
    if (this.last && this.now() - this.lastReadAt <= maxAgeMs && !(this.session.vt && this.session.vt._pendingBytes > 0)) return this.last;
    return this.readNow();
  }

  /** Stop timers. */
  dispose() {
    this._disposed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

module.exports = {
  ScreenReader,
  snapshotFromTerminal,
  isRangeDim,
  screenText,
  SCREEN_DEBOUNCE_MS,
  SCREEN_MIN_INTERVAL_MS,
};
