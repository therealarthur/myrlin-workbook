/**
 * The mobile v2 stream: one authenticated WebSocket per paired phone at
 * /ws/m/v2 (PROTOCOL.md 5).
 *
 * What: upgrade authentication through B1's auth.authenticateUpgrade, the
 * myrlin.v2 subprotocol, topics and their scopes, the envelope and $control
 * frames, per topic seq with replay and resync (./rings.js), heartbeat and
 * the close codes of 5.6, backpressure, the command rate limits, token
 * renewal through the auth command, scope loss and revocation.
 *
 * Why: the phone never polls for anything the stream carries, and after a
 * reconnect it must be able to prove it missed nothing (critic F12). Every
 * other B2 and B3 module publishes only through hub.publish so seq, epoch and
 * ring bookkeeping have exactly one owner (BUILD-CONTRACT 3.4.3).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { TopicRings } = require('./rings');
const { b64url, log, warn } = require('../chat/common');

const STREAM_PATH = '/ws/m/v2';
const SUBPROTOCOL = 'myrlin.v2';
const HEARTBEAT_MS = 20000;
const DEAD_PEER_MS = 40000;
const IDLE_TIMEOUT_MS = 60000;
const TOKEN_GRACE_MS = 60000;
const DEFAULT_TOKEN_LIFE_MS = 15 * 60 * 1000;
const MAX_SOCKETS_PER_DEVICE = 2;
const MAX_TOPICS = 64;
const COMMAND_WINDOW_MS = 10000;
const MAX_COMMANDS_PER_WINDOW = 50;
const MAX_BAD_COMMANDS = 3;
const SEND_BUFFER_LIMIT = 4 * 1024 * 1024;
const SERVER_FRAME_MAX = 1024 * 1024;
const CLIENT_FRAME_MAX = 64 * 1024;
const COMMAND_ID_MAX = 64;

const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TOKEN_EXPIRED: 4001,
  BAD_COMMANDS: 4400,
  REVOKED: 4401,
  HEARTBEAT: 4408,
  REPLACED: 4409,
  TOO_MANY_COMMANDS: 4429,
  TOO_SLOW: 4500,
});

/** Topic name to the scope it needs (PROTOCOL.md 5.2); null means none. */
const TOPIC_SCOPES = Object.freeze({
  computer: null,
  device: null,
  sessions: 'chat',
  session: 'chat',
  tabs: 'chat',
  accounts: 'accounts.read',
  migrations: 'chat',
});

const SESSION_TOPIC_RE = /^session:((?:cl|cx|wb)_[A-Za-z0-9._:-]{1,120})$/;
const PLAIN_TOPICS = new Set(['computer', 'device', 'sessions', 'tabs', 'accounts', 'migrations']);

/**
 * Mint a stream epoch: e_ plus 16 base64url chars of 12 random bytes (PROTOCOL.md 0.3).
 * @returns {string}
 */
function mintEpoch() {
  return 'e_' + b64url(crypto.randomBytes(12));
}

/**
 * Parse a topic name into {kind, sessionId}, or null when it is not a topic.
 * @param {string} topic
 * @returns {{kind: string, sessionId: (string|null)}|null}
 */
function parseTopic(topic) {
  if (typeof topic !== 'string') return null;
  if (PLAIN_TOPICS.has(topic)) return { kind: topic, sessionId: null };
  const m = SESSION_TOPIC_RE.exec(topic);
  return m ? { kind: 'session', sessionId: m[1] } : null;
}

/**
 * Write a plain HTTP error answer on a socket that has not been upgraded.
 * @param {import('net').Socket} socket
 * @param {number} status
 * @param {object} body
 * @param {object} [headers]
 */
function writeUpgradeError(socket, status, body, headers) {
  try {
    const payload = JSON.stringify(body);
    const lines = [
      'HTTP/1.1 ' + status + ' ' + (require('http').STATUS_CODES[status] || 'Error'),
      'Content-Type: application/json; charset=utf-8',
      'Cache-Control: no-store',
      'X-Myrlin-Api: 2.0',
      'Connection: close',
      'Content-Length: ' + Buffer.byteLength(payload),
    ];
    for (const [k, v] of Object.entries(headers || {})) lines.push(k + ': ' + v);
    socket.write(lines.join('\r\n') + '\r\n\r\n' + payload);
  } catch (_) { /* socket already gone */ }
  try { socket.destroy(); } catch (_) {}
}

