/**
 * Test only stand in for B1's parts of the mobile context (BUILD-CONTRACT 3.4.2).
 *
 * What: a router with route(method, path, handler) that authenticates bearer
 * tokens of fake devices, checks the route's scope (PROTOCOL.md 2.10 for the
 * chat routes), parses JSON bodies and answers 401, 403, 404, 405 like B1's;
 * errors with MobileError and send; auth.authenticateUpgrade; devices with
 * onRevoked and onScopesChanged; audit and push recorders; and a loopback
 * listener on port 0 that routes /ws/m/v2 upgrades to the hub.
 *
 * Why: B1 and B2 are built in parallel (wave B); B2's tests code against the
 * interface and switch to B1's harness at rebase.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { LocalMobileError, sendJson, errorBody } = require('../../../src/web/mobile/chat/common');

/** Scopes of the chat routes (PROTOCOL.md 2.10). */
const ROUTE_SCOPES = {
  'POST /sessions/:sessionId/restart': 'sessions.manage',
  'POST /sessions/:sessionId/stop': 'sessions.manage',
  'POST /sessions/:sessionId/continue-here': 'sessions.manage',
  'POST /sessions/:sessionId/resume-anyway': 'sessions.manage',
  'POST /sessions/:sessionId/branch': 'sessions.manage',
  'POST /sessions': 'sessions.manage',
  'POST /uploads': 'media.upload',
  'GET /uploads/:uploadId': 'media.upload',
  'PUT /uploads/:uploadId/chunks': 'media.upload',
  'POST /uploads/:uploadId/complete': 'media.upload',
  'DELETE /uploads/:uploadId': 'media.upload',
  'GET /uploads/:uploadId/content': 'media.upload',
};
const DEFAULT_SCOPES = ['accounts.read', 'accounts.swap', 'chat', 'media.upload', 'search', 'sessions.manage'];
const TOKEN_LIFE_MS = 15 * 60 * 1000;

/**
 * @returns {object} stub parts plus helpers
 */
