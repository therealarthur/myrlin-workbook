/**
 * scope-table.js: PROTOCOL.md section 2.10 as data, the single source of the
 * scope and limiter class of every route the phone may call.
 *
 * WHY (critic F3): one middleware owns this table, every route on the mobile
 * listener is registered through it, registering a route that is not listed
 * fails at startup, and a contract test compares this table with a hand
 * transcription of the document (test/mobile/fixtures/route-table.json).
 *
 * Scope values: "public" (no token), "none" (any authenticated device), or a
 * scope name. Paths are relative to /api/m/v2, except the stream upgrade.
 * `owner` names the Workbook track that registers the handler (BUILD-CONTRACT
 * 3.2); a route whose owner is not mounted still authenticates and checks its
 * scope, then answers 404.
 */
'use strict';

/** Every scope of revision 0 (PROTOCOL.md 2.10). */
const SCOPES = Object.freeze(['chat', 'sessions.manage', 'accounts.read', 'accounts.swap', 'media.upload', 'search', 'pty.raw']);
/** Scopes that can be granted in revision 0 (pty.raw cannot, P26). */
const GRANTABLE_SCOPES = Object.freeze(['chat', 'sessions.manage', 'accounts.read', 'accounts.swap', 'media.upload', 'search']);
/** Scopes checked at the desktop Allow step by default (all grantable ones). */
const DEFAULT_SCOPES = GRANTABLE_SCOPES;

/** Path prefix of the REST routes. */
const API_PREFIX = '/api/m/v2';
/** The stream path, outside the prefix. */
const STREAM_PATH = '/ws/m/v2';

/* eslint-disable no-multi-spaces */
const ROUTES = Object.freeze([
  ['GET', '/identity', 'public', 'identity', 'B1'],
  ['POST', '/pair', 'public', 'pair', 'B1'],
  ['GET', '/pair/:pairId', 'public', 'pairPoll', 'B1'],
  ['POST', '/hello', 'public', 'hello', 'B1'],
  ['POST', '/session', 'public', 'session', 'B1'],
  ['GET', '/computer', 'none', 'device', 'B1'],
  ['GET', '/browse', 'sessions.manage', 'device', 'B1'],
  ['GET', '/devices/me', 'none', 'device', 'B1'],
  ['PATCH', '/devices/me', 'none', 'device', 'B1'],
  ['DELETE', '/devices/me', 'none', 'device', 'B1'],
  ['PUT', '/devices/me/push', 'none', 'device', 'B1'],
  ['DELETE', '/devices/me/push', 'none', 'device', 'B1'],
  ['PUT', '/devices/me/live-activities/:activityId', 'none', 'device', 'B1'],
  ['DELETE', '/devices/me/live-activities/:activityId', 'none', 'device', 'B1'],
  ['GET', '/devices/me/preferences', 'none', 'device', 'B1'],
  ['PATCH', '/devices/me/preferences', 'none', 'device', 'B1'],
  ['GET', '/sessions/recent', 'chat', 'device', 'B2'],
  ['GET', '/tree', 'chat', 'device', 'B3'],
  ['GET', '/tree/projects/:projectId', 'chat', 'device', 'B3'],
  ['PATCH', '/projects/:projectId', 'sessions.manage', 'device', 'B3'],
  ['PATCH', '/folders/:folderId', 'sessions.manage', 'device', 'B3'],
  ['GET', '/sessions/:sessionId', 'chat', 'device', 'B2'],
  ['PATCH', '/sessions/:sessionId', 'sessions.manage', 'device', 'B3'],
  ['GET', '/sessions/:sessionId/messages', 'chat', 'device', 'B2'],
  ['GET', '/sessions/:sessionId/messages/:messageId/parts/:partIndex/text', 'chat', 'device', 'B2'],
  ['GET', '/sessions/:sessionId/messages/:messageId/parts/:partIndex/content', 'chat', 'device', 'B2'],
  ['POST', '/sessions/:sessionId/send', 'chat', 'send', 'B2'],
  ['GET', '/sessions/:sessionId/sends', 'chat', 'device', 'B2'],
  ['DELETE', '/sessions/:sessionId/sends/:clientMessageId', 'chat', 'device', 'B2'],
  ['POST', '/sessions/:sessionId/interrupt', 'chat', 'send', 'B2'],
  ['GET', '/sessions/:sessionId/prompts', 'chat', 'device', 'B2'],
  ['POST', '/sessions/:sessionId/prompts/:promptId/answer', 'chat', 'send', 'B2'],
  ['GET', '/sessions/:sessionId/settings', 'chat', 'device', 'B3'],
  ['PATCH', '/sessions/:sessionId/settings', 'sessions.manage', 'device', 'B3'],
  ['POST', '/sessions/:sessionId/restart', 'sessions.manage', 'send', 'B2'],
  ['POST', '/sessions/:sessionId/stop', 'sessions.manage', 'send', 'B2'],
  ['POST', '/sessions/:sessionId/continue-here', 'sessions.manage', 'send', 'B2'],
  ['POST', '/sessions/:sessionId/resume-anyway', 'sessions.manage', 'send', 'B2'],
  ['POST', '/sessions/:sessionId/branch', 'sessions.manage', 'send', 'B2'],
  ['GET', '/sessions/:sessionId/commands', 'chat', 'device', 'B2'],
  ['POST', '/sessions', 'sessions.manage', 'send', 'B2'],
  ['GET', '/providers/:provider/settings-schema', 'chat', 'device', 'B3'],
  ['GET', '/tabs', 'chat', 'device', 'B3'],
  ['PATCH', '/tabs', 'sessions.manage', 'device', 'B3'],
  ['GET', '/search/names', 'search', 'search', 'B3'],
  ['GET', '/search/messages', 'search', 'search', 'B3'],
  ['POST', '/uploads', 'media.upload', 'device', 'B2'],
  ['GET', '/uploads/:uploadId', 'media.upload', 'device', 'B2'],
  ['PUT', '/uploads/:uploadId/chunks', 'media.upload', 'upload', 'B2'],
  ['POST', '/uploads/:uploadId/complete', 'media.upload', 'device', 'B2'],
  ['DELETE', '/uploads/:uploadId', 'media.upload', 'device', 'B2'],
  ['GET', '/uploads/:uploadId/content', 'media.upload', 'device', 'B2'],
  ['GET', '/accounts', 'accounts.read', 'device', 'B3'],
  ['POST', '/accounts/refresh', 'accounts.swap', 'device', 'B3'],
  ['POST', '/accounts/swap', 'accounts.swap', 'send', 'B3'],
  ['POST', '/accounts/login', 'accounts.swap', 'send', 'B3'],
  ['GET', '/accounts/login/:flowId', 'accounts.swap', 'device', 'B3'],
  ['POST', '/accounts/login/:flowId/cancel', 'accounts.swap', 'send', 'B3'],
  ['PUT', '/accounts/:provider/:accountId/label', 'accounts.swap', 'device', 'B3'],
  ['POST', '/sessions/:sessionId/migrations/preview', 'sessions.manage', 'device', 'B3'],
  ['POST', '/sessions/:sessionId/migrations', 'sessions.manage', 'send', 'B3'],
  ['GET', '/migrations', 'chat', 'device', 'B3'],
  ['GET', '/migrations/:migrationId', 'chat', 'device', 'B3'],
  ['POST', '/migrations/:migrationId/approve', 'sessions.manage', 'send', 'B3'],
  ['POST', '/migrations/:migrationId/cancel', 'sessions.manage', 'send', 'B3'],
  ['POST', '/migrations/:migrationId/retry', 'sessions.manage', 'send', 'B3'],
  ['GET', '/migrations/:migrationId/report', 'chat', 'device', 'B3'],
  ['GET', '/migrations/:migrationId/turns/:turnNumber', 'chat', 'device', 'B3'],
  ['GET', STREAM_PATH, 'none', 'device', 'B2', true],
].map(([method, path, scope, limiter, owner, upgrade]) => Object.freeze({
  method, path, scope, limiter, owner, upgrade: upgrade === true,
})));
/* eslint-enable no-multi-spaces */