/**
 * Create the stream hub.
 *
 * @param {object} ctx - The mobile context (BUILD-CONTRACT 3.4.1); uses ctx.mobile.auth and ctx.mobile.devices when present.
 * @param {object} [opts] - Timing overrides for tests.
 * @returns {object} The hub (BUILD-CONTRACT 3.4.3 members plus handleUpgrade, attachToServer, close).
 */
function createHub(ctx, opts = {}) {
  const now = opts.now || Date.now;
  const heartbeatMs = opts.heartbeatMs || HEARTBEAT_MS;
  const deadPeerMs = opts.deadPeerMs || DEAD_PEER_MS;
  const tokenGraceMs = opts.tokenGraceMs || TOKEN_GRACE_MS;
  const sendBufferLimit = opts.sendBufferLimit || SEND_BUFFER_LIMIT;
  const epoch = opts.epoch || mintEpoch();
  const rings = new TopicRings({ now, sizes: opts.ringSizes || null });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: CLIENT_FRAME_MAX,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols && protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  /** @type {Set<object>} per socket state */
  const sockets = new Set();
  const subscribeHooks = new Set();
  const unsubscribeHooks = new Set();
  const unsubs = [];
  let sessionResolver = () => true;
  let closed = false;

  const mobile = () => (ctx && ctx.mobile) || {};

  /**
   * Scopes of a device right now: the device record when B1 exposes it (scope
   * edits apply at once, PROTOCOL.md 2.9), else what the socket authenticated with.
   * @param {object} st
   * @returns {string[]}
   */
  function currentScopes(st) {
    try {
      const d = mobile().devices && mobile().devices.get ? mobile().devices.get(st.deviceId) : null;
      if (d && Array.isArray(d.scopes)) return d.scopes;
    } catch (_) { /* fall back */ }
    return st.scopes || [];
  }

  /**
   * Send a raw frame object; closes a socket that reads too slowly.
   * @param {object} st
   * @param {object} frame
   * @returns {boolean}
   */
  function sendFrame(st, frame) {
    if (!st.ws || st.ws.readyState !== 1) return false;
    let text;
    try { text = JSON.stringify(frame); } catch (_) { return false; }
    if (Buffer.byteLength(text) > SERVER_FRAME_MAX) {
      warn('stream frame over 1 MiB dropped', frame.topic, frame.type);
      return false;
    }
    try { st.ws.send(text); } catch (_) { return false; }
    if (st.ws.bufferedAmount > sendBufferLimit) {
      closeSocket(st, CLOSE.TOO_SLOW, 'TOO_SLOW');
      return false;
    }
    return true;
  }

  /**
   * Send a $control frame.
   * @param {object} st
   * @param {string} type
   * @param {object} data
   */
  function control(st, type, data) {
    sendFrame(st, { topic: '$control', seq: 0, epoch, ts: now(), type, data });
  }

  /**
   * Envelope for a stored event on a topic.
   * @param {string} topic - Topic name as the phone sees it.
   * @param {{seq:number, ts:number, type:string, data:object}} ev
   * @returns {object}
   */
  function envelope(topic, ev) {
    return { topic, seq: ev.seq, epoch, ts: ev.ts, type: ev.type, data: ev.data };
  }

  /**
   * The ring key of a topic for one socket (device events are per device).
   * @param {object} st
   * @param {string} topic
   * @returns {string}
   */
  function keyFor(st, topic) {
    return topic === 'device' ? 'device:' + st.deviceId : topic;
  }

  function fireHooks(set, topic, deviceId) {
    for (const fn of set) {
      try { fn(topic, deviceId); } catch (err) { warn('stream hook failed', err && err.message); }
    }
  }

  /**
   * Add a topic to a socket and fire the subscribe hooks.
   * @param {object} st
   * @param {string} topic
   */
  function addTopic(st, topic) {
    if (st.topics.has(topic)) return;
    st.topics.add(topic);
    fireHooks(subscribeHooks, topic, st.deviceId);
  }

  /**
   * Remove a topic from a socket and fire the unsubscribe hooks.
   * @param {object} st
   * @param {string} topic
   */
  function removeTopic(st, topic) {
    if (!st.topics.delete(topic)) return;
    fireHooks(unsubscribeHooks, topic, st.deviceId);
  }

  /**
   * Close one socket with a code and forget it.
   * @param {object} st
   * @param {number} code
   * @param {string} reason
   */
  function closeSocket(st, code, reason) {
    if (st.closing) return;
    st.closing = true;
    try { st.ws.close(code, reason); } catch (_) {}
    const t = setTimeout(() => { try { st.ws.terminate(); } catch (_) {} }, 2000);
    if (t.unref) t.unref();
    detach(st);
  }

  /**
   * Forget a socket and release its topics.
   * @param {object} st
   */
  function detach(st) {
    if (!sockets.has(st)) return;
    sockets.delete(st);
    for (const topic of Array.from(st.topics)) removeTopic(st, topic);
  }

  /**
   * Handle one subscribe command.
   * @param {object} st
   * @param {object} cmd
   */
  function onSubscribe(st, cmd) {
    const list = Array.isArray(cmd.topics) ? cmd.topics : null;
    if (!list) return control(st, 'error', { id: cmd.id, error: 'The subscribe command needs a topics list.', code: 'INVALID_COMMAND' });
    const epochMatches = (cmd.epoch === null || cmd.epoch === undefined) ? null : cmd.epoch === epoch;
    const scopes = currentScopes(st);
    const acked = [];
    const replays = [];
    for (const item of list) {
      const topic = item && typeof item === 'object' ? item.topic : item;
      const sinceSeq = item && typeof item === 'object' && Number.isInteger(item.sinceSeq) ? item.sinceSeq : null;
      const parsed = parseTopic(topic);
      if (!parsed) {
        control(st, 'error', { id: cmd.id, error: 'There is no topic named ' + String(topic).slice(0, 80) + '.', code: 'TOPIC_NOT_FOUND' });
        continue;
      }
      const scope = TOPIC_SCOPES[parsed.kind];
      if (scope && !scopes.includes(scope)) {
        control(st, 'error', { id: cmd.id, error: 'This iPhone does not have the ' + scope + ' permission.', code: 'SCOPE_REQUIRED', scope });
        continue;
      }
      if (parsed.kind === 'session') {
        let ok = false;
        try { ok = !!sessionResolver(parsed.sessionId); } catch (_) { ok = false; }
        if (!ok) {
          control(st, 'error', { id: cmd.id, error: 'That session does not exist on this computer.', code: 'SESSION_NOT_FOUND' });
          continue;
        }
      }
      if (!st.topics.has(topic) && st.topics.size >= MAX_TOPICS) {
        control(st, 'error', { id: cmd.id, error: 'One connection can follow at most 64 topics.', code: 'TOPIC_LIMIT' });
        continue;
      }
      const d = rings.decide(keyFor(st, topic), { epochMatches, sinceSeq });
      if (d.mode === 'resync') control(st, 'resync', { topic, reason: d.reason, currentSeq: d.currentSeq });
      addTopic(st, topic);
      acked.push({ topic, currentSeq: d.currentSeq, replayed: d.events.length, mode: d.mode });
      if (d.events.length) replays.push({ topic, events: d.events });
    }
    control(st, 'subscribed', { id: cmd.id, topics: acked });
    for (const r of replays) {
      for (const ev of r.events) sendFrame(st, envelope(r.topic, ev));
    }
  }

  /**
   * Handle one unsubscribe command.
   * @param {object} st
   * @param {object} cmd
   */
  function onUnsubscribe(st, cmd) {
    const list = Array.isArray(cmd.topics) ? cmd.topics : [];
    const removed = [];
    for (const topic of list) {
      if (topic === 'computer' || topic === 'device') continue;
      if (st.topics.has(topic)) { removeTopic(st, topic); removed.push(topic); }
    }
    control(st, 'unsubscribed', { id: cmd.id, topics: removed });
  }

  /**
   * Handle the auth command: a newer token of the same device renews the socket.
   * @param {object} st
   * @param {object} cmd
   */
  function onAuth(st, cmd) {
    const auth = mobile().auth;
    let result = null;
    try {
      if (!auth || typeof auth.authenticateUpgrade !== 'function' || typeof cmd.token !== 'string') throw new Error('no auth');
      result = auth.authenticateUpgrade({ headers: { authorization: 'Bearer ' + cmd.token }, url: STREAM_PATH, method: 'GET' });
    } catch (_) { result = null; }
    if (!result || result.deviceId !== st.deviceId) {
      return control(st, 'error', { id: cmd.id, error: 'That token was not accepted.', code: 'AUTH_FAILED' });
    }
    st.expiresAtMs = Number.isFinite(result.expiresAtMs) ? result.expiresAtMs : now() + DEFAULT_TOKEN_LIFE_MS;
    if (Array.isArray(result.scopes)) st.scopes = result.scopes;
    control(st, 'authed', { id: cmd.id, expiresAtMs: st.expiresAtMs });
  }

  /**
   * Parse, rate limit and dispatch one client frame.
   * @param {object} st
   * @param {Buffer|string} raw
   */
  function onMessage(st, raw) {
    st.lastFrameAt = now();
    const t = now();
    st.cmdTimes.push(t);
    while (st.cmdTimes.length && st.cmdTimes[0] < t - COMMAND_WINDOW_MS) st.cmdTimes.shift();
    if (st.cmdTimes.length > MAX_COMMANDS_PER_WINDOW) return closeSocket(st, CLOSE.TOO_MANY_COMMANDS, 'TOO_MANY_COMMANDS');
    let cmd = null;
    try { cmd = JSON.parse(raw.toString()); } catch (_) { cmd = null; }
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.type !== 'string') {
      st.badCount += 1;
      if (st.badCount >= MAX_BAD_COMMANDS) return closeSocket(st, CLOSE.BAD_COMMANDS, 'BAD_COMMANDS');
      return control(st, 'error', { id: null, error: 'That command could not be read.', code: 'INVALID_COMMAND' });
    }
    if (cmd.id !== undefined && (typeof cmd.id !== 'string' || cmd.id.length > COMMAND_ID_MAX)) cmd.id = null;
    if (cmd.id === undefined) cmd.id = null;
    switch (cmd.type) {
      case 'subscribe': return onSubscribe(st, cmd);
      case 'unsubscribe': return onUnsubscribe(st, cmd);
      case 'ping': return control(st, 'pong', { id: cmd.id, ts: Number.isFinite(cmd.ts) ? cmd.ts : null, serverTs: now() });
      case 'auth': return onAuth(st, cmd);
      default: return control(st, 'error', { id: cmd.id, error: 'Unknown command ' + String(cmd.type).slice(0, 40) + '.', code: 'UNKNOWN_COMMAND' });
    }
  }

  /**
   * Answer an HTTP upgrade for /ws/m/v2. Returns false for any other path so
   * the caller (B1's listener) can answer 404.
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} socket
   * @param {Buffer} head
   * @returns {boolean}
   */
  function handleUpgrade(req, socket, head) {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) { pathname = ''; }
    if (pathname !== STREAM_PATH) return false;
    if (closed) { writeUpgradeError(socket, 503, { error: 'The phone connection is restarting.', code: 'SERVICE_UNAVAILABLE', retryAfterMs: 1000 }, { 'Retry-After': '1' }); return true; }
    if (req.headers.origin !== undefined) {
      writeUpgradeError(socket, 403, { error: 'Web pages cannot use the phone connection.', code: 'WEB_ORIGIN_REFUSED' });
      return true;
    }
    const protoHeader = String(req.headers['sec-websocket-protocol'] || '');
    if (!protoHeader.split(',').map((s) => s.trim()).includes(SUBPROTOCOL)) {
      writeUpgradeError(socket, 400, { error: 'The stream needs the myrlin.v2 subprotocol.', code: 'SUBPROTOCOL_REQUIRED' });
      return true;
    }
    let auth = null;
    try {
      const a = mobile().auth;
      if (!a || typeof a.authenticateUpgrade !== 'function') throw Object.assign(new Error('Sign in again.'), { status: 401, code: 'AUTH_REQUIRED' });
      auth = a.authenticateUpgrade(req);
      if (!auth || !auth.deviceId) throw Object.assign(new Error('Sign in again.'), { status: 401, code: 'AUTH_REQUIRED' });
    } catch (err) {
      const status = err && Number.isInteger(err.status) ? err.status : 401;
      const body = Object.assign({ error: (err && err.message) || 'Sign in again.', code: (err && err.code) || 'AUTH_REQUIRED' }, (err && err.extra) || {});
      const headers = status === 429 && body.retryAfterMs ? { 'Retry-After': String(Math.ceil(body.retryAfterMs / 1000)) } : {};
      writeUpgradeError(socket, status, body, headers);
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth));
    return true;
  }

  /**
   * A new authenticated socket: enforce the per device limit, send ready.
   * @param {import('ws').WebSocket} ws
   * @param {{deviceId: string, scopes: string[], expiresAtMs?: number}} auth
   */
  function onConnection(ws, auth) {
    const st = {
      ws,
      deviceId: auth.deviceId,
      scopes: Array.isArray(auth.scopes) ? auth.scopes : [],
      expiresAtMs: Number.isFinite(auth.expiresAtMs) ? auth.expiresAtMs : now() + DEFAULT_TOKEN_LIFE_MS,
      topics: new Set(),
      cmdTimes: [],
      badCount: 0,
      lastFrameAt: now(),
      pingSentAt: 0,
      connectedAt: now(),
      closing: false,
    };
    const mine = Array.from(sockets).filter((s) => s.deviceId === st.deviceId).sort((a, b) => a.connectedAt - b.connectedAt);
    while (mine.length >= MAX_SOCKETS_PER_DEVICE) closeSocket(mine.shift(), CLOSE.REPLACED, 'REPLACED');
    sockets.add(st);
    ws.on('message', (raw) => onMessage(st, raw));
    ws.on('pong', () => { st.lastFrameAt = now(); });
    ws.on('close', () => detach(st));
    ws.on('error', () => detach(st));
    addTopic(st, 'computer');
    addTopic(st, 'device');
    control(st, 'ready', {
      streamEpoch: epoch,
      deviceId: st.deviceId,
      serverTs: now(),
      heartbeatIntervalMs: HEARTBEAT_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      maxTopics: MAX_TOPICS,
      topics: [
        { topic: 'computer', currentSeq: rings.currentSeq('computer') },
        { topic: 'device', currentSeq: rings.currentSeq(keyFor(st, 'device')) },
      ],
    });
    if (typeof opts.onConnect === 'function') {
      try { opts.onConnect(st.deviceId); } catch (_) {}
    }
  }

  /** Heartbeat tick: dead peers, expired tokens, pings. */
  function tick() {
    const t = now();
    for (const st of Array.from(sockets)) {
      if (st.expiresAtMs && t > st.expiresAtMs + tokenGraceMs) { closeSocket(st, CLOSE.TOKEN_EXPIRED, 'TOKEN_EXPIRED'); continue; }
      if (st.pingSentAt && st.lastFrameAt < st.pingSentAt && t - st.pingSentAt >= deadPeerMs) { closeSocket(st, CLOSE.HEARTBEAT, 'HEARTBEAT'); continue; }
      if (!st.pingSentAt || st.lastFrameAt >= st.pingSentAt) {
        st.pingSentAt = t;
        try { st.ws.ping(); } catch (_) {}
      }
    }
  }
  const timer = setInterval(tick, Math.max(50, Math.min(heartbeatMs, deadPeerMs / 2)));
  if (timer.unref) timer.unref();

  /**
   * Publish an event on a topic (not the per device topic).
   * @param {string} topic
   * @param {string} type
   * @param {object} data
   * @returns {number} The event's seq.
   */
  function publish(topic, type, data) {
    const parsed = parseTopic(topic);
    if (!parsed || topic === 'device') throw new Error('invalid topic ' + topic);
    const ev = rings.append(topic, type, data || {});
    const frame = envelope(topic, ev);
    for (const st of sockets) {
      if (st.topics.has(topic)) sendFrame(st, frame);
    }
    return ev.seq;
  }

  /**
   * Publish an event on one device's `device` topic.
   * @param {string} deviceId
   * @param {string} type
   * @param {object} data
   * @returns {number}
   */
  function publishDevice(deviceId, type, data) {
    const ev = rings.append('device:' + deviceId, type, data || {});
    const frame = envelope('device', ev);
    for (const st of sockets) {
      if (st.deviceId === deviceId && st.topics.has('device')) sendFrame(st, frame);
    }
    return ev.seq;
  }

  /**
   * Drop topics a device may no longer read (PROTOCOL.md 5.2).
   * @param {string} deviceId
   * @param {string[]} scopes
   */
  function onScopesChanged(deviceId, scopes) {
    for (const st of sockets) {
      if (st.deviceId !== deviceId) continue;
      st.scopes = Array.isArray(scopes) ? scopes : [];
      const dropped = [];
      for (const topic of Array.from(st.topics)) {
        const p = parseTopic(topic);
        const need = p ? TOPIC_SCOPES[p.kind] : null;
        if (need && !st.scopes.includes(need)) {
          control(st, 'error', { id: null, error: 'This iPhone lost the ' + need + ' permission.', code: 'SCOPE_REQUIRED', scope: need });
          removeTopic(st, topic);
          dropped.push(topic);
        }
      }
      if (dropped.length) control(st, 'unsubscribed', { id: null, topics: dropped });
    }
  }

  /**
   * Close every socket of a device.
   * @param {string} deviceId
   * @param {number} code
   * @param {string} reason
   */
  function closeDevice(deviceId, code, reason) {
    for (const st of Array.from(sockets)) {
      if (st.deviceId === deviceId) closeSocket(st, code, reason);
    }
  }

  // B1 hooks, when B1 is mounted.
  try {
    const m = mobile();
    if (m.devices && typeof m.devices.onRevoked === 'function') unsubs.push(m.devices.onRevoked((id) => closeDevice(id, CLOSE.REVOKED, 'DEVICE_REVOKED')));
    if (m.auth && typeof m.auth.onTokenRevoked === 'function') unsubs.push(m.auth.onTokenRevoked((id) => closeDevice(id, CLOSE.REVOKED, 'DEVICE_REVOKED')));
    if (m.devices && typeof m.devices.onScopesChanged === 'function') unsubs.push(m.devices.onScopesChanged(onScopesChanged));
  } catch (err) { warn('stream could not register device hooks', err && err.message); }

  const hub = {
    epoch,
    publish,
    publishDevice,
    currentSeq: (topic) => rings.currentSeq(topic),
    isDeviceConnected: (deviceId) => Array.from(sockets).some((s) => s.deviceId === deviceId && !s.closing),
    connectedDevices: () => Array.from(new Set(Array.from(sockets).map((s) => s.deviceId))),
    closeDevice,
    onScopesChanged,
    onSubscribe(fn) { subscribeHooks.add(fn); return () => subscribeHooks.delete(fn); },
    onUnsubscribe(fn) { unsubscribeHooks.add(fn); return () => unsubscribeHooks.delete(fn); },
    /** Who follows a topic right now (device ids). */
    subscribersOf(topic) { return Array.from(sockets).filter((s) => s.topics.has(topic)).map((s) => s.deviceId); },
    setSessionResolver(fn) { if (typeof fn === 'function') sessionResolver = fn; },
    handleUpgrade,
    /**
     * Listen for upgrades on an http.Server directly (used by tests and when
     * B1's listener exposes its server instead of routing upgrades itself).
     * @param {import('http').Server} server
     */
    attachToServer(server) {
      const onUp = (req, socket, head) => {
        if (!handleUpgrade(req, socket, head)) writeUpgradeError(socket, 404, { error: 'Not found.', code: 'NOT_FOUND' });
      };
      server.on('upgrade', onUp);
      unsubs.push(() => server.removeListener('upgrade', onUp));
    },
    /**
     * Close every socket and stop the heartbeat.
     * @param {number} [code=1001]
     * @param {string} [reason]
     */
    close(code = CLOSE.GOING_AWAY, reason = 'SHUTDOWN') {
      closed = true;
      clearInterval(timer);
      for (const st of Array.from(sockets)) closeSocket(st, code, reason);
      for (const u of unsubs.splice(0)) { try { u(); } catch (_) {} }
      try { wss.close(); } catch (_) {}
    },
    stats() { return { sockets: sockets.size, epoch }; },
  };
  log('stream hub ready, epoch minted');
  return hub;
}

module.exports = {
  createHub,
  mintEpoch,
  parseTopic,
  STREAM_PATH,
  SUBPROTOCOL,
  CLOSE,
  TOPIC_SCOPES,
  MAX_TOPICS,
  HEARTBEAT_MS,
  DEAD_PEER_MS,
};
