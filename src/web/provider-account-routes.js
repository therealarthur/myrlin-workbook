/**
 * HTTP routes for provider account switchers (generic, any provider).
 *
 * Mirrors src/web/credential-routes.js (the Claude switcher routes) but is
 * provider-neutral: the routes resolve a manager from the `managers` map
 * by the :providerId path segment, so no provider name ever appears in
 * this file. Every route requires the workbook's own bearer auth and every
 * error goes through structuredError. Responses only ever serialize the
 * manager's safe projection (getSafeList); token material never reaches
 * the browser in any HTTP or SSE payload.
 *
 * SSE payloads use `accountId` and `providerId`, NEVER a bare `id` key, so
 * broadcastSSE's workspace-id extraction cannot misfile them; the event
 * types (provider-accounts:changed, provider-accounts:usage) are also
 * registered in GLOBAL_EVENT_TYPES (server.js) as the second guard.
 *
 * Design: docs/plans/2026-07-03-codex-account-switcher-design.md Part 3.3.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Shared best-effort race helper (observes both outcomes, unref'd timer);
// lives with the other cross-module account-manager helpers, alongside the
// writeFileAtomic/credError primitives the generic manager already reuses.
const { settleWithin } = require('./credential-manager');

// SSE event type names (shared with server.js GLOBAL_EVENT_TYPES and the
// frontend switch cases; named here so the three sites cannot drift apart
// silently in this file at least).
const EVENT_CHANGED = 'provider-accounts:changed';
const EVENT_USAGE = 'provider-accounts:usage';

// Best-effort budget for the serialized pre-list sync on the GET list
// route (same deadlock hardening as GET /api/credentials, 2026-07-24):
// the roster (getSafeList) reads snapshot files directly and never touches
// the manager's operation mutex, so it always renders; only the
// belt-and-braces sync rides the mutex and is raced against this window.
const LIST_BEST_EFFORT_MS = 2500;

/**
 * Build the post-apply restart expectation copy for one provider. Set once
 * per apply response; never auto-restarts anything (same policy as the
 * Claude switcher).
 *
 * @param {string} displayName - Provider display name from the manager.
 * @returns {string} Human-facing restart note.
 */
function restartNoteFor(displayName) {
  const name = displayName || 'provider';
  return 'New ' + name + ' sessions use this account immediately. Running '
    + name + ' sessions keep the previous account until restarted.';
}

/**
 * Register the provider account routes on the Express app.
 *
 * @param {import('express').Express} app - The Express app.
 * @param {object} deps
 * @param {Function} deps.requireAuth - Bearer auth middleware.
 * @param {(type: string, data: object) => void} deps.broadcast - SSE broadcast.
 * @param {Function} deps.structuredError - The server's error serializer.
 * @param {Map<string, object>} deps.managers - providerId -> manager map
 *   (createProviderAccountManager instances). The id strings come from
 *   each capability's providerId, so the caller stays literal-free too.
 * @param {number} [deps.listBestEffortMs] - Override for the GET list
 *   best-effort window (LIST_BEST_EFFORT_MS). Injectable for fast tests.
 * @returns {void}
 */
