/**
 * VtSidecar: a server-side headless VT shadow of a live PTY session.
 *
 * Notion-restyle phase P6 (terminal stage 2). Implements the server half of
 * `docs/design/notion-restyle/TERMINAL-ARCHITECTURE.md` section 7.1: one
 * `@xterm/headless` terminal per PTY session, fed the SAME byte stream the
 * WebSocket clients receive, maintaining exact screen state for three jobs
 * the raw byte ring cannot do:
 *
 *   1. EXACT REPLAY (architecture defect D3). On attach or lag-resync the
 *      server today replays `scrollback.join('')`, a byte log pruned from the
 *      FRONT at 100 KB. For a long-lived alternate-screen agent pane the
 *      pruned prefix contains `CSI ?1049h` plus the whole frame construction,
 *      so what survives is tens of thousands of in-place patches that paint a
 *      few digits onto an otherwise blank screen. A state SNAPSHOT has no
 *      prefix to lose: it describes the screen, not the history of writes.
 *
 *   2. DEEP NORMAL-BUFFER HISTORY (defect D7). On the normal buffer a scroll
 *      off is a real, unambiguous commit event, so committed lines are
 *      appended to a bounded line log that outlives xterm's own client ring.
 *      (Measured fact C1: the alternate buffer NEVER scrolls, so there is
 *      deliberately no alternate-buffer history here. That is the transcript
 *      layer's job, not this module's.)
 *
 *   3. AUTHORITATIVE MODE SIGNAL. The server sees every byte, so it knows the
 *      buffer type, the mouse tracking mode and the bracketed-paste mode with
 *      no client sniffing, and can broadcast one answer that every attached
 *      client routes on identically and instantly.
 *
 * ---------------------------------------------------------------------------
 * CONTAINMENT
 * ---------------------------------------------------------------------------
 * `@xterm/headless` is loaded LAZILY behind the same containment pattern
 * `pty-manager.js` uses for `node-pty`: the require lives in a try/catch, the
 * error is remembered, a capability probe reports it, and every consumer is
 * written so a null sidecar degrades to the pre-existing byte-ring path. A
 * sidecar failure must NEVER kill a PTY session or the server. Lazy (rather
 * than load-time) resolution means a server running with the feature flag off
 * pays neither the require cost nor the memory.
 *
 * Every public method is total: it returns a null/empty/false result rather
 * than throwing, and it catches everything the headless terminal can throw.
 *
 * ---------------------------------------------------------------------------
 * SERIALIZATION: WHY THERE IS A BUILT-IN SERIALIZER
 * ---------------------------------------------------------------------------
 * TERMINAL-ARCHITECTURE 13.3 pairs `@xterm/headless` with
 * `@xterm/addon-serialize`. That addon is NOT installed in this repo and
 * implementation agents may not add dependencies, so `serializeTerminal()`
 * below produces the snapshot from the PUBLIC headless buffer API only
 * (`IBuffer` / `IBufferLine` / `IBufferCell` / `IModes`), with zero new
 * dependencies. The addon remains supported as an OPTIONAL faster path behind
 * `CWM_VT_SIDECAR_USE_ADDON=1`; when it is absent or fails to load the
 * built-in path is used, and when the built-in path fails the caller falls
 * back to the byte ring. Three tiers, each strictly safer than the last.
 *
 * Known fidelity limits of the built-in serializer, stated rather than hidden:
 *   - The current SGR pen (the attributes the next written glyph would take)
 *     is not exposed by the public API, so the snapshot ends with `CSI 0 m`.
 *     Applications set SGR before writing, so this is invisible in practice.
 *   - The DECSTBM scrolling region and the selected character sets are not
 *     readable, so the snapshot resets the region and assumes the default
 *     charset. Zero DECSTBM usage was measured across ten live sessions
 *     (TERMINAL-ARCHITECTURE 2.3), which is why this is acceptable.
 *   - Cell content beyond the scrollback cap is gone by definition; the line
 *     log carries depth instead (that is why the headless scrollback is 500).
 *
 * ---------------------------------------------------------------------------
 * MEMORY AND CPU BOUNDS
 * ---------------------------------------------------------------------------
 *   - `VT_SIDECAR_MAX_SESSIONS` (12) caps how many sidecars exist at once.
 *     Beyond it `create()` returns null and the byte-ring path is used.
 *   - `VT_SIDECAR_SCROLLBACK` (500) caps the headless buffer itself. xterm
 *     stores 3 uint32 per cell, so 500 lines at 200 columns is roughly 1.2 MB
 *     of cell data per sidecar. Depth is carried by the line log, not here.
 *   - `VT_LINE_LOG_MAX_LINES` (50000) and `VT_LINE_LOG_MAX_BYTES` (32 MB)
 *     bound the line log, whichever trips first, trimmed from the front.
 *   - `VT_WRITE_QUEUE_MAX_BYTES` (8 MB) bounds the headless write queue. The
 *     PTY data path must never block, so writes are queued, not awaited; if
 *     the queue is saturated the sidecar DROPS bytes and marks itself
 *     degraded rather than growing without limit. A degraded sidecar refuses
 *     to produce snapshots (callers fall back to the byte ring) until a full
 *     screen clear or an alternate-buffer switch re-establishes known state.
 *   - `VT_SNAPSHOT_MAX_CHARS` (4 MB) bounds one snapshot payload, trimmed
 *     from the OLDEST end so the current screen always survives.
 *   - CPU: parsing is the same code path the browser already runs per client;
 *     the sidecar adds one parse per session, not one per client. Line
 *     capture is O(lines committed), amortised, batched at
 *     `VT_LINE_CAPTURE_BATCH`.
 *
 * All bounds are env-overridable for operators, exactly as `mirror-service.js`
 * does, so a deployment can tune them without a code change.
 *
 * ---------------------------------------------------------------------------
 * FEATURE FLAGS
 * ---------------------------------------------------------------------------
 *   CWM_VT_SIDECAR=1              master enable. DEFAULT OFF for one release
 *                                 (BUILD-CONTRACT P6.2). Off means no headless
 *                                 terminal is ever constructed.
 *   CWM_VT_SIDECAR_SNAPSHOT=0     keep the sidecar (mode signal + line log)
 *                                 but replay the byte ring on attach. This is
 *                                 the fallback flag the contract requires; the
 *                                 ring path is retained, never removed.
 *   CWM_VT_SIDECAR_USE_ADDON=1    prefer @xterm/addon-serialize when present.
 *   CWM_SIMULATE_VT_LOAD_FAILURE=1  test/manual seam: behave exactly as if the
 *                                 headless require threw.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/web/vt-sidecar
 */

'use strict';

// ---------------------------------------------------------------------------
// Named constants (env-overridable for operators, ctor-overridable for tests)
// ---------------------------------------------------------------------------

