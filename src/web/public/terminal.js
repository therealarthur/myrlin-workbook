/**
 * TerminalPane - xterm.js terminal connected via WebSocket to server-side PTY
 * Performance-critical: raw binary I/O, no JSON wrapping for terminal data
 */

// Smooth-scroll animation duration in ms for wheel and Shift+PageUp/Down
// scrolling (issue #41). xterm 6.0.0 animates scrollLines over this window;
// kept short because each intermediate row step refreshes the DOM renderer.
const SMOOTH_SCROLL_DURATION_MS = 120;

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

  static getCurrentTheme() {
    const t = document.documentElement.dataset.theme;
    switch (t) {
      case 'latte': return TerminalPane.THEME_LATTE;
      case 'frappe': return TerminalPane.THEME_FRAPPE;
      case 'macchiato': return TerminalPane.THEME_MACCHIATO;
      case 'cherry': return TerminalPane.THEME_CHERRY;
      case 'ocean': return TerminalPane.THEME_OCEAN;
      case 'amber': return TerminalPane.THEME_AMBER;
      case 'mint': return TerminalPane.THEME_MINT;
      default: return TerminalPane.THEME_MOCHA;
    }
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
   * Feature-detects the writeText FUNCTION, not just the clipboard object:
   * some engines expose a navigator.clipboard object without writeText, and
   * calling through a mere object check would reintroduce the throw.
   *
   * Contract: NEVER throws and the returned promise NEVER rejects, under any
   * circumstance, so callers inside key and click handlers stay
   * exception-safe.
   *
   * @param {string} text - Text to place on the clipboard ('' when nullish).
   * @returns {Promise<boolean>} Resolves true when the copy succeeded, false
   *   when every available path failed. Never rejects.
   */
  static copyTextToClipboard(text) {
    const value = (text === null || text === undefined) ? '' : String(text);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function') {
        // Secure context: async Clipboard API. Map BOTH outcomes so the
        // promise can never reject. On rejection (Safari and some mobile
        // browsers deny programmatic writes even on https) attempt the
        // execCommand fallback before giving up; by the time the rejection
        // lands the user gesture may have expired, in which case execCommand
        // simply reports false, so trying is harmless.
        return navigator.clipboard.writeText(value).then(
          () => true,
          () => {
            try { return TerminalPane._copyViaExecCommand(value); } catch (_) { return false; }
          }
        );
      }
      // Insecure origin (or clipboard API absent): synchronous fallback.
      return Promise.resolve(TerminalPane._copyViaExecCommand(value));
    } catch (_) {
      // Belt and braces: nothing above should throw, but the whole point of
      // this helper is that callers NEVER see an exception. A throw escaping
      // a key handler is exactly the bug that sent SIGINT to running CLIs.
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
   * @returns {boolean} True when execCommand reported success. Never throws.
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
    let ok = false;
    try {
      document.body.appendChild(ta);
      if (typeof ta.focus === 'function') ta.focus({ preventScroll: true });
      if (typeof ta.select === 'function') ta.select();
      // iOS Safari ignores select() on some versions; the explicit range
      // makes the selection real there too.
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, value.length);
      ok = !!document.execCommand('copy');
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
  // Matches CSI escape sequences. Same pattern _detectActivity and
  // _analyzeForAutoTrust already use for ANSI stripping; hoisted to a named
  // constant so the re-arm gate shares it. Only used with .replace (safe
  // for a /g regex; lastIndex is not carried across replace calls).
  static ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

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
    // Copy-mode root cause (user report, 2026-07-25): Claude Code's interactive
    // TUI turns on terminal mouse tracking (DECSET 1000/1002/1003 + SGR 1006).
    // While that is active, xterm forwards a plain drag/wheel to the PTY instead
    // of making a text selection, so plain-drag never selects and Ctrl+C finds
    // no selection. xterm's documented escape hatch is Shift (shouldForceSelection
    // returns event.shiftKey on non-Mac), so Shift+drag always selects. This flag
    // powers an opt-in per-pane "Select mode" that makes a PLAIN drag behave like
    // a Shift+drag, so the user can copy without the interactive layer being
    // disabled globally. OFF by default so clickable TUI options keep working.
    this._selectMode = false;
    // References to the injected copy-mode DOM + the capture-phase mouse
    // interceptor, so dispose() can tear everything down cleanly.
    this._selectModeBtn = null;
    this._selStrip = null;
    this._copyHint = null;
    this._copyHintTimer = null;
    this._selMouseHandler = null;
    this._selInterceptorContainer = null;
    this._selectDragging = false;
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
    // Plan 19-02 (PTY-04, PTY-05): per-pane provider context. Both fields are
    // populated in mount() after the pane DOM exists. _providerId drives idle
    // detection and Shift+Enter dispatch; defaults to the back-compat provider
    // id (see line below) if data-provider is missing for any reason (e.g., a
    // pane created before Phase 18-01).
    this.paneEl = null;
    this._providerId = 'claude'; // gsd:provider-literal-allowed (Phase 19 default before mount)
  }

  _log(msg) {
    console.log('[Terminal]', msg);
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

  mount() {
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
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        lineHeight: 1.2,
        scrollback: 5000,
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
      this._injectCopyControls();

      // IMPORTANT: Fit BEFORE connecting WebSocket so we know the real
      // terminal dimensions. The PTY spawns at whatever cols/rows we pass
      // in the WS URL - if we connect before fit, the PTY starts at
      // hardcoded 120x30, outputs formatted for 120 cols, then gets
      // resized to the actual (smaller) dimensions. That mismatch garbles
      // the display and forces users to type "reset".
      //
      // Double-rAF ensures the grid layout is fully calculated before fit.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            this.fitAddon.fit();
            this._log('Fitted: ' + this.term.cols + 'x' + this.term.rows);
          } catch (e) {
            this._log('fit() failed: ' + e.message);
          }

          // NOW connect with correct dimensions
          this._log('Calling connect()...');
          this.connect();

          // Safety refit after 200ms - catches edge cases where the grid
          // is still settling (e.g., CSS transitions, slow layout).
          // Deduplicated: only notifies the server when dims really changed,
          // so the common already-settled case sends nothing.
          setTimeout(() => {
            if (this.fitAddon) {
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

        // Ctrl+C / Cmd+C: copy selected text to clipboard (if selection exists)
        // Without selection, fall through so xterm sends \x03 (SIGINT) normally.
        //
        // WHY the try/catch bracket and the helper (user report, 2026-07-24):
        // this branch used to call the async Clipboard API directly with a
        // chained .catch(). On insecure origins (plain http to a LAN IP or
        // hostname, the documented remote-access mode) navigator.clipboard is
        // undefined, so the PROPERTY ACCESS threw a synchronous TypeError
        // that .catch() could not see (.catch only intercepts promise
        // rejections, not a throw during property lookup). The exception
        // escaped this handler BEFORE clearSelection() and `return false`
        // ran, xterm treated the key as unhandled, and the "copy" keystroke
        // sent \x03 (SIGINT) that interrupted the user's running CLI
        // session. Same secure-context trap as paste issue #64, which was
        // fixed on the Ctrl+V branch below but never applied here.
        //
        // TerminalPane.copyTextToClipboard never throws by contract (and
        // actually copies on every origin via its execCommand fallback), but
        // the bracket below makes the SIGINT fall-through STRUCTURALLY
        // impossible even if a future edit regresses that guarantee: once a
        // selection exists this branch always reaches `return false` and
        // consumes the key. Do not lift the copy call out of the try.
        if (mod && e.key === 'c' && this.term.hasSelection()) {
          try {
            // Fire-and-forget: the copy is best-effort (matches the old
            // silent-catch behavior); consuming the key is mandatory.
            TerminalPane.copyTextToClipboard(this.term.getSelection());
            this.term.clearSelection();
          } catch (_) {
            // Swallow everything. An exception escaping past this point is
            // what used to SIGINT the CLI mid-run.
          }
          return false;
        }

        // Ctrl+V / Cmd+V: paste from clipboard. Two arms depending on whether
        // the async Clipboard API is present, which is a secure-context check.
        //
        // Secure context (localhost or https): navigator.clipboard.readText
        // exists. We call preventDefault() to cancel the browser's native paste
        // so the beforeinput(insertFromPaste)/paste handlers below do NOT also
        // fire, then read the clipboard explicitly and send once. This preserves
        // the PR #45 (commit cee137a) fix that stopped a double-send on
        // localhost, where both the native paste and the explicit read would
        // otherwise send the text through the WebSocket twice.
        //
        // Insecure context (http over LAN, the documented remote-access mode):
        // navigator.clipboard is undefined, so pasteFromClipboard() cannot run.
        // Here we must NOT preventDefault. Returning false only tells xterm to
        // skip the key; the browser still performs its native paste, which the
        // beforeinput/paste handlers below bracket and send exactly once (deduped
        // via _pasteHandled). A double-send is impossible in this arm because the
        // clipboard-API path never executes here.
        //
        // Regression context: issue #64 (paste silently dead for every
        // non-localhost user) was caused by PR #45 always calling
        // preventDefault, which cancelled the native paste while the only other
        // path (navigator.clipboard) does not exist on insecure origins. Do NOT
        // collapse these two arms back into an unconditional preventDefault:
        // that reintroduces #64.
        if (mod && e.key === 'v') {
          if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
            e.preventDefault();
            this.pasteFromClipboard();
          }
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
          // Set _pasteHandled flag so the paste event handler doesn't double-send.
          if (e.inputType === 'insertFromPaste') {
            e.preventDefault();
            this._pasteHandled = true;
            const text = e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
            if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
              const bracketedText = '\x1b[200~' + text + '\x1b[201~';
              this.ws.send(JSON.stringify({ type: 'input', data: bracketedText }));
            }
            return;
          }

          if (e.inputType === 'insertReplacementText') {
            e.preventDefault();
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
          e.stopPropagation();
          if (this._pasteHandled) {
            this._pasteHandled = false;
            return;
          }
          const text = (e.clipboardData || window.clipboardData || '').getData('text');
          if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
            const bracketedText = '\x1b[200~' + text + '\x1b[201~';
            this.ws.send(JSON.stringify({ type: 'input', data: bracketedText }));
          }
        }, { capture: true });
      }

      this.term.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

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

    // Close any stale WebSocket before creating a new one
    if (this.ws) {
      try { this.ws.onmessage = null; this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch (_) {}
      this.ws = null;
    }

    // On reconnect, cancel any pending write operations THEN reset the terminal.
    // Without draining the write pipeline first, a stale rAF/timer could flush
    // old data into the terminal AFTER reset(), causing duplicate content.
    if (isReconnect && this.term) {
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
    const container = document.getElementById(this.containerId);
    const paneEl = container ? container.closest('.terminal-pane') : null;
    if (paneEl) paneEl.classList.add('terminal-pane-loading');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this._log('WebSocket constructor threw: ' + err.message);
      this._status('WebSocket failed: ' + err.message, 'red');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');
      return;
    }

    this.ws.onopen = () => {
      // Remove loading animation
      const paneEl = document.getElementById(this.containerId)?.closest('.terminal-pane');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');

      this.connected = true;
      this._reconnectAttempts = 0;
      // Mute idle notifications during the scrollback replay burst the
      // server sends right after (re)connect. Without this window, every
      // pane sitting at a prompt fires "ready for input" ~2s after a tab
      // switch or page load replays its buffer (notification-storm bug).
      this._suppressIdleUntil = Date.now() + TerminalPane.REPLAY_SUPPRESS_MS;
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
            if (this._writeRaf) { cancelAnimationFrame(this._writeRaf); this._writeRaf = null; }
            if (this._bgFlushTimer) { clearTimeout(this._bgFlushTimer); this._bgFlushTimer = null; }
            this._writeBuf = '';
            this._activitySample = '';
            if (this.term) this.term.reset();
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
      const paneEl = document.getElementById(this.containerId)?.closest('.terminal-pane');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');

      this.connected = false;
      this._log('WebSocket CLOSED code=' + event.code + ' reason=' + (event.reason || 'none'));

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
    this.term.focus();
    // Also explicitly focus the hidden textarea - xterm.js's focus()
    // sometimes doesn't propagate in multi-instance setups
    const container = document.getElementById(this.containerId);
    if (container) {
      const textarea = container.querySelector('.xterm-helper-textarea');
      if (textarea) textarea.focus({ preventScroll: true });
    }
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
   * @returns {Promise<boolean>} true when text was read and sent; false when
   *   the clipboard API is unavailable or the read was denied/failed.
   */
  async pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      this._emitPasteUnavailable('insecure-context');
      return false;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const bracketedText = '\x1b[200~' + text + '\x1b[201~';
        this.ws.send(JSON.stringify({ type: 'input', data: bracketedText }));
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
      const container = document.getElementById(this.containerId);
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
    // Bail when this pane's terminal element is detached from the document,
    // e.g. cached inside a DocumentFragment during a tab-group switch. The
    // ResizeObserver watches the slot container by id, so a DIFFERENT
    // session mounted into the same slot in another tab group can otherwise
    // fire this cached pane's observer; the container rect check below would
    // pass (the container is visible, just hosting someone else) and a fit
    // against the detached element would send bogus dims to this pane's PTY.
    if (!this.term.element || !this.term.element.isConnected) return;
    const container = document.getElementById(this.containerId);
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'activate' })); } catch (_) {}
    }
    this.safeFit();
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

    const container = document.getElementById(this.containerId);
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
      if (!this._mobileTypeMode && !this._mobileSelecting) e.stopPropagation();
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

      // If we were selecting, revert after a delay for xterm.js to process
      if (this._mobileSelecting) {
        // Long-press converted this gesture into selection; no momentum will
        // run, so this is also a gesture-end path (issue #41).
        restoreSmoothScroll();
        setTimeout(() => this._disableMobileSelection(), 300);
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
      const container = document.getElementById(this.containerId);
      if (container) {
        container.dispatchEvent(new CustomEvent('terminal-activity', {
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
          const el = document.getElementById(this.containerId);
          if (el) el.dispatchEvent(new CustomEvent('terminal-needs-input', { bubbles: true, detail: { sessionId: this.sessionId, needsInput: false } }));
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
      const idleContainer = document.getElementById(this.containerId);
      if (idleContainer) {
        idleContainer.dispatchEvent(new CustomEvent('terminal-activity', {
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
      const container = document.getElementById(this.containerId);
      if (container) {
        container.dispatchEvent(new CustomEvent('terminal-idle', {
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
        const el = document.getElementById(this.containerId);
        if (el) {
          el.dispatchEvent(new CustomEvent('terminal-needs-input', {
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
        const el = document.getElementById(this.containerId);
        if (el) {
          el.dispatchEvent(new CustomEvent('terminal-needs-input', {
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
   * Left-button only: right/middle clicks pass through untouched so the
   * right-click context menu (and its Copy item) still works, and so the
   * clickable TUI is reachable the instant the toggle goes back off.
   */
  _installSelectModeInterceptor() {
    const container = document.getElementById(this.containerId);
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
      // OFF: do nothing, so the app receives normal mouse reporting and the
      // interactive TUI stays fully clickable.
      if (!this._selectMode) return;
      // Our own re-dispatched clone: let it reach xterm untouched.
      if (e.__cwmSelSynthetic) return;
      if (e.type === 'mousedown') {
        if (e.button !== 0) return;        // pass right/middle through
        this._selectDragging = true;
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
    };
    this._selMouseHandler = handler;
    this._selInterceptorContainer = container;
    container.addEventListener('mousedown', handler, { capture: true });
    container.addEventListener('mousemove', handler, { capture: true });
    container.addEventListener('mouseup', handler, { capture: true });
  }

  /**
   * Enable or disable Select mode for this pane and refresh its UI.
   * @param {boolean} on - true to make plain drags select text.
   * @returns {boolean} The resulting mode.
   */
  setSelectMode(on) {
    this._selectMode = !!on;
    if (this._selectMode) this._dismissCopyHint();
    this._updateSelectModeUI();
    return this._selectMode;
  }

  /** Flip Select mode. Returns the new state. */
  toggleSelectMode() {
    return this.setSelectMode(!this._selectMode);
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
    btn.className = 'terminal-pane-selectmode btn btn-ghost btn-icon btn-sm';
    btn.setAttribute('aria-pressed', 'false');
    btn.style.transition = 'color 160ms ease, background 160ms ease';
    // I-beam / text-selection glyph, sized to match the sibling header icons.
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
      + '<path d="M5.5 2.5A.5.5 0 0 1 6 2h4a.5.5 0 0 1 0 1H8.5v10H10a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1h1.5V3H6a.5.5 0 0 1-.5-.5z"/>'
      + '<path d="M3.5 2h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 0-.5.5v1a.5.5 0 0 1-1 0v-1A1.5 1.5 0 0 1 3.5 2zm8 0A1.5 1.5 0 0 1 13 3.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 1 0-1h.5zM2.5 11a.5.5 0 0 1 .5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 1 0 1h-1A1.5 1.5 0 0 1 2 12.5v-1a.5.5 0 0 1 .5-.5zm11 0a.5.5 0 0 1 .5.5v1a1.5 1.5 0 0 1-1.5 1.5h-1a.5.5 0 0 1 0-1h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 1 .5-.5z"/></svg>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const on = this.toggleSelectMode();
      // Turning OFF restores the clickable layer; refocus so typing resumes.
      if (!on && this.term) this.term.focus();
    });

    const closeBtn = header.querySelector('.terminal-pane-close');
    if (closeBtn) header.insertBefore(btn, closeBtn);
    else header.appendChild(btn);
    this._selectModeBtn = btn;

    this._maybeShowCopyHint();
    this._updateSelectModeUI();
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
      this._selectModeBtn.style.color = on ? 'var(--mauve, #cba6f7)' : '';
      this._selectModeBtn.style.background = on ? 'var(--surface1, rgba(203, 166, 247, 0.16))' : '';
      this._selectModeBtn.title = on
        ? 'Select mode ON: drag selects text, Ctrl+C copies. Clickable options are paused. Click to turn off.'
        : 'Select / Copy mode: drag to select text. Tip: hold Shift and drag to select any time. Clickable options pause while this is on.';
    }
    if (on) this._showSelectModeStrip();
    else this._hideSelectModeStrip();
    if (this.paneEl) this.paneEl.classList.toggle('select-mode-on', on);
  }

  /**
   * Show a compact non-blocking strip at the bottom of the pane while Select
   * mode is on, so the user knows the interactive layer is paused and how to
   * resume it. pointer-events:none so it never intercepts a selection drag.
   */
  _showSelectModeStrip() {
    if (!this.paneEl) return;
    if (this._selStrip) { this._selStrip.hidden = false; this._selStrip.style.opacity = '1'; return; }
    const s = document.createElement('div');
    s.className = 'terminal-selectmode-strip';
    s.textContent = 'Select mode: drag to select, Ctrl+C to copy. Clickable options paused, toggle off to resume.';
    s.style.cssText = 'position:absolute;left:8px;right:8px;bottom:8px;z-index:20;'
      + "font:11px/1.4 'Plus Jakarta Sans', system-ui, sans-serif;"
      + 'color:var(--text, #cdd6f4);background:var(--surface0, rgba(24, 24, 37, 0.94));'
      + 'border:1px solid var(--mauve, #cba6f7);border-radius:8px;padding:6px 10px;'
      + 'box-shadow:0 6px 18px rgba(0, 0, 0, 0.35);opacity:0;'
      + 'transition:opacity 160ms ease;pointer-events:none;';
    this.paneEl.appendChild(s);
    requestAnimationFrame(() => { if (this._selStrip) this._selStrip.style.opacity = '1'; });
    this._selStrip = s;
  }

  /** Hide the Select-mode strip (kept in the DOM for cheap re-show). */
  _hideSelectModeStrip() {
    if (this._selStrip) {
      this._selStrip.style.opacity = '0';
      this._selStrip.hidden = true;
    }
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
    if (!this.paneEl || this._copyHint) return;
    const h = document.createElement('div');
    h.className = 'terminal-copy-hint';
    h.style.cssText = 'position:absolute;top:36px;right:8px;z-index:30;max-width:248px;'
      + "font:11px/1.45 'Plus Jakarta Sans', system-ui, sans-serif;"
      + 'color:var(--text, #cdd6f4);background:var(--surface0, rgba(24, 24, 37, 0.97));'
      + 'border:1px solid var(--surface2, #585b70);border-radius:10px;'
      + 'padding:9px 22px 9px 11px;box-shadow:0 8px 24px rgba(0, 0, 0, 0.42);'
      + 'opacity:0;transition:opacity 180ms ease;';
    h.innerHTML = 'Claude Code captures the mouse. Hold <b>Shift</b> and drag to select, '
      + 'then <b>Ctrl+C</b> to copy, or use <b>Select mode</b> (this button).'
      + '<button class="terminal-copy-hint-x" aria-label="Dismiss" '
      + 'style="position:absolute;top:3px;right:5px;background:none;border:none;'
      + 'color:inherit;cursor:pointer;font-size:15px;line-height:1;padding:2px;opacity:0.7;">&times;</button>';
    this.paneEl.appendChild(h);
    requestAnimationFrame(() => { if (this._copyHint) this._copyHint.style.opacity = '1'; });
    const x = h.querySelector('.terminal-copy-hint-x');
    if (x) x.addEventListener('click', (e) => { e.stopPropagation(); this._dismissCopyHint(); });
    this._copyHint = h;
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
    clearTimeout(this.reconnectTimer);
    clearTimeout(this._fitTimer);
    clearTimeout(this._idleCheckTimer);
    clearTimeout(this._activityDebounceTimer);
    clearTimeout(this._bgFlushTimer);
    clearTimeout(this._needsInputTimer);
    if (this._writeRaf) cancelAnimationFrame(this._writeRaf);
    this._writeBuf = '';
    this._activitySample = '';
    if (this._touchScrollCleanup) this._touchScrollCleanup();
    // Copy-mode teardown: remove the capture-phase mouse interceptor and any
    // injected controls/hints so a remount into the same slot starts clean.
    if (this._copyHintTimer) { clearTimeout(this._copyHintTimer); this._copyHintTimer = null; }
    if (this._selInterceptorContainer && this._selMouseHandler) {
      try {
        this._selInterceptorContainer.removeEventListener('mousedown', this._selMouseHandler, { capture: true });
        this._selInterceptorContainer.removeEventListener('mousemove', this._selMouseHandler, { capture: true });
        this._selInterceptorContainer.removeEventListener('mouseup', this._selMouseHandler, { capture: true });
      } catch (_) {}
    }
    this._selMouseHandler = null;
    this._selInterceptorContainer = null;
    if (this._selectModeBtn) { try { this._selectModeBtn.remove(); } catch (_) {} this._selectModeBtn = null; }
    if (this._selStrip) { try { this._selStrip.remove(); } catch (_) {} this._selStrip = null; }
    if (this._copyHint) { try { this._copyHint.remove(); } catch (_) {} this._copyHint = null; }
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.ws) { this.ws.onmessage = null; this.ws.onclose = null; this.ws.close(); }
    if (this.term) this.term.dispose();
    this.term = null;
    this.ws = null;
  }
}

if (typeof window !== 'undefined') window.TerminalPane = TerminalPane;
