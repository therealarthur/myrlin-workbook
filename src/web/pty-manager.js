/**
 * PTY Session Manager for Claude Workspace Manager.
 *
 * Manages pseudo-terminal sessions using node-pty. Each session is a long-lived
 * PTY process that persists independently of WebSocket client connections,
 * allowing reconnection with full scrollback replay.
 *
 * Performance notes:
 *   - PTY output is sent as raw text to WebSocket clients (no JSON wrapping)
 *   - WebSocket input is written directly to PTY (no buffering)
 *   - Scrollback is capped at ~100KB total characters
 */

const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStore } = require('../state/store');

/**
 * Resolve the real working directory for a Claude session.
 * Scans ~/.claude/projects/ for the session's JSONL file, then:
 *   1. Reads sessions-index.json originalPath (applies to all sessions in that project)
 *   2. Checks sessions-index.json entries for a per-session projectPath
 *   3. Falls back to scanning the JSONL for a line with a cwd field
 */
function cwdFromJsonl(sessionId) {
  try {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeDir)) return null;
    const dirs = fs.readdirSync(claudeDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const jsonlPath = path.join(claudeDir, dir.name, sessionId + '.jsonl');
      if (!fs.existsSync(jsonlPath)) continue;

      // Try sessions-index.json — originalPath is the project-wide cwd,
      // entries[].projectPath is per-session
      try {
        const indexPath = path.join(claudeDir, dir.name, 'sessions-index.json');
        if (fs.existsSync(indexPath)) {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          // Per-session projectPath takes priority
          const entries = index.entries || [];
          const entry = entries.find(s => s.sessionId === sessionId);
          if (entry && entry.projectPath) return entry.projectPath;
          // Fall back to project-wide originalPath
          if (index.originalPath) return index.originalPath;
        }
      } catch (_) {}

      // Last resort: scan JSONL for a line with a cwd field
      try {
        const fd = fs.openSync(jsonlPath, 'r');
        try {
          const buf = Buffer.alloc(16384);
          const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
          const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.cwd) return parsed.cwd;
            } catch (_) {}
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Maximum scrollback buffer size in total characters
const MAX_SCROLLBACK_CHARS = 100 * 1024; // 100KB

/**
 * Represents a single PTY session with its process, clients, and scrollback.
 */
class PtySession {
  constructor(sessionId, ptyProcess) {
    this.sessionId = sessionId;
    this.pty = ptyProcess;
    this.clients = new Set();      // Set of WebSocket connections
    this.scrollback = [];          // Array of raw output strings
    this.scrollbackSize = 0;       // Running total of characters
    this.alive = true;
    this.exitCode = null;
    this.pid = ptyProcess.pid;
    this.pingInterval = null;    // Keepalive ping interval ID
    this._lastActiveTimer = null; // Debounce timer for lastActive updates
    this.createdAt = Date.now();  // Track when session was spawned
  }

  /**
   * Append data to the scrollback buffer, pruning if over limit.
   * @param {string} data - Raw PTY output
   */
  appendScrollback(data) {
    this.scrollback.push(data);
    this.scrollbackSize += data.length;

    // Prune from the front when exceeding limit
    while (this.scrollbackSize > MAX_SCROLLBACK_CHARS && this.scrollback.length > 1) {
      const removed = this.scrollback.shift();
      this.scrollbackSize -= removed.length;
    }
  }
}

class PtySessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> PtySession
  }

  /**
   * Spawn a new PTY session or return an existing one.
   *
   * @param {string} sessionId - Unique session identifier
   * @param {object} options
   * @param {string} [options.command='claude'] - Base command to run
   * @param {string} [options.cwd] - Working directory for the PTY
   * @param {number} [options.cols=120] - Terminal columns
   * @param {number} [options.rows=30] - Terminal rows
   * @param {boolean} [options.bypassPermissions=false] - If true, adds --dangerously-skip-permissions
   * @returns {PtySession} The PTY session object
   */
  spawnSession(sessionId, { command = 'claude', cwd, cols = 120, rows = 30, bypassPermissions = false, resumeSessionId = null, verbose = false, model = null, agentTeams = false, shell: requestedShell = null } = {}) {
    // Return existing session if already alive
    const existing = this.sessions.get(sessionId);
    if (existing && existing.alive) {
      return existing;
    }

    // ── Defense-in-depth: validate all user-controlled inputs ──
    // Primary validation happens at the API/WebSocket boundary (server.js, pty-server.js).
    // This is a secondary gate to catch any bypass or future code path that skips validation.
    const SHELL_UNSAFE = /[;&|`$(){}[\]<>!#*?\n\r\\'"]/;
    if (SHELL_UNSAFE.test(command)) {
      console.error(`[PTY] Rejected unsafe command for session ${sessionId}: ${command}`);
      return null;
    }
    if (resumeSessionId && !/^[a-zA-Z0-9_-]+$/.test(resumeSessionId)) {
      console.error(`[PTY] Rejected unsafe resumeSessionId for session ${sessionId}: ${resumeSessionId}`);
      return null;
    }
    if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) {
      console.error(`[PTY] Rejected unsafe model for session ${sessionId}: ${model}`);
      return null;
    }

    // Build full command string (all inputs validated above)
    let fullCommand = command;
    if (resumeSessionId) {
      fullCommand += ' --resume ' + resumeSessionId;
    } else if (cwd) {
      // No explicit session to resume - use --continue to pick up most recent
      // conversation in this working directory. On a fresh dir with no history,
      // Claude will start a new conversation (same as bare `claude`).
      fullCommand += ' --continue';
    }
    if (bypassPermissions) {
      fullCommand += ' --dangerously-skip-permissions';
    }
    if (verbose) {
      fullCommand += ' --verbose';
    }
    if (model) {
      fullCommand += ' --model ' + model;
    }

    // Validate cwd exists. If the provided path is invalid (e.g. an encoded
    // directory name like "-Users-jane-project"), resolve the real cwd from
    // the session's JSONL file before falling back to home.
    let resolvedCwd = cwd || process.cwd();
    const cwdIsValid = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (_) { return false; } };
    if (!cwdIsValid(resolvedCwd)) {
      const resumeId = resumeSessionId || sessionId;
      const jsonlCwd = cwdFromJsonl(resumeId);
      if (jsonlCwd && cwdIsValid(jsonlCwd)) {
        console.log(`[PTY] cwd "${resolvedCwd}" invalid, resolved from JSONL: ${jsonlCwd}`);
        resolvedCwd = jsonlCwd;
      } else {
        console.log(`[PTY] cwd "${resolvedCwd}" invalid, no JSONL cwd found, falling back to home`);
        resolvedCwd = os.homedir();
      }
    }

    // Inject workspace documentation env vars so AI sessions can read/write docs
    const sessionEnv = { ...process.env };
    // Remove CLAUDECODE env var to prevent "nested session" detection error
    // when Myrlin itself runs inside a Claude Code session
    delete sessionEnv.CLAUDECODE;
    try {
      const store = getStore();
      const storeSession = store.getSession(sessionId);
      if (storeSession && storeSession.workspaceId) {
        const docsManager = require('../state/docs-manager');
        sessionEnv.CWM_WORKSPACE_DOCS_PATH = docsManager.getDocsPath(storeSession.workspaceId);
        sessionEnv.CWM_WORKSPACE_ID = storeSession.workspaceId;
        const port = process.env.PORT || process.env.CWM_PORT || '3456';
        sessionEnv.CWM_DOCS_API_BASE = `http://localhost:${port}/api/workspaces/${storeSession.workspaceId}/docs`;
      }
    } catch (_) {
      // Non-critical - session can work without docs integration
    }

    // Platform-specific shell selection
    // Supports user-requested shell override via context menu "Change Environment".
    // All shells validated against allowlists to prevent arbitrary binary execution.
    const isWindows = process.platform === 'win32';
    const ALLOWED_SHELLS_UNIX = [
      '/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh',
      '/bin/zsh', '/usr/bin/zsh', '/bin/fish', '/usr/bin/fish',
      '/bin/dash', '/usr/bin/dash', '/bin/ash',
    ];
    const ALLOWED_SHELLS_WIN = ['cmd.exe', 'powershell.exe', 'pwsh.exe'];
    // Git Bash paths checked at spawn time (may not exist on all systems)
    const GIT_BASH_PATHS = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];

    let shell, shellArgs;
    if (requestedShell) {
      // User explicitly chose a shell via "Change Environment"
      if (isWindows) {
        if (ALLOWED_SHELLS_WIN.includes(requestedShell)) {
          shell = requestedShell;
        } else if (requestedShell === 'git-bash') {
          // Resolve Git Bash to an actual path
          const gitBashPath = GIT_BASH_PATHS.find(p => fs.existsSync(p));
          shell = gitBashPath || 'cmd.exe';
          if (!gitBashPath) console.log('[PTY] Git Bash not found, falling back to cmd.exe');
        } else {
          console.log(`[PTY] Rejected unknown Windows shell "${requestedShell}", using cmd.exe`);
          shell = 'cmd.exe';
        }
      } else {
        // Unix: check if requested shell is in allowlist
        const match = ALLOWED_SHELLS_UNIX.find(s => s.endsWith('/' + requestedShell) || s === requestedShell);
        shell = match || '/bin/bash';
      }
    } else {
      // Default: cmd.exe on Windows, user's $SHELL (validated) on Unix
      const safeShell = (process.env.SHELL && ALLOWED_SHELLS_UNIX.includes(process.env.SHELL))
        ? process.env.SHELL
        : '/bin/bash';
      shell = isWindows ? 'cmd.exe' : safeShell;
    }

    // Override SHELL env var to match the selected shell so Claude Code's
    // internal shell detection picks up the right one. Without this, Claude
    // Code launched from PowerShell may still detect MINGW64 Git Bash via
    // an inherited SHELL=/usr/bin/bash from the parent process.
    if (isWindows) {
      if (shell === 'powershell.exe' || shell === 'pwsh.exe') {
        sessionEnv.SHELL = shell;
        // Remove MINGW/Cygwin paths that confuse Windows-native shells
        delete sessionEnv.MSYSTEM;
        delete sessionEnv.MINGW_PREFIX;
      } else if (shell === 'cmd.exe') {
        // CMD doesn't use SHELL, remove it so Claude Code defaults to
        // Windows-native behavior instead of detecting Git Bash
        delete sessionEnv.SHELL;
        delete sessionEnv.MSYSTEM;
        delete sessionEnv.MINGW_PREFIX;
      }
      // For git-bash: keep SHELL as-is (bash is correct)
    } else {
      // Unix: set SHELL to the resolved path
      sessionEnv.SHELL = shell;
    }

    // Build shell arguments based on the resolved shell binary
    if (shell === 'cmd.exe') {
      shellArgs = ['/c', fullCommand];
    } else if (shell === 'powershell.exe' || shell === 'pwsh.exe') {
      shellArgs = ['-NoProfile', '-Command', fullCommand];
    } else {
      // Unix shells and Git Bash all use -l -c
      shellArgs = ['-l', '-c', fullCommand];
    }

    console.log(`[PTY] Spawning: ${shell} ${shellArgs.join(' ')} (cwd: ${resolvedCwd})`);

    // Spawn PTY process
    // Windows: cmd.exe /c so it exits when Claude exits (Ctrl+C, completion, crash)
    // Linux/WSL: login shell (-l) ensures PATH includes nvm/npm paths where claude lives
    let ptyProcess;
    try {
      const spawnOpts = {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: sessionEnv,
      };
      if (isWindows) {
        spawnOpts.useConpty = true;
      }
      ptyProcess = pty.spawn(shell, shellArgs, spawnOpts);
    } catch (err) {
      console.error(`[PTY] Failed to spawn for session ${sessionId}:`, err.message);
      return null; // caller should check for null
    }

    const session = new PtySession(sessionId, ptyProcess);
    this.sessions.set(sessionId, session);

    // Handle asynchronous PTY process errors (e.g. process crashes after spawn).
    // Guard with typeof check since node-pty's IPty may not always expose .on()
    if (typeof ptyProcess.on === 'function') {
      ptyProcess.on('error', (err) => {
        console.error(`[PTY] Process error for session ${sessionId}:`, err.message);
        session.alive = false;
      });
    }

    // PTY output handler: immediate broadcast with backpressure safety valve.
    // Data is sent instantly to preserve the native terminal streaming feel.
    // Only skips a client if its WebSocket buffer exceeds 64KB (overwhelmed tab).
    ptyProcess.onData((data) => {
      session.appendScrollback(data);

      // Broadcast immediately to all connected WebSocket clients
      for (const ws of session.clients) {
        try {
          if (ws.readyState === 1) { // WebSocket.OPEN
            // Backpressure check: if this client's send buffer exceeds 64KB,
            // it can't keep up — skip it so other terminals stay responsive.
            // Data is preserved in scrollback for reconnection.
            if (ws.bufferedAmount < 65536) {
              ws.send(data);
            }
          }
        } catch (_) {
          session.clients.delete(ws);
        }
      }

      // Throttled lastActive update - fires immediately then at most once per 30s
      if (!session._lastActiveTimer) {
        try {
          const store = getStore();
          if (store.getSession(sessionId)) {
            store.updateSession(sessionId, {});
          }
        } catch (_) {}
        session._lastActiveTimer = setTimeout(() => {
          session._lastActiveTimer = null;
        }, 30000);
      }
    });

    // PTY exit handler
    ptyProcess.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;

      // Send structured exit message to all clients (this one IS JSON)
      const exitMsg = JSON.stringify({ type: 'exit', exitCode });
      for (const ws of session.clients) {
        try {
          if (ws.readyState === 1) {
            ws.send(exitMsg);
          }
        } catch (_) {
          // ignore
        }
      }

      // Update store status
      try {
        const store = getStore();
        store.updateSessionStatus(sessionId, 'stopped', null);
      } catch (_) {
        // Store may not have this session
      }
    });

    // Update store with running status and PID
    try {
      const store = getStore();
      store.updateSessionStatus(sessionId, 'running', ptyProcess.pid);
    } catch (_) {
      // Store may not have this session
    }

    console.log(`[PTY] Spawned session ${sessionId} (PID: ${ptyProcess.pid}) cmd: "${fullCommand}" cwd: "${cwd || process.cwd()}"`);

    // ── Async: detect Claude session UUID from newest JSONL after spawn ──
    // Claude Code creates a JSONL file in ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
    // After a short delay, scan for the newest file and backfill resumeSessionId
    // so future restarts use the precise --resume <uuid> instead of --continue.
    if (resolvedCwd && !resumeSessionId) {
      setTimeout(() => {
        try {
          const claudeDir = path.join(os.homedir(), '.claude', 'projects');
          if (!fs.existsSync(claudeDir)) return;

          // Claude encodes the cwd path as a directory name under ~/.claude/projects/
          // Try multiple encoding patterns: URL-encoded, slash-replaced
          const candidates = fs.readdirSync(claudeDir).filter(d => {
            try {
              const decoded = decodeURIComponent(d);
              const normalizedDecoded = decoded.replace(/[/\\]/g, path.sep);
              const normalizedCwd = resolvedCwd.replace(/[/\\]/g, path.sep);
              return normalizedDecoded === normalizedCwd;
            } catch (_) {
              return false;
            }
          });

          if (candidates.length === 0) return;

          const projDir = path.join(claudeDir, candidates[0]);
          const jsonls = fs.readdirSync(projDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              try {
                return { name: f, mtime: fs.statSync(path.join(projDir, f)).mtimeMs };
              } catch (_) {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);

          if (jsonls.length === 0) return;

          const uuid = jsonls[0].name.replace('.jsonl', '');
          console.log(`[PTY] Detected Claude session UUID for ${sessionId}: ${uuid}`);

          // Save to store so future restarts use --resume <uuid>
          try {
            const store = getStore();
            if (store.getSession(sessionId)) {
              store.updateSession(sessionId, { resumeSessionId: uuid });
              console.log(`[PTY] Backfilled resumeSessionId=${uuid} for session ${sessionId}`);
            }
          } catch (_) {}

          // Also store on the session object for layout saves
          session.detectedResumeId = uuid;
        } catch (err) {
          console.log(`[PTY] UUID detection failed for ${sessionId}: ${err.message}`);
        }
      }, 8000); // Wait 8s for Claude to create the JSONL file
    }

    return session;
  }

  /**
   * Attach a WebSocket client to a PTY session.
   * If the session doesn't exist, attempts to spawn it from store data.
   *
   * @param {string} sessionId - Session to attach to
   * @param {WebSocket} ws - WebSocket client connection
   * @param {object} [spawnOpts] - Options passed to spawnSession if creating new
   */
  attachClient(sessionId, ws, spawnOpts = {}) {
    let session = this.sessions.get(sessionId);

    // If no live session, try to spawn from store data
    if (!session || !session.alive) {
      try {
        const store = getStore();
        const storeSession = store.getSession(sessionId);
        if (storeSession) {
          console.log(`[PTY] Spawning from store data for ${sessionId}: resumeSessionId=${storeSession.resumeSessionId}, cwd=${storeSession.workingDir}, cmd=${storeSession.command}`);
          session = this.spawnSession(sessionId, {
            command: storeSession.command || 'claude',
            cwd: storeSession.workingDir || undefined,
            bypassPermissions: storeSession.bypassPermissions || false,
            verbose: storeSession.verbose || false,
            model: storeSession.model || null,
            agentTeams: storeSession.agentTeams || false,
            resumeSessionId: storeSession.resumeSessionId || null,
            ...spawnOpts,
          });
        } else {
          console.log(`[PTY] No store data for ${sessionId}, spawning with provided options`);
          // No store data - spawn with provided options
          session = this.spawnSession(sessionId, spawnOpts);
        }
      } catch (err) {
        const reason = 'PTY spawn failed: ' + (err.message || 'unknown error');
        console.error(`[PTY] Failed to spawn session ${sessionId}:`, err.message);
        console.error(`[PTY] Stack:`, err.stack);
        // Send error as JSON message before closing so the client gets the real reason
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: reason }));
          }
        } catch (_) {}
        try { ws.close(1011, reason.substring(0, 123)); } catch (_) {}
        return;
      }
    }

    // spawnSession returns null on failure (e.g. posix_spawnp) without throwing.
    // Guard here so null doesn't propagate to session.clients.add() below.
    if (!session) {
      const reason = 'PTY spawn failed: process could not be started';
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: reason }));
        }
      } catch (_) {}
      try { ws.close(1011, reason.substring(0, 123)); } catch (_) {}
      return;
    }

    // Replay scrollback buffer BEFORE adding to broadcast set.
    // This ensures the client receives the full historical output first,
    // then starts receiving only NEW live data — no interleaving.
    if (session.scrollback.length > 0) {
      const replay = session.scrollback.join('');
      try {
        if (ws.readyState === 1) {
          ws.send(replay);
        }
      } catch (_) {
        // ignore
      }
    }

    // NOW add client to the broadcast set for live PTY data
    session.clients.add(ws);

    // If session already exited, notify this client
    if (!session.alive) {
      try {
        ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode }));
      } catch (_) {}
    }

    // Handle incoming messages from this WebSocket client
    ws.on('message', (raw) => {
      if (!session.alive) return;

      try {
        // Try to parse as JSON control message
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'input' && msg.data !== undefined) {
          // Write user input directly to PTY - NO BUFFERING
          session.pty.write(msg.data);
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          session.pty.resize(
            Math.max(1, Math.min(500, msg.cols)),
            Math.max(1, Math.min(200, msg.rows))
          );
        }
      } catch (_) {
        // Not valid JSON - treat as raw input
        session.pty.write(raw.toString());
      }
    });

    // Handle client disconnect - DON'T kill PTY, it persists for reconnect
    ws.on('close', () => {
      session.clients.delete(ws);
      console.log(`[PTY] Client detached from session ${sessionId} (${session.clients.size} remaining)`);
    });

    ws.on('error', () => {
      session.clients.delete(ws);
    });

    console.log(`[PTY] Client attached to session ${sessionId} (${session.clients.size} clients)`);

    // ── Ping/pong keepalive ──────────────────────────────────
    // Browser WebSockets auto-respond to pings with pongs (RFC 6455).
    // Without keepalive, idle connections get dropped by OS/firewalls,
    // causing terminal flashing on reconnect.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Start a shared ping interval per session (30s cycle)
    if (!session.pingInterval) {
      session.pingInterval = setInterval(() => {
        for (const client of session.clients) {
          if (client.isAlive === false) {
            console.log(`[PTY] Client unresponsive, terminating (session ${sessionId})`);
            client.terminate();
            session.clients.delete(client);
            continue;
          }
          client.isAlive = false;
          try { client.ping(); } catch (_) {
            session.clients.delete(client);
          }
        }
        // Self-clear when all clients disconnect (PTY stays alive for reconnect)
        if (session.clients.size === 0) {
          clearInterval(session.pingInterval);
          session.pingInterval = null;
        }
      }, 30000);
    }
  }

  /**
   * Kill a PTY session and disconnect all clients.
   * @param {string} sessionId
   * @returns {boolean} True if session existed and was killed
   */
  killSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Close all WebSocket clients
    for (const ws of session.clients) {
      try {
        ws.close(1000, 'Session terminated');
      } catch (_) {}
    }
    session.clients.clear();

    // Clear keepalive ping interval
    if (session.pingInterval) {
      clearInterval(session.pingInterval);
      session.pingInterval = null;
    }

    // Kill the PTY process
    if (session.alive) {
      try {
        session.pty.kill();
      } catch (_) {}
      session.alive = false;
    }

    // Remove from map
    this.sessions.delete(sessionId);

    // Update store status
    try {
      const store = getStore();
      store.updateSessionStatus(sessionId, 'stopped', null);
    } catch (_) {}

    console.log(`[PTY] Killed session ${sessionId}`);
    return true;
  }

  /**
   * Destroy all PTY sessions. Called on server shutdown.
   */
  destroyAll() {
    console.log(`[PTY] Destroying all sessions (${this.sessions.size} active)`);
    for (const [sessionId] of this.sessions) {
      this.killSession(sessionId);
    }
  }

  /**
   * List all PTY sessions with summary info.
   * @returns {Array<{sessionId, pid, alive, clientCount, createdAt}>}
   */
  listSessions() {
    const result = [];
    for (const [sessionId, session] of this.sessions) {
      result.push({
        sessionId,
        pid: session.pid,
        alive: session.alive,
        clientCount: session.clients.size,
        createdAt: session.createdAt || null,
      });
    }
    return result;
  }

  /**
   * Get a session by ID.
   * @param {string} sessionId
   * @returns {PtySession|undefined}
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }
}

module.exports = { PtySessionManager };