/**
 * Parse a positive integer environment override, falling back to a default.
 * Mirrors the helper in mirror-service.js and jsonl-tailer.js (duplicated on
 * purpose: the three modules stay independently extractable).
 *
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Default when absent or invalid.
 * @returns {number} Resolved positive integer.
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Maximum number of concurrent sidecars. TERMINAL-ARCHITECTURE 11.2 sets 12,
 * matching the practical pane and tab-group ceiling. Beyond it the sidecar is
 * skipped and the byte-ring path is used, which is a graceful degradation
 * rather than a failure.
 */
const VT_SIDECAR_MAX_SESSIONS = envInt('CWM_VT_SIDECAR_MAX_SESSIONS', 12);

/**
 * Headless scrollback depth. Deliberately SHALLOW (500, not the client's
 * 10000) because the line log carries retention. This is the single biggest
 * lever on the server memory figure in TERMINAL-ARCHITECTURE 11.3.
 */
const VT_SIDECAR_SCROLLBACK = envInt('CWM_VT_SIDECAR_SCROLLBACK', 500);

/** Hard cap on line-log entries, trimmed from the front. */
const VT_LINE_LOG_MAX_LINES = envInt('CWM_VT_LINE_LOG_MAX_LINES', 50000);

/** Hard second bound on the line log, whichever trips first. */
const VT_LINE_LOG_MAX_BYTES = envInt('CWM_VT_LINE_LOG_MAX_BYTES', 32 * 1024 * 1024);

/**
 * Approximate per-entry overhead charged against VT_LINE_LOG_MAX_BYTES on top
 * of the string payload: a small V8 object plus a slot in the backing array.
 * Named so the accounting is auditable rather than a magic number.
 */
const VT_LINE_ENTRY_OVERHEAD_BYTES = 64;

/**
 * Bound on bytes queued into the headless terminal but not yet parsed. The
 * PTY data path is never blocked, so this is the only thing standing between
 * a burst of output and unbounded memory.
 */
const VT_WRITE_QUEUE_MAX_BYTES = envInt('CWM_VT_WRITE_QUEUE_MAX_BYTES', 8 * 1024 * 1024);

/** Bound on one serialized snapshot payload, trimmed from the oldest end. */
const VT_SNAPSHOT_MAX_CHARS = envInt('CWM_VT_SNAPSHOT_MAX_CHARS', 4 * 1024 * 1024);

/**
 * Commit-capture batch size. A scroll event fires once per scrolled line
 * (verified empirically against @xterm/headless 6.0.0), so capturing every
 * time would be one buffer read per line. Batching at 256 keeps the capture
 * well inside the 500-line scrollback so nothing is evicted unread, while
 * amortising the per-call overhead.
 */
const VT_LINE_CAPTURE_BATCH = envInt('CWM_VT_LINE_CAPTURE_BATCH', 256);

/**
 * Stable, machine-readable code surfaced to callers and to the capability
 * probe so they can branch on THIS specific failure without string-matching a
 * human-readable message. Mirrors PTY_UNAVAILABLE_CODE in pty-manager.js.
 */
const VT_UNAVAILABLE_CODE = 'VT_HEADLESS_LOAD_FAILED';

/**
 * DEC private modes the sidecar tracks by intercepting `CSI ? Pm h` and
 * `CSI ? Pm l`. Tracking the RAW sequences (rather than reading `term.modes`)
 * is what makes an exact restore possible: `IModes` exposes the mouse
 * TRACKING mode but not the mouse ENCODING (1005 / 1006 / 1015 / 1016), and
 * restoring tracking without its encoding would make the client send reports
 * the application cannot parse.
 */
const VT_TRACKED_PRIVATE_MODES = new Set([
  1,     // DECCKM application cursor keys
  6,     // DECOM origin mode
  7,     // DECAWM autowrap
  9,     // X10 mouse reporting
  12,    // cursor blink
  25,    // DECTCEM cursor visible
  47,    // legacy alternate screen
  1000,  // VT200 mouse
  1002,  // button-event (drag) mouse
  1003,  // any-event mouse
  1004,  // focus reporting
  1005,  // UTF-8 mouse encoding
  1006,  // SGR mouse encoding
  1015,  // urxvt mouse encoding
  1016,  // SGR pixel mouse encoding
  1047,  // legacy alternate screen
  1048,  // save/restore cursor
  1049,  // alternate screen + save cursor
  2004,  // bracketed paste
  2026,  // synchronized output
  2031,  // colour scheme change notification
  9001,  // win32 input mode (ConPTY)
]);

/**
 * Private modes the snapshot RESTORES, in emission order. Deliberately a
 * subset of the tracked set:
 *   - 1049 / 47 / 1047 / 1048 are expressed by the snapshot's own buffer
 *     switch, so re-emitting them would double-switch.
 *   - 2026 (synchronized output) is excluded because restoring it mid-frame
 *     would leave the client buffering forever if the app had opened a sync
 *     frame. Zero usage was measured, so nothing is lost.
 *   - 9001 (win32 input) and 2031 (colour scheme notification) are host
 *     capability negotiations addressed to the terminal, not renderable
 *     state; xterm.js ignores 9001 entirely. They are tracked for diagnostics
 *     (verification gate VG-4) and not replayed.
 */
const VT_RESTORED_PRIVATE_MODES = [1, 6, 7, 9, 12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004];

/**
 * Fresh-terminal defaults for the restored modes. Only modes whose live value
 * DIFFERS from its default are emitted, which keeps the restore block to a
 * handful of bytes on a typical session.
 */
const VT_PRIVATE_MODE_DEFAULTS = Object.freeze({
  1: false, 6: false, 7: true, 9: false, 12: false, 25: true,
  1000: false, 1002: false, 1003: false, 1004: false,
  1005: false, 1006: false, 1015: false, 1016: false, 2004: false,
});

/**
 * Snapshot preamble. Normalises every terminal mode the serializer's own
 * output depends on, so the payload renders identically regardless of what
 * state the receiving terminal was left in:
 *   CSI ? 7 h  autowrap ON  - wrapped lines are replayed by writing a full
 *                             row and letting the terminal wrap, which is
 *                             what reproduces IBufferLine.isWrapped.
 *   CSI ? 6 l  origin mode OFF - so CUP row numbers are absolute.
 *   CSI 4 l    insert mode OFF - so writes overwrite rather than shift.
 *   CSI r      scrolling region reset to the full screen.
 *   CSI m      SGR reset.
 *   CSI H      cursor home.
 */
const VT_SNAPSHOT_PREAMBLE = '\x1b[?7h\x1b[?6l\x1b[4l\x1b[r\x1b[m\x1b[H';

// ---------------------------------------------------------------------------
// Lazy, containment-guarded module resolution
// ---------------------------------------------------------------------------

let _headlessTerminal = null;
let _headlessLoadError = null;
let _headlessAttempted = false;
let _headlessErrorLogged = false;

