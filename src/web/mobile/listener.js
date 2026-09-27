/**
 * listener.js: the mobile http.Server, a second listener beside the main
 * Workbook server that serves only /api/m/v2/* and the /ws/m/v2 upgrade.
 *
 * WHY: A2 and critic F8. Tailscale Serve points at this loopback port and
 * never at 3457, so a tailnet device can reach only the phone protocol, never
 * the desktop page, the PTY socket or /api/update. Rules (PROTOCOL.md 1.1):
 * loopback bind only, any Origin header refused (a browser always sends one),
 * 1 MiB bodies, X-Myrlin-Api on every response, a request log with method and
 * path only (never a query string, W3), 404 and 405 for everything else.
 */
'use strict';

const http = require('http');
const errors = require('./errors');
const { parseUrl } = require('./router');
const { STREAM_PATH, API_PREFIX } = require('./scope-table');
const { isLoopbackHost } = require('./context');

/** Grace before remaining sockets are destroyed on stop. */
const STOP_GRACE_MS = 250;
/** WebSocket close code for a listener restart (PROTOCOL.md 5.6). */
const CLOSE_SERVICE_RESTART = 1012;
/** Header timeouts, generous for the pair long poll (25 s). */
const KEEP_ALIVE_MS = 65000;
const HEADERS_TIMEOUT_MS = 70000;

/**
 * Write a protocol error on a raw socket before any upgrade.
 *
 * @param {object} socket - net.Socket.
 * @param {number} status - HTTP status.
 * @param {string} code - Protocol code.
 * @param {string} [message] - Sentence.
 * @param {object} [extra] - Extra fields.
 */
function rejectUpgrade(socket, status, code, message, extra) {
  const body = JSON.stringify(errors.errorBody(code, message, extra));
  const lines = [
    'HTTP/1.1 ' + status + ' ' + (http.STATUS_CODES[status] || 'Error'),
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    errors.API_HEADER + ': ' + errors.API_HEADER_VALUE,
    'Content-Length: ' + Buffer.byteLength(body),
    'Connection: close',
  ];
  if (extra && typeof extra.retryAfterMs === 'number') lines.push('Retry-After: ' + Math.max(1, Math.ceil(extra.retryAfterMs / 1000)));
  try {
    socket.write(lines.join('\r\n') + '\r\n\r\n' + body);
  } catch (_) { /* socket already gone */ }
  try { socket.destroy(); } catch (_) { /* ignore */ }
}

/**
 * Create the listener.
 *
 * @param {object} deps - {router, auth, getSettings(), getHub(), log}.
 * @returns {object} {start, stop, status, server()}
 */
