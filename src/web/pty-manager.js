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
  spawnSession(sessionId, { command = 'claude', cwd, cols = 120, rows = 30, bypassPermissions = false, resumeSessionId = null, verbose = false, model = null, agentTeams = false } = {}) {
    // Return existing session if already alive
    const existing = this.sessions.get(sessionId);
    if (existing && existing.alive) {
      return existing;
    }

    // Build full command string
    let fullCommand = command;
    if (resumeSessionId) {
      fullCommand += ' --resume ' + resumeSessionId;
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

    // Validate cwd exists — fall back to home directory if not
    let resolvedCwd = cwd || process.cwd();
    try {
      if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
        console.log(`[PTY] cwd "${resolvedCwd}" does not exist or is not a directory, falling back to home`);
        resolvedCwd = os.homedir();
      }
    } catch (e) {
      console.log(`[PTY] cwd check failed for "${resolvedCwd}": ${e.message}, falling back to home`);
      resolvedCwd = os.homedir();
    }

    // Inject workspace documentation env vars so AI sessions can read/write docs
    const sessionEnv = { ...process.env };
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
      // Non-critical — session can work without docs integration
    }

    console.log(`[PTY] Spawning: cmd.exe /k ${fullCommand} (cwd: ${resolvedCwd})`);

    // Spawn PTY process via cmd.exe on Windows
    const ptyProcess = pty.spawn('cmd.exe', ['/k', fullCommand], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
      env: sessionEnv,
      useConpty: true,
    });

    const session = new PtySession(sessionId, ptyProcess);
    this.sessions.set(sessionId, session);

    // PTY output handler: buffer + broadcast as raw binary (no JSON wrapping)
    ptyProcess.onData((data) => {
      session.appendScrollback(data);

      // Broadcast raw output to all connected WebSocket clients
      for (const ws of session.clients) {
        try {
          if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(data);
          }
        } catch (_) {
          session.clients.delete(ws);
        }
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

    // Add client to the session's client set
    session.clients.add(ws);

    // Replay scrollback buffer so the client sees existing output
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
   * Get a session by ID.
   * @param {string} sessionId
   * @returns {PtySession|undefined}
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }
}

module.exports = { PtySessionManager };
