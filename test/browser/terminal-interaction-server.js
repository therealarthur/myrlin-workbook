#!/usr/bin/env node
/**
 * terminal-interaction-server.js: Hermetic browser fixture for xterm input.
 * Modified: 2026-07-25
 *
 * Serves only checked-in terminal assets plus an in-memory WebSocket endpoint.
 * It never loads Workbook state, credentials, providers, or production APIs.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_HTML = path.join(__dirname, 'terminal-interaction.html');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'src', 'web', 'public');
const HOST = '127.0.0.1';
const REQUESTED_PORT = Number.parseInt(process.argv[2], 10);
const PORT = Number.isInteger(REQUESTED_PORT) && REQUESTED_PORT > 0
  ? REQUESTED_PORT
  : 0;
const CLIENTS = new Set();

const ALLOWED_ASSETS = new Map([
  ['/src/web/public/app.js', path.join(PUBLIC_ROOT, 'app.js')],
  ['/src/web/public/terminal.js', path.join(PUBLIC_ROOT, 'terminal.js')],
  ['/src/web/public/vendor/xterm/xterm.css', path.join(PUBLIC_ROOT, 'vendor', 'xterm', 'xterm.css')],
  ['/src/web/public/vendor/xterm/xterm.min.js', path.join(PUBLIC_ROOT, 'vendor', 'xterm', 'xterm.min.js')],
  ['/src/web/public/vendor/xterm-addon-fit/xterm-addon-fit.min.js',
    path.join(PUBLIC_ROOT, 'vendor', 'xterm-addon-fit', 'xterm-addon-fit.min.js')],
  ['/src/web/public/vendor/xterm-addon-web-links/xterm-addon-web-links.min.js',
    path.join(PUBLIC_ROOT, 'vendor', 'xterm-addon-web-links', 'xterm-addon-web-links.min.js')],
]);

const state = {
  inputFrames: 0,
  mouseEvents: 0,
  hoverMoves: 0,
  leftPresses: 0,
  rightPresses: 0,
  sigintCount: 0,
  pasteCount: 0,
  pastePayloads: [],
  rawInputs: [],
  mode: 'alt',
};

/**
 * Reset all observed client-input counters without touching connected panes.
 * @returns {void}
 */
function resetState() {
  state.inputFrames = 0;
  state.mouseEvents = 0;
  state.hoverMoves = 0;
  state.leftPresses = 0;
  state.rightPresses = 0;
  state.sigintCount = 0;
  state.pasteCount = 0;
  state.pastePayloads = [];
  state.rawInputs = [];
}

/**
 * Return a JSON-safe snapshot of the fixture's observed input state.
 * @returns {object} A detached state object.
 */
function snapshotState() {
  return {
    inputFrames: state.inputFrames,
    mouseEvents: state.mouseEvents,
    hoverMoves: state.hoverMoves,
    leftPresses: state.leftPresses,
    rightPresses: state.rightPresses,
    sigintCount: state.sigintCount,
    pasteCount: state.pasteCount,
    pastePayloads: state.pastePayloads.slice(),
    rawInputs: state.rawInputs.slice(),
    mode: state.mode,
  };
}

/**
 * Send terminal output to every connected fixture pane.
 * @param {string} data - Raw VT output.
 * @returns {void}
 */
