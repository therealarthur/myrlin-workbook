/**
 * workspace/index.js: mountWorkspace(router, ctx), the mobile v2 workspace
 * track (B3): the tree, names, pin and archive, session settings, the tab
 * layout with revisions, search, accounts and migrations, wired into B1's
 * router and B2's session index and stream hub.
 *
 * WHY: B1's index.js loads this module when it exists and calls it after
 * B2's mountChat (BUILD-CONTRACT 3.4.1), so everything B3 serves hangs off
 * this one entry point, and ctx.mobile.workspace carries exactly the members
 * BUILD-CONTRACT 3.4.4 promises to B2 (launch options, flags, tab group
 * placement) plus the accounts snapshot, lineage and the migration engine.
 * Every route is registered through router.route, so the scope table
 * decides its scope and limiter (PROTOCOL.md 2.10, critic F3).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const common = require('./common');
const layoutStoreMod = require('./layout-store');
const { createSessionFlags } = require('./session-flags');
const { createSettingsSchema } = require('./settings-schema');
const { createSessionSettings } = require('./session-settings');
const { createTree } = require('./tree');
const { createNames } = require('./names');
const { createTabs } = require('./tabs');
const { createSearch } = require('./search');
const { createAccounts } = require('./accounts');
const { createMigrations } = require('./migrate/jobs');
const { mountMigrationRoutes, MIGRATE_ROUTES } = require('./migrate/routes');

/** Retry-After of a 503 answer whose body carries no retryAfterMs (PROTOCOL.md 0.5). */
const RETRY_AFTER_503_SECONDS = 60;

/** Every workspace route B3 registers besides the migration routes (PROTOCOL.md 2.10). */
const WORKSPACE_ROUTES = Object.freeze([
  ['GET', '/tree'],
  ['GET', '/tree/projects/:projectId'],
  ['PATCH', '/projects/:projectId'],
  ['PATCH', '/folders/:folderId'],
  ['PATCH', '/sessions/:sessionId'],
  ['GET', '/sessions/:sessionId/settings'],
  ['PATCH', '/sessions/:sessionId/settings'],
  ['GET', '/providers/:provider/settings-schema'],
  ['GET', '/tabs'],
  ['PATCH', '/tabs'],
  ['GET', '/search/names'],
  ['GET', '/search/messages'],
  ['GET', '/accounts'],
  ['POST', '/accounts/refresh'],
  ['POST', '/accounts/swap'],
  ['POST', '/accounts/login'],
  ['GET', '/accounts/login/:flowId'],
  ['POST', '/accounts/login/:flowId/cancel'],
  ['PUT', '/accounts/:provider/:accountId/label'],
]);

/**
 * Mount the workspace track.
 *
 * @param {object} router - B1's router ({route(method, path, handler)}).
 * @param {object} ctx - The mobile context (BUILD-CONTRACT 3.4.1).
 * @param {object} [options] - Test seams: {now, env, glass, useWorker}.
 * @returns {object} ctx.mobile.workspace
 */
