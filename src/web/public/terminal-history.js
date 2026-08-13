/**
 * terminal-history.js - the Unified Scrollback Surface history layer.
 * Created: 2026-08-13, Notion restyle phase P7 (terminal stages 3 and 4).
 * BUILD-CONTRACT.md P7.1 to P7.6, TERMINAL-ARCHITECTURE.md sections 7 to 12.
 *
 * WHAT PROBLEM THIS FILE SOLVES
 *
 * "You cannot drag up and copy history." Measured against ten live PTY
 * sessions (TERMINAL-ARCHITECTURE.md section 2), the reason is not a bug in
 * this application: an agent CLI enters the ALTERNATE buffer and then repaints
 * by absolute cursor addressing only. Zero scroll sequences, zero scroll
 * regions, zero index or reverse-index, across every sample including a 100 KB
 * one. A terminal cannot capture scrollback from a viewport that never
 * scrolls, so for those panes there is no terminal-layer history to reach, in
 * this application or in Windows Terminal or in iTerm2.
 *
 * The history that DOES exist lives in two other places, and this file is the
 * one surface that reaches both by scroll position instead of by a button:
 *
 *   NORMAL-buffer panes (a shell, a build, a REPL) have real terminal
 *   scrollback. xterm's own ring is primary for short lookback; the server's
 *   VT sidecar keeps a deep line log for everything older, read through
 *   GET /api/sessions/:id/history.
 *
 *   ALTERNATE-buffer panes (every agent CLI) have the session TRANSCRIPT on
 *   disk, which the mirror API already publishes read-only and paged. That is
 *   the only correct source for the conversation, and it is the one source
 *   that survives a session restart.
 *
 * THE FOUR RULINGS THIS FILE IMPLEMENTS, each of which was a decision rather
 * than an implementation detail:
 *
 *   1. THE DOCUMENT CONTAINS THE CURRENT SCREEN AS ITS LAST SEGMENT.
 *      TERMINAL-ARCHITECTURE 8.6: "not possible, and not needed" to select
 *      ACROSS the boundary, because there is no boundary to cross. Once the
 *      layer is open it holds everything INCLUDING what is on screen, so one
 *      drag from the bottom of the document to any point above it selects a
 *      contiguous range with no seam and no special case. This is the whole
 *      answer to the user's sentence.
 *
 *   2. FREEZE THE MIRROR, NOT THE STREAM. Select mode v3 freezes the PTY WRITE
 *      PIPELINE while a selection is held, which is a sound answer to "xterm
 *      anchors a selection to absolute buffer coordinates and a repaint
 *      invalidates it" and a heavy one: reading text stops the terminal.
 *      A selection over DOM text nodes cannot be repainted by PTY output, so
 *      the only thing that has to pause here is the periodic textContent swap
 *      of the live segment. Pausing it costs nothing, has no queue, has no
 *      overflow valve, and is invisible. The PTY never stops (requirement A9
 *      holds by construction).
 *
 *   3. THE SEAM IS A DELIBERATE ONE-TURN OVERLAP, NEVER A HEURISTIC JOIN.
 *      The transcript tailer is live, so its newest message and the live frame
 *      often restate the same turn. Computing the join point means matching
 *      semantic text against a width-wrapped, ANSI-decorated frame, which is
 *      fragile and fails SILENTLY. A visible duplicate is honest; a false
 *      positive deletes real conversation out of a copy. Section 7.4 settles
 *      it, and vt-sidecar.js settles the identical question the same way for
 *      its own resize seams.
 *
 *   4. ROUTING IS BY BUFFER MODE, NEVER BY PROVIDER. One pane crosses the
 *      boundary: a shell where the user types `claude` moves from normal to
 *      alternate and back on exit. The predicate is re-evaluated live, and the
 *      server mode frame is an UPGRADE over xterm's own buffer type, never a
 *      dependency, because CWM_VT_SIDECAR defaults off.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 *   It does not hold a live mirror subscription. Section 12: the layer "opens
 *   a mirror, reads one window, and closes immediately", so the ten-watcher
 *   limit is never consumed by a pane the user is merely reading. The LIVE
 *   segment is what stays live.
 *
 *   It does not touch Select mode. Every v1, v2 and v3 identifier is preserved
 *   verbatim in terminal.js; Select mode keeps exactly one job (make a plain
 *   drag select on the LIVE screen under mouse tracking) and this layer never
 *   engages its hold.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function exposeTerminalHistory(root, factory) {
  'use strict';

  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.TerminalHistory = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTerminalHistory() {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     LIMITS (TERMINAL-ARCHITECTURE.md 11.2)
     Every one of these is a bound rather than a preference, and each
     names the failure it exists to prevent.
     ═══════════════════════════════════════════════════════════════════ */

  // One page of the history document. Matches HISTORY_PAGE_LINES in 11.2 and
  // the server route's own clamp, so a page request is never silently halved.
  var HISTORY_PAGE_LINES = 2000;

  // Page backwards when the reader is within this many viewports of the top.
  // Two is enough that the fetch completes before the reader arrives at the
  // seam on any link a browser will tolerate, and small enough that idle
  // scrolling does not pull the whole file.
  var HISTORY_PREFETCH_VIEWPORTS = 2;

  // Ceiling on lines held in the DOM at once. Beyond it the OLDEST loaded
  // lines are trimmed; they are re-fetchable, because paging is by absolute
  // cursor rather than by "what is loaded". Node count, not bytes, is what
  // makes a document scroll badly.
  var HISTORY_MAX_LOADED_LINES = 40000;

  // Ceiling on the live segment before it is rebalanced into the segment above
  // it. A build running while the layer is open would otherwise grow one text
  // node without limit. The rebalance moves text between two adjacent nodes and
  // therefore shifts NOTHING on screen.
  var HISTORY_LIVE_SEGMENT_MAX_LINES = 4000;

  // How long after a forwarded wheel notch the application has to produce
  // output before its own history counts as exhausted (8.2). 140ms is longer
  // than any local repaint and shorter than a notch-to-notch interval.
  var WHEEL_EXHAUSTION_MS = 140;

  // How long an exhaustion verdict stays valid. Without this a pane that was
  // idle ten minutes ago would open the layer on the first wheel notch of a
  // completely new gesture, which is not what the user asked for.
  var WHEEL_ESCALATION_TTL_MS = 4000;

  // Rows a plain wheel notch moves inside the layer when the browser reports a
  // pixel delta we do not want to trust verbatim.
  var HISTORY_WHEEL_LINES = 3;

  // Open and close animation, honouring reduced motion through the pane's own
  // gate. One row of translate, per 8.1.
  var HISTORY_ANIMATION_MS = 160;

  // The quiet overlay scrollbar (8.3, P7.4).
  var HISTORY_SCROLLBAR_WIDTH_PX = 6;
  var HISTORY_SCROLLBAR_FADE_MS = 900;
  var HISTORY_SCROLLBAR_MIN_THUMB_PX = 24;

  // Stacking. The pane ladder is: terminal (flow), Select strip 4, floating
  // action buttons 5, copy hint 30, Copy view overlay 40. The history layer is
  // a READING surface rather than a modal, so it sits above the terminal and
  // below the pane's own controls: the upload and schedule buttons stay
  // clickable while history is open, and the Copy view still opens over it.
  var HISTORY_LAYER_Z_INDEX = 4;

  // Bytes requested per transcript page. Same value the Copy view uses, and
  // the server clamps it to its own window cap, so this is a request rather
  // than a guarantee.
  var HISTORY_TRANSCRIPT_PAGE_BYTES = 262144;

  // Runs of this many blank lines or more collapse to one in the ARCHIVED
  // segments. The live segment is never collapsed: its blank rows are the
  // frame's own layout and collapsing them would break the pixel match with
  // the live screen, which is the one thing that must not happen.
  var HISTORY_BLANK_RUN_LIMIT = 3;

  // Upper bound on the reflow-seam dedupe window, in lines. vt-sidecar.js can
  // repeat up to |delta rows| lines around a widen and counts the seams; this
  // caps how far back a dedupe may look so the cost stays linear and so a
  // genuinely repeated log line far from a seam can never be eaten.
  var HISTORY_SEAM_DEDUPE_MAX_LINES = 240;

  // Lines of dedupe budget granted per counted reflow.
  var HISTORY_SEAM_DEDUPE_PER_REFLOW = 60;

  // Characters of a tool payload kept on its one-line summary in a rendered
  // transcript. Same value and same reasoning as the Copy view.
  var HISTORY_TRANSCRIPT_TOOL_CHARS = 120;

  // The four segment ids, oldest first. The order is fixed and is the same for
  // both routes, which is what lets one document serve a shell and an agent.
  var SEGMENT_IDS = ['deep', 'ring', 'transcript', 'live'];

  // The two history sources the router chooses between (7.2).
  var SOURCE_TRANSCRIPT = 'transcript';
  var SOURCE_NATIVE = 'native';

  /* ═══════════════════════════════════════════════════════════════════
     PURE HELPERS
     Every function below is side-effect free and DOM-free so the router
     truth table, the paging cursor and the seam arithmetic are unit
     testable without a browser (test/terminal-history.test.js).
     ═══════════════════════════════════════════════════════════════════ */

  /**
   * Whether the pane's application currently owns the ALTERNATE buffer.
   *
   * Two sources in falling order of authority, and the fallback is mandatory:
   * the server mode frame is behind CWM_VT_SIDECAR and defaults OFF, so a
   * client that hard-depended on it would have no router at all on a default
   * install.
   *
   * @param {object|null} modeFrame - The last `{type:'mode', ...}` frame, or null.
   * @param {object|null} term - The live xterm instance, or null.
   * @returns {boolean} True when an alternate-screen application is running.
   */
  function resolveAltBuffer(modeFrame, term) {
    if (modeFrame && typeof modeFrame.altBuffer === 'boolean') return modeFrame.altBuffer;
    try {
      return !!(term && term.buffer && term.buffer.active &&
        term.buffer.active.type === 'alternate');
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether the application currently has the mouse.
   *
   * `mouseTracking` IS A STRING ENUM ('none', 'x10', 'vt200', 'drag', 'any')
   * and must never be truthy-tested: the string 'none' is truthy, so a truthy
   * test reports mouse tracking on for every pane that has ever answered the
   * question. P6 publishes `mouseTrackingActive` precisely so a consumer does
   * not have to know the enum, and this function prefers it.
   *
   * @param {object|null} modeFrame - The last mode frame, or null.
   * @param {object|null} term - The live xterm instance, or null.
   * @returns {boolean} True when the wheel belongs to the application.
   */
  function resolveMouseTrackingActive(modeFrame, term) {
    if (modeFrame && typeof modeFrame.mouseTrackingActive === 'boolean') {
      return modeFrame.mouseTrackingActive;
    }
    if (modeFrame && typeof modeFrame.mouseTracking === 'string') {
      return modeFrame.mouseTracking !== 'none' && modeFrame.mouseTracking !== '';
    }
    try {
      var mode = term && term.modes ? term.modes.mouseTrackingMode : null;
      return typeof mode === 'string' && mode !== 'none' && mode !== '';
    } catch (_) {
      return false;
    }
  }

  /**
   * The routing rule, 7.2, as one pure predicate.
   *
   * Keyed on the live BUFFER MODE rather than on the provider, because a
   * single pane crosses the boundary in both directions during its life. A
   * pane with no resolvable transcript identity (a brand new session whose CLI
   * has not written its first line yet) routes to the native path, which still
   * has the live screen and whatever the normal buffer holds, rather than to
   * an error.
   *
   * @param {{altBuffer: boolean, hasTranscript: boolean}} state - Live state.
   * @returns {string} SOURCE_TRANSCRIPT or SOURCE_NATIVE.
   */
  function routeHistorySource(state) {
    var s = state || {};
    if (s.altBuffer && s.hasTranscript) return SOURCE_TRANSCRIPT;
    return SOURCE_NATIVE;
  }

  /**
   * Rejoin the logical lines a terminal split across rows.
   *
   * The deep line log stores one entry per ROW with `w` (isWrapped) set on
   * every row that is the continuation of the row above it. A history document
   * is `white-space: pre-wrap` at the pane's own width, so re-emitting the
   * terminal's hard wrap would wrap the text twice: once where the terminal
   * broke it and again where the pane does. Rejoining restores the logical
   * line and lets the surface wrap it exactly where the live terminal does.
   *
   * @param {Array<{t: string, w: boolean}>} entries - Row entries, oldest first.
   * @returns {string[]} Logical lines, oldest first.
   */
  function joinWrappedLines(entries) {
    var out = [];
    var list = Array.isArray(entries) ? entries : [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i] || {};
      var text = typeof entry.t === 'string' ? entry.t : '';
      // A wrapped row belongs to the line above it, unless it is the first row
      // of the page, in which case the line above was never loaded and the row
      // has to stand on its own rather than be dropped.
      if (entry.w && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    return out;
  }

  /**
   * Where to start paging the deep log so the first page is strictly OLDER
   * than what the client already holds.
   *
   * The client's own ring already shows `clientCommitted` committed lines, and
   * the server's log holds `total` of them from the same byte stream. Skipping
   * the newest `clientCommitted` server lines is therefore the alignment, and
   * it is an ASSUMPTION rather than a proof: a client that was reset by a
   * resync, or a server that reflowed, can be off by a bounded number of
   * lines. The failure mode is a visible duplicate at the seam, never a
   * deletion, which is the same trade 7.4 makes for the transcript seam.
   *
   * @param {{total: number, oldestAvailable: number, clientCommitted: number}} state
   * @returns {number} The absolute cursor to page backwards from.
   */
  function deepStartCursor(state) {
    var s = state || {};
    var total = Number.isFinite(s.total) ? s.total : 0;
    var oldest = Number.isFinite(s.oldestAvailable) ? s.oldestAvailable : 0;
    var client = Number.isFinite(s.clientCommitted) ? Math.max(0, s.clientCommitted) : 0;
    return Math.max(oldest, Math.min(total, total - client));
  }

  /**
   * The cursor for the NEXT page backwards, or null when the log is exhausted.
   *
   * @param {object|null} page - A page as returned by the history route.
   * @returns {number|null} The next `beforeLine`, or null.
   */
  function nextDeepCursor(page) {
    if (!page || !page.hasMore) return null;
    if (!Number.isFinite(page.firstLine)) return null;
    if (Number.isFinite(page.oldestAvailable) && page.firstLine <= page.oldestAvailable) return null;
    return page.firstLine;
  }

  /**
   * How many lines a dedupe may look back across, given the seam count.
   *
   * Zero reflows means the log is monotonic and no dedupe is permitted at all,
   * which is the property that keeps a genuinely repeated log line (a repeated
   * prompt, a repeated build warning) out of the dedupe's reach.
   *
   * @param {number} reflows - `getStats().reflows` for this session.
   * @returns {number} Window size in lines.
   */
  function seamDedupeWindow(reflows) {
    var count = Number.isFinite(reflows) ? Math.max(0, reflows) : 0;
    if (count === 0) return 0;
    return Math.min(HISTORY_SEAM_DEDUPE_MAX_LINES, count * HISTORY_SEAM_DEDUPE_PER_REFLOW);
  }

  /**
   * Length of the longest run of lines that is BOTH the tail of `older` and the
   * head of `newer`, within a bounded window.
   *
   * Used when prepending a page: the sidecar's line log can repeat up to
   * |delta rows| lines around a resize seam, and it counts the seams so a
   * consumer can dedupe at render time. Only an exact, contiguous, bounded
   * match is removed, so the operation can never delete content that merely
   * looks similar.
   *
   * @param {string[]} older - The page about to be prepended.
   * @param {string[]} newer - The lines already at the top of the document.
   * @param {number} window - Maximum overlap to consider, from seamDedupeWindow.
   * @returns {number} Number of tail lines of `older` to drop.
   */
  function trailingOverlap(older, newer, window) {
    var a = Array.isArray(older) ? older : [];
    var b = Array.isArray(newer) ? newer : [];
    var max = Math.min(window || 0, a.length, b.length);
    for (var len = max; len > 0; len--) {
      var same = true;
      for (var i = 0; i < len; i++) {
        if (a[a.length - len + i] !== b[i]) { same = false; break; }
      }
      if (same) return len;
    }
    return 0;
  }

  /**
   * Read a half-open range of rows out of an xterm buffer as plain text.
   *
   * Defensive by row: a line that cannot be read becomes blank rather than
   * aborting the read, because a partially readable document is far more
   * useful than an exception inside a render.
   *
   * @param {object} buf - An xterm IBuffer.
   * @param {number} from - First row index, inclusive.
   * @param {number} to - Last row index, exclusive.
   * @returns {string[]} One entry per row.
   */
  function readBufferRange(buf, from, to) {
    var out = [];
    if (!buf || typeof buf.getLine !== 'function') return out;
    var len = typeof buf.length === 'number' ? buf.length : 0;
    var start = Math.max(0, Math.min(len, Math.floor(from || 0)));
    var end = Math.max(start, Math.min(len, Math.floor(to === undefined ? len : to)));
    for (var i = start; i < end; i++) {
      var text = '';
      try {
        var line = buf.getLine(i);
        if (line && typeof line.translateToString === 'function') {
          text = line.translateToString(true) || '';
        }
      } catch (_) {
        text = '';
      }
      out.push(text);
    }
    return out;
  }

  /**
   * Collapse padding runs in an ARCHIVED segment.
   *
   * Mirrors the Copy view's rule (COPY_VIEW_BLANK_RUN_LIMIT) rather than
   * importing it, so this module loads and tests standalone. Deliberately NOT
   * applied to the live segment: see HISTORY_BLANK_RUN_LIMIT.
   *
   * @param {string[]} lines - Raw lines in document order.
   * @returns {string[]} Cleaned lines.
   */
  function collapseBlankRuns(lines) {
    var out = [];
    var run = 0;
    var list = Array.isArray(lines) ? lines : [];
    for (var i = 0; i < list.length; i++) {
      var line = typeof list[i] === 'string' ? list[i] : '';
      if (line.trim() === '') { run++; continue; }
      if (run > 0) {
        if (out.length > 0) {
          var keep = run >= HISTORY_BLANK_RUN_LIMIT ? 1 : run;
          for (var k = 0; k < keep; k++) out.push('');
        }
        run = 0;
      }
      out.push(line);
    }
    return out;
  }

  /**
   * Render mirror transcript messages as plain text.
   *
   * Shape follows the Copy view's Full-transcript rendering so the two
   * surfaces describe the same conversation the same way: a role label per
   * turn, tool events collapsed to one labelled line, truncation marked rather
   * than silent. Prior art reused deliberately (13.2 asks for exactly this).
   *
   * @param {Array} messages - Mirror messages, oldest first.
   * @returns {string[]} Lines, oldest first.
   */
  function renderTranscriptLines(messages) {
    var list = Array.isArray(messages) ? messages : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m !== 'object') continue;
      var text = typeof m.text === 'string' ? m.text : '';
      var truncatedTag = m.truncated ? ' [truncated]' : '';
      if (m.kind === 'tool_use' || m.kind === 'tool_result') {
        var label = m.kind === 'tool_use'
          ? ('tool: ' + (m.toolName ? String(m.toolName) : 'unknown'))
          : 'tool result';
        var firstLine = text.split('\n')[0].slice(0, HISTORY_TRANSCRIPT_TOOL_CHARS);
        out.push('[' + label + ']' + (firstLine ? ' ' + firstLine : '') + truncatedTag);
        continue;
      }
      var role = typeof m.role === 'string' && m.role ? m.role : 'assistant';
      var roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
      var model = (role === 'assistant' && m.model) ? ' (' + String(m.model) + ')' : '';
      out.push(roleLabel + model + ':');
      var body = (text + truncatedTag).split('\n');
      for (var b = 0; b < body.length; b++) out.push(body[b]);
      out.push('');
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  /**
   * Convert a wheel event into a signed row count.
   *
   * Same normalisation the Select-mode wheel guard performs, for the same
   * reason: browsers report deltas in three units and the pixel magnitude
   * varies wildly by device. Positive means toward newer output.
   *
   * @param {object} ev - A WheelEvent or a stub carrying deltaY/deltaMode.
   * @param {number} rows - Viewport height in rows, for page-mode deltas.
   * @returns {number} Signed row count; 0 when there is nothing to scroll.
   */
  function wheelLines(ev, rows) {
    var dy = (ev && typeof ev.deltaY === 'number') ? ev.deltaY : 0;
    if (!dy) return 0;
    var mode = (ev && typeof ev.deltaMode === 'number') ? ev.deltaMode : 0;
    if (mode === 1) return Math.round(dy) || (dy > 0 ? 1 : -1);
    if (mode === 2) {
      var page = Math.max(1, rows || HISTORY_WHEEL_LINES);
      return (Math.round(dy) || (dy > 0 ? 1 : -1)) * page;
    }
    return dy > 0 ? HISTORY_WHEEL_LINES : -HISTORY_WHEEL_LINES;
  }

  /**
   * Whether a keyboard event is a plain printable character.
   *
   * This is what makes the surface modeless: 8.4's last row says the way out
   * of history is to start typing, exactly as in a native terminal. Modifier
   * combinations are excluded (Ctrl+C must copy, not dismiss), and so are the
   * named keys, whose `key` is longer than one code point.
   *
   * @param {object} e - A KeyboardEvent or a stub.
   * @returns {boolean} True when the key should dismiss the layer and be sent.
   */
  function isPrintableKey(e) {
    if (!e || typeof e.key !== 'string') return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    // Array.from counts code points, so an emoji or an astral character from
    // an IME still reads as one key rather than as two UTF-16 units.
    return Array.from(e.key).length === 1;
  }

  /* ═══════════════════════════════════════════════════════════════════
     THE LAYER
     ═══════════════════════════════════════════════════════════════════ */

  /**
   * The history surface for one terminal pane.
   *
   * Owned by its TerminalPane, created lazily on the first open, and torn down
   * by detachHostBindings / dispose exactly like the Copy view overlay, because
   * it is hosted on the pane element and fixed grid slots are reused across tab
   * groups.
   *
   * Every method is written to be safe on a pane whose terminal, host or socket
   * has gone away: this surface must never be the reason a terminal breaks.
   */
  function TerminalHistoryLayer(pane) {
    this.pane = pane || null;
    this.root = null;
    this.doc = null;
    this.pagingEl = null;
    this.ruleEl = null;
    this.segments = {};
    this.scrollbarEl = null;
    this.thumbEl = null;

    this._open = false;
    this._frozen = false;
    this._destroyed = false;

    // Segment contents, kept as arrays so paging can prepend and the seam
    // dedupe can compare without re-parsing textContent.
    this._lines = { deep: [], ring: [], transcript: [], live: [] };

    // Paging cursors. null means "not started"; false means "exhausted".
    this._deepCursor = null;
    this._deepExhausted = false;
    this._deepReflows = 0;
    this._transcriptOffset = null;
    this._transcriptExhausted = false;
    this._loading = false;

    // The live segment's anchor: the buffer row the live segment starts at.
    // Captured at open so that output arriving while the layer is open extends
    // the BOTTOM of the document and never moves what the reader is looking at.
    this._liveAnchor = 0;
    this._lastBufferLength = 0;

    this._source = SOURCE_NATIVE;
    this._refreshRaf = null;
    this._dirty = false;
    this._scrollbarTimer = null;
    this._selectionHandler = null;
    this._resizeObserver = null;

    // Wheel escalation state (8.2). `_wheelExhaustedAt` is the moment the
    // application was judged to have no more history of its own.
    this._wheelProbeTimer = null;
    this._wheelForwardedAt = 0;
    this._lastOutputAt = 0;
    this._wheelExhaustedAt = 0;
  }

  /** @returns {boolean} Whether the layer is currently open. */
  TerminalHistoryLayer.prototype.isOpen = function isOpen() {
    return !!this._open;
  };

  /** @returns {boolean} Whether the live-segment refresh is paused. */
  TerminalHistoryLayer.prototype.isFrozen = function isFrozen() {
    return !!this._frozen;
  };

  /**
   * The live xterm instance, or null when the pane has none.
   * @returns {object|null} The terminal.
   */
  TerminalHistoryLayer.prototype._term = function _term() {
    return (this.pane && this.pane.term) ? this.pane.term : null;
  };

  /**
   * Resolve the current route (7.2), re-evaluated on every open and on every
   * buffer change rather than cached at construction.
   *
   * @returns {string} SOURCE_TRANSCRIPT or SOURCE_NATIVE.
   */
  TerminalHistoryLayer.prototype.resolveSource = function resolveSource() {
    var pane = this.pane || {};
    var modeFrame = pane._remoteModeFrame || null;
    var hasTranscript = false;
    try {
      hasTranscript = !!(typeof pane._copyViewIdentity === 'function' && pane._copyViewIdentity());
    } catch (_) {
      hasTranscript = false;
    }
    return routeHistorySource({
      altBuffer: resolveAltBuffer(modeFrame, this._term()),
      hasTranscript: hasTranscript,
    });
  };

  /** @returns {boolean} Whether the application currently owns the mouse. */
  TerminalHistoryLayer.prototype.mouseTrackingActive = function mouseTrackingActive() {
    var pane = this.pane || {};
    return resolveMouseTrackingActive(pane._remoteModeFrame || null, this._term());
  };

  /** @returns {boolean} Whether an alternate-screen application is running. */
  TerminalHistoryLayer.prototype.altBuffer = function altBuffer() {
    var pane = this.pane || {};
    return resolveAltBuffer(pane._remoteModeFrame || null, this._term());
  };

  /* ── DOM ─────────────────────────────────────────────────────── */

  /**
   * Build the layer DOM once and return its root.
   *
   * Hosted on the PANE element rather than on the terminal container, for the
   * two reasons the Copy view is: the pane is the positioned ancestor, and the
   * mobile touch engine's capture-phase handlers live on the container, so a
   * surface outside it scrolls natively on touch instead of fighting them.
   * The rect is then measured from the container so the layer covers exactly
   * the pane body and the header and the input row never move (10.4).
   *
   * @returns {HTMLElement|null} The root element, or null with no host.
   */
  TerminalHistoryLayer.prototype._ensureDom = function _ensureDom() {
    if (this.root) return this.root;
    if (this._destroyed) return null;
    if (typeof document === 'undefined') return null;
    var host = this._host();
    if (!host) return null;

    var root = document.createElement('div');
    root.className = 'terminal-history';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Terminal history');
    root.hidden = true;
    root.style.display = 'none';
    root.style.zIndex = String(HISTORY_LAYER_Z_INDEX);

    var doc = document.createElement('div');
    doc.className = 'terminal-history-doc';
    // Focusable for accessibility and explicit Tab access, but NEVER focused
    // on open: the terminal keeps the keyboard so that typing dismisses (8.8).
    doc.tabIndex = 0;

    var paging = document.createElement('div');
    paging.className = 'terminal-history-paging';
    paging.setAttribute('role', 'status');
    paging.hidden = true;
    doc.appendChild(paging);

    for (var i = 0; i < SEGMENT_IDS.length; i++) {
      var id = SEGMENT_IDS[i];
      if (id === 'live') {
        // The seam. A single hairline in the palette's own rule colour, no
        // label and no banner: it reads as structure rather than as a mode.
        // The title attribute carries the explanation for a screen reader and
        // for a hover, which is where an explanation belongs.
        var rule = document.createElement('div');
        rule.className = 'terminal-history-rule';
        rule.setAttribute('title',
          'Below this line is the current screen. The newest turn can appear on both sides of it.');
        rule.hidden = true;
        doc.appendChild(rule);
        this.ruleEl = rule;
      }
      var seg = document.createElement('pre');
      seg.className = 'terminal-history-seg';
      seg.dataset.seg = id;
      seg.hidden = true;
      doc.appendChild(seg);
      this.segments[id] = seg;
    }

    var scrollbar = document.createElement('div');
    scrollbar.className = 'terminal-history-scrollbar';
    scrollbar.setAttribute('aria-hidden', 'true');
    var thumb = document.createElement('div');
    thumb.className = 'terminal-history-thumb';
    scrollbar.appendChild(thumb);

    root.appendChild(doc);
    root.appendChild(scrollbar);
    host.appendChild(root);

    this.root = root;
    this.doc = doc;
    this.pagingEl = paging;
    this.scrollbarEl = scrollbar;
    this.thumbEl = thumb;

    this._bindDomEvents();
    return root;
  };

  /**
   * The element the layer is parented on.
   * @returns {HTMLElement|null} The pane element, or null.
   */
  TerminalHistoryLayer.prototype._host = function _host() {
    var pane = this.pane;
    if (!pane) return null;
    if (pane.paneEl) return pane.paneEl;
    try {
      if (typeof pane._getOwnedContainer === 'function') return pane._getOwnedContainer();
    } catch (_) { /* an unhosted pane simply cannot show a layer */ }
    return null;
  };

  /**
   * The terminal container element, which is the rect the layer must cover and
   * the element whose ground it must match.
   * @returns {HTMLElement|null} The container, or null.
   */
  TerminalHistoryLayer.prototype._container = function _container() {
    var pane = this.pane;
    if (!pane) return null;
    try {
      if (typeof pane._getOwnedContainer === 'function') return pane._getOwnedContainer();
    } catch (_) { /* fall through */ }
    return null;
  };

  /** Wire the layer's own listeners. Idempotent through _ensureDom. */
  TerminalHistoryLayer.prototype._bindDomEvents = function _bindDomEvents() {
    var self = this;

    this.doc.addEventListener('scroll', function onScroll() {
      self._onScroll();
    }, { passive: true });

    // The bottom boundary. Passing the bottom of the document closes the layer
    // and pins live (8.1), which is the half of the gesture that makes the
    // surface feel like one continuous scroll axis rather than an overlay.
    this.doc.addEventListener('wheel', function onWheel(e) {
      self._onDocWheel(e);
    }, { passive: false });

    // Keys typed while the layer itself holds focus (the user clicked into the
    // document to select). The terminal cannot see these, so the layer answers
    // them with the same rules 8.4 gives, and forwards a printable key to the
    // PTY itself so that typing still means typing.
    this.doc.addEventListener('keydown', function onKey(e) {
      self._onDocKey(e);
    });

    // A click inside the layer must not reach the pane's own click handling
    // (which refocuses the terminal and would fight a selection drag).
    this.root.addEventListener('mousedown', function onDown(e) { e.stopPropagation(); });
    this.root.addEventListener('click', function onClick(e) { e.stopPropagation(); });
  };

  /* ── metrics (P7.2) ──────────────────────────────────────────── */

  /**
   * Derive typography and geometry from the LIVE xterm instance.
   *
   * TERMINAL-ARCHITECTURE 10.3 is unambiguous about the direction: the
   * terminal's metrics win inside the terminal region, and the layer reads
   * them from the instance rather than from a stylesheet. 10.1 is why: one
   * pixel of line-height difference, or one shade of ground, and the seam is
   * immediately visible and the illusion of one continuous terminal collapses.
   *
   * The row height is MEASURED from a rendered row where one exists, because
   * that is the number the DOM renderer actually used; the fontSize times
   * lineHeight product is the fallback for a pane that has not painted yet.
   *
   * Re-derived on open, on theme change and on rebind, never cached across
   * them.
   *
   * @returns {boolean} Whether metrics were applied.
   */
  TerminalHistoryLayer.prototype.applyMetrics = function applyMetrics() {
    if (!this.root || typeof window === 'undefined') return false;
    var term = this._term();
    var container = this._container();
    var host = this._host();
    if (!term || !container || !host) return false;

    var options = term.options || {};
    var fontSize = typeof options.fontSize === 'number' ? options.fontSize : 13;
    var lineHeightMult = typeof options.lineHeight === 'number' ? options.lineHeight : 1.2;
    var fontFamily = options.fontFamily || 'monospace';
    var letterSpacing = typeof options.letterSpacing === 'number' ? options.letterSpacing : 0;

    var screenEl = null;
    var rowEl = null;
    try {
      screenEl = container.querySelector('.xterm-screen');
      rowEl = container.querySelector('.xterm-rows > div');
    } catch (_) { /* a container without a painted terminal measures nothing */ }

    // Read the resolved values off the live surface where they exist: xterm
    // resolves its own font stack, and a webfont that swapped in after mount
    // changes the metric without changing term.options.
    var rowHeightPx = 0;
    try {
      if (rowEl && typeof rowEl.getBoundingClientRect === 'function') {
        rowHeightPx = rowEl.getBoundingClientRect().height;
      }
    } catch (_) { rowHeightPx = 0; }
    if (!rowHeightPx) rowHeightPx = Math.round(fontSize * lineHeightMult);

    var resolvedFamily = fontFamily;
    var resolvedSize = fontSize + 'px';
    try {
      if (screenEl && typeof window.getComputedStyle === 'function') {
        var cs = window.getComputedStyle(screenEl);
        if (cs) {
          if (cs.fontFamily) resolvedFamily = cs.fontFamily;
          if (cs.fontSize) resolvedSize = cs.fontSize;
          if (cs.letterSpacing && cs.letterSpacing !== 'normal') letterSpacing = parseFloat(cs.letterSpacing) || 0;
        }
      }
    } catch (_) { /* keep the option-derived values */ }

    // The rect. Measured from the container so the layer covers exactly the
    // pane body: the header above it and the input row below it never move.
    try {
      var cRect = container.getBoundingClientRect();
      var hRect = host.getBoundingClientRect();
      this.root.style.position = 'absolute';
      this.root.style.top = (cRect.top - hRect.top) + 'px';
      this.root.style.left = (cRect.left - hRect.left) + 'px';
      this.root.style.width = cRect.width + 'px';
      this.root.style.height = cRect.height + 'px';
    } catch (_) { /* an unlaid-out pane gets the stylesheet's inset:0 */ }

    // Horizontal padding measured from the live screen so column 1 lands on
    // the same x coordinate (10.3's last row). Falls back to the container's
    // own computed padding, which is what the terminal surface token sets.
    var padLeft = 0;
    var padTop = 0;
    try {
      if (screenEl) {
        var sRect = screenEl.getBoundingClientRect();
        var kRect = container.getBoundingClientRect();
        padLeft = Math.max(0, Math.round(sRect.left - kRect.left));
        padTop = Math.max(0, Math.round(sRect.top - kRect.top));
      }
      if (!padLeft && typeof window.getComputedStyle === 'function') {
        var kcs = window.getComputedStyle(container);
        padLeft = parseFloat(kcs.paddingLeft) || 0;
        padTop = parseFloat(kcs.paddingTop) || 0;
      }
    } catch (_) { /* zero padding is a visible but harmless mismatch */ }

    var surface = this._surface();
    var doc = this.doc;
    doc.style.fontFamily = resolvedFamily;
    doc.style.fontSize = resolvedSize;
    doc.style.lineHeight = rowHeightPx + 'px';
    doc.style.letterSpacing = letterSpacing ? letterSpacing + 'px' : 'normal';
    doc.style.padding = padTop + 'px ' + padLeft + 'px';
    if (surface) {
      // The SAME value the canvas paints, not a near neighbour: the layer sits
      // over a container already painting --term-bg, so the edges are
      // invisible by construction rather than by two systems agreeing.
      this.root.style.background = surface.bg;
      doc.style.color = surface.ink;
      if (this.ruleEl) this.ruleEl.style.borderTopColor = surface.rule;
      if (this.pagingEl) this.pagingEl.style.color = surface.dim;
    }
    this._rowHeightPx = rowHeightPx;
    return true;
  };

  /**
   * The terminal surface projection for the active theme (P5.4).
   *
   * @returns {object|null} The projection, or null when it is unavailable.
   */
  TerminalHistoryLayer.prototype._surface = function _surface() {
    try {
      var api = (typeof window !== 'undefined') ? window.MyrlinTerminalSurface : null;
      if (!api || typeof api.terminalSurface !== 'function') return null;
      var themeId = null;
      if (typeof document !== 'undefined' && document.documentElement) {
        themeId = document.documentElement.getAttribute('data-theme');
      }
      return api.terminalSurface(themeId) || null;
    } catch (_) {
      return null;
    }
  };

  /* ── open and close (P7.1) ───────────────────────────────────── */

  /**
   * Open the history surface.
   *
   * NOT a modal transition: no toggle, no strip, no announcement. The layer
   * animates in over one row of translate and is positioned at the BOTTOM of
   * its document, which is where the live screen is, so the pane looks
   * unchanged at the instant it opens and the wheel gesture that opened it
   * continues into real history.
   *
   * @param {string} [reason] - Diagnostic label.
   * @returns {boolean} True when the layer is open.
   */
  TerminalHistoryLayer.prototype.open = function open(reason) {
    if (this._destroyed) return false;
    if (this._open) return true;
    if (!this._ensureDom()) return false;
    var term = this._term();
    if (!term) return false;

    this._source = this.resolveSource();
    this._captureLiveAnchor();
    this._composeLocalSegments();
    this.applyMetrics();

    this.root.hidden = false;
    this.root.style.display = 'block';
    this._open = true;

    this._installSelectionWatch();
    this._installResizeWatch();
    this._scrollToBottom();
    this._animateIn();
    this._updateScrollbar(true);
    this._notify();

    // Real sources are fetched AFTER the surface is up, so opening is never
    // gated on a network round trip. An empty transcript segment simply grows
    // upward when the page arrives, and the reader's position is preserved.
    var self = this;
    Promise.resolve().then(function loadFirstPage() {
      return self._loadInitialPage();
    }).catch(function ignore() { /* every failure reports in the paging bar */ });

    if (this.pane && typeof this.pane._log === 'function') {
      this.pane._log('History layer opened (' + (reason || 'unspecified') + ', source=' + this._source + ')');
    }
    return true;
  };

  /**
   * Close the surface and pin the terminal to live.
   *
   * @param {string} [reason] - Diagnostic label.
   * @returns {boolean} True when a layer was actually closed.
   */
  TerminalHistoryLayer.prototype.close = function close(reason) {
    if (!this._open) return false;
    this._open = false;
    this._frozen = false;
    this._removeSelectionWatch();
    this._removeResizeWatch();
    if (this._refreshRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._refreshRaf);
    }
    this._refreshRaf = null;
    if (this.root) {
      this.root.hidden = true;
      this.root.style.display = 'none';
    }
    // Pin live. scrollToBottom is what makes wheel-down at the bottom of the
    // document hand back a terminal that is showing the newest output rather
    // than wherever it was left.
    try {
      var term = this._term();
      if (term && typeof term.scrollToBottom === 'function') term.scrollToBottom();
    } catch (_) { /* a disposed terminal needs no pinning */ }
    this._notify();
    if (this.pane && typeof this.pane._log === 'function') {
      this.pane._log('History layer closed (' + (reason || 'unspecified') + ')');
    }
    return true;
  };

  /** Toggle the surface. @returns {boolean} Whether it ends up open. */
  TerminalHistoryLayer.prototype.toggle = function toggle() {
    return this._open ? (this.close('toggle'), false) : this.open('toggle');
  };

  /**
   * Announce open/closed state on the pane, reusing the existing bubbling
   * contract so the phone chrome can stay honest (8.5) with no new event and
   * no coupling from this file to the app shell.
   */
  TerminalHistoryLayer.prototype._notify = function _notify() {
    try {
      if (this.pane && typeof this.pane._notifySelectChromeState === 'function') {
        this.pane._notifySelectChromeState();
      }
    } catch (_) { /* advisory only */ }
  };

  /** Animate the surface in over one row, honouring reduced motion. */
  TerminalHistoryLayer.prototype._animateIn = function _animateIn() {
    if (!this.root) return;
    var duration = HISTORY_ANIMATION_MS;
    try {
      var Pane = (typeof window !== 'undefined') ? window.TerminalPane : null;
      if (Pane && typeof Pane.getSmoothScrollDuration === 'function' &&
          Pane.getSmoothScrollDuration() === 0) {
        duration = 0;
      }
    } catch (_) { /* keep the default */ }
    if (!duration) {
      this.root.style.transform = '';
      this.root.style.opacity = '';
      return;
    }
    var rows = this._rowHeightPx || 0;
    var self = this;
    try {
      this.root.style.transition = 'none';
      this.root.style.transform = 'translateY(' + rows + 'px)';
      this.root.style.opacity = '0';
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function frame() {
          if (!self.root) return;
          self.root.style.transition = 'transform ' + duration + 'ms ease, opacity ' + duration + 'ms ease';
          self.root.style.transform = 'translateY(0)';
          self.root.style.opacity = '1';
        });
      } else {
        this.root.style.transform = '';
        this.root.style.opacity = '';
      }
    } catch (_) { /* animation is cosmetic */ }
  };

  /* ── composition ─────────────────────────────────────────────── */

  /**
   * Record where the live segment starts in the terminal's buffer.
   *
   * Everything above this row is archived at open time; everything from it
   * down is the LIVE segment. That split is what keeps the reader's position
   * stable: output arriving while the layer is open extends the bottom of the
   * document and never inserts above what they are reading.
   */
  TerminalHistoryLayer.prototype._captureLiveAnchor = function _captureLiveAnchor() {
    var term = this._term();
    this._liveAnchor = 0;
    this._lastBufferLength = 0;
    try {
      var buf = term.buffer.active;
      this._lastBufferLength = typeof buf.length === 'number' ? buf.length : 0;
      // On the alternate buffer the whole viewport IS the live segment and
      // there is nothing above it in that buffer at all (measured fact C1: the
      // alternate viewport never scrolls).
      this._liveAnchor = buf.type === 'alternate'
        ? 0
        : (typeof buf.baseY === 'number' ? buf.baseY : 0);
    } catch (_) {
      this._liveAnchor = 0;
    }
  };

  /**
   * Compose the segments that need no network: the client-side ring and the
   * live screen. Called on open and on a buffer change.
   */
  TerminalHistoryLayer.prototype._composeLocalSegments = function _composeLocalSegments() {
    var term = this._term();
    if (!term) return;
    var ring = [];
    try {
      var buffers = term.buffer;
      var active = buffers.active;
      if (active && active.type === 'alternate') {
        // The pre-alternate normal buffer. For a Workbook-spawned agent pane
        // this is usually empty, because the CLI clears the normal buffer on
        // startup (measured, section 2.4 C3), but a pane where the user ran a
        // shell first and then launched a CLI has real output here and it is
        // genuinely older than the conversation, so it goes above it.
        ring = collapseBlankRuns(readBufferRange(buffers.normal, 0, undefined));
      } else {
        ring = collapseBlankRuns(readBufferRange(active, 0, this._liveAnchor));
      }
    } catch (_) {
      ring = [];
    }
    this._lines.ring = ring;
    this._renderSegment('ring');
    this._refreshLiveSegment(true);
  };

  /**
   * Read the live segment out of the terminal and write it into the DOM.
   *
   * THE MIRROR FREEZE (7.3, P7.3) lives here and nowhere else: while a
   * selection is held inside the layer this returns without touching the DOM,
   * so the text nodes the selection is anchored to cannot move. The PTY is
   * never involved, never blocked, and never queued.
   *
   * @param {boolean} [force] - Refresh even when nothing looks dirty.
   * @returns {boolean} Whether the DOM was written.
   */
  TerminalHistoryLayer.prototype._refreshLiveSegment = function _refreshLiveSegment(force) {
    if (!this._open && !force) return false;
    if (this._frozen) return false;
    var term = this._term();
    if (!term) return false;

    var lines;
    try {
      var buf = term.buffer.active;
      var length = typeof buf.length === 'number' ? buf.length : 0;
      if (buf.type === 'alternate') {
        lines = readBufferRange(buf, 0, length);
      } else {
        // A shrinking buffer means xterm trimmed its ring, so every index
        // moved and the anchor no longer points where it did. Re-anchor to the
        // current viewport rather than silently reading the wrong rows; the
        // cost is one visible discontinuity after 10000 lines of output during
        // a single reading session.
        if (length < this._lastBufferLength) {
          this._liveAnchor = typeof buf.baseY === 'number' ? buf.baseY : 0;
        }
        this._lastBufferLength = length;
        var anchor = Math.max(0, Math.min(this._liveAnchor, length));
        lines = readBufferRange(buf, anchor, length);
      }
    } catch (_) {
      return false;
    }

    // The live segment is NEVER blank-collapsed. Its blank rows are the
    // frame's own layout, and collapsing them would make the surface a
    // different height from the screen it is mirroring, which is exactly the
    // one-pixel class of mismatch 10.1 calls the highest risk item.
    this._lines.live = lines;
    this._renderSegment('live');
    this._rebalanceLiveSegment();
    this._updateSeamRule();
    this._updateScrollbar(false);
    return true;
  };

  /**
   * Move the oldest overflow out of the live segment into the segment above it.
   *
   * The document text is IDENTICAL before and after (the same lines in the
   * same order, in a different node), so nothing on screen moves. This exists
   * only to keep one text node from growing without bound while a long build
   * runs underneath an open history layer.
   */
  TerminalHistoryLayer.prototype._rebalanceLiveSegment = function _rebalanceLiveSegment() {
    if (this._frozen) return;
    var live = this._lines.live;
    if (live.length <= HISTORY_LIVE_SEGMENT_MAX_LINES) return;
    var overflow = live.length - HISTORY_LIVE_SEGMENT_MAX_LINES;
    var moved = live.slice(0, overflow);
    this._lines.live = live.slice(overflow);
    this._lines.ring = this._lines.ring.concat(moved);
    this._liveAnchor += overflow;
    this._renderSegment('ring');
    this._renderSegment('live');
    this._trimLoaded();
  };

  /**
   * Write one segment's lines into its element.
   *
   * @param {string} id - Segment id.
   * @returns {boolean} Whether the element was written.
   */
  TerminalHistoryLayer.prototype._renderSegment = function _renderSegment(id) {
    var el = this.segments[id];
    if (!el) return false;
    var lines = this._lines[id] || [];
    var text = lines.join('\n');
    if (el.textContent === text) {
      el.hidden = lines.length === 0;
      return false;
    }
    el.textContent = text;
    el.hidden = lines.length === 0;
    return true;
  };

  /**
   * Show the seam rule only when there is genuinely something above the live
   * segment. A lone rule at the top of a document is noise.
   */
  TerminalHistoryLayer.prototype._updateSeamRule = function _updateSeamRule() {
    if (!this.ruleEl) return;
    var above = this._lines.deep.length + this._lines.ring.length + this._lines.transcript.length;
    this.ruleEl.hidden = above === 0;
  };

  /**
   * Enforce the DOM node budget by dropping the OLDEST loaded lines.
   *
   * The dropped lines stay re-fetchable because paging is by absolute cursor,
   * so this is a memory bound rather than a data loss. The deep segment is
   * trimmed before the transcript because it is the cheaper of the two to
   * re-fetch (one bounded route call against a bounded in-memory log).
   */
  TerminalHistoryLayer.prototype._trimLoaded = function _trimLoaded() {
    var total = 0;
    for (var i = 0; i < SEGMENT_IDS.length; i++) total += this._lines[SEGMENT_IDS[i]].length;
    if (total <= HISTORY_MAX_LOADED_LINES) return;
    var excess = total - HISTORY_MAX_LOADED_LINES;
    var order = ['deep', 'transcript', 'ring'];
    for (var o = 0; o < order.length && excess > 0; o++) {
      var id = order[o];
      var lines = this._lines[id];
      if (lines.length === 0) continue;
      var drop = Math.min(excess, lines.length);
      this._lines[id] = lines.slice(drop);
      excess -= drop;
      this._renderSegment(id);
    }
  };

  /* ── data sources (P7.5) ─────────────────────────────────────── */

  /**
   * Fetch the first real page for whichever source the router chose.
   * @returns {Promise<boolean>} Whether anything was loaded.
   */
  TerminalHistoryLayer.prototype._loadInitialPage = function _loadInitialPage() {
    if (this._source === SOURCE_TRANSCRIPT) return this._loadTranscriptPage(true);
    return this._loadDeepPage(true);
  };

  /**
   * Page the deep normal-buffer log backwards.
   *
   * @param {boolean} first - Whether this is the first page since open.
   * @returns {Promise<boolean>} Whether lines were prepended.
   */
  TerminalHistoryLayer.prototype._loadDeepPage = function _loadDeepPage(first) {
    if (this._loading || this._deepExhausted) return Promise.resolve(false);
    var pane = this.pane;
    if (!pane || typeof pane.fetchDeepHistory !== 'function') return Promise.resolve(false);
    if (first) return this._loadDeepFirstPage();
    if (!Number.isFinite(this._deepCursor)) return Promise.resolve(false);
    return this._loadDeepPageAt(this._deepCursor);
  };

  /**
   * Fetch the first deep page, aligned against what the client already shows.
   *
   * Two calls rather than one, deliberately. A one-line probe answers "how
   * many committed lines does the server hold", which is the only unknown in
   * deepStartCursor; asking for a full page first and then discarding it would
   * transfer a page nobody reads, and guessing the cursor without the total
   * would make the alignment invisible. The probe is a bounded read against an
   * in-memory ring, so it costs a round trip and nothing else.
   *
   * @returns {Promise<boolean>} Whether lines were prepended.
   */
  TerminalHistoryLayer.prototype._loadDeepFirstPage = function _loadDeepFirstPage() {
    var self = this;
    this._loading = true;
    this._setPaging('Loading earlier output');
    return this.pane.fetchDeepHistory({ lines: 1 }).then(function onProbe(probe) {
      self._loading = false;
      if (!probe || probe.available !== true || !probe.total) {
        // No sidecar, no session, or nothing committed yet. The layer still
        // works: it shows the client ring and the live screen, which is what a
        // native terminal would show.
        self._deepExhausted = true;
        self._setPaging('');
        return false;
      }
      self._deepReflows = Number.isFinite(probe.reflows) ? probe.reflows : 0;
      var cursor = deepStartCursor({
        total: probe.total,
        oldestAvailable: probe.oldestAvailable,
        clientCommitted: self._lines.ring.length,
      });
      self._deepCursor = cursor;
      if (cursor <= (Number.isFinite(probe.oldestAvailable) ? probe.oldestAvailable : 0)) {
        // The client already holds everything the server does.
        self._deepExhausted = true;
        self._setPaging('');
        return false;
      }
      return self._loadDeepPageAt(cursor);
    }).catch(function onFail(err) {
      self._loading = false;
      self._setPaging('Could not read earlier output: ' + ((err && err.message) || 'unknown error'));
      return false;
    });
  };

  /**
   * Fetch one deep page at an explicit cursor.
   *
   * @param {number} cursor - Absolute line index to page backwards from.
   * @returns {Promise<boolean>} Whether lines were prepended.
   */
  TerminalHistoryLayer.prototype._loadDeepPageAt = function _loadDeepPageAt(cursor) {
    var self = this;
    var pane = this.pane;
    if (!pane || typeof pane.fetchDeepHistory !== 'function') return Promise.resolve(false);
    this._loading = true;
    return pane.fetchDeepHistory({ lines: HISTORY_PAGE_LINES, beforeLine: cursor })
      .then(function onPage(page) {
        self._loading = false;
        if (!page || page.available !== true) {
          self._deepExhausted = true;
          self._setPaging('');
          return false;
        }
        return self._acceptDeepPage(page, Array.isArray(page.lines) ? page.lines : []);
      })
      .catch(function onFail() {
        self._loading = false;
        self._setPaging('');
        return false;
      });
  };

  /**
   * Prepend one deep page, rejoining wrapped rows and deduping a resize seam.
   *
   * @param {object} page - The route's page envelope.
   * @param {Array<{t: string, w: boolean}>} entries - Row entries.
   * @returns {boolean} Whether lines were prepended.
   */
  TerminalHistoryLayer.prototype._acceptDeepPage = function _acceptDeepPage(page, entries) {
    var lines = joinWrappedLines(entries);
    this._deepCursor = nextDeepCursor(page);
    if (this._deepCursor === null) this._deepExhausted = true;

    if (lines.length === 0) {
      this._setPaging(this._deepExhausted ? '' : 'No earlier output');
      return false;
    }

    // The seam dedupe compares against the HEAD of whatever is currently
    // oldest in the document, bounded by the window the reflow count buys.
    // Slicing rather than concatenating keeps this linear in the window rather
    // than in the whole loaded document.
    var window = seamDedupeWindow(this._deepReflows);
    var head = this._lines.deep.length > 0
      ? this._lines.deep.slice(0, window)
      : this._lines.ring.slice(0, window);
    var overlap = trailingOverlap(lines, head, window);
    if (overlap > 0) lines = lines.slice(0, lines.length - overlap);

    this._prependLines('deep', lines);
    var notice = '';
    if (Number.isFinite(page.lostLines) && page.lostLines > 0) {
      notice = page.lostLines + ' earlier lines were dropped before they could be recorded';
    } else if (this._deepExhausted) {
      notice = '';
    }
    this._setPaging(notice);
    return true;
  };

  /**
   * Page the session transcript backwards.
   *
   * @param {boolean} first - Whether this is the first page since open.
   * @returns {Promise<boolean>} Whether messages were prepended.
   */
  TerminalHistoryLayer.prototype._loadTranscriptPage = function _loadTranscriptPage(first) {
    var self = this;
    if (this._loading || this._transcriptExhausted) return Promise.resolve(false);
    var pane = this.pane;
    if (!pane || typeof pane.fetchTranscriptWindow !== 'function') return Promise.resolve(false);
    this._loading = true;
    this._setPaging(first ? 'Loading the conversation' : 'Loading earlier conversation');

    var options = {};
    if (!first && Number.isFinite(this._transcriptOffset)) {
      options.beforeOffset = this._transcriptOffset;
    }

    return pane.fetchTranscriptWindow(options).then(function onWindow(win) {
      self._loading = false;
      if (!win) {
        self._transcriptExhausted = true;
        self._setPaging('No transcript for this pane yet. What is on screen is what there is.');
        return false;
      }
      var messages = Array.isArray(win.messages) ? win.messages : [];
      if (Number.isFinite(win.startOffset)) self._transcriptOffset = win.startOffset;
      if (!win.truncatedHead || !Number.isFinite(self._transcriptOffset) || self._transcriptOffset <= 0) {
        self._transcriptExhausted = true;
      }
      if (messages.length === 0) {
        self._setPaging(first
          ? 'This session has no transcript entries yet.'
          : '');
        return false;
      }
      self._prependLines('transcript', renderTranscriptLines(messages));
      self._setPaging('');
      return true;
    }).catch(function onFail(err) {
      self._loading = false;
      self._setPaging('Could not read the conversation: ' + ((err && err.message) || 'unknown error'));
      return false;
    });
  };

  /**
   * Prepend lines to a segment while keeping the reader exactly where they are.
   *
   * Content added ABOVE the viewport would otherwise yank it, which is the one
   * thing a paging surface must never do. The scroll offset is corrected by
   * the height the document gained, measured rather than computed from a row
   * count, so a wrapped line costs what it actually costs.
   *
   * @param {string} id - Segment id.
   * @param {string[]} lines - Lines to prepend, oldest first.
   * @returns {boolean} Whether anything was prepended.
   */
  TerminalHistoryLayer.prototype._prependLines = function _prependLines(id, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return false;
    var doc = this.doc;
    var beforeHeight = doc ? doc.scrollHeight : 0;
    var beforeTop = doc ? doc.scrollTop : 0;
    this._lines[id] = lines.concat(this._lines[id] || []);
    this._renderSegment(id);
    this._updateSeamRule();
    this._trimLoaded();
    if (doc) {
      try {
        doc.scrollTop = beforeTop + (doc.scrollHeight - beforeHeight);
      } catch (_) { /* a detached document has no scroll to preserve */ }
    }
    this._updateScrollbar(true);
    return true;
  };

  /**
   * Show or clear the quiet paging bar.
   *
   * Skeletons over spinners: the bar is a 24px row of dim text plus a 2px
   * indeterminate shimmer on the scrollbar track while a fetch is in flight.
   *
   * @param {string} text - Message, or '' to hide the bar.
   */
  TerminalHistoryLayer.prototype._setPaging = function _setPaging(text) {
    if (!this.pagingEl) return;
    var message = typeof text === 'string' ? text : '';
    this.pagingEl.textContent = message;
    this.pagingEl.hidden = message === '';
    if (this.scrollbarEl && this.scrollbarEl.classList) {
      this.scrollbarEl.classList.toggle('is-paging', !!this._loading);
    }
  };

  /* ── scrolling and boundaries (P7.1) ─────────────────────────── */

  /** Scroll the document to its bottom, which is the live screen. */
  TerminalHistoryLayer.prototype._scrollToBottom = function _scrollToBottom() {
    if (!this.doc) return;
    try { this.doc.scrollTop = this.doc.scrollHeight; } catch (_) { /* detached */ }
  };

  /** @returns {boolean} Whether the document is scrolled to its bottom. */
  TerminalHistoryLayer.prototype._atBottom = function _atBottom() {
    if (!this.doc) return true;
    return (this.doc.scrollTop + this.doc.clientHeight) >= (this.doc.scrollHeight - 1);
  };

  /** React to a scroll: prefetch near the top, update the affordance. */
  TerminalHistoryLayer.prototype._onScroll = function _onScroll() {
    this._updateScrollbar(true);
    if (!this.doc) return;
    var threshold = this.doc.clientHeight * HISTORY_PREFETCH_VIEWPORTS;
    if (this.doc.scrollTop <= threshold) this._pageOlder();
  };

  /**
   * Fetch the next page backwards for the active source.
   * @returns {Promise<boolean>} Whether a fetch was started.
   */
  TerminalHistoryLayer.prototype._pageOlder = function _pageOlder() {
    if (this._loading) return Promise.resolve(false);
    if (this._source === SOURCE_TRANSCRIPT) return this._loadTranscriptPage(false);
    return this._loadDeepPage(false);
  };

  /**
   * The layer's own wheel handling, which owns exactly one decision: leaving.
   *
   * Everything else is native DOM scrolling, which is why drag-at-edge
   * auto-scroll, momentum and touch all work here with no code.
   *
   * @param {WheelEvent} e - The wheel event.
   */
  TerminalHistoryLayer.prototype._onDocWheel = function _onDocWheel(e) {
    if (!this._open) return;
    var down = e && typeof e.deltaY === 'number' && e.deltaY > 0;
    if (!down) return;
    if (!this._atBottom()) return;
    // Passing the bottom returns to live. preventDefault stops the gesture
    // from also scrolling an ancestor once the layer is gone.
    if (e.cancelable) e.preventDefault();
    this.close('wheel-bottom');
  };

  /**
   * Decide what a wheel event over the LIVE terminal means (8.1 and 8.2).
   *
   * Installed through xterm 6's public attachCustomWheelEventHandler rather
   * than as another capture-phase listener, so the Select-mode wheel guard is
   * untouched and keeps working exactly as it does today.
   *
   * @param {WheelEvent} e - The wheel event xterm is about to handle.
   * @returns {boolean} True to let xterm handle it, false to consume it.
   */
  TerminalHistoryLayer.prototype.handleTerminalWheel = function handleTerminalWheel(e) {
    if (this._destroyed || !e) return true;
    if (this._open) return true;
    var up = typeof e.deltaY === 'number' && e.deltaY < 0;
    if (!up) return true;

    // The GUARANTEED path. Shift plus wheel is what every mainstream terminal
    // reserves for its own scrollback when an application owns the mouse, so
    // it is native muscle memory rather than a Workbook invention, and it is
    // why the convenience path below is allowed to be a heuristic.
    if (e.shiftKey) {
      this.open('shift-wheel');
      return false;
    }

    var term = this._term();
    if (!this.altBuffer()) {
      // A normal-buffer pane scrolls its own ring first. Workbook code is not
      // involved at all until xterm is at the top of it, which is what makes
      // short lookback byte-exact and colour-exact.
      var viewportY = 0;
      try { viewportY = term.buffer.active.viewportY; } catch (_) { viewportY = 0; }
      if (viewportY > 0) return true;
      this.open('top-boundary');
      return false;
    }

    // Alternate buffer with no mouse tracking: nothing else wants the wheel.
    if (!this.mouseTrackingActive()) {
      this.open('alt-no-tracking');
      return false;
    }

    // Alternate buffer, application owns the mouse. Forward it, and escalate
    // only once the application has demonstrably run out of its own history.
    if (!this._escalationEnabled()) return true;
    if (this._wheelExhaustedAt &&
        (Date.now() - this._wheelExhaustedAt) < WHEEL_ESCALATION_TTL_MS) {
      this._wheelExhaustedAt = 0;
      this.open('wheel-exhaustion');
      return false;
    }
    this._armExhaustionProbe();
    return true;
  };

  /**
   * Whether the convenience escalation path is switched on.
   *
   * Defaults ON and has an off switch, because it is a heuristic layered on a
   * guaranteed path (8.2). It must never be the only way to reach history.
   *
   * @returns {boolean} Whether plain wheel may escalate.
   */
  TerminalHistoryLayer.prototype._escalationEnabled = function _escalationEnabled() {
    try {
      var raw = (typeof localStorage !== 'undefined')
        ? localStorage.getItem('cwm_settings')
        : null;
      var settings = raw ? JSON.parse(raw) : {};
      if (settings && settings.terminalWheelEscalation === false) return false;
    } catch (_) { /* unreadable settings fall through to the default */ }
    return true;
  };

  /**
   * Arm the exhaustion probe after forwarding a wheel notch to the application.
   *
   * If no PTY output arrives within WHEEL_EXHAUSTION_MS, the application had
   * nothing more to show, and the NEXT notch opens the history layer instead
   * of being swallowed. If output does arrive, the application is scrolling
   * its own history and the verdict is cancelled, which is what keeps this
   * from stealing the wheel from a CLI that implements its own scrollback.
   */
  TerminalHistoryLayer.prototype._armExhaustionProbe = function _armExhaustionProbe() {
    var self = this;
    this._wheelForwardedAt = Date.now();
    if (this._wheelProbeTimer) clearTimeout(this._wheelProbeTimer);
    this._wheelProbeTimer = setTimeout(function verdict() {
      self._wheelProbeTimer = null;
      if (self._lastOutputAt >= self._wheelForwardedAt) return;
      self._wheelExhaustedAt = Date.now();
    }, WHEEL_EXHAUSTION_MS);
  };

  /**
   * Note that the PTY produced output.
   *
   * Two jobs: it cancels an exhaustion verdict (the application IS responding
   * to the wheel), and it marks the live segment dirty so an open layer keeps
   * mirroring the screen.
   */
  TerminalHistoryLayer.prototype.noteOutput = function noteOutput() {
    this._lastOutputAt = Date.now();
    this._wheelExhaustedAt = 0;
    if (!this._open || this._frozen) return;
    this._dirty = true;
    if (this._refreshRaf) return;
    var self = this;
    if (typeof requestAnimationFrame === 'function') {
      this._refreshRaf = requestAnimationFrame(function frame() {
        self._refreshRaf = null;
        if (!self._dirty) return;
        self._dirty = false;
        self._refreshLiveSegment(false);
      });
    } else {
      this._dirty = false;
      this._refreshLiveSegment(false);
    }
  };

  /**
   * Re-route and recompose after the application entered or left the alternate
   * buffer, so a pane that crosses the boundary re-routes with no user action
   * and without tearing the surface down (7.2).
   */
  TerminalHistoryLayer.prototype.onBufferChange = function onBufferChange() {
    if (this._destroyed) return;
    var next = this.resolveSource();
    if (!this._open) { this._source = next; return; }
    if (next !== this._source) {
      this._source = next;
      this._lines.deep = [];
      this._lines.transcript = [];
      this._deepCursor = null;
      this._deepExhausted = false;
      this._transcriptOffset = null;
      this._transcriptExhausted = false;
      this._renderSegment('deep');
      this._renderSegment('transcript');
      var self = this;
      Promise.resolve().then(function reload() { return self._loadInitialPage(); })
        .catch(function ignore() {});
    }
    this._captureLiveAnchor();
    this._composeLocalSegments();
  };

  /* ── keyboard (8.4) ──────────────────────────────────────────── */

  /**
   * Handle a key that reached the TERMINAL while the layer is open.
   *
   * Returns a verdict rather than acting on the socket, because the caller
   * (the pane's own custom key handler) owns the decision about whether xterm
   * should also process the key. `pass` means "the layer is done, let the key
   * through to the PTY", which is what makes typing the way out.
   *
   * @param {KeyboardEvent} e - The keydown event.
   * @returns {string|null} 'consumed', 'pass', or null when not ours.
   */
  TerminalHistoryLayer.prototype.handleTerminalKey = function handleTerminalKey(e) {
    if (!e || e.type !== 'keydown') return null;
    var mod = e.ctrlKey || e.metaKey;

    // Shift+PageUp opens the layer even from live, which is the keyboard half
    // of the guaranteed path and the convention on Linux consoles, xterm and
    // Windows Terminal alike.
    if (e.shiftKey && !mod && e.key === 'PageUp') {
      if (!this._open && !this.open('shift-pageup')) return null;
      this.scrollByPages(-1);
      return 'consumed';
    }
    if (!this._open) return null;

    if (e.shiftKey && !mod && e.key === 'PageDown') {
      if (this._atBottom()) this.close('shift-pagedown');
      else this.scrollByPages(1);
      return 'consumed';
    }
    if (mod && e.shiftKey && e.key === 'Home') { this.scrollToTop(); return 'consumed'; }
    if (mod && e.shiftKey && e.key === 'End') { this.close('ctrl-shift-end'); return 'consumed'; }
    if (e.key === 'Escape') { this.close('escape'); return 'consumed'; }
    if (e.key === 'PageUp' && !mod && !e.shiftKey) { this.scrollByPages(-1); return 'consumed'; }
    if (e.key === 'PageDown' && !mod && !e.shiftKey) { this.scrollByPages(1); return 'consumed'; }
    if (e.key === 'ArrowUp' && !mod && !e.shiftKey) { this.scrollByRows(-1); return 'consumed'; }
    if (e.key === 'ArrowDown' && !mod && !e.shiftKey) {
      if (this._atBottom()) { this.close('arrow-down'); return 'consumed'; }
      this.scrollByRows(1);
      return 'consumed';
    }

    // Anything printable dismisses and is delivered. This is the row that
    // makes the whole surface modeless: the way out of history is to start
    // typing, exactly as in a native terminal.
    if (isPrintableKey(e) || e.key === 'Enter') {
      this.close('typing');
      return 'pass';
    }
    return null;
  };

  /**
   * Handle a key that reached the LAYER because the user clicked into it.
   *
   * Same rules as handleTerminalKey, but the layer has to deliver a printable
   * key to the PTY itself: xterm never saw it, so nothing else will send it.
   *
   * @param {KeyboardEvent} e - The keydown event.
   */
  TerminalHistoryLayer.prototype._onDocKey = function _onDocKey(e) {
    if (!e) return;
    var mod = e.ctrlKey || e.metaKey;

    // Ctrl+C with a selection is the browser's own trusted copy. Never touch
    // it: it works on every origin and needs no permission.
    if (mod && !e.shiftKey && (e.key === 'c' || e.key === 'C')) return;

    if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (mod && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      // Scope select-all to the document. Without this, Ctrl+A in a focusable
      // element selects the whole page in most engines.
      e.preventDefault();
      this.selectAll();
      return;
    }

    var verdict = this.handleTerminalKey(e);
    if (verdict === 'consumed') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (verdict === 'pass') {
      e.preventDefault();
      e.stopPropagation();
      this._returnFocusToTerminal();
      // Deliver the character the user typed, so dismissing by typing types.
      if (isPrintableKey(e)) this._sendToPty(e.key);
      else if (e.key === 'Enter') this._sendToPty('\r');
    }
  };

  /** Hand the keyboard back to the terminal after the layer closes. */
  TerminalHistoryLayer.prototype._returnFocusToTerminal = function _returnFocusToTerminal() {
    try {
      if (this.pane && typeof this.pane.focus === 'function') this.pane.focus();
    } catch (_) { /* a hidden or mobile-scroll pane declines focus by design */ }
  };

  /**
   * Send raw input to the PTY through the pane's socket.
   *
   * @param {string} data - Bytes to send.
   * @returns {boolean} Whether anything was sent.
   */
  TerminalHistoryLayer.prototype._sendToPty = function _sendToPty(data) {
    try {
      var pane = this.pane;
      if (!pane || !pane.ws || !data) return false;
      if (typeof WebSocket !== 'undefined' && pane.ws.readyState !== WebSocket.OPEN) return false;
      pane.ws.send(JSON.stringify({ type: 'input', data: data }));
      return true;
    } catch (_) {
      return false;
    }
  };

  /**
   * Scroll by whole pages.
   * @param {number} pages - Signed page count; negative is toward older.
   */
  TerminalHistoryLayer.prototype.scrollByPages = function scrollByPages(pages) {
    if (!this.doc) return;
    try {
      this.doc.scrollTop += pages * Math.max(1, this.doc.clientHeight - (this._rowHeightPx || 0));
    } catch (_) { /* detached */ }
  };

  /**
   * Scroll by whole rows.
   * @param {number} rows - Signed row count; negative is toward older.
   */
  TerminalHistoryLayer.prototype.scrollByRows = function scrollByRows(rows) {
    if (!this.doc) return;
    try {
      this.doc.scrollTop += rows * (this._rowHeightPx || 16);
    } catch (_) { /* detached */ }
  };

  /** Jump to the oldest loaded content. */
  TerminalHistoryLayer.prototype.scrollToTop = function scrollToTop() {
    if (!this.doc) return;
    try { this.doc.scrollTop = 0; } catch (_) { /* detached */ }
    this._pageOlder();
  };

  /* ── selection, freeze and copy (P7.3, P7.6) ─────────────────── */

  /**
   * Watch for a selection being held inside the layer.
   *
   * `selectionchange` is a document-level event, so the handler is installed
   * on open and removed on close rather than left attached for the life of the
   * pane: six panes each holding a permanent document listener would run six
   * handlers on every caret move anywhere in the application.
   */
  TerminalHistoryLayer.prototype._installSelectionWatch = function _installSelectionWatch() {
    if (this._selectionHandler || typeof document === 'undefined') return;
    var self = this;
    this._selectionHandler = function onSelectionChange() {
      self._syncFreeze();
    };
    document.addEventListener('selectionchange', this._selectionHandler);
  };

  /** Remove the selection watch and release any freeze it was holding. */
  TerminalHistoryLayer.prototype._removeSelectionWatch = function _removeSelectionWatch() {
    if (this._selectionHandler && typeof document !== 'undefined') {
      try { document.removeEventListener('selectionchange', this._selectionHandler); } catch (_) {}
    }
    this._selectionHandler = null;
    this._frozen = false;
  };

  /**
   * Freeze or resume the MIRROR according to whether a selection is held.
   *
   * This is the whole of the mirror-freeze principle in code, and what it does
   * NOT do is the point: it never touches _enqueueWrite, _flushWriteBuffer,
   * _engageSelectHold or the socket. The PTY keeps streaming and the live
   * terminal underneath keeps repainting; only the textContent swap pauses, so
   * the text nodes the selection is anchored to cannot move underneath it.
   *
   * @returns {boolean} The freeze state after the sync.
   */
  TerminalHistoryLayer.prototype._syncFreeze = function _syncFreeze() {
    var held = this.hasSelection();
    if (held === this._frozen) return this._frozen;
    this._frozen = held;
    if (!held) {
      // Catch up in one write the moment the selection goes away.
      this._refreshLiveSegment(true);
    }
    return this._frozen;
  };

  /**
   * Whether a non-collapsed selection is currently held inside this layer.
   * @returns {boolean} True while the user is holding a selection here.
   */
  TerminalHistoryLayer.prototype.hasSelection = function hasSelection() {
    try {
      if (typeof document === 'undefined' || typeof document.getSelection !== 'function') return false;
      if (!this.root || typeof this.root.contains !== 'function') return false;
      var sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return false;
      return this.root.contains(sel.anchorNode) && this.root.contains(sel.focusNode);
    } catch (_) {
      return false;
    }
  };

  /**
   * Select the whole history document, including the current screen (P7.6).
   *
   * This is requirement A6, "select the entire pane content with one action",
   * and it is only answerable here: the terminal's own selectAll reaches what
   * xterm holds, which for an agent pane is one screen.
   *
   * @returns {boolean} Whether a selection was made.
   */
  TerminalHistoryLayer.prototype.selectAll = function selectAll() {
    try {
      if (typeof document === 'undefined' || typeof window === 'undefined') return false;
      if (!this.doc || typeof document.createRange !== 'function') return false;
      var range = document.createRange();
      // Deliberately NOT the whole layer: the paging bar is chrome, so it must
      // not land in the clipboard.
      var first = this._firstContentSegment();
      var last = this.segments.live;
      if (!first || !last) return false;
      range.setStartBefore(first);
      range.setEndAfter(last);
      var sel = window.getSelection ? window.getSelection() : null;
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      this._syncFreeze();
      return true;
    } catch (_) {
      return false;
    }
  };

  /**
   * The first segment element that currently holds content.
   * @returns {HTMLElement|null} The element, or null.
   */
  TerminalHistoryLayer.prototype._firstContentSegment = function _firstContentSegment() {
    for (var i = 0; i < SEGMENT_IDS.length; i++) {
      var id = SEGMENT_IDS[i];
      if (this._lines[id].length > 0 && this.segments[id]) return this.segments[id];
    }
    return this.segments.live || null;
  };

  /**
   * The whole document as plain text, oldest first.
   *
   * @returns {string} Document text, with the segments joined in order.
   */
  TerminalHistoryLayer.prototype.getDocumentText = function getDocumentText() {
    var parts = [];
    for (var i = 0; i < SEGMENT_IDS.length; i++) {
      var lines = this._lines[SEGMENT_IDS[i]];
      if (lines.length > 0) parts.push(lines.join('\n'));
    }
    return parts.join('\n');
  };

  /* ── the quiet scrollbar (P7.4, 8.3) ─────────────────────────── */

  /**
   * Size and place the overlay scrollbar thumb, and fade it out again.
   *
   * It represents the WHOLE logical extent, which is what makes it the only
   * affordance the surface needs: the thumb's size says how much history
   * exists, so no strip, no toggle and no announcement are required.
   *
   * @param {boolean} show - Whether to reveal it (a scroll or a load did).
   */
  TerminalHistoryLayer.prototype._updateScrollbar = function _updateScrollbar(show) {
    var bar = this.scrollbarEl;
    var thumb = this.thumbEl;
    var doc = this.doc;
    if (!bar || !thumb || !doc) return;
    var extent = doc.scrollHeight;
    var view = doc.clientHeight;
    // Hidden entirely when there is nothing above the current screen, which is
    // the done criterion: an affordance for history that does not exist is a
    // lie about what the surface can do.
    if (!extent || extent <= view + 1) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var ratio = view / extent;
    var height = Math.max(HISTORY_SCROLLBAR_MIN_THUMB_PX, Math.round(view * ratio));
    var travel = view - height;
    var progress = extent - view > 0 ? (doc.scrollTop / (extent - view)) : 0;
    try {
      thumb.style.height = height + 'px';
      thumb.style.transform = 'translateY(' + Math.round(progress * travel) + 'px)';
    } catch (_) { /* a stubbed element measures nothing */ }
    if (show && bar.classList) {
      bar.classList.add('is-visible');
      var self = this;
      if (this._scrollbarTimer) clearTimeout(this._scrollbarTimer);
      this._scrollbarTimer = setTimeout(function fade() {
        self._scrollbarTimer = null;
        if (self.scrollbarEl && self.scrollbarEl.classList) {
          self.scrollbarEl.classList.remove('is-visible');
        }
      }, HISTORY_SCROLLBAR_FADE_MS);
    }
  };

  /* ── lifecycle ───────────────────────────────────────────────── */

  /** Keep the layer's rect and metrics correct when the pane is resized. */
  TerminalHistoryLayer.prototype._installResizeWatch = function _installResizeWatch() {
    if (this._resizeObserver || typeof ResizeObserver !== 'function') return;
    var container = this._container();
    if (!container) return;
    var self = this;
    try {
      this._resizeObserver = new ResizeObserver(function onResize() {
        if (!self._open) return;
        // A held selection must survive a resize: the document is pre-wrap, so
        // it reflows as text and the metrics are all that need re-applying.
        self.applyMetrics();
        self._updateScrollbar(false);
      });
      this._resizeObserver.observe(container);
    } catch (_) {
      this._resizeObserver = null;
    }
  };

  /** Stop watching for resizes. */
  TerminalHistoryLayer.prototype._removeResizeWatch = function _removeResizeWatch() {
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
    }
    this._resizeObserver = null;
  };

  /** Re-derive metrics after a theme change. */
  TerminalHistoryLayer.prototype.onThemeChange = function onThemeChange() {
    if (!this.root) return;
    this.applyMetrics();
  };

  /**
   * Whether an event target sits inside this layer.
   *
   * Used by the pane's capture-phase touch and wheel handlers, which would
   * otherwise translate a scroll gesture inside the layer into terminal
   * scrolling. Same exemption the Copy view already has.
   *
   * @param {EventTarget} target - The event target.
   * @returns {boolean} True when the target is inside an OPEN layer.
   */
  TerminalHistoryLayer.prototype.contains = function contains(target) {
    return !!(this._open && this.root && target &&
      typeof this.root.contains === 'function' && this.root.contains(target));
  };

  /** Tear the layer down completely. Idempotent. */
  TerminalHistoryLayer.prototype.destroy = function destroy() {
    this._destroyed = true;
    this._open = false;
    this._frozen = false;
    this._removeSelectionWatch();
    this._removeResizeWatch();
    if (this._refreshRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._refreshRaf);
    }
    this._refreshRaf = null;
    if (this._scrollbarTimer) { clearTimeout(this._scrollbarTimer); this._scrollbarTimer = null; }
    if (this._wheelProbeTimer) { clearTimeout(this._wheelProbeTimer); this._wheelProbeTimer = null; }
    if (this.root) {
      try { this.root.remove(); } catch (_) {}
    }
    this.root = null;
    this.doc = null;
    this.pagingEl = null;
    this.ruleEl = null;
    this.scrollbarEl = null;
    this.thumbEl = null;
    this.segments = {};
    this._lines = { deep: [], ring: [], transcript: [], live: [] };
  };

  return {
    TerminalHistoryLayer: TerminalHistoryLayer,
    // Pure helpers, exported for the unit suite and for any future consumer
    // that needs the routing rule without a DOM.
    resolveAltBuffer: resolveAltBuffer,
    resolveMouseTrackingActive: resolveMouseTrackingActive,
    routeHistorySource: routeHistorySource,
    joinWrappedLines: joinWrappedLines,
    deepStartCursor: deepStartCursor,
    nextDeepCursor: nextDeepCursor,
    seamDedupeWindow: seamDedupeWindow,
    trailingOverlap: trailingOverlap,
    readBufferRange: readBufferRange,
    collapseBlankRuns: collapseBlankRuns,
    renderTranscriptLines: renderTranscriptLines,
    wheelLines: wheelLines,
    isPrintableKey: isPrintableKey,
    SEGMENT_IDS: SEGMENT_IDS,
    SOURCE_TRANSCRIPT: SOURCE_TRANSCRIPT,
    SOURCE_NATIVE: SOURCE_NATIVE,
    HISTORY_PAGE_LINES: HISTORY_PAGE_LINES,
    HISTORY_PREFETCH_VIEWPORTS: HISTORY_PREFETCH_VIEWPORTS,
    HISTORY_MAX_LOADED_LINES: HISTORY_MAX_LOADED_LINES,
    HISTORY_LIVE_SEGMENT_MAX_LINES: HISTORY_LIVE_SEGMENT_MAX_LINES,
    HISTORY_TRANSCRIPT_PAGE_BYTES: HISTORY_TRANSCRIPT_PAGE_BYTES,
    HISTORY_SEAM_DEDUPE_MAX_LINES: HISTORY_SEAM_DEDUPE_MAX_LINES,
    HISTORY_SEAM_DEDUPE_PER_REFLOW: HISTORY_SEAM_DEDUPE_PER_REFLOW,
    HISTORY_LAYER_Z_INDEX: HISTORY_LAYER_Z_INDEX,
    HISTORY_SCROLLBAR_WIDTH_PX: HISTORY_SCROLLBAR_WIDTH_PX,
    HISTORY_SCROLLBAR_FADE_MS: HISTORY_SCROLLBAR_FADE_MS,
    HISTORY_ANIMATION_MS: HISTORY_ANIMATION_MS,
    WHEEL_EXHAUSTION_MS: WHEEL_EXHAUSTION_MS,
    WHEEL_ESCALATION_TTL_MS: WHEEL_ESCALATION_TTL_MS,
    HISTORY_BLANK_RUN_LIMIT: HISTORY_BLANK_RUN_LIMIT,
  };
}));