function createB1Stub() {
  const routes = [];
  const devices = new Map();
  const tokens = new Map();
  const revoked = new Set();
  const revokeHooks = new Set();
  const scopeHooks = new Set();
  const auditEntries = [];
  const pushEvents = [];

  function authFrom(header) {
    const m = /^Bearer (.+)$/.exec(String(header || ''));
    if (!m) throw new LocalMobileError(401, 'AUTH_REQUIRED', 'Sign in again.');
    const t = tokens.get(m[1]);
    if (!t) throw new LocalMobileError(401, 'AUTH_REQUIRED', 'Sign in again.');
    if (revoked.has(t.deviceId)) throw new LocalMobileError(401, 'DEVICE_REVOKED', 'This iPhone was removed.');
    if (Date.now() > t.expiresAtMs) throw new LocalMobileError(401, 'SESSION_EXPIRED', 'Sign in again.');
    const d = devices.get(t.deviceId);
    return { deviceId: t.deviceId, scopes: d.scopes.slice(), device: d, expiresAtMs: t.expiresAtMs };
  }

  const router = {
    route(method, pattern, handler) { routes.push({ method, pattern, parts: pattern.split('/'), handler }); },
    routes,
    /** The http request handler. */
    async handle(req, res) {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) { pathname = ''; }
      if (!pathname.startsWith('/api/m/v2/')) return sendJson(res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
      const rel = pathname.slice('/api/m/v2'.length);
      const segs = rel.split('/');
      const matches = routes.filter((r) => r.parts.length === segs.length && r.parts.every((p, i) => p.startsWith(':') || p === segs[i]));
      // Prefer literal segments over parameters (/sessions/recent before /sessions/:sessionId).
      matches.sort((a, b) => a.parts.filter((p) => p.startsWith(':')).length - b.parts.filter((p) => p.startsWith(':')).length);
      if (!matches.length) return sendJson(res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
      const r = matches.find((x) => x.method === req.method && x.parts.every((p, i) => p.startsWith(':') || p === segs[i]));
      if (!r) return sendJson(res, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
      const params = {};
      r.parts.forEach((p, i) => { if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]); });
      req.params = params;
      let auth;
      try { auth = authFrom(req.headers.authorization); } catch (err) { const e = errorBody(err); return sendJson(res, e.status, e.body); }
      const scope = ROUTE_SCOPES[r.method + ' ' + r.pattern] || 'chat';
      if (!auth.scopes.includes(scope)) return sendJson(res, 403, { error: 'This iPhone needs the ' + scope + ' permission.', code: 'SCOPE_REQUIRED', scope });
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && /json/.test(String(req.headers['content-type'] || ''))) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        try { req.body = text ? JSON.parse(text) : {}; } catch (_) { return sendJson(res, 400, { error: 'The request body is not JSON.', code: 'INVALID_JSON' }); }
      }
      try { await r.handler(req, res, auth); } catch (err) { const e = errorBody(err); if (!res.headersSent) sendJson(res, e.status, e.body); }
    },
  };

  const mobile = {
    router,
    errors: { MobileError: LocalMobileError, send: (res, status, code, message, extra) => sendJson(res, status, Object.assign({ error: message, code }, extra || {})) },
    auth: {
      authenticateUpgrade(req) { return authFrom(req.headers && (req.headers.authorization || req.headers.Authorization)); },
      authenticate(req) { return authFrom(req.headers && req.headers.authorization); },
      onTokenRevoked(fn) { revokeHooks.add(fn); return () => revokeHooks.delete(fn); },
    },
    devices: {
      get: (id) => devices.get(id) || null,
      onRevoked(fn) { revokeHooks.add(fn); return () => revokeHooks.delete(fn); },
      onScopesChanged(fn) { scopeHooks.add(fn); return () => scopeHooks.delete(fn); },
    },
    audit: { write: (e) => auditEntries.push(Object.assign({ ts: Date.now() }, e)) },
    push: { notify: async (e) => { pushEvents.push(e); } },
  };

  return {
    mobile,
    auditEntries,
    pushEvents,
    /**
     * A paired device with a live token.
     * @param {string[]} [scopes]
     * @param {number} [lifeMs]
     * @returns {{deviceId: string, token: string}}
     */
    addDevice(scopes, lifeMs) {
      const deviceId = 'd_' + crypto.randomBytes(15).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').slice(0, 20);
      devices.set(deviceId, { deviceId, scopes: (scopes || DEFAULT_SCOPES).slice(), preferences: {} });
      return { deviceId, token: this.mintToken(deviceId, lifeMs) };
    },
    mintToken(deviceId, lifeMs) {
      const token = crypto.randomBytes(32).toString('base64url');
      tokens.set(token, { deviceId, expiresAtMs: Date.now() + (lifeMs || TOKEN_LIFE_MS) });
      return token;
    },
    setScopes(deviceId, scopes) { devices.get(deviceId).scopes = scopes.slice(); for (const fn of scopeHooks) fn(deviceId, scopes.slice()); },
    revoke(deviceId) { revoked.add(deviceId); for (const fn of revokeHooks) fn(deviceId); },
    /**
     * Start a loopback listener on port 0 for the router and the hub.
     * @param {object} ctx - with ctx.mobile.hub set after mountChat
     * @returns {Promise<{server: http.Server, port: number, base: string, close: Function}>}
     */
    listen(ctx) {
      const server = http.createServer((req, res) => {
        res.setHeader('X-Myrlin-Api', '2.0');
        router.handle(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: 'Internal.', code: 'INTERNAL' }); });
      });
      server.on('upgrade', (req, socket, head) => {
        const hub = ctx.mobile && ctx.mobile.hub;
        if (!hub || !hub.handleUpgrade(req, socket, head)) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); }
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          resolve({ server, port, base: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(() => r())) });
        });
      });
    },
  };
}

module.exports = { createB1Stub, DEFAULT_SCOPES, ROUTE_SCOPES };