function mountWorkspace(router, ctx, options) {
  const o = options || {};
  ctx.mobile = ctx.mobile || {};
  const now = o.now || ctx.now || Date.now;
  const log = common.logger(ctx);
  const unsubs = [];

  // The layout store is the per data folder singleton server.js also uses
  // for GET and PUT /api/layout (S8); B3 adds the desktop broadcaster.
  const layoutStore = layoutStoreMod.forDataDir(ctx.dataDir || require('../../../utils/data-dir').getDataDir());
  layoutStore.resetHooks();
  layoutStore.setBroadcaster((type, data) => common.broadcast(ctx, type, data));
  layoutStore.setLogger((m) => log(m));

  const flags = createSessionFlags({ ctx, now });
  const schema = createSettingsSchema({ ctx, now });
  const settings = createSessionSettings({ ctx, schema, now });
  const tree = createTree({ ctx, now });
  const names = createNames({ ctx, flags, tree });
  const tabs = createTabs({ ctx, now, layoutStore });
  const search = createSearch({ ctx, now, tabs, tree });
  // Tab group names are in the name index too.
  unsubs.push(layoutStore.onChange(() => search.invalidateNames()));
  const accounts = createAccounts({ ctx, now, env: o.env || process.env, glass: o.glass });

  // ctx.mobile.workspace is set before the migration engine loads, because
  // the engine's resume may reach B2, which reads these members back.
  const workspace = {
    routes: WORKSPACE_ROUTES.concat(MIGRATE_ROUTES),
    settings: {
      launchOptionsFor: (id) => settings.launchOptionsFor(id),
      pendingRestartFor: (id) => settings.pendingRestartFor(id),
    },
    flags: { get: (id) => flags.get(id), set: (id, patch) => flags.set(id, patch) },
    tabs: {
      tabGroupIdsFor: (id) => tabs.tabGroupIdsFor(id),
      addSessionToGroup: (groupId, sessionId, afterSessionId, who) => tabs.addSessionToGroup(groupId, sessionId, afterSessionId, who),
    },
    accounts: { snapshot: () => accounts.snapshot(), glassApiUp: () => accounts.glassApiUp() },
    lineage: { of: (id) => null },
    migrations: null,
    onProviderChange: () => { search.invalidateNames(); },
    internals: { layoutStore, flags, schema, settings, tree, names, tabs, search, accounts },
  };
  ctx.mobile.workspace = workspace;

  const migrations = createMigrations({ ctx, now, flags, tabs, settings, accounts, schema, useWorker: o.useWorker !== false });
  workspace.migrations = {
    get: (id) => migrations.get(id),
    list: () => migrations.jobs(),
  };
  workspace.lineage.of = (id) => migrations.lineageOf(id);
  workspace.internals.migrations = migrations;

  // Routes.
  const who = (auth) => ({ deviceId: auth && auth.deviceId ? auth.deviceId : null });
  const handlers = {
    'GET /tree': () => tree.tree(),
    'GET /tree/projects/:projectId': (req) => tree.project(req.params.projectId, req.query || {}),
    'PATCH /projects/:projectId': (req, res, auth) => names.patchProject(req.params.projectId, req.body, who(auth)),
    'PATCH /folders/:folderId': (req, res, auth) => names.patchFolder(req.params.folderId, req.body, who(auth)),
    'PATCH /sessions/:sessionId': (req, res, auth) => {
      if (typeof req.noteUnknownFields === 'function') req.noteUnknownFields(require('./names').SESSION_PATCH_FIELDS);
      return names.patchSession(req.params.sessionId, req.body, who(auth));
    },
    'GET /sessions/:sessionId/settings': (req) => settings.get(req.params.sessionId),
    'PATCH /sessions/:sessionId/settings': (req, res, auth) => settings.patch(req.params.sessionId, req.body, who(auth)),
    'GET /providers/:provider/settings-schema': (req) => {
      if (!schema.isProvider(req.params.provider)) common.fail('PROVIDER_NOT_FOUND', 'That provider is not known on this computer.');
      return schema.schemaFor(req.params.provider);
    },
    'GET /tabs': () => tabs.get(),
    'PATCH /tabs': (req, res, auth) => tabs.patch(req.body, { ifMatch: req.headers && req.headers['if-match'], deviceId: who(auth).deviceId }),
    'GET /search/names': (req) => search.names(req.query || {}),
    'GET /search/messages': (req) => search.messages(req.query || {}),
    'GET /accounts': async () => Object.assign({ accounts: await accounts.get() }, common.snapshotSeq(ctx, 'accounts')),
    'POST /accounts/refresh': async (req, res, auth) => { common.sendStatus(res, 202, await accounts.refresh(req.body, who(auth))); return undefined; },
    'POST /accounts/swap': (req, res, auth) => accounts.swap(req.body, who(auth)),
    'POST /accounts/login': async (req, res, auth) => { common.sendStatus(res, 202, await accounts.login(req.body, who(auth))); return undefined; },
    'GET /accounts/login/:flowId': (req) => accounts.loginStatus(req.params.flowId),
    'POST /accounts/login/:flowId/cancel': (req) => accounts.loginCancel(req.params.flowId),
    'PUT /accounts/:provider/:accountId/label': (req, res, auth) => accounts.setLabel(req.params.provider, req.params.accountId, req.body, who(auth)),
  };
  if (router && typeof router.route === 'function') {
    for (const [method, p] of WORKSPACE_ROUTES) {
      const fn = handlers[method + ' ' + p];
      router.route(method, p, (req, res, auth) => Promise.resolve()
        .then(() => fn(req, res, auth))
        .catch((err) => {
          // PROTOCOL.md 0.5: every 503 carries Retry-After. B1's sender adds
          // it only for a body with retryAfterMs, which GLASS_UNAVAILABLE
          // may not carry (section 13), so the header is set here first.
          if (err && err.status === 503 && res && !res.headersSent && typeof res.setHeader === 'function') {
            res.setHeader('Retry-After', String(RETRY_AFTER_503_SECONDS));
          }
          throw err;
        }));
    }
    mountMigrationRoutes(router, migrations);
  } else {
    log('mounted without a router; routes are not served');
  }

  // B2 hooks: settings apply at the next start (clear pendingRestart on a
  // spawn), and wb_ ids that re-key keep their flags and stored settings.
  const pm = typeof ctx.getPtyManager === 'function' ? ctx.getPtyManager() : null;
  if (pm && typeof pm.onSessionSpawn === 'function') unsubs.push(pm.onSessionSpawn((wbId) => settings.onSpawn(wbId)));
  const chat = ctx.mobile.chat;
  if (chat && chat.sessions && typeof chat.sessions.onChanged === 'function') {
    unsubs.push(chat.sessions.onChanged((ev) => {
      for (const ch of (ev && ev.changes) || []) {
        if (ch.change === 'idChanged' && ch.previousSessionId) {
          flags.rekey(ch.previousSessionId, ch.sessionId);
          settings.rekey(ch.previousSessionId, ch.sessionId);
        }
      }
    }));
  }

  accounts.start();
  try { migrations.load(); } catch (err) { log('migration resume failed: ' + (err && err.message)); }

  workspace.stop = () => {
    for (const u of unsubs.splice(0)) { try { u(); } catch (_) { /* ignore */ } }
    try { tabs.stop(); } catch (_) { /* ignore */ }
    try { search.stop(); } catch (_) { /* ignore */ }
    try { accounts.stop(); } catch (_) { /* ignore */ }
    try { migrations.stop(); } catch (_) { /* ignore */ }
    layoutStore.setBroadcaster(null);
  };
  log('mounted with ' + workspace.routes.length + ' routes');
  return workspace;
}

module.exports = { mountWorkspace, WORKSPACE_ROUTES };