/**
 * Resolve the `@xterm/headless` Terminal class exactly once, containing any
 * load failure. Lazy on purpose: with the feature flag off (the default for
 * one release) the dependency is never required at all, so the disabled path
 * costs zero require time and zero memory.
 *
 * @returns {Function|null} The headless Terminal constructor, or null when
 *   the module could not be loaded.
 */
function loadHeadless() {
  if (_headlessAttempted) return _headlessTerminal;
  _headlessAttempted = true;
  try {
    // Test-only / manual-repro seam, mirroring CWM_SIMULATE_PTY_LOAD_FAILURE
    // in pty-manager.js: makes us behave exactly as if the require threw, so
    // the degraded path is exercisable on a machine where the module loads
    // fine. Production installs never set this variable.
    if (process.env.CWM_SIMULATE_VT_LOAD_FAILURE === '1') {
      throw new Error('Failed to load @xterm/headless (simulated via CWM_SIMULATE_VT_LOAD_FAILURE)');
    }
    const mod = require('@xterm/headless');
    const Term = mod && mod.Terminal ? mod.Terminal : null;
    if (typeof Term !== 'function') {
      throw new Error('@xterm/headless resolved but exports no Terminal constructor');
    }
    _headlessTerminal = Term;
  } catch (err) {
    _headlessLoadError = err instanceof Error ? err : new Error(String(err));
    _headlessTerminal = null;
  }
  return _headlessTerminal;
}

let _serializeAddon = null;
let _serializeAttempted = false;

/**
 * Optionally resolve `@xterm/addon-serialize`. It is NOT a dependency of this
 * repo; this hook exists so a future release that adds it gets the addon's
 * faster path with no code change, and so the absence is a recorded fact
 * rather than a silent assumption.
 *
 * @returns {Function|null} The SerializeAddon constructor, or null.
 */
function loadSerializeAddon() {
  if (_serializeAttempted) return _serializeAddon;
  _serializeAttempted = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@xterm/addon-serialize');
    _serializeAddon = mod && mod.SerializeAddon ? mod.SerializeAddon : null;
  } catch (_) {
    _serializeAddon = null;
  }
  return _serializeAddon;
}

/**
 * Capability probe for the headless VT engine. Consumed by the sidecar
 * registry, tests, and any future health endpoint. Never throws. The `code`
 * field is stable and safe to expose publicly; `message` carries the raw load
 * error for SERVER-SIDE logging only.
 *
 * @returns {{available: boolean, code: string|null, message: string|null,
 *            serializeAddon: boolean}}
 */
function getVtSidecarAvailability() {
  const Term = loadHeadless();
  return {
    available: !!Term,
    code: Term ? null : VT_UNAVAILABLE_CODE,
    message: Term ? null : (_headlessLoadError ? _headlessLoadError.message : 'unavailable'),
    serializeAddon: !!loadSerializeAddon(),
  };
}

/**
 * Master feature flag, read at call time (not at module load) so tests and
 * operators can toggle it without re-requiring the module graph.
 *
 * @returns {boolean} True when the sidecar subsystem is enabled.
 */
function isSidecarEnabled() {
  return process.env.CWM_VT_SIDECAR === '1';
}

/**
 * Snapshot-replay sub-flag. Meaningful only when the sidecar is enabled;
 * setting it to '0' keeps the mode signal and the line log while replaying
 * the byte ring on attach. This is the contract's required fallback switch:
 * the ring path is retained in full, never removed.
 *
 * @returns {boolean} True when attach should replay a state snapshot.
 */
function isSnapshotReplayEnabled() {
  return isSidecarEnabled() && process.env.CWM_VT_SIDECAR_SNAPSHOT !== '0';
}

// ---------------------------------------------------------------------------
// Serialization helpers (pure; exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the CSI CUP (cursor position) sequence for a 1-based row/column.
 *
 * @param {number} row - 1-based row.
 * @param {number} col - 1-based column.
 * @returns {string} `CSI row ; col H`.
 */
function cup(row, col) {
  return '\x1b[' + row + ';' + col + 'H';
}

/**
 * Build a compact, comparable signature of a cell's rendition so consecutive
 * cells sharing a rendition emit one SGR sequence instead of one per cell.
 *
 * @param {object} cell - An IBufferCell.
 * @returns {string} Signature string; equal signatures render identically.
 */
function attrSignature(cell) {
  return cell.getFgColorMode() + ':' + cell.getFgColor() + ':' +
    cell.getBgColorMode() + ':' + cell.getBgColor() + ':' +
    (cell.isBold() ? 1 : 0) + (cell.isDim() ? 1 : 0) + (cell.isItalic() ? 1 : 0) +
    (cell.isUnderline() ? 1 : 0) + (cell.isBlink() ? 1 : 0) + (cell.isInverse() ? 1 : 0) +
    (cell.isInvisible() ? 1 : 0) + (cell.isStrikethrough() ? 1 : 0) + (cell.isOverline() ? 1 : 0);
}

/**
 * Build the SGR sequence that reproduces a cell's rendition from a clean pen.
 *
 * Always leads with the `0` reset parameter and then re-applies every active
 * attribute. That is a few bytes larger than an incremental diff and it is
 * chosen deliberately: a full re-application cannot desynchronise, which
 * makes each emitted line independently correct and therefore makes trimming
 * the oldest lines off a too-large snapshot safe.
 *
 * @param {object} cell - An IBufferCell.
 * @returns {string} An SGR sequence, e.g. `CSI 0 ; 1 ; 38 ; 5 ; 42 m`.
 */
function sgrFor(cell) {
  let s = '\x1b[0';
  if (cell.isBold()) s += ';1';
  if (cell.isDim()) s += ';2';
  if (cell.isItalic()) s += ';3';
  if (cell.isUnderline()) s += ';4';
  if (cell.isBlink()) s += ';5';
  if (cell.isInverse()) s += ';7';
  if (cell.isInvisible()) s += ';8';
  if (cell.isStrikethrough()) s += ';9';
  if (cell.isOverline()) s += ';53';
  if (cell.isFgRGB()) {
    const v = cell.getFgColor();
    s += ';38;2;' + ((v >> 16) & 0xff) + ';' + ((v >> 8) & 0xff) + ';' + (v & 0xff);
  } else if (cell.isFgPalette()) {
    s += ';38;5;' + cell.getFgColor();
  }
  if (cell.isBgRGB()) {
    const v = cell.getBgColor();
    s += ';48;2;' + ((v >> 16) & 0xff) + ';' + ((v >> 8) & 0xff) + ';' + (v & 0xff);
  } else if (cell.isBgPalette()) {
    s += ';48;5;' + cell.getBgColor();
  }
  return s + 'm';
}