function broadcast(data) {
  for (const client of CLIENTS) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

/**
 * Render the mouse-capturing alternate-screen fixture.
 * @returns {void}
 */
function enterAltMode() {
  state.mode = 'alt';
  broadcast(
    '\x1b[?1049h' +
    '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h' +
    '\x1b[2J\x1b[H' +
    'MYRLIN MOUSE-CAPTURING TUI FIXTURE\r\n' +
    'COPY_TARGET_ALPHA_BETA_GAMMA\r\n' +
    'CLICKABLE_OPTION_ONE\r\n' +
    'CLICKABLE_OPTION_TWO\r\n' +
    'ALT_SCREEN_HAS_NO_NORMAL_SCROLLBACK\r\n' +
    'Drag sends mouse reports; Shift+drag must select.\r\n'
  );
}

/**
 * Render more than one viewport of main-buffer content with mouse mode off.
 * @returns {void}
 */
function enterNormalMode() {
  state.mode = 'normal';
  let output =
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l' +
    '\x1b[?1049l\x1b[2J\x1b[H';
  for (let index = 1; index <= 140; index++) {
    output += 'NORMAL_SCROLL_LINE_' + String(index).padStart(3, '0') + '\r\n';
  }
  output += 'NORMAL_SCROLL_BOTTOM\r\n';
  broadcast(output);
}

/**
 * Parse one input frame emitted by TerminalPane and update counters.
 * @param {string} data - Raw terminal input payload.
 * @returns {void}
 */
function observeInput(data) {
  state.inputFrames++;
  state.rawInputs.push(data);
  if (state.rawInputs.length > 100) state.rawInputs.shift();

  for (const byte of Buffer.from(data, 'utf8')) {
    if (byte === 0x03) state.sigintCount++;
  }

  const mousePattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of data.matchAll(mousePattern)) {
    state.mouseEvents++;
    const code = Number(match[1]);
    if (match[4] === 'M' && (code & 32) !== 0 && (code & 3) === 3) {
      state.hoverMoves++;
    }
    if (match[4] === 'M' && (code & 3) === 0) state.leftPresses++;
    if (match[4] === 'M' && (code & 3) === 2) state.rightPresses++;
  }

  const pastePattern = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
  for (const match of data.matchAll(pastePattern)) {
    state.pasteCount++;
    state.pastePayloads.push(match[1]);
  }
}

/**
 * Serve a local file with an explicit content type.
 * @param {http.ServerResponse} response - HTTP response.
 * @param {string} filePath - Absolute file path.
 * @param {string} contentType - Response MIME type.
 * @returns {void}
 */
function serveFile(response, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Fixture read failed: ' + error.message);
  }
}

/**
 * Handle the fixture's deliberately tiny HTTP surface.
 * @param {http.IncomingMessage} request - HTTP request.
 * @param {http.ServerResponse} response - HTTP response.
 * @returns {void}
 */
function handleRequest(request, response) {
  const url = new URL(request.url, 'http://' + (request.headers.host || HOST));

  if (url.pathname === '/' || url.pathname === '/terminal-interaction.html') {
    serveFile(response, FIXTURE_HTML, 'text/html; charset=utf-8');
    return;
  }
  if (url.pathname === '/state') {
    const body = Buffer.from(JSON.stringify(snapshotState()));
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    response.end(body);
    return;
  }
  if (url.pathname === '/reset' && request.method === 'POST') {
    resetState();
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/mode/alt' && request.method === 'POST') {
    enterAltMode();
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/mode/normal' && request.method === 'POST') {
    enterNormalMode();
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  const assetPath = ALLOWED_ASSETS.get(url.pathname);
  if (assetPath) {
    const contentType = url.pathname.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/javascript; charset=utf-8';
    serveFile(response, assetPath, contentType);
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

const server = http.createServer(handleRequest);
const websocketServer = new WebSocketServer({ noServer: true });
let shuttingDown = false;

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://' + (request.headers.host || HOST));
  if (url.pathname !== '/ws/terminal') {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (client) => {
    websocketServer.emit('connection', client);
  });
});

websocketServer.on('connection', (client) => {
  CLIENTS.add(client);
  client.on('close', () => CLIENTS.delete(client));
  client.on('message', (buffer) => {
    try {
      const message = JSON.parse(buffer.toString('utf8'));
      if (message.type === 'input' && typeof message.data === 'string') {
        observeInput(message.data);
      }
    } catch (_) {
      // The production client sends JSON input frames; malformed fixture input
      // is ignored so it cannot crash the local server.
    }
  });
  setTimeout(enterAltMode, 50);
});

/**
 * Close only this fixture's sockets and listener.
 * @returns {void}
 */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of CLIENTS) {
    try { client.close(1001, 'fixture shutdown'); } catch (_) {}
  }
  try { websocketServer.close(); } catch (_) {}
  const finish = () => process.exit(0);
  try {
    server.close(finish);
    setTimeout(finish, 2000).unref();
  } catch (_) {
    finish();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
process.on('message', (message) => {
  if (message && message.type === 'shutdown') shutdown();
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const url = 'http://' + HOST + ':' + address.port + '/';
  if (typeof process.send === 'function') {
    process.send({ type: 'ready', url });
  } else {
    console.log('HARNESS_URL=' + url);
  }
});