function setupProviderAccountRoutes(app, { requireAuth, broadcast, structuredError, managers, listBestEffortMs }) {
  // Effective best-effort window for the list route (tests inject a small
  // one so a hung-mutex case does not cost 2.5s of wall clock per test).
  const bestEffortMs = (Number.isFinite(Number(listBestEffortMs)) && Number(listBestEffortMs) > 0)
    ? Number(listBestEffortMs) : LIST_BEST_EFFORT_MS;
  /**
   * Broadcast wrapper: an SSE failure must never fail a route.
   *
   * @param {string} type - Event type.
   * @param {object} data - Event payload (accountId/providerId keys only).
   * @returns {void}
   */
  function safeBroadcast(type, data) {
    try { broadcast(type, data); } catch (_) { /* SSE must never fail a route */ }
  }

  /**
   * Map a thrown manager error onto structuredError. Errors created via
   * credError carry .status/.code/.retryable; anything else is a 500.
   *
   * @param {import('express').Response} res
   * @param {Error} err
   * @returns {import('express').Response}
   */
  function mapError(res, err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    const code = (err && err.code && typeof err.code === 'string') ? err.code : 'ACCT_INTERNAL';
    const message = (err && err.message) ? err.message : 'Internal provider account manager error';
    return structuredError(res, status, code, message, !!(err && err.retryable));
  }

  /**
   * Resolve the manager for a request's :providerId, or answer 404 when
   * the provider has no account switcher registered. Returning null after
   * responding keeps the handlers one-liners.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @returns {object|null} The manager, or null (response already sent).
   */
  function resolveManager(req, res) {
    const providerId = req.params.providerId;
    const manager = (managers && typeof managers.get === 'function') ? managers.get(providerId) : null;
    if (!manager) {
      structuredError(res, 404, 'PROVIDER_ACCOUNTS_UNSUPPORTED',
        'No account switcher is registered for that provider.', false);
      return null;
    }
    return manager;
  }

  /**
   * Send the canonical list response: the manager's safe projection. THE
   * ONLY roster shape any route serializes.
   *
   * @param {import('express').Response} res
   * @param {object} manager
   * @returns {import('express').Response}
   */
  function sendList(res, manager) {
    return res.json(manager.getSafeList());
  }

  // ─── GET /api/provider-accounts/:providerId ───────────────────────────
  // List the roster. A cheap guarded sync runs first so the live active
  // account always appears even before the watcher's first tick (same
  // belt-and-braces as GET /api/credentials). NO network usage calls.
  // DEGRADED MODE (deadlock hardening, 2026-07-24): the sync rides the
  // manager's serialized chain, so it is raced against bestEffortMs and
  // the roster is served regardless, with degraded:true when the sync did
  // not finish; a wedged chain can no longer blank the account tab.
  app.get('/api/provider-accounts/:providerId', requireAuth, async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    try {
      const bestEffort = (async () => {
        try { await manager.syncActiveAuthToSnapshot(); } catch (_) { /* sync is best effort */ }
      })();
      const completed = await settleWithin(bestEffort, bestEffortMs);
      const list = manager.getSafeList();
      if (!completed) list.degraded = true;
      return res.json(list);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── POST /api/provider-accounts/:providerId/refresh-usage ────────────
  // Body { accountId } forces one account past the TTL; {} refreshes every
  // snapshot whose cache is stale. Per-account usage failure is NOT a
  // route error (rows keep their stale cache; dead tokens surface in the
  // list). Broadcasts provider-accounts:usage with the safe rows.
  app.post('/api/provider-accounts/:providerId/refresh-usage', requireAuth, async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    try {
      const body = req.body || {};
      if (body.accountId !== undefined) {
        if (typeof body.accountId !== 'string' || !body.accountId) {
          return structuredError(res, 400, 'VALIDATION', 'accountId must be a non-empty string', false);
        }
        await manager.updateSnapshotUsage(body.accountId, { force: true });
      } else {
        const snaps = manager.listSnapshots();
        for (const snap of snaps) {
          try {
            await manager.updateSnapshotUsage(snap.accountId, { force: false });
          } catch (_) { /* per-account failure never fails the batch */ }
        }
      }
      const list = manager.getSafeList();
      safeBroadcast(EVENT_USAGE, { providerId: manager.providerId, accounts: list.accounts });
      return res.json(list);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── POST /api/provider-accounts/:providerId/apply ────────────────────
  // The switch. Broadcasts provider-accounts:changed AFTER a real apply;
  // an alreadyActive no-op broadcasts nothing (no state changed).
  app.post('/api/provider-accounts/:providerId/apply', requireAuth, async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    const body = req.body || {};
    if (typeof body.accountId !== 'string' || !body.accountId) {
      return structuredError(res, 400, 'VALIDATION', 'accountId must be a non-empty string', false);
    }
    try {
      const result = await manager.applyAccount(body.accountId);
      if (result.applied) {
        safeBroadcast(EVENT_CHANGED, {
          providerId: manager.providerId,
          activeAccountId: body.accountId,
          email: result.email || '',
          appliedAt: new Date().toISOString(),
        });
      }
      return res.json({
        applied: !!result.applied,
        alreadyActive: !!result.alreadyActive,
        activeAccountId: manager.getActiveAccountId() || null,
        email: result.email || '',
        restartNote: restartNoteFor(manager.displayName),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── POST /api/provider-accounts/:providerId/capture ──────────────────
  // Snapshot the live login with an optional friendly label.
  app.post('/api/provider-accounts/:providerId/capture', requireAuth, async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    try {
      const body = req.body || {};
      const snap = await manager.captureCurrent({ label: body.label });
      safeBroadcast(EVENT_CHANGED, { providerId: manager.providerId, captured: true, accountId: snap.accountId });
      return sendList(res, manager);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── PUT /api/provider-accounts/:providerId/:accountId/label ──────────
  // Rename. Trim, cap 60 (400 beyond), empty clears back to the fallback.
  app.put('/api/provider-accounts/:providerId/:accountId/label', requireAuth, async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    try {
      const body = req.body || {};
      const snap = await manager.setLabel(req.params.accountId, body.label != null ? body.label : '');
      safeBroadcast(EVENT_CHANGED, { providerId: manager.providerId, renamed: true, accountId: snap.accountId });
      return sendList(res, manager);
    } catch (err) {
      return mapError(res, err);
    }
  });

  // ─── DELETE /api/provider-accounts/:providerId/:accountId ─────────────
  // Removes the snapshot file ONLY; never the live auth file, never
  // anything remote (same contract as DELETE /api/credentials).
  app.delete('/api/provider-accounts/:providerId/:accountId', requireAuth, async (req, res) => {
    const manager = resolveManager(req, res);
    if (!manager) return;
    try {
      const accountId = req.params.accountId;
      await manager.deleteSnapshot(accountId);
      safeBroadcast(EVENT_CHANGED, { providerId: manager.providerId, deleted: true, accountId });
      return sendList(res, manager);
    } catch (err) {
      return mapError(res, err);
    }
  });
}

module.exports = {
  setupProviderAccountRoutes,
  restartNoteFor,
  EVENT_CHANGED,
  EVENT_USAGE,
};
