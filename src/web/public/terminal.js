/**
 * TerminalPane - xterm.js terminal connected via WebSocket to server-side PTY
 * Performance-critical: raw binary I/O, no JSON wrapping for terminal data
 */

// Smooth-scroll animation duration in ms for wheel and Shift+PageUp/Down
// scrolling (issue #41). xterm 6.0.0 animates scrollLines over this window;
// kept short because each intermediate row step refreshes the DOM renderer.
const SMOOTH_SCROLL_DURATION_MS = 120;

/* ═══════════════════════════════════════════════════════════════════
   SELECT MODE v2 TUNING CONSTANTS
   Select mode v1 only re-dispatched a plain drag as a Shift+drag so
   xterm would force a selection (see _installSelectModeInterceptor).
   That is necessary but not sufficient: xterm anchors a selection to
   ABSOLUTE buffer coordinates and clears it only on user input,
   scrollback trim, a row-count resize, or a buffer switch. A plain PTY
   write does NOT clear it, but a full-screen TUI's frame repaint
   rewrites the cells underneath, so the highlight silently goes stale
   and the copied text is nonsense. v2 therefore FREEZES the write
   pipeline for the duration of the selection: the screen the user is
   dragging over stops changing, so the selection stays exactly what
   they see.
   ═══════════════════════════════════════════════════════════════════ */

// Upper bound on output held back while Select mode is frozen, measured in
// JavaScript string length (close enough to bytes for terminal output, which
// is overwhelmingly ASCII plus box-drawing). A pane left frozen in front of a
// chatty build would otherwise grow the hold queue without limit and then
// stall the main thread on one giant term.write() at unfreeze. On overflow the
// pane leaves Select mode, flushes, and says so in the strip.
const SELECT_FREEZE_MAX_HOLD_CHARS = 2 * 1024 * 1024;

// Rows scrolled per wheel notch while Select mode is on and the NORMAL buffer
// is active. Only meaningful there: the alternate buffer has no scrollback, so
// a wheel event under a full-screen TUI has nowhere to go and is swallowed.
const SELECT_FREEZE_WHEEL_LINES = 3;

// How long a transient Select-mode notice (for example the overflow message)
// stays on screen before the strip reverts to its normal state.
const SELECT_NOTICE_MS = 3600;

// Divider inserted in the Copy view between the scrollback transcript held in
// the normal buffer and the live full-screen frame in the alternate buffer.
const COPY_VIEW_DIVIDER = '[ current screen ]';

// Runs of this many or more consecutive blank lines collapse to a single blank
// line in the Copy view. Full-screen TUI frames are mostly padding, so without
// this the composed text is dominated by empty rows.
const COPY_VIEW_BLANK_RUN_LIMIT = 3;

// Fallback offset (px) from the top of the pane to the Copy view overlay when
// the pane header cannot be measured (detached or display:none at open time).
const COPY_VIEW_DEFAULT_TOP_PX = 34;

// How long the Copy view's "Copy all" button shows its result state.
const COPY_VIEW_FEEDBACK_MS = 1400;

// Minimum height AND width (px) for every control in the Copy view bar once the
// pane is laid out for a phone. The desktop sizing (a 26px tall text button) is
// well under the 40px comfortable-touch floor, which made "Copy all" and
// "Refresh" easy to miss and easy to mis-tap on a real device.
const COPY_VIEW_TOUCH_TARGET_PX = 40;

// Viewport width (px) at or below which the pane is treated as phone-laid-out
// for the purposes of touch sizing. Matches the 768px breakpoint every mobile
// rule in styles-mobile.css already uses, so JS sizing and CSS layout agree.
const COPY_VIEW_TOUCH_MAX_WIDTH_PX = 768;

/* ═══════════════════════════════════════════════════════════════════
   COPY VIEW SOURCES
   The terminal source can only ever offer what the TERMINAL saw: the
   normal buffer plus the current full-screen frame. An interactive CLI
   keeps the conversation inside its own app and repaints a width-locked
   frame, so everything older than the visible screen exists only in the
   session transcript on disk. The server already publishes that through
   the mirror API (open/history/close, live since v1.2.0), which is the
   same read-only path the mirror pane uses, so the Copy view can offer
   the real conversation as a second source without a new endpoint and
   without ever touching the running session.
   ═══════════════════════════════════════════════════════════════════ */

// The two Copy view sources. Terminal is the default because it is always
// available and needs no network round trip.
const COPY_VIEW_SOURCE_TERMINAL = 'terminal';
const COPY_VIEW_SOURCE_TRANSCRIPT = 'transcript';

// Characters of a tool payload kept on its one-line summary. Tool events are
// noise in a copied conversation, but dropping them entirely loses the thread
// of what the assistant actually did, so each collapses to a single labelled
// line the way the mirror pane collapses them into a details summary.
const COPY_VIEW_TRANSCRIPT_TOOL_CHARS = 120;

// Bytes requested per "Load earlier" page. The server clamps this to its own
// history window cap, so this is a request, not a guarantee.
const COPY_VIEW_TRANSCRIPT_PAGE_BYTES = 262144;

/* ═══════════════════════════════════════════════════════════════════
   SELECT MODE STRIP PLACEMENT CONSTANTS
   The strip is absolutely positioned inside the pane, so it has to be
   told about the two things that live at the bottom of a pane: the
   floating action buttons on desktop (z-order) and the mobile toolbar
   plus type-and-send row on a phone (vertical inset).
   ═══════════════════════════════════════════════════════════════════ */

// Gap (px) between the strip and whatever sits below it.
const SELECT_STRIP_BASE_BOTTOM_PX = 8;

// Bottom inset (px) used on a mobile-active pane when the toolbar cannot be
// measured (not yet laid out, or measured while the pane was hidden). Sized for
// one row of 38px toolbar buttons plus its 6px padding, so the strip still
// clears the toolbar rather than sitting on top of it.
const SELECT_STRIP_MOBILE_CHROME_FALLBACK_PX = 50;

// Stacking order for the strip. It is a pointer-events:none notice, so it must
// paint ABOVE terminal text but BELOW the pane's interactive chrome. The
// floating upload and schedule buttons sit at z-index 5 (styles.css), and at
// the strip's old z-index of 20 they were painted over: still clickable, but
// invisible, which reads as a rendering bug. Anything genuinely modal stays
// above (the copy hint at 30, the Copy view overlay at 40).
const SELECT_STRIP_Z_INDEX = 4;

/* ═══════════════════════════════════════════════════════════════════
   TERMINAL-GENERATED REPORT FILTER
   ConPTY turns on DEC 1004 focus reporting for essentially every pane
   (term.modes.sendFocusMode is true on plain shells and on CLI panes
   alike). xterm answers a focus change by emitting \x1b[I / \x1b[O
   through the SAME term.onData channel keystrokes use, and the app
   shell relays it as an ordinary { type: 'input' } frame. Select mode
   treats input as "the user is typing, resume live output", so the
   click that STARTS a selection was cancelling the mode it was made
   in. These constants back the filter that tells a machine-generated
   report apart from a keystroke.

   MOUSE REPORTS BELONG HERE TOO (field bug, 2026-08-06, user report:
   "as soon as I go and hover over the terminal the select button
   stops being toggled on"). An interactive CLI enables mouse tracking
   1000/1002/1003 with SGR encoding 1006. 1003 is ANY-EVENT tracking,
   so simply moving the pointer across the terminal, with no button
   held and nothing clicked, makes xterm emit a stream of
   \x1b[<35;col;rowM reports on this same channel. Select mode read
   the first one as typing and switched itself off before the user had
   selected anything. Measured with a real pointer sweep over a pane in
   any-event tracking: 81 reports, 881 characters, all from hovering.

   Both funnels consume the one predicate below (term.onData directly,
   the socket hook through _isReportOnlyInputFrame), so the grammar and
   the cap are defined once and cannot drift apart.
   ═══════════════════════════════════════════════════════════════════ */

// Longest payload still considered for the report-only test.
//
// RAISED FROM 64 (field bug, 2026-08-06). The one-shot reports are tiny (a
// focus report is 3 chars, a cursor position report about 8, a device
// attributes response about 12), but MOUSE MOTION reports are not one-shot:
// with any-event tracking (DECSET 1003) every few pixels of pointer movement
// produces another 9 to 15 byte report, and xterm can hand several of them to
// one onData callback. A measured hover sweep produced 81 reports totalling
// 881 characters. At 64 the filter rejected a coalesced burst and the pane
// unfroze, which is precisely the bug this cap now has to survive.
//
// The fail-safe direction is unchanged: a burst even longer than this is
// treated as user input and resumes live output. That is rare (it needs one
// callback carrying more than a kilobyte of pure reports) and harmless.
const TERMINAL_REPORT_MAX_CHARS = 1024;

// One or more concatenated terminal reports and NOTHING else:
//   \x1b[I / \x1b[O            DEC 1004 focus in / focus out
//   \x1b[<row>;<col>R          DSR cursor position report (CPR)
//   \x1b[?...c / \x1b[>...c    primary / secondary device attributes (DA)
//   \x1b[<b;col;rowM / ...m    SGR 1006 mouse report, press/motion and release
//   \x1b[M + 3 bytes           legacy X10 mouse report
// Anchored at both ends so a mixed chunk (a report plus a real keystroke)
// fails and the pane unfreezes. Every alternative starts with CSI (ESC [), so
// printable text, control characters (\r, \t, \x03, \x7f) and SS3 sequences
// (\x1bO...) are rejected on the first two characters.
//
// The mouse button field is matched as a full \d+ rather than an enumeration
// of the codes seen in the wild. Any-event tracking varies that number by
// button, by motion bit, and by modifier (hover 35, hover with Shift 39, with
// Meta 43, with Ctrl 51, drags 32 to 34, wheel 64 and 65), and an enumeration
// would silently regress the moment a combination outside the list occurred.
// Every value in that field is machine-generated, so none of it is ambiguous.
const TERMINAL_REPORT_ONLY_RE =
  /^(?:\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>][0-9;]*c|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

/* ═══════════════════════════════════════════════════════════════════
   VISIBLE-PANE WIDTH CLAIM CONSTANTS
   One PTY is shared by every attached client, and the backend gives
   geometry ownership to whichever client last typed or sent an explicit
   'activate' (see claimSizeOwnership in src/web/pty-manager.js). The
   app layer already claims on a pane click, a browser visibility
   change, a window focus, and a tab-group restore. These constants
   govern the two edges the app layer cannot see: a pane scrolling or
   switching into view, and the terminal taking keyboard focus without
   a click. Without them a phone that switches to a pane it was already
   attached to keeps receiving frames laid out for a desktop.
   ═══════════════════════════════════════════════════════════════════ */

// Minimum gap between two activate claims from the same pane. Visibility and
// focus can fire back to back for one user gesture; without this the pane
// would send a burst of identical claims.
const ACTIVATE_DEBOUNCE_MS = 500;

// A claim with UNCHANGED cols/rows is normally redundant, but ownership can
// move to another device at any time, so an identical claim is allowed again
// once this much time has passed. The backend suppresses no-op resizes
// (applyViewport returns early on identical dims), so a re-claim at the same
// size costs one small control frame and no repaint.
const ACTIVATE_REASSERT_MS = 5000;

// Quiet window after a connect or a server-initiated resync. The server
// replays scrollback immediately afterwards; claiming geometry in the middle
// of that would resize the PTY mid-replay and produce a torn screen.
const ACTIVATE_CONNECT_GUARD_MS = 1500;

// Fraction of the pane that must be on screen before it counts as the pane the
// user is actually looking at.
const ACTIVATE_VISIBILITY_RATIO = 0.5;

/* ═══════════════════════════════════════════════════════════════════
   PASTE INPUT PREPARATION
   Notion restyle phase P5, work packages P5.1 and P5.2.
   TERMINAL-ARCHITECTURE.md defects D1 and D2, sections 9.2 to 9.4.

   Three paste entry points (beforeinput/insertFromPaste, the native
   paste event, and the explicit pasteFromClipboard menu action) used to
   build their own payload with the same two lines each:

       const bracketedText = '\x1b[200~' + text + '\x1b[201~';
       this.ws.send(JSON.stringify({ type: 'input', data: bracketedText }));

   Both lines carried a defect that the architecture measured against a
   live PTY rather than inferred:

   D1  The brackets were applied UNCONDITIONALLY. DEC 2004 is a mode the
       APPLICATION turns on; an application that has not asked for it
       receives the literal characters `[200~` and `[201~` around the
       paste. Every agent CLI measured has the mode on, so this was
       invisible on the common path and broken on every bare shell.

   D2  Newlines were sent verbatim. Windows clipboard text is CRLF, and a
       PTY line discipline reads CR LF as an Enter FOLLOWED BY a stray
       line feed, so a two line paste executed as two commands plus two
       blank lines. xterm's own paste path normalises first, and this is
       the exact normalisation it performs.

   The fix is one pure function, at module level rather than on the class,
   for two reasons. It has no instance state, so it is testable without a
   DOM, an xterm or a socket; and test/bracketed-paste-isolation.test.js
   gates the character distance between `pasteFromClipboard` and
   `this.ws.send(`, so the call site has to stay one short line.
   ═══════════════════════════════════════════════════════════════════ */

// The multi-line paste confirm setting, TERMINAL-ARCHITECTURE 9.4. `auto` is
// the table: bracketed sessions never nag, unbracketed multi-line always asks.
// The other two exist because a user who knows what they are doing should be
// able to say so once instead of per paste.
const PASTE_CONFIRM_AUTO = 'auto';
const PASTE_CONFIRM_ALWAYS = 'always';
const PASTE_CONFIRM_NEVER = 'never';

// The two halves of DEC 2004 bracketed paste. Named rather than inlined so the
// sanitiser below and the wrapper agree by construction.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