function createListener(deps) {
  const log = deps.log || ((m) => console.log(m));
  let server = null;
  let running = false;
  let lastError = null;
  let boundPort = null;
  let boundHost = null;
  const sockets = new Set();

  /**
   * Handle one HTTP request.
   *
   * @param {object} req - Request.
   * @param {object} res - Response.
   */
  function onRequest(req, res) {
    const started = Date.now();
    errors.setProtocolHeaders(res);
    const url = parseUrl(req);
    const pathOnly = url ? url.pathname : '/';
    res.on('finish', () => {
      log('[mobile] ' + req.method + ' ' + pathOnly + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms');
    });
    const run = async () => {
      if (req.headers.origin !== undefined) throw errors.fail('WEB_ORIGIN_REFUSED');
      if (!url) throw errors.fail('NOT_FOUND');
      if (url.pathname === STREAM_PATH) throw errors.fail('SUBPROTOCOL_REQUIRED');
      if (!url.pathname.startsWith(API_PREFIX + '/')) throw errors.fail('NOT_FOUND');
      await deps.router.dispatch(req, res, url);
    };
    run().catch((err) => {
      if (res.headersSent || res.writableEnded) return;
      errors.sendThrown(res, err, log);
    });
  }

  /**
   * Handle a WebSocket upgrade: Origin, path, authentication, then hand the
   * socket to B2's hub (BUILD-CONTRACT 3.4.2: hub.handleUpgrade).
   *
   * @param {object} req - Upgrade request.
   * @param {object} socket - net.Socket.
   * @param {Buffer} head - First packet.
   */
  function onUpgrade(req, socket, head) {
    const url = parseUrl(req);
    const pathOnly = url ? url.pathname : '/';
    log('[mobile] UPGRADE ' + pathOnly);
    if (req.headers.origin !== undefined) return rejectUpgrade(socket, 403, 'WEB_ORIGIN_REFUSED');
    if (!url || url.pathname !== STREAM_PATH) return rejectUpgrade(socket, 404, 'NOT_FOUND');
    let auth;
    try {
      auth = deps.auth.authenticateUpgrade(req);
    } catch (err) {
      const e = err && err.code ? err : errors.fail('INTERNAL');
      return rejectUpgrade(socket, e.status, e.code, e.message, e.extra);
    }
    const hub = deps.getHub();
    if (!hub || typeof hub.handleUpgrade !== 'function') {
      return rejectUpgrade(socket, 404, 'NOT_FOUND', 'The stream is not served by this computer yet.');
    }
    req.mobileAuth = auth;
    try {
      hub.handleUpgrade(req, socket, head, auth);
    } catch (err) {
      log('[mobile] stream upgrade failed: ' + (err && err.message));
      rejectUpgrade(socket, 500, 'INTERNAL');
    }
  }

  /**
   * Start listening with the current settings. Resolves with the status; a
   * non loopback host or a bind error leaves it stopped with `error` set.
   *
   * @returns {Promise<object>}
   */
  function start() {
    if (running) return Promise.resolve(status());
    const s = deps.getSettings();
    lastError = null;
    if (!isLoopbackHost(s.host)) {
      lastError = 'The phone listener binds only 127.0.0.1 or ::1; "' + String(s.host).slice(0, 60) + '" was refused.';
      log('[mobile] ' + lastError);
      return Promise.resolve(status());
    }
    return new Promise((resolve) => {
      const srv = http.createServer(onRequest);
      srv.keepAliveTimeout = KEEP_ALIVE_MS;
      srv.headersTimeout = HEADERS_TIMEOUT_MS;
      srv.on('upgrade', onUpgrade);
      srv.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });
      srv.once('error', (err) => {
        lastError = err && err.code === 'EADDRINUSE'
          ? 'Port ' + s.port + ' is already in use on ' + s.host + '.'
          : 'The phone listener could not start (' + ((err && err.code) || 'error') + ').';
        lastError = String(lastError);
        running = false;
        server = null;
        log('[mobile] ' + lastError);
        resolve(Object.assign(status(), { errorCode: err && err.code }));
      });
      srv.listen(s.port, s.host.trim(), () => {
        server = srv;
        running = true;
        const addr = srv.address();
        boundPort = addr && addr.port;
        boundHost = s.host.trim();
        log('[mobile] listening on ' + boundHost + ':' + boundPort);
        resolve(status());
      });
    });
  }

  /**
   * Stop listening: stream sockets close with 1012 through the hub, the HTTP
   * server closes, and remaining sockets are destroyed after a short grace.
   * Never touches the main server or any PTY.
   *
   * @returns {Promise<void>}
   */
  function stop() {
    const srv = server;
    if (!srv) {
      running = false;
      return Promise.resolve();
    }
    const hub = deps.getHub();
    if (hub && typeof hub.closeAll === 'function') {
      try { hub.closeAll(CLOSE_SERVICE_RESTART, 'Listener restart'); } catch (_) { /* best effort */ }
    }
    running = false;
    server = null;
    return new Promise((resolve) => {
      srv.close(() => resolve());
      const t = setTimeout(() => {
        for (const sock of sockets) { try { sock.destroy(); } catch (_) { /* ignore */ } }
        sockets.clear();
      }, STOP_GRACE_MS);
      if (t.unref) t.unref();
      if (typeof srv.closeIdleConnections === 'function') srv.closeIdleConnections();
    });
  }

  /** @returns {{running: boolean, error: string|null, port: number|null, host: string|null}} */
  function status() {
    return { running, error: lastError, port: running ? boundPort : null, host: running ? boundHost : null };
  }

  return { start, stop, status, server: () => server, CLOSE_SERVICE_RESTART };
}

module.exports = { createListener, rejectUpgrade, CLOSE_SERVICE_RESTART };