/**
 * Serialize one buffer line to a byte string.
 *
 * Trailing cells are trimmed only when they are BOTH blank and
 * default-attributed: a run of spaces carrying a background colour is content
 * (a status bar), not padding, and dropping it would lose the bar. Trimming
 * is suppressed entirely for a line whose successor is wrapped, because the
 * wrap is reproduced by writing a full row and letting the terminal wrap,
 * which is what makes `IBufferLine.isWrapped` come back true on the client.
 *
 * The SGR pen is reset at the start of every line (the first content cell
 * always emits its full rendition), so every emitted line is independently
 * correct. That is what allows an oversized snapshot to be trimmed from the
 * oldest end without corrupting the remainder.
 *
 * @param {object} line - An IBufferLine.
 * @param {number} cols - Terminal width in columns.
 * @param {boolean} full - Emit all `cols` columns without trimming.
 * @param {object} cellRef - A reusable IBufferCell from `buffer.getNullCell()`.
 * @returns {string} The line's byte representation (no line terminator).
 */
function serializeLine(line, cols, full, cellRef) {
  if (!line) return '';
  const width = Math.min(cols, line.length);
  let end = width;
  if (!full) {
    while (end > 0) {
      const c = line.getCell(end - 1, cellRef);
      if (!c) { end--; continue; }
      const chars = c.getChars();
      const blank = (chars === '' || chars === ' ') && c.isAttributeDefault();
      if (!blank) break;
      end--;
    }
  }
  if (end === 0) return '';

  let out = '';
  let sig = null;
  for (let x = 0; x < end; x++) {
    const c = line.getCell(x, cellRef);
    if (!c) break;
    // Width 0 is the placeholder cell that follows a double-width glyph; the
    // glyph itself was already emitted and carries both columns.
    if (c.getWidth() === 0) continue;
    const nextSig = attrSignature(c);
    if (nextSig !== sig) {
      out += sgrFor(c);
      sig = nextSig;
    }
    const chars = c.getChars();
    out += (chars === '' ? ' ' : chars);
  }
  return out;
}

/**
 * Serialize the tracked private modes back into `CSI ? Pm h` / `CSI ? Pm l`
 * sequences, emitting only those whose live value differs from the
 * fresh-terminal default.
 *
 * @param {object} modeState - Map of mode number to boolean.
 * @returns {string} Zero or more private-mode set/reset sequences.
 */
function serializePrivateModes(modeState) {
  let out = '';
  for (const mode of VT_RESTORED_PRIVATE_MODES) {
    const live = modeState[mode];
    if (live === undefined) continue;
    if (live === VT_PRIVATE_MODE_DEFAULTS[mode]) continue;
    out += '\x1b[?' + mode + (live ? 'h' : 'l');
  }
  return out;
}

/**
 * Serialize a headless terminal's complete state to a byte string that, when
 * written to a freshly reset terminal of the same geometry, reproduces the
 * same grid, the same cursor position and the same input-affecting modes.
 *
 * Emission order and why:
 *   1. Preamble, normalising the modes the serializer's own output depends on.
 *   2. NORMAL buffer content, oldest line first, `CRLF` separated, so lines
 *      above the viewport land in the receiving terminal's scrollback exactly
 *      as they sit in the sidecar's. Wrapped lines are emitted full width
 *      with no separator so the terminal re-derives the wrap itself.
 *   3. If the alternate buffer is active: `CSI ? 1049 h`, then the alternate
 *      screen written row by row with ABSOLUTE cursor addressing. Absolute
 *      addressing is used here because the alternate screen has no scrollback
 *      and must never scroll during replay.
 *   4. `CSI 0 m`, then the cursor position, then the private-mode restore.
 *
 * @param {object} term - A headless Terminal instance.
 * @param {object} [opts]
 * @param {object} [opts.modeState] - Tracked private-mode map (see above).
 * @param {number} [opts.maxChars] - Bound on the payload; oldest normal-buffer
 *   lines are dropped first so the current screen always survives.
 * @returns {string} The snapshot payload. Never throws for a live terminal.
 */
function serializeTerminal(term, { modeState = null, maxChars = VT_SNAPSHOT_MAX_CHARS } = {}) {
  const cols = term.cols;
  const rows = term.rows;
  const active = term.buffer.active;
  const isAlt = active.type === 'alternate';
  const normal = term.buffer.normal;

  // ── Normal buffer, as an array of per-line payloads so an oversized
  //    snapshot can be trimmed from the OLDEST end without corrupting the
  //    remainder (every line is independently SGR-correct by construction).
  const normalCell = normal.getNullCell();
  const normalEnd = Math.min(normal.length, normal.baseY + rows);
  const chunks = [];
  let chunkBytes = 0;
  for (let y = 0; y < normalEnd; y++) {
    const line = normal.getLine(y);
    const next = (y + 1 < normalEnd) ? normal.getLine(y + 1) : null;
    const nextWrapped = !!(next && next.isWrapped);
    let piece = serializeLine(line, cols, nextWrapped, normalCell);
    // Reset the pen before EVERY line boundary, wrapped or not. A line feed
    // at the bottom of the screen scrolls, and the newly exposed row is
    // erased with the CURRENT background colour (back-colour erase, BCE).
    // Without this reset, a row that ended inside a coloured run tints the
    // whole of the following row, which is a real defect: it was caught by
    // the golden-stream comparison on a truecolor background fixture.
    // Emitting `CSI m` costs three bytes per line, moves no cursor, and
    // cannot cancel a pending wrap, so it is safe in the wrapped case too.
    piece += '\x1b[m';
    if (y < normalEnd - 1 && !nextWrapped) piece += '\r\n';
    chunks.push(piece);
    chunkBytes += piece.length;
  }
  // Trim the oldest lines until the normal-buffer portion fits its share of
  // the budget. The current screen is the last `rows` entries and is never
  // trimmed while anything older remains.
  const normalBudget = Math.max(0, maxChars - (isAlt ? rows * (cols + 16) : 0));
  let firstKept = 0;
  while (chunkBytes > normalBudget && firstKept < chunks.length - 1) {
    chunkBytes -= chunks[firstKept].length;
    firstKept++;
  }
  let out = VT_SNAPSHOT_PREAMBLE + chunks.slice(firstKept).join('');

  if (!isAlt) {
    out += '\x1b[m' + cup(normal.cursorY + 1, normal.cursorX + 1);
  } else {
    out += '\x1b[m\x1b[?1049h';
    const altCell = active.getNullCell();
    for (let y = 0; y < rows; y++) {
      const line = active.getLine(y);
      const piece = serializeLine(line, cols, false, altCell);
      if (!piece) continue;
      // Same back-colour-erase guard as the normal buffer: reset the pen
      // before repositioning, so a row that ends inside a coloured run
      // cannot tint anything the cursor move happens to expose.
      out += '\x1b[m' + cup(y + 1, 1) + piece;
    }
    out += '\x1b[m' + cup(active.cursorY + 1, active.cursorX + 1);
  }

  if (modeState) out += serializePrivateModes(modeState);
  return out;
}

// ---------------------------------------------------------------------------
// VtSidecar
// ---------------------------------------------------------------------------

