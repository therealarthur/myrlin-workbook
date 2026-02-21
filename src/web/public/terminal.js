/**
 * TerminalPane - xterm.js terminal connected via WebSocket to server-side PTY
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

      // Custom key handler for Ctrl+C (copy), Ctrl+V (paste), Shift+Enter
      this.term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const mod = e.ctrlKey || e.metaKey;

        // Ctrl+C / Cmd+C: copy selected text to clipboard (if selection exists)
        // Without selection, fall through so xterm sends \x03 (SIGINT) normally
        if (mod && e.key === 'c' && this.term.hasSelection()) {
          navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
          this.term.clearSelection();
          return false;
        }

        // Ctrl+V / Cmd+V: paste from clipboard via WebSocket
        // Using explicit clipboard read instead of relying on browser paste event,
        // which doesn't always fire reliably through xterm's hidden textarea
        if (mod && e.key === 'v') {
          this.pasteFromClipboard();
          return false;
        }

        // Shift+Enter: send newline instead of carriage return
        if (e.key === 'Enter' && e.shiftKey) {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'input', data: '\n' }));
          }
          return false;
        }

        return true;
      });

      // ── Mobile IME/autocorrect guard ──────────────────────────
      // Mobile keyboards handle autocorrect in two ways:
      // 1. Composition events (CJK, swipe typing): compositionstart → compositionend
      // 2. beforeinput with insertReplacementText (tap-to-correct suggestions)
      //
      // xterm.js doesn't handle either well — it sends both the original
      // keystrokes AND the replacement, causing text duplication.
      //
      // Strategy: intercept both paths, block xterm's processing, and send
      // the correct keystrokes (backspaces + replacement) ourselves.
      this._composing = false;
      this._replacingText = false;
      const xtermTextarea = container.querySelector('.xterm-helper-textarea');
      if (xtermTextarea) {
        // Path 1: Composition events (swipe, CJK input)
        xtermTextarea.addEventListener('compositionstart', () => {
          this._composing = true;
        });
        xtermTextarea.addEventListener('compositionend', (e) => {
          this._composing = false;
          if (e.data && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'input', data: e.data }));
          }
        });

        // Path 2: Autocorrect tap-to-replace (Gboard, iOS keyboard, etc.)
        // beforeinput fires BEFORE the textarea is modified — we can block it
        // and send the correct backspaces + replacement to the PTY ourselves.
        xtermTextarea.addEventListener('beforeinput', (e) => {
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
        });
      }

      this.term.onData((data) => {
        // Skip input during IME composition — compositionend sends the result
        if (this._composing) return;
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
      container.innerHTML = '<div style="padding:16px;color:#f38ba8;font-size:13px;">Terminal init failed: ' + err.message + '</div>';
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

    // On reconnect, fully reset the terminal before the server replays scrollback.
    // reset() clears viewport, scrollback buffer, cursor, and all terminal state.
    // Without this, the replayed scrollback appears on top of existing content.
    if (isReconnect && this.term) {
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
   */
  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Wrap in bracketed paste escape sequences so the shell correctly
        // handles pasted content (prevents misinterpreting special chars)
        const bracketedText = '\x1b[200~' + text + '\x1b[201~';
        this.ws.send(JSON.stringify({ type: 'input', data: bracketedText }));
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
   * Visibility-safe fit: only calls fitAddon.fit() when the container is visible.
   * Hidden panes (display:none from tab switching) report 0×0 dimensions, which
   * causes fitAddon to resize the PTY to 1×1 — permanently garbling scrollback.
   * All external callers should use safeFit() instead of fitAddon.fit() directly.
   */
  safeFit() {
    if (!this.fitAddon || !this.term) return;
    const container = document.getElementById(this.containerId);
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    try { this.fitAddon.fit(); } catch (_) { return; }
    // Notify server of new dimensions
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
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
    // NOT get mobile treatment - they have keyboards and wide screens.
    return window.innerWidth <= 768;
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
    // and programmatically scrolls .xterm-viewport.scrollTop. Momentum
    // simulation provides native-feeling inertia on touch release.
    //
    // Long-press (400ms hold) switches to xterm.js selection mode so the
    // user can highlight text without triggering the keyboard.

    const viewport = this._xtermViewport;
    if (!viewport) return;

    let startY = 0;          // Touch start Y position
    let lastY = 0;           // Previous touchmove Y
    let lastTime = 0;        // Previous touchmove timestamp
    let velocity = 0;        // Scroll velocity for momentum (px/ms)
    let momentumRaf = null;  // rAF ID for momentum animation
    let isScrolling = false; // Whether we detected a scroll gesture
    let longPressTimer = null;
    const LONG_PRESS_MS = 400;
    const MOVE_THRESHOLD = 8;  // px — must move this far to be a scroll
    const FRICTION = 0.95;     // Momentum deceleration per frame
    const MIN_VELOCITY = 0.5;  // Stop momentum below this (px/ms)

    /** Cancel any running momentum animation */
    const stopMomentum = () => {
      if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
      velocity = 0;
    };

    /** Animate momentum scroll after finger lifts */
    const animateMomentum = () => {
      velocity *= FRICTION;
      if (Math.abs(velocity) < MIN_VELOCITY) { stopMomentum(); return; }
      viewport.scrollTop -= velocity * 16; // ~16ms per frame
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
      const touch = e.touches[0];
      startY = touch.clientY;
      lastY = touch.clientY;
      lastTime = Date.now();
      velocity = 0;
      isScrolling = false;

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
        // Scroll the viewport by the finger's delta
        viewport.scrollTop -= deltaY;
        // Track velocity for momentum (smoothed)
        if (dt > 0) {
          const instantV = deltaY / dt;
          velocity = velocity * 0.6 + instantV * 0.4; // weighted average
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
        setTimeout(() => this._disableMobileSelection(), 300);
        return;
      }

      if (this._mobileTypeMode) return;

      // Start momentum animation if finger was moving fast enough
      if (isScrolling && Math.abs(velocity) > MIN_VELOCITY) {
        momentumRaf = requestAnimationFrame(animateMomentum);
      }
      isScrolling = false;
    };

    // Use CAPTURE phase to intercept before xterm.js gets the events.
    // Non-passive so we can prevent xterm from seeing the events in scroll mode.
    container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });

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

    // Track completion (debounced internally)
    this._trackActivityForCompletion();

    // Debounce activity detection to at most once per 200ms
    if (!this._activityDebounceTimer) {
      this._activityDebounceTimer = setTimeout(() => {
        this._activityDebounceTimer = null;
        const sample = this._activitySample;
        this._activitySample = '';
        if (sample) this._detectActivity(sample);
        this._analyzeForAutoTrust(sample);
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
   * Called after every terminal write. Marks the pane as working and
   * schedules a debounced idle check - if no output arrives for 2s
   * after the last burst, we inspect the buffer for a prompt.
   */
  _trackActivityForCompletion() {
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
    if (!this._isWorking) {
      this._isWorking = true;
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
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.ws) { this.ws.onmessage = null; this.ws.onclose = null; this.ws.close(); }
    if (this.term) this.term.dispose();
    this.term = null;
    this.ws = null;
  }
}

if (typeof window !== 'undefined') window.TerminalPane = TerminalPane;