// Every embedded end marker is removed from a bracketed payload. This is the
// one place in the terminal path where content from OUTSIDE the application
// (the system clipboard) is framed by control sequences, so it gets an
// explicit sanitiser rather than an assumption: an end marker inside the
// payload would close the bracket early and let everything after it be read as
// TYPED input by the receiving application. That is the difference between
// pasting a README that happens to quote an escape sequence and executing it.
const BRACKETED_PASTE_END_RE = /\x1b\[201~/g;

// How much of the first line the multi-line confirm shows. Long enough to
// recognise a command, short enough that the dialog never grows a scrollbar.
const PASTE_PREVIEW_MAX_CHARS = 120;

/**
 * Prepare clipboard text for delivery to a PTY.
 *
 * Pure: no DOM, no socket, no instance state, so the whole truth table is
 * unit-testable (test/paste-input-preparation.test.js).
 *
 * @param {string} text - Raw clipboard text, in whatever newline flavour the
 *   source platform used.
 * @param {{bracketedPasteMode?: boolean, confirmMultiline?: string}} [opts] -
 *   `bracketedPasteMode` is the LIVE state of DEC 2004 for the receiving
 *   application, never an assumption. `confirmMultiline` is the 9.4 setting
 *   and defaults to `auto`.
 * @returns {{data: string, needsConfirm: boolean, lineCount: number,
 *   bracketed: boolean, firstLine: string}} `data` is exactly what should go on
 *   the wire once any confirm has been answered.
 */
function prepareInputForPty(text, opts) {
  const options = opts || {};
  const raw = typeof text === 'string' ? text : (text == null ? '' : String(text));
  const bracketed = options.bracketedPasteMode === true;

  // D2. The same expression xterm uses (`e.replace(/\r?\n/g, "\r")`), chosen
  // deliberately over a broader one: CRLF and LF both become one CR, and a
  // LONE CR is already correct and is left exactly as it is.
  let data = raw.replace(/\r?\n/g, '\r');

  // Count before the brackets go on, so the count describes the user's text
  // rather than the framing. A trailing newline COUNTS as a second line,
  // because a trailing CR is what makes a shell execute the last command:
  // "one line plus Enter" is precisely the case the confirm exists for.
  const segments = data.split('\r');
  const lineCount = segments.length;
  const firstLine = segments[0].slice(0, PASTE_PREVIEW_MAX_CHARS);

  if (bracketed) {
    // D1's sanitiser, and then D1's wrapper. Order matters: strip first, so a
    // marker that arrived inside the payload cannot survive into the framed
    // string, and never strip the marker this function is about to add.
    data = data.replace(BRACKETED_PASTE_END_RE, '');
    data = BRACKETED_PASTE_START + data + BRACKETED_PASTE_END;
  }

  const multiline = lineCount > 1;
  const mode = options.confirmMultiline || PASTE_CONFIRM_AUTO;
  let needsConfirm;
  if (mode === PASTE_CONFIRM_NEVER) {
    needsConfirm = false;
  } else if (mode === PASTE_CONFIRM_ALWAYS) {
    needsConfirm = multiline;
  } else {
    // `auto`, the 9.4 table. An application that turned DEC 2004 on has told
    // the terminal it will handle a multi-line payload itself, so asking would
    // be nagging about a case that is already safe. Every agent CLI measured
    // in TERMINAL-ARCHITECTURE section 2 has it on, so the common path is
    // silent and the bare-shell path, where each line becomes a command, asks.
    needsConfirm = multiline && !bracketed;
  }

  return { data: data, needsConfirm: needsConfirm, lineCount: lineCount, bracketed: bracketed, firstLine: firstLine };
}

class TerminalPane {
  // ── Theme palettes for xterm.js ──────────────────────────
  static THEME_MOCHA = {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: 'rgba(203, 166, 247, 0.25)',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  };

  static THEME_LATTE = {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    cursorAccent: '#eff1f5',
    selectionBackground: 'rgba(136, 57, 239, 0.2)',
    selectionForeground: '#4c4f69',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#8839ef',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#6c6f85',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#8839ef',
    brightCyan: '#179299',
    brightWhite: '#bcc0cc',
  };

  static THEME_FRAPPE = {
    background: '#303446',
    foreground: '#c6d0f5',
    cursor: '#f2d5cf',
    cursorAccent: '#303446',
    selectionBackground: 'rgba(202, 158, 230, 0.3)',
    selectionForeground: '#c6d0f5',
    black: '#51576d',
    red: '#e78284',
    green: '#a6d189',
    yellow: '#e5c890',
    blue: '#8caaee',
    magenta: '#ca9ee6',
    cyan: '#81c8be',
    white: '#b5bfe2',
    brightBlack: '#626880',
    brightRed: '#e78284',
    brightGreen: '#a6d189',
    brightYellow: '#e5c890',
    brightBlue: '#8caaee',
    brightMagenta: '#ca9ee6',
    brightCyan: '#81c8be',
    brightWhite: '#c6d0f5',
  };

  static THEME_MACCHIATO = {
    background: '#24273a',
    foreground: '#cad3f5',
    cursor: '#f4dbd6',
    cursorAccent: '#24273a',
    selectionBackground: 'rgba(198, 160, 246, 0.3)',
    selectionForeground: '#cad3f5',
    black: '#494d64',
    red: '#ed8796',
    green: '#a6da95',
    yellow: '#eed49f',
    blue: '#8aadf4',
    magenta: '#c6a0f6',
    cyan: '#8bd5ca',
    white: '#b8c0e0',
    brightBlack: '#5b6078',
    brightRed: '#ed8796',
    brightGreen: '#a6da95',
    brightYellow: '#eed49f',
    brightBlue: '#8aadf4',
    brightMagenta: '#c6a0f6',
    brightCyan: '#8bd5ca',
    brightWhite: '#cad3f5',
  };

  static THEME_CHERRY = {
    background: '#221a22',
    foreground: '#f0ddf0',
    cursor: '#f5a0d0',
    cursorAccent: '#221a22',
    selectionBackground: 'rgba(245, 160, 208, 0.25)',
    selectionForeground: '#f0ddf0',
    black: '#4c404e',
    red: '#f07888',
    green: '#a0d890',
    yellow: '#f0d098',
    blue: '#90b0ea',
    magenta: '#e890c8',
    cyan: '#80d8c0',
    white: '#dcc8e0',
    brightBlack: '#605464',
    brightRed: '#f07888',
    brightGreen: '#a0d890',
    brightYellow: '#f0d098',
    brightBlue: '#90b0ea',
    brightMagenta: '#e890c8',
    brightCyan: '#80d8c0',
    brightWhite: '#f0ddf0',
  };

  static THEME_OCEAN = {
    background: '#1a1e28',
    foreground: '#d8e4f5',
    cursor: '#70a8f0',
    cursorAccent: '#1a1e28',
    selectionBackground: 'rgba(112, 168, 240, 0.25)',
    selectionForeground: '#d8e4f5',
    black: '#384254',
    red: '#f08888',
    green: '#80d8a0',
    yellow: '#f0d880',
    blue: '#70a8f0',
    magenta: '#b0a0ea',
    cyan: '#60d8d0',
    white: '#b8ccdc',
    brightBlack: '#4a5668',
    brightRed: '#f08888',
    brightGreen: '#80d8a0',
    brightYellow: '#f0d880',
    brightBlue: '#70a8f0',
    brightMagenta: '#b0a0ea',
    brightCyan: '#60d8d0',
    brightWhite: '#d8e4f5',
  };

  static THEME_AMBER = {
    background: '#211e1a',
    foreground: '#f0e8d8',
    cursor: '#f0d070',
    cursorAccent: '#211e1a',
    selectionBackground: 'rgba(240, 208, 112, 0.25)',
    selectionForeground: '#f0e8d8',
    black: '#4c4438',
    red: '#e08878',
    green: '#a0d090',
    yellow: '#f0d070',
    blue: '#88b4d8',
    magenta: '#d0a8d8',
    cyan: '#78c8b8',
    white: '#dcd4bc',
    brightBlack: '#605848',
    brightRed: '#e08878',
    brightGreen: '#a0d090',
    brightYellow: '#f0d070',
    brightBlue: '#88b4d8',
    brightMagenta: '#d0a8d8',
    brightCyan: '#78c8b8',
    brightWhite: '#f0e8d8',
  };

  static THEME_MINT = {
    background: '#1a2120',
    foreground: '#d8f0e8',
    cursor: '#78e0a0',
    cursorAccent: '#1a2120',
    selectionBackground: 'rgba(120, 224, 160, 0.25)',
    selectionForeground: '#d8f0e8',
    black: '#3c4a48',
    red: '#e09090',
    green: '#78e0a0',
    yellow: '#e0d890',
    blue: '#80b4e0',
    magenta: '#c0a0e0',
    cyan: '#60e0c8',
    white: '#c0dcd4',
    brightBlack: '#4e5e5c',
    brightRed: '#e09090',
    brightGreen: '#78e0a0',
    brightYellow: '#e0d890',
    brightBlue: '#80b4e0',
    brightMagenta: '#c0a0e0',
    brightCyan: '#60e0c8',
    brightWhite: '#d8f0e8',
  };

  /**
   * Build an xterm palette from the semantic color slots shared by every
   * Workbook CSS theme. Light themes use darker neutral slots for ANSI black
   * and lighter surface slots for ANSI white so both ends remain legible.
   */
  static _buildThemePalette(tokens, isLight) {
    return {
      background: tokens.base,
      foreground: tokens.text,
      cursor: tokens.rosewater,
      cursorAccent: tokens.base,
      selectionBackground: TerminalPane._colorWithAlpha(
        tokens.mauve,
        isLight ? 0.2 : 0.25,
        isLight ? 'rgba(136, 57, 239, 0.2)' : 'rgba(203, 166, 247, 0.25)'
      ),
      selectionForeground: tokens.text,
      black: isLight ? tokens.subtext1 : tokens.surface1,
      red: tokens.red,
      green: tokens.green,
      yellow: tokens.yellow,
      blue: tokens.blue,
      magenta: tokens.mauve,
      cyan: tokens.teal,
      white: isLight ? tokens.surface2 : tokens.subtext1,
      brightBlack: isLight ? tokens.subtext0 : tokens.surface2,
      brightRed: tokens.red,
      brightGreen: tokens.green,
      brightYellow: tokens.yellow,
      brightBlue: tokens.blue,
      brightMagenta: tokens.mauve,
      brightCyan: tokens.teal,
      brightWhite: isLight ? tokens.surface1 : tokens.text,
    };
  }

  /**
   * Apply alpha to a six-digit CSS hex color. Custom properties currently
   * resolve to hex; if a future theme uses another format, preserve its
   * complete static selection fallback rather than returning invalid CSS.
   */
  static _colorWithAlpha(color, alpha, fallback) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!match) return fallback;
    const value = parseInt(match[1], 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  /**
   * Complete, theme-correct fallbacks for environments where computed CSS is
   * unavailable (unit tests, early startup, or a detached document).
   */
  static _getThemeFallback(themeId) {
    switch (themeId) {
      case 'mocha': return TerminalPane.THEME_MOCHA;
      case 'latte': return TerminalPane.THEME_LATTE;
      case 'frappe': return TerminalPane.THEME_FRAPPE;
      case 'macchiato': return TerminalPane.THEME_MACCHIATO;
      case 'cherry': return TerminalPane.THEME_CHERRY;
      case 'ocean': return TerminalPane.THEME_OCEAN;
      case 'amber': return TerminalPane.THEME_AMBER;
      case 'mint': return TerminalPane.THEME_MINT;
      case 'nord':
        return TerminalPane._buildThemePalette({
          base: '#2e3440',
          surface1: '#434c5e',
          surface2: '#4c566a',
          text: '#eceff4',
          subtext0: '#a5b1c2',
          subtext1: '#d8dee9',
          mauve: '#b48ead',
          blue: '#81a1c1',
          green: '#a3be8c',
          yellow: '#ebcb8b',
          red: '#bf616a',
          teal: '#8fbcbb',
          rosewater: '#d8b4a0',
        }, false);
      case 'dracula':
        return TerminalPane._buildThemePalette({
          base: '#282a36',
          surface1: '#44475a',
          surface2: '#545768',
          text: '#f8f8f2',
          subtext0: '#b8b8b0',
          subtext1: '#d8d8d0',
          mauve: '#bd93f9',
          blue: '#8be9fd',
          green: '#50fa7b',
          yellow: '#f1fa8c',
          red: '#ff5555',
          teal: '#8be9fd',
          rosewater: '#ffd0e0',
        }, false);
      case 'tokyo-night':
        return TerminalPane._buildThemePalette({
          base: '#1a1b26',
          surface1: '#3b4261',
          surface2: '#545c7e',
          text: '#c0caf5',
          subtext0: '#9aa5ce',
          subtext1: '#a9b1d6',
          mauve: '#bb9af7',
          blue: '#7aa2f7',
          green: '#9ece6a',
          yellow: '#e0af68',
          red: '#f7768e',
          teal: '#73daca',
          rosewater: '#ffc0cb',
        }, false);
      case 'rose-pine-dawn':
        return TerminalPane._buildThemePalette({
          base: '#faf4ed',
          surface1: '#dfdad9',
          surface2: '#cecacd',
          text: '#575279',
          subtext0: '#6e6a86',
          subtext1: '#635f7b',
          mauve: '#907aa9',
          blue: '#286983',
          green: '#56949f',
          yellow: '#ea9d34',
          red: '#b4637a',
          teal: '#56949f',
          rosewater: '#d7827e',
        }, true);
      case 'gruvbox-light':
        return TerminalPane._buildThemePalette({
          base: '#fbf1c7',
          surface1: '#bdae93',
          surface2: '#a89984',
          text: '#3c3836',
          subtext0: '#504945',
          subtext1: '#453e3a',
          mauve: '#8f3f71',
          blue: '#076678',
          green: '#79740e',
          yellow: '#b57614',
          red: '#9d0006',
          teal: '#427b58',
          rosewater: '#c8956c',
        }, true);
      default:
        return null;
    }
  }

  /**
   * Resolve a palette from the active root custom properties. Each field has
   * a complete static fallback, so a missing variable can never make xterm
   * inherit colors from a different theme.
   */
  static _getCssVariableTheme(fallback, isLight) {
    if (typeof document === 'undefined' || !document.documentElement) return fallback;

    let styles;
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        styles = window.getComputedStyle(document.documentElement);
      } else if (typeof getComputedStyle === 'function') {
        styles = getComputedStyle(document.documentElement);
      } else {
        return fallback;
      }
    } catch (_) {
      return fallback;
    }

    const read = (property, fallbackValue) => {
      try {
        const value = styles.getPropertyValue(property).trim();
        return value || fallbackValue;
      } catch (_) {
        return fallbackValue;
      }
    };

    const tokens = {
      base: read('--base', fallback.background),
      surface1: read('--surface1', fallback.black),
      surface2: read('--surface2', fallback.brightBlack),
      text: read('--text', fallback.foreground),
      subtext0: read('--subtext0', isLight ? fallback.brightBlack : fallback.brightWhite),
      subtext1: read('--subtext1', isLight ? fallback.black : fallback.white),
      mauve: read('--mauve', fallback.magenta),
      blue: read('--blue', fallback.blue),
      green: read('--green', fallback.green),
      yellow: read('--yellow', fallback.yellow),
      red: read('--red', fallback.red),
      teal: read('--teal', fallback.cyan),
      rosewater: read('--rosewater', fallback.cursor),
    };
    const palette = TerminalPane._buildThemePalette(tokens, isLight);

    // _buildThemePalette derives selection alpha from --mauve. Retain the
    // theme-specific static value if that custom property was not usable.
    palette.selectionBackground = TerminalPane._colorWithAlpha(
      tokens.mauve,
      isLight ? 0.2 : 0.25,
      fallback.selectionBackground
    );
    return palette;
  }

  /**
   * The terminal surface projection, when one is reachable.
   *
   * Notion restyle P5.4. Prefers the global that index.html loads immediately
   * before this file, and falls back to the theme registry's own null-safe
   * accessor so a consumer that loaded the registry but not the surface still
   * resolves. Returns null rather than throwing on every failure path,
   * because every caller has a complete static fallback and a missing script
   * must degrade to the previous behaviour rather than to a blank pane.
   *
   * @returns {object|null} The `MyrlinTerminalSurface` module, or null.
   */
  static _surfaceProvider() {
    try {
      if (typeof window !== 'undefined' && window.MyrlinTerminalSurface) {
        return window.MyrlinTerminalSurface;
      }
      if (typeof globalThis !== 'undefined' && globalThis.MyrlinTerminalSurface) {
        return globalThis.MyrlinTerminalSurface;
      }
    } catch (_) { /* a sandboxed or partially initialised global */ }
    return null;
  }

  /**
   * The active theme id, as the document has stamped it.
   *
   * One reader, because three call sites used to spell the same expression
   * and the `|| 'mocha'` default is load bearing: the pre-paint bootstrap in
   * index.html sets the attribute before any script runs, but a detached
   * document in a test has none.
   *
   * @returns {string} A persisted theme id.
   */
  static _activeThemeId() {
    try {
      if (typeof document !== 'undefined' && document.documentElement &&
          document.documentElement.dataset) {
        return document.documentElement.dataset.theme || 'mocha';
      }
    } catch (_) { /* detached document */ }
    return 'mocha';
  }

  /**
   * Publish the terminal surface to CSS as `--term-*` custom properties.
   *
   * Notion restyle P5.4 and P5.5. This is what lets the pane's own chrome (the
   * surface padding, the input row, its top rule and the prompt glyph) paint
   * the SAME values xterm paints rather than a near neighbour, which
   * TERMINAL-ARCHITECTURE.md 10.1 calls the highest risk item for perceived
   * quality: a seam of one shade is immediately visible.
   *
   * Called from three places, deliberately overlapping, because each covers a
   * case the others cannot:
   *
   *   1. At module load, so the first paint after a reload is already correct.
   *   2. From getCurrentTheme(), which app.js already calls once per live pane
   *      on every theme change, so an existing installation needs no app.js
   *      edit to re-theme its chrome.
   *   3. From a `data-theme` MutationObserver, which is the only one of the
   *      three that fires when the theme changes with ZERO panes open. Without
   *      it, switching theme on the Sessions view would leave the `--term-*`
   *      properties stale until a pane happened to open.
   *
   * @param {string} [themeId] - Theme to publish. Defaults to the active one.
   * @returns {boolean} Whether the properties were written.
   */
  static publishTerminalSurfaceVars(themeId) {
    const provider = TerminalPane._surfaceProvider();
    if (!provider || typeof provider.applyTerminalSurfaceVars !== 'function') return false;
    try {
      return provider.applyTerminalSurfaceVars(themeId || TerminalPane._activeThemeId());
    } catch (_) {
      return false;
    }
  }

  static getCurrentTheme() {
    const themeId = TerminalPane._activeThemeId();

    // P5.4: the projection is the single source of truth for terminal surface
    // colour. It is consulted FIRST and it needs no computed CSS, so a pane
    // constructed before first paint gets the right palette rather than a
    // half-resolved one. Publishing the CSS custom properties here is what
    // keeps app.js's existing per-pane re-theme loop sufficient for the chrome
    // half as well, with no edit to a file this work package does not own.
    //
    // Everything below this block is UNCHANGED and stays as the last resort,
    // exactly as BUILD-CONTRACT P5.4 requires: "with the eight existing static
    // palettes retained as the last-resort fallback so a missing custom
    // property can never make one pane inherit another theme's colours". If
    // terminal-surface.js fails to load, the terminal is what it was before P5.
    const provider = TerminalPane._surfaceProvider();
    if (provider && typeof provider.xtermTheme === 'function') {
      let projected = null;
      try {
        projected = provider.xtermTheme(themeId);
      } catch (_) {
        projected = null;
      }
      if (projected) {
        TerminalPane.publishTerminalSurfaceVars(themeId);
        return projected;
      }
    }

    const fallback = TerminalPane._getThemeFallback(themeId);
    if (!fallback) return TerminalPane.THEME_MOCHA;
    const isCssDerivedTheme = themeId === 'nord'
      || themeId === 'dracula'
      || themeId === 'tokyo-night'
      || themeId === 'rose-pine-dawn'
      || themeId === 'gruvbox-light';
    if (!isCssDerivedTheme) return fallback;
    const isLight = themeId === 'rose-pine-dawn'
      || themeId === 'gruvbox-light';
    return TerminalPane._getCssVariableTheme(fallback, isLight);
  }

  /**
   * The terminal face.
   *
   * Notion restyle P5.5, and the answer to CURRENT-UI.md 6.2's other half:
   * "Font family and size are hardcoded here, NOT read from --font-mono."
   * They now come through the projection, which reads the `--font-terminal`
   * token, so a theme can carry its own face and a user can change the face
   * without editing JavaScript.
   *
   * The literal below is retained EXACTLY as it was and is the last resort, so
   * a failure to load terminal-surface.js leaves the terminal on the face it
   * has always had rather than on a browser default. That matters more here
   * than anywhere else in the application: an unexpected fallback face changes
   * the cell width, which changes the column count, which changes what the CLI
   * on the other end draws.
   *
   * @returns {string} A CSS font-family list for xterm's `fontFamily` option.
   */
  static getTerminalFontFamily() {
    const provider = TerminalPane._surfaceProvider();
    try {
      if (provider && typeof provider.terminalSurface === 'function') {
        const surface = provider.terminalSurface(TerminalPane._activeThemeId());
        if (surface && typeof surface.fontFamily === 'string' && surface.fontFamily.trim()) {
          return surface.fontFamily.trim();
        }
      }
    } catch (_) { /* fall through to the shipped stack */ }
    return "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";
  }

  // Resolve the smooth-scroll animation duration in ms. Reads the persisted
  // setting, honors the OS reduced-motion preference, and returns 0 (instant)
  // when either opts out. One place so panes constructed before app settings
  // load still behave correctly.
  static getSmoothScrollDuration() {
    try {
      const s = JSON.parse(localStorage.getItem('cwm_settings') || '{}');
      if (s.smoothScrolling === false) return 0;
    } catch (_) {}
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    return SMOOTH_SCROLL_DURATION_MS;
  }

  // ── Universal clipboard copy (secure-context safe) ─────────────
  // WHY these live on TerminalPane as statics: terminal.js is the shared
  // seam between the pane and the app shell. index.html loads terminal.js
  // before app.js, and app.js already consumes TerminalPane statics
  // (getCurrentTheme), so both files copy through this one implementation
  // without inventing a module system for the public/ scripts.

  /**
   * Copy text to the clipboard on ANY origin, secure or not.
   *
   * The async Clipboard API (navigator.clipboard.writeText) only exists in
   * secure contexts (https or localhost). On plain http to a LAN IP or
   * hostname, the documented remote-access mode, navigator.clipboard is
   * undefined and even PROPERTY ACCESS on it throws a SYNCHRONOUS TypeError
   * that a chained .catch() can never intercept (.catch only sees promise
   * rejections, not a throw during property lookup). That exact trap is what
   * turned Ctrl+C-to-copy into a SIGINT to the running CLI (see the Ctrl+C
   * branch in attachCustomKeyEventHandler) and is the copy-side twin of
   * paste issue #64.
   *
   * WHY copy can work everywhere while paste cannot: browsers still permit
   * document.execCommand('copy') from script during a user gesture on every
   * origin, because copying exposes nothing the page did not already have.
   * Programmatic PASTE reads foreign clipboard data and is dead from script
   * on insecure origins, which is why the paste path can only degrade to a
   * "press Ctrl+V" hint while this helper has a real universal fallback.
   *
   * Gesture ordering matters: an embedded browser may expose writeText but
   * reject it only after the trusted click has expired. Explicit copy actions
   * therefore make the synchronous execCommand attempt FIRST, while user
   * activation is unquestionably live, then invoke writeText immediately in
   * the SAME call stack whenever it exists.
   *
   * Both attempts are intentional. Chromium/WebView can return true from
   * execCommand('copy') even though the OS clipboard was not changed. That
   * boolean means the command was accepted, not that a clipboard commit can be
   * verified, so it must never short-circuit the modern API. Conversely, the
   * synchronous attempt remains the only viable path on insecure LAN origins
   * and can rescue embedded browsers that expose but deny writeText. The
   * function check remains required because some engines expose a clipboard
   * object without writeText.
   *
   * Contract: NEVER throws and the returned promise NEVER rejects, under any
   * circumstance, so callers inside click handlers stay exception-safe.
   *
   * @param {string} text - Text to place on the clipboard ('' when nullish).
   * @returns {Promise<boolean>} Resolves true when the copy succeeded, false
   *   when every available path failed. Never rejects.
   */
  static copyTextToClipboard(text) {
    const value = (text === null || text === undefined) ? '' : String(text);
    try {
      // Preserve the trusted user gesture. If this helper was entered from a
      // menu/button click, execCommand(copy) runs synchronously in that same
      // stack and cannot lose activation while an async permission check is
      // settling. Do not treat its return value as proof of an OS clipboard
      // write: embedded Chromium has been observed returning true for a no-op.
      let legacyVerified = false;
      try {
        legacyVerified = TerminalPane._copyViaExecCommand(value);
      } catch (_) {}

      if (typeof navigator !== 'undefined' && navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function') {
        // Invoke this before yielding/awaiting so the click activation is still
        // live. A resolved writeText is the authoritative secure-origin result.
        // Map BOTH outcomes so the promise returned to callers never rejects.
        let modernWrite;
        try {
          modernWrite = navigator.clipboard.writeText(value);
        } catch (_) {
          // Some implementations throw synchronously instead of returning a
          // rejected promise. Preserve any already-completed legacy copy, or
          // retry that path once if the first attempt was unavailable.
          if (legacyVerified) return Promise.resolve(true);
          try {
            return Promise.resolve(TerminalPane._copyViaExecCommand(value));
          } catch (_) {
            return Promise.resolve(false);
          }
        }
        return Promise.resolve(modernWrite).then(
          () => true,
          () => {
            if (legacyVerified) return true;
            try { return TerminalPane._copyViaExecCommand(value); } catch (_) { return false; }
          }
        );
      }
      return Promise.resolve(legacyVerified);
    } catch (_) {
      // Belt and braces: callers never see a gesture-handler exception.
      return Promise.resolve(false);
    }
  }

  /**
   * Fallback copy via a temporary offscreen textarea and
   * document.execCommand('copy'). Standard technique; kept private, callers
   * use copyTextToClipboard which picks the right path.
   *
   * The textarea is rendered but invisible: execCommand('copy') copies the
   * CURRENT SELECTION, so the element must be selectable (display:none would
   * break it, and readOnly is deliberately not set because a real selection
   * is required). position:fixed at 1px keeps the focus jump from scrolling
   * the page; aria-hidden keeps it out of the accessibility tree.
   *
   * The user's prior focus and document selection are snapshotted and
   * restored where practical: xterm selections live in xterm's own model,
   * not the document selection, so terminal copies are unaffected, but this
   * protects copies triggered while text elsewhere on the page (an input,
   * the docs panel) is selected.
   *
   * @param {string} value - Already-stringified text to copy.
   * @returns {boolean} True only when execCommand reported success AND its
   *   synchronous copy event accepted the explicit clipboard payload. Never
   *   throws.
   */
  static _copyViaExecCommand(value) {
    if (typeof document === 'undefined' || !document.body ||
        typeof document.execCommand !== 'function') {
      return false;
    }
    const prevActive = document.activeElement;
    const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
    const savedRanges = [];
    if (selection && typeof selection.rangeCount === 'number') {
      for (let i = 0; i < selection.rangeCount; i++) {
        try { savedRanges.push(selection.getRangeAt(i)); } catch (_) {}
      }
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.boxShadow = 'none';
    ta.style.background = 'transparent';
    ta.style.opacity = '0';
    // Supplying the payload on the synchronous copy event is more reliable
    // than trusting the textarea's default selection transfer in embedded
    // browsers. The listener is scoped to the temporary element, and setting
    // clipboardData is permitted during the trusted copy gesture even when the
    // async Clipboard API is unavailable on an insecure origin.
    let copyEventHandled = false;
    if (typeof ta.addEventListener === 'function') {
      ta.addEventListener('copy', (event) => {
        try {
          if (event.clipboardData &&
              typeof event.clipboardData.setData === 'function') {
            event.clipboardData.setData('text/plain', value);
            event.preventDefault();
            copyEventHandled = true;
          }
        } catch (_) {}
      }, { once: true });
    }
    let ok = false;
    try {
      document.body.appendChild(ta);
      if (typeof ta.focus === 'function') ta.focus({ preventScroll: true });
      if (typeof ta.select === 'function') ta.select();
      // iOS Safari ignores select() on some versions; the explicit range
      // makes the selection real there too.
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, value.length);
      const commandAccepted = !!document.execCommand('copy');
      // A truthy execCommand result only means the command was accepted. Some
      // embedded Chromium hosts return true without dispatching `copy` or
      // changing the platform clipboard. Require the synchronous event to
      // confirm that our explicit payload was actually handled.
      ok = commandAccepted && copyEventHandled;
    } catch (_) {
      ok = false;
    } finally {
      // ALWAYS remove the scratch element, even when execCommand threw, so
      // repeated failed copies can never leak textareas into the DOM.
      try { if (ta.parentNode) ta.parentNode.removeChild(ta); } catch (_) {}
      // Restore the user's selection and focus, best-effort: a failure here
      // must not turn a successful copy into a throw.
      try {
        if (selection && savedRanges.length) {
          selection.removeAllRanges();
          for (const r of savedRanges) selection.addRange(r);
        }
        if (prevActive && prevActive !== document.body &&
            typeof prevActive.focus === 'function') {
          prevActive.focus({ preventScroll: true });
        }
      } catch (_) {}
    }
    return ok;
  }

  // ── Idle-notification gating constants (notification-storm fix) ──
  // Minimum ANSI-stripped, trimmed characters a flushed chunk must contain
  // to count as "meaningful output" that re-arms idle detection. Cosmetic
  // repaints (cursor moves, focus reports, spinner ticks) strip down to
  // almost nothing and must not re-arm the notifier.
  static MIN_REARM_CHARS = 24;
  // A pane will not dispatch terminal-idle more than once per this window,
  // even if a full-screen repaint (SIGWINCH after a grid resize) re-arms it.
  static IDLE_REFIRE_COOLDOWN_MS = 30000;
  // After a WebSocket (re)connect, mute idle detection for this long so the
  // server's scrollback replay burst cannot fire a "ready for input" toast.
  static REPLAY_SUPPRESS_MS = 3000;
  // Select mode is intentionally per terminal session: enabling it should
  // survive a browser refresh for that same session without disabling
  // clickable TUI controls in every other pane.
  static SELECT_MODE_STORAGE_PREFIX = 'cwm_terminal_select_mode_v1:';
  // Matches CSI escape sequences. Same pattern _detectActivity and
  // _analyzeForAutoTrust already use for ANSI stripping; hoisted to a named
  // constant so the re-arm gate shares it. Only used with .replace (safe
  // for a /g regex; lastIndex is not carried across replace calls).
  static ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

  static _selectModeStorageKey(sessionId) {
    const id = (sessionId === null || sessionId === undefined)
      ? ''
      : String(sessionId).trim();
    if (!id) return '';
    try {
      return TerminalPane.SELECT_MODE_STORAGE_PREFIX + encodeURIComponent(id);
    } catch (_) {
      return '';
    }
  }

  static _loadSelectModePreference(sessionId) {
    const key = TerminalPane._selectModeStorageKey(sessionId);
    if (!key || typeof localStorage === 'undefined') return false;
    try {
      return localStorage.getItem(key) === '1';
    } catch (_) {
      return false;
    }
  }

  static _saveSelectModePreference(sessionId, on) {
    const key = TerminalPane._selectModeStorageKey(sessionId);
    if (!key || typeof localStorage === 'undefined') return;
    try {
      if (on) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch (_) {}
  }

  constructor(containerId, sessionId, sessionName, spawnOpts) {
    this.containerId = containerId;
    this.sessionId = sessionId;
    this.sessionName = sessionName || 'Terminal';
    this.spawnOpts = spawnOpts || {}; // Extra params for PTY spawn (cwd, resumeSessionId, etc.)
    this.term = null;
    this.fitAddon = null;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._gotFirstData = false;
    // Completion detection: track whether Claude is actively producing output
    this._isWorking = false;
    this._idleNotified = false; // true once terminal-idle has fired; prevents re-notification on trivial PTY output
    this._lastOutputTime = 0;
    this._idleCheckTimer = null;
    // Notification-storm gating (see MIN_REARM_CHARS and friends above):
    // _suppressIdleUntil: while Date.now() is below this, idle checks are
    //   muted so scrollback replay bursts (mount AND reconnect) never notify.
    // _lastIdleFiredAt: timestamp of the last terminal-idle dispatch, used
    //   for the per-pane refire cooldown (IDLE_REFIRE_COOLDOWN_MS).
    this._suppressIdleUntil = 0;
    this._lastIdleFiredAt = 0;
    // Activity detection: real-time parsing of Claude Code output patterns
    this._currentActivity = null; // { type: 'thinking'|'reading'|'writing'|'running'|'searching'|'idle', detail: '...' }
    this._activityBuffer = '';    // Rolling buffer for pattern matching (last ~500 chars)
    // Focus tracking: background terminals flush at lower frequency to prevent
    // main-thread blocking (the primary cause of cursor freezes with multiple panes)
    this._isFocused = false;
    this._bgFlushTimer = null;
    // Callback for fatal connection failure (max retries exhausted or server error).
    // App.js uses this to auto-close dead panes so they don't occupy grid space.
    this.onFatalError = null;
    // Auto-trust: rolling buffer of ANSI-stripped PTY output for pattern matching
    this._autoTrustBuffer = '';      // 4KB rolling buffer
    this._autoTrustCooldown = 0;     // Timestamp of last auto-trust action
    this._needsInput = false;        // Whether a question was detected that wasn't auto-answered
    this._needsInputTimer = null;    // Timer to clear needsInput after new output
    this._autoTrustEnabled = false;  // Set by app layer for worktree task terminals
    // Write batching buffers — must be initialized here so _status() calls in
    // mount() (before connectWs runs) don't produce "undefined" prefixes.
    this._writeBuf = '';
    this._activitySample = '';
    this._writeRaf = null;
    this._pasteHandled = false;
    this._pasteHandledResetTimer = null;
    // ── P5.1 paste correctness state ─────────────────────────────
    // _remoteBracketedPaste: the last DEC 2004 state reported by the server's
    //   VT sidecar `mode` frame (P6.3). Stays undefined, and therefore unused,
    //   whenever CWM_VT_SIDECAR is off, which is the default. Never a boolean
    //   until a frame actually arrives, so `typeof === 'boolean'` is the test.
    // _modeSeq: the highest mode-frame sequence number seen. The sidecar
    //   stamps a monotonic seq precisely so a client can drop a reordered or
    //   duplicated frame without keeping its own history.
    // _pasteConfirmEl: the live multi-line paste dialog, so a pane that is
    //   disposed or rebound mid-decision cannot leave one orphaned in the DOM.
    this._remoteBracketedPaste = undefined;
    this._modeSeq = 0;
    this._pasteConfirmEl = null;
    // Copy-mode root cause (user report, 2026-07-25): Claude Code's interactive
    // TUI turns on terminal mouse tracking (DECSET 1000/1002/1003 + SGR 1006).
    // While that is active, xterm forwards a plain drag/wheel to the PTY instead
    // of making a text selection, so plain-drag never selects and Ctrl+C finds
    // no selection. xterm's documented escape hatch is Shift (shouldForceSelection
    // returns event.shiftKey on non-Mac), so Shift+drag always selects. This flag
    // powers an opt-in per-pane "Select mode" that makes a PLAIN drag behave like
    // a Shift+drag, so the user can copy without the interactive layer being
    // disabled globally. It starts OFF unless this same session was explicitly
    // enabled before a refresh, so unrelated panes keep clickable TUI options.
    this._selectMode = TerminalPane._loadSelectModePreference(this.sessionId);
    // References to the injected copy-mode DOM + the capture-phase mouse
    // interceptor, so dispose() can tear everything down cleanly.
    this._selectModeBtn = null;
    this._selStrip = null;
    this._copyHint = null;
    this._copyHintTimer = null;
    this._selMouseHandler = null;
    this._selInterceptorContainer = null;
    this._selectDragging = false;
    // ── Select mode v2: freeze-while-selecting state ─────────────
    // _selectFrozenAt: when the current freeze started (diagnostics only).
    // _selWheelHandler/_selWheelTarget: the capture-phase wheel guard that
    //   stops the app from scrolling (and therefore repainting) underneath a
    //   selection. Installed with the mouse interceptor, inert while OFF, and
    //   released by detachHostBindings like every other host-owned listener.
    // _selNoticeTimer: timer that clears a transient strip message.
    // _fitDeferredWhileFrozen: a container resize arrived while frozen and was
    //   deliberately not applied (a row-count change would clear the xterm
    //   selection and reflow the snapshot). Re-fit on unfreeze.
    // _freezeBlockedUntil: while Date.now() is below this the freeze is
    //   SUSPENDED even with Select mode on, so a scrollback replay always
    //   reaches the screen. The server sends a reset marker plus a full replay
    //   on EVERY attach, including the first one after a refresh, and Select
    //   mode is a per-session preference that survives that refresh. Without
    //   this window a user who left the toggle on would come back to a pane
    //   that holds its own replay and looks blank.
    // ── Select mode v3: the hold is what freezes, not the toggle ──
    // _selectHold: true only while a selection is being made or is being held.
    //   v2 froze the write pipeline the instant the toggle went ON, which is
    //   what the user hit: "when i toggle select, the window freezes and i
    //   cannot scroll or drag up". Real usage is toggle first, position the
    //   content, THEN drag. So the pause now starts at drag start and ends
    //   when the selection goes away. Select mode itself is unchanged: it is
    //   still the per-session preference that makes a plain drag select.
    this._selectHold = false;
    this._selectFrozenAt = 0;
    this._freezeBlockedUntil = 0;
    this._selWheelHandler = null;
    this._selWheelTarget = null;
    this._selNoticeTimer = null;
    this._selSelectionDisposable = null;
    this._fitDeferredWhileFrozen = false;
    // ── Copy view overlay state (per pane, never shared) ─────────
    // The overlay is hosted on paneEl, so it is host-owned state: created
    // lazily on first open and destroyed by detachHostBindings so a cached
    // group never leaves an overlay attached to a slot another session took.
    this._copyViewBtn = null;
    this._copyOverlay = null;
    this._copyOverlayPre = null;
    this._copyOverlayBtns = null;
    this._copyOverlayKeyHandler = null;
    this._copyOverlayOpen = false;
    this._copyViewText = '';
    this._copyFeedbackTimer = null;
    // ── Copy view: Full transcript source state ──────────────────
    // _copyViewSource: which source the overlay is showing right now.
    // _copyViewMessages: transcript messages in document order, oldest first.
    // _copyViewStartOffset: byte offset of the OLDEST loaded line; the cursor
    //   "Load earlier" pages backward from. null means nothing loaded yet.
    // _copyViewTruncatedHead: the server reported that the window it returned
    //   started mid-file, so there is genuinely more above what is shown.
    // _copyViewLoading: a fetch is in flight; keeps the controls idempotent.
    this._copyViewSource = COPY_VIEW_SOURCE_TERMINAL;
    this._copyViewMessages = [];
    this._copyViewStartOffset = null;
    this._copyViewTruncatedHead = false;
    this._copyViewLoading = false;
    this._copyViewSourceBtns = null;
    this._copyViewLoadEarlierBtn = null;
    this._copyViewNoticeEl = null;
    // ── Visible-pane width claim state ───────────────────────────
    // One PTY is shared by every attached client and the backend hands
    // geometry ownership to whichever client last typed or sent 'activate'.
    // A pane that becomes the one the user is looking at claims ownership so
    // the CLI repaints at THIS device's width, which is what makes a phone
    // readable instead of showing 200 column frames wrapped to 60.
    // _lastActivateAt / _lastActivateCols / _lastActivateRows: debounce and
    //   no-op suppression inputs (see ACTIVATE_DEBOUNCE_MS / ACTIVATE_REASSERT_MS).
    // _activatePending: a claim was requested while output was frozen and is
    //   waiting for the freeze to lift.
    // _activateBlockedUntil: quiet window covering connect and resync replays.
    // _paneObserver / _paneVisible / _activateFocusHandler: the two triggers,
    //   both host-owned and released by detachHostBindings.
    this._lastActivateAt = 0;
    this._lastActivateCols = null;
    this._lastActivateRows = null;
    this._activatePending = false;
    this._activateBlockedUntil = 0;
    this._activateRetryTimer = null;
    this._paneObserver = null;
    this._paneVisible = false;
    this._activateFocusHandler = null;
    this._activateFocusTarget = null;
    this._hostMobileTypeMode = undefined;
    this._mobileSelectionResetTimer = null;
    this._copyHintShown = false;
    // Issue #41: true while a mobile touch gesture (or its momentum tail) is
    // driving term.scrollLines() directly. xterm's smoothScrollDuration is
    // zeroed for that window so the engine's per-frame interpolation is not
    // double-eased by xterm's own scroll animation on every scrollLines call.
    this._engineDriving = false;
    // Resize dedup: the last cols/rows actually sent to the server. Redundant
    // resize messages force ConPTY viewport repaints that pollute every
    // client's stream and the shared scrollback, so resize is only sent when
    // dimensions really changed (see _sendResizeIfChanged).
    this._lastSentCols = null;
    this._lastSentRows = null;
    // Mount has two deferred animation frames plus a delayed refit. Track a
    // generation and every handle so dispose-before-frame cannot resurrect a
    // closed pane or connect a stale WebSocket.
    this._disposed = false;
    this._mountGeneration = 0;
    this._mountRafOuter = null;
    this._mountRafInner = null;
    this._mountRefitTimer = null;
    // Plan 19-02 (PTY-04, PTY-05): per-pane provider context. Both fields are
    // populated in mount() after the pane DOM exists. _providerId drives idle
    // detection and Shift+Enter dispatch; defaults to the back-compat provider
    // id (see line below) if data-provider is missing for any reason (e.g., a
    // pane created before Phase 18-01).
    this.paneEl = null;
    this._providerId = 'claude'; // gsd:provider-literal-allowed (Phase 19 default before mount)
    // Issue #68: reference to the in-pane "terminal engine unavailable" banner
    // overlay, if one has been rendered. Tracked so dispose() can remove it and
    // so repeated attach attempts never stack duplicate overlays.
    this._ptyUnavailableBannerEl = null;
  }

  _log(msg) {
    console.log('[Terminal]', msg);
  }

  /**
   * Resolve the fixed DOM container only while it still renders this exact
   * TerminalPane. Cached groups keep their WebSocket alive while the same
   * container id hosts another session, so id lookup alone is never proof of
   * ownership.
   */
  _getOwnedContainer() {
    if (typeof document === 'undefined' ||
        !this.term || !this.term.element) return null;
    const container = document.getElementById(this.containerId);
    if (!container ||
        this.term.element.parentElement !== container ||
        this.term.element.__cwmTerminalPane !== this) {
      return null;
    }
    return container;
  }

  /** Write a colored status message through the batching pipeline to avoid freezing */
  _status(msg, color) {
    if (!this.term) return;
    const c = color === 'red' ? '31' : color === 'green' ? '32' : color === 'yellow' ? '33' : '34';
    const statusMsg = '\x1b[1;' + c + 'm' + msg + '\x1b[0m\r\n';
    // Route through rAF batching instead of direct term.write()
    if (typeof this._enqueueWrite === 'function') {
      this._enqueueWrite(statusMsg);
    } else {
      this.term.write(statusMsg);
    }
  }

  /**
   * Render a persistent in-pane banner explaining that the server's native
   * terminal engine (node-pty) is unavailable (issue #68). Called from the
   * WebSocket close handler when the server closes with reason
   * 'PTY_UNAVAILABLE'. Idempotent: any existing banner in this pane is removed
   * first so repeated attach attempts (the user re-clicking the session)
   * cannot stack duplicate overlays. The banner is positioned below the pane
   * header so the header controls (including Close) stay clickable.
   */
  _showPtyUnavailableBanner() {
    if (typeof document === 'undefined') return;
    // Resolve the owning pane element. Prefer the cached reference from mount()
    // and fall back to walking up from the container id.
    let paneEl = this.paneEl;
    if (!paneEl) {
      const container = document.getElementById(this.containerId);
      paneEl = container ? container.closest('.terminal-pane') : null;
    }
    if (!paneEl) return;

    // Defensive de-dup: remove any prior banner in this pane (this instance's
    // or a leftover from a reused slot) before creating a fresh one.
    const prior = paneEl.querySelector('.terminal-pty-unavailable');
    if (prior) { try { prior.remove(); } catch (_) {} }

    const banner = document.createElement('div');
    banner.className = 'terminal-pty-unavailable';
    banner.setAttribute('role', 'alert');
    // Offset below the header so header buttons remain reachable. offsetHeight
    // is read live so the banner tracks whatever the current header height is.
    const header = paneEl.querySelector('.terminal-pane-header');
    const headerH = header ? header.offsetHeight : 0;
    if (headerH > 0) banner.style.top = headerH + 'px';

    const inner = document.createElement('div');
    inner.className = 'terminal-pty-unavailable-inner';

    const title = document.createElement('div');
    title.className = 'terminal-pty-unavailable-title';
    title.textContent = 'Terminal engine unavailable on the server';

    const body = document.createElement('div');
    body.className = 'terminal-pty-unavailable-body';
    // Build the body with a monospace <code> chip for the module name without
    // using innerHTML (keeps this XSS-proof and matches the additive idiom).
    body.appendChild(document.createTextNode(
      'The server could not load its native terminal module ('
    ));
    const codeChip = document.createElement('code');
    codeChip.className = 'terminal-pty-unavailable-code';
    codeChip.textContent = 'node-pty';
    body.appendChild(codeChip);
    body.appendChild(document.createTextNode(
      '). All other features keep working. See the server console or the ' +
      'README Troubleshooting section for the fix for your platform.'
    ));

    inner.appendChild(title);
    inner.appendChild(body);
    banner.appendChild(inner);
    paneEl.appendChild(banner);
    this._ptyUnavailableBannerEl = banner;
  }

  /**
   * Remove the PTY-unavailable banner if present. Called from dispose() so a
   * torn-down pane never leaves an orphaned overlay behind in a reused slot.
   */
  _removePtyUnavailableBanner() {
    if (this._ptyUnavailableBannerEl) {
      try { this._ptyUnavailableBannerEl.remove(); } catch (_) {}
      this._ptyUnavailableBannerEl = null;
    }
  }

  mount() {
    if (this._disposed) return;
    const mountGeneration = ++this._mountGeneration;
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.error('[Terminal] Container not found:', this.containerId);
      return;
    }
    container.innerHTML = '';

    if (typeof Terminal === 'undefined') {
      console.error('[Terminal] xterm.js not loaded');
      container.innerHTML = '<div style="padding:16px;color:var(--red);font-size:13px;">Error: xterm.js not loaded</div>';
      return;
    }
    if (typeof FitAddon === 'undefined') {
      console.error('[Terminal] FitAddon not loaded');
      container.innerHTML = '<div style="padding:16px;color:var(--red);font-size:13px;">Error: FitAddon not loaded</div>';
      return;
    }

    try {
      this.term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 13,
        // P5.5: the face arrives through the terminalSurface projection, which
        // reads --font-terminal. The size deliberately does NOT: 13px is the
        // metric the PTY column count has always been computed from, and
        // TERMINAL-ARCHITECTURE.md 10.3 rules that the terminal's own metrics
        // win inside the terminal region ("a 1.7 line height inside a terminal
        // wastes roughly 40 percent of the vertical rows, which changes the
        // PTY row count and therefore changes what the CLI renders").
        fontFamily: TerminalPane.getTerminalFontFamily(),
        lineHeight: 1.2,
        // P5.3, TERMINAL-ARCHITECTURE defect D7. The client ring was 5000 lines
        // against a 100 KB server ring, so a chatty shell trimmed its own
        // history away from BOTH ends within an hour and the content was then
        // gone for good. 10000 lines at this cell size measures roughly 8 MB
        // per pane in xterm 6's buffer, which is the figure VG-5 exists to
        // confirm against a heap snapshot rather than an estimate.
        scrollback: 10000,
        // Issue #41: animate wheel and Shift+PageUp/Down scrolling instead of
        // jumping in discrete row blocks. Resolves to 0 (instant) when the
        // setting is off or the OS requests reduced motion.
        smoothScrollDuration: TerminalPane.getSmoothScrollDuration(),
        rightClickSelectsWord: false,
        theme: TerminalPane.getCurrentTheme(),
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.term.loadAddon(this.fitAddon);

      if (typeof WebLinksAddon !== 'undefined') {
        this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
      }

      this.term.open(container);
      // Stamp the live xterm root with its owning TerminalPane. Fixed grid
      // slots can be reused while cached panes and deferred mounts overlap;
      // event routing must follow the terminal that actually rendered the
      // target, not merely whichever object is currently in a slot array.
      if (this.term.element) this.term.element.__cwmTerminalPane = this;
      this._log('xterm opened in ' + this.containerId + ' for session ' + this.sessionId);

      // Plan 19-02 (PTY-04, PTY-05): read this pane's provider tag once at
      // mount time. data-provider is set by app.js openTerminalInPane (and by
      // Phase 18-01 on sidebar render sites; the pane attribute is the one
      // that matters for live behavior). Cached here because the tag does not
      // change for the lifetime of a pane: opening a different session into
      // the same slot tears down this TerminalPane and constructs a new one.
      this.paneEl = container.closest('.terminal-pane');
      this._providerId =
        (this.paneEl && this.paneEl.dataset && this.paneEl.dataset.provider) ||
        'claude'; // gsd:provider-literal-allowed (Phase 19 default when data-provider missing)

      this._status('Connecting to session...', 'blue');

      // Initialize mobile scroll/type mode after terminal is in DOM
      this.initMobileInputMode();

      // Copy-mode: install the capture-phase mouse interceptor (a no-op until
      // the toggle is ON) and inject the Select-mode control + one-time hint
      // into the pane header. Kept out of the mobile engine's way: the touch
      // scroll/select engine only runs on real touch devices (_isMobile), and
      // this interceptor only acts on left-button MOUSE drags while the toggle
      // is on, so the two never fight over the same gesture.
      this._installSelectModeInterceptor();
      // Select mode v2: the wheel guard is installed alongside the mouse
      // interceptor and is equally inert while the toggle is off. It exists
      // because xterm 6 forwards the wheel to the PTY whenever the app has
      // mouse tracking on and offers no Shift bypass for local scrolling, so
      // a single wheel notch during a selection would scroll the app and
      // repaint every cell under the highlight.
      this._installSelectModeWheelGuard();
      this._injectCopyControls();
      // Width claim: start watching for this pane becoming the one the user is
      // actually looking at. Both triggers are inert until the WebSocket is
      // open and the initial replay window has passed.
      this._installVisibilityActivate();

      // IMPORTANT: Fit BEFORE connecting WebSocket so we know the real
      // terminal dimensions. The PTY spawns at whatever cols/rows we pass
      // in the WS URL - if we connect before fit, the PTY starts at
      // hardcoded 120x30, outputs formatted for 120 cols, then gets
      // resized to the actual (smaller) dimensions. That mismatch garbles
      // the display and forces users to type "reset".
      //
      // Double-rAF ensures the grid layout is fully calculated before fit.
      this._mountRafOuter = requestAnimationFrame(() => {
        this._mountRafOuter = null;
        if (this._disposed || this._mountGeneration !== mountGeneration) return;
        this._mountRafInner = requestAnimationFrame(() => {
          this._mountRafInner = null;
          if (this._disposed || this._mountGeneration !== mountGeneration) return;
          try {
            this.fitAddon.fit();
            this._log('Fitted: ' + this.term.cols + 'x' + this.term.rows);
          } catch (e) {
            this._log('fit() failed: ' + e.message);
          }

          // NOW connect with correct dimensions
          this._log('Calling connect()...');
          this.connect();

          // P5.5 metric stability. The terminal face is now a self-hosted
          // webfont declared with `font-display: swap`, so on a cold load the
          // browser can measure the FALLBACK face, hand xterm a cell width,
          // and then swap the real face in underneath it. The symptom is
          // column drift: a pane that fitted 96 columns reflows to 92 a
          // fraction of a second later, and the CLI on the other end has
          // already drawn for 96.
          //
          // document.fonts.ready settles once every pending face has loaded or
          // failed, so one refit at that moment closes the window. It is
          // additive to the 200ms safety refit below rather than a replacement,
          // because the two answer different questions: this one is "the face
          // arrived", that one is "the layout settled". Guarded on every axis,
          // since the Font Loading API is absent in the vm sandboxes this file
          // is unit-tested in.
          try {
            if (typeof document !== 'undefined' && document.fonts &&
                document.fonts.ready && typeof document.fonts.ready.then === 'function') {
              document.fonts.ready.then(() => {
                if (this._disposed || this._mountGeneration !== mountGeneration || !this.fitAddon) return;
                try {
                  this.fitAddon.fit();
                  this._sendResizeIfChanged(false);
                } catch (_) { /* a pane torn down mid-load */ }
              }).catch(() => { /* font loading never blocks a terminal */ });
            }
          } catch (_) { /* no Font Loading API */ }

          // Safety refit after 200ms - catches edge cases where the grid
          // is still settling (e.g., CSS transitions, slow layout).
          // Deduplicated: only notifies the server when dims really changed,
          // so the common already-settled case sends nothing.
          this._mountRefitTimer = setTimeout(() => {
            this._mountRefitTimer = null;
            if (!this._disposed &&
                this._mountGeneration === mountGeneration &&
                this.fitAddon) {
              try {
                this.fitAddon.fit();
                this._sendResizeIfChanged(false);
              } catch (_) {}
            }
          }, 200);
        });
      });

      // Custom key handler for Ctrl+C (copy), Ctrl+V (paste), Shift+Enter
      this.term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const mod = e.ctrlKey || e.metaKey;
        // KeyboardEvent.key follows Caps Lock and Shift ("C"/"V"). Normalize
        // once so the safety-critical copy/paste branches cannot fall through
        // to xterm's control-character path merely because letter case changed.
        const shortcutKey = typeof e.key === 'string' ? e.key.toLowerCase() : '';

        // ── Ctrl+Shift+C, copy ALWAYS (TERMINAL-ARCHITECTURE D5 and 8.4) ──
        //
        // The Linux terminal convention, and the answer to the one thing plain
        // Ctrl+C cannot do: copy when the user is not sure whether a selection
        // exists. Plain Ctrl+C is deliberately ambiguous (selection copies,
        // no selection interrupts), which means a user who wants to copy has to
        // know the state of something they cannot see. This shortcut has one
        // meaning and never sends ETX.
        //
        // It is written `mod && e.shiftKey && shortcutKey` rather than
        // `mod && shortcutKey && e.shiftKey`, and it sits ABOVE the plain
        // branch, for two reasons that are both load bearing:
        //
        //   BEHAVIOUR. `mod && shortcutKey === 'c'` is also true with Shift
        //   held, so the plain branch below would otherwise swallow this
        //   shortcut and hand it to a native copy that Chromium has already
        //   bound to Inspect Element.
        //
        //   PRESERVATION. Three suites slice the plain branch out of this file
        //   BY ITS SOURCE TEXT (copy-secure-context-fallback, terminal-select-v2
        //   and terminal-select-mode) and assert that the slice contains no
        //   preventDefault and no copyTextToClipboard. A branch that began with
        //   the same characters, or that sat between the plain branch and the
        //   `// Ctrl+V / Cmd+V` comment below, would be extracted as part of it
        //   and would turn all three red while behaving correctly.
        //
        // preventDefault here is aimed at the browser, not at xterm: xterm 6
        // already produces nothing for a Ctrl+SHIFT+letter (its control-code
        // branch requires `!e.shiftKey`), so there was never a SIGINT to
        // suppress; what there is, is a DevTools shortcut to keep out of the
        // way when DevTools is closed.
        if (mod && e.shiftKey && shortcutKey === 'c') {
          e.preventDefault();
          const selection = this.getCopySelection();
          if (selection.hasSelection && selection.text) {
            TerminalPane.copyTextToClipboard(selection.text);
          }
          return false;
        }

        // ── Ctrl+Shift+A, select all (D5 and 8.4) ──
        //
        // Terminal.selectAll() has existed in xterm 6 the whole time
        // (xterm.d.ts line 1191) and nothing was wired to it, so "copy the
        // whole terminal window" had no single action.
        //
        // WHY NOT Ctrl+A. Ctrl+A is beginning-of-line in readline and in every
        // shell, editor and agent CLI this application spawns, and it is the
        // tmux and screen prefix. Intercepting it would break the terminal to
        // add a convenience, which is the opposite of what a terminal is for.
        // 8.4 rules on this explicitly and picks the Shift form; Cmd+A already
        // reaches xterm's own SELECT_ALL on macOS and is left alone.
        //
        // Stage 3 upgrades this to select the whole history document; today it
        // selects the whole terminal buffer, which is everything that exists.
        if (mod && e.shiftKey && shortcutKey === 'a') {
          e.preventDefault();
          try {
            if (this.term && typeof this.term.selectAll === 'function') this.term.selectAll();
          } catch (_) { /* a disposed terminal has nothing to select */ }
          return false;
        }

        // Ctrl+C / Cmd+C with an xterm selection belongs to the browser's
        // trusted native copy path. Returning false keeps xterm from turning
        // the shortcut into ETX/SIGINT, while deliberately NOT calling
        // preventDefault lets Chromium dispatch its trusted `copy` event.
        // xterm owns that event on the terminal element and synchronously
        // writes its selection through ClipboardEvent.clipboardData.
        //
        // This is more reliable than an async navigator.clipboard.writeText
        // call: embedded browsers can expose the API while denying the
        // permission, and preventDefault previously disabled the native path
        // that would still have worked. With no selection this branch is
        // skipped, preserving ordinary terminal Ctrl+C/SIGINT.
        if (mod && shortcutKey === 'c') {
          const copySelection = this.getCopySelection();
          if (copySelection.hasSelection) return false;
        }

        // Ctrl+V / Cmd+V always stays on the browser's trusted native paste
        // path. Do not call preventDefault() here. Returning false only tells
        // xterm not to process the key itself; Chromium still emits the trusted
        // beforeinput/paste events that the capture listeners below bracket and
        // forward exactly once.
        //
        // WHY this is origin- and permission-independent (user report,
        // 2026-07-25): navigator.clipboard.readText can exist on localhost or
        // HTTPS while still rejecting in embedded browsers. The old "secure"
        // arm canceled native paste first, then awaited that permission-gated
        // API. Its error message told the user to press Ctrl+V, but every retry
        // entered the same canceled arm, creating a permanent dead end.
        //
        // Programmatic clipboard reads remain available to the explicit Paste
        // menu action in pasteFromClipboard(). Keyboard paste must use the
        // browser's user-gesture path on every origin. The capture-phase paste
        // listener calls stopImmediatePropagation(), so xterm's same-target
        // listener cannot double-send (the original PR #45 concern).
        if (mod && shortcutKey === 'v') {
          // Select mode v2: a paste is input, and input resumes live output.
          // Exiting here as well as in the capture listeners below is
          // deliberate belt and braces: an engine that fires the shortcut but
          // never dispatches a usable paste event would otherwise leave the
          // pane frozen with no visible cause.
          this._exitSelectModeForInput();
          return false;
        }

        // Shift+Enter: dispatch through this pane's provider spec.
        // Plan 19-02 (PTY-05) refactor. Previously hardcoded to '\x1b\r'
        // which is Claude/Ink-correct but wrong for non-Ink TUIs.
        // _getShiftEnterSequence reads window.CWMProviderSpecs and returns
        // the provider-specific sequence (Claude -> '\x1b\r', Codex -> '\r').
        // Defaults to '\x1b\r' if the spec map is missing so the long-
        // standing Claude behavior is the safe fallback.
        // preventDefault is required: returning false only stops xterm from
        // handling the key but does NOT prevent the browser from inserting a
        // newline into the hidden textarea, which then fires onData with \r
        // and submits, same pattern as the Ctrl+V handler above.
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          // Select mode v2: this branch bypasses onData and writes straight to
          // the socket, so it needs its own unfreeze or the newline the user
          // just inserted would never render.
          this._exitSelectModeForInput();
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const data = this._getShiftEnterSequence();
            this.ws.send(JSON.stringify({ type: 'input', data }));
          }
          return false;
        }

        return true;
      });

      // ── Mobile autocorrect guard ─────────────────────────────
      // xterm.js does not handle beforeinput with insertReplacementText
      // (tap-to-correct on Gboard, iOS keyboard, etc.).  We intercept it
      // ourselves: block the native replacement, compute the required
      // backspaces from getTargetRanges(), and send backspaces +
      // replacement text to the PTY directly.
      this._replacingText = false;
      const xtermTextarea = container.querySelector('.xterm-helper-textarea');
      if (xtermTextarea) {
        xtermTextarea.addEventListener('beforeinput', (e) => {
          // Intercept paste-via-beforeinput to prevent xterm.js onData double-send.
          // Extract the pasted text and send it through our WebSocket instead.
          // Arm _pasteHandled only after this handler actually sends text, so
          // an empty/orphan beforeinput event can never suppress a later paste.
          if (e.inputType === 'insertFromPaste') {
            e.preventDefault();
            // Select mode v2: pasted text is input, so live output resumes.
            this._exitSelectModeForInput();
            const text = e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
            if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
              this._pasteHandled = true;
              // Some browsers/mobile keyboards emit beforeinput without a later
              // paste event. Keep the latch only for the rest of this browser
              // gesture; a missing companion event must not eat the next paste.
              clearTimeout(this._pasteHandledResetTimer);
              this._pasteHandledResetTimer = setTimeout(() => {
                this._pasteHandled = false;
                this._pasteHandledResetTimer = null;
              }, 0);
              this._sendPastePayload(text);
            }
            return;
          }

          if (e.inputType === 'insertReplacementText') {
            e.preventDefault();
            // Select mode v2: an autocorrect replacement is input too.
            this._exitSelectModeForInput();
            const replacement = e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
            if (!replacement || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            // getTargetRanges() tells us what text the keyboard is replacing
            const ranges = e.getTargetRanges();
            let deleteCount = 0;
            if (ranges.length > 0) {
              const range = ranges[0];
              deleteCount = range.endOffset - range.startOffset;
            }

            // Send backspaces to erase the old word, then the replacement
            const backspaces = '\x7f'.repeat(deleteCount) || '\b'.repeat(deleteCount);
            this.ws.send(JSON.stringify({ type: 'input', data: backspaces + replacement }));
          }
        }, { capture: true });

        // Intercept native paste events (right-click > Paste, Edit menu, touch-paste)
        // and route them through our WebSocket instead of letting xterm.js double-send.
        // Ctrl+V/Cmd+V is handled by the custom key handler. beforeinput may have
        // already handled this paste (sets _pasteHandled), so check the flag first.
        xtermTextarea.addEventListener('paste', (e) => {
          e.preventDefault();
          // xterm also listens for paste on this exact textarea. A capture
          // listener runs first, but stopPropagation() would still allow
          // xterm's same-target listener to send the text a second time.
          e.stopImmediatePropagation();
          // Select mode v2: right-click Paste and touch-paste land here.
          this._exitSelectModeForInput();
          if (this._pasteHandled) {
            clearTimeout(this._pasteHandledResetTimer);
            this._pasteHandledResetTimer = null;
            this._pasteHandled = false;
            return;
          }
          const text = (e.clipboardData || window.clipboardData || '').getData('text');
          if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this._sendPastePayload(text);
          }
        }, { capture: true });
      }

      this.term.onData((data) => {
        // Select mode v2: this is the single funnel every keystroke xterm
        // decides to forward passes through, so it is where "typing resumes
        // live output" is enforced. The unfreeze happens BEFORE the bytes go
        // out, so the queued frames land first and the echo of what was just
        // typed renders on top of them instead of behind them.
        //
        // A Ctrl+C that copies a selection never reaches here: the custom key
        // handler returns false for it, so xterm produces no data and the
        // freeze (and the selection) survive the copy.
        //
        // FOCUS-REPORT GUARD (ship blocker, 2026-08-05): onData is not a
        // keystroke-only channel. With DEC 1004 focus reporting on (ConPTY
        // turns it on for effectively every pane) xterm sends \x1b[I / \x1b[O
        // here whenever its hidden textarea gains or loses focus, and a device
        // status or device attributes reply arrives the same way. Treating
        // those as typing cancelled Select mode on the very mousedown that
        // started a selection. A payload made up only of such reports is
        // therefore forwarded WITHOUT leaving the mode; anything else, mixed
        // chunks included, still unfreezes. The send below is deliberately
        // outside the branch: what goes to the PTY is unchanged in every case.
        if (!TerminalPane._isTerminalReportOnly(data)) {
          this._exitSelectModeForInput();
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Select mode v3: the selection going away is what ends the pause.
      // Registered here, next to onData, because both are terminal-level
      // subscriptions rather than host-owned chrome: they belong to this
      // xterm instance for its whole life and are disposed with it. The
      // handler itself decides whether the event really means "gesture over"
      // (see _onSelectionChanged), because xterm also fires this on every
      // intermediate update during a drag.
      if (typeof this.term.onSelectionChange === 'function') {
        this._selSelectionDisposable =
          this.term.onSelectionChange(() => this._onSelectionChanged());
      }

      this._resizeObserver = new ResizeObserver((entries) => {
        // Guard: skip fit when container is hidden (e.g., tab switch sets display:none).
        // A 0×0 contentRect causes fitAddon to calculate 1×1 cols/rows, which sends a
        // resize to the PTY server and permanently garbles the terminal's buffered output.
        const entry = entries[0];
        if (entry && (entry.contentRect.width === 0 || entry.contentRect.height === 0)) return;

        // Debounce resize to prevent layout thrashing during mobile tab switches
        clearTimeout(this._fitTimer);
        this._fitTimer = setTimeout(() => {
          this.safeFit();
        }, 100);
      });
      this._resizeObserver.observe(container);

    } catch (err) {
      console.error('[Terminal] Init failed:', err);
      container.innerHTML = '<div style="padding:16px;color:var(--red);font-size:13px;">Terminal init failed: ' + err.message + '</div>';
    }
  }

  connect() {
    this._log('connect() entered, ws=' + (this.ws ? 'exists(state=' + this.ws.readyState + ')' : 'null'));

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._log('Already connected, skipping');
      return;
    }

    const isReconnect = this._gotFirstData; // true if we've received data before

    // Select mode v2: open the replay window now, before the socket exists.
    // The server sends a reset marker plus the full scrollback the moment it
    // attaches, and a pane that restored Select mode from a previous visit
    // must paint that replay instead of holding it.
    this._freezeBlockedUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;
    // Width claim: open its own quiet window for the same reason. Claiming
    // geometry mid-replay would resize the PTY underneath the replay and tear
    // it. This window is shorter than the freeze one because a claim only has
    // to wait for the replay to be UNDERWAY, not for it to be classified.
    this._activateBlockedUntil = Date.now() + ACTIVATE_CONNECT_GUARD_MS;

    // Close any stale WebSocket before creating a new one
    if (this.ws) {
      try { this.ws.onmessage = null; this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch (_) {}
      this.ws = null;
    }

    // On reconnect, cancel any pending write operations THEN reset the terminal.
    // Without draining the write pipeline first, a stale rAF/timer could flush
    // old data into the terminal AFTER reset(), causing duplicate content.
    if (isReconnect && this.term) {
      // Select mode v2: a reconnect is followed by a full scrollback replay.
      // Replaying into a frozen pane would pile the entire transcript into the
      // hold queue behind a selection that term.reset() is about to
      // invalidate anyway, so drop the freeze (and the stale hold) first.
      this._discardSelectModeHold();
      if (this._writeRaf) { cancelAnimationFrame(this._writeRaf); this._writeRaf = null; }
      if (this._bgFlushTimer) { clearTimeout(this._bgFlushTimer); this._bgFlushTimer = null; }
      this._writeBuf = '';
      this._activitySample = '';
      this.term.reset();
    }

    const token = localStorage.getItem('cwm_token');
    this._log('Token from localStorage: ' + (token ? token.substring(0, 12) + '...' : 'NULL'));

    if (!token) {
      this._status('No auth token. Please log in again.', 'red');
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = protocol + '//' + location.host + '/ws/terminal?token=' + encodeURIComponent(token) + '&sessionId=' + this.sessionId;
    // Pass actual terminal dimensions so the PTY spawns at the right size
    if (this.term) {
      wsUrl += '&cols=' + this.term.cols + '&rows=' + this.term.rows;
    }
    // Append optional spawn options as query params
    if (this.spawnOpts.cwd) wsUrl += '&cwd=' + encodeURIComponent(this.spawnOpts.cwd);
    if (this.spawnOpts.resumeSessionId) wsUrl += '&resumeSessionId=' + encodeURIComponent(this.spawnOpts.resumeSessionId);
    if (this.spawnOpts.command) wsUrl += '&command=' + encodeURIComponent(this.spawnOpts.command);
    if (this.spawnOpts.bypassPermissions) wsUrl += '&bypassPermissions=true';
    if (this.spawnOpts.verbose) wsUrl += '&verbose=true';
    if (this.spawnOpts.model) wsUrl += '&model=' + encodeURIComponent(this.spawnOpts.model);
    if (this.spawnOpts.shell) wsUrl += '&shell=' + encodeURIComponent(this.spawnOpts.shell);
    if (this.spawnOpts.newSession) wsUrl += '&newSession=true';
    // Plan 19-01 PTY-02: forward the spawn-time provider hint so the
    // backend's registry-driven sentinel can route to the correct provider
    // even when the session has no store record yet. Backend validates via
    // isSafeProviderId (a-zA-Z0-9_-, 32 char cap) in pty-server.js. When
    // omitted, the backend falls back to the store-tagged provider or the
    // v1.1 default.
    if (this.spawnOpts.provider) wsUrl += '&provider=' + encodeURIComponent(this.spawnOpts.provider);
    this._log('Opening WebSocket: ' + wsUrl.substring(0, 80) + '...');

    // Add loading animation to the pane
    const container = this._getOwnedContainer();
    const paneEl = container ? container.closest('.terminal-pane') : null;
    if (paneEl) paneEl.classList.add('terminal-pane-loading');

    try {
      this.ws = new WebSocket(wsUrl);
      // Select mode v2: make this socket self-unfreezing for input frames.
      this._installInputUnfreezeHook(this.ws);
    } catch (err) {
      this._log('WebSocket constructor threw: ' + err.message);
      this._status('WebSocket failed: ' + err.message, 'red');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');
      return;
    }

    this.ws.onopen = () => {
      // Remove loading animation
      const paneEl = this._getOwnedContainer()?.closest('.terminal-pane');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');

      this.connected = true;
      this._reconnectAttempts = 0;
      // Mute idle notifications during the scrollback replay burst the
      // server sends right after (re)connect. Without this window, every
      // pane sitting at a prompt fires "ready for input" ~2s after a tab
      // switch or page load replays its buffer (notification-storm bug).
      this._suppressIdleUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;
      // Select mode v2: re-arm the replay window from the moment the socket
      // really opened. The connect-time arm can have expired while a slow
      // handshake was in flight, and the replay only starts now.
      this._freezeBlockedUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;
      // Width claim: re-arm its quiet window from the moment the socket really
      // opened (the connect-time arm can have expired while the handshake was
      // in flight on a slow link).
      this._activateBlockedUntil = Date.now() + ACTIVATE_CONNECT_GUARD_MS;
      this._log('WebSocket OPEN');
      this._status('Connected. Starting session...', 'green');
      // Forced send: this server-side connection is brand new and has no
      // stored viewport for this client yet, so the initial resize must go
      // out even when dims match the previous connection's last send.
      this._sendResizeIfChanged(true);
    };

    // ── Write batching: accumulate WebSocket data and flush to xterm
    //    once per animation frame. Prevents main-thread thrashing when
    //    multiple terminals output rapidly (fixes input freeze). ──
    this._writeBuf = '';
    this._writeRaf = null;
    this._activitySample = '';       // Sampled data for activity detection
    this._activityDebounceTimer = null;

    this.ws.onmessage = (event) => {
      const data = event.data;

      if (!this._gotFirstData) {
        this._gotFirstData = true;
        this._log('First data received (' + data.length + ' bytes)');
      }

      if (typeof data === 'string' && data.charAt(0) === '{') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'exit') {
            // Flush any pending writes before showing exit status
            this._flushWriteBuffer();
            this._status('[Process exited with code ' + msg.exitCode + ']', 'red');
            this.connected = false;
            return;
          } else if (msg.type === 'resumeId') {
            // Server detected the Claude session UUID after spawn.
            // Update spawnOpts so layout saves include the correct resumeSessionId
            // for accurate session restoration on restart.
            this.spawnOpts.resumeSessionId = msg.resumeSessionId;
            this._log('Backfilled resumeSessionId: ' + msg.resumeSessionId);
            return;
          } else if (msg.type === 'reset') {
            // Server-initiated full resync: a complete scrollback replay
            // follows (attach/reconnect or lagged-client recovery). Drop any
            // buffered partial writes and clear the screen so the replay
            // cannot interleave with or duplicate stale frames. Must be safe
            // mid-stream: everything here is idempotent.
            //
            // Select mode v2: unfreeze BEFORE the reset. term.reset() switches
            // back to the normal buffer and clears the screen, which discards
            // any selection the user had, so holding output past this point
            // would protect nothing and would stall the replay behind a frozen
            // queue. The hold is dropped rather than flushed because the
            // replay that follows re-sends everything.
            this._discardSelectModeHold();
            // Width claim: the replay that follows must not be interrupted by
            // a geometry change, so open the same quiet window connect uses.
            this._activateBlockedUntil = Date.now() + ACTIVATE_CONNECT_GUARD_MS;
            if (this._writeRaf) { cancelAnimationFrame(this._writeRaf); this._writeRaf = null; }
            if (this._bgFlushTimer) { clearTimeout(this._bgFlushTimer); this._bgFlushTimer = null; }
            this._writeBuf = '';
            this._activitySample = '';
            if (this.term) this.term.reset();
            return;
          } else if (msg.type === 'mode') {
            // P6.3's mode signal, consumed by P5.1's paste path.
            //
            // The server's headless VT sees every byte of the session,
            // including the bytes that arrived before this client attached, so
            // it knows whether the application has DEC 2004 on even when the
            // local xterm was reset a moment ago by a resync. It is behind
            // CWM_VT_SIDECAR and defaults OFF, so this branch is an UPGRADE:
            // isBracketedPasteMode falls back to xterm's own reader and then to
            // false, and nothing in P5 requires a frame ever to arrive.
            //
            // Out-of-order and duplicate frames are dropped on `seq`, which the
            // sidecar stamps for exactly this purpose. A frame with no seq (an
            // older or hand-rolled server) is accepted, because refusing an
            // unversioned signal would be worse than acting on a stale one:
            // the worst case is a bracket decision one mode-change out of date.
            if (typeof msg.seq !== 'number' || msg.seq >= this._modeSeq) {
              if (typeof msg.seq === 'number') this._modeSeq = msg.seq;
              if (typeof msg.bracketedPaste === 'boolean') {
                this._remoteBracketedPaste = msg.bracketedPaste;
              }
            }
            return;
          } else if (msg.type === 'error') {
            this._flushWriteBuffer();
            this._status('[Error: ' + msg.message + ']', 'red');
            return;
          } else if (msg.type === 'output') {
            this._enqueueWrite(msg.data);
            return;
          }
        } catch (_) {}
      }
      this._enqueueWrite(data);
    };

    this.ws.onclose = (event) => {
      // Remove loading animation
      const paneEl = this._getOwnedContainer()?.closest('.terminal-pane');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');

      this.connected = false;
      this._log('WebSocket CLOSED code=' + event.code + ' reason=' + (event.reason || 'none'));

      // Native terminal engine unavailable on the server (issue #68). The
      // server closes with this exact code+reason when node-pty failed to
      // load. It will not fix itself, so do NOT reconnect; and unlike a
      // transient spawn failure we do NOT auto-close the pane, because the
      // in-pane banner needs to persist so the user can read the remediation.
      if (event.code === 1011 && event.reason === 'PTY_UNAVAILABLE') {
        this._showPtyUnavailableBanner();
        return; // No reconnect, no auto-close
      }

      // Code 1011 = server error (PTY spawn failed). Don't retry - it won't fix itself.
      if (event.code === 1011) {
        const reason = event.reason || 'PTY session failed to spawn';
        this._status('[Server error: ' + reason + ']', 'red');
        // Auto-close this pane after a brief delay so user sees the error
        if (this.onFatalError) setTimeout(() => this.onFatalError(this.sessionId), 2000);
        return; // No reconnect
      }

      if (this._reconnectAttempts < this._maxReconnectAttempts) {
        this._reconnectAttempts++;
        const delay = Math.min(2000 * this._reconnectAttempts, 10000);
        this._log('Reconnecting in ' + delay + 'ms (attempt ' + this._reconnectAttempts + ')');
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      } else {
        this._status('[Connection lost after ' + this._maxReconnectAttempts + ' attempts]', 'red');
        // Auto-close this pane after a brief delay so user sees the error
        if (this.onFatalError) setTimeout(() => this.onFatalError(this.sessionId), 2000);
      }
    };

    this.ws.onerror = (err) => {
      this._log('WebSocket ERROR: ' + (err.message || 'unknown'));
    };
  }

  focus() {
    if (!this.term) return;
    // On mobile in scroll mode, don't focus textarea (prevents keyboard popup)
    if (this._isMobile() && !this._mobileTypeMode) return;
    const container = this._getOwnedContainer();
    if (!container || container.hidden) return;
    this.term.focus();
    // Also explicitly focus the hidden textarea - xterm.js's focus()
    // sometimes doesn't propagate in multi-instance setups
    const textarea = container.querySelector('.xterm-helper-textarea');
    if (textarea) textarea.focus({ preventScroll: true });
  }

  blur() {
    if (this.term) this.term.blur();
  }

  /**
   * Paste text from clipboard into the terminal via WebSocket.
   * Works on both desktop and mobile regardless of pointer-events state.
   *
   * The pasted text is wrapped in bracketed-paste escape sequences
   * (\x1b[200~ ... \x1b[201~) so the shell treats it as literal content and
   * does not misinterpret embedded control characters as commands. (This
   * explanation formerly lived as an inline comment beside the wrapping line;
   * it moved up here so the availability guard could be added without changing
   * the pasteFromClipboard..this.ws.send proximity the isolation gate checks.)
   *
   * P5.1 AMENDS THAT PARAGRAPH IN ONE RESPECT, and the amendment is the whole
   * point of the work package: the wrapping is now CONDITIONAL on the receiving
   * application having enabled DEC 2004, which prepareInputForPty reads from the
   * live terminal rather than assuming. Against an application that never asked
   * for bracketed paste (a bare cmd.exe, powershell.exe, or any simple REPL) the
   * markers were delivered as literal garbage, which is defect D1 in
   * TERMINAL-ARCHITECTURE.md section 4. Newline normalisation (D2) and the
   * multi-line confirm (9.4) arrive on the same call.
   *
   * Availability: the async Clipboard API (navigator.clipboard.readText) only
   * exists in secure contexts (https or localhost). On http over LAN, the
   * documented remote-access mode, navigator.clipboard is undefined. Rather
   * than let the read throw into the catch and log to console only, which is
   * what left paste silently dead for every non-localhost user (issue #64), we
   * guard up front, surface a user-visible message through _emitPasteUnavailable,
   * and return false so the caller can fall back to the native Ctrl+V (Cmd+V)
   * path. The catch branch (a NotAllowedError from Safari or a mobile browser
   * refusing programmatic reads) is surfaced the same way instead of being
   * swallowed.
   *
   * Select mode v2: the first statement of the body leaves Select mode, because
   * an explicit Paste is input to the session and input resumes live output.
   * It runs before the availability check so a pane cannot stay frozen after a
   * paste the browser refused. The reasoning lives here rather than beside the
   * call for the same reason the bracketed-paste explanation above moved up:
   * test/bracketed-paste-isolation.test.js gates the character distance between
   * `pasteFromClipboard` and `this.ws.send(`, so the body has to stay compact.
   *
   * @returns {Promise<boolean>} true when text was read and sent; false when
   *   the clipboard API is unavailable or the read was denied/failed.
   */
  async pasteFromClipboard() {
    this._exitSelectModeForInput(); // Select mode v2: see note above.
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      this._emitPasteUnavailable('insecure-context');
      return false;
    }
    try {
      const text = await navigator.clipboard.readText();
      const paste = text ? prepareInputForPty(text, this.pasteOptions()) : null;
      if (paste && paste.needsConfirm) this._confirmMultilinePaste(paste);
      else if (paste && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: paste.data }));
      }
      // Refocus the terminal after the async clipboard read completes.
      // The await can cause the browser to shift focus away from xterm's
      // internal textarea, requiring a manual click to resume typing.
      if (this.term) this.term.focus();
      return true;
    } catch (err) {
      // A rejection here is almost always a permission denial (Safari and some
      // mobile browsers refuse programmatic clipboard reads even on https).
      // Previously this only hit _log (console), so paste appeared to do
      // nothing. Surface it to the user and refocus so Ctrl+V still works.
      this._log('Clipboard paste failed: ' + err.message);
      this._emitPasteUnavailable('denied');
      if (this.term) this.term.focus();
      return false;
    }
  }

  /**
   * Read the LIVE bracketed-paste state for the application on the other end
   * of this pane's PTY.
   *
   * Three sources, in falling order of authority, because P5 must work whether
   * or not P6's server-side VT sidecar is switched on:
   *
   *   1. The `mode` control frame (TERMINAL-ARCHITECTURE stage 2, P6.3). The
   *      server's headless VT is the same parser the real terminal uses and it
   *      sees every byte, including bytes this client was not attached for. It
   *      is behind CWM_VT_SIDECAR and DEFAULTS OFF, so it is an upgrade rather
   *      than a dependency: nothing here may require it.
   *   2. `term.modes.bracketedPasteMode`, xterm 6's own public IModes reader
   *      (xterm.d.ts line 1919). Correct for everything this client has seen,
   *      which is everything after attach.
   *   3. False. An application that has not asked for bracketing does not want
   *      it, and this is the SAFE default in both directions: a missing bracket
   *      pastes literally, while a spurious bracket prints `[200~` into the
   *      user's shell.
   *
   * @returns {boolean} Whether DEC 2004 is currently enabled.
   */
  isBracketedPasteMode() {
    if (typeof this._remoteBracketedPaste === 'boolean') return this._remoteBracketedPaste;
    try {
      if (this.term && this.term.modes) return this.term.modes.bracketedPasteMode === true;
    } catch (_) { /* a disposed or partially constructed terminal reports nothing */ }
    return false;
  }

  /**
   * The options every paste entry point passes to prepareInputForPty.
   *
   * One method so the three call sites cannot drift, which is exactly how D1
   * and D2 came to exist in three places at once.
   *
   * @returns {{bracketedPasteMode: boolean, confirmMultiline: string}} Options.
   */
  pasteOptions() {
    return {
      bracketedPasteMode: this.isBracketedPasteMode(),
      confirmMultiline: TerminalPane.multilinePasteSetting(),
    };
  }

  /**
   * Read the `terminalConfirmMultilinePaste` setting.
   *
   * Static and defensive for the same reason getSmoothScrollDuration is: a
   * pane can be constructed before the app shell has loaded its settings, and
   * a paste must never throw on a malformed localStorage value.
   *
   * @returns {string} `auto` (the 9.4 table), `always`, or `never`.
   */
  static multilinePasteSetting() {
    try {
      const stored = JSON.parse(localStorage.getItem('cwm_settings') || '{}');
      const value = stored && stored.terminalConfirmMultilinePaste;
      if (value === PASTE_CONFIRM_ALWAYS || value === PASTE_CONFIRM_NEVER) return value;
    } catch (_) { /* unreadable or malformed settings fall through to the default */ }
    return PASTE_CONFIRM_AUTO;
  }

  /**
   * Prepare and deliver one paste, asking first when 9.4 says to ask.
   *
   * Used by the two NATIVE entry points (beforeinput/insertFromPaste and the
   * paste event). Both have already called preventDefault, so nothing is on a
   * deadline: deferring the send behind a confirm is safe.
   *
   * @param {string} text - Raw clipboard text.
   * @returns {void}
   */
  _sendPastePayload(text) {
    const paste = prepareInputForPty(text, this.pasteOptions());
    if (paste.needsConfirm) {
      this._confirmMultilinePaste(paste);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input', data: paste.data }));
    }
  }

  /**
   * Ask before sending a multi-line paste to an application that has not
   * enabled bracketed paste.
   *
   * WHY THIS IS A PANE-LOCAL DIALOG rather than window.confirm or an app-shell
   * modal. window.confirm blocks the event loop, which stalls the PTY write
   * pipeline of every other pane on the page. An app-shell modal would put the
   * decision in app.js, a file this work package does not own, and would put a
   * chrome-coloured card over a terminal-coloured surface. This is parented on
   * the pane, styled entirely from stylesheet classes (no inline colour), and
   * dismissable three ways: Paste, Cancel, Escape.
   *
   * The default action is PASTE, matching Windows Terminal's own
   * confirmMultilinePaste dialog: the user asked for this, the confirm exists
   * to make the consequence visible, not to make it hard.
   *
   * @param {{data: string, lineCount: number, firstLine: string}} paste - A
   *   prepared payload from prepareInputForPty.
   * @returns {void}
   */
  _confirmMultilinePaste(paste) {
    const pane = this.paneEl || (this._getOwnedContainer() &&
      this._getOwnedContainer().closest('.terminal-pane'));
    if (!pane || typeof document === 'undefined') {
      // No surface to ask on. Send rather than silently swallow the paste:
      // losing a user's clipboard with no message is worse than the mild
      // surprise the confirm exists to prevent.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: paste.data }));
      }
      return;
    }
    this._dismissPasteConfirm();

    const root = document.createElement('div');
    root.className = 'terminal-paste-confirm';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', 'Confirm multi-line paste');

    const title = document.createElement('div');
    title.className = 'terminal-paste-confirm-title';
    title.textContent = 'Paste ' + paste.lineCount + ' lines into this session?';

    const detail = document.createElement('div');
    detail.className = 'terminal-paste-confirm-detail';
    detail.textContent = 'Each line runs as its own command. It starts with:';

    const preview = document.createElement('div');
    preview.className = 'terminal-paste-confirm-preview';
    preview.textContent = paste.firstLine;

    const actions = document.createElement('div');
    actions.className = 'terminal-paste-confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm terminal-paste-confirm-cancel';
    cancel.textContent = 'Cancel';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'btn btn-primary btn-sm terminal-paste-confirm-accept';
    accept.textContent = 'Paste';
    actions.appendChild(cancel);
    actions.appendChild(accept);

    root.appendChild(title);
    root.appendChild(detail);
    root.appendChild(preview);
    root.appendChild(actions);

    const close = () => this._dismissPasteConfirm();
    const send = () => {
      close();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: paste.data }));
      }
      this.focus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); this.focus(); }
      else if (e.key === 'Enter') { e.stopPropagation(); send(); }
    };
    accept.addEventListener('click', send);
    cancel.addEventListener('click', () => { close(); this.focus(); });
    root.addEventListener('keydown', onKey);

    pane.appendChild(root);
    this._pasteConfirmEl = root;
    try { accept.focus(); } catch (_) { /* a detached pane cannot take focus */ }
  }

  /**
   * Remove the multi-line paste confirm if one is open.
   *
   * Idempotent, and called from dispose() and detachHostBindings() as well as
   * from the dialog's own buttons, so a pane that is torn down or moved to
   * another slot mid-decision never leaves an orphan dialog in the DOM.
   *
   * @returns {void}
   */
  _dismissPasteConfirm() {
    if (!this._pasteConfirmEl) return;
    try { this._pasteConfirmEl.remove(); } catch (_) { /* already detached */ }
    this._pasteConfirmEl = null;
  }

  /**
   * Read the selection the user can currently copy from this pane.
   *
   * xterm normally owns selection state. A native DOM selection is also
   * accepted when both endpoints live inside this pane; that covers touch/
   * coarse-pointer and renderer fallback states where the browser visibly
   * highlights terminal text but xterm's model reports no selection.
   *
   * @returns {{hasSelection:boolean,text:string,source:'xterm'|'dom'|null}}
   */
  getCopySelection() {
    try {
      if (this.term && typeof this.term.hasSelection === 'function' &&
          this.term.hasSelection()) {
        return {
          hasSelection: true,
          text: typeof this.term.getSelection === 'function'
            ? String(this.term.getSelection())
            : '',
          source: 'xterm',
        };
      }
    } catch (_) {}

    try {
      if (typeof document === 'undefined' ||
          typeof document.getSelection !== 'function') {
        return { hasSelection: false, text: '', source: null };
      }
      const selection = document.getSelection();
      const pane = this.paneEl ||
        this._getOwnedContainer()?.closest('.terminal-pane');
      if (!selection || selection.isCollapsed || !pane ||
          !selection.anchorNode || !selection.focusNode ||
          !pane.contains(selection.anchorNode) ||
          !pane.contains(selection.focusNode)) {
        return { hasSelection: false, text: '', source: null };
      }
      return {
        hasSelection: true,
        text: String(selection.toString()),
        source: 'dom',
      };
    } catch (_) {
      return { hasSelection: false, text: '', source: null };
    }
  }

  /**
   * Detach every slot-owned listener/control while keeping the live xterm,
   * WebSocket, buffer, and selection intact.
   *
   * Terminal tab groups reuse fixed slot containers. Cached panes therefore
   * must release their host bindings before another group mounts in the same
   * DOM, otherwise Select buttons and capture listeners control a hidden
   * TerminalPane. Pane drag/reorder uses the same lifecycle before rebinding
   * a live terminal to its destination slot.
   *
   * @returns {boolean} true when host bindings were detached.
   */
  detachHostBindings() {
    if (this._hostMobileTypeMode === undefined) {
      this._hostMobileTypeMode = !!this._mobileTypeMode;
    }

    if (this._touchScrollCleanup) {
      try { this._touchScrollCleanup(); } catch (_) {}
      this._touchScrollCleanup = null;
    }
    this._xtermTextarea = null;
    this._xtermScreen = null;
    this._xtermViewport = null;
    this._mobileSelecting = false;
    if (this._mobileSelectionResetTimer) {
      clearTimeout(this._mobileSelectionResetTimer);
      this._mobileSelectionResetTimer = null;
    }

    if (this._resizeObserver) this._resizeObserver.disconnect();

    if (this._copyHintTimer) {
      clearTimeout(this._copyHintTimer);
      this._copyHintTimer = null;
    }
    if (this._selInterceptorContainer && this._selMouseHandler) {
      try {
        this._selInterceptorContainer.removeEventListener('mousedown', this._selMouseHandler, true);
        this._selInterceptorContainer.removeEventListener('mousemove', this._selMouseHandler, true);
        this._selInterceptorContainer.removeEventListener('mouseup', this._selMouseHandler, true);
      } catch (_) {}
    }
    this._selMouseHandler = null;
    this._selInterceptorContainer = null;

    // Select mode v2 host release. The wheel guard is bound to the slot
    // container and the Copy view overlay is parented to the pane element, so
    // both are fixed-host resources exactly like the mouse interceptor above:
    // leaving them attached would let a cached pane swallow another session's
    // wheel events and leave a stale snapshot floating over the live terminal.
    // The mode flag itself is deliberately NOT cleared here: Select mode is a
    // per-session preference that must survive a pane move or a tab-group
    // cache, and _isWriteFrozen() already stops freezing an unhosted pane.
    if (this._selNoticeTimer) { clearTimeout(this._selNoticeTimer); this._selNoticeTimer = null; }
    this._removeSelectModeWheelGuard();
    this._destroyCopyView();
    // P5.2: the multi-line paste confirm is parented on the pane element, so it
    // is a fixed-host resource exactly like the Copy view overlay above. A
    // cached pane that kept its dialog attached would leave a question about
    // one session floating over another session's terminal.
    this._dismissPasteConfirm();
    if (this._copyViewBtn) {
      try { this._copyViewBtn.remove(); } catch (_) {}
      this._copyViewBtn = null;
    }
    // Width claim: the IntersectionObserver watches the slot container and the
    // focus listener sits on xterm's hidden textarea, so both are host-owned.
    // A cached pane that kept observing would claim geometry the moment its old
    // slot became visible again with a DIFFERENT session rendering into it.
    this._removeVisibilityActivate();

    if (this.paneEl) this.paneEl.classList.remove('select-mode-on');
    if (this._selectModeBtn) {
      try { this._selectModeBtn.remove(); } catch (_) {}
      this._selectModeBtn = null;
    }
    if (this._selStrip) {
      try { this._selStrip.remove(); } catch (_) {}
      this._selStrip = null;
    }
    if (this._copyHint) {
      try { this._copyHint.remove(); } catch (_) {}
      this._copyHint = null;
    }
    this.paneEl = null;
    // Select mode v3: an unhosted pane cannot be holding a selection the user
    // can see, and a stale hold would re-freeze the moment the pane is rebound
    // into a new slot. Cleared before the drain so _isWriteFrozen agrees.
    this._selectHold = false;
    this._selectFrozenAt = 0;
    this._selectDragging = false;
    // Select mode v2: the pane is now unhosted, so _isWriteFrozen() is false
    // and anything the freeze was holding must go to the terminal instead of
    // sitting in the queue until the next chunk happens to arrive. A pane the
    // user cannot see has no selection worth protecting, and an invisible hold
    // would keep growing toward the overflow cap with no way to toggle it off.
    // dispose() empties the write buffer before it calls this, so teardown
    // still writes nothing.
    this._unfreezeAndFlush();
    return true;
  }

  /**
   * Rebind a live TerminalPane to the fixed DOM host for its current slot.
   *
   * @param {string} containerId - Destination terminal-container id.
   * @returns {boolean} true when the destination exists and was rebound.
   */
  rebindHost(containerId) {
    const container = typeof document !== 'undefined'
      ? document.getElementById(containerId)
      : null;
    if (!container) return false;

    this.detachHostBindings();
    const restoreMobileTypeMode = !!this._hostMobileTypeMode;
    this._hostMobileTypeMode = undefined;
    this.containerId = containerId;
    this.paneEl = container.closest('.terminal-pane');

    if (this.term && this.term.element &&
        this.term.element.parentElement !== container) {
      container.appendChild(this.term.element);
    }
    if (this.term && this.term.element) {
      this.term.element.__cwmTerminalPane = this;
    }

    if (this.term) {
      this._installSelectModeInterceptor();
      // Select mode v2: the wheel guard follows the pane to its new slot for
      // the same reason the mouse interceptor does. Both were released by the
      // detachHostBindings() call above.
      this._installSelectModeWheelGuard();
      this._injectCopyControls();
      // Width claim: rebuild both triggers against the destination slot. The
      // hidden-to-visible edge then fires for the restored pane, which is
      // exactly when this device should own the geometry again.
      this._installVisibilityActivate();
      if (this._resizeObserver) this._resizeObserver.observe(container);
      if (this._isMobile()) {
        this.initMobileInputMode();
        if (restoreMobileTypeMode) this.setMobileTypeMode();
      }
    }
    return true;
  }

  /**
   * Surface a paste failure to the user via a bubbling CustomEvent.
   * TerminalPane has no toast UI of its own, so it dispatches
   * cwm:paste-unavailable from its container element and app.js (which owns
   * showToast) handles it. WHY an event rather than a direct call: the pane
   * must stay decoupled from the app shell, which keeps it self-contained and
   * source-testable. If no container is mounted yet we fall back to document
   * so the message is never dropped silently.
   * @param {string} reason - 'insecure-context' (no Clipboard API) or 'denied'
   *   (read blocked by the browser). Lets app.js tailor the message; both tell
   *   the user that Ctrl+V (Cmd+V on Mac) still works.
   */
  _emitPasteUnavailable(reason) {
    try {
      if (typeof document === 'undefined') return;
      const container = this._getOwnedContainer();
      const target = container || document;
      if (!target || typeof target.dispatchEvent !== 'function') return;
      target.dispatchEvent(new CustomEvent('cwm:paste-unavailable', {
        bubbles: true,
        detail: { reason, containerId: this.containerId, sessionId: this.sessionId },
      }));
    } catch (_) {
      // Never let a notification failure break the paste path.
    }
  }

  /**
   * Send a raw command string to the PTY (e.g., "reset\r").
   */
  sendCommand(cmd) {
    // Select mode v2: an app-driven command (slash command, "reset", a
    // scheduled message) is still input to the PTY, and its output must be
    // visible, so it resumes the live stream exactly like typing does.
    this._exitSelectModeForInput();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input', data: cmd }));
    }
  }

  /**
   * Visibility-safe fit: only calls fitAddon.fit() when the container is visible.
   * Hidden panes (display:none from tab switching) report 0×0 dimensions, which
   * causes fitAddon to resize the PTY to 1×1 — permanently garbling scrollback.
   * All external callers should use safeFit() instead of fitAddon.fit() directly.
   */
  safeFit() {
    if (!this.fitAddon || !this.term) return;
    // Select mode v2 (mobile placement): the strip sits above the pane's bottom
    // chrome, and the size of that chrome changes on exactly the events that
    // trigger a fit: a tab switch making this pane mobile-active (the strip may
    // already be showing from a remembered preference, placed while the pane
    // was still laid out as desktop), a rotation, and the mobile
    // type-and-send row opening or closing. Re-placed BEFORE the freeze guard
    // below on purpose, because the guard returns early and the strip is only
    // ever on screen while that freeze is active. Costs one property check on
    // a pane that has never shown the strip.
    if (this._selStrip) this._applySelectStripPlacement();
    // Select mode v2: never reflow the grid while output is frozen. A fit that
    // changes the ROW count is one of the few things xterm 6 treats as a
    // reason to clear the selection outright, and any applied resize makes the
    // CLI repaint its whole frame straight into the hold queue. The intent is
    // remembered and replayed the moment the freeze lifts, so a pane that was
    // resized mid-selection still ends up at the correct geometry.
    if (this._isWriteFrozen()) { this._fitDeferredWhileFrozen = true; return; }
    // Bail when this pane's terminal element is detached from the document,
    // e.g. cached inside a DocumentFragment during a tab-group switch. The
    // ResizeObserver watches the slot container by id, so a DIFFERENT
    // session mounted into the same slot in another tab group can otherwise
    // fire this cached pane's observer; the container rect check below would
    // pass (the container is visible, just hosting someone else) and a fit
    // against the detached element would send bogus dims to this pane's PTY.
    if (!this.term.element || !this.term.element.isConnected) return;
    const container = this._getOwnedContainer();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    try { this.fitAddon.fit(); } catch (_) { return; }
    // Notify the server only when dimensions actually changed. ConPTY
    // repaints the whole viewport on every applied resize, so redundant
    // resize messages pollute the stream of every connected client.
    this._sendResizeIfChanged(false);
  }

  /**
   * Send the terminal's current dimensions to the server, deduplicated
   * against the last values sent on this pane.
   *
   * @param {boolean} force - Send even when dims match the last sent values.
   *   Used on WebSocket open: the fresh server-side connection has no stored
   *   viewport for this client yet, so the initial resize must always go out.
   */
  _sendResizeIfChanged(force) {
    if (!this.term || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (!force && cols === this._lastSentCols && rows === this._lastSentRows) return;
    this._lastSentCols = cols;
    this._lastSentRows = rows;
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /**
   * Claim size ownership of the shared PTY for this client without writing
   * anything to stdin, then re-assert this pane's geometry. Called by the
   * app layer whenever this pane becomes the one the user is looking at
   * (pane focus, browser tab becoming visible, window focus, tab-group
   * restore). An old server that does not know the 'activate' type parses
   * and ignores it, so this degrades gracefully across a mixed-version
   * deploy window.
   */
  activate() {
    // Select mode v2 guard: never claim geometry while output is frozen. The
    // claim makes the CLI repaint its whole frame, which would pour straight
    // into the hold queue, and the safeFit below could change the row count
    // and clear the selection outright. The intent is remembered and replayed
    // when the freeze lifts.
    if (this._isWriteFrozen()) { this._activatePending = true; return; }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'activate' })); } catch (_) {}
    }
    this.safeFit();
    this._noteActivateSent();
  }

  /* ═══════════════════════════════════════════════════════════
     VISIBLE-PANE WIDTH CLAIM
     The app layer already calls activate() when the user clicks a
     pane, when the browser tab becomes visible, when the window
     regains focus, and when a tab group is restored. These triggers
     cover the cases it cannot see: a pane scrolling or switching into
     view (a phone tab switch, a grid layout change) and the terminal
     taking keyboard focus without a click. Claiming makes the shared
     PTY resize to THIS client, and the CLI repaints its whole frame at
     that width, which is what turns an unreadable wrapped phone view
     into a clean narrow one. The honest cost of a single shared PTY: a
     desktop watching the same session then sees the narrow frames too,
     until it is interacted with again.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Record that a geometry claim just went out, so the debounce and the no-op
   * suppression in _requestActivate have something to measure against.
   * Reads the CURRENT grid, which is why callers fit before claiming.
   */
  _noteActivateSent() {
    this._lastActivateAt = Date.now();
    if (this.term) {
      this._lastActivateCols = this.term.cols;
      this._lastActivateRows = this.term.rows;
    }
  }

  /**
   * Claim PTY geometry ownership for this client, subject to every guard.
   *
   * Order of the guards is deliberate:
   *   1. No socket, no terminal, no claim.
   *   2. Frozen for a selection: remember and defer (see activate()).
   *   3. Inside the connect or resync quiet window: retry after it closes
   *      rather than dropping the intent, so a pane that becomes visible
   *      during startup still ends up owning geometry.
   *   4. Debounce: visibility and focus commonly fire together for one
   *      gesture, and one claim per gesture is enough.
   *   5. No-op suppression: an identical cols/rows claim is skipped, but only
   *      for ACTIVATE_REASSERT_MS, because ownership can move to another
   *      device at any time and re-claiming is how it comes back.
   * The fit happens BEFORE the send so the viewport the server stores for this
   * client is the geometry it is about to be asked to apply.
   *
   * @param {string} reason - Trigger label, for the debug log only.
   * @returns {boolean} True when a claim was actually sent.
   */
  _requestActivate(reason) {
    if (!this.term || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this._isWriteFrozen()) { this._activatePending = true; return false; }
    const now = Date.now();
    if (now < this._activateBlockedUntil) {
      this._scheduleActivateRetry(this._activateBlockedUntil - now, reason);
      return false;
    }
    if (this._lastActivateAt && (now - this._lastActivateAt) < ACTIVATE_DEBOUNCE_MS) return false;
    this.safeFit();
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols === this._lastActivateCols && rows === this._lastActivateRows &&
        this._lastActivateAt && (now - this._lastActivateAt) < ACTIVATE_REASSERT_MS) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ type: 'activate' }));
    } catch (_) {
      return false;
    }
    this._noteActivateSent();
    this._log('Claimed PTY geometry (' + reason + ') at ' + cols + 'x' + rows);
    return true;
  }

  /**
   * Re-attempt a claim once the current quiet window closes. At most one timer
   * is outstanding per pane; a second request while one is pending is already
   * represented by that timer.
   *
   * @param {number} delayMs - Remaining quiet window.
   * @param {string} reason - Trigger label carried through to the retry.
   */
  _scheduleActivateRetry(delayMs, reason) {
    if (this._activateRetryTimer) return;
    const wait = Math.max(0, Math.min(delayMs, ACTIVATE_CONNECT_GUARD_MS)) + 50;
    this._activateRetryTimer = setTimeout(() => {
      this._activateRetryTimer = null;
      this._requestActivate(reason);
    }, wait);
  }

  /**
   * Wire the two "this pane is the one being looked at" triggers.
   *
   * (a) IntersectionObserver on the pane's owned container: fires when the
   *     pane crosses ACTIVATE_VISIBILITY_RATIO of on-screen area, which is
   *     what a phone tab switch, a tab-group restore, or a scroll into view
   *     looks like from inside the pane. Only the hidden-to-visible EDGE
   *     claims, so a pane that stays visible never re-claims on its own.
   * (b) focus on xterm's hidden textarea: keyboard focus without a click (tab
   *     key, programmatic focus, the mobile Type button) never reaches the
   *     app's click handler, so it would otherwise not claim at all.
   *
   * Both are feature-detected and wrapped: an engine without
   * IntersectionObserver simply keeps the app-layer activate() behavior. The
   * container is resolved through _getOwnedContainer so a cached pane can
   * never observe a slot another session is rendering into, and both bindings
   * are released by detachHostBindings and rebuilt by rebindHost.
   */
  _installVisibilityActivate() {
    const container = this._getOwnedContainer();
    if (!container) return;
    this._removeVisibilityActivate();
    if (typeof IntersectionObserver === 'function') {
      try {
        this._paneObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const ratio = typeof entry.intersectionRatio === 'number' ? entry.intersectionRatio : 0;
            const visible = !!entry.isIntersecting && ratio >= ACTIVATE_VISIBILITY_RATIO;
            if (visible && !this._paneVisible) {
              this._paneVisible = true;
              this._requestActivate('visible');
            } else if (!visible) {
              this._paneVisible = false;
            }
          }
        }, { threshold: [ACTIVATE_VISIBILITY_RATIO] });
        this._paneObserver.observe(container);
      } catch (_) {
        this._paneObserver = null;
      }
    }
    const textarea = container.querySelector('.xterm-helper-textarea');
    if (textarea && typeof textarea.addEventListener === 'function') {
      this._activateFocusHandler = () => { this._requestActivate('focus'); };
      textarea.addEventListener('focus', this._activateFocusHandler);
      this._activateFocusTarget = textarea;
    }
  }

  /** Tear down the visibility and focus claim triggers and any pending retry. */
  _removeVisibilityActivate() {
    if (this._paneObserver) {
      try { this._paneObserver.disconnect(); } catch (_) {}
      this._paneObserver = null;
    }
    if (this._activateFocusTarget && this._activateFocusHandler) {
      try {
        this._activateFocusTarget.removeEventListener('focus', this._activateFocusHandler);
      } catch (_) {}
    }
    this._activateFocusHandler = null;
    this._activateFocusTarget = null;
    if (this._activateRetryTimer) { clearTimeout(this._activateRetryTimer); this._activateRetryTimer = null; }
    this._paneVisible = false;
    this._activatePending = false;
  }

  // Re-apply the smooth-scroll setting live to this pane. No-op while the mobile
  // momentum engine is driving (it manages the duration itself to avoid double
  // animation) or before the terminal element exists.
  applySmoothScrollSetting() {
    if (!this.term || this._engineDriving) return;
    this.term.options.smoothScrollDuration = TerminalPane.getSmoothScrollDuration();
  }

  /**
   * Mobile scroll/type mode.
   * On mobile, touching the terminal to scroll triggers the keyboard because
   * xterm.js uses a hidden textarea for input. Professional mobile terminals
   * (Blink Shell, Termux) solve this by separating scroll and type modes.
   *
   * Scroll mode (default): textarea is readonly, touch scrolls without keyboard
   * Type mode: textarea is writable, keyboard appears for input
   */
  _isMobile() {
    // Decide whether this pane should run the mobile scroll/type engine.
    //
    // REGRESSION FIX (user report, 2026-07-25): the previous test was
    // `('ontouchstart' in window) || navigator.maxTouchPoints > 0`, added by
    // commit 7b992aa ("enable touch scrolling for all clients"). Desktop
    // Chrome and Edge expose `window.ontouchstart` even with ZERO touch
    // hardware (maxTouchPoints 0, no digitizer), so that first disjunct made
    // `_isMobile()` return true on ordinary mouse desktops. When it returned
    // true, initMobileInputMode() set `.xterm-screen { pointer-events: none }`
    // for scroll passthrough. With the screen pointer-transparent, xterm's
    // SelectionService (which binds mousedown on `.xterm-screen`) never saw
    // the drag, so term.hasSelection() stayed false while the browser still
    // painted a NATIVE DOM selection over the DOM-rendered rows. That is
    // exactly the reported bug: a visible highlight that Ctrl+C could not
    // copy (hasSelection() false, so the copy branch in
    // attachCustomKeyEventHandler fell through and xterm sent \x03/SIGINT,
    // which is why a second Ctrl+C exited the CLI), and a right-click Copy
    // that found nothing because it reads the same empty xterm selection.
    //
    // The fix requires a REAL coarse primary pointer AND actual touch points,
    // never `ontouchstart` alone. A phone or tablet reports
    // `(pointer: coarse)` as its primary pointer together with
    // maxTouchPoints > 0, so genuine touch devices still get the scroll/type
    // engine. A desktop with a mouse reports `(pointer: fine)` as primary
    // (even when a touchscreen is attached), so it now stays in desktop mode
    // where `.xterm-screen` keeps its default pointer-events and mouse text
    // selection plus Ctrl+C copy work normally.
    //
    // All lookups are typeof-guarded and wrapped so detection can never throw
    // in a non-browser or partially-stubbed environment (the source tests
    // construct TerminalPane without a full window); on any failure we default
    // to desktop, the non-restrictive mode that preserves mouse selection.
    try {
      const coarsePrimary =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches;
      const hasTouchPoints =
        typeof navigator !== 'undefined' &&
        typeof navigator.maxTouchPoints === 'number' &&
        navigator.maxTouchPoints > 0;
      return coarsePrimary && hasTouchPoints;
    } catch (_) {
      return false;
    }
  }

  /**
   * Initialize mobile input mode - called after terminal mounts.
   * Uses CSS pointer-events to prevent touch from focusing xterm's hidden
   * textarea (which triggers the keyboard). Toolbar buttons send via WebSocket
   * directly and don't need the textarea. The "Type" button toggles
   * pointer-events to allow keyboard input when explicitly requested.
   */
  initMobileInputMode() {
    if (!this._isMobile() || !this.term) return;

    this._mobileTypeMode = false;
    this._mobileSelecting = false;

    const container = this._getOwnedContainer();
    if (!container) return;
    const textarea = container.querySelector('.xterm-helper-textarea');
    if (!textarea) return;

    this._xtermTextarea = textarea;
    this._xtermScreen = container.querySelector('.xterm-screen');
    this._xtermViewport = container.querySelector('.xterm-viewport');

    // Disable mobile keyboard autocomplete/autocorrect/spellcheck.
    // These use IME composition events that xterm.js mishandles,
    // causing duplicated/garbled text injection.
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');

    // Default to scroll mode: block touch from reaching textarea and screen.
    // textarea: prevents keyboard popup on scroll
    // screen: block xterm.js's internal touch handling that calls preventDefault
    textarea.style.pointerEvents = 'none';
    if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'none';

    // ── Manual touch-scroll with momentum ──────────────────────────
    // Why manual? xterm.js registers touch/wheel handlers on .xterm-viewport
    // and .xterm that call preventDefault(), blocking native browser scroll
    // even when pointer-events: none is set on .xterm-screen (events still
    // bubble from viewport to .xterm where xterm.js intercepts them).
    //
    // This handler intercepts touches at our container level (capture phase)
    // and uses term.scrollLines() — xterm.js's own scroll API — so that
    // internal scroll state (ydisp) stays in sync. Without this, xterm.js
    // doesn't know the user has scrolled up and snaps back to the bottom
    // on every new PTY output line.
    //
    // Long-press (400ms hold) switches to xterm.js selection mode so the
    // user can highlight text without triggering the keyboard.

    // Line height in pixels: used to convert touch pixel deltas to line counts.
    const fontSize = (this.term.options && this.term.options.fontSize) || 13;
    const lineHeightMult = (this.term.options && this.term.options.lineHeight) || 1.2;
    const lineHeightPx = Math.ceil(fontSize * lineHeightMult);

    let startY = 0;          // Touch start Y position
    let lastY = 0;           // Previous touchmove Y
    let lastTime = 0;        // Previous touchmove timestamp
    let velocity = 0;        // Scroll velocity for momentum (px/ms)
    let momentumRaf = null;  // rAF ID for momentum animation
    let isScrolling = false; // Whether we detected a scroll gesture
    let longPressTimer = null;
    let scrollAccum = 0;     // Sub-line pixel accumulator for smooth scrolling
    let lastMomentumTime = 0;
    const LONG_PRESS_MS = 400;
    const MOVE_THRESHOLD = 8;  // px — must move this far to be a scroll
    const FRICTION = 0.92;     // Momentum deceleration (per 16ms equivalent)
    const MIN_VELOCITY = 0.1;  // Stop momentum below this (px/ms)

    /**
     * Hand scroll control back to xterm once the touch engine stops driving
     * (issue #41). Reads getSmoothScrollDuration() fresh so a settings or
     * reduced-motion change made mid-gesture self-corrects at gesture end.
     */
    const restoreSmoothScroll = () => {
      this._engineDriving = false;
      if (this.term) this.term.options.smoothScrollDuration = TerminalPane.getSmoothScrollDuration();
    };

    /** Cancel any running momentum animation */
    const stopMomentum = () => {
      if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
      velocity = 0;
      // Momentum decay (or teardown) is a gesture-end path: restore xterm's
      // own smooth scrolling for subsequent wheel/keyboard scrolls.
      restoreSmoothScroll();
    };

    /**
     * Scroll by a pixel amount using xterm.js's scrollLines() API.
     * Using the API (not direct scrollTop) keeps xterm.js's internal ydisp
     * in sync, so new output doesn't snap the view back to the bottom.
     * scrollLines(n): negative = toward top (older content), positive = toward bottom.
     * Finger moving down (px > 0) should show older content → scrollLines(negative).
     */
    const scrollByPixels = (px) => {
      scrollAccum += px / lineHeightPx;
      const linesToScroll = Math.trunc(scrollAccum);
      if (linesToScroll !== 0) {
        scrollAccum -= linesToScroll;
        this.term.scrollLines(-linesToScroll);
      }
    };

    /** Animate momentum scroll after finger lifts (time-based, works at any Hz) */
    const animateMomentum = (timestamp) => {
      if (lastMomentumTime === 0) lastMomentumTime = timestamp;
      const dt = Math.min(timestamp - lastMomentumTime, 64); // cap at 64ms (tab switches)
      lastMomentumTime = timestamp;
      velocity *= Math.pow(FRICTION, dt / 16); // scale decay to actual frame time
      if (Math.abs(velocity) < MIN_VELOCITY) { stopMomentum(); return; }
      scrollByPixels(velocity * dt);
      momentumRaf = requestAnimationFrame(animateMomentum);
    };

    const onTouchStart = (e) => {
      // Copy view overlay owns its own scrolling and long-press selection.
      if (this._isInsideCopyView(e.target)) return;
      // In type mode, let xterm.js handle everything
      if (this._mobileTypeMode) return;
      // If currently selecting, let xterm handle
      if (this._mobileSelecting) return;

      // Block xterm.js from seeing this event (it calls preventDefault)
      e.stopPropagation();
      stopMomentum();
      // Issue #41: take scroll ownership for this gesture. Zero xterm's own
      // scroll animation so the engine's per-frame scrollLines() calls apply
      // instantly instead of each getting an extra ease (double animation).
      this._engineDriving = true;
      if (this.term && this.term.options.smoothScrollDuration) this.term.options.smoothScrollDuration = 0;
      const touch = e.touches[0];
      startY = touch.clientY;
      lastY = touch.clientY;
      lastTime = Date.now();
      velocity = 0;
      isScrolling = false;
      scrollAccum = 0;

      // Start long-press timer for text selection
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!isScrolling) this._enableMobileSelection();
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e) => {
      // Copy view overlay scrolls natively; never convert it to term scroll.
      if (this._isInsideCopyView(e.target)) return;
      if (this._mobileTypeMode) return;
      // If selecting, let xterm.js handle the selection drag
      if (this._mobileSelecting) return;

      // Block xterm.js from seeing this event
      e.stopPropagation();

      const touch = e.touches[0];
      const deltaY = touch.clientY - lastY;
      const totalDelta = Math.abs(touch.clientY - startY);
      const now = Date.now();
      const dt = now - lastTime;

      // Once movement exceeds threshold, it's a scroll — cancel long-press
      if (!isScrolling && totalDelta > MOVE_THRESHOLD) {
        isScrolling = true;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }

      if (isScrolling) {
        // Prevent default browser scroll (e.g. pull-to-refresh on Chrome mobile/tablet)
        if (e.cancelable) e.preventDefault();
        
        // Scroll via xterm.js API so ydisp stays in sync (prevents snap-back on output)
        scrollByPixels(deltaY);
        // Track velocity for momentum (smoothed exponential average)
        if (dt > 0) {
          const instantV = deltaY / dt;
          velocity = velocity * 0.6 + instantV * 0.4;
        }
      }

      lastY = touch.clientY;
      lastTime = now;
    };

    const onTouchEnd = (e) => {
      // Copy view overlay: leave the gesture entirely to the browser.
      if (this._isInsideCopyView(e.target)) return;
      if (!this._mobileTypeMode && !this._mobileSelecting) e.stopPropagation();
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

      // If we were selecting, revert after a delay for xterm.js to process
      if (this._mobileSelecting) {
        // Long-press converted this gesture into selection; no momentum will
        // run, so this is also a gesture-end path (issue #41).
        restoreSmoothScroll();
        if (this._mobileSelectionResetTimer) {
          clearTimeout(this._mobileSelectionResetTimer);
        }
        this._mobileSelectionResetTimer = setTimeout(() => {
          this._mobileSelectionResetTimer = null;
          this._disableMobileSelection();
        }, 300);
        return;
      }

      if (this._mobileTypeMode) return;

      // Start momentum animation if finger was moving fast enough
      if (isScrolling && Math.abs(velocity) > MIN_VELOCITY) {
        lastMomentumTime = 0;
        momentumRaf = requestAnimationFrame(animateMomentum);
      } else {
        // No momentum tail: the gesture ends right here, hand scroll control
        // back to xterm (momentum gestures restore via stopMomentum instead).
        restoreSmoothScroll();
      }
      isScrolling = false;
    };

    // Use CAPTURE phase to intercept before xterm.js gets the events.
    // Non-passive so we can prevent xterm from seeing the events in scroll mode
    // AND prevent browser pull-to-refresh (overscroll) on mobile/tablet.
    container.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    container.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });

    // Store cleanup function for dispose()
    this._touchScrollCleanup = () => {
      clearTimeout(longPressTimer);
      stopMomentum();
      container.removeEventListener('touchstart', onTouchStart, { capture: true });
      container.removeEventListener('touchmove', onTouchMove, { capture: true });
      container.removeEventListener('touchend', onTouchEnd, { capture: true });
      container.removeEventListener('touchcancel', onTouchEnd, { capture: true });
    };
  }

  /**
   * Temporarily enable xterm.js touch handling for text selection (long-press).
   * Re-enables pointer-events on .xterm-screen so xterm handles selection,
   * but keeps textarea pointer-events disabled to prevent keyboard popup.
   */
  _enableMobileSelection() {
    if (this._mobileSelectionResetTimer) {
      clearTimeout(this._mobileSelectionResetTimer);
      this._mobileSelectionResetTimer = null;
    }
    this._mobileSelecting = true;
    if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'auto';
    // Haptic feedback if available (subtle vibration signals selection mode)
    if (navigator.vibrate) navigator.vibrate(25);
  }

  /**
   * Disable xterm.js touch handling after selection ends.
   * Reverts .xterm-screen to pointer-events: none for scroll passthrough.
   */
  _disableMobileSelection() {
    this._mobileSelecting = false;
    if (this._xtermScreen && !this._mobileTypeMode) {
      this._xtermScreen.style.pointerEvents = 'none';
    }
  }

  /**
   * Switch to type mode - keyboard appears, user can type into terminal.
   * Restores pointer-events on both textarea (keyboard input) and screen
   * (xterm.js touch handling for cursor/selection).
   */
  setMobileTypeMode() {
    if (!this._xtermTextarea || !this.term) return;
    this._mobileTypeMode = true;
    this._xtermTextarea.style.pointerEvents = 'auto';
    if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'auto';
    this.term.focus();
    if (this.onMobileModeChange) this.onMobileModeChange('type');
  }

  /**
   * Switch to scroll mode - keyboard hidden, touch scrolls terminal output.
   * Disables pointer-events on textarea (prevents keyboard popup) and screen
   * (lets touches pass through to viewport for native compositor-thread scroll).
   */
  setMobileScrollMode() {
    if (!this._xtermTextarea) return;
    this._mobileTypeMode = false;
    this._xtermTextarea.style.pointerEvents = 'none';
    if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'none';
    if (this.term) this.term.blur();
    if (this.onMobileModeChange) this.onMobileModeChange('scroll');
  }

  /**
   * Toggle between scroll and type mode
   */
  toggleMobileInputMode() {
    if (this._mobileTypeMode) {
      this.setMobileScrollMode();
    } else {
      this.setMobileTypeMode();
    }
    return this._mobileTypeMode;
  }

  /* ═══════════════════════════════════════════════════════════
     WRITE BATCHING
     Accumulates WebSocket data and flushes to xterm.js once per
     animation frame. Prevents main-thread thrashing when multiple
     terminals output rapidly — the primary cause of input freezes.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Enqueue data for batched writing to xterm.
   * Focused terminal: flushes every animation frame for responsive input.
   * Background terminals: flush every 150ms to avoid blocking the active pane's
   * main thread — this is what prevents cursor freezes with multiple sessions.
   * @param {string} data - Raw terminal output
   */
  _enqueueWrite(data) {
    this._writeBuf += data;
    this._activitySample += data;

    // Select mode v2 freeze gate. While the toggle is on for a hosted pane,
    // bytes accumulate in the SAME queue the batching pipeline already uses
    // and no flush is scheduled, so the visible screen becomes a stable
    // snapshot and an in-progress selection can never be repainted out from
    // under the user. Nothing is dropped: the queue drains in one write when
    // the mode ends. Scheduling is skipped entirely (rather than relying on
    // the flush-side guard alone) so a chatty session cannot spin a rAF or a
    // 150ms timer on every chunk for as long as the user keeps selecting.
    if (this._isWriteFrozen()) {
      if (this._writeBuf.length >= SELECT_FREEZE_MAX_HOLD_CHARS) this._overflowSelectFreeze();
      return;
    }

    if (this._isFocused) {
      // Active terminal: flush every frame for real-time responsiveness
      if (this._bgFlushTimer) { clearTimeout(this._bgFlushTimer); this._bgFlushTimer = null; }
      if (!this._writeRaf) {
        this._writeRaf = requestAnimationFrame(() => this._flushWriteBuffer());
      }
    } else {
      // Background terminal: throttled flush to yield main thread to focused pane
      if (!this._bgFlushTimer) {
        this._bgFlushTimer = setTimeout(() => {
          this._bgFlushTimer = null;
          if (this._writeRaf) { cancelAnimationFrame(this._writeRaf); this._writeRaf = null; }
          this._flushWriteBuffer();
        }, 150);
      }
    }
  }

  /**
   * Mark this terminal as focused (active pane). Focused terminals render
   * at full frame rate. Background terminals throttle to 150ms intervals.
   * Called by app.js when the user clicks/focuses a pane.
   * @param {boolean} focused - Whether this pane is the active/focused one
   */
  setFocused(focused) {
    this._isFocused = focused;
    // Select mode v2: focusing a frozen pane must not schedule a flush. The
    // flush-side gate would refuse to consume the queue anyway, so this only
    // saves a wasted animation frame per focus change, but it also keeps the
    // "nothing is scheduled while frozen" invariant true at every entry point.
    if (this._isWriteFrozen()) return;
    // If becoming focused and there's buffered data, flush immediately
    if (focused && this._writeBuf) {
      if (this._bgFlushTimer) { clearTimeout(this._bgFlushTimer); this._bgFlushTimer = null; }
      if (!this._writeRaf) {
        this._writeRaf = requestAnimationFrame(() => this._flushWriteBuffer());
      }
    }
  }

  /**
   * Flush accumulated write buffer to xterm in a single write call.
   * Also triggers debounced activity detection and completion tracking.
   */
  _flushWriteBuffer() {
    this._writeRaf = null;
    // Select mode v2 freeze gate, second line of defense. A rAF or background
    // timer scheduled just BEFORE the toggle went on still fires afterwards;
    // returning here (before the buffer is consumed) keeps the held bytes
    // queued instead of letting one stray frame repaint under a selection.
    if (this._isWriteFrozen()) return;
    if (!this._writeBuf) return;

    const buf = this._writeBuf;
    this._writeBuf = '';

    // Single xterm write for the entire frame's data
    this.term.write(buf);

    // Track completion (debounced internally). The flushed chunk is passed
    // so the tracker can decide whether this burst is meaningful output or
    // just a cosmetic repaint (see _trackActivityForCompletion).
    this._trackActivityForCompletion(buf);

    // Debounce activity detection to at most once per 200ms.
    // Skip for unfocused terminals to avoid wasting CPU on regex
    // parsing when the result won't be visible anyway.
    if (!this._activityDebounceTimer) {
      this._activityDebounceTimer = setTimeout(() => {
        this._activityDebounceTimer = null;
        const sample = this._activitySample;
        this._activitySample = '';
        if (sample && this._isFocused) {
          this._detectActivity(sample);
          this._analyzeForAutoTrust(sample);
        }
      }, 200);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     ACTIVITY DETECTION
     Parses terminal output in real-time for Claude Code patterns
     and dispatches 'terminal-activity' events so the app layer
     can display what each pane is currently doing.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Detect Claude Code activity from raw terminal output.
   * Matches tool-use headers (Read, Write, Bash, etc.) and updates
   * the current activity state, dispatching a custom event on change.
   */
  _detectActivity(data) {
    // Append to rolling buffer (strip ANSI escape codes for matching)
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    this._activityBuffer += clean;
    if (this._activityBuffer.length > 500) {
      this._activityBuffer = this._activityBuffer.slice(-500);
    }

    let newActivity = null;

    // Pattern matching - check most specific patterns first
    // Claude Code tool use headers look like: "⏺ Read(file_path)" or "⏺ Write(file_path)" or "⏺ Bash(command)"
    const toolMatch = this._activityBuffer.match(/⏺\s*(Read|Write|Edit|Bash|Glob|Grep|Task|WebFetch|WebSearch)\(([^)]*)\)\s*$/m);
    if (toolMatch) {
      const tool = toolMatch[1];
      const arg = toolMatch[2].trim().replace(/^["']|["']$/g, '');
      const shortArg = arg.length > 40 ? '...' + arg.slice(-37) : arg;

      if (tool === 'Read') newActivity = { type: 'reading', detail: shortArg };
      else if (tool === 'Write' || tool === 'Edit') newActivity = { type: 'writing', detail: shortArg };
      else if (tool === 'Bash') newActivity = { type: 'running', detail: shortArg };
      else if (tool === 'Glob' || tool === 'Grep') newActivity = { type: 'searching', detail: shortArg };
      else if (tool === 'Task') newActivity = { type: 'delegating', detail: 'Spawning subagent' };
      else if (tool === 'WebFetch' || tool === 'WebSearch') newActivity = { type: 'searching', detail: 'Web search' };
    }

    // Thinking/streaming indicator - detect Claude's actual response marker.
    // Claude Code prefixes all output (responses + tool calls) with ⏺.
    // Tool calls are already caught above, so a ⏺ in the CURRENT chunk
    // without a tool match means Claude is streaming a text response.
    // Only check the current data chunk (not rolling buffer) to avoid
    // stale markers from previous tool calls triggering false positives.
    if (!newActivity && /⏺/.test(clean)) {
      newActivity = { type: 'thinking', detail: 'Generating response' };
    }

    if (newActivity && (!this._currentActivity || this._currentActivity.type !== newActivity.type || this._currentActivity.detail !== newActivity.detail)) {
      this._currentActivity = newActivity;
      // Dispatch custom event for the app layer
      const eventTarget = this._getOwnedContainer() || document;
      if (eventTarget && typeof eventTarget.dispatchEvent === 'function') {
        eventTarget.dispatchEvent(new CustomEvent('terminal-activity', {
          bubbles: true,
          detail: { sessionId: this.sessionId, activity: newActivity }
        }));
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     COMPLETION DETECTION
     Detects when Claude transitions from "working" (producing output)
     to "idle" (showing a prompt, ready for input). Uses a debounced
     check: after 2 seconds of no new output, inspects the terminal
     buffer's last line for prompt patterns (❯, $, >, Human:, etc.).
     ═══════════════════════════════════════════════════════════ */

  /**
   * Called after every terminal write flush. Marks the pane as working and
   * schedules a debounced idle check - if no output arrives for 2s
   * after the last burst, we inspect the buffer for a prompt.
   * @param {string} chunk - The flushed output chunk. Used to decide whether
   *   this burst is meaningful enough to re-arm idle detection; the debounced
   *   idle check itself is (re)scheduled on every flush regardless.
   */
  _trackActivityForCompletion(chunk) {
    this._lastOutputTime = Date.now();
    // Clear "needs input" indicator when new output arrives (agent moved past the prompt)
    if (this._needsInput) {
      clearTimeout(this._needsInputTimer);
      this._needsInputTimer = setTimeout(() => {
        if (this._needsInput) {
          this._needsInput = false;
          const eventTarget = this._getOwnedContainer() || document;
          if (eventTarget && typeof eventTarget.dispatchEvent === 'function') {
            eventTarget.dispatchEvent(new CustomEvent('terminal-needs-input', { bubbles: true, detail: { sessionId: this.sessionId, needsInput: false } }));
          }
        }
      }, 5000);
    }
    // Edge-triggered re-arm: only MEANINGFUL output counts as new work.
    // Cosmetic repaints (Ink border redraw, focus-report echo, spinner
    // ticks, cursor repositioning) strip to fewer than MIN_REARM_CHARS
    // visible characters and must NOT reset _idleNotified. Before this
    // gate, ANY byte re-armed the notifier, so every repaint followed by
    // 2s of quiet re-fired "ready for input" (the notification storm).
    const cleanChunk = (typeof chunk === 'string' ? chunk : '')
      .replace(TerminalPane.ANSI_ESCAPE_RE, '');
    if (cleanChunk.trim().length >= TerminalPane.MIN_REARM_CHARS && !this._isWorking) {
      this._isWorking = true;
      // New work started after being idle - allow the next idle event to fire
      this._idleNotified = false;
    }
    // Debounced idle check - if no output for 2 seconds after burst, check for prompt
    clearTimeout(this._idleCheckTimer);
    this._idleCheckTimer = setTimeout(() => {
      this._checkForCompletion();
    }, 2000);
  }

  /**
   * Inspect the terminal buffer's cursor line for prompt patterns.
   * If a prompt is detected, dispatch a 'terminal-idle' CustomEvent
   * so the app layer can show notifications, flash borders, etc.
   */
  _checkForCompletion() {
    if (!this._isWorking || !this.term) return;

    // Replay-suppression window: output arriving right after a WebSocket
    // (re)connect is scrollback replay, not new work. Disarm and bail so a
    // replayed prompt line cannot notify on mount, reconnect, or tab switch.
    if (Date.now() < this._suppressIdleUntil) {
      this._isWorking = false;
      return;
    }

    // Read the last line of the terminal buffer at the cursor position
    const buffer = this.term.buffer.active;
    const cursorRow = buffer.cursorY + buffer.baseY;
    const line = buffer.getLine(cursorRow);
    if (!line) return;

    const lineText = line.translateToString(true).trim();

    // Plan 19-02 (PTY-04): dispatch idle detection through the active pane's
    // provider spec. Replaces a hardcoded Claude regex with a per-pane lookup
    // so a Codex pane fires idle only on Codex prompts (`codex>`) and a Claude
    // pane fires only on Claude prompts (`❯`, `Human:`, etc.). The spec map
    // is populated at boot by app.js fetchProviderSpecs(); _isIdleLineForProvider
    // falls back to the original Claude regex if the map is missing.
    if (TerminalPane._isIdleLineForProvider(this._providerId, lineText)) {
      this._isWorking = false;

      // Update activity to idle when prompt is detected
      this._currentActivity = { type: 'idle', detail: 'Waiting for input' };
      this._activityBuffer = '';
      const idleTarget = this._getOwnedContainer() || document;
      if (idleTarget && typeof idleTarget.dispatchEvent === 'function') {
        idleTarget.dispatchEvent(new CustomEvent('terminal-activity', {
          bubbles: true,
          detail: { sessionId: this.sessionId, activity: this._currentActivity }
        }));
      }

      // Only dispatch terminal-idle once per work cycle. Trivial PTY output
      // (cursor repositioning, escape sequences) can restart the 2s debounce
      // timer and land here again while the prompt is still showing. Without
      // this guard, the notification dot gets re-added after the user clears it.
      if (this._idleNotified) return;

      // Per-pane refire cooldown: even a legitimate-looking re-arm (e.g. a
      // full-screen SIGWINCH repaint after a grid resize passes the
      // MIN_REARM_CHARS gate) cannot ping the user more than once per
      // IDLE_REFIRE_COOLDOWN_MS for the same pane.
      if (Date.now() - this._lastIdleFiredAt < TerminalPane.IDLE_REFIRE_COOLDOWN_MS) return;
      this._idleNotified = true;
      this._lastIdleFiredAt = Date.now();

      // Dispatch custom event for the app to handle
      const idleEventTarget = this._getOwnedContainer() || document;
      if (idleEventTarget && typeof idleEventTarget.dispatchEvent === 'function') {
        idleEventTarget.dispatchEvent(new CustomEvent('terminal-idle', {
          bubbles: true,
          detail: { sessionId: this.sessionId, sessionName: this.sessionName }
        }));
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     AUTO-TRUST / QUESTION DETECTION
     Analyzes terminal output for interactive prompts (Y/n, trust,
     permission dialogs). When auto-trust is enabled, automatically
     accepts safe prompts. Dangerous prompts (delete, credentials)
     are never auto-accepted — they raise a "needs input" event
     so the app layer can alert the user.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Analyze recent terminal output for interactive question/dialog patterns.
   * Strips ANSI codes, appends to a rolling 4KB buffer, then checks the
   * tail for known prompt patterns. Safe prompts are auto-accepted when
   * auto-trust is enabled; dangerous prompts always require human input.
   * @param {string} data - Raw terminal output chunk (may contain ANSI)
   */
  _analyzeForAutoTrust(data) {
    // Strip ANSI escape codes for clean pattern matching
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    this._autoTrustBuffer += clean;
    // Trim to last 4096 chars (4KB rolling window)
    if (this._autoTrustBuffer.length > 4096) {
      this._autoTrustBuffer = this._autoTrustBuffer.slice(-4096);
    }

    // Only check the most recent 200 chars for prompt patterns
    const tail = this._autoTrustBuffer.slice(-200);

    // Prompt/dialog detection patterns
    const promptPatterns = [
      /\(Y\/n\)/i,
      /\(y\/N\)/i,
      /trust this (folder|directory|project)/i,
      /allow .*(tool|access|permission)/i,
      /\bproceed\?/i,
      /\bapprove\b.*\?/i,
      /\bcontinue\?/i,
      /\baccept\b.*\?/i,
    ];

    let matched = false;
    let matchText = '';
    for (const pattern of promptPatterns) {
      const m = tail.match(pattern);
      if (m) {
        matched = true;
        matchText = m[0];
        break;
      }
    }

    if (!matched) return;

    // Check for danger keywords — never auto-accept these
    const dangerKeywords = /\b(delete|remove|credential|secret|password|key|token|destroy|format|drop|wipe|overwrite)\b/i;
    const contextWindow = tail; // Check entire tail for danger context
    const isDangerous = dangerKeywords.test(contextWindow);

    if (isDangerous) {
      // Dangerous prompt: always require human input regardless of auto-trust setting
      if (!this._needsInput) {
        this._needsInput = true;
        const eventTarget = this._getOwnedContainer() || document;
        if (eventTarget && typeof eventTarget.dispatchEvent === 'function') {
          eventTarget.dispatchEvent(new CustomEvent('terminal-needs-input', {
            bubbles: true,
            detail: { sessionId: this.sessionId, needsInput: true }
          }));
        }
      }
      return;
    }

    if (this._autoTrustEnabled) {
      // Auto-trust enabled and prompt is safe: auto-accept after cooldown
      const now = Date.now();
      if (now - this._autoTrustCooldown >= 3000) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
          this._autoTrustCooldown = now;
          this._log('Auto-trust: accepted dialog (' + matchText + ')');
        }
      }
    } else {
      // Auto-trust not enabled: flag as needing human input
      if (!this._needsInput) {
        this._needsInput = true;
        const eventTarget = this._getOwnedContainer() || document;
        if (eventTarget && typeof eventTarget.dispatchEvent === 'function') {
          eventTarget.dispatchEvent(new CustomEvent('terminal-needs-input', {
            bubbles: true,
            detail: { sessionId: this.sessionId, needsInput: true }
          }));
        }
      }
    }
  }

  /**
   * Plan 19-02 (PTY-05): resolve the Shift+Enter byte sequence for this
   * pane's provider.
   *
   * Reads window.CWMProviderSpecs[providerId].shiftEnter. Claude returns
   * '\x1b\r' (Ink-correct: ESC+CR is "newline in input"); Codex returns
   * '\r' (plain CR; Codex CLI is Rust-based and does not need Ink's
   * workaround).
   *
   * Defensive fallback to '\x1b\r' (Claude's value) so the long-standing
   * behavior is preserved when the spec map is missing (e.g., boot race
   * condition or /api/providers unreachable on first paint).
   *
   * Instance method (not static) because it consults this._providerId
   * cached at mount time.
   *
   * @returns {string} The byte sequence to send for Shift+Enter.
   */
  _getShiftEnterSequence() {
    const specs = (typeof window !== 'undefined' && window.CWMProviderSpecs) || null;
    const spec = (specs && specs[this._providerId]) ||
      (specs && specs.claude) || // gsd:provider-literal-allowed (Phase 19 fallback)
      null;
    if (spec && typeof spec.shiftEnter === 'string') return spec.shiftEnter;
    // Defensive default: Claude's Ink-correct ESC+CR. Preserves pre-19-02
    // behavior when the spec map is unavailable.
    return '\x1b\r';
  }

  /**
   * Plan 19-02 (PTY-04): dispatch idle detection through a provider spec.
   *
   * Reads window.CWMProviderSpecs (built at boot by app.js fetchProviderSpecs)
   * and runs the active provider's idle regex array against the given line.
   * Defensive fallback: if the spec map is missing or the provider has no
   * idleRegexes, fall back to the original Claude regex pair so existing
   * Claude flows keep working even when /api/providers is unreachable or
   * provider-specs.js failed to load.
   *
   * Static so it can be exercised by test/idle-signal-dispatch.test.js
   * without constructing an xterm.js instance.
   *
   * @param {string} providerId - The pane's provider id from data-provider.
   * @param {string} lineText - The trimmed cursor-line text from the buffer.
   * @returns {boolean} True when the line looks like an idle prompt for the provider.
   */
  static _isIdleLineForProvider(providerId, lineText) {
    const specs = (typeof window !== 'undefined' && window.CWMProviderSpecs) || null;
    const spec = (specs && specs[providerId]) ||
      (specs && specs.claude) || // gsd:provider-literal-allowed (Phase 19 fallback to Claude spec)
      null;
    if (spec && Array.isArray(spec.idleRegexes)) {
      for (const re of spec.idleRegexes) {
        if (re && typeof re.test === 'function' && re.test(lineText)) return true;
      }
      return false;
    }
    // Spec map missing entirely: fall back to the original Claude regex pair
    // so panes created before the spec map loads (race condition) still get
    // idle detection. Mirror of src/providers/claude/index.js isIdleSignal.
    return /[❯$>]\s*$/.test(lineText) || /^(Human:|Type.*message)/.test(lineText);
  }

  /* ═══════════════════════════════════════════════════════════
     COPY / SELECT MODE  (mouse-mode copy fix, 2026-07-25)
     Claude Code's interactive TUI enables terminal mouse tracking,
     so xterm forwards a plain drag to the PTY instead of selecting
     text. Two copy paths are provided WITHOUT disabling the clickable
     TUI: (A) a per-pane Select-mode toggle that makes a plain drag act
     like a Shift+drag, and (B) the always-on Shift+drag fast path that
     xterm already honors (shouldForceSelection => event.shiftKey).
     ═══════════════════════════════════════════════════════════ */

  /**
   * Install a capture-phase mouse interceptor on this pane's container.
   *
   * The interceptor is a NO-OP unless this._selectMode is on. When on, it
   * takes each left-button mouse event, stops xterm's own listener from
   * seeing the raw event (stopImmediatePropagation), and re-dispatches a
   * clone with shiftKey forced true. xterm then treats the gesture as a
   * forced selection (CoreBrowserTerminal: `if (!areMouseEventsActive ||
   * shouldForceSelection(ev)) return;` skips the PTY send, and
   * SelectionService starts a real selection), so a plain drag selects text
   * even while the app has mouse tracking on.
   *
   * WHY the synthetic-shift approach instead of poking xterm internals: the
   * browser loads the MINIFIED vendor bundle (vendor/xterm/xterm.min.js), so
   * private fields like the selection/mouse services are name-mangled and
   * cannot be monkeypatched reliably. This path depends only on documented
   * DOM events and xterm's public Shift-to-select behavior, so it survives
   * bundle updates.
   *
   * Left-button selection: middle clicks and ordinary right clicks pass
   * through. The one exception is right-button mousedown over an existing
   * selection, which is withheld from xterm so the subsequent Workbook Copy
   * menu sees the same text. The clickable TUI remains reachable whenever
   * there is no selection and the toggle is off.
   */
  _installSelectModeInterceptor() {
    const container = this._getOwnedContainer();
    if (!container) return;
    // Idempotent: a remount into the same slot must not stack interceptors.
    if (this._selInterceptorContainer && this._selMouseHandler) {
      try {
        this._selInterceptorContainer.removeEventListener('mousedown', this._selMouseHandler, { capture: true });
        this._selInterceptorContainer.removeEventListener('mousemove', this._selMouseHandler, { capture: true });
        this._selInterceptorContainer.removeEventListener('mouseup', this._selMouseHandler, { capture: true });
      } catch (_) {}
    }
    this._selectDragging = false;
    const handler = (e) => {
      // Once text is selected, mouse-reporting TUIs must not see the hover
      // move that precedes a physical right-click, nor either right-button
      // edge. Full mouse mode reports even zero-button movement; Claude Code
      // can redraw on that hover and clear xterm's selection before the later
      // contextmenu event. Keep the selected buffer frozen through the whole
      // gesture, but do not preventDefault so contextmenu still opens.
      const selectedForCopy = this.getCopySelection().hasSelection;
      const selectedHover =
        e.type === 'mousemove' && !this._selectDragging &&
        (e.buttons === 0 || e.buttons === undefined);
      const selectedRightEdge =
        (e.type === 'mousedown' || e.type === 'mouseup') && e.button === 2;
      if (selectedForCopy && (selectedHover || selectedRightEdge)) {
        e.stopImmediatePropagation();
        return;
      }
      // OFF: do nothing, so the app receives normal mouse reporting and the
      // interactive TUI stays fully clickable.
      if (!this._selectMode) return;
      // Our own re-dispatched clone: let it reach xterm untouched.
      if (e.__cwmSelSynthetic) return;
      // v3 safety net: a drag that ended OUTSIDE the pane never delivered its
      // mouseup to this container listener (xterm tracks the rest of the drag
      // on document), so _selectDragging would stay armed and the hold would
      // outlive the gesture. The first buttonless move that comes back over
      // the terminal closes it. Unreachable while a selection exists, because
      // the selected-hover branch above returns first, which is correct: a
      // held selection must keep the pause.
      if (e.type === 'mousemove' && this._selectDragging &&
          (e.buttons === 0 || e.buttons === undefined)) {
        this._selectDragging = false;
        if (!this.getCopySelection().hasSelection) {
          this._releaseSelectHold('drag-ended-outside-pane');
        }
        return;
      }
      if (e.type === 'mousedown') {
        if (e.button !== 0) return;        // pass right/middle through
        this._selectDragging = true;
        // v3: the pause starts HERE, synchronously, before the clone below
        // reaches xterm and anchors the selection. A frame written between the
        // press and the anchor would slide the text out from under the
        // pointer, which is the exact failure v2 froze the whole session to
        // avoid. Freezing at drag start buys the same protection without
        // pausing a pane the user is only trying to scroll.
        this._engageSelectHold('drag-start');
      } else if (!this._selectDragging) {
        return;                            // only steer moves/ups of our own drag
      }
      if (e.type === 'mouseup') this._selectDragging = false;
      // Clone the event with shiftKey forced true. bubbles+cancelable so the
      // clone reaches xterm's element/document listeners and its preventDefault
      // works exactly as a genuine Shift+drag would.
      let clone;
      try {
        clone = new MouseEvent(e.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: (typeof window !== 'undefined' ? window : null),
          detail: e.detail,
          screenX: e.screenX,
          screenY: e.screenY,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          shiftKey: true,
          button: e.button,
          buttons: e.buttons,
          relatedTarget: e.relatedTarget || null,
        });
      } catch (_) {
        // If MouseEvent construction fails for any reason, fall back to letting
        // the raw event through rather than swallowing the gesture entirely.
        return;
      }
      clone.__cwmSelSynthetic = true;
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      (e.target || container).dispatchEvent(clone);
      // v3: xterm finalizes the selection inside the clone dispatch above, so
      // by this line the answer is settled. A click that selected nothing must
      // not leave the pane paused; that is the single most likely way a user
      // would end up stuck, since a stray click is not a gesture they would
      // think to undo.
      if (e.type === 'mouseup' && !this.getCopySelection().hasSelection) {
        this._releaseSelectHold('click-without-selection');
      }
    };
    this._selMouseHandler = handler;
    this._selInterceptorContainer = container;
    container.addEventListener('mousedown', handler, { capture: true });
    container.addEventListener('mousemove', handler, { capture: true });
    container.addEventListener('mouseup', handler, { capture: true });
  }

  /**
   * Enable or disable Select mode for this pane and refresh its UI.
   *
   * v2: this is also the freeze boundary. Turning the mode ON stops the write
   * pipeline (see _enqueueWrite) so the screen under the pointer stops moving;
   * turning it OFF drains everything that arrived in the meantime in a single
   * write and applies any resize that was deferred during the freeze. The
   * signature, the persistence call, and the return value are deliberately
   * unchanged from v1 so every existing caller and gate keeps working.
   *
   * @param {boolean} on - true to make plain drags select text.
   * @returns {boolean} The resulting mode.
   */
  setSelectMode(on) {
    const was = !!this._selectMode;
    this._selectMode = !!on;
    TerminalPane._saveSelectModePreference(this.sessionId, this._selectMode);
    if (this._selectMode) this._dismissCopyHint();
    this._updateSelectModeUI();
    if (!was && this._selectMode) {
      // v3: turning the mode ON freezes NOTHING. Output stays live so the user
      // can scroll to the part they want before they drag. The pause starts at
      // drag start (see _engageSelectHold).
      this._selectHold = false;
      this._selectFrozenAt = 0;
    } else if (was && !this._selectMode) {
      this._selectFrozenAt = 0;
      // Clear the hold BEFORE draining: _flushWriteBuffer consults
      // _isWriteFrozen, and a stale hold would make the drain a no-op.
      this._selectHold = false;
      this._unfreezeAndFlush();
    }
    return this._selectMode;
  }

  /* ═══════════════════════════════════════════════════════════
     SELECT MODE v2: FREEZE-WHILE-SELECTING
     xterm 6 anchors a selection to absolute buffer coordinates and
     clears it only on user input, scrollback trim, a row-count
     resize, or a buffer switch. A plain PTY write leaves the
     selection object intact but repaints the cells beneath it, so a
     full-screen TUI turns a valid selection into stale garbage
     within one frame. Freezing the write pipeline for the duration
     of the selection is what makes plain drag-to-copy trustworthy.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Whether the write pipeline is currently holding output back.
   *
   * Single source of truth for every gate (_enqueueWrite schedules nothing
   * while this is true, _flushWriteBuffer refuses to consume the queue,
   * setFocused schedules no catch-up frame, safeFit defers), so a future
   * freeze trigger only has to change this one predicate.
   *
   * The host check is not cosmetic. Fixed grid slots are shared across tab
   * groups, so detachHostBindings() can leave a pane live and streaming with
   * no visible chrome (see the cached-group path in app.js). Such a pane has
   * no selection to protect and no reachable toggle, so it must keep rendering
   * instead of silently filling the hold queue. Select mode itself stays on,
   * which is what lets the preference survive a pane move or group switch.
   *
   * The replay window is the second non-cosmetic guard. A freeze protects a
   * selection the user is making right now; it must never swallow the screen
   * the pane is being handed. Connect, socket open, and a server resync each
   * open the window, so a restored-ON pane still paints its scrollback.
   *
   * v3 ADDS THE HOLD, and it is the decisive term. v2 answered true for the
   * whole time the toggle was on, so switching Select mode on froze the pane
   * immediately: "when i toggle select, the window freezes and i cannot scroll
   * or drag up". Nothing about that pause was useful before a selection
   * existed. Now the answer is true only while a selection is actually being
   * made or held, which is the only window where an incoming repaint can turn
   * a valid selection into stale text.
   *
   * @returns {boolean} True while output is held for a selection.
   */
  _isWriteFrozen() {
    if (!this._selectMode || !this.paneEl) return false;
    // v3: the toggle alone pauses nothing. See _engageSelectHold.
    if (!this._selectHold) return false;
    if (this._freezeBlockedUntil && Date.now() < this._freezeBlockedUntil) return false;
    return true;
  }

  /**
   * Start holding output because a selection gesture just began.
   *
   * Called synchronously from the Select-mode mouse interceptor on the
   * mousedown that starts a drag, BEFORE the shift-forced clone is dispatched
   * to xterm. The ordering is the whole point: xterm anchors the selection to
   * absolute buffer coordinates during that clone, so any frame written
   * between the press and the anchor would move the text out from under the
   * user's own pointer.
   *
   * Refuses to engage when Select mode is off, so a stray call can never pause
   * an ordinary pane. Idempotent: a second mousedown inside one gesture keeps
   * the existing hold and its start timestamp.
   *
   * @param {string} [reason] - Diagnostic label for the log line.
   * @returns {boolean} True when this call started the hold.
   */
  _engageSelectHold(reason) {
    if (!this._selectMode || this._selectHold) return false;
    this._selectHold = true;
    this._selectFrozenAt = Date.now();
    this._updateSelectModeUI();
    if (reason) this._log('Select hold engaged (' + reason + ')');
    return true;
  }

  /**
   * Stop holding output and drain everything that arrived during the hold.
   *
   * The release paths are deliberately several, because a selection can end in
   * several ways and every one of them has to resume the stream:
   *   - a click that selected nothing (mouseup with no selection),
   *   - a drag that ended outside the pane and came back buttonless,
   *   - the selection being cleared by anything at all (onSelectionChange),
   *   - the mode being switched off, a resync, the overflow valve, dispose.
   *
   * Select mode itself is untouched here. Releasing the hold is not the user
   * changing their mind about the mode; it just means there is nothing left to
   * protect, so the pane goes back to being live and scrollable.
   *
   * @param {string} [reason] - Diagnostic label for the log line.
   * @returns {boolean} True when a hold was actually released.
   */
  _releaseSelectHold(reason) {
    if (!this._selectHold) return false;
    this._selectHold = false;
    this._selectFrozenAt = 0;
    this._updateSelectModeUI();
    // Drain AFTER the flag is cleared: the drain consults _isWriteFrozen.
    this._unfreezeAndFlush();
    if (reason) this._log('Select hold released (' + reason + ')');
    return true;
  }

  /**
   * React to xterm's selection changing while Select mode is on.
   *
   * xterm fires this on every drag update as well as on the final clear, so
   * two guards decide whether the gesture is really over:
   *   - a hold has to be active (nothing to release otherwise), and
   *   - no drag may be in progress, because an intermediate update during a
   *     drag can legitimately report an empty selection (the pointer is back
   *     at the anchor cell) and releasing there would resume output in the
   *     middle of the user's gesture.
   *
   * The pane-scoped selection helper is used rather than term.hasSelection so
   * a DOM-rendered selection inside the same pane also counts as "still
   * selected", matching what Ctrl+C and the Copy menu act on.
   *
   * @returns {boolean} True when this event ended the hold.
   */
  _onSelectionChanged() {
    if (!this._selectHold) return false;
    if (this._selectDragging) return false;
    try {
      if (this.getCopySelection().hasSelection) return false;
    } catch (_) {
      // A selection that cannot be read is treated as gone, which resumes
      // output. Erring toward live is the safe direction here.
    }
    return this._releaseSelectHold('selection-cleared');
  }

  /**
   * Resume the live stream: drain everything held during the freeze in one
   * write, then apply a resize that was deliberately skipped while frozen.
   *
   * Order matters. The held bytes were produced for the geometry the PTY had
   * while they were generated, so they are written FIRST and re-fitting
   * happens after; fitting first would render old-width frames into a new-width
   * grid and leave torn output on screen until the CLI repainted.
   */
  _unfreezeAndFlush() {
    if (this._writeBuf && this.term) {
      if (this._writeRaf) { cancelAnimationFrame(this._writeRaf); this._writeRaf = null; }
      if (this._bgFlushTimer) { clearTimeout(this._bgFlushTimer); this._bgFlushTimer = null; }
      this._flushWriteBuffer();
    }
    if (this._fitDeferredWhileFrozen) {
      this._fitDeferredWhileFrozen = false;
      this.safeFit();
    }
    // A geometry claim held back by the freeze runs now, after the drain and
    // the re-fit, so the claim carries this pane's current cols/rows.
    if (this._activatePending) {
      this._activatePending = false;
      this._requestActivate('unfreeze');
    }
  }

  /**
   * Drop the freeze for an incoming scrollback replay, DISCARDING whatever was
   * held rather than writing it.
   *
   * Used by the two resync paths (WebSocket reconnect and a server-initiated
   * reset), where a full replay is about to arrive and term.reset() is about
   * to clear the screen. Flushing there would write frames the replay is about
   * to duplicate, and holding would stall the replay behind a queue nothing is
   * going to drain. The held bytes themselves are dropped by the caller, which
   * clears the write buffer immediately after this returns; this method's job
   * is to make sure the freeze gate is open when the replay lands.
   *
   * Select mode itself is deliberately LEFT ON. The server sends a reset plus
   * a full replay on every attach, including the first one after a refresh, so
   * clearing the mode here would quietly undo the per-session preference that
   * v1 added and would make the toggle appear to reset itself on every
   * reconnect. Suspending the freeze for the replay window achieves the actual
   * requirement without touching the user's choice.
   *
   * Safe to call unconditionally and repeatedly.
   */
  _discardSelectModeHold() {
    // Reuse the replay window the idle notifier already trusts: it is defined
    // as "output arriving this soon after a (re)connect is replay, not new
    // work", which is exactly the output that must not be held.
    this._freezeBlockedUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;
    // v3: drop the hold itself as well, not just suspend it for the window.
    // term.reset() is about to clear the buffer, which destroys the selection
    // the hold was protecting, so there is nothing left to protect. Cleared
    // WITHOUT a flush on purpose: the caller empties the queue immediately
    // after this returns, because the replay re-sends all of it.
    this._selectHold = false;
    this._selectFrozenAt = 0;
    // A geometry claim deferred by the freeze is still wanted (the client that
    // was being looked at has not changed), but it must wait for the replay
    // that follows this resync. Queue it behind the quiet window instead of
    // dropping it: the caller opens that window immediately after this returns.
    if (this._activatePending) {
      this._activatePending = false;
      this._scheduleActivateRetry(ACTIVATE_CONNECT_GUARD_MS, 'post-resync');
    }
    if (!this._selectMode) return;
    // A fit deferred before the resync is stale: term.reset() is about to
    // repaint everything anyway, and the ResizeObserver will fit again if the
    // container really changed.
    this._fitDeferredWhileFrozen = false;
    this._updateSelectModeUI();
  }

  /**
   * Leave Select mode because the user is sending input to the session.
   * Called from every path that puts bytes on the wire (onData, both paste
   * listeners, Ctrl+V, Shift+Enter, sendCommand, pasteFromClipboard) BEFORE
   * the send, so held frames land first and the echo renders on top of a
   * current screen.
   * @returns {boolean} True when a freeze was actually lifted.
   */
  _exitSelectModeForInput() {
    if (!this._selectMode) return false;
    this.setSelectMode(false);
    return true;
  }

  /**
   * Whether a payload heading for the PTY consists ONLY of reports the
   * TERMINAL generated, with no user input mixed in.
   *
   * WHY THIS EXISTS (ship blocker, 2026-08-05). ConPTY enables DEC 1004 focus
   * reporting on every pane, so xterm emits \x1b[I when its hidden textarea
   * gains focus and \x1b[O when it loses it, through the same term.onData
   * channel that carries keystrokes. Select mode's contract is "typing resumes
   * live output", so the reproduction was brutal: the user clicks the header
   * toggle (the button takes focus), then presses the mouse down in the
   * terminal to drag. xterm refocuses its textarea, emits \x1b[I, onData treats
   * it as typing, the mode turns itself off and the freeze lifts on the exact
   * click that starts the selection. The same bytes also travel the wrapped
   * ws.send as an input frame, so both unfreeze funnels fired.
   *
   * SECOND REPORTER, SAME DEFECT (field bug, 2026-08-06). An interactive CLI
   * turns on mouse tracking 1000/1002/1003 with SGR encoding 1006. DECSET 1003
   * is ANY-EVENT tracking: moving the pointer across the terminal with no
   * button held emits \x1b[<35;col;rowM on this channel for every few pixels of
   * travel. The user's words were "as soon as I go and hover over the terminal
   * the select button stops being toggled on", and a measured sweep produced 81
   * such reports in one gesture. Mouse reports are therefore terminal-generated
   * too, and both encodings are accepted (SGR, plus the legacy X10 form for
   * completeness). They are still FORWARDED unchanged, because the CLI needs
   * them for its own clickable interface; only the unfreeze decision changes.
   *
   * WHY IT CANNOT SWALLOW REAL INPUT. Every accepted token begins with CSI
   * (ESC + '['), so a printable character, a control character (\r, \t, \x03,
   * \x7f), and every SS3 sequence (\x1bOA..\x1bOS, which is how xterm encodes
   * application-mode cursor and F1..F4 keys) are rejected immediately. Within
   * CSI, the accepted final bytes are I, O, R, c, M and m only: arrow keys end
   * in A..D, Home/End in H/F, the editing keys and bracketed paste in '~', and
   * modified arrows in A..D as well. The two mouse forms need a `<` or a bare
   * `M` immediately after the CSI, neither of which any key encoding produces.
   * The pattern is anchored at both ends and repeats whole tokens, so a chunk
   * that mixes a report with anything else fails and the caller unfreezes,
   * which is the fail-safe direction.
   *
   * KNOWN, DELIBERATE AMBIGUITY. xterm encodes F3 with a modifier as
   * \x1b[1;<mod>R, which is byte-identical to a cursor position report for row
   * 1. There is no way to tell them apart from the bytes alone, and dropping
   * CPR from the grammar would leave Select mode cancelling itself whenever a
   * CLI probes the cursor. The cost of the ambiguity is bounded: a modified F3
   * pressed while Select mode is on still reaches the session, it just does not
   * resume live output; any other key does.
   *
   * @param {*} data - Candidate payload (only strings can qualify).
   * @returns {boolean} True when the whole payload is terminal-generated.
   */
  static _isTerminalReportOnly(data) {
    if (typeof data !== 'string') return false;
    // Empty is not a report: "one or more" is part of the contract, and an
    // empty payload should never suppress an unfreeze.
    if (data.length === 0 || data.length > TERMINAL_REPORT_MAX_CHARS) return false;
    // Cheapest possible reject for ordinary typing: real keystrokes almost
    // never start with ESC, and this skips the regex entirely for them.
    if (data.charCodeAt(0) !== 0x1b) return false;
    return TERMINAL_REPORT_ONLY_RE.test(data);
  }

  /**
   * Whether a serialized WebSocket frame is an input frame whose payload is
   * nothing but terminal-generated reports.
   *
   * Used by the socket hook, which previously decided on a substring match
   * alone and therefore unfroze on the relayed focus report as well. Parsing is
   * confined to frames that already passed the cheap substring gate, so
   * geometry traffic still costs one indexOf.
   *
   * Conservative on every uncertainty: a frame that will not parse, a frame
   * whose parsed type is not 'input', and any thrown error all return false,
   * which means the caller unfreezes exactly as it did before this filter
   * existed. Only a positively identified report-only input frame is skipped.
   *
   * @param {*} payload - The exact value handed to ws.send.
   * @returns {boolean} True when the frame carries reports and nothing else.
   */
  static _isReportOnlyInputFrame(payload) {
    if (typeof payload !== 'string') return false;
    try {
      const msg = JSON.parse(payload);
      if (!msg || msg.type !== 'input') return false;
      return TerminalPane._isTerminalReportOnly(msg.data);
    } catch (_) {
      // Unparseable frame: fall back to the pre-filter behavior.
      return false;
    }
  }

  /**
   * Wrap a freshly created WebSocket so that ANY input frame this pane sends
   * leaves Select mode first, whichever layer built the frame.
   *
   * The pane's own send sites all call _exitSelectModeForInput explicitly, but
   * they are not the only ones: the app shell writes `{ type: 'input' }`
   * directly onto tp.ws in several places, most importantly the mobile toolbar
   * keys and the mobile type-and-send row. On a phone that is the PRIMARY way
   * to type, so without this hook a user who left Select mode on would tap
   * Send and watch a terminal that never answers, because the reply was
   * sitting in the hold queue.
   *
   * Substring matching comes FIRST rather than JSON.parse: every producer
   * builds the frame with JSON.stringify, whose output for this shape always
   * contains the exact token, and parsing every geometry frame would be pure
   * overhead. The Select-mode check comes before even that, so an unfrozen pane
   * pays one boolean. Idempotent (a re-wrap after a reconnect is a no-op on the
   * same socket) and exception-safe: a failure here must never swallow the
   * user's keystroke.
   *
   * FOCUS-REPORT GUARD (ship blocker, 2026-08-05): the substring gate alone was
   * not enough. xterm's DEC 1004 focus reports travel this socket as ordinary
   * input frames, so the relayed \x1b[I from the mousedown that starts a
   * selection unfroze the pane here even after onData learned to ignore it.
   * Frames that pass the substring gate are now parsed, and a frame whose data
   * is nothing but terminal-generated reports is sent without leaving Select
   * mode. Every other input frame behaves exactly as before, including frames
   * that fail to parse (see _isReportOnlyInputFrame, which is conservative on
   * every uncertainty).
   *
   * @param {WebSocket} ws - The socket to wrap.
   * @returns {WebSocket} The same socket, for call-site convenience.
   */
  _installInputUnfreezeHook(ws) {
    if (!ws || typeof ws.send !== 'function' || ws.__cwmInputUnfreeze) return ws;
    const originalSend = ws.send.bind(ws);
    ws.__cwmInputUnfreeze = true;
    ws.send = (payload) => {
      try {
        if (this._selectMode && typeof payload === 'string' &&
            payload.indexOf('"type":"input"') !== -1 &&
            !TerminalPane._isReportOnlyInputFrame(payload)) {
          // Unfreeze BEFORE the bytes go out, so held frames land first and
          // the echo renders on top of a current screen.
          this._exitSelectModeForInput();
        }
      } catch (_) {
        // A bookkeeping failure must not stop the send.
      }
      return originalSend(payload);
    };
    return ws;
  }

  /**
   * Overflow valve for the hold queue: leave Select mode, flush, and say why.
   *
   * Reached when a session produces more than SELECT_FREEZE_MAX_HOLD_CHARS
   * while frozen (a build log, a test run, a `cat` of something large). The
   * alternative, holding without limit, trades a stale selection for unbounded
   * memory growth and a multi-second stall at unfreeze, which is worse.
   */
  _overflowSelectFreeze() {
    this.setSelectMode(false);
    this._showSelectModeNotice('Live output resumed: too much new output to hold while selecting.');
  }

  /**
   * Install the capture-phase wheel guard for Select mode.
   *
   * Inert while the toggle is off, so normal panes keep xterm's own wheel
   * behavior (including its smooth scrolling). While on:
   *   - ALTERNATE buffer (a full-screen TUI): the wheel is swallowed. There is
   *     no scrollback in the alt buffer, so local scrolling is meaningless,
   *     and forwarding the wheel to the app would scroll ITS view and repaint
   *     every cell under the selection.
   *   - NORMAL buffer (a plain shell pane): the wheel is translated into a
   *     local viewport scroll. Scrollback genuinely exists there, so Select
   *     mode still allows scrolling to older output and drag-at-edge
   *     auto-extension keeps working.
   *
   * Capture phase on the pane's owned container is deliberate: it runs before
   * any listener xterm registered on its own element or viewport, which is the
   * only reliable way to preempt them without touching xterm internals (the
   * browser loads the minified vendor bundle, where they are name-mangled).
   * Registered non-passive so preventDefault is honored. Resolving the
   * container through _getOwnedContainer() keeps a cached pane from binding to
   * a slot that another session is currently rendering into.
   */
  _installSelectModeWheelGuard() {
    const container = this._getOwnedContainer();
    if (!container) return;
    // Idempotent across remounts into the same slot.
    this._removeSelectModeWheelGuard();
    const handler = (e) => {
      if (!this._selectMode) return;
      // Never steal wheel events that belong to the Copy view overlay; it is
      // an ordinary scrollable DOM element and scrolls natively.
      if (this._isInsideCopyView(e.target)) return;
      const holding = !!this._selectHold;
      const isAlt = !!(this.term && this.term.buffer && this.term.buffer.active &&
        this.term.buffer.active.type === 'alternate');
      // v3: with Select mode ON but NOTHING selected yet, the wheel is the user
      // positioning the content they are about to drag over. Under a
      // full-screen CLI the only thing that can scroll is the app's own
      // history, so the wheel is forwarded to it (xterm turns it into the
      // mouse report the app expects) and the repaint that follows is exactly
      // what was asked for. v2 swallowed this, which is why the pane felt
      // stuck: "i cannot scroll or drag up".
      if (!holding && isAlt) return;
      if (e.cancelable) e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      if (!this.term || !this.term.buffer || !this.term.buffer.active) return;
      // Holding a selection under a full-screen CLI: swallow. The alternate
      // buffer has no scrollback of its own, and forwarding would make the app
      // repaint every cell underneath the selection.
      if (isAlt) return;
      // Normal buffer, either state: local scrolling. This moves the viewport
      // without writing a single cell, so a held selection (anchored to
      // absolute buffer coordinates) survives it intact, and drag-at-edge
      // extension keeps working. That is why it stays available while holding.
      const lines = TerminalPane._wheelLinesFromEvent(e, this.term.rows);
      if (lines) {
        try { this.term.scrollLines(lines); } catch (_) {}
      }
    };
    this._selWheelHandler = handler;
    this._selWheelTarget = container;
    container.addEventListener('wheel', handler, { capture: true, passive: false });
  }

  /** Remove the capture-phase wheel guard, if one is installed. */
  _removeSelectModeWheelGuard() {
    if (this._selWheelTarget && this._selWheelHandler) {
      try {
        this._selWheelTarget.removeEventListener('wheel', this._selWheelHandler, { capture: true });
      } catch (_) {}
    }
    this._selWheelHandler = null;
    this._selWheelTarget = null;
  }

  /**
   * Convert a wheel event into a signed row count for term.scrollLines().
   *
   * Browsers report wheel deltas in three units (pixels, lines, pages) and the
   * pixel magnitude varies wildly by device and OS, so pixel-mode events are
   * normalized to a fixed number of rows per notch rather than trusted
   * verbatim. Positive means scroll toward newer output, matching both the
   * DOM convention and xterm's scrollLines sign.
   *
   * Static and side-effect free so it can be exercised without a terminal.
   *
   * @param {WheelEvent|object} ev - The wheel event (or a stub with deltaY).
   * @param {number} rows - Current viewport height, used for page-mode deltas.
   * @returns {number} Signed row count; 0 when there is nothing to scroll.
   */
  static _wheelLinesFromEvent(ev, rows) {
    const dy = (ev && typeof ev.deltaY === 'number') ? ev.deltaY : 0;
    if (!dy) return 0;
    const mode = (ev && typeof ev.deltaMode === 'number') ? ev.deltaMode : 0;
    if (mode === 1) { // DOM_DELTA_LINE
      return Math.round(dy) || (dy > 0 ? 1 : -1);
    }
    if (mode === 2) { // DOM_DELTA_PAGE
      const page = Math.max(1, rows || SELECT_FREEZE_WHEEL_LINES);
      return (Math.round(dy) || (dy > 0 ? 1 : -1)) * page;
    }
    return dy > 0 ? SELECT_FREEZE_WHEEL_LINES : -SELECT_FREEZE_WHEEL_LINES;
  }

  /** Flip Select mode. Returns the new state. */
  toggleSelectMode() {
    return this.setSelectMode(!this._selectMode);
  }

  /**
   * Hand keyboard focus back to the terminal after a Select-mode control took
   * it, so the pointer gesture that follows produces no focus transition.
   *
   * Routed through the pane's own focus() rather than term.focus() on purpose:
   * focus() already declines to steal focus from a mobile pane in scroll mode
   * (which would raise the software keyboard over the text the user is trying
   * to select) and already refuses a hidden or unowned container. Never throws;
   * a refocus that cannot happen is a small UX loss, not a failed toggle.
   *
   * @returns {boolean} True when focus was actually requested.
   */
  _refocusTerminalForSelect() {
    try {
      if (!this.term || typeof this.focus !== 'function') return false;
      this.focus();
      return true;
    } catch (_) {
      return false;
    }
  }

  // Name of the bubbling DOM event a pane fires whenever its Select mode or
  // Copy view state changes. Kept as a static so the pane, the app shell, and
  // the tests all spell it the same way exactly once.
  static SELECT_CHROME_EVENT = 'cwm:select-chrome';

  /**
   * Announce a Select mode / Copy view state change on the pane element.
   *
   * WHY (mobile parity, 2026-08-05): the pane header that carries both controls
   * is display:none at phone widths, so the app shell mirrors them onto the
   * mobile toolbar. That mirror has to stay honest when the state changes with
   * NO toolbar tap behind it: typing resumes live output, the hold-queue
   * overflow valve trips, Esc closes the overlay, a host rebind rebuilds the
   * chrome. A bubbling CustomEvent keeps the dependency one-way. The pane knows
   * nothing about the toolbar, and the shell wires exactly one delegated
   * listener instead of a hook per pane instance.
   *
   * Never throws: a missing host, a stubbed element, or an engine without
   * CustomEvent simply means nobody is listening.
   */
  _notifySelectChromeState() {
    try {
      const host = this.paneEl;
      if (!host || typeof host.dispatchEvent !== 'function') return;
      // typeof on an undeclared identifier is safe, which matters because the
      // source tests evaluate this file with no DOM globals at all.
      if (typeof CustomEvent !== 'function') return;
      host.dispatchEvent(new CustomEvent(TerminalPane.SELECT_CHROME_EVENT, {
        bubbles: true,
        detail: {
          sessionId: this.sessionId,
          selectMode: !!this._selectMode,
          copyViewOpen: !!this._copyOverlayOpen,
        },
      }));
    } catch (_) {
      // Advisory notification only; a failure must never break a toggle.
    }
  }

  /**
   * Build the Select-mode toggle button inside this pane's header and, on the
   * first pane ever mounted, a dismissable one-time hint about copying. All
   * visual state is set with inline styles that reference Catppuccin CSS
   * variables (with literal fallbacks) so the control renders correctly even
   * if a cached styles.css has not refreshed. Idempotent across remounts.
   */
  _injectCopyControls() {
    if (!this.paneEl) return;
    const header = this.paneEl.querySelector('.terminal-pane-header');
    if (!header) return;
    const existing = header.querySelector('.terminal-pane-selectmode');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'terminal-pane-selectmode btn btn-ghost btn-sm';
    btn.setAttribute('aria-pressed', 'false');
    btn.style.transition = 'color 160ms ease, background 160ms ease';
    // I-beam / text-selection glyph plus a short label. Focused mode shows the
    // label on the active pane (and whenever the mode is on) so the essential
    // copy affordance is discoverable without adding five repeated labels to a
    // dense grid.
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
      + '<path d="M5.5 2.5A.5.5 0 0 1 6 2h4a.5.5 0 0 1 0 1H8.5v10H10a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1h1.5V3H6a.5.5 0 0 1-.5-.5z"/>'
      + '<path d="M3.5 2h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 0-.5.5v1a.5.5 0 0 1-1 0v-1A1.5 1.5 0 0 1 3.5 2zm8 0A1.5 1.5 0 0 1 13 3.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 1 0-1h.5zM2.5 11a.5.5 0 0 1 .5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 1 0 1h-1A1.5 1.5 0 0 1 2 12.5v-1a.5.5 0 0 1 .5-.5zm11 0a.5.5 0 0 1 .5.5v1a1.5 1.5 0 0 1-1.5 1.5h-1a.5.5 0 0 1 0-1h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 1 .5-.5z"/></svg>'
      + '<span class="terminal-selectmode-label">Select</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const on = this.toggleSelectMode();
      // Turning OFF restores the clickable layer; refocus so typing resumes.
      if (!on && this.term) this.term.focus();
      // Turning ON refocuses too (ship blocker follow-up, 2026-08-05). Clicking
      // this button moves keyboard focus to the button, so the user's next
      // mousedown inside the terminal moves it back and, with DEC 1004 focus
      // reporting on, emits \x1b[I on the exact click that starts the drag.
      // _isTerminalReportOnly already stops that report from cancelling the
      // mode; handing focus back here means the transition never happens at
      // all, so the very first drag selects. Routed through the pane's own
      // focus() so a phone in scroll mode is not forced to raise its keyboard.
      if (on) this._refocusTerminalForSelect();
    });

    const closeBtn = header.querySelector('.terminal-pane-close');
    if (closeBtn) header.insertBefore(btn, closeBtn);
    else header.appendChild(btn);
    this._selectModeBtn = btn;

    // ── Copy view control (Select mode v2) ───────────────────────
    // Sits immediately after the Select toggle because the two answer the same
    // question at different scopes: Select mode copies what is on screen, Copy
    // view copies everything the pane has. Same button classes and sizing as
    // the sibling header icons (mic, expand, collapse, close).
    const existingCopyView = header.querySelector('.terminal-pane-copyview');
    if (existingCopyView) existingCopyView.remove();
    const cvBtn = document.createElement('button');
    cvBtn.type = 'button';
    cvBtn.className = 'terminal-pane-copyview btn btn-ghost btn-icon btn-sm';
    cvBtn.setAttribute('aria-pressed', 'false');
    // Icon-only button: give it an accessible name at creation as well as on
    // every state change, so it is never announced as an unnamed button even in
    // the window before _updateCopyViewUI runs.
    cvBtn.setAttribute('aria-label', 'Open Copy view');
    cvBtn.style.transition = 'color 160ms ease, background 160ms ease';
    // Document with lines glyph: "take the text out of this pane".
    cvBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
      + '<path d="M4 1.5A1.5 1.5 0 0 1 5.5 0h4.086a1.5 1.5 0 0 1 1.06.44l2.915 2.914A1.5 1.5 0 0 1 14 4.414V12.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4 12.5v-11zM5.5 1a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V5h-2.5A1.5 1.5 0 0 1 9 3.5V1H5.5zm4.5.207V3.5a.5.5 0 0 0 .5.5h2.293L10 1.207z"/>'
      + '<path d="M2 4.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 0 .5.5h7a.5.5 0 0 1 0 1H3A1.5 1.5 0 0 1 1.5 14V5a.5.5 0 0 1 .5-.5z"/>'
      + '<path d="M6.5 6h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1zm0 2.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1zm0 2.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1z"/></svg>';
    cvBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleCopyView();
    });
    if (closeBtn) header.insertBefore(cvBtn, closeBtn);
    else header.appendChild(cvBtn);
    this._copyViewBtn = cvBtn;

    this._maybeShowCopyHint();
    this._updateSelectModeUI();
    this._updateCopyViewUI();
  }

  /**
   * Reflect the current Select-mode state on the toggle button and show or
   * hide the "options paused" strip. Colors come from theme variables so the
   * active state matches whichever Catppuccin flavor is live.
   */
  _updateSelectModeUI() {
    const on = !!this._selectMode;
    if (this._selectModeBtn) {
      this._selectModeBtn.classList.toggle('active', on);
      this._selectModeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      this._selectModeBtn.setAttribute(
        'aria-label',
        on ? 'Turn off Select text mode' : 'Turn on Select text mode'
      );
      this._selectModeBtn.style.color = on ? 'var(--mauve, #cba6f7)' : '';
      this._selectModeBtn.style.background = on ? 'var(--surface1, rgba(203, 166, 247, 0.16))' : '';
      this._selectModeBtn.title = on
        ? 'Select mode ON: output is paused, drag selects text, Ctrl+C copies. Clickable options are paused. Click to turn off, or just type.'
        : 'Select / Copy mode: pause output and drag to select text. Tip: hold Shift and drag to select any time. Clickable options pause while this is on.';
    }
    if (on) this._showSelectModeStrip();
    else this._hideSelectModeStrip();
    if (this.paneEl) this.paneEl.classList.toggle('select-mode-on', on);
    // Mobile parity: the app shell mirrors this toggle onto the mobile toolbar,
    // and the mode can end without a toolbar tap (typing, the overflow valve).
    this._notifySelectChromeState();
  }

  // Default strip copy while Select mode is on. v3 rewording: the v2 text led
  // with "output paused", which was true the moment the toggle went on and was
  // exactly the behavior the user rejected. Now the pause is a property of the
  // drag, so the text leads with what is available (scrolling), then says when
  // output pauses, then names both ways back to live.
  // Kept as a static so the strip, the notice path, and tests share one string.
  static SELECT_STRIP_TEXT = 'Select mode: scroll freely. Drag to select and output pauses while you do. Ctrl+C copies. Click away or type to resume. Copy view captures the whole conversation.';

  /**
   * Show a compact non-blocking strip at the bottom of the pane while Select
   * mode is on, so the user knows the interactive layer is paused and how to
   * resume it. pointer-events:none so it never intercepts a selection drag.
   * Re-asserts the default text on every show so a transient notice
   * (see _showSelectModeNotice) can never stick.
   */
  _showSelectModeStrip() {
    if (!this.paneEl) return;
    if (this._selStrip) {
      this._selStrip.textContent = TerminalPane.SELECT_STRIP_TEXT;
      this._selStrip.hidden = false;
      this._selStrip.style.opacity = '1';
      // Re-measured on every show, never cached: the same pane is desktop one
      // moment and mobile-active the next, and the toolbar can appear, be
      // hidden with a pane, or grow a second row between two shows.
      this._applySelectStripPlacement();
      return;
    }
    const s = document.createElement('div');
    s.className = 'terminal-selectmode-strip';
    s.textContent = TerminalPane.SELECT_STRIP_TEXT;
    s.style.cssText = 'position:absolute;left:8px;right:8px;'
      + 'bottom:' + SELECT_STRIP_BASE_BOTTOM_PX + 'px;z-index:' + SELECT_STRIP_Z_INDEX + ';'
      // Notion restyle P1.2: the Plus Jakarta Sans webfont stopped loading when
      // index.html dropped its Google Fonts link, so this names the token
      // instead of a family that is no longer fetched. The literal fallback is
      // kept for the same reason every token here carries one: a stale cached
      // stylesheet must not leave this strip unstyled.
      + 'font:11px/1.4 var(--font-sans, ui-sans-serif);'
      + 'color:var(--text, #cdd6f4);background:var(--surface0, rgba(24, 24, 37, 0.94));'
      + 'border:1px solid var(--mauve, #cba6f7);border-radius:8px;padding:6px 10px;'
      + 'box-shadow:0 6px 18px rgba(0, 0, 0, 0.35);opacity:0;'
      + 'transition:opacity 160ms ease;pointer-events:none;';
    this.paneEl.appendChild(s);
    requestAnimationFrame(() => { if (this._selStrip) this._selStrip.style.opacity = '1'; });
    this._selStrip = s;
    this._applySelectStripPlacement();
  }

  /**
   * Measure how far above the bottom of the pane the Select-mode strip has to
   * sit so it never covers the mobile toolbar.
   *
   * On desktop the answer is the plain 8px inset: nothing else occupies the
   * bottom edge, and the floating action buttons are handled by z-order rather
   * than by moving the strip. On a mobile-active pane the toolbar (and the
   * type-and-send row when it is open) are the LAST flex children of the pane,
   * so the strip has to clear their combined height or it lands on top of them.
   * That was the reported defect: the strip is pointer-events:none, so the
   * toolbar under it stayed tappable but became invisible, which reads as the
   * toolbar having disappeared the moment Select mode turned on.
   *
   * Hidden chrome measures 0 (display:none and the hidden attribute both
   * collapse offsetHeight), so a pane with no toolbar shown naturally falls
   * back to the desktop inset. A mobile-active pane whose toolbar cannot be
   * measured yet uses a fallback sized for one row of buttons rather than
   * guessing zero, because guessing zero is the failure mode being fixed.
   *
   * @returns {number} Bottom inset in CSS pixels.
   */
  _selectStripBottomPx() {
    const pane = this.paneEl;
    if (!pane || !pane.classList || typeof pane.classList.contains !== 'function') {
      return SELECT_STRIP_BASE_BOTTOM_PX;
    }
    if (!pane.classList.contains('mobile-active')) return SELECT_STRIP_BASE_BOTTOM_PX;
    let chrome = 0;
    try {
      if (typeof pane.querySelector === 'function') {
        const toolbar = pane.querySelector('.terminal-mobile-toolbar');
        const inputRow = pane.querySelector('.terminal-mobile-input-row');
        if (toolbar && typeof toolbar.offsetHeight === 'number') chrome += toolbar.offsetHeight;
        if (inputRow && typeof inputRow.offsetHeight === 'number') chrome += inputRow.offsetHeight;
      }
    } catch (_) {
      chrome = 0;
    }
    if (!chrome) chrome = SELECT_STRIP_MOBILE_CHROME_FALLBACK_PX;
    return SELECT_STRIP_BASE_BOTTOM_PX + chrome;
  }

  /**
   * Apply the measured bottom inset (and re-assert the stacking order) on the
   * live strip element. Split out from _showSelectModeStrip so both the
   * first-show and the cached-show paths run exactly the same measurement.
   */
  _applySelectStripPlacement() {
    const strip = this._selStrip;
    if (!strip || !strip.style) return;
    try {
      strip.style.bottom = this._selectStripBottomPx() + 'px';
      strip.style.zIndex = String(SELECT_STRIP_Z_INDEX);
    } catch (_) {
      // Placement is cosmetic; a stubbed element must not break the toggle.
    }
  }

  /** Hide the Select-mode strip (kept in the DOM for cheap re-show). */
  _hideSelectModeStrip() {
    if (this._selStrip) {
      this._selStrip.style.opacity = '0';
      this._selStrip.hidden = true;
    }
  }

  /**
   * Flash a transient message in the Select-mode strip.
   *
   * Reuses the strip rather than introducing a second overlay so the message
   * appears exactly where the user was already told about Select mode, and so
   * it inherits pointer-events:none (a notice can never eat a click). The
   * strip is created on demand, which is what lets the overflow path speak up
   * even though it has just turned Select mode off.
   *
   * @param {string} text - Short sentence to display. No markup.
   * @param {number} [ms] - Visible duration; defaults to SELECT_NOTICE_MS.
   */
  _showSelectModeNotice(text, ms) {
    if (!this.paneEl) return;
    this._showSelectModeStrip();
    if (!this._selStrip) return;
    this._selStrip.textContent = text;
    if (this._selNoticeTimer) { clearTimeout(this._selNoticeTimer); this._selNoticeTimer = null; }
    this._selNoticeTimer = setTimeout(() => {
      this._selNoticeTimer = null;
      // Whichever state the pane is in by the time this fires is authoritative:
      // still selecting means restore the standing text, otherwise stand down.
      if (this._selectMode) this._showSelectModeStrip();
      else this._hideSelectModeStrip();
    }, typeof ms === 'number' ? ms : SELECT_NOTICE_MS);
  }

  /* ═══════════════════════════════════════════════════════════
     COPY VIEW OVERLAY
     Select mode makes the VISIBLE screen selectable, which still
     cannot answer "copy the whole conversation": an interactive CLI
     keeps its history inside the app, repaints a width-locked frame
     in the alternate buffer, and writes nothing to terminal
     scrollback. The Copy view is the honest answer to that. It
     renders a text SNAPSHOT of both buffers as ordinary DOM text, so
     native selection, Ctrl+A, long-press on touch, and the browser's
     own copy all work with no terminal semantics in the way.
     All styling is injected from here (no stylesheet edits) to keep
     the pane self-contained, matching how v1 injects its controls.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Read every line of an xterm buffer as plain text.
   *
   * Works on either buffer namespace member. For the normal buffer `length`
   * spans the scrollback plus the viewport; for the alternate buffer it is
   * exactly the viewport, which is what makes "everything plus the current
   * screen" expressible as two calls. Right-trimmed per line because a
   * terminal grid pads every row to the full width with spaces.
   *
   * Static and defensive: any line that cannot be read is treated as blank
   * rather than aborting the snapshot, since a partially readable transcript
   * is still far more useful than an error.
   *
   * @param {object} buf - An xterm IBuffer (active, normal or alternate).
   * @returns {string[]} One entry per row, in buffer order.
   */
  static _readBufferLines(buf) {
    const out = [];
    if (!buf || typeof buf.getLine !== 'function') return out;
    const len = typeof buf.length === 'number' ? buf.length : 0;
    for (let i = 0; i < len; i++) {
      let text = '';
      try {
        const line = buf.getLine(i);
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
   * Collapse padding runs and trailing blanks in composed snapshot text.
   *
   * A full-screen frame is mostly empty rows, and the normal buffer keeps the
   * blank remainder of the last screen before the app took over, so a raw
   * join is unreadable. Runs of COPY_VIEW_BLANK_RUN_LIMIT or more blank lines
   * collapse to one; shorter runs are preserved because one or two blank lines
   * are meaningful paragraph structure in real output. Leading and trailing
   * blank runs are dropped entirely.
   *
   * @param {string[]} lines - Raw lines in document order.
   * @returns {string[]} Cleaned lines.
   */
  static _collapseBlankRuns(lines) {
    const out = [];
    let run = 0;
    for (const raw of (Array.isArray(lines) ? lines : [])) {
      const line = typeof raw === 'string' ? raw : '';
      if (line.trim() === '') { run++; continue; }
      if (run > 0) {
        // Drop the run entirely at the very top of the document; otherwise
        // emit it, collapsed when it is longer than the limit.
        if (out.length > 0) {
          const keep = run >= COPY_VIEW_BLANK_RUN_LIMIT ? 1 : run;
          for (let i = 0; i < keep; i++) out.push('');
        }
        run = 0;
      }
      out.push(line);
    }
    // A trailing run is never emitted: it is padding, not content.
    return out;
  }

  /**
   * Compose the Copy view snapshot text from an xterm buffer namespace.
   *
   * When the alternate buffer is active (an interactive CLI is running) the
   * normal buffer is still readable and still holds everything printed before
   * the app took over, including shell scrollback. That transcript is emitted
   * first, then a divider, then the live frame, which is the closest thing to
   * "everything this pane has shown" that the terminal layer can offer. When
   * no app is running, the active buffer IS the normal buffer and one pass
   * over it (scrollback included) is the whole story.
   *
   * Takes the namespace as an argument instead of reading this.term so it can
   * be exercised against stub buffers with no xterm instance.
   *
   * @param {object} bufferApi - term.buffer (with active/normal members).
   * @returns {string} Newline-joined snapshot text; '' when nothing is readable.
   */
  _composeCopyViewText(bufferApi) {
    if (!bufferApi) return '';
    const active = bufferApi.active || null;
    const normal = bufferApi.normal || null;
    const isAlt = !!(active && active.type === 'alternate');
    let lines;
    if (isAlt) {
      lines = TerminalPane._readBufferLines(normal);
      // Only announce a divider when there is genuinely something above it. A
      // pane that launched straight into a full-screen app has an empty normal
      // buffer, and a lone divider at the top of the snapshot would be noise.
      if (lines.some((l) => l && l.trim() !== '')) lines.push(COPY_VIEW_DIVIDER);
      else lines = [];
      lines = lines.concat(TerminalPane._readBufferLines(active));
    } else {
      lines = TerminalPane._readBufferLines(active || normal);
    }
    return TerminalPane._collapseBlankRuns(lines).join('\n');
  }

  /**
   * Create the Copy view overlay once per pane and return it.
   *
   * Hosted on the pane element (not the terminal container) for two reasons:
   * the pane is the positioned ancestor, and the mobile touch engine's
   * capture-phase handlers live on the container, so an overlay outside it
   * scrolls natively on touch without fighting them. Styles are inline and
   * reference theme custom properties so the overlay follows the active
   * Catppuccin flavor with no stylesheet changes.
   *
   * @returns {HTMLElement|null} The overlay root, or null if there is no host.
   */
  _ensureCopyOverlay() {
    if (this._copyOverlay) return this._copyOverlay;
    if (typeof document === 'undefined') return null;
    const host = this.paneEl || this._getOwnedContainer();
    if (!host) return null;
    // Measured here for the first paint and RE-measured on every open by
    // _applyCopyOverlayMetrics, because the same pane can be desktop (header
    // visible) or phone-laid-out (header display:none) at different opens.
    const topPx = this._copyOverlayTopPx();

    const root = document.createElement('div');
    root.className = 'terminal-copyview';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Copy view');
    root.style.cssText = 'position:absolute;left:0;right:0;bottom:0;top:' + topPx + 'px;z-index:40;'
      + 'display:flex;flex-direction:column;overflow:hidden;'
      + 'background:var(--mantle, #181825);color:var(--text, #cdd6f4);'
      + 'border-top:1px solid var(--surface1, #45475a);';

    const bar = document.createElement('div');
    bar.className = 'terminal-copyview-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex:0 0 auto;'
      + 'padding:6px 8px 6px 12px;background:var(--surface0, #313244);'
      + 'border-bottom:1px solid var(--surface1, #45475a);'
      // Notion restyle P1.2: token rather than the retired webfont family.
      + 'font:600 12px/1.4 var(--font-sans, ui-sans-serif);';

    const title = document.createElement('span');
    title.className = 'terminal-copyview-title';
    title.textContent = 'Copy view';
    title.style.cssText = 'flex:0 0 auto;color:var(--text, #cdd6f4);';

    // ── Source switch: Terminal | Full transcript ────────────────
    // Two mutually exclusive buttons rather than a select element: it is two
    // options, it has to be a comfortable touch target, and a native select
    // popup on mobile would render outside the overlay and escape its
    // keydown containment.
    const sourceWrap = document.createElement('div');
    sourceWrap.className = 'terminal-copyview-sources';
    sourceWrap.setAttribute('role', 'group');
    sourceWrap.setAttribute('aria-label', 'Copy view source');
    sourceWrap.style.cssText = 'flex:1 1 auto;display:flex;align-items:center;gap:4px;';
    const mkSource = (source, label, hint) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'terminal-copyview-source';
      b.dataset.source = source;
      b.textContent = label;
      b.title = hint;
      b.setAttribute('aria-label', hint);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._setCopyViewSource(source);
      });
      return b;
    };
    const terminalSourceBtn = mkSource(
      COPY_VIEW_SOURCE_TERMINAL, 'Terminal',
      'Copy what this terminal has shown, including the current screen'
    );
    const transcriptSourceBtn = mkSource(
      COPY_VIEW_SOURCE_TRANSCRIPT, 'Full transcript',
      'Copy the whole conversation from the session transcript, not just what fit on screen'
    );
    sourceWrap.appendChild(terminalSourceBtn);
    sourceWrap.appendChild(transcriptSourceBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'terminal-copyview-copy btn btn-ghost btn-sm';
    copyBtn.textContent = 'Copy all';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'terminal-copyview-refresh btn btn-ghost btn-sm';
    refreshBtn.textContent = 'Refresh';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'terminal-copyview-close btn btn-ghost btn-icon btn-sm';
    closeBtn.setAttribute('aria-label', 'Close copy view');
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
      + '<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>';
    // Literal fallbacks alongside the tokens keep the buttons legible even if
    // a cached stylesheet has not picked up the btn classes yet.
    const btnCss = 'flex:0 0 auto;cursor:pointer;border-radius:6px;padding:3px 9px;'
      + 'border:1px solid var(--surface2, #585b70);background:var(--surface1, #45475a);'
      + 'color:var(--text, #cdd6f4);'
      + "font:600 11px/1.6 'Plus Jakarta Sans', system-ui, sans-serif;";
    copyBtn.style.cssText = btnCss;
    refreshBtn.style.cssText = btnCss;
    closeBtn.style.cssText = 'flex:0 0 auto;cursor:pointer;border-radius:6px;padding:2px 5px;'
      + 'border:1px solid transparent;background:none;color:var(--subtext0, #a6adc8);'
      + 'display:inline-flex;align-items:center;';

    const pre = document.createElement('pre');
    pre.className = 'terminal-copyview-text';
    pre.tabIndex = 0;
    pre.style.cssText = 'margin:0;flex:1 1 auto;overflow:auto;padding:10px 12px;'
      // Notion restyle P1.2: the Copy view snapshot is terminal text, so it
      // takes the terminal's mono token (--font-code, the native SFMono and
      // Consolas chain) rather than the retired JetBrains Mono webfont. Two
      // literal fallbacks follow it so the snapshot can never render
      // proportionally, which would silently misalign every column.
      + 'font:12px/1.5 var(--font-code, ui-monospace, monospace);'
      + 'white-space:pre-wrap;overflow-wrap:anywhere;'
      + 'user-select:text;-webkit-user-select:text;-webkit-overflow-scrolling:touch;'
      + 'background:var(--mantle, #181825);color:var(--text, #cdd6f4);outline:none;';

    // Sizing for the two source buttons: same literal-fallback approach as the
    // action buttons so they stay legible against a stale cached stylesheet.
    const sourceCss = 'flex:0 0 auto;cursor:pointer;border-radius:6px;padding:3px 9px;'
      + 'border:1px solid var(--surface2, #585b70);background:transparent;'
      + 'color:var(--subtext0, #a6adc8);'
      + "font:600 11px/1.6 'Plus Jakarta Sans', system-ui, sans-serif;";
    terminalSourceBtn.style.cssText = sourceCss;
    transcriptSourceBtn.style.cssText = sourceCss;

    // "Load earlier" pages backward through the transcript. Docked above the
    // text rather than in the bar because that is where the content it
    // prepends appears, matching the mirror pane.
    const loadEarlier = document.createElement('button');
    loadEarlier.type = 'button';
    loadEarlier.className = 'terminal-copyview-earlier';
    loadEarlier.textContent = 'Load earlier';
    loadEarlier.title = 'Fetch the previous page of this conversation';
    loadEarlier.setAttribute('aria-label', 'Load earlier conversation');
    loadEarlier.hidden = true;
    loadEarlier.style.cssText = 'flex:0 0 auto;display:none;width:100%;cursor:pointer;'
      + 'border:0;border-bottom:1px solid var(--surface1, #45475a);'
      + 'background:var(--surface0, #313244);color:var(--subtext0, #a6adc8);'
      + "font:600 11px/1.6 'Plus Jakarta Sans', system-ui, sans-serif;padding:6px 10px;";
    loadEarlier.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._loadEarlierTranscript();
    });

    // Inline notice: every failure mode of the transcript source reports here
    // instead of throwing away the overlay the user already had open.
    const notice = document.createElement('div');
    notice.className = 'terminal-copyview-notice';
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'flex:0 0 auto;display:none;padding:6px 12px;'
      + 'background:var(--surface0, #313244);color:var(--subtext0, #a6adc8);'
      + 'border-bottom:1px solid var(--surface1, #45475a);'
      + "font:11px/1.5 'Plus Jakarta Sans', system-ui, sans-serif;";

    bar.appendChild(title);
    bar.appendChild(sourceWrap);
    bar.appendChild(copyBtn);
    bar.appendChild(refreshBtn);
    bar.appendChild(closeBtn);
    root.appendChild(bar);
    root.appendChild(notice);
    root.appendChild(loadEarlier);
    root.appendChild(pre);

    copyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this._copyAllFromCopyView(); });
    refreshBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this._refreshCopyView(); });
    closeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this._closeCopyView(); });

    // Keep pane-level and app-level handlers out of the overlay: a click here
    // must not re-focus the terminal (which would steal the keyboard back from
    // the snapshot) and a keystroke here must not reach a global shortcut.
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    root.addEventListener('click', (e) => e.stopPropagation());
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this._closeCopyView(); return; }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'a' || e.key === 'A')) {
        // Scope select-all to the snapshot. Without this, Ctrl+A in a plain
        // focusable element selects the whole document in most engines.
        e.preventDefault();
        this._selectAllInCopyView();
      }
      // Ctrl+C is deliberately NOT handled: with a DOM selection present the
      // browser's own copy already does the right thing on every origin.
    };
    root.addEventListener('keydown', onKey);
    this._copyOverlayKeyHandler = onKey;

    host.appendChild(root);
    this._copyOverlay = root;
    this._copyOverlayPre = pre;
    this._copyOverlayBtns = { copy: copyBtn, refresh: refreshBtn, close: closeBtn };
    this._copyViewSourceBtns = { terminal: terminalSourceBtn, transcript: transcriptSourceBtn };
    this._copyViewLoadEarlierBtn = loadEarlier;
    this._copyViewNoticeEl = notice;
    this._updateCopyViewSourceUI();
    // Size the bar controls for the layout that exists right now. Re-applied on
    // every open so a rotation or a window resize between opens is honored.
    this._applyCopyOverlayMetrics();
    return root;
  }

  /**
   * Offset (px) from the top of the pane to the top of the Copy view overlay.
   *
   * Three distinct cases, and the middle one is the reported mobile defect:
   *   - Header measurable (desktop): sit exactly below it, so the pane title,
   *     the Select toggle and the close button all stay reachable.
   *   - Header present but measuring 0: styles-mobile.css sets display:none on
   *     the pane header at phone widths, so a hidden header occupies no space
   *     and the overlay must cover the pane FROM THE TOP. The old code fell
   *     through to the 34px desktop fallback here and left a live, still
   *     repainting band of terminal above the snapshot.
   *   - No header element at all (a detached or unusual host): keep the
   *     historical fallback, which assumes a header that will render later.
   *
   * @returns {number} Top inset in CSS pixels.
   */
  _copyOverlayTopPx() {
    const pane = this.paneEl;
    if (!pane || typeof pane.querySelector !== 'function') return COPY_VIEW_DEFAULT_TOP_PX;
    let header = null;
    try {
      header = pane.querySelector('.terminal-pane-header');
    } catch (_) {
      header = null;
    }
    if (!header) return COPY_VIEW_DEFAULT_TOP_PX;
    const measured = typeof header.offsetHeight === 'number' ? header.offsetHeight : null;
    if (measured === null) return COPY_VIEW_DEFAULT_TOP_PX;
    if (measured > 0) return measured;
    // A header that exists and measures zero is a HIDDEN header, not an
    // unmeasurable one: cover the pane from its very top.
    return 0;
  }

  /**
   * Whether this pane is laid out the way a phone lays it out.
   *
   * Two independent signals because either one alone is wrong somewhere: a real
   * touch device (coarse primary pointer plus touch points, the same test the
   * mobile scroll engine uses) always qualifies, and so does any viewport at or
   * below the 768px breakpoint every mobile CSS rule keys off, which covers a
   * narrow desktop window and a device-emulation session. Never throws.
   *
   * @returns {boolean} True when touch-sized controls are appropriate.
   */
  _isPhoneWidthLayout() {
    try {
      if (typeof this._isMobile === 'function' && this._isMobile()) return true;
      return typeof window !== 'undefined' &&
        typeof window.innerWidth === 'number' &&
        window.innerWidth > 0 &&
        window.innerWidth <= COPY_VIEW_TOUCH_MAX_WIDTH_PX;
    } catch (_) {
      return false;
    }
  }

  /**
   * Re-apply every Copy view measurement that depends on the CURRENT layout:
   * the top offset (see _copyOverlayTopPx) and the touch sizing of the bar
   * controls.
   *
   * Called from _ensureCopyOverlay for the first paint and from _openCopyView
   * on every open, because the overlay is created once per pane and then
   * reused: caching either value at creation time is what left a phone with a
   * band of live terminal above the snapshot and with 26px tall buttons.
   * Setting the minimums to '' rather than a number on desktop restores the
   * stylesheet's own sizing instead of pinning a stale pixel value.
   */
  _applyCopyOverlayMetrics() {
    if (!this._copyOverlay) return;
    try {
      if (this._copyOverlay.style) {
        this._copyOverlay.style.top = this._copyOverlayTopPx() + 'px';
      }
    } catch (_) {
      // Geometry is cosmetic; never let it stop the overlay from opening.
    }
    const btns = this._copyOverlayBtns;
    if (!btns) return;
    const touch = this._isPhoneWidthLayout();
    const size = touch ? COPY_VIEW_TOUCH_TARGET_PX + 'px' : '';
    // The source switch and the paging control are bar chrome too, so they
    // meet the same touch floor as the actions beside them.
    const sourceBtns = this._copyViewSourceBtns || {};
    for (const key of [COPY_VIEW_SOURCE_TERMINAL, COPY_VIEW_SOURCE_TRANSCRIPT]) {
      const btn = sourceBtns[key];
      if (!btn || !btn.style) continue;
      try {
        btn.style.minHeight = size;
        if (touch) {
          btn.style.display = 'inline-flex';
          btn.style.alignItems = 'center';
          btn.style.justifyContent = 'center';
        }
      } catch (_) { /* stubbed element in a test harness */ }
    }
    if (this._copyViewLoadEarlierBtn && this._copyViewLoadEarlierBtn.style) {
      try { this._copyViewLoadEarlierBtn.style.minHeight = size; } catch (_) {}
    }
    for (const key of ['copy', 'refresh', 'close']) {
      const btn = btns[key];
      if (!btn || !btn.style) continue;
      try {
        btn.style.minHeight = size;
        btn.style.minWidth = size;
        // Center the label inside the enlarged hit box rather than leaving it
        // top-aligned once the button is taller than its text.
        if (touch) {
          btn.style.display = 'inline-flex';
          btn.style.alignItems = 'center';
          btn.style.justifyContent = 'center';
        }
      } catch (_) {
        // A stubbed element in a test harness has no style object to write.
      }
    }
  }

  /**
   * Rebuild the snapshot from the live buffers and show it, scrolled to the
   * most recent content. Uses textContent, never innerHTML: terminal output is
   * untrusted text and must never be parsed as markup.
   *
   * v3: dispatches on the active source. The terminal source keeps the exact
   * behavior it always had; the transcript source re-fetches its newest page,
   * because Refresh means "get me the current state of whatever I am looking
   * at" in both cases.
   */
  _refreshCopyView() {
    if (!this._copyOverlayPre) return;
    if (this._copyViewSource === COPY_VIEW_SOURCE_TRANSCRIPT) {
      this._loadTranscriptSnapshot();
      return;
    }
    const text = (this.term && this.term.buffer) ? this._composeCopyViewText(this.term.buffer) : '';
    this._copyViewText = text;
    this._copyOverlayPre.textContent = text;
    this._scrollCopyViewToBottom();
  }

  /* ═══════════════════════════════════════════════════════════
     COPY VIEW: FULL TRANSCRIPT SOURCE
     Reads the session transcript through the existing read-only
     mirror API. Nothing here touches the running session: the
     mirror path only ever reads the artifact on disk, which is why
     it is safe on a session another window or machine is driving.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Resolve this pane's upstream identity for the mirror API.
   *
   * Both parts come from state the pane already holds, which is what keeps
   * this feature out of app.js entirely: the provider is the one resolved
   * from data-provider at mount, and the upstream session id is the
   * resumeSessionId the pane was opened with. A pane opened on an EXISTING
   * project session carries that id (the app passes the same value as both
   * the pane's session id and resumeSessionId), so the fallback to sessionId
   * covers the same case from the other direction.
   *
   * A brand new session started by Workbook has no upstream id until the CLI
   * writes its first transcript line, so this returns null there and the
   * caller shows a notice instead of guessing. Candidates are pre-validated
   * against the same shapes the server enforces, so a malformed id is caught
   * here rather than as a 400.
   *
   * @returns {{provider: string, providerSessionId: string}|null}
   */
  _copyViewIdentity() {
    const providerRe = /^[a-z][a-z0-9_-]{0,32}$/;
    const sessionRe = /^[a-zA-Z0-9_-]{1,256}$/;
    const provider = typeof this._providerId === 'string' ? this._providerId : '';
    if (!providerRe.test(provider)) return null;
    const opts = this.spawnOpts || {};
    const candidates = [opts.resumeSessionId, this.sessionId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && sessionRe.test(candidate)) {
        return { provider, providerSessionId: candidate };
      }
    }
    return null;
  }

  /**
   * Authenticated JSON request against the Workbook API.
   *
   * Uses the same bearer token the pane already reads from localStorage for
   * its WebSocket, so the Copy view needs no reference to the app shell and no
   * new auth surface. Errors are normalized into an Error carrying the
   * server's structured message when there is one, because the overlay reports
   * failures inline as text.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Absolute API path.
   * @param {object} [body] - JSON body for non-GET requests.
   * @returns {Promise<object>} Parsed JSON response.
   */
  async _copyViewApi(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    let token = null;
    try { token = localStorage.getItem('cwm_token'); } catch (_) { token = null; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = await res.json();
        detail = (parsed && (parsed.message || parsed.error)) || '';
      } catch (_) { detail = ''; }
      throw new Error(detail || ('Request failed (' + res.status + ')'));
    }
    if (res.status === 204) return {};
    return res.json();
  }

  /**
   * Per-pane device id for the mirror API.
   *
   * The mirror open call is keyed by (session, device) so two tabs can hold
   * independent subscriptions. The Copy view opens and immediately closes, so
   * this only has to be unique and well-shaped, never unguessable; auth still
   * rides on the bearer token. Derived from the pane's session id so a repeat
   * open from the same pane reuses one key instead of leaking subscriptions.
   *
   * @returns {string} A device id matching the server's shape.
   */
  _copyViewDeviceId() {
    const safe = String(this.sessionId || 'pane').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100);
    return 'copyview-' + safe;
  }

  /**
   * Fetch the newest page of the session transcript and render it.
   *
   * Opens the mirror to get a history window plus its offsets, then closes it
   * immediately: the Copy view is a snapshot, so holding a live subscription
   * (and its file watcher) would be a resource leak for no benefit. Refresh
   * repeats exactly this call, which is what makes it mean "show me the
   * current end of the conversation".
   *
   * Never throws into a click handler; every failure ends as an inline notice
   * with the Terminal source still one tap away.
   *
   * @returns {Promise<boolean>} True when messages were rendered.
   */
  async _loadTranscriptSnapshot() {
    if (this._copyViewLoading) return false;
    const identity = this._copyViewIdentity();
    if (!identity) {
      this._copyViewMessages = [];
      this._copyViewStartOffset = null;
      this._copyViewTruncatedHead = false;
      this._renderTranscriptIntoOverlay();
      this._showCopyViewNotice(
        'This pane has no session transcript yet. Start or resume a session, or use the Terminal source.'
      );
      return false;
    }
    this._copyViewLoading = true;
    this._showCopyViewNotice('Loading conversation...');
    this._updateCopyViewSourceUI();
    let opened = null;
    try {
      opened = await this._copyViewApi('POST', '/api/mirror/open', {
        provider: identity.provider,
        providerSessionId: identity.providerSessionId,
        deviceId: this._copyViewDeviceId(),
      });
    } catch (err) {
      this._copyViewLoading = false;
      this._showCopyViewNotice(
        'Could not read the session transcript: ' + ((err && err.message) || 'unknown error')
      );
      this._updateCopyViewSourceUI();
      return false;
    }
    // Release the subscription immediately: this is a snapshot, not a live
    // view. Fire and forget, because the server's idle sweep is the safety net
    // and a failed close must never surface as a Copy view error.
    try {
      const mirrorKey = opened && opened.mirrorKey;
      if (mirrorKey) {
        const p = this._copyViewApi('POST', '/api/mirror/close', {
          mirrorKey,
          deviceId: this._copyViewDeviceId(),
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) { /* courtesy call only */ }

    const history = Array.isArray(opened && opened.history) ? opened.history : [];
    this._copyViewMessages = history;
    this._copyViewStartOffset =
      typeof opened.startOffset === 'number' ? opened.startOffset : null;
    this._copyViewTruncatedHead = !!(opened && opened.truncatedHead);
    this._copyViewLoading = false;
    this._renderTranscriptIntoOverlay();
    if (history.length === 0) {
      this._showCopyViewNotice('This session has no transcript entries yet.');
    } else {
      this._hideCopyViewNotice();
    }
    this._updateCopyViewSourceUI();
    return history.length > 0;
  }

  /**
   * Page one window further back through the transcript and PREPEND it.
   *
   * beforeOffset is the byte offset of the oldest line currently loaded, so
   * each call walks backward through the file without re-reading what is
   * already on screen. The control disappears once the server stops reporting
   * a truncated head, which is how "exhausted" is expressed.
   *
   * @returns {Promise<boolean>} True when earlier messages were prepended.
   */
  async _loadEarlierTranscript() {
    if (this._copyViewLoading) return false;
    if (this._copyViewSource !== COPY_VIEW_SOURCE_TRANSCRIPT) return false;
    const identity = this._copyViewIdentity();
    if (!identity || typeof this._copyViewStartOffset !== 'number' ||
        this._copyViewStartOffset <= 0) {
      return false;
    }
    this._copyViewLoading = true;
    this._updateCopyViewSourceUI();
    let page = null;
    try {
      page = await this._copyViewApi('GET', '/api/mirror/history'
        + '?provider=' + encodeURIComponent(identity.provider)
        + '&providerSessionId=' + encodeURIComponent(identity.providerSessionId)
        + '&beforeOffset=' + encodeURIComponent(String(this._copyViewStartOffset))
        + '&maxBytes=' + encodeURIComponent(String(COPY_VIEW_TRANSCRIPT_PAGE_BYTES)));
    } catch (err) {
      this._copyViewLoading = false;
      this._showCopyViewNotice(
        'Could not load earlier messages: ' + ((err && err.message) || 'unknown error')
      );
      this._updateCopyViewSourceUI();
      return false;
    }
    const earlier = Array.isArray(page && page.messages) ? page.messages : [];
    if (earlier.length > 0) {
      this._copyViewMessages = earlier.concat(this._copyViewMessages);
    }
    if (typeof page.startOffset === 'number') this._copyViewStartOffset = page.startOffset;
    this._copyViewTruncatedHead = !!(page && page.truncatedHead);
    this._copyViewLoading = false;
    // Re-render in place and keep the reader where they were: prepending
    // content would otherwise yank the viewport to the top.
    const pre = this._copyOverlayPre;
    const beforeHeight = pre ? pre.scrollHeight : 0;
    const beforeTop = pre ? pre.scrollTop : 0;
    this._renderTranscriptIntoOverlay({ preserveScroll: true });
    if (pre) {
      try { pre.scrollTop = beforeTop + (pre.scrollHeight - beforeHeight); } catch (_) {}
    }
    if (earlier.length === 0) this._showCopyViewNotice('No earlier messages.');
    else this._hideCopyViewNotice();
    this._updateCopyViewSourceUI();
    return earlier.length > 0;
  }

  /**
   * Render the loaded transcript messages as plain text into the overlay and
   * make that text what Copy all copies.
   *
   * @param {object} [opts] - { preserveScroll } to leave the viewport alone.
   * @returns {string} The rendered text.
   */
  _renderTranscriptIntoOverlay(opts) {
    const text = TerminalPane._renderTranscriptText(this._copyViewMessages);
    this._copyViewText = text;
    if (this._copyOverlayPre) this._copyOverlayPre.textContent = text;
    if (!(opts && opts.preserveScroll)) this._scrollCopyViewToBottom();
    return text;
  }

  /**
   * Turn mirror messages into readable plain text.
   *
   * Shape follows the mirror pane's rendering so the two surfaces describe the
   * same conversation the same way, translated from DOM into text:
   *   - each turn is labelled with its role, so a pasted conversation still
   *     reads as a dialogue rather than a wall of text,
   *   - tool events collapse to ONE line each ("[tool: Read] first line..."),
   *     because a copied conversation wants the thread of what happened, not
   *     the payloads,
   *   - a server-truncated message is marked, so a reader is never silently
   *     given a partial quote.
   *
   * Static and pure: no DOM, no instance state, so it is directly testable
   * against a stubbed payload.
   *
   * @param {Array} messages - Mirror messages, oldest first.
   * @returns {string} Newline-joined transcript text.
   */
  static _renderTranscriptText(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const text = typeof m.text === 'string' ? m.text : '';
      const truncatedTag = m.truncated ? ' [truncated]' : '';
      if (m.kind === 'tool_use' || m.kind === 'tool_result') {
        const label = m.kind === 'tool_use'
          ? ('tool: ' + (m.toolName ? String(m.toolName) : 'unknown'))
          : 'tool result';
        const firstLine = text.split('\n')[0].slice(0, COPY_VIEW_TRANSCRIPT_TOOL_CHARS);
        out.push('[' + label + ']' + (firstLine ? ' ' + firstLine : '') + truncatedTag);
        continue;
      }
      const role = typeof m.role === 'string' && m.role ? m.role : 'assistant';
      const label = role.charAt(0).toUpperCase() + role.slice(1);
      const model = (role === 'assistant' && m.model) ? ' (' + String(m.model) + ')' : '';
      out.push(label + model + ':');
      out.push(text + truncatedTag);
      out.push('');
    }
    // Drop a trailing blank separator so the snapshot does not end in padding.
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  /**
   * Switch the Copy view between its sources.
   *
   * Terminal renders synchronously from the live buffers. Transcript loads on
   * first selection and then reuses what it has, so flipping back and forth
   * does not re-fetch; Refresh is the explicit way to get newer content.
   *
   * @param {string} source - COPY_VIEW_SOURCE_TERMINAL or _TRANSCRIPT.
   * @returns {boolean} True when the source changed.
   */
  _setCopyViewSource(source) {
    const next = source === COPY_VIEW_SOURCE_TRANSCRIPT
      ? COPY_VIEW_SOURCE_TRANSCRIPT
      : COPY_VIEW_SOURCE_TERMINAL;
    const changed = next !== this._copyViewSource;
    this._copyViewSource = next;
    this._updateCopyViewSourceUI();
    if (next === COPY_VIEW_SOURCE_TERMINAL) {
      this._hideCopyViewNotice();
      const text = (this.term && this.term.buffer) ? this._composeCopyViewText(this.term.buffer) : '';
      this._copyViewText = text;
      if (this._copyOverlayPre) this._copyOverlayPre.textContent = text;
      this._scrollCopyViewToBottom();
      return changed;
    }
    if (this._copyViewMessages.length > 0) {
      this._renderTranscriptIntoOverlay();
      return changed;
    }
    const p = this._loadTranscriptSnapshot();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return changed;
  }

  /** Reflect source selection, loading state and paging availability. */
  _updateCopyViewSourceUI() {
    const btns = this._copyViewSourceBtns;
    if (btns) {
      for (const key of [COPY_VIEW_SOURCE_TERMINAL, COPY_VIEW_SOURCE_TRANSCRIPT]) {
        const btn = btns[key];
        if (!btn) continue;
        const on = this._copyViewSource === key;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('active', on);
        btn.style.background = on ? 'var(--surface1, #45475a)' : 'transparent';
        btn.style.color = on ? 'var(--text, #cdd6f4)' : 'var(--subtext0, #a6adc8)';
        btn.style.borderColor = on ? 'var(--mauve, #cba6f7)' : 'var(--surface2, #585b70)';
      }
    }
    const earlier = this._copyViewLoadEarlierBtn;
    if (earlier) {
      const canPage = this._copyViewSource === COPY_VIEW_SOURCE_TRANSCRIPT &&
        this._copyViewTruncatedHead &&
        typeof this._copyViewStartOffset === 'number' && this._copyViewStartOffset > 0;
      earlier.hidden = !canPage;
      earlier.style.display = canPage ? 'block' : 'none';
      earlier.disabled = !!this._copyViewLoading;
      earlier.textContent = this._copyViewLoading ? 'Loading...' : 'Load earlier';
    }
  }

  /**
   * Show a short inline notice inside the overlay.
   * @param {string} text - Plain text, never markup.
   */
  _showCopyViewNotice(text) {
    const el = this._copyViewNoticeEl;
    if (!el) return;
    el.textContent = String(text || '');
    el.hidden = false;
    el.style.display = 'block';
  }

  /** Hide the inline notice. */
  _hideCopyViewNotice() {
    const el = this._copyViewNoticeEl;
    if (!el) return;
    el.hidden = true;
    el.style.display = 'none';
  }

  /**
   * Pin the snapshot to its end (newest output), the way a terminal sits at
   * the bottom of its scrollback. Deferred a frame so the layout that follows
   * a textContent swap has happened before scrollHeight is read.
   */
  _scrollCopyViewToBottom() {
    const pre = this._copyOverlayPre;
    if (!pre) return;
    const pin = () => { try { pre.scrollTop = pre.scrollHeight; } catch (_) {} };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pin);
    else pin();
  }

  /** Select the entire snapshot, and nothing outside it, as a DOM selection. */
  _selectAllInCopyView() {
    try {
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      const pre = this._copyOverlayPre;
      if (!pre || typeof document.createRange !== 'function') return;
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {
      // A selection failure is cosmetic; the user can still drag-select.
    }
  }

  /**
   * Copy the whole snapshot through the universal clipboard helper (which
   * works on insecure origins too, the documented LAN access mode) and report
   * the outcome on the button for a moment. Never throws.
   */
  _copyAllFromCopyView() {
    const btn = this._copyOverlayBtns ? this._copyOverlayBtns.copy : null;
    const done = (ok) => {
      if (!btn) return;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      if (this._copyFeedbackTimer) clearTimeout(this._copyFeedbackTimer);
      this._copyFeedbackTimer = setTimeout(() => {
        this._copyFeedbackTimer = null;
        if (this._copyOverlayBtns && this._copyOverlayBtns.copy) {
          this._copyOverlayBtns.copy.textContent = 'Copy all';
        }
      }, COPY_VIEW_FEEDBACK_MS);
    };
    try {
      const p = TerminalPane.copyTextToClipboard(this._copyViewText || '');
      if (p && typeof p.then === 'function') p.then(done, () => done(false));
      else done(true);
    } catch (_) {
      done(false);
    }
  }

  /**
   * Open the Copy view. Deliberately does NOT freeze the terminal: the overlay
   * is a snapshot taken at open time, so the session underneath can keep
   * streaming. Opening it while Select mode is on is allowed and leaves that
   * freeze exactly as it was.
   * @returns {boolean} True when the overlay is open.
   */
  _openCopyView() {
    const root = this._ensureCopyOverlay();
    if (!root) return false;
    root.hidden = false;
    root.style.display = 'flex';
    // Re-measure BEFORE the snapshot is composed and shown: the overlay is
    // created once and reused, so a pane that was opened on a desktop layout
    // and is now phone-laid-out (hidden header, touch targets) has to be
    // re-fitted here or it keeps the geometry of its first ever open.
    this._applyCopyOverlayMetrics();
    this._copyOverlayOpen = true;
    this._refreshCopyView();
    if (this._copyOverlayPre && typeof this._copyOverlayPre.focus === 'function') {
      try { this._copyOverlayPre.focus({ preventScroll: true }); } catch (_) {}
    }
    this._updateCopyViewUI();
    return true;
  }

  /** Close the Copy view and hand focus back to the terminal. */
  _closeCopyView() {
    if (this._copyOverlay) {
      this._copyOverlay.style.display = 'none';
      this._copyOverlay.hidden = true;
    }
    this._copyOverlayOpen = false;
    this._updateCopyViewUI();
    // focus() already declines to steal focus on a mobile pane in scroll mode.
    this.focus();
  }

  /**
   * Toggle the Copy view. Public so the app layer (context menu, keyboard
   * shortcut) can reach the same entry point the header button uses.
   * @returns {boolean} True when the overlay ends up open.
   */
  toggleCopyView() {
    if (this._copyOverlayOpen) { this._closeCopyView(); return false; }
    return this._openCopyView();
  }

  /**
   * Whether an event target sits inside this pane's Copy view overlay.
   *
   * Used by the mobile touch engine and the Select-mode wheel guard, whose
   * capture-phase handlers live on the pane container and would otherwise
   * translate a scroll gesture inside the overlay into terminal scrolling.
   * Normally the overlay is hosted OUTSIDE that container (on the pane
   * element), so this only matters in the fallback host case, but the check is
   * cheap and makes both paths correct regardless of where the overlay landed.
   *
   * @param {EventTarget} target - The event target to test.
   * @returns {boolean} True when the target is within the open overlay.
   */
  _isInsideCopyView(target) {
    return !!(this._copyOverlayOpen && this._copyOverlay && target &&
      typeof this._copyOverlay.contains === 'function' && this._copyOverlay.contains(target));
  }

  /** Reflect Copy view open/closed state on its header button. */
  _updateCopyViewUI() {
    // Announced BEFORE the header-button guard below: the mobile toolbar mirror
    // has to learn about an Esc-close even on a pane whose header button was
    // never built (a detached host), and the listener reads pane state directly.
    this._notifySelectChromeState();
    if (!this._copyViewBtn) return;
    const on = !!this._copyOverlayOpen;
    this._copyViewBtn.classList.toggle('active', on);
    this._copyViewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // aria-label as well as title: the button is icon-only, so a screen reader
    // otherwise announces it as an unnamed button on engines that do not fall
    // back to title. The label names the ACTION, the title explains it.
    this._copyViewBtn.setAttribute('aria-label', on ? 'Close Copy view' : 'Open Copy view');
    this._copyViewBtn.style.color = on ? 'var(--mauve, #cba6f7)' : '';
    this._copyViewBtn.style.background = on ? 'var(--surface1, rgba(203, 166, 247, 0.16))' : '';
    this._copyViewBtn.title = on
      ? 'Copy view open: select and copy any part of the transcript. Esc closes.'
      : 'Copy view: snapshot the whole transcript as plain text you can select and copy.';
  }

  /** Remove the Copy view overlay and its timers from the DOM. */
  _destroyCopyView() {
    if (this._copyFeedbackTimer) { clearTimeout(this._copyFeedbackTimer); this._copyFeedbackTimer = null; }
    if (this._copyOverlay) {
      if (this._copyOverlayKeyHandler) {
        try { this._copyOverlay.removeEventListener('keydown', this._copyOverlayKeyHandler); } catch (_) {}
      }
      try { this._copyOverlay.remove(); } catch (_) {}
    }
    this._copyOverlay = null;
    this._copyOverlayPre = null;
    this._copyOverlayBtns = null;
    this._copyOverlayKeyHandler = null;
    this._copyOverlayOpen = false;
    this._copyViewText = '';
    // Full transcript state dies with the overlay: a rebuilt overlay in a new
    // host must not inherit another visit's page cursor or its messages, and
    // the element references would be dangling.
    this._copyViewSource = COPY_VIEW_SOURCE_TERMINAL;
    this._copyViewMessages = [];
    this._copyViewStartOffset = null;
    this._copyViewTruncatedHead = false;
    this._copyViewLoading = false;
    this._copyViewSourceBtns = null;
    this._copyViewLoadEarlierBtn = null;
    this._copyViewNoticeEl = null;
  }

  /**
   * Show a one-time, dismissable hint explaining the two copy paths. Gated by
   * a localStorage flag so it appears once and never nags. Auto-dismisses
   * after a short window; the × button or enabling Select mode also dismisses.
   */
  _maybeShowCopyHint() {
    try {
      if (localStorage.getItem('cwm_copyhint_v1')) return;
    } catch (_) { return; }
    if (!this.paneEl || this._copyHint || this._copyHintShown) return;
    const h = document.createElement('div');
    h.className = 'terminal-copy-hint';
    h.style.cssText = 'position:absolute;top:36px;right:8px;z-index:30;max-width:248px;'
      + "font:11px/1.45 'Plus Jakarta Sans', system-ui, sans-serif;"
      + 'color:var(--text, #cdd6f4);background:var(--surface0, rgba(24, 24, 37, 0.97));'
      + 'border:1px solid var(--surface2, #585b70);border-radius:10px;'
      + 'padding:9px 22px 9px 11px;box-shadow:0 8px 24px rgba(0, 0, 0, 0.42);'
      + 'opacity:0;transition:opacity 180ms ease;';
    // Names all THREE copy paths: the always-available Shift+drag, the Select
    // mode toggle, and the Copy view snapshot. Copy view was missing here even
    // though it is the only path that reaches scrollback a full-screen CLI
    // never wrote to the terminal, which is the case users hit first.
    h.innerHTML = 'Claude Code captures the mouse. Hold <b>Shift</b> and drag to select, '
      + 'then <b>Ctrl+C</b> to copy, or turn on <b>Select mode</b> (this button) and '
      + 'drag normally. Scrolling keeps working; output only pauses while you drag. '
      + '<b>Copy view</b> (next to it) snapshots the whole conversation as plain text.'
      + '<button class="terminal-copy-hint-x" aria-label="Dismiss" '
      + 'style="position:absolute;top:3px;right:5px;background:none;border:none;'
      + 'color:inherit;cursor:pointer;font-size:15px;line-height:1;padding:2px;opacity:0.7;">&times;</button>';
    this.paneEl.appendChild(h);
    requestAnimationFrame(() => { if (this._copyHint) this._copyHint.style.opacity = '1'; });
    const x = h.querySelector('.terminal-copy-hint-x');
    if (x) x.addEventListener('click', (e) => { e.stopPropagation(); this._dismissCopyHint(); });
    this._copyHint = h;
    this._copyHintShown = true;
    // "One-time" means once shown, not once its 14-second timer eventually
    // completes. Persist immediately so a swap, group-cache rebind, reload, or
    // crash cannot resurrect the same onboarding card.
    try { localStorage.setItem('cwm_copyhint_v1', '1'); } catch (_) {}
    this._copyHintTimer = setTimeout(() => this._dismissCopyHint(), 14000);
  }

  /** Dismiss the one-time copy hint and remember it so it never returns. */
  _dismissCopyHint() {
    try { localStorage.setItem('cwm_copyhint_v1', '1'); } catch (_) {}
    if (this._copyHintTimer) { clearTimeout(this._copyHintTimer); this._copyHintTimer = null; }
    if (this._copyHint) {
      const el = this._copyHint;
      this._copyHint = null;
      el.style.opacity = '0';
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 220);
    }
  }

  dispose() {
    this._disposed = true;
    this._mountGeneration++;
    if (this._mountRafOuter) cancelAnimationFrame(this._mountRafOuter);
    if (this._mountRafInner) cancelAnimationFrame(this._mountRafInner);
    clearTimeout(this._mountRefitTimer);
    this._mountRafOuter = null;
    this._mountRafInner = null;
    this._mountRefitTimer = null;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this._fitTimer);
    clearTimeout(this._idleCheckTimer);
    clearTimeout(this._activityDebounceTimer);
    clearTimeout(this._bgFlushTimer);
    clearTimeout(this._needsInputTimer);
    clearTimeout(this._pasteHandledResetTimer);
    this._pasteHandledResetTimer = null;
    this._pasteHandled = false;
    if (this._writeRaf) cancelAnimationFrame(this._writeRaf);
    this._writeBuf = '';
    this._activitySample = '';
    // Release every fixed-slot listener/control before disposing the live
    // terminal. This is the same ownership boundary used by pane moves and
    // tab-group caching, so teardown cannot drift from rebind behavior.
    // Select mode v2 rides along: detachHostBindings() removes the capture
    // phase wheel guard, the Copy view overlay with its key handler, and the
    // Copy view header button.
    this.detachHostBindings();
    // Issue #68: tear down the PTY-unavailable banner overlay so a reused grid
    // slot does not inherit a stale overlay from this disposed pane.
    this._removePtyUnavailableBanner();
    // Select mode v2: a disposed pane must not stay frozen. The in-memory flag
    // is cleared without touching the stored preference on purpose, because
    // closing a pane is not the user changing their mind: reopening the same
    // session restores Select mode exactly as the v1 persistence intends.
    this._selectMode = false;
    this._selectFrozenAt = 0;
    // v3: the hold and the drag flag die with the pane too, so a disposed pane
    // can never be re-mounted into a paused state.
    this._selectHold = false;
    this._selectDragging = false;
    this._fitDeferredWhileFrozen = false;
    if (this._selSelectionDisposable) {
      try { this._selSelectionDisposable.dispose(); } catch (_) {}
      this._selSelectionDisposable = null;
    }
    if (this._selNoticeTimer) { clearTimeout(this._selNoticeTimer); this._selNoticeTimer = null; }
    this._removeSelectModeWheelGuard();
    // Width claim teardown: disconnect the observer and the focus listener and
    // cancel a queued retry, so a disposed pane can never claim geometry for a
    // session it no longer displays.
    this._removeVisibilityActivate();
    this._destroyCopyView();
    // P5.2: a disposed pane must not leave its paste question on screen, and
    // the answer would have nowhere to go anyway once the socket is closed.
    this._dismissPasteConfirm();
    if (this._copyViewBtn) { try { this._copyViewBtn.remove(); } catch (_) {} this._copyViewBtn = null; }
    if (this.ws) { this.ws.onmessage = null; this.ws.onclose = null; this.ws.close(); }
    if (this.term && this.term.element &&
        this.term.element.__cwmTerminalPane === this) {
      try { delete this.term.element.__cwmTerminalPane; } catch (_) {}
    }
    if (this.term) this.term.dispose();
    this.term = null;
    this.ws = null;
  }
}