/**
 * One headless VT shadowing one PTY session.
 *
 * Lifecycle is owned by the caller (pty-manager): construct on spawn, `write`
 * every PTY byte, `resize` on every applied viewport change, `dispose` on
 * exit or kill. Nothing in this class registers a timer, touches the
 * filesystem, or holds a reference to a WebSocket, so disposal is exact.
 */
class VtSidecar {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId - Owning PTY session id, for logging only.
   * @param {number} [opts.cols=120] - Initial width, matching the PTY.
   * @param {number} [opts.rows=30] - Initial height, matching the PTY.
   * @param {Function} [opts.onModeChange] - Called with a mode frame whenever
   *   the authoritative mode signal actually changes. Never called with an
   *   unchanged signal. Exceptions thrown by it are swallowed and logged.
   * @param {Function} [opts.TerminalClass] - @private test-only injection of
   *   the headless Terminal constructor.
   * @param {number} [opts.scrollback] - Override the headless scrollback.
   */
  constructor({ sessionId, cols = 120, rows = 30, onModeChange = null, TerminalClass = null, scrollback = null } = {}) {
    const Term = TerminalClass || loadHeadless();
    if (!Term) {
      const err = new Error(_headlessLoadError ? _headlessLoadError.message : 'headless VT unavailable');
      err.code = VT_UNAVAILABLE_CODE;
      throw err;
    }

    this.sessionId = sessionId;
    this.createdAt = Date.now();
    this.disposed = false;

    /**
     * Degraded means the VT has knowingly missed bytes (write-queue overflow)
     * so its grid may not match the real terminal. While degraded the sidecar
     * refuses to produce a snapshot and the caller falls back to the byte
     * ring. It clears itself when a full screen clear or a buffer switch
     * re-establishes a known state, because after either of those the
     * application repaints from scratch.
     */
    this.degraded = false;

    this._onModeChange = typeof onModeChange === 'function' ? onModeChange : null;
    this._modeSeq = 0;
    this._lastMode = null;

    // Tracked DEC private modes, populated by the parser hooks below.
    this._modeState = Object.create(null);

    // Write-queue accounting (see VT_WRITE_QUEUE_MAX_BYTES).
    this._pendingBytes = 0;
    this._droppedBytes = 0;
    this._writtenBytes = 0;

    // Normal-buffer commit tracking (see _captureCommittedLines).
    this._normalScrollCount = 0;
    this._capturedUpTo = 0;
    this._lostLines = 0;
    this._reflows = 0;

    // Bounded line log of committed normal-buffer lines.
    this._lineLog = [];
    this._lineLogBytes = 0;
    this._lineLogFirstIndex = 0;
    this._lineLogEvicted = 0;

    this.term = new Term({
      cols: Math.max(1, cols | 0) || 120,
      rows: Math.max(1, rows | 0) || 30,
      scrollback: scrollback === null ? VT_SIDECAR_SCROLLBACK : scrollback,
      allowProposedApi: true,
      // The sidecar never renders, so anything cosmetic is omitted on
      // purpose. convertEol stays OFF: the PTY stream is authoritative and
      // rewriting its line endings would desynchronise the shadow.
    });

    /**
     * Commit-capture batch size for THIS sidecar, clamped so it can never
     * exceed half the headless scrollback. The capture runs inside the scroll
     * handler once this many lines have accumulated, so a batch larger than
     * the scrollback would let lines be evicted before they were ever read.
     * Deriving it here (rather than trusting the constant) makes a small
     * operator-configured scrollback safe by construction.
     */
    const effectiveScrollback = scrollback === null ? VT_SIDECAR_SCROLLBACK : scrollback;
    this._captureBatch = Math.max(1, Math.min(VT_LINE_CAPTURE_BATCH, Math.floor(effectiveScrollback / 2) || 1));

    this._disposables = [];
    this._installParserHooks();
    this._installBufferHooks();
    // Prime the comparison baseline WITHOUT notifying. At construction time
    // no client is attached yet (the sidecar is created during spawn), so an
    // emission here would reach nobody; and priming silently is what lets the
    // callback contract be the strong one: onModeChange fires only on a real
    // CHANGE. A client that attaches later is handed getModeFrame() instead.
    this._lastMode = this.getMode();
    if (this._lastMode) this._modeSeq = 1;
  }

