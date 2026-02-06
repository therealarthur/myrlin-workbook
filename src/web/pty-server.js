/**
 * WebSocket server for PTY terminal connections.
 *
 * Handles WebSocket upgrade requests on /ws/terminal, authenticates via
 * query-param token, and delegates to PtySessionManager for session lifecycle.
 *
 * Usage:
 *   const { attachPtyWebSocket } = require('./pty-server');
 *   const { ptyWss, ptyManager } = attachPtyWebSocket(httpServer);
 */

const { WebSocketServer } = require('ws');
const url = require('url');
const { isValidToken } = require('./auth');
const { PtySessionManager } = require('./pty-manager');

/**
 * Attach a WebSocket server to an existing HTTP server for PTY terminal access.
 *
 * Listens for upgrade requests on `/ws/terminal` with query parameters:
 *   - token: Required. Valid auth token.
 *   - sessionId: Required. The session to attach to.
 *   - cols: Optional. Terminal columns (default handled by PtySessionManager).
 *   - rows: Optional. Terminal rows.
 *   - cwd: Optional. Working directory for new sessions.
 *   - command: Optional. Command to run (default 'claude').
 *   - bypassPermissions: Optional. If 'true', adds --dangerously-skip-permissions.
 *
 * @param {import('http').Server} httpServer - The Node.js HTTP server instance
 * @returns {{ ptyWss: WebSocketServer, ptyManager: PtySessionManager }}
 */
function attachPtyWebSocket(httpServer) {
  const ptyWss = new WebSocketServer({ noServer: true });
  const ptyManager = new PtySessionManager();

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);

    // Only handle /ws/terminal upgrades
    if (pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }

    // Authenticate via query param token
    const token = query.token;
    if (!isValidToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      console.log('[WS] Rejected unauthenticated WebSocket upgrade');
      return;
    }

    const sessionId = query.sessionId;
    if (!sessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      console.log('[WS] Rejected WebSocket upgrade: missing sessionId');
      return;
    }

    // Complete the WebSocket handshake
    ptyWss.handleUpgrade(request, socket, head, (ws) => {
      ptyWss.emit('connection', ws, request);

      // Build spawn options from query params
      const spawnOpts = {};
      if (query.cols) spawnOpts.cols = parseInt(query.cols, 10);
      if (query.rows) spawnOpts.rows = parseInt(query.rows, 10);
      if (query.cwd) spawnOpts.cwd = query.cwd;
      if (query.command) spawnOpts.command = query.command;
      if (query.resumeSessionId) spawnOpts.resumeSessionId = query.resumeSessionId;
      if (query.bypassPermissions === 'true') spawnOpts.bypassPermissions = true;

      // Attach the client to the PTY session
      ptyManager.attachClient(sessionId, ws, spawnOpts);
    });
  });

  console.log('[WS] PTY WebSocket server attached on /ws/terminal');
  return { ptyWss, ptyManager };
}

module.exports = { attachPtyWebSocket };
