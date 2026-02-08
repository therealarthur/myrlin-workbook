/**
 * TerminalPane — xterm.js terminal connected via WebSocket to server-side PTY
 * Performance-critical: raw binary I/O, no JSON wrapping for terminal data
 */
class TerminalPane {
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
        theme: {
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
        },
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.term.loadAddon(this.fitAddon);

      if (typeof WebLinksAddon !== 'undefined') {
        this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
      }

      this.term.open(container);
      this._log('xterm opened in ' + this.containerId + ' for session ' + this.sessionId);

      this._status('Connecting to session...', 'blue');

      requestAnimationFrame(() => {
        try {
          this.fitAddon.fit();
          this._log('Fitted: ' + this.term.cols + 'x' + this.term.rows);
        } catch (e) {
          this._log('fit() failed: ' + e.message);
        }
        // Initialize mobile scroll/type mode separation
        this.initMobileInputMode();
        this._log('Calling connect()...');
        this.connect();
      });

      // Intercept Shift+Enter to send newline instead of carriage return
      // This lets Claude Code receive a "next line" signal rather than "submit"
      this.term.attachCustomKeyEventHandler((e) => {
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
    // Append optional spawn options as query params
    if (this.spawnOpts.cwd) wsUrl += '&cwd=' + encodeURIComponent(this.spawnOpts.cwd);
    if (this.spawnOpts.resumeSessionId) wsUrl += '&resumeSessionId=' + encodeURIComponent(this.spawnOpts.resumeSessionId);
    if (this.spawnOpts.command) wsUrl += '&command=' + encodeURIComponent(this.spawnOpts.command);
    this._log('Opening WebSocket: ' + wsUrl.substring(0, 80) + '...');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this._log('WebSocket constructor threw: ' + err.message);
      this._status('WebSocket failed: ' + err.message, 'red');
      return;
    }

    this.ws.onopen = () => {
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
            return;
          }
        } catch (_) {}
      }
      this.term.write(data);
    };

    this.ws.onclose = (event) => {
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
    if (this.term) this.term.focus();
  }

  blur() {
    if (this.term) this.term.blur();
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
   * Sets the terminal to scroll mode by default on mobile.
   * Also installs a custom touch scroll handler since xterm.js's canvas
   * intercepts all touch events and prevents native scroll on the viewport.
   */
  initMobileInputMode() {
    if (!this._isMobile() || !this.term) return;

    this._mobileTypeMode = false;

    // Find xterm's hidden textarea
    const container = document.getElementById(this.containerId);
    if (!container) return;
    const textarea = container.querySelector('.xterm-helper-textarea');
    if (!textarea) return;

    this._xtermTextarea = textarea;

    // Default to scroll mode: make textarea readonly so keyboard won't appear
    textarea.setAttribute('readonly', 'readonly');
    textarea.setAttribute('inputmode', 'none');

    // When textarea loses focus (keyboard dismissed), revert to scroll mode
    textarea.addEventListener('blur', () => {
      if (this._mobileTypeMode) {
        this.setMobileScrollMode();
      }
    });

    // ── Custom Touch Scroll Handler ──────────────────────────────
    // xterm.js's .xterm-screen canvas sits on top of .xterm-viewport and
    // intercepts all touch events, preventing native scroll. We capture
    // touch events and programmatically scroll the terminal.
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
   * Switch to type mode — keyboard appears, user can type into terminal
   */
  setMobileTypeMode() {
    if (!this._xtermTextarea || !this.term) return;
    this._mobileTypeMode = true;
    this._xtermTextarea.removeAttribute('readonly');
    this._xtermTextarea.setAttribute('inputmode', 'text');
    this.term.focus();
    // Notify listeners (toolbar button can update its state)
    if (this.onMobileModeChange) this.onMobileModeChange('type');
  }

  /**
   * Switch to scroll mode — keyboard hidden, touch scrolls terminal output
   */
  setMobileScrollMode() {
    if (!this._xtermTextarea) return;
    this._mobileTypeMode = false;
    this._xtermTextarea.setAttribute('readonly', 'readonly');
    this._xtermTextarea.setAttribute('inputmode', 'none');
    if (this.term) this.term.blur();
    // Notify listeners
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

  dispose() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this._fitTimer);
    if (this._touchScrollCleanup) this._touchScrollCleanup();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    if (this.term) this.term.dispose();
    this.term = null;
    this.ws = null;
  }
}

if (typeof window !== 'undefined') window.TerminalPane = TerminalPane;
