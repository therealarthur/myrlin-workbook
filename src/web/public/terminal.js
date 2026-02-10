/**
 * TerminalPane — xterm.js terminal connected via WebSocket to server-side PTY
 * Performance-critical: raw binary I/O, no JSON wrapping for terminal data
 */
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

  static getCurrentTheme() {
    const t = document.documentElement.dataset.theme;
    switch (t) {
      case 'latte': return TerminalPane.THEME_LATTE;
      case 'frappe': return TerminalPane.THEME_FRAPPE;
      case 'macchiato': return TerminalPane.THEME_MACCHIATO;
      default: return TerminalPane.THEME_MOCHA;
    }
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
    this._lastOutputTime = 0;
    this._idleCheckTimer = null;
  }

  _log(msg) {
    console.log('[Terminal]', msg);
  }

  _status(msg, color) {
    if (this.term) {
      const c = color === 'red' ? '31' : color === 'green' ? '32' : color === 'yellow' ? '33' : '34';
      this.term.write('\x1b[1;' + c + 'm' + msg + '\x1b[0m\r\n');
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
      container.innerHTML = '<div style="padding:16px;color:#f38ba8;font-size:13px;">Error: xterm.js not loaded</div>';
      return;
    }
    if (typeof FitAddon === 'undefined') {
      console.error('[Terminal] FitAddon not loaded');
      container.innerHTML = '<div style="padding:16px;color:#f38ba8;font-size:13px;">Error: FitAddon not loaded</div>';
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

      this._status('Connecting to session...', 'blue');

      // Initialize mobile scroll/type mode after terminal is in DOM
      this.initMobileInputMode();

      // IMPORTANT: Fit BEFORE connecting WebSocket so we know the real
      // terminal dimensions. The PTY spawns at whatever cols/rows we pass
      // in the WS URL — if we connect before fit, the PTY starts at
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

          // Safety refit after 200ms — catches edge cases where the grid
          // is still settling (e.g., CSS transitions, slow layout)
          setTimeout(() => {
            if (this.fitAddon) {
              try {
                this.fitAddon.fit();
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
                }
              } catch (_) {}
            }
          }, 200);
        });
      });

      // Intercept Shift+Enter to send newline instead of carriage return
      // This lets Claude Code receive a "next line" signal rather than "submit"
      this.term.attachCustomKeyEventHandler((e) => {
        // Let browser handle Ctrl+V / Cmd+V — triggers container paste listener
        if (e.type === 'keydown' && (e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
          return false;
        }
        if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'input', data: '\n' }));
          }
          return false; // prevent xterm default Enter handling
        }
        return true; // let xterm handle everything else
      });

      this.term.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Explicit paste handler — catches Ctrl+V / Cmd+V and clipboard paste events.
      // xterm.js built-in paste can be unreliable with bracketed paste mode,
      // so we intercept and send directly via WebSocket.
      container.addEventListener('paste', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input', data: text }));
        }
      });

      this._resizeObserver = new ResizeObserver(() => {
        // Debounce resize to prevent layout thrashing during mobile tab switches
        clearTimeout(this._fitTimer);
        this._fitTimer = setTimeout(() => {
          if (this.fitAddon) {
            try { this.fitAddon.fit(); } catch (_) {}
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
            }
          }
        }, 100);
      });
      this._resizeObserver.observe(container);

      // ── Click-to-position cursor ──────────────────────────
      this._initClickToPosition(container);
    } catch (err) {
      console.error('[Terminal] Init failed:', err);
      container.innerHTML = '<div style="padding:16px;color:#f38ba8;font-size:13px;">Terminal init failed: ' + err.message + '</div>';
    }
  }

  connect() {
    this._log('connect() entered, ws=' + (this.ws ? 'exists(state=' + this.ws.readyState + ')' : 'null'));

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._log('Already connected, skipping');
      return;
    }

    // Close any stale WebSocket before creating a new one
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch (_) {}
      this.ws = null;
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
      this._log('WebSocket OPEN');
      this._status('Connected. Starting session...', 'green');
      this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
    };

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
            this._status('[Process exited with code ' + msg.exitCode + ']', 'red');
            this.connected = false;
            return;
          } else if (msg.type === 'error') {
            this._status('[Error: ' + msg.message + ']', 'red');
            return;
          } else if (msg.type === 'output') {
            this.term.write(msg.data);
            this._trackActivityForCompletion();
            return;
          }
        } catch (_) {}
      }
      this.term.write(data);

      // Track activity for completion detection
      this._trackActivityForCompletion();
    };

    this.ws.onclose = (event) => {
      // Remove loading animation
      const paneEl = document.getElementById(this.containerId)?.closest('.terminal-pane');
      if (paneEl) paneEl.classList.remove('terminal-pane-loading');

      this.connected = false;
      this._log('WebSocket CLOSED code=' + event.code + ' reason=' + (event.reason || 'none'));

      // Code 1011 = server error (PTY spawn failed). Don't retry — it won't fix itself.
      if (event.code === 1011) {
        const reason = event.reason || 'PTY session failed to spawn';
        this._status('[Server error: ' + reason + ']', 'red');
        this._status('Check server logs for details. Drag a new session to retry.', 'yellow');
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
    // Also explicitly focus the hidden textarea — xterm.js's focus()
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
   */
  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: text }));
      }
    } catch (err) {
      this._log('Clipboard paste failed: ' + err.message);
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
   * Mobile scroll/type mode.
   * On mobile, touching the terminal to scroll triggers the keyboard because
   * xterm.js uses a hidden textarea for input. Professional mobile terminals
   * (Blink Shell, Termux) solve this by separating scroll and type modes.
   *
   * Scroll mode (default): textarea is readonly, touch scrolls without keyboard
   * Type mode: textarea is writable, keyboard appears for input
   */
  _isMobile() {
    // Use width-based check matching the CSS media query, NOT touch detection.
    // Touch-enabled desktops (Windows laptops) have 'ontouchstart' but should
    // NOT get mobile treatment — they have keyboards and wide screens.
    return window.innerWidth <= 768;
  }

  /**
   * Initialize mobile input mode — called after terminal mounts.
   * Uses CSS pointer-events to prevent touch from focusing xterm's hidden
   * textarea (which triggers the keyboard). Toolbar buttons send via WebSocket
   * directly and don't need the textarea. The "Type" button toggles
   * pointer-events to allow keyboard input when explicitly requested.
   */
  initMobileInputMode() {
    if (!this._isMobile() || !this.term) return;

    this._mobileTypeMode = false;

    const container = document.getElementById(this.containerId);
    if (!container) return;
    const textarea = container.querySelector('.xterm-helper-textarea');
    if (!textarea) return;

    this._xtermTextarea = textarea;

    // Default to scroll mode: block touch from reaching textarea via CSS.
    // This prevents the keyboard from appearing when scrolling.
    // Unlike readonly, this doesn't interfere with programmatic input.
    textarea.style.pointerEvents = 'none';

    // ── Custom Touch Scroll Handler ──────────────────────────────
    this._initTouchScroll(container);
  }

  /**
   * Custom touch scroll for mobile. Directly manipulates the xterm viewport's
   * scrollTop for pixel-smooth scrolling that feels like native scroll.
   * xterm.js's .xterm-screen canvas sits on top of .xterm-viewport and
   * intercepts touch events, so we handle them manually.
   */
  _initTouchScroll(container) {
    let touchStartY = 0;
    let touchLastY = 0;
    let touchLastTime = 0;
    let velocity = 0;
    let momentumId = null;
    let isScrolling = false;

    // Get the xterm viewport element (the actual scrollable div)
    const viewport = container.querySelector('.xterm-viewport');
    if (!viewport) {
      this._log('Touch scroll: .xterm-viewport not found');
      return;
    }

    const cancelMomentum = () => {
      if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
      }
    };

    const applyMomentum = () => {
      if (Math.abs(velocity) < 0.3) {
        velocity = 0;
        return;
      }

      // Scroll the viewport directly — pixel-smooth, no line snapping
      viewport.scrollTop += velocity;

      // Decelerate — 0.95 gives a smooth, native-feeling coast
      velocity *= 0.95;

      momentumId = requestAnimationFrame(applyMomentum);
    };

    container.addEventListener('touchstart', (e) => {
      if (this._mobileTypeMode) return;

      cancelMomentum();
      const touch = e.touches[0];
      touchStartY = touch.clientY;
      touchLastY = touch.clientY;
      touchLastTime = Date.now();
      velocity = 0;
      isScrolling = false;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (this._mobileTypeMode) return;

      const touch = e.touches[0];
      const deltaY = touchLastY - touch.clientY; // positive = scroll down
      const now = Date.now();
      const dt = Math.max(now - touchLastTime, 1);

      // Determine if this is a scroll gesture (>5px vertical movement)
      if (!isScrolling) {
        if (Math.abs(touchStartY - touch.clientY) > 5) {
          isScrolling = true;
        } else {
          return;
        }
      }

      // Prevent page scroll — we're handling it
      e.preventDefault();

      // Directly scroll the viewport — pixel smooth, no line quantization
      viewport.scrollTop += deltaY;

      // Track velocity for momentum (pixels per 16ms frame)
      velocity = deltaY * (16 / dt);

      touchLastY = touch.clientY;
      touchLastTime = now;
    }, { passive: false });

    container.addEventListener('touchend', () => {
      if (this._mobileTypeMode) return;
      if (!isScrolling) return;

      // Apply momentum scrolling with deceleration
      if (Math.abs(velocity) > 0.5) {
        momentumId = requestAnimationFrame(applyMomentum);
      }
      isScrolling = false;
    }, { passive: true });

    this._touchScrollCleanup = () => cancelMomentum();
  }

  /**
   * Click-to-position: when user clicks on the same row as the cursor,
   * send left/right arrow keys to move cursor to clicked column.
   * Desktop only — mobile has its own touch scroll handling.
   */
  _initClickToPosition(container) {
    if (this._isMobile()) return;

    container.addEventListener('mouseup', (e) => {
      // Don't interfere with text selection
      if (this.term.hasSelection()) return;
      // Left-click only
      if (e.button !== 0) return;

      // Small delay to let selection state settle
      setTimeout(() => {
        if (this.term.hasSelection()) return;
        this._handleClickToPosition(e, container);
      }, 50);
    });
  }

  _handleClickToPosition(e, container) {
    if (!this.term || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const cursorRow = this.term.buffer.active.cursorY;
    const cursorCol = this.term.buffer.active.cursorX;

    // Calculate cell dimensions from actual rendered size
    const termEl = container.querySelector('.xterm-screen');
    if (!termEl) return;
    const rect = termEl.getBoundingClientRect();
    const cellW = rect.width / this.term.cols;
    const cellH = rect.height / this.term.rows;

    // Determine clicked row/col
    const clickedRow = Math.floor((e.clientY - rect.top) / cellH);
    const clickedCol = Math.floor((e.clientX - rect.left) / cellW);

    // Safety: only move cursor on the SAME ROW as cursor
    if (clickedRow !== cursorRow) return;

    // Clamp and calculate delta
    const targetCol = Math.max(0, Math.min(clickedCol, this.term.cols - 1));
    const delta = targetCol - cursorCol;
    if (delta === 0) return;

    // Send arrow key escape sequences
    const seq = (delta > 0 ? '\x1b[C' : '\x1b[D').repeat(Math.abs(delta));
    this.ws.send(JSON.stringify({ type: 'input', data: seq }));
  }

  /**
   * Switch to type mode — keyboard appears, user can type into terminal
   */
  setMobileTypeMode() {
    if (!this._xtermTextarea || !this.term) return;
    this._mobileTypeMode = true;
    // Allow touch to reach textarea so keyboard can appear
    this._xtermTextarea.style.pointerEvents = 'auto';
    this.term.focus();
    if (this.onMobileModeChange) this.onMobileModeChange('type');
  }

  /**
   * Switch to scroll mode — keyboard hidden, touch scrolls terminal output
   */
  setMobileScrollMode() {
    if (!this._xtermTextarea) return;
    this._mobileTypeMode = false;
    // Block touch from reaching textarea — prevents keyboard on scroll
    this._xtermTextarea.style.pointerEvents = 'none';
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
     COMPLETION DETECTION
     Detects when Claude transitions from "working" (producing output)
     to "idle" (showing a prompt, ready for input). Uses a debounced
     check: after 2 seconds of no new output, inspects the terminal
     buffer's last line for prompt patterns (❯, $, >, Human:, etc.).
     ═══════════════════════════════════════════════════════════ */

  /**
   * Called after every terminal write. Marks the pane as working and
   * schedules a debounced idle check — if no output arrives for 2s
   * after the last burst, we inspect the buffer for a prompt.
   */
  _trackActivityForCompletion() {
    this._lastOutputTime = Date.now();
    if (!this._isWorking) {
      this._isWorking = true;
    }
    // Debounced idle check — if no output for 2 seconds after burst, check for prompt
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

    // Read the last line of the terminal buffer at the cursor position
    const buffer = this.term.buffer.active;
    const cursorRow = buffer.cursorY + buffer.baseY;
    const line = buffer.getLine(cursorRow);
    if (!line) return;

    const lineText = line.translateToString(true).trim();

    // Claude Code prompt patterns: ends with ❯, $, or >
    // Also match "Human:" which appears in Claude's conversation UI
    if (/[❯$>]\s*$/.test(lineText) || /^(Human:|Type.*message)/.test(lineText)) {
      this._isWorking = false;

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

  dispose() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this._fitTimer);
    clearTimeout(this._idleCheckTimer);
    if (this._touchScrollCleanup) this._touchScrollCleanup();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    if (this.term) this.term.dispose();
    this.term = null;
    this.ws = null;
  }
}

if (typeof window !== 'undefined') window.TerminalPane = TerminalPane;