/**
 * Compile a table path into a matcher. Segments starting with ":" are params
 * that match one non empty segment.
 *
 * @param {string} pattern - Table path.
 * @returns {{re: RegExp, names: string[]}}
 */
function compile(pattern) {
  const names = [];
  const src = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp('^' + src + '$'), names };
}

const COMPILED = ROUTES.map((r) => Object.assign({}, r, compile(r.path)));

/**
 * Find the table entries whose path matches a request path, most literal
 * first (so /sessions/recent wins over /sessions/:sessionId).
 *
 * @param {string} relPath - Path relative to the prefix (or the stream path).
 * @returns {Array<{entry: object, params: object}>}
 */
function matchPath(relPath) {
  const out = [];
  for (const c of COMPILED) {
    const m = c.re.exec(relPath);
    if (!m) continue;
    const params = {};
    let ok = true;
    c.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]);
      } catch (_) {
        ok = false;
      }
    });
    if (ok) out.push({ entry: ROUTES[COMPILED.indexOf(c)], params, literal: c.names.length === 0 });
  }
  out.sort((a, b) => Number(b.literal) - Number(a.literal) || a.entry.path.split(':').length - b.entry.path.split(':').length);
  return out;
}

/**
 * Look a (method, path) pair up by its table path (not a request path).
 *
 * @param {string} method - HTTP method.
 * @param {string} tablePath - Path as written in the table.
 * @returns {object|null}
 */
function find(method, tablePath) {
  return ROUTES.find((r) => r.method === method && r.path === tablePath) || null;
}

module.exports = {
  SCOPES,
  GRANTABLE_SCOPES,
  DEFAULT_SCOPES,
  API_PREFIX,
  STREAM_PATH,
  ROUTES,
  matchPath,
  find,
  compile,
};