  /**
   * Intercept `CSI ? Pm h` and `CSI ? Pm l` to maintain an exact private-mode
   * map. Both handlers return false so the terminal's own default handling
   * still runs; this is an observer, never an override.
   *
   * @private
   */
  _installParserHooks() {
    const record = (set) => (params) => {
      try {
        for (const p of params) {
          const n = Array.isArray(p) ? p[0] : p;
          if (!Number.isFinite(n)) continue;
          if (!VT_TRACKED_PRIVATE_MODES.has(n)) continue;
          this._modeState[n] = set;
          // A buffer switch re-establishes known screen state: the incoming
          // buffer is cleared and repainted from scratch by the application,
          // so any bytes we previously dropped no longer matter.
          if (n === 1049 || n === 47 || n === 1047) this.degraded = false;
        }
      } catch (_) { /* an observer must never break the parser */ }
      return false;
    };
    try {
      this._disposables.push(this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, record(true)));
      this._disposables.push(this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, record(false)));
      // `CSI 2 J` (erase entire display) is the other point at which the
      // screen becomes known-blank and a degraded shadow re-converges.
      this._disposables.push(this.term.parser.registerCsiHandler({ final: 'J' }, (params) => {
        try {
          const n = Array.isArray(params[0]) ? params[0][0] : params[0];
          if (n === 2 || n === 3) this.degraded = false;
        } catch (_) {}
        return false;
      }));
    } catch (_) {
      // A headless build without a public parser still gives us a usable
      // snapshot and mode signal via IModes; only the exact mouse-encoding
      // restore is lost. Degrade, do not fail.
    }
  }

  /**
   * Hook the scroll event that drives normal-buffer line capture.
   *
   * `onScroll` fires exactly once per scrolled line (verified against
   * @xterm/headless 6.0.0), which is what makes the commit counter exact even
   * after `baseY` saturates at the scrollback cap and stops growing. Counting
   * scrolls rather than watching `baseY` is the whole reason the line log can
   * outlive the shadow's own 500-line buffer without a gap.
   *
   * There is deliberately NO onBufferChange listener emitting the mode
   * signal. Mode emission is coalesced into the per-write callback, which
   * gives clients a strong, statable contract: AT MOST ONE mode frame per PTY
   * output chunk, always describing the settled state after that chunk. A
   * buffer-change listener would emit an extra intermediate frame for the
   * common startup handshake (enter the alternate buffer, then enable mouse
   * tracking, all in one chunk) with no benefit to any consumer.
   *
   * @private
   */
  _installBufferHooks() {
    try {
      this._disposables.push(this.term.onScroll(() => {
        try {
          // Alternate-buffer scrolls are NOT history. Measured fact C1: the
          // agent CLI never scrolls its alternate viewport at all, and if
          // some other application does, those lines belong to that
          // application's own screen, not to the session's line history.
          if (this.term.buffer.active.type !== 'normal') return;
          this._normalScrollCount++;
          if (this._normalScrollCount - this._capturedUpTo >= this._captureBatch) {
            this._captureCommittedLines();
          }
        } catch (_) {}
      }));
    } catch (_) {}
  }

  /**
   * Feed PTY bytes to the shadow. Never throws, never blocks the caller, and
   * never grows without bound.
   *
   * @param {string|Buffer} data - Raw PTY output, exactly as broadcast.
   * @param {Function} [onParsed] - Optional, invoked once the bytes have been
   *   parsed AND the derived state (line log, mode signal) has been updated.
   *   The headless terminal parses asynchronously, so this is the only honest
   *   way to know the shadow has caught up; it is what a future
   *   flush-before-snapshot would hang off, and what the tests await. Never
   *   invoked when the write was dropped or threw.
   * @returns {boolean} True when the bytes were queued, false when dropped.
   */
  write(data, onParsed) {
    if (this.disposed || data === null || data === undefined) return false;
    let payload = data;
    if (typeof payload !== 'string') {
      try { payload = payload.toString('utf8'); } catch (_) { return false; }
    }
    if (payload.length === 0) return false;

    if (this._pendingBytes + payload.length > VT_WRITE_QUEUE_MAX_BYTES) {
      // The shadow is behind. Dropping is the only bounded option: blocking
      // would stall the PTY broadcast for every client, and queuing without
      // limit would trade a rendering defect for an out-of-memory crash.
      this._droppedBytes += payload.length;
      this.degraded = true;
      return false;
    }

    this._pendingBytes += payload.length;
    try {
      this.term.write(payload, () => {
        this._pendingBytes -= payload.length;
        this._writtenBytes += payload.length;
        if (!this.disposed) {
          this._captureCommittedLines();
          this._emitModeIfChanged();
        }
        if (typeof onParsed === 'function') {
          try { onParsed(); } catch (err) { this._logOnce('onParsed threw: ' + (err && err.message)); }
        }
      });
    } catch (err) {
      this._pendingBytes -= payload.length;
      this.degraded = true;
      this._logOnce('write failed: ' + (err && err.message));
      return false;
    }
    return true;
  }

  /**
   * Resize the shadow to match a viewport that was actually applied to the
   * PTY. Called only from the manager's single resize choke point, so the
   * shadow's geometry can never drift from the PTY's.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {boolean} True when the resize was applied.
   */
  resize(cols, rows) {
    if (this.disposed) return false;
    const c = Math.max(1, Number(cols) | 0);
    const r = Math.max(1, Number(rows) | 0);
    if (!Number.isFinite(c) || !Number.isFinite(r)) return false;
    if (c === this.term.cols && r === this.term.rows) return false;

    // A resize REFLOWS the buffer. Rows move between the viewport and the
    // scrollback with NO scroll event, so the `topAbsolute = scrollCount -
    // baseY` mapping the line capture depends on is only valid within one
    // geometry. Drain everything committed under the old geometry first,
    // then re-anchor under the new one. Skipping this produced a real,
    // silent gap in the deep history: it was caught in the end-to-end proof
    // as a log that jumped from line 30 straight to line 40 after a client
    // reattached at a narrower width.
    this._captureCommittedLines();
    let preBaseY = 0;
    try { preBaseY = this.term.buffer.normal.baseY; } catch (_) {}

    try {
      this.term.resize(c, r);
    } catch (err) {
      this._logOnce('resize failed: ' + (err && err.message));
      return false;
    }

    this._rebaselineLineLog(preBaseY);
    return true;
  }

  /**
   * Re-anchor the line-capture bookkeeping after a reflow.
   *
   * Two jobs:
   *   1. A shrink pushes rows out of the viewport into the scrollback without
   *      a scroll event. Those rows ARE committed history, so they are
   *      appended explicitly. A widen pulls rows back the other way; those
   *      rows were already logged when they first scrolled off, and they will
   *      be logged AGAIN when they scroll off a second time, so the log can
   *      repeat up to `|delta rows|` lines around a widen and is therefore
   *      not strictly monotonic across a resize seam.
   *
   *      That repeat is deliberate. Trimming the tail of the log to
   *      compensate would be exact only if reflow never joined or split a
   *      wrapped line, and when that assumption failed it would DELETE
   *      history that is no longer on screen. TERMINAL-ARCHITECTURE 7.4
   *      settles the identical question for the transcript seam the same
   *      way: a visible duplicate beats a silent deletion. `getStats().
   *      reflows` counts the seams so a consumer that wants to dedupe at
   *      render time knows how many to look for.
   *   2. Reset the absolute counters. With both at zero the invariant
   *      `topAbsolute = scrollCount - baseY` re-derives to `-baseY`, which
   *      maps absolute 0 onto the first row of the NEW viewport, so the next
   *      genuine scroll-off is captured exactly. The log's own index space is
   *      independent of these counters (readLines pages by
   *      `_lineLogFirstIndex`), so resetting them cannot renumber history.
   *
   * @private
   * @param {number} preBaseY - `buffer.normal.baseY` before the resize.
   */
  _rebaselineLineLog(preBaseY) {
    try {
      const normal = this.term.buffer.normal;
      const postBaseY = normal.baseY;
      for (let y = preBaseY; y < postBaseY; y++) {
        const line = normal.getLine(y);
        if (!line) break;
        let text = '';
        try { text = line.translateToString(true); } catch (_) { text = ''; }
        this._appendLogLine(text, !!line.isWrapped);
      }
    } catch (_) { /* a failed rebaseline costs history, never the session */ }
    this._normalScrollCount = 0;
    this._capturedUpTo = 0;
    this._reflows++;
  }

  /**
   * The authoritative mode signal for this session.
   *
   * @returns {{altBuffer: boolean, mouseTracking: string,
   *            mouseTrackingActive: boolean, bracketedPaste: boolean}|null}
   */
  getMode() {
    if (this.disposed) return null;
    try {
      const modes = this.term.modes;
      const tracking = (modes && modes.mouseTrackingMode) || 'none';
      return {
        altBuffer: this.term.buffer.active.type === 'alternate',
        mouseTracking: tracking,
        mouseTrackingActive: tracking !== 'none',
        bracketedPaste: !!(modes && modes.bracketedPasteMode),
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Produce a state snapshot of the current screen plus the normal-buffer
   * scrollback, as bytes a freshly reset terminal can render.
   *
   * Returns null (rather than a partial payload) whenever the shadow cannot
   * vouch for its own state, so the caller falls back to the byte ring. That
   * is the whole point of the containment contract: a wrong snapshot is worse
   * than a truncated byte log.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxChars] - Payload bound override.
   * @returns {string|null} Snapshot bytes, or null when unavailable.
   */
  snapshot({ maxChars = VT_SNAPSHOT_MAX_CHARS } = {}) {
    if (this.disposed || this.degraded) return null;
    try {
      if (process.env.CWM_VT_SIDECAR_USE_ADDON === '1') {
        const addonText = this._snapshotViaAddon();
        if (addonText) return addonText;
      }
      const text = serializeTerminal(this.term, { modeState: this._modeState, maxChars });
      return (typeof text === 'string' && text.length > 0) ? text : null;
    } catch (err) {
      this._logOnce('snapshot failed: ' + (err && err.message));
      return null;
    }
  }

  /**
   * Optional `@xterm/addon-serialize` path. Not a dependency of this repo; it
   * is loaded lazily and any failure falls through to the built-in
   * serializer. The addon instance is created once and reused.
   *
   * @private
   * @returns {string|null}
   */
  _snapshotViaAddon() {
    try {
      const Addon = loadSerializeAddon();
      if (!Addon) return null;
      if (!this._addon) {
        this._addon = new Addon();
        this.term.loadAddon(this._addon);
      }
      const text = this._addon.serialize({ scrollback: VT_SIDECAR_SCROLLBACK });
      if (typeof text !== 'string' || !text) return null;
      return VT_SNAPSHOT_PREAMBLE + text + serializePrivateModes(this._modeState);
    } catch (_) {
      this._addon = null;
      return null;
    }
  }

  /**
   * Append every normal-buffer line that has scrolled above the viewport
   * since the last capture.
   *
   * The absolute index of buffer line 0 is `scrollCount - baseY`, which stays
   * correct after `baseY` saturates at the scrollback cap, and lets a fall
   * behind be DETECTED (and counted as `lostLines`) rather than silently
   * producing a gap in the middle of the log.
   *
   * @private
   */
  _captureCommittedLines() {
    if (this.disposed) return;
    let buffer;
    try {
      buffer = this.term.buffer.normal;
    } catch (_) { return; }
    if (!buffer) return;
    if (this._capturedUpTo >= this._normalScrollCount) return;

    const topAbsolute = this._normalScrollCount - buffer.baseY;
    let from = this._capturedUpTo;
    if (from < topAbsolute) {
      // Lines were evicted from the shadow's scrollback before we read them.
      // Only reachable if one write chunk scrolled more than the scrollback
      // depth; recorded so the gap is visible rather than invented.
      this._lostLines += topAbsolute - from;
      from = topAbsolute;
    }
    for (let abs = from; abs < this._normalScrollCount; abs++) {
      const line = buffer.getLine(abs - topAbsolute);
      if (!line) break;
      let text = '';
      try { text = line.translateToString(true); } catch (_) { text = ''; }
      this._appendLogLine(text, !!line.isWrapped);
    }
    this._capturedUpTo = this._normalScrollCount;
  }

  /**
   * Append one committed line to the bounded log, trimming from the front on
   * either bound. `wrapped` is preserved so the history layer (P7) can rejoin
   * a logical line that the terminal split across rows.
   *
   * @private
   * @param {string} text
   * @param {boolean} wrapped
   */
  _appendLogLine(text, wrapped) {
    const entry = { t: text, w: wrapped };
    this._lineLog.push(entry);
    this._lineLogBytes += text.length * 2 + VT_LINE_ENTRY_OVERHEAD_BYTES;
    while (this._lineLog.length > VT_LINE_LOG_MAX_LINES ||
           (this._lineLogBytes > VT_LINE_LOG_MAX_BYTES && this._lineLog.length > 1)) {
      const removed = this._lineLog.shift();
      this._lineLogBytes -= removed.t.length * 2 + VT_LINE_ENTRY_OVERHEAD_BYTES;
      this._lineLogFirstIndex++;
      this._lineLogEvicted++;
    }
  }

  /**
   * Read a page of committed normal-buffer lines, newest-page-first paging by
   * absolute line index. This is the data source for the history layer's
   * `deep` segment (BUILD-CONTRACT P7.5); the HTTP route that exposes it is
   * P7's to add, so this module deliberately stops at the read API.
   *
   * @param {object} [opts]
   * @param {number} [opts.beforeLine] - Absolute index to page backwards from.
   *   Defaults to the end of the log.
   * @param {number} [opts.lines=2000] - Page size, clamped to [1, 10000].
   * @returns {{lines: Array<{t: string, w: boolean}>, firstLine: number,
   *            beforeLine: number, total: number, oldestAvailable: number,
   *            hasMore: boolean, lostLines: number}}
   */
  readLines({ beforeLine = null, lines = 2000 } = {}) {
    const oldest = this._lineLogFirstIndex;
    const end = this._lineLogFirstIndex + this._lineLog.length;
    const count = Math.max(1, Math.min(10000, Number(lines) || 2000));
    let before = beforeLine === null || beforeLine === undefined ? end : Number(beforeLine);
    if (!Number.isFinite(before)) before = end;
    before = Math.max(oldest, Math.min(end, before));
    const first = Math.max(oldest, before - count);
    return {
      lines: this._lineLog.slice(first - oldest, before - oldest),
      firstLine: first,
      beforeLine: before,
      total: end,
      oldestAvailable: oldest,
      hasMore: first > oldest,
      lostLines: this._lostLines,
    };
  }

  /**
   * Diagnostics for the health surface and for tests asserting the bounds are
   * actually enforced.
   *
   * @returns {object} Plain, allocation-free-ish summary. Never throws.
   */
  getStats() {
    let cols = 0;
    let rows = 0;
    try { cols = this.term.cols; rows = this.term.rows; } catch (_) {}
    return {
      sessionId: this.sessionId,
      disposed: this.disposed,
      degraded: this.degraded,
      cols,
      rows,
      writtenBytes: this._writtenBytes,
      droppedBytes: this._droppedBytes,
      pendingBytes: this._pendingBytes,
      lineLogLines: this._lineLog.length,
      lineLogBytes: this._lineLogBytes,
      lineLogFirstIndex: this._lineLogFirstIndex,
      lineLogEvicted: this._lineLogEvicted,
      lostLines: this._lostLines,
      scrolledLines: this._normalScrollCount,
      reflows: this._reflows,
      modeSeq: this._modeSeq,
    };
  }

  /**
   * Compare the live mode signal against the last emitted one and notify only
   * on a real change. Carries a monotonic `seq` so a client can discard a
   * reordered or duplicated frame without keeping its own history.
   *
   * @private
   */
  _emitModeIfChanged() {
    if (this.disposed || !this._onModeChange) return;
    const mode = this.getMode();
    if (!mode) return;
    const prev = this._lastMode;
    if (prev &&
        prev.altBuffer === mode.altBuffer &&
        prev.mouseTracking === mode.mouseTracking &&
        prev.bracketedPaste === mode.bracketedPaste) {
      return;
    }
    this._lastMode = mode;
    this._modeSeq++;
    const frame = {
      type: 'mode',
      altBuffer: mode.altBuffer,
      mouseTracking: mode.mouseTracking,
      bracketedPaste: mode.bracketedPaste,
      mouseTrackingActive: mode.mouseTrackingActive,
      seq: this._modeSeq,
    };
    try {
      this._onModeChange(frame);
    } catch (err) {
      this._logOnce('onModeChange threw: ' + (err && err.message));
    }
  }

  /**
   * The last mode frame this sidecar emitted, so a client attaching later can
   * be given the current signal without waiting for the next change.
   *
   * @returns {object|null} A `{type:'mode', ...}` frame, or null.
   */
  getModeFrame() {
    const mode = this.getMode();
    if (!mode) return null;
    if (!this._lastMode) {
      this._lastMode = mode;
      this._modeSeq++;
    }
    return {
      type: 'mode',
      altBuffer: mode.altBuffer,
      mouseTracking: mode.mouseTracking,
      bracketedPaste: mode.bracketedPaste,
      mouseTrackingActive: mode.mouseTrackingActive,
      seq: this._modeSeq,
    };
  }

  /**
   * Log a sidecar problem at most once per sidecar, so a repeating fault
   * cannot flood server.log. The sidecar is an optimisation; its noise floor
   * must stay below the signal from the session it shadows.
   *
   * @private
   * @param {string} message
   */
  _logOnce(message) {
    if (this._logged) return;
    this._logged = true;
    try {
      console.error('[VT] sidecar ' + this.sessionId + ': ' + message);
    } catch (_) { /* console can EPIPE; never fatal */ }
  }

  /**
   * Release the headless terminal and every listener. Idempotent.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this._disposables) {
      try { if (d && typeof d.dispose === 'function') d.dispose(); } catch (_) {}
    }
    this._disposables.length = 0;
    try { if (this._addon && typeof this._addon.dispose === 'function') this._addon.dispose(); } catch (_) {}
    this._addon = null;
    try { this.term.dispose(); } catch (_) {}
    this._lineLog.length = 0;
    this._lineLogBytes = 0;
    this._onModeChange = null;
  }
}

// ---------------------------------------------------------------------------
// VtSidecarRegistry
// ---------------------------------------------------------------------------

/**
 * Owns the set of live sidecars for one PtySessionManager and enforces the
 * concurrency cap. Instance-scoped rather than a module singleton so two
 * managers (or two tests) never share state.
 */
class VtSidecarRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSessions] - Override VT_SIDECAR_MAX_SESSIONS.
   * @param {Function} [opts.TerminalClass] - @private test-only injection.
   */
  constructor({ maxSessions = null, TerminalClass = null } = {}) {
    this.sidecars = new Map();
    this._maxSessions = maxSessions === null ? VT_SIDECAR_MAX_SESSIONS : maxSessions;
    this._TerminalClass = TerminalClass;
    this._capLogged = false;
    this._unavailableLogged = false;
  }

  /**
   * Whether the subsystem should run at all. Combines the feature flag with
   * the capability probe so callers ask one question.
   *
   * @returns {boolean}
   */
  isEnabled() {
    if (!isSidecarEnabled()) return false;
    if (this._TerminalClass) return true;
    return !!loadHeadless();
  }

  /**
   * Create a sidecar for a session, or return null when the subsystem is off,
   * unavailable, or at capacity. Never throws: every failure mode degrades to
   * the byte-ring path.
   *
   * @param {string} sessionId
   * @param {object} opts - Forwarded to the VtSidecar constructor.
   * @returns {VtSidecar|null}
   */
  create(sessionId, opts = {}) {
    if (!isSidecarEnabled()) return null;
    const existing = this.sidecars.get(sessionId);
    if (existing && !existing.disposed) return existing;

    if (!this._TerminalClass && !loadHeadless()) {
      if (!this._unavailableLogged) {
        this._unavailableLogged = true;
        try {
          console.error(
            '[VT] headless VT unavailable; terminal snapshot replay and the ' +
            'mode signal are disabled, the byte-ring replay path continues ' +
            'unchanged. Detail: ' +
            (_headlessLoadError ? _headlessLoadError.message : 'unknown load failure')
          );
        } catch (_) {}
      }
      return null;
    }

    if (this.sidecars.size >= this._maxSessions) {
      if (!this._capLogged) {
        this._capLogged = true;
        try {
          console.log('[VT] sidecar cap reached (' + this._maxSessions + '); further sessions use the byte ring');
        } catch (_) {}
      }
      return null;
    }

    try {
      const sidecar = new VtSidecar(Object.assign({ sessionId, TerminalClass: this._TerminalClass }, opts));
      this.sidecars.set(sessionId, sidecar);
      return sidecar;
    } catch (err) {
      try {
        console.error('[VT] failed to create sidecar for ' + sessionId + ': ' + (err && err.message));
      } catch (_) {}
      return null;
    }
  }

  /**
   * @param {string} sessionId
   * @returns {VtSidecar|undefined}
   */
  get(sessionId) {
    return this.sidecars.get(sessionId);
  }

  /**
   * Dispose and forget one sidecar. Idempotent.
   *
   * @param {string} sessionId
   * @returns {boolean} True when a sidecar existed.
   */
  dispose(sessionId) {
    const sidecar = this.sidecars.get(sessionId);
    if (!sidecar) return false;
    this.sidecars.delete(sessionId);
    try { sidecar.dispose(); } catch (_) {}
    return true;
  }

  /** Dispose every sidecar. Called on server shutdown. */
  disposeAll() {
    for (const sessionId of Array.from(this.sidecars.keys())) {
      this.dispose(sessionId);
    }
  }

  /**
   * @returns {{enabled: boolean, count: number, maxSessions: number,
   *            sidecars: Array<object>}}
   */
  getStats() {
    const sidecars = [];
    for (const sidecar of this.sidecars.values()) {
      try { sidecars.push(sidecar.getStats()); } catch (_) {}
    }
    return {
      enabled: this.isEnabled(),
      count: this.sidecars.size,
      maxSessions: this._maxSessions,
      sidecars,
    };
  }
}

module.exports = {
  VtSidecar,
  VtSidecarRegistry,
  getVtSidecarAvailability,
  isSidecarEnabled,
  isSnapshotReplayEnabled,
  serializeTerminal,
  serializePrivateModes,
  VT_UNAVAILABLE_CODE,
  VT_SIDECAR_MAX_SESSIONS,
  VT_SIDECAR_SCROLLBACK,
  VT_LINE_LOG_MAX_LINES,
  VT_LINE_LOG_MAX_BYTES,
  VT_WRITE_QUEUE_MAX_BYTES,
  VT_SNAPSHOT_MAX_CHARS,
  VT_LINE_CAPTURE_BATCH,
  VT_TRACKED_PRIVATE_MODES,
  VT_RESTORED_PRIVATE_MODES,
  VT_SNAPSHOT_PREAMBLE,
  // @private test seams: pure helpers the golden-stream tests exercise
  // directly, plus the lazy loaders so a test can assert containment.
  __test: { serializeLine, sgrFor, attrSignature, loadHeadless, loadSerializeAddon, envInt },
};
