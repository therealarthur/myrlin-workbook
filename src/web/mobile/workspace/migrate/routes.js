/**
 * migrate/routes.js: the migration routes of PROTOCOL.md 4.12 on B1's
 * router (scopes and limiters come from scope-table.js).
 *
 * WHY: one place maps HTTP to the engine (jobs.js): status codes (202 for a
 * preview start and a start, 200 elsewhere), the Idempotency-Key rule (428
 * without it, R08:513), and the audit lines. The engine throws MobileError,
 * which B1's router turns into the PROTOCOL.md 0.4 body.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const common = require('../common');

/** Every migration route: [method, path] (PROTOCOL.md 2.10). */
const MIGRATE_ROUTES = Object.freeze([
  ['POST', '/sessions/:sessionId/migrations/preview'],
  ['POST', '/sessions/:sessionId/migrations'],
  ['GET', '/migrations'],
  ['GET', '/migrations/:migrationId'],
  ['POST', '/migrations/:migrationId/approve'],
  ['POST', '/migrations/:migrationId/cancel'],
  ['POST', '/migrations/:migrationId/retry'],
  ['GET', '/migrations/:migrationId/report'],
  ['GET', '/migrations/:migrationId/turns/:turnNumber'],
]);
/** Idempotency-Key shape: a UUID or any short token of safe characters. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Register the migration routes.
 *
 * @param {object} router - B1's router.
 * @param {object} engine - createMigrations().
 * @returns {Array<[string, string]>} The registered routes.
 */
function mountMigrationRoutes(router, engine) {
  const who = (auth) => ({ deviceId: auth && auth.deviceId ? auth.deviceId : null });
  const handlers = {
    'POST /sessions/:sessionId/migrations/preview': (req) => engine.preview(req.params.sessionId, req.body),
    'POST /sessions/:sessionId/migrations': (req, res, auth) => {
      const key = req.headers && req.headers['idempotency-key'];
      if (typeof key !== 'string' || !key.trim()) common.fail('IDEMPOTENCY_KEY_REQUIRED', 'Starting a migration needs an Idempotency-Key header.');
      if (!IDEMPOTENCY_KEY_RE.test(key.trim())) common.fail('INVALID_FIELD', 'The Idempotency-Key header is not valid.', { field: 'Idempotency-Key' });
      const snap = engine.start(req.params.sessionId, req.body, key.trim(), who(auth));
      common.sendStatus(res, 202, snap);
      return undefined;
    },
    'GET /migrations': (req) => engine.list(req.query || {}),
    'GET /migrations/:migrationId': (req) => engine.get(req.params.migrationId),
    'POST /migrations/:migrationId/approve': (req, res, auth) => engine.approve(req.params.migrationId, req.body, who(auth)),
    'POST /migrations/:migrationId/cancel': (req, res, auth) => engine.cancel(req.params.migrationId, who(auth)),
    'POST /migrations/:migrationId/retry': (req, res, auth) => engine.retry(req.params.migrationId, req.body, who(auth)),
    'GET /migrations/:migrationId/report': (req) => engine.getReport(req.params.migrationId),
    'GET /migrations/:migrationId/turns/:turnNumber': (req) => engine.getTurn(req.params.migrationId, req.params.turnNumber),
  };
  for (const [method, p] of MIGRATE_ROUTES) {
    const fn = handlers[method + ' ' + p];
    router.route(method, p, (req, res, auth) => fn(req, res, auth));
  }
  return MIGRATE_ROUTES.slice();
}

module.exports = { mountMigrationRoutes, MIGRATE_ROUTES };