if (typeof window !== 'undefined') window.TerminalPane = TerminalPane;

/* ═══════════════════════════════════════════════════════════════════
   TERMINAL SURFACE PUBLICATION
   Notion restyle P5.4 and P5.5.

   The `--term-*` custom properties are what let the pane chrome (the
   terminal surface padding, the input row, its top rule and the prompt
   glyph) paint the SAME values xterm paints. They have to be correct
   in three situations, and no single trigger covers all three:

     at load          so the first paint after a reload is right;
     on getCurrentTheme()  which app.js already calls per live pane on
                      every theme change, so no app.js edit is needed;
     on a data-theme change with NO pane open, which neither of the
                      other two can see.

   The observer is the third. It is installed once, at module scope,
   guarded on every global it touches, because this file is evaluated
   in DOM-less vm sandboxes by four test suites and a throw here would
   take the whole class with it.
   ═══════════════════════════════════════════════════════════════════ */
(function installTerminalSurfaceSync() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  try {
    TerminalPane.publishTerminalSurfaceVars();
  } catch (_) { /* the projection is optional by construction */ }
  if (typeof MutationObserver !== 'function') return;
  try {
    const observer = new MutationObserver(() => {
      try {
        TerminalPane.publishTerminalSurfaceVars();
      } catch (_) { /* never throw out of an observer callback */ }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  } catch (_) { /* an environment without observers keeps the load-time value */ }
}());
