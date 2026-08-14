/**
 * Express Web API Server for Claude Workspace Manager.
 *
 * Provides a REST API for managing workspaces, sessions, and live events.
 * Serves the static frontend from ./public and exposes an SSE endpoint
 * for real-time updates.
 *
 * Usage:
 *   const { startServer } = require('./server');
 *   const server = startServer(3456);
 */

const path = require('path');
const { execFile, execSync } = require('child_process');
const express = require('express');

const { setupAuth, requireAuth, isValidToken, addToken, generateToken, isRateLimited, reloadTokensFromStore, setStoreGetter } = require('./auth');
const { setupPairing, detectAllUrls } = require('./pairing');
const { setupPushRoutes, setupPushListeners } = require('./push');
const { setupDeviceRoutes } = require('./device-manager');
const { getStore } = require('../state/store');
const { launchSession, stopSession, restartSession } = require('../core/session-manager');
const { backupFrontend, restoreFrontend, getBackupStatus } = require('./backup');
const td = require('../core/td-adapter');
const { getDataDir } = require('../utils/data-dir');
const { Worker } = require('worker_threads');

// Full-SPA browser acceptance launches the real server against an isolated
// profile. In that explicit mode, operations that inspect project-local
// credentials, fetch Git refs, or start tunnel processes must stay inert.
const HERMETIC_UI_TEST = process.env.CWM_TEST_HERMETIC_UI === '1';

// Plan 15-01 (DISC-03): provider registry and Claude provider object.
// The registry resolves session.provider tags to provider objects via
// getProviderForSession(); claudeProvider supplies cliBinary and
// findArtifactPath wrappers that route handlers dispatch through so the
// abstraction is ready for Phase 17 (Codex) without further surgery.
const registry = require('../providers');
const claudeProvider = require('../providers/claude');

/**
 * Resolve the Provider object for a session record. Reads session.provider,
 * falls back to claudeProvider for missing tags (defense in depth on top of
 * the state-load normalization from Plan 14-02), and returns the provider
 * via registry.getProvider. Returns null only if the registry has no
 * provider with the resolved id (a corrupt session record tagged with a
 * never-shipped provider id; should never happen in practice but the
 * route handlers defensively check).
 *
 * Plan 15-01 (DISC-03). Used by every transcript-artifact lookup in
 * route handlers; refactored from direct helper calls so the
 * abstraction is ready for Phase 17 (Codex).
 *
 * @param {Object|null} session - Session record from store.getSession.
 *                                Tolerates null (returns null).
 * @returns {Object|null} Provider object, or null if unresolvable.
 */
function getProviderForSession(session) {
  if (!session) return null;
  // Defensive default: state-load normalization in src/state/store.js already
  // backfills session.provider, but this helper is the second layer guarding
  // any session record that bypassed _tryLoadFile (test fixtures, in-memory
  // mutations, etc.). The literal carries the allowlist marker so the grep
  // gate in test/grep-gate.test.js is satisfied.
  const id = session.provider || 'claude'; // gsd:provider-literal-allowed (defensive default; matches state-load normalization)
  return registry.getProvider(id);
}

// ─── Cost Worker Thread ──────────────────────────────────
// Offloads JSONL parsing to a background thread to prevent
// terminal I/O freezes during cost calculation.
let _costWorker = null;
let _costWorkerId = 0;
const _costWorkerCallbacks = new Map();

/**
 * Get or create the cost calculation worker thread.
 * Lazy-initialized on first cost request.
 * @returns {Worker} The cost worker thread
 */
function getCostWorker() {
  if (_costWorker) return _costWorker;
  _costWorker = new Worker(path.join(__dirname, 'cost-worker.js'));
  _costWorker.on('message', (msg) => {
    const cb = _costWorkerCallbacks.get(msg.id);
    if (cb) {
      _costWorkerCallbacks.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error));
      else cb.resolve(msg.result);
    }
  });
  _costWorker.on('error', (err) => {
    console.error('[CostWorker] Error:', err.message);
  });
  _costWorker.on('exit', (code) => {
    console.warn('[CostWorker] Exited with code', code);
    _costWorker = null;
    // Reject any pending callbacks
    for (const [id, cb] of _costWorkerCallbacks) {
      cb.reject(new Error('Worker exited'));
      _costWorkerCallbacks.delete(id);
    }
  });
  return _costWorker;
}

/**
 * Calculate session cost asynchronously via the worker thread.
 * Falls back to sync calculation if the worker fails.
 * @param {string} jsonlPath - Path to the JSONL file
 * @returns {Promise<object>} Cost breakdown
 */
function calculateSessionCostAsync(jsonlPath) {
  return new Promise((resolve, reject) => {
    const id = ++_costWorkerId;
    _costWorkerCallbacks.set(id, { resolve, reject });
    try {
      getCostWorker().postMessage({
        id,
        jsonlPath,
        pricing: TOKEN_PRICING,
        defaultPricing: DEFAULT_PRICING,
      });
    } catch (err) {
      _costWorkerCallbacks.delete(id);
      reject(err);
    }
  });
}

/**
 * Resolve the td binary path in priority order:
 *   1. store.settings.tdBinary (user-configured, persisted in workspaces.json)
 *   2. TD_BINARY environment variable
 *   3. 'td' (rely on PATH)
 */
function getTdBinary() {
  try {
    const stored = getStore().settings.tdBinary;
    if (stored && stored.trim()) return stored.trim();
  } catch (_) { /* store not ready yet */ }
  return process.env.TD_BINARY || td.DEFAULT_TD_BINARY;
}

// ─── Input Sanitization ────────────────────────────────────
// Validates user-controlled fields that flow into shell commands.
// Rejects shell metacharacters to prevent command injection.

/** Regex matching shell metacharacters that could enable command injection */
const SHELL_UNSAFE = /[;&|`$(){}[\]<>!#*?\n\r\\'"]/;

/**
 * Validate a command string. Must be a safe executable name/path.
 * Allows alphanumeric, hyphens, dots, forward slashes (paths), spaces (for args).
 * Rejects shell metacharacters that could chain commands.
 * @param {string} cmd - The command to validate
 * @returns {string|null} Sanitized command or null if invalid
 */
function sanitizeCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const trimmed = cmd.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (SHELL_UNSAFE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate a model identifier. Must be alphanumeric with hyphens, dots, colons.
 * Examples: "claude-opus-4-6", "claude-sonnet-4-5-20250929"
 * @param {string} model - The model identifier
 * @returns {string|null} Sanitized model or null if invalid
 */
function sanitizeModel(model) {
  if (!model || typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate a session ID for --resume. Must be UUID-like (hex + hyphens).
 * @param {string} id - The session/resume ID
 * @returns {string|null} Sanitized ID or null if invalid
 */
function sanitizeSessionId(id) {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate a working directory path. Rejects shell metacharacters.
 * Does NOT check existence (that's done at spawn time by pty-manager).
 * @param {string} dir - The directory path
 * @returns {string|null} Sanitized path or null if invalid
 */
function sanitizeWorkingDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const trimmed = dir.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  // Allow path separators (/ and \), colons (C:), dots, spaces, tildes, hyphens
  // Reject shell metacharacters that could enable injection
  if (/[;&|`$(){}[\]<>!#*?\n\r]/.test(trimmed)) return null;
  return trimmed;
}

// ─── App Creation ──────────────────────────────────────────

const app = express();

// ─── Core Middleware ────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// API Version header on every response (ERRR-03)
app.use((req, res, next) => {
  res.setHeader('X-API-Version', '1');
  next();
});

/**
 * Send a structured error response with machine-readable code.
 * Format: { error: string, code: number, message: string, retryable: boolean }
 * @param {import('express').Response} res - Express response
 * @param {number} statusCode - HTTP status code
 * @param {string} errorCode - Machine-readable error code (e.g. 'INVALID_TOKEN')
 * @param {string} message - Human-readable message
 * @param {boolean} [retryable=false] - Whether the client can retry this request
 */
function structuredError(res, statusCode, errorCode, message, retryable = false) {
  return res.status(statusCode).json({
    error: errorCode,
    code: statusCode,
    message,
    retryable,
  });
}

// CORS headers - restrict to localhost and local network origins
// Mobile clients with valid Bearer tokens are allowed from any origin
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'http://localhost',
    'http://127.0.0.1',
    'https://localhost',
    'https://127.0.0.1',
  ];
  // Allow any localhost port (e.g. http://localhost:3456, http://localhost:5173)
  const isAllowed = allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed + ':'));
  // Also allow requests from the same host (e.g. Tailscale IP, LAN IP)
  // Uses exact hostname comparison to prevent substring bypass attacks
  // (e.g. 192.168.1.100.evil.com must NOT match 192.168.1.100)
  const reqHost = req.headers.host;
  let isSameHost = false;
  if (!isAllowed && reqHost && origin) {
    try {
      const originHostname = new URL(origin).hostname;
      const reqHostname = reqHost.split(':')[0];
      isSameHost = originHostname === reqHostname;
    } catch (_) { /* malformed origin -- deny */ }
  }

  // Trust Bearer tokens from any origin (mobile clients on LAN, Tailscale, tunnel)
  const authHeader = req.headers.authorization || '';
  const hasValidToken = authHeader.startsWith('Bearer ') && isValidToken(authHeader.split(' ')[1]);

  if (hasValidToken) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (isSameHost) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    // Preflight: if requesting Authorization header, allow from any origin
    // (preflight requests do not carry Bearer tokens themselves)
    const requestedHeaders = (req.headers['access-control-request-headers'] || '').toLowerCase();
    if (requestedHeaders.includes('authorization')) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    return res.sendStatus(204);
  }
  next();
});

// ─── Security Headers ────────────────────────────────────────
app.use((req, res, next) => {
  // Content Security Policy - allow self + inline styles (for dynamic UI) + WebSocket
  // Dynamically allow WebSocket from the request host (supports Tailscale/LAN access)
  const host = req.headers.host || 'localhost:3456';
  const hostname = host.split(':')[0];
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    `connect-src 'self' ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://${hostname}:* wss://${hostname}:*; ` +
    "img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; " +
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com;"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Static Files ──────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Request Logging ─────────────────────────────────────────

app.use((req, res, next) => {
  // Log API requests (skip static files) without exposing auth details
  if (req.originalUrl.startsWith('/api/')) {
    console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  }
  next();
});

// ─── Health Check (no auth) ─────────────────────────────────

const serverStartTime = Date.now();

app.get('/api/health', (req, res) => {
  // PTY capability (issue #68): report whether the native terminal engine
  // loaded so clients and monitoring can distinguish a degraded boot from a
  // healthy one. This endpoint is PUBLIC (no auth), so the payload exposes
  // only { available } plus a stable machine code on failure. The raw error
  // string, filesystem paths, and usernames are withheld here and kept in the
  // server logs only (see pty-diagnostics.getHealthPtyField). Lazily required
  // so a diagnostics fault can never break the health check itself.
  let ptyStatus;
  try {
    ptyStatus = require('./pty-diagnostics').getHealthPtyField();
  } catch (_) {
    ptyStatus = { available: true };
  }
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    timestamp: new Date().toISOString(),
    pty: ptyStatus,
  });
});

// ─── Fallback/Backup Endpoints ──────────────────────────────

app.get('/api/fallback/status', requireAuth, (req, res) => {
  const status = getBackupStatus();
  if (!status) return res.status(404).json({ error: 'No backup available' });
  return res.json(status);
});

app.post('/api/fallback/restore', requireAuth, (req, res) => {
  const manifest = restoreFrontend();
  if (!manifest) return res.status(500).json({ error: 'Restore failed - no backup found' });
  return res.json({ success: true, restored: manifest });
});

// ─── Auth Routes (public, no token required) ───────────────

setupAuth(app);

// ─── Pairing Routes (mobile device authentication) ─────────
setupPairing(app, { requireAuth, addToken, generateToken, isRateLimited, getStore });

// ─── Push Notification Routes (mobile device push tokens) ───
setupPushRoutes(app, requireAuth, getStore);
setupPushListeners(getStore());

// ─── Device Management Routes (paired device CRUD) ────────────
setupDeviceRoutes(app, {
  requireAuth,
  getStore: () => getStore(),
  removeToken: require('./auth').removeToken,
  sendPush: require('./push').sendPush,
  getSSEClients: () => sseClients,
});

// ─── Credential Switcher Routes (Claude account swap) ────────
// Design: docs/plans/2026-07-02-credential-switcher-design.md. The manager
// owns the snapshot store, rotation write-back watcher, and the PC apply
// transaction; the watcher is started in startServer() and stopped on
// shutdown. broadcast is a lazy closure: broadcastSSE is a hoisted function
// declaration, so runtime calls resolve even though it is defined below.
const { createCredentialManager, PROACTIVE_REFRESH_FLOOR_MIN } = require('./credential-manager');
const credentialMacBridge = require('./mac-bridge');
const { setupCredentialRoutes } = require('./credential-routes');
const credentialManager = createCredentialManager({
  settingsProvider: () => (getStore().settings || {}).credentialSwitcher || {},
  // Write-back for manager-owned settings (the Mac-active lineage hint):
  // shallow-merges the patch into settings.credentialSwitcher so the hint
  // survives restarts without the manager knowing store internals.
  settingsPatcher: (patch) => {
    const store = getStore();
    const cur = (store.settings && store.settings.credentialSwitcher) || {};
    store.updateSettings({ credentialSwitcher: { ...cur, ...(patch || {}) } });
  },
});
setupCredentialRoutes(app, {
  requireAuth,
  getStore: () => getStore(),
  broadcast: (type, data) => broadcastSSE(type, data),
  structuredError,
  manager: credentialManager,
  macBridge: credentialMacBridge,
});

// ─── Provider Account Switchers (generic, capability-driven) ─
// Design: docs/plans/2026-07-03-codex-account-switcher-design.md. The
// generic manager mirrors the Claude credential manager above but is
// fully parameterized by a provider-owned capability object, so this
// wiring and src/web/provider-account-*.js stay free of provider
// literals: the id string below comes from the capability itself. The
// watcher is started in startServer() and stopped on shutdown.
const { accountsCapability: codexAccountsCapability } = require('../providers/codex/accounts');
const { createProviderAccountManager } = require('./provider-account-manager');
const { setupProviderAccountRoutes } = require('./provider-account-routes');
const codexAccountManager = createProviderAccountManager(codexAccountsCapability, {
  // Per-provider settings live under settings.providerAccounts[providerId]
  // (parallel to settings.credentialSwitcher for Claude).
  settingsProvider: () =>
    (((getStore().settings || {}).providerAccounts || {})[codexAccountsCapability.providerId]) || {},
});
setupProviderAccountRoutes(app, {
  requireAuth,
  broadcast: (type, data) => broadcastSSE(type, data),
  structuredError,
  managers: new Map([[codexAccountsCapability.providerId, codexAccountManager]]),
});

// ─── Session Mirror service (issue #10 Tier 1, Phase 3) ─────
// Read-only live mirror of externally-started provider sessions. The
// service owns the tailers and subscriber refcounts; the /api/mirror/*
// routes below (search for "MIRROR - read-only") own HTTP validation.
// broadcastSSE is a hoisted function declaration and sseClients is a
// module-scope const declared later in this file; both closures only
// dereference them at call time, so construction order is safe.
const { MirrorService, MIRROR_KEY_SEPARATOR } = require('./mirror-service');
const mirrorService = new MirrorService({
  getProvider: (id) => registry.getProvider(id),
  broadcast: (type, data) => broadcastSSE(type, data),
  // Lets the service GC subscribers whose SSE client vanished without a
  // close call (tab killed, phone lost signal) so a tailer never leaks.
  isDeviceConnected: (deviceId) => {
    if (!deviceId) return false;
    for (const [, client] of sseClients) {
      if (client.deviceId === deviceId && !client.res.writableEnded) return true;
    }
    return false;
  },
});

// ─── Public Server Info (no auth required) ─────────────────
// Public endpoint for mobile connection testing (no auth)

/**
 * GET /api/server-info
 * Returns server identity, capabilities, detected URLs, and basic stats.
 * No authentication required so mobile clients can test reachability
 * before completing the pairing flow.
 */
app.get('/api/server-info', (req, res) => {
  const pkg = (() => {
    try { return require(path.join(__dirname, '..', '..', 'package.json')); }
    catch (_) { return { name: 'myrlin-workbook', version: '0.0.0' }; }
  })();
  const port = req.socket.localPort || 3456;
  const store = getStore();
  const urls = detectAllUrls(port, store);
  const sessions = Object.values(store.state.sessions || {});
  const runningCount = sessions.filter(s => s.status === 'running').length;

  return res.json({
    name: pkg.name || 'myrlin-workbook',
    version: pkg.version || '0.0.0',
    platform: process.platform,
    uptime: process.uptime(),
    capabilities: {
      push: true,
      aiSearch: !!process.env.ANTHROPIC_API_KEY,
      costTracking: true,
      terminal: true,
      search: true,
      tunnel: !!(store.state.settings && store.state.settings.tunnelUrl),
    },
    urls,
    stats: {
      workspaceCount: Object.keys(store.state.workspaces || {}).length,
      sessionCount: sessions.length,
      runningCount,
    },
  });
});

// ─── Mobile Sync (single-request bootstrap) ────────────────

/**
 * GET /api/mobile/sync
 * Returns all data needed for mobile app bootstrap in a single response.
 * Sessions use sparse fields only (omits logs, workingDir, command, flags,
 * initialPrompt, createdAt) to keep the payload small on slow connections.
 * Includes a syncVersion number for future delta sync support.
 */
app.get('/api/mobile/sync', requireAuth, (req, res) => {
  const store = getStore();
  const state = store.state;

  // Sparse session fields for list view (omit heavy fields)
  const SPARSE_SESSION_FIELDS = ['id', 'name', 'workspaceId', 'status', 'topic', 'tags', 'lastActive', 'pid', 'resumeSessionId'];

  const sessions = Object.values(state.sessions || {}).map(s => {
    const sparse = {};
    for (const field of SPARSE_SESSION_FIELDS) {
      if (s[field] !== undefined) sparse[field] = s[field];
    }
    return sparse;
  });

  // Find requesting device by token
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const device = store.findDeviceByToken(token);

  // Compute stats
  const allSessions = Object.values(state.sessions || {});
  const runningCount = allSessions.filter(s => s.status === 'running').length;

  // Build recent session IDs (last 10 by lastActive)
  const recentSessions = [...allSessions]
    .sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''))
    .slice(0, 10)
    .map(s => s.id);

  // Strip token from device info before sending
  const deviceInfo = device ? (() => {
    const { token: _, ...rest } = device;
    return rest;
  })() : null;

  res.json({
    server: {
      name: state.settings?.serverName || 'Myrlin Workbook',
      version: require('../../package.json').version,
      uptime: Math.floor(process.uptime()),
    },
    workspaces: Object.values(state.workspaces || {}),
    workspaceOrder: state.workspaceOrder || [],
    workspaceGroups: Object.values(state.workspaceGroups || {}),
    sessions,
    recentSessions,
    templates: Object.values(state.templates || {}),
    settings: state.settings || {},
    device: deviceInfo,
    stats: {
      runningCount,
      totalCount: allSessions.length,
      totalCost: 0,
    },
    syncVersion: 1,
    timestamp: new Date().toISOString(),
  });
});

// ─── Protected API Routes ──────────────────────────────────
// All routes below require a valid Bearer token.

// Cross-process state sync: on GET requests, check if another process
// (e.g. TUI) has modified the state file since we last read it.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') {
    getStore().checkDiskSync();
  }
  next();
});

// ──────────────────────────────────────────────────────────
//  WORKSPACES
// ──────────────────────────────────────────────────────────

/**
 * GET /api/workspaces
 * Returns all workspaces with their session counts attached.
 */
app.get('/api/workspaces', requireAuth, (req, res) => {
  const store = getStore();
  const workspaces = store.getAllWorkspacesList().map((ws) => ({
    ...ws,
    sessionCount: Array.isArray(ws.sessions) ? ws.sessions.length : 0,
  }));
  const workspaceOrder = store._state.workspaceOrder || [];

  return res.json({ workspaces, workspaceOrder });
});

/**
 * GET /api/workspaces/:id
 * Returns a single workspace with its full session objects.
 */
app.get('/api/workspaces/:id', requireAuth, (req, res) => {
  const store = getStore();
  const workspace = store.getWorkspace(req.params.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }

  const sessions = store.getWorkspaceSessions(workspace.id);
  return res.json({ workspace: { ...workspace, sessionObjects: sessions } });
});

/**
 * POST /api/workspaces
 * Body: { name, description?, color? }
 */
app.post('/api/workspaces', requireAuth, (req, res) => {
  const { name, description, color, icon } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Workspace name is required.' });
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: 'Workspace name must be 100 characters or fewer.' });
  }

  const store = getStore();
  const workspace = store.createWorkspace({
    name: name.trim(),
    description: description || '',
    color: color || 'cyan',
    icon: icon || null,
  });

  return res.status(201).json({ workspace });
});

/**
 * PUT /api/workspaces/:id
 * Body: partial workspace fields to update
 */
/**
 * PUT /api/workspaces/reorder
 * Body: { order: [...ids] }
 * Saves the sidebar ordering (mix of workspace IDs and group IDs).
 * IMPORTANT: Must be registered BEFORE PUT /api/workspaces/:id so Express
 * doesn't match "reorder" as an :id parameter.
 */
app.put('/api/workspaces/reorder', requireAuth, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of IDs.' });
  }
  const store = getStore();
  store.reorderWorkspaces(order);
  return res.json({ success: true });
});

app.put('/api/workspaces/:id', requireAuth, (req, res) => {
  const store = getStore();
  const workspace = store.updateWorkspace(req.params.id, req.body);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }

  return res.json({ workspace });
});

/**
 * DELETE /api/workspaces/:id
 */
app.delete('/api/workspaces/:id', requireAuth, (req, res) => {
  const store = getStore();
  const deleted = store.deleteWorkspace(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }

  return res.json({ success: true });
});

/**
 * POST /api/workspaces/:id/activate
 * Set this workspace as the active workspace.
 */
app.post('/api/workspaces/:id/activate', requireAuth, (req, res) => {
  const store = getStore();
  const result = store.setActiveWorkspace(req.params.id);

  if (!result) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }

  return res.json({ success: true });
});

// ──────────────────────────────────────────────────────────
//  WORKSPACE DOCUMENTATION
// ──────────────────────────────────────────────────────────

/**
 * GET /api/workspaces/:id/docs
 * Returns parsed documentation for a workspace.
 */
app.get('/api/workspaces/:id/docs', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const docs = store.getWorkspaceDocs(req.params.id);
  if (!docs) {
    return res.json({ raw: null, notes: [], goals: [], tasks: [], roadmap: [], rules: [] });
  }
  return res.json(docs);
});

/**
 * PUT /api/workspaces/:id/docs
 * Body: { content: "raw markdown" }
 * Replaces the entire documentation.
 */
app.put('/api/workspaces/:id/docs', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { content } = req.body || {};
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content (string) is required.' });
  }
  store.updateWorkspaceDocs(req.params.id, content);
  const docs = store.getWorkspaceDocs(req.params.id);
  return res.json(docs);
});

/**
 * POST /api/workspaces/:id/docs/notes
 * Body: { text }
 */
app.post('/api/workspaces/:id/docs/notes', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required.' });
  }
  store.addWorkspaceNote(req.params.id, text.trim());
  return res.status(201).json({ success: true });
});

/**
 * POST /api/workspaces/:id/docs/goals
 * Body: { text }
 */
app.post('/api/workspaces/:id/docs/goals', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required.' });
  }
  store.addWorkspaceGoal(req.params.id, text.trim());
  return res.status(201).json({ success: true });
});

/**
 * POST /api/workspaces/:id/docs/tasks
 * Body: { text }
 */
app.post('/api/workspaces/:id/docs/tasks', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required.' });
  }
  store.addWorkspaceTask(req.params.id, text.trim());
  return res.status(201).json({ success: true });
});

/**
 * POST /api/workspaces/:id/docs/roadmap
 * Body: { text, status? }
 * Adds a roadmap item with optional status (defaults to 'planned').
 */
app.post('/api/workspaces/:id/docs/roadmap', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { text, status } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required.' });
  }
  store.addWorkspaceRoadmapItem(req.params.id, text.trim(), status || 'planned');
  return res.status(201).json({ success: true });
});

/**
 * POST /api/workspaces/:id/docs/rules
 * Body: { text }
 * Adds a rule item.
 */
app.post('/api/workspaces/:id/docs/rules', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required.' });
  }
  store.addWorkspaceRule(req.params.id, text.trim());
  return res.status(201).json({ success: true });
});

/**
 * PUT /api/workspaces/:id/docs/:section/:index
 * Toggle done state of a goal or task, or cycle roadmap status.
 */
app.put('/api/workspaces/:id/docs/:section/:index', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { section, index } = req.params;
  if (!['goals', 'tasks', 'roadmap'].includes(section)) {
    return res.status(400).json({ error: 'Section must be "goals", "tasks", or "roadmap".' });
  }
  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Invalid index.' });
  }
  if (section === 'roadmap') {
    const result = store.cycleWorkspaceRoadmapStatus(req.params.id, idx);
    if (!result) return res.status(404).json({ error: 'Item not found at index.' });
    return res.json({ success: true });
  }
  const result = store.toggleWorkspaceItem(req.params.id, section, idx);
  if (!result) return res.status(404).json({ error: 'Item not found at index.' });
  return res.json({ success: true });
});

/**
 * DELETE /api/workspaces/:id/docs/:section/:index
 * Remove an item by section and index.
 */
app.delete('/api/workspaces/:id/docs/:section/:index', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { section, index } = req.params;
  if (!['notes', 'goals', 'tasks', 'roadmap', 'rules'].includes(section)) {
    return res.status(400).json({ error: 'Section must be "notes", "goals", "tasks", "roadmap", or "rules".' });
  }
  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Invalid index.' });
  }
  const result = store.removeWorkspaceItem(req.params.id, section, idx);
  if (!result) return res.status(404).json({ error: 'Item not found at index.' });
  return res.json({ success: true });
});

// ──────────────────────────────────────────────────────────
//  PINNED NOTES
//  Per-session pinned note indices, persisted as JSON files
//  under ~/.myrlin/pinned-notes/{workspaceId}.json
//  Format: { [sessionId]: [noteIndex, ...] }
// ──────────────────────────────────────────────────────────

/**
 * Return the directory used to store pinned-note files.
 * Creates it if it does not already exist.
 * @returns {string}
 */
function getPinnedNotesDir() {
  const dir = path.join(getDataDir(), 'pinned-notes');
  require('fs').mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read the pinned-notes map for a workspace from disk.
 * Returns {} if the file does not exist or cannot be parsed.
 * @param {string} workspaceId
 * @returns {{ [sessionId: string]: number[] }}
 */
function getPinnedNotes(workspaceId) {
  const file = path.join(getPinnedNotesDir(), `${workspaceId}.json`);
  try {
    const raw = require('fs').readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

/**
 * Atomically write the pinned-notes map for a workspace.
 * Writes to a temp file then renames to ensure no partial reads.
 * @param {string} workspaceId
 * @param {{ [sessionId: string]: number[] }} data
 */
function savePinnedNotes(workspaceId, data) {
  const fs = require('fs');
  const dir = getPinnedNotesDir();
  const file = path.join(dir, `${workspaceId}.json`);
  const tmp = path.join(dir, `.tmp.${Date.now()}.${workspaceId}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Add noteIndex to the pinned list for sessionId, deduplicating.
 * @param {string} wsId
 * @param {string} sessionId
 * @param {number} noteIndex
 */
function pin(wsId, sessionId, noteIndex) {
  const data = getPinnedNotes(wsId);
  const existing = data[sessionId] || [];
  if (!existing.includes(noteIndex)) {
    existing.push(noteIndex);
  }
  data[sessionId] = existing;
  savePinnedNotes(wsId, data);
}

/**
 * Remove noteIndex from the pinned list for sessionId.
 * @param {string} wsId
 * @param {string} sessionId
 * @param {number} noteIndex
 */
function unpin(wsId, sessionId, noteIndex) {
  const data = getPinnedNotes(wsId);
  if (!data[sessionId]) return;
  data[sessionId] = data[sessionId].filter(i => i !== noteIndex);
  savePinnedNotes(wsId, data);
}

/**
 * GET /api/workspaces/:id/pinned-notes
 * Returns the full pinned-notes map: { [sessionId]: [noteIndex, ...] }
 */
app.get('/api/workspaces/:id/pinned-notes', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const data = getPinnedNotes(req.params.id);
  return res.json(data);
});

/**
 * POST /api/workspaces/:id/pinned-notes
 * Body: { sessionId, noteIndex, action: 'pin' | 'unpin' }
 * Pins or unpins a note index for a session.
 */
app.post('/api/workspaces/:id/pinned-notes', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { sessionId, noteIndex, action } = req.body || {};
  if (!sessionId || noteIndex === undefined || noteIndex === null) {
    return res.status(400).json({ error: 'sessionId and noteIndex are required.' });
  }
  const idx = parseInt(noteIndex, 10);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'noteIndex must be a non-negative integer.' });
  }

  if (action === 'unpin') {
    unpin(req.params.id, sessionId, idx);
  } else {
    pin(req.params.id, sessionId, idx);
  }
  return res.json({ success: true });
});

/**
 * GET /api/workspaces/:id/pinned-notes/:sessionId
 * Returns resolved note objects for the session's pinned indices.
 * Response: { notes: [{ text, timestamp }, ...] }
 * Returns empty array (not 404) if the session has no pins.
 */
app.get('/api/workspaces/:id/pinned-notes/:sessionId', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const data = getPinnedNotes(req.params.id);
  const indices = data[req.params.sessionId] || [];

  if (indices.length === 0) {
    return res.json({ notes: [] });
  }

  const docs = store.getWorkspaceDocs(req.params.id);
  const allNotes = (docs && docs.notes) ? docs.notes : [];
  const notes = indices
    .filter(i => i >= 0 && i < allNotes.length)
    .map(i => ({ text: allNotes[i].text, timestamp: allNotes[i].timestamp }));

  return res.json({ notes });
});

// ──────────────────────────────────────────────────────────
//  TD TASK INTEGRATION
//  These endpoints bridge myrlin's docs panel to the `td` CLI
//  (github.com/marcus/td). All td commands run in the context
//  of the workspace's configured repo directory (tdRepoDir).
// ──────────────────────────────────────────────────────────

/**
 * Resolve the td repo directory for a workspace.
 * Uses workspace.tdRepoDir if set, otherwise falls back to the most
 * common workingDir among the workspace's sessions.
 * @param {Object} store
 * @param {string} workspaceId
 * @returns {string|null}
 */
function resolveTdRepoDir(store, workspaceId) {
  const ws = store.getWorkspace(workspaceId);
  if (!ws) return null;
  if (ws.tdRepoDir) return ws.tdRepoDir;
  // Infer from sessions
  const sessions = store.getWorkspaceSessions(workspaceId);
  if (!sessions || sessions.length === 0) return null;
  const counts = {};
  for (const s of sessions) {
    if (s.workingDir) counts[s.workingDir] = (counts[s.workingDir] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;

  const inferredDir = sorted[0][0];

  // If the inferred dir is a git worktree (not the main repo), resolve to the
  // main repo root, that's where .todos/ lives, not inside the worktree.
  // `git rev-parse --git-common-dir` returns the shared .git dir for both the
  // main repo and any linked worktree, so dirname() gives the main repo root.
  try {
    const { execFileSync } = require('child_process');
    const commonGitDir = execFileSync(
      'git', ['-C', inferredDir, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    ).trim();
    const absCommonGitDir = path.isAbsolute(commonGitDir)
      ? commonGitDir
      : path.resolve(inferredDir, commonGitDir);
    const mainRepoRoot = path.dirname(absCommonGitDir);
    if (mainRepoRoot && mainRepoRoot !== inferredDir && require('fs').existsSync(mainRepoRoot)) {
      return mainRepoRoot;
    }
  } catch (_) { /* not a git repo or git unavailable, fall through */ }

  return inferredDir;
}

/**
 * GET /api/workspaces/:id/td/status
 * Returns whether td is available and initialized for this workspace.
 */
app.get('/api/workspaces/:id/td/status', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = resolveTdRepoDir(store, req.params.id);
  const available = await td.isAvailable(getTdBinary()).catch(() => false);
  const initialized = repoDir ? td.isInitialized(repoDir) : false;
  return res.json({ available, initialized, repoDir });
});

/**
 * POST /api/workspaces/:id/td/init
 * Run `td init` in the workspace repo directory.
 * Body: { repoDir? }, optionally set/override the repo dir at the same time.
 */
app.post('/api/workspaces/:id/td/init', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  let repoDir = (req.body && req.body.repoDir) ? req.body.repoDir.trim() : null;
  if (!repoDir) repoDir = resolveTdRepoDir(store, req.params.id);
  if (!repoDir) return res.status(400).json({ error: 'No repo directory configured for this workspace.' });

  // Persist the repoDir on the workspace if it wasn't already set
  if (!ws.tdRepoDir || ws.tdRepoDir !== repoDir) {
    store.updateWorkspace(req.params.id, { tdRepoDir: repoDir });
  }

  const output = await td.init(repoDir, getTdBinary()).catch(err => { throw err; });
  return res.json({ success: true, output, repoDir });
});

/**
 * PUT /api/workspaces/:id/td/repodir
 * Set the repo directory for td integration on this workspace.
 * Body: { repoDir }
 */
app.put('/api/workspaces/:id/td/repodir', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = (req.body && req.body.repoDir) ? req.body.repoDir.trim() : null;
  if (!repoDir) return res.status(400).json({ error: 'repoDir is required.' });

  store.updateWorkspace(req.params.id, { tdRepoDir: repoDir });
  return res.json({ success: true, repoDir });
});

/**
 * GET /api/td/projects
 * Return all workspaces that have td initialized, with their resolved repo dirs.
 * Used by the Tasks > td panel dropdown.
 */
app.get('/api/td/projects', requireAuth, (req, res) => {
  const store = getStore();
  const allWorkspaces = store.getAllWorkspacesList();
  const projects = [];
  for (const ws of allWorkspaces) {
    const repoDir = resolveTdRepoDir(store, ws.id);
    if (repoDir && td.isInitialized(repoDir)) {
      projects.push({ name: ws.name, repoDir, workspaceId: ws.id });
    }
  }
  return res.json({ projects });
});

/**
 * GET /api/td/issues?dir=<path>
 * List td issues for an explicit repo directory (not workspace-scoped).
 * Allows the Tasks panel to show issues for whatever dir is focused.
 * Query: ?dir=<absolute-path>, ?status=open|in_progress|...
 */
app.get('/api/td/issues', requireAuth, async (req, res) => {
  const dir = req.query.dir ? decodeURIComponent(req.query.dir) : null;
  if (!dir) return res.status(400).json({ error: 'dir query parameter required.' });
  if (!td.isInitialized(dir)) return res.status(400).json({ error: 'td is not initialized in this directory.' });
  const filters = req.query.status ? { status: req.query.status } : {};
  const issues = await td.listIssues(dir, filters, getTdBinary());
  return res.json({ issues, repoDir: dir });
});

/**
 * GET /api/workspaces/:id/td/issues
 * List td issues for this workspace's repo.
 * Query: ?status=open|in_progress|in_review|blocked|closed (optional filter)
 */
app.get('/api/workspaces/:id/td/issues', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = resolveTdRepoDir(store, req.params.id);
  if (!repoDir) return res.status(400).json({ error: 'No repo directory configured for this workspace.' });
  if (!td.isInitialized(repoDir)) return res.status(400).json({ error: 'td is not initialized in this directory. POST /td/init first.' });

  const filters = req.query.status ? { status: req.query.status } : {};
  const issues = await td.listIssues(repoDir, filters, getTdBinary());
  return res.json({ issues, repoDir });
});

/**
 * POST /api/workspaces/:id/td/issues
 * Create a new td issue.
 * Body: { title, type?, priority? }
 */
app.post('/api/workspaces/:id/td/issues', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = resolveTdRepoDir(store, req.params.id);
  if (!repoDir) return res.status(400).json({ error: 'No repo directory configured for this workspace.' });
  if (!td.isInitialized(repoDir)) return res.status(400).json({ error: 'td is not initialized in this directory.' });

  const { title, type, priority } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required.' });

  const issueId = await td.createIssue(repoDir, title.trim(), { type, priority }, getTdBinary());
  const issue = await td.showIssue(repoDir, issueId, getTdBinary()).catch(() => ({ id: issueId, title: title.trim() }));
  return res.status(201).json({ issue, issueId });
});

/**
 * DELETE /api/workspaces/:id/td/issues/:issueId
 * Delete a td issue.
 */
app.delete('/api/workspaces/:id/td/issues/:issueId', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = resolveTdRepoDir(store, req.params.id);
  if (!repoDir) return res.status(400).json({ error: 'No repo directory configured for this workspace.' });

  await td.deleteIssue(repoDir, req.params.issueId, getTdBinary());
  return res.json({ success: true });
});

/**
 * GET /api/workspaces/:id/td/issues/:issueId/context
 * Get full td context for an issue (for pre-populating worktree task form).
 */
app.get('/api/workspaces/:id/td/issues/:issueId/context', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = resolveTdRepoDir(store, req.params.id);
  if (!repoDir) return res.status(400).json({ error: 'No repo directory configured for this workspace.' });

  const [details, context] = await Promise.all([
    td.showIssue(repoDir, req.params.issueId, getTdBinary()),
    td.getContext(repoDir, req.params.issueId, getTdBinary()).catch(() => ''),
  ]);
  return res.json({ details, context, repoDir });
});

/**
 * POST /api/workspaces/:id/td/issues/:issueId/start
 * Mark a td issue as in_progress (called when promoting to a worktree task).
 */
app.post('/api/workspaces/:id/td/issues/:issueId/start', requireAuth, async (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const repoDir = resolveTdRepoDir(store, req.params.id);
  if (!repoDir) return res.status(400).json({ error: 'No repo directory configured for this workspace.' });

  await td.startIssue(repoDir, req.params.issueId, getTdBinary());
  return res.json({ success: true });
});

/**
 * GET /api/td/binary
 * Return the currently resolved td binary path and whether it is reachable.
 */
app.get('/api/td/binary', requireAuth, async (req, res) => {
  const binary = getTdBinary();
  const available = await td.isAvailable(binary).catch(() => false);
  return res.json({ binary, available, source: getStore().settings.tdBinary ? 'settings' : (process.env.TD_BINARY ? 'env' : 'default') });
});

/**
 * PUT /api/td/binary
 * Persist the td binary path in the store settings.
 * Body: { binary }, empty string clears it (falls back to env/default).
 */
app.put('/api/td/binary', requireAuth, async (req, res) => {
  const binary = ((req.body && req.body.binary) || '').trim();
  getStore().updateSettings({ tdBinary: binary });
  const resolved = getTdBinary();
  const available = await td.isAvailable(resolved).catch(() => false);
  return res.json({ success: true, binary: resolved, available });
});

// ──────────────────────────────────────────────────────────
//  WORKSPACE GROUPS
// ──────────────────────────────────────────────────────────

/**
 * GET /api/groups
 * Returns all workspace groups.
 */
app.get('/api/groups', requireAuth, (req, res) => {
  const store = getStore();
  return res.json({ groups: store.getAllGroups() });
});

/**
 * POST /api/groups
 * Body: { name, color? }
 * Creates a new workspace group.
 */
app.post('/api/groups', requireAuth, (req, res) => {
  const { name, color } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Group name is required.' });
  }
  const store = getStore();
  const group = store.createGroup({ name: name.trim(), color: color || 'blue' });
  return res.status(201).json({ group });
});

/**
 * PUT /api/groups/:id
 * Body: partial group fields to update (name, color, workspaceIds)
 */
app.put('/api/groups/:id', requireAuth, (req, res) => {
  const store = getStore();
  const group = store.updateGroup(req.params.id, req.body);
  if (!group) {
    return res.status(404).json({ error: 'Group not found.' });
  }
  return res.json({ group });
});

/**
 * DELETE /api/groups/:id
 */
app.delete('/api/groups/:id', requireAuth, (req, res) => {
  const store = getStore();
  const deleted = store.deleteGroup(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Group not found.' });
  }
  return res.json({ success: true });
});

/**
 * POST /api/groups/:id/add
 * Body: { workspaceId }
 * Moves a workspace into this group.
 */
app.post('/api/groups/:id/add', requireAuth, (req, res) => {
  const { workspaceId } = req.body || {};
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required.' });
  }
  const store = getStore();
  const result = store.moveWorkspaceToGroup(workspaceId, req.params.id);
  if (!result) {
    return res.status(404).json({ error: 'Group or workspace not found.' });
  }
  return res.json({ success: true });
});

// (reorder route moved above PUT /api/workspaces/:id to avoid :id capturing "reorder")

// ──────────────────────────────────────────────────────────
//  SESSIONS
// ──────────────────────────────────────────────────────────

/**
 * GET /api/sessions
 * Supports two modes of operation for backward compatibility:
 *
 * Legacy mode (when `mode` param is present):
 *   mode=all          All sessions (default)
 *   mode=workspace    Sessions for a specific workspace (requires workspaceId)
 *   mode=recent       Recently used sessions (optional count)
 *   workspaceId=xxx   Required when mode=workspace
 *   count=N           Number of recent sessions to return (default 10)
 *   Returns: { sessions }
 *
 * Paginated mode (when any pagination param is present without `mode`):
 *   limit=N           Max results per page (default 50, max 100)
 *   offset=N          Skip N results (default 0)
 *   status=string     Filter: running, stopped, error, idle, all (default all)
 *   sort=string       Sort by: lastActive (default), name, created
 *   order=string      Sort direction: asc, desc (default desc)
 *   search=string     Case-insensitive substring match on name and topic
 *   workspaceId=xxx   Filter to sessions in a specific workspace
 *   Returns: { sessions, pagination: { total, limit, offset, hasMore } }
 */
app.get('/api/sessions', requireAuth, (req, res) => {
  const store = getStore();

  // Detect whether to use legacy mode or paginated mode
  const hasMode = req.query.mode != null;
  const hasPaginationParams = req.query.limit || req.query.offset ||
    req.query.status || req.query.sort || req.query.order ||
    req.query.search || (req.query.workspaceId && !hasMode);

  // Legacy mode: preserve existing behavior when mode param is present
  if (hasMode && !hasPaginationParams) {
    const mode = req.query.mode;
    let sessions;

    switch (mode) {
      case 'workspace': {
        const { workspaceId } = req.query;
        if (!workspaceId) {
          return res.status(400).json({ error: 'workspaceId query parameter is required when mode=workspace.' });
        }
        sessions = store.getWorkspaceSessions(workspaceId);
        break;
      }

      case 'recent': {
        const count = parseInt(req.query.count, 10) || 10;
        sessions = store.getRecentSessions(count);
        break;
      }

      case 'all':
      default:
        sessions = store.getAllSessionsList();
        break;
    }

    return res.json({ sessions });
  }

  // Paginated mode: use getPaginatedSessions when any pagination param is present
  if (hasPaginationParams) {
    const result = store.getPaginatedSessions({
      limit: req.query.limit,
      offset: req.query.offset,
      status: req.query.status,
      sort: req.query.sort,
      order: req.query.order,
      search: req.query.search,
      workspaceId: req.query.workspaceId,
    });

    return res.json({
      sessions: result.sessions,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  }

  // Default (no params at all): return all sessions for backward compatibility
  const sessions = store.getAllSessionsList();
  return res.json({ sessions });
});

/**
 * POST /api/sessions
 * Body: { name, workspaceId, workingDir?, topic?, command?, resumeSessionId? }
 */
app.post('/api/sessions', requireAuth, (req, res) => {
  const { name, workspaceId, workingDir, topic, command, resumeSessionId, provider } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Session name is required.' });
  }
  if (name.trim().length > 200) {
    return res.status(400).json({ error: 'Session name must be 200 characters or fewer.' });
  }
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required.' });
  }

  // Validate fields that flow into shell commands. Default v1.1 back-compat:
  // claudeProvider.cliBinary (Plan 15-01 replaced the bare provider-name literal).
  const safeCommand = command ? sanitizeCommand(command) : claudeProvider.cliBinary;
  if (command && !safeCommand) {
    return res.status(400).json({ error: 'Invalid command. Must not contain shell metacharacters.' });
  }
  const safeDir = workingDir ? sanitizeWorkingDir(workingDir) : '';
  if (workingDir && !safeDir) {
    return res.status(400).json({ error: 'Invalid working directory path.' });
  }
  const safeResumeId = resumeSessionId ? sanitizeSessionId(resumeSessionId) : null;
  if (resumeSessionId && !safeResumeId) {
    return res.status(400).json({ error: 'Invalid resume session ID.' });
  }

  // alpha.7: validate + propagate `provider` from the request body. Without
  // this, a Codex Desktop session adopted via "Add to Project" lost its
  // provider tag and silently defaulted via the read-side normalizer.
  // Downstream actions (Start, Start (Bypass), Restart) then launched
  // the wrong CLI against a non-matching session UUID, producing
  // confusing errors. Validation regex matches the registry's allowed
  // id shape.
  let safeProvider = null;
  if (provider !== undefined && provider !== null) {
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,32}$/.test(provider)) {
      return res.status(400).json({ error: 'Invalid provider id.' });
    }
    safeProvider = provider;
  }

  const store = getStore();
  const session = store.createSession({
    name: name.trim(),
    workspaceId,
    workingDir: safeDir,
    topic: topic || '',
    command: safeCommand,
    resumeSessionId: safeResumeId,
  });

  if (!session) {
    return res.status(404).json({ error: 'Workspace not found. Cannot create session.' });
  }

  // Apply provider tag through updateSession so the session is persisted
  // with the correct provider. The two-step (create then update) keeps
  // createSession's signature stable; a future schema bump can fold the
  // field into the constructor.
  if (safeProvider) {
    store.updateSession(session.id, { provider: safeProvider });
    session.provider = safeProvider;
  }

  return res.status(201).json({ session });
});

/**
 * PUT /api/sessions/:id
 * Body: partial session fields to update
 */
app.put('/api/sessions/:id', requireAuth, (req, res) => {
  const store = getStore();
  const updates = req.body || {};

  // Validate fields that flow into shell commands before storing
  if (updates.command !== undefined) {
    const safe = sanitizeCommand(updates.command);
    if (!safe && updates.command) return res.status(400).json({ error: 'Invalid command. Must not contain shell metacharacters.' });
    // Plan 15-01: default v1.1 back-compat is claudeProvider.cliBinary.
    updates.command = safe || claudeProvider.cliBinary;
  }
  if (updates.workingDir !== undefined) {
    const safe = sanitizeWorkingDir(updates.workingDir);
    if (!safe && updates.workingDir) return res.status(400).json({ error: 'Invalid working directory path.' });
    updates.workingDir = safe || '';
  }
  if (updates.model !== undefined) {
    const safe = sanitizeModel(updates.model);
    if (!safe && updates.model) return res.status(400).json({ error: 'Invalid model identifier.' });
    updates.model = safe || '';
  }
  if (updates.resumeSessionId !== undefined) {
    const safe = sanitizeSessionId(updates.resumeSessionId);
    if (!safe && updates.resumeSessionId) return res.status(400).json({ error: 'Invalid resume session ID.' });
    updates.resumeSessionId = safe || null;
  }
  if (updates.tags !== undefined) {
    updates.tags = Array.isArray(updates.tags) ? updates.tags.filter(t => typeof t === 'string' && t.length <= 30).slice(0, 10) : [];
  }

  // Capture previous status before applying updates so we can detect
  // running->stopped transitions for auto-summary generation.
  const existingSession = store.getSession(req.params.id);
  const previousStatus = existingSession ? existingSession.status : null;

  const session = store.updateSession(req.params.id, updates);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  // Auto-transition worktree tasks to "review" when their session stops
  if (updates.status === 'stopped' && previousStatus === 'running') {
    const wtTask = store.getWorktreeTasks().find(t => t.sessionId === req.params.id && t.status === 'running');
    if (wtTask) {
      store.updateWorktreeTask(wtTask.id, { status: 'review', completedAt: new Date().toISOString() });
      broadcastSSE('worktreeTask:updated', { task: store.getWorktreeTasks().find(t => t.id === wtTask.id) });
    }
  }

  // Auto-generate summary when a session transitions from running to stopped
  // and the workspace has autoSummary enabled (defaults to true).
  if (updates.status === 'stopped' && previousStatus === 'running') {
    const ws = session.workspaceId ? store.getWorkspace(session.workspaceId) : null;
    const autoSummaryEnabled = ws ? (ws.autoSummary !== false) : false;

    if (autoSummaryEnabled) {
      // Generate summary in background so we don't block the response
      setImmediate(() => {
        try {
          const resumeSessionId = session.resumeSessionId || req.params.id;
          // Plan 15-01 (DISC-03): dispatch through provider abstraction.
          const provider = getProviderForSession(session);
          const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;
          if (jsonlPath) {
            const summaryText = generateSessionSummary(jsonlPath);
            const fullSummary = `**${session.name}**: ${summaryText}`;
            if (session.workspaceId) {
              store.addWorkspaceNote(session.workspaceId, fullSummary);
              // Broadcast update to SSE clients so the UI refreshes docs
              broadcastSSE('docs:updated', { workspaceId: session.workspaceId });
            }
          }
        } catch (_) {
          // Best-effort - don't crash on summary failure
        }
      });
    }
  }

  return res.json({ session });
});

/**
 * DELETE /api/sessions/:id
 */
app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const store = getStore();
  const deleted = store.deleteSession(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  return res.json({ success: true });
});

/**
 * PUT /api/sessions/:id/provider-settings
 *
 * Phase 21 Plan 21-01: persist per-session provider settings.
 *
 * Request body: { settings: { ...providerSpecificFields } }
 *   For Codex sessions, accepted keys are: model, sandbox, approvalPolicy,
 *   reasoningEffort, bypassApprovalsAndSandbox, features.
 *
 * Validation:
 *   - 404 if session id is unknown
 *   - 400 if body.settings is not a plain object
 *   - 400 if any key is unknown or its value fails the per-key allow-list
 *   - 400 if a free-form string value contains shell-unsafe characters
 *
 * Response: 200 with the canonical persisted bundle.
 *
 * Note: pty-manager re-reads providerSettings from the store on every
 * spawn, so a setting change takes effect the next time the pane is
 * (re)started. The frontend surfaces a toast hint after a successful PUT.
 */
// BUILD-CONTRACT P8.7 / CODEX-PARITY B5, B16, B17.
//
// These three used to be literal copies of the sets in
// src/providers/codex/spawn.js. Two copies of one enum in two layers is how the
// following bug survived: measured across 3002 real threads, the effort set
// covered about 2 percent of actual usage, so a session whose real effort is
// `ultra` could neither be launched with it nor persist it, and a saved
// template silently lost the field on every round trip.
//
// They now re-point at the provider's definition, which is the single source of
// truth, so widening an enum is one edit in one file. Loaded defensively: this
// route's validation must not be what takes the server down if a provider
// module ever fails to load, so a require failure falls back to the original
// literal sets rather than throwing at startup.
const CODEX_SPAWN_ENUMS = (() => {
  const fallback = {
    SANDBOX_VALUES: new Set(['read-only', 'workspace-write', 'danger-full-access']),
    APPROVAL_VALUES: new Set(['untrusted', 'on-failure', 'on-request', 'never']),
    EFFORT_VALUES: new Set(['minimal', 'low', 'medium', 'high']),
  };
  try {
    const spawnModule = require('../providers/codex/spawn');
    return {
      SANDBOX_VALUES: spawnModule.SANDBOX_VALUES instanceof Set ? spawnModule.SANDBOX_VALUES : fallback.SANDBOX_VALUES,
      APPROVAL_VALUES: spawnModule.APPROVAL_VALUES instanceof Set ? spawnModule.APPROVAL_VALUES : fallback.APPROVAL_VALUES,
      EFFORT_VALUES: spawnModule.EFFORT_VALUES instanceof Set ? spawnModule.EFFORT_VALUES : fallback.EFFORT_VALUES,
    };
  } catch (_) {
    return fallback;
  }
})();

const CODEX_SANDBOX_VALUES = CODEX_SPAWN_ENUMS.SANDBOX_VALUES;
const CODEX_APPROVAL_VALUES = CODEX_SPAWN_ENUMS.APPROVAL_VALUES;
const CODEX_EFFORT_VALUES = CODEX_SPAWN_ENUMS.EFFORT_VALUES;
const CODEX_FEATURE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const CODEX_MODEL_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const CODEX_ALLOWED_KEYS = new Set([
  'model', 'sandbox', 'approvalPolicy', 'reasoningEffort',
  'bypassApprovalsAndSandbox', 'features',
]);

function validateCodexProviderSettings(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, error: 'settings must be a plain object' };
  }
  for (const key of Object.keys(settings)) {
    if (!CODEX_ALLOWED_KEYS.has(key)) {
      return { ok: false, error: 'unknown setting key: ' + key };
    }
  }
  if (settings.model !== undefined) {
    if (typeof settings.model !== 'string' || !CODEX_MODEL_ID_RE.test(settings.model) || SHELL_UNSAFE.test(settings.model)) {
      return { ok: false, error: 'invalid model id' };
    }
  }
  if (settings.sandbox !== undefined && !CODEX_SANDBOX_VALUES.has(settings.sandbox)) {
    return { ok: false, error: 'invalid sandbox value' };
  }
  if (settings.approvalPolicy !== undefined && !CODEX_APPROVAL_VALUES.has(settings.approvalPolicy)) {
    return { ok: false, error: 'invalid approvalPolicy value' };
  }
  if (settings.reasoningEffort !== undefined && !CODEX_EFFORT_VALUES.has(settings.reasoningEffort)) {
    return { ok: false, error: 'invalid reasoningEffort value' };
  }
  if (settings.bypassApprovalsAndSandbox !== undefined && typeof settings.bypassApprovalsAndSandbox !== 'boolean') {
    return { ok: false, error: 'bypassApprovalsAndSandbox must be boolean' };
  }
  if (settings.features !== undefined) {
    if (!Array.isArray(settings.features)) {
      return { ok: false, error: 'features must be an array' };
    }
    for (const name of settings.features) {
      if (typeof name !== 'string' || !CODEX_FEATURE_NAME_RE.test(name) || SHELL_UNSAFE.test(name)) {
        return { ok: false, error: 'invalid feature name: ' + name };
      }
    }
  }
  return { ok: true };
}

app.put('/api/sessions/:id/provider-settings', requireAuth, (req, res) => {
  const store = getStore();
  const sessionId = req.params.id;
  const session = store.getSession(sessionId);
  const settings = req.body && req.body.settings;
  if (settings === undefined || settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'settings must be a plain object' });
  }

  // Provider resolution. Three sources, priority high → low:
  //   1. session.provider when a Myrlin store record exists (authoritative).
  //   2. req.body.provider when the caller explicitly tags an ad-hoc session
  //      (the typical Codex Desktop right-click-opened pane case where
  //      :id is the Codex UUID and no store record exists).
  //   3. None → 404 (ad-hoc PUT without provider tag is ambiguous: we can't
  //      know which enum allow-list to validate against).
  let providerId = null;
  let isAdHoc = false;
  if (session) {
    providerId = session.provider || 'claude'; // gsd:provider-literal-allowed (back-compat default for un-tagged legacy sessions)
  } else if (typeof req.body.provider === 'string' && /^[a-z][a-z0-9_-]{0,32}$/.test(req.body.provider)) {
    // alpha.6 ad-hoc fallback: allow per-(provider, upstream-uuid) settings
    // for discovered sessions that have no Myrlin store entry yet.
    providerId = req.body.provider;
    isAdHoc = true;
    // The url :id must look like a safe upstream session id (the same
    // shell-safe shape resumeSessionId uses elsewhere). Reject otherwise so
    // a hostile caller can't pollute state with arbitrary keys.
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'invalid session id for ad-hoc provider-settings' });
    }
  } else {
    return res.status(404).json({ error: 'Session not found.' });
  }

  // Per-provider validation. Today only Codex has a settings surface; Claude
  // gets a 400 until a future plan defines its bundle shape.
  if (providerId === 'codex') { // gsd:provider-literal-allowed
    const check = validateCodexProviderSettings(settings);
    if (!check.ok) {
      return res.status(400).json({ error: check.error });
    }
  } else {
    return res.status(400).json({ error: 'provider does not accept provider-settings: ' + providerId });
  }

  if (isAdHoc) {
    store.setProviderSessionSettings(providerId, sessionId, settings);
    return res.json({
      success: true,
      sessionId,
      provider: providerId,
      settings,
      adHoc: true,
    });
  }

  const updated = store.updateSessionProviderSettings(sessionId, providerId, settings);
  if (!updated) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  return res.json({
    success: true,
    sessionId,
    provider: providerId,
    settings: updated.providerSettings[providerId],
  });
});

// Provider id shape shared with the ad-hoc provider-settings route. Kept as a
// named constant so both routes validate identically and a future change is
// made in one place.
const SESSION_TITLE_PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,32}$/;
// Upper bound on a stored title. Long enough for any human name; short enough
// that a hostile caller cannot bloat state. Trimmed before length is measured.
const SESSION_TITLE_MAX_LEN = 200;

/**
 * PUT /api/session-titles/:providerId/:uuid
 *
 * Persist (or clear) a human title override for an upstream session UUID so a
 * rename becomes searchable server-side AND syncs across devices (localStorage
 * was device-local). Keyed by (providerId, upstream UUID), mirroring the
 * ad-hoc provider-settings slot.
 *
 * Params:
 *   - :providerId must match SESSION_TITLE_PROVIDER_ID_RE and resolve to a
 *     registered provider (enabled or not); unknown providers are rejected so
 *     we never store titles under a never-shipped id.
 *   - :uuid must pass sanitizeSessionId (UUID-ish, shell-safe).
 *
 * Body: { title }. Trimmed and capped at SESSION_TITLE_MAX_LEN. An empty title
 * DELETES the override (the only deletion path; the product rule is "no
 * tracked session is ever lost", so titles are never dropped implicitly).
 *
 * Response: 200 { success, provider, uuid, title|null, deleted }.
 */
app.put('/api/session-titles/:providerId/:uuid', requireAuth, (req, res) => {
  const providerId = req.params.providerId;
  if (typeof providerId !== 'string' || !SESSION_TITLE_PROVIDER_ID_RE.test(providerId)) {
    return res.status(400).json({ error: 'invalid providerId' });
  }
  // Reject unknown providers so state stays keyed by real registry ids.
  if (!registry.getProvider(providerId)) {
    return res.status(400).json({ error: 'unknown provider: ' + providerId });
  }
  const uuid = sanitizeSessionId(req.params.uuid);
  if (!uuid) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  const rawTitle = req.body && typeof req.body.title === 'string' ? req.body.title : '';
  let title = rawTitle.trim();
  if (title.length > SESSION_TITLE_MAX_LEN) {
    title = title.slice(0, SESSION_TITLE_MAX_LEN);
  }

  const store = getStore();
  // Empty title -> deletion; non-empty -> set. The store method handles both
  // and prunes empty buckets. It saves + emits an event either way.
  const stored = store.setProviderSessionTitle(providerId, uuid, title);
  return res.json({
    success: true,
    provider: providerId,
    uuid: uuid,
    title: stored,
    deleted: stored === null,
  });
});

/**
 * POST /api/sessions/:id/start
 * Launch the session process and mark it as recently used.
 */
app.post('/api/sessions/:id/start', requireAuth, (req, res) => {
  const store = getStore();
  const result = launchSession(req.params.id);

  if (result.success) {
    store.touchRecent(req.params.id);
  }

  return res.json(result);
});

/**
 * POST /api/sessions/:id/stop
 * Stop the running session process.
 */
app.post('/api/sessions/:id/stop', requireAuth, (req, res) => {
  const result = stopSession(req.params.id);
  return res.json(result);
});

/**
 * POST /api/sessions/:id/restart
 * Restart the session process and mark it as recently used.
 */
app.post('/api/sessions/:id/restart', requireAuth, (req, res) => {
  const store = getStore();
  const result = restartSession(req.params.id);

  if (result.success) {
    store.touchRecent(req.params.id);
  }

  return res.json(result);
});

// ──────────────────────────────────────────────────────────
//  SCROLLBACK & LOGS PAGINATION
// ──────────────────────────────────────────────────────────

/**
 * GET /api/sessions/:id/scrollback
 * Returns paginated lines from the session's PTY scrollback buffer.
 * Query params:
 *   - lines: number of lines to return (default 100, max 1000)
 *   - from: 'end' for last N lines (default), or numeric line index
 * Returns: { lines: string[], total: number, from: number, hasMore: boolean }
 */
app.get('/api/sessions/:id/scrollback', requireAuth, (req, res) => {
  const ptyManager = getPtyManager();
  if (!ptyManager) {
    return res.json({ lines: [], total: 0, from: 0, hasMore: false });
  }

  const lines = Math.max(1, Math.min(1000, parseInt(req.query.lines, 10) || 100));
  const from = req.query.from === undefined || req.query.from === 'end'
    ? 'end'
    : parseInt(req.query.from, 10);

  const result = ptyManager.getScrollbackLines(req.params.id, { lines, from });
  return res.json(result);
});

/* ──────────────────────────────────────────────────────────────
   DEEP NORMAL-BUFFER HISTORY (Notion restyle P7.5)

   The route TERMINAL-ARCHITECTURE.md stage 4 names, wrapping the read
   API P6 left ready (`ptyManager.getHistoryLines`). It is the data
   source for the history layer's `deep` segment, which is the half of
   the Unified Scrollback Surface that serves NORMAL-buffer panes: a
   shell, a build, a REPL. Alternate-buffer panes route to the session
   transcript through /api/mirror/* instead, because a viewport that
   never scrolls has no terminal-layer history to serve (section 2.3).

   FOUR PROPERTIES, each deliberate:

     READ-ONLY AND BOUNDED. The sidecar's own readLines clamps the page
     to [1, 10000]; this route clamps harder, to HISTORY_ROUTE_MAX_LINES,
     because the page size a browser asks for is untrusted input and a
     10000-line page of 200-column lines is a 4 MB response. The client
     pages instead, which is what `hasMore` and `firstLine` are for.

     IT NEVER THROWS AND NEVER 404s. A session with no sidecar (the
     default: CWM_VT_SIDECAR is off), a session that does not exist, and
     a disposed sidecar all answer 200 with `available: false` and an
     empty page. The layer treats "no deep history" as an ordinary state
     rather than an error, so an error status here would turn a normal
     condition into a red console line on every open.

     IT REPORTS ITS OWN SEAMS. `lostLines` counts lines evicted before
     capture and `reflows` counts resize seams, and the log can repeat
     up to |delta rows| lines around a widen (vt-sidecar.js
     _rebaselineLineLog). Both are published so the client can dedupe at
     RENDER time with a bounded window rather than guess, and so a gap is
     visible rather than invented. That is the same ruling section 7.4
     makes for the transcript seam: a visible duplicate beats a silent
     deletion.

     IT CARRIES THE MODE. `getSessionMode` is free here and answers the
     one question the client needs before it can route (alt buffer or
     not). The WebSocket `mode` frame is still the primary signal; this
     is the fallback for a client that attached before the sidecar had
     an opinion, and it is null whenever the sidecar is off, which is
     exactly when the client falls back to `buffer.active.type`.
   ────────────────────────────────────────────────────────────── */

// Hard ceiling on one page of deep history. HISTORY_PAGE_LINES in
// TERMINAL-ARCHITECTURE.md 11.2 is 2000, which is one page of the history
// document, so a request larger than that cannot be a page render.
const HISTORY_ROUTE_MAX_LINES = 2000;

// Default page size when the caller does not ask for one.
const HISTORY_ROUTE_DEFAULT_LINES = 500;

/**
 * GET /api/sessions/:id/history
 *
 * Returns one page of committed normal-buffer lines from the session's VT
 * sidecar, newest page first, paging backwards by absolute line index.
 *
 * Query params:
 *   - beforeLine: absolute line index to page backwards FROM (exclusive).
 *     Omitted means "the newest page".
 *   - lines: page size, clamped to [1, HISTORY_ROUTE_MAX_LINES].
 *
 * Returns: {
 *   lines: Array<{t: string, w: boolean}>,  // oldest first within the page;
 *                                           // w is isWrapped, so a client can
 *                                           // rejoin a wrapped logical line
 *   firstLine, beforeLine, total, oldestAvailable, hasMore,
 *   lostLines, reflows, available, maxLines,
 *   mode: {altBuffer, mouseTracking, mouseTrackingActive, bracketedPaste}|null
 * }
 */
app.get('/api/sessions/:id/history', requireAuth, (req, res) => {
  // One empty shape, used for every "nothing to serve" case, so a client
  // never has to branch on null or on a status code.
  const empty = {
    lines: [], firstLine: 0, beforeLine: 0, total: 0, oldestAvailable: 0,
    hasMore: false, lostLines: 0, reflows: 0, available: false,
    maxLines: HISTORY_ROUTE_MAX_LINES, mode: null,
  };

  try {
    const ptyManager = getPtyManager();
    if (!ptyManager) return res.json(empty);

    const requested = parseInt(req.query.lines, 10);
    const lines = Math.max(1, Math.min(
      HISTORY_ROUTE_MAX_LINES,
      Number.isFinite(requested) ? requested : HISTORY_ROUTE_DEFAULT_LINES
    ));
    // A missing, blank or malformed cursor means "the newest page". A negative
    // one is clamped rather than rejected: the sidecar already clamps into
    // [oldestAvailable, total], so an out-of-range cursor is answered with the
    // nearest real page instead of a 400 the layer would have to handle.
    const parsedBefore = parseInt(req.query.beforeLine, 10);
    const options = { lines };
    if (Number.isFinite(parsedBefore)) options.beforeLine = Math.max(0, parsedBefore);

    const page = ptyManager.getHistoryLines(req.params.id, options);

    // Seam counter for render-time dedupe. Read from the diagnostics surface
    // rather than added to getHistoryLines, so P6's read API keeps the exact
    // shape it published and this route owns its own enrichment.
    let reflows = 0;
    try {
      const stats = ptyManager.getSidecarStats();
      const list = (stats && Array.isArray(stats.sidecars)) ? stats.sidecars : [];
      const mine = list.find((s) => s && s.sessionId === req.params.id);
      if (mine && typeof mine.reflows === 'number') reflows = mine.reflows;
    } catch (_) { /* diagnostics are advisory; a page without them still renders */ }

    let mode = null;
    try { mode = ptyManager.getSessionMode(req.params.id) || null; } catch (_) { mode = null; }

    return res.json(Object.assign({}, empty, page, {
      reflows,
      mode,
      maxLines: HISTORY_ROUTE_MAX_LINES,
    }));
  } catch (_) {
    // The history layer degrades to the client-side ring on an empty page, so
    // answering 200-with-nothing keeps a pane readable when this fails.
    return res.json(empty);
  }
});

/**
 * GET /api/sessions/:id/logs
 * Returns paginated session log entries.
 * Query params:
 *   - limit: max entries to return (default 50, max 100)
 *   - offset: starting index (default 0)
 * Returns: { logs: Array, total: number, hasMore: boolean }
 */
app.get('/api/sessions/:id/logs', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const logs = session.logs || [];
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const sliced = logs.slice(offset, offset + limit);
  return res.json({
    logs: sliced,
    total: logs.length,
    hasMore: (offset + sliced.length) < logs.length,
  });
});

// ──────────────────────────────────────────────────────────
//  STATS
// ──────────────────────────────────────────────────────────

/**
 * GET /api/stats
 * Returns aggregate statistics about the current state.
 */
app.get('/api/stats', requireAuth, (req, res) => {
  const store = getStore();
  const allWorkspaces = store.getAllWorkspacesList();
  const allSessions = store.getAllSessionsList();

  const runningSessions = allSessions.filter(
    (s) => s.status === 'running'
  ).length;

  const activeWorkspace = store.getActiveWorkspace();

  return res.json({
    totalWorkspaces: allWorkspaces.length,
    totalSessions: allSessions.length,
    runningSessions,
    activeWorkspace: activeWorkspace
      ? { id: activeWorkspace.id, name: activeWorkspace.name }
      : null,
  });
});

// ──────────────────────────────────────────────────────────
//  DISCOVER - Scan local Claude sessions
// ──────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
// Claude path-decode helpers, MOVED to src/providers/claude/path-decode.js (Plan 14-03 / ABST-03).
// Transcript artifact lookups were also lifted into path-decode.js by Plan 15-01
// (DISC-03) and are NO LONGER required directly here; route handlers dispatch
// through getProviderForSession + claudeProvider.findArtifactPath /
// findArtifactByWorkingDir so the abstraction is ready for Phase 17 (Codex).
const {
  decodeClaudePath,
  greedyFsWalk,
  resolveProjectPath,
  getOriginalPathFromJsonl,
  getProjectDisplayName,
  isLikelyFailedCJKDecode,
  CJK_REGEX,
} = require('../providers/claude/path-decode');
// Claude parse helpers, MOVED to src/providers/claude/parse.js (Plan 14-03 / ABST-03).
const { extractCustomTitle, extractSessionName } = require('../providers/claude/parse');

// ─── Discover Cache (30s TTL, per-provider) ──────────────────────────────
// Plan 15-02 (DISC-05): per-provider cache keyed by provider id. Toggling
// a single provider does NOT invalidate other providers' cache entries; the
// TTL check happens per-key so a fresh scan for Codex does not force a
// re-walk of Claude's tree. Plan 15-03's PUT /api/providers/:id/enabled
// handler invokes _discoverCache.delete(id) on toggle-off to drop the
// toggled provider's slot while leaving sibling slots intact.
const _discoverCache = new Map(); // Map<providerId, {data: Array, time: number}>
const DISCOVER_CACHE_TTL = 30000; // 30 seconds

// ─── Session liveness (issue #10 Tier 1, Phase 0) ────────────────────────
/**
 * How recently a session's transcript artifact must have been written for
 * the session to be flagged `live` in discovery responses. mtime-based
 * heuristic: "live" means "the CLI wrote transcript lines within the
 * window", NOT "a process is currently running" (a hung CLI stops writing
 * and goes stale; a session waiting on user input also reads as stale).
 * Env-overridable (CWM_MIRROR shares the same knob via mirror-service.js)
 * so operators can widen the window for slow-writing providers.
 */
const LIVE_THRESHOLD_MS = (() => {
  const raw = parseInt(process.env.CWM_LIVE_THRESHOLD_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120000;
})();

/**
 * Group a provider's ProviderSession[] return into the v1.2 per-project
 * accordion shape the existing frontend renders. Grouping key is
 * projectPath (the resolved cwd). Each output entry has:
 *   { encodedName, realPath, displayName, failedDecode, dirExists,
 *     hasClaudeMd, sessionCount, totalSize, lastActive,
 *     sessions: [{ claudeSessionId, modified, size, title, provider }] }
 *
 * encodedName comes from the provider's session record (Plan 15-02 added
 * it to claudeProvider.discover); for providers that don't expose it
 * the field is set to null and the display-name fallback uses realPath.
 *
 * Plan 15-02 (DISC-01).
 *
 * @param {Array} sessions - ProviderSession[] from provider.discover().
 * @param {Object} provider - The provider object (used for provider.id tagging).
 * @returns {Array} Project accordion array, sorted by lastActive descending.
 */
function groupProviderSessionsForUI(sessions, provider) {
  const byProject = new Map();
  // Read-time title merge: a rename persisted via PUT /api/session-titles is
  // stored keyed by (provider.id, upstream UUID). We apply it here so the
  // custom name shows in the sidebar AND flows into every consumer that
  // reuses this grouping (GET /api/discover, POST /api/ai/find-session). The
  // provider stays pure: the override lookup lives in server.js and keys off
  // provider.id (registry data), never a string literal. Wrapped defensively
  // so a store hiccup never breaks discovery grouping.
  let _titleStore = null;
  try { _titleStore = getStore(); } catch (_) { _titleStore = null; }
  for (const s of sessions) {
    const key = s.projectPath || '(unknown)';
    let bucket = byProject.get(key);
    if (!bucket) {
      bucket = {
        provider: provider.id, // Frontend render filter reads this on the bucket; without it non-Claude provider buckets default to the Claude id via the fallback at app.js renderProjects and never match the corresponding tab.
        realPath: s.projectPath || '(unknown)',
        encodedName: s.encodedName || null,
        displayName: null,
        failedDecode: false,
        dirExists: false,
        hasClaudeMd: false,
        sessionCount: 0,
        totalSize: 0,
        lastActive: null,
        sessions: [],
      };
      byProject.set(key, bucket);
    }
    bucket.sessionCount++;
    bucket.totalSize += (s.sizeBytes || 0);
    if (!bucket.lastActive || (s.lastActive && new Date(s.lastActive) > new Date(bucket.lastActive))) {
      bucket.lastActive = s.lastActive;
    }
    // storeOverride wins over the transcript-extracted title so a user rename
    // is authoritative; falls back to the provider-extracted title otherwise.
    let storeOverride = null;
    if (_titleStore && s.providerSessionId) {
      try { storeOverride = _titleStore.getProviderSessionTitle(provider.id, s.providerSessionId); } catch (_) { storeOverride = null; }
    }
    // Issue #10 Phase 0: liveness flags for the mirror affordance. Guarded
    // through Number.isFinite so a malformed lastActive can never leak NaN
    // into the JSON payload (JSON.stringify would silently null it).
    const lastActiveMs = s.lastActive ? new Date(s.lastActive).getTime() : NaN;
    bucket.sessions.push({
      claudeSessionId: s.providerSessionId, // legacy field name; v1.1 frontend uses this key
      provider: provider.id,
      modified: s.lastActive,
      size: s.sizeBytes,
      title: storeOverride || s.title || null,
      // Carry the archived flag from the provider (codex archived_sessions/)
      // through to the frontend so a discovered archived thread can be shown
      // with a muted affordance. Absent/false for live sessions.
      archived: s.archived === true,
      // Issue #10 Phase 0: `live` is a pure mtime heuristic (transcript
      // written within LIVE_THRESHOLD_MS), never process state. Archived
      // threads are never live regardless of mtime.
      live: Number.isFinite(lastActiveMs)
        && (Date.now() - lastActiveMs) < LIVE_THRESHOLD_MS
        && s.archived !== true,
      lastActiveMs: Number.isFinite(lastActiveMs) ? lastActiveMs : null,
    });
  }

  const projects = Array.from(byProject.values());
  for (const p of projects) {
    p.displayName = getProjectDisplayName(p.encodedName || p.realPath, p.realPath);
    p.failedDecode = p.encodedName ? isLikelyFailedCJKDecode(p.encodedName) : false;
    try { p.dirExists = fs.existsSync(p.realPath); } catch (_) { /* ignore */ }
    try { p.hasClaudeMd = fs.existsSync(path.join(p.realPath, 'CLAUDE.md')); } catch (_) { /* ignore */ }
    p.sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  }
  projects.sort((a, b) => {
    if (!a.lastActive) return 1;
    if (!b.lastActive) return -1;
    return new Date(b.lastActive) - new Date(a.lastActive);
  });
  return projects;
}

/**
 * GET /api/discover
 * Plan 15-02 (DISC-01/02/04/05): per-provider registry dispatcher.
 *
 * Default response shape: { projects: { <providerId>: [<ProjectAccordion>...] } }
 * where projects is a plain object keyed by registered-and-enabled provider id.
 * Each session record inside the per-project accordion carries a provider tag.
 *
 * Backward compat: ?legacy=1 returns the v1.1 array shape
 * { projects: [<ProjectAccordion>...] } populated with Claude entries only.
 * Codex entries are dropped from the legacy response intentionally; pre-v1.2
 * callers do not understand provider tagging. New callers should consume the
 * default object shape.
 *
 * Snapshot semantics (DISC-04, PITFALL F7): registry.listEnabled() is called
 * ONCE on the first executable line of the route, ensuring a mid-request
 * toggle cannot produce a half-toggled response.
 *
 * Per-provider cache (DISC-05): _discoverCache is a Map keyed by provider id;
 * toggling a single provider does NOT invalidate other providers' cache
 * entries.
 *
 * Provider failure isolation: if a provider.discover throws, that provider's
 * slot is set to [] and the error is logged via console.error; other
 * providers' results are preserved.
 *
 * Query params:
 *   ?refresh=true  bypass cache for all enabled providers
 *   ?legacy=1      return v1.1 array shape (Claude-only)
 */
app.get('/api/discover', requireAuth, async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === 'true';
  const wantLegacy = req.query.legacy === '1';

  // PITFALL F7: snapshot the enabled providers ONCE at request entry.
  // A mid-request toggle does NOT change this snapshot. The Set inside
  // the registry mutates, but our local array is a fresh copy.
  const enabled = registry.listEnabled();
  if (enabled.length === 0) {
    return res.json(wantLegacy ? { projects: [] } : { projects: {} });
  }

  const projects = {};
  for (const provider of enabled) {
    let entry = _discoverCache.get(provider.id);
    if (forceRefresh || !entry || (now - entry.time) >= DISCOVER_CACHE_TTL) {
      try {
        const sessions = await provider.discover({ forceRefresh });
        if (!Array.isArray(sessions)) {
          throw new Error('provider.discover returned non-array');
        }
        const grouped = groupProviderSessionsForUI(sessions, provider);
        entry = { data: grouped, time: now };
        _discoverCache.set(provider.id, entry);
      } catch (err) {
        console.error('[discover] provider ' + provider.id + ' failed: ' + (err && err.message ? err.message : err));
        entry = { data: [], time: now };
        _discoverCache.set(provider.id, entry);
      }
    }
    projects[provider.id] = entry.data;
  }

  if (wantLegacy) {
    // v1.1 shape: array of project accordions, Claude-only. Codex entries
    // are dropped intentionally; pre-v1.2 callers do not understand provider
    // tagging. New callers should consume the default object shape. We
    // source the key from claudeProvider.id (registry-sourced provider name)
    // so the grep gate stays clean without an allowlist marker.
    const claudeProjects = projects[claudeProvider.id] || [];
    return res.json({ projects: claudeProjects });
  }

  // Plan 22-01: include ad-hoc provider-settings keyed by upstream
  // session UUID so the bottom status strip can hydrate on first render
  // for discovered Codex Desktop sessions that have no Myrlin store
  // record. The frontend reads state.adHocProviderSettings from this
  // field; only `codex` carries data today, but the shape is open for
  // future providers (gemini, etc.).
  const store = getStore();
  const adHocRoot = (store._state && store._state.providerSessionSettings) || {};
  return res.json({ projects, adHocProviderSettings: adHocRoot });
});


// ──────────────────────────────────────────────────────────
//  MIRROR - read-only live mirror of provider sessions
//  (issue #10 Tier 1, Phase 3; service in src/web/mirror-service.js)
// ──────────────────────────────────────────────────────────

// Validation patterns. Provider ids reuse the exact shape enforced by
// POST /api/sessions (lowercase slug, matches registry id conventions).
// providerSessionId covers Claude UUIDs and Codex rollout thread ids; the
// length cap blocks pathological input without loosening the charset.
const MIRROR_PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,32}$/;
const MIRROR_SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,256}$/;
// deviceId: web tabs use 'web-<uuid>'; paired mobile devices use their
// pairing uuid. Colon allowed for forward-compat with prefixed schemes.
const MIRROR_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Validate the (provider, providerSessionId) pair shared by every mirror
 * endpoint. Returns null when valid, otherwise writes a structured 400
 * response and returns the response (truthy) so callers can early-return.
 *
 * @param {import('express').Response} res
 * @param {*} provider - Candidate provider id.
 * @param {*} providerSessionId - Candidate upstream session id.
 * @returns {object|null} The 400 response, or null when valid.
 */
function rejectInvalidMirrorTarget(res, provider, providerSessionId) {
  if (typeof provider !== 'string' || !MIRROR_PROVIDER_ID_RE.test(provider)) {
    return structuredError(res, 400, 'INVALID_PROVIDER', 'provider must match ' + String(MIRROR_PROVIDER_ID_RE));
  }
  if (typeof providerSessionId !== 'string' || !MIRROR_SESSION_ID_RE.test(providerSessionId)) {
    return structuredError(res, 400, 'INVALID_SESSION_ID', 'providerSessionId must match ' + String(MIRROR_SESSION_ID_RE));
  }
  return null;
}

/**
 * Map a MirrorService error to its HTTP response. Unknown codes become a
 * 500 with a generic message (never leak filesystem paths to the client).
 *
 * @param {import('express').Response} res
 * @param {Error} err - Error thrown by MirrorService (carries .code).
 * @returns {object} The written response.
 */
function mirrorErrorResponse(res, err) {
  const code = err && err.code;
  if (code === 'MIRROR_UNSUPPORTED') {
    return structuredError(res, 400, 'MIRROR_UNSUPPORTED', 'This provider does not support mirroring.');
  }
  if (code === 'ARTIFACT_NOT_FOUND') {
    return structuredError(res, 404, 'ARTIFACT_NOT_FOUND', 'No transcript found for that session.');
  }
  if (code === 'MIRROR_LIMIT') {
    return structuredError(res, 409, 'MIRROR_LIMIT', 'Too many mirrors open. Close one and retry.');
  }
  console.error('[mirror] request failed: ' + (err && err.message ? err.message : err));
  return structuredError(res, 500, 'MIRROR_FAILED', 'Mirror operation failed.', true);
}

/**
 * POST /api/mirror/open
 * Body: { provider, providerSessionId, deviceId }
 * Opens (or attaches to) a read-only mirror. Response is the MirrorService
 * open() payload: { mirrorKey, live, fileSize, startOffset, endOffset,
 * truncatedHead, history }. Idempotent per (key, deviceId): reconnecting
 * clients re-POST after SSE drops and simply get a fresh history snapshot.
 */
app.post('/api/mirror/open', requireAuth, async (req, res) => {
  const { provider, providerSessionId, deviceId } = req.body || {};
  const invalid = rejectInvalidMirrorTarget(res, provider, providerSessionId);
  if (invalid) return invalid;
  if (typeof deviceId !== 'string' || !MIRROR_DEVICE_ID_RE.test(deviceId)) {
    return structuredError(res, 400, 'INVALID_DEVICE_ID', 'deviceId must match ' + String(MIRROR_DEVICE_ID_RE));
  }
  try {
    const result = await mirrorService.open({ provider, providerSessionId, deviceId });
    return res.json(result);
  } catch (err) {
    return mirrorErrorResponse(res, err);
  }
});

/**
 * POST /api/mirror/close
 * Body: { mirrorKey, deviceId }
 * Detaches a device from a mirror. Always returns {ok:true} for unknown
 * keys (close is a courtesy call; the idle sweep is the safety net).
 */
app.post('/api/mirror/close', requireAuth, (req, res) => {
  const { mirrorKey, deviceId } = req.body || {};
  if (typeof mirrorKey !== 'string' || mirrorKey.length === 0 || mirrorKey.length > 300) {
    return structuredError(res, 400, 'INVALID_MIRROR_KEY', 'mirrorKey is required');
  }
  // Key shape check: providerId ':' providerSessionId with the same
  // per-part patterns as open. Rejecting garbage early keeps the service
  // map free of unparseable keys (they could never match an entry anyway).
  const sepIdx = mirrorKey.indexOf(MIRROR_KEY_SEPARATOR);
  const keyProvider = sepIdx > 0 ? mirrorKey.slice(0, sepIdx) : '';
  const keySession = sepIdx > 0 ? mirrorKey.slice(sepIdx + 1) : '';
  const invalid = rejectInvalidMirrorTarget(res, keyProvider, keySession);
  if (invalid) return invalid;
  if (deviceId !== undefined && (typeof deviceId !== 'string' || !MIRROR_DEVICE_ID_RE.test(deviceId))) {
    return structuredError(res, 400, 'INVALID_DEVICE_ID', 'deviceId must match ' + String(MIRROR_DEVICE_ID_RE));
  }
  try {
    mirrorService.close({ mirrorKey, deviceId });
    return res.json({ ok: true });
  } catch (err) {
    return mirrorErrorResponse(res, err);
  }
});

/**
 * GET /api/mirror/history?provider&providerSessionId&beforeOffset&maxBytes
 * Stateless "Load earlier" window: parses the lines that end before
 * beforeOffset (a line-aligned byte offset from a previous open/history
 * response). No watcher is created. Response: { messages, startOffset,
 * truncatedHead }.
 */
app.get('/api/mirror/history', requireAuth, async (req, res) => {
  const provider = req.query.provider;
  const providerSessionId = req.query.providerSessionId;
  const invalid = rejectInvalidMirrorTarget(res, provider, providerSessionId);
  if (invalid) return invalid;
  const beforeOffset = parseInt(req.query.beforeOffset, 10);
  if (!Number.isFinite(beforeOffset) || beforeOffset < 0) {
    return structuredError(res, 400, 'INVALID_OFFSET', 'beforeOffset must be a non-negative integer');
  }
  // maxBytes is optional; the service clamps it to the history window cap,
  // so a hostile query param can never force a giant read.
  const maxBytesRaw = parseInt(req.query.maxBytes, 10);
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : undefined;
  try {
    const result = await mirrorService.readEarlier({ provider, providerSessionId, beforeOffset, maxBytes });
    return res.json(result);
  } catch (err) {
    return mirrorErrorResponse(res, err);
  }
});


// ──────────────────────────────────────────────────────────
//  PROVIDERS - Registry-backed metadata + toggle endpoints
//  Plan 15-03 (DISC-06, DISC-07). The two endpoints below expose the
//  Provider registry surface to the frontend. GET returns the tile
//  shape including a PATH-probe `available` flag; PUT persists toggle
//  state and runs provider lifecycle hooks. Both routes use the
//  existing requireAuth middleware. Routes are declared HERE,
//  immediately after GET /api/discover, so Express's declaration-order
//  matching reaches them before any later wildcard catch-alls and so
//  the provider surface lives in one contiguous block in the source.
// ──────────────────────────────────────────────────────────

// ─── Availability Probe Cache (30s TTL) ────────────────────
// Keyed by cliBinary so two providers that happen to share a binary
// name share a probe result. The cache is module-local and reset only
// by process restart or explicit ?refresh=true on a request.
const _availabilityCache = new Map(); // Map<cliBinary, {available: boolean, time: number}>
const AVAILABILITY_CACHE_TTL = 30000; // 30 seconds

/**
 * Probe whether the given CLI binary is on PATH. Uses `where` on Windows
 * and `which` on POSIX. Result is cached for 30s to avoid spawning a
 * subprocess on every /api/providers request. The cache is keyed by
 * cliBinary so two providers sharing a binary name share a result.
 *
 * The probe has a hard 2-second timeout per spawn so a misbehaving PATH
 * entry (slow network filesystem, dead drive, etc.) cannot block the
 * Node event loop for more than 2s per cache miss.
 *
 * Defense in depth: JSON.stringify on cliBinary defends against any
 * shell-special characters in a future provider's binary name. Today
 * every registered provider's cliBinary is a hardcoded ASCII slug so
 * the quoting is paranoia, but cheap insurance.
 *
 * Plan 15-03 (DISC-06).
 *
 * @param {string} cliBinary - The provider's cliBinary field.
 * @param {boolean} [forceRefresh=false] - Bypass cache and re-probe.
 * @returns {boolean} True if the binary is reachable via PATH.
 */
function probeAvailability(cliBinary, forceRefresh) {
  const now = Date.now();
  const cached = _availabilityCache.get(cliBinary);
  if (!forceRefresh && cached && (now - cached.time) < AVAILABILITY_CACHE_TTL) {
    return cached.available;
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  let available = false;
  try {
    execSync(cmd + ' ' + JSON.stringify(cliBinary), { stdio: 'pipe', timeout: 2000, windowsHide: true });
    available = true;
  } catch (_) {
    available = false;
  }
  _availabilityCache.set(cliBinary, { available, time: now });
  return available;
}

/**
 * GET /api/providers
 *
 * Returns the list of registered providers with their enabled flag
 * (from registry.isEnabled) and available flag (PATH probe of
 * cliBinary). Response shape feeds the Phase 18 Settings UI Providers
 * section.
 *
 * Query params:
 *   ?refresh=true  Bypass the 30s availability cache and re-probe.
 *
 * Response (200):
 *   [{id, displayName, accentToken, enabled, available, supportsCost,
 *     supportsTokenUsage}]
 *
 * Plan 15-03 (DISC-06). Plan 18-04 added supportsCost so the frontend can
 * disclose Codex's "cost not tracked" state with an em-dash + tooltip
 * instead of misleading "$0.00" badges (COST-02 / COST-03).
 *
 * BUILD-CONTRACT P9.3 added supportsTokenUsage, because the two claims are not
 * the same one. "We know how many tokens this session burned" and "we know what
 * it cost in money" were conflated behind a single flag, and Codex can only make
 * the first: it bills against a ChatGPT plan and its rollouts carry a plan type
 * and a credits block but no price. A row that is `supportsCost: false,
 * supportsTokenUsage: true` should show a token count where a Claude row shows
 * a dollar amount, rather than showing nothing or, worse, `$0.00`.
 */
app.get('/api/providers', requireAuth, (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  const all = registry.listAll();
  const out = all.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    accentToken: p.accentToken,
    // Plan 19-02: expose cliBinary so the frontend can build the spec
    // map (window.CWMProviderSpecs) and remove the 5 hardcoded default
    // provider literals in app.js drop / spawn callsites.
    cliBinary: p.cliBinary,
    enabled: registry.isEnabled(p.id),
    available: probeAvailability(p.cliBinary, forceRefresh),
    // Plan 18-04 (COST-02/03): defensive call. supportsCost() is contract-
    // required, but defaulting to true protects the frontend from a
    // broken/misregistered provider rather than silently dropping the
    // cost badge for Claude.
    supportsCost: (typeof p.supportsCost === 'function') ? (p.supportsCost() !== false) : true,
    // BUILD-CONTRACT P9.3: OPTIONAL capability, so an absent member reports
    // false rather than defaulting to true. The asymmetry with supportsCost
    // above is deliberate: defaulting cost to true preserves the pre-provider
    // behaviour every caller already assumed, while defaulting token usage to
    // true would promise a number no existing provider has been asked for.
    supportsTokenUsage:
      (typeof p.supportsTokenUsage === 'function') ? (p.supportsTokenUsage() === true) : false,
  }));
  res.json(out);
});

/**
 * GET /api/providers/:id/usage-snapshot
 *
 * BUILD-CONTRACT P9.6. The plan and rate-limit windows behind the account usage
 * meters, for any provider that can report them locally.
 *
 * Deliberately NOT the account switcher's feed. That one calls a live vendor
 * endpoint with the access token out of the credential file. This one reads a
 * line the assistant writes locally on every turn, so it needs no credential,
 * makes no network call, works offline and cannot fail because a token expired.
 * The two are complementary: the switcher knows about the ACCOUNT, this knows
 * about the CURRENT LIMIT WINDOW.
 *
 * Response (200), when the provider can answer:
 *   {
 *     provider: <the provider id from the path>,
 *     supported: true,
 *     rateLimits: {
 *       planType, limitId, limitName, reachedType, spendControlReached,
 *       primary:   {usedPercent, windowMinutes, resetsAt} | null,
 *       secondary: {usedPercent, windowMinutes, resetsAt} | null,
 *       individual:{usedPercent, windowMinutes, resetsAt} | null,
 *       credits:   {balance, hasCredits, unlimited} | null
 *     },
 *     contextWindow: number|null,
 *     observedAt: number|null
 *   }
 *
 * Response (200), otherwise: `{provider, supported: false, reason}`. A meter
 * must render "unknown" on that, never a full or an empty bar.
 */
app.get('/api/providers/:id/usage-snapshot', requireAuth, (req, res) => {
  const provider = registry.getProvider(req.params.id);
  if (!provider) {
    return res.status(404).json({ error: 'Unknown provider', provider: req.params.id, supported: false });
  }
  if (typeof provider.getUsageSnapshot !== 'function') {
    return res.json({ provider: provider.id, supported: false, reason: 'provider-reports-no-usage' });
  }
  Promise.resolve()
    .then(() => provider.getUsageSnapshot())
    .then((snapshot) => {
      if (!snapshot || !snapshot.rateLimits) {
        // Nothing on this machine can answer. "Unknown" is the honest render,
        // and it is not the same thing as a limit of zero.
        return res.json({ provider: provider.id, supported: false, reason: 'no-observation-on-disk' });
      }
      return res.json({
        provider: provider.id,
        supported: true,
        rateLimits: snapshot.rateLimits,
        contextWindow: typeof snapshot.contextWindow === 'number' ? snapshot.contextWindow : null,
        observedAt: typeof snapshot.observedAt === 'number' ? snapshot.observedAt : null,
      });
    })
    .catch(() => res.json({ provider: provider.id, supported: false, reason: 'snapshot-failed' }));
});

/**
 * PUT /api/providers/:id/enabled
 *
 * Toggle a provider's enabled state. Persists immediately to
 * state.settings.providers via registry.setEnabled + store.save, then
 * runs the appropriate lifecycle hook (init on toggle-on, dispose on
 * toggle-off) with a 5-second timeout. Lifecycle failure is logged via
 * console.warn but does NOT roll back the persisted state; the toggle
 * is sticky and user retry is the recovery path.
 *
 * Toggle-off also clears the toggled provider's per-provider entry in
 * _discoverCache (if 15-02's per-provider Map has landed; otherwise
 * the defensive check below is a no-op until 15-02 lands). Other
 * providers' cache entries remain intact (DISC-05 independence).
 *
 * Mid-PTY safety: this handler does NOT kill running PTYs. Phase 14
 * pty-manager already gates spawns on registry.isEnabled at spawn
 * time, so toggle-off blocks NEW spawns but leaves running PTYs
 * untouched.
 *
 * Body: {enabled: boolean}
 *
 * Responses:
 *   404  Unknown provider id
 *   400  Body missing or non-boolean enabled field
 *   401  Missing or invalid auth (handled by requireAuth)
 *   500  Store persistence failure
 *   200  {id, displayName, accentToken, enabled, available}
 *
 * Plan 15-03 (DISC-07).
 */
app.put('/api/providers/:id/enabled', requireAuth, async (req, res) => {
  const id = req.params.id;
  const provider = registry.getProvider(id);
  if (!provider) {
    return res.status(404).json({ error: 'Unknown provider: ' + id });
  }

  const body = req.body || {};
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'Body must include enabled: boolean' });
  }
  const enabled = body.enabled;
  const wasEnabled = registry.isEnabled(id);

  // Persist FIRST. The toggle is sticky; if lifecycle hooks fail the
  // persisted state still reflects the user's intent and the user can
  // retry. setEnabled also writes-through to store.state.settings.providers
  // (see src/providers/index.js); save() writes that to disk.
  registry.setEnabled(id, enabled);
  try {
    getStore().save();
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to persist toggle: ' + (err && err.message ? err.message : err),
    });
  }

  // Lifecycle hooks. Best-effort with a 5s timeout via Promise.race so
  // a hung init/dispose cannot block the response indefinitely. Failure
  // is logged but does NOT roll back the persisted state.
  if (enabled && !wasEnabled) {
    try {
      await Promise.race([
        provider.init(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('init timeout')), 5000)),
      ]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[providers] init ' + id + ' failed: ' + (err && err.message ? err.message : err));
    }
  } else if (!enabled && wasEnabled) {
    try {
      await Promise.race([
        provider.dispose(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('dispose timeout')), 5000)),
      ]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[providers] dispose ' + id + ' failed: ' + (err && err.message ? err.message : err));
    }
    // Invalidate THIS provider's discover cache entry. Other providers'
    // entries remain intact (DISC-05 independence). The defensive check
    // tolerates BOTH the pre-15-02 shape (scalar _discoverCache = null
    // with no .delete) AND the post-15-02 shape (per-provider Map with
    // .delete). Once 15-02 lands the second branch becomes the active
    // path; until then this is a no-op.
    if (typeof _discoverCache !== 'undefined' &&
        _discoverCache &&
        typeof _discoverCache.delete === 'function') {
      _discoverCache.delete(id);
    }
  }

  // Return the updated tile shape so the client can refresh its UI in
  // a single round-trip. `available` re-probes (cached) so a freshly
  // toggled-on provider whose binary was just installed shows the
  // up-to-date PATH probe result.
  res.json({
    id: provider.id,
    displayName: provider.displayName,
    accentToken: provider.accentToken,
    enabled,
    available: probeAvailability(provider.cliBinary, false),
  });
});


// ──────────────────────────────────────────────────────────
//  Session Auto-Title
// ──────────────────────────────────────────────────────────

/**
 * Generate a concise session title from user messages.
 * Uses the first message for topic and recent messages for current focus.
 * Produces a short, descriptive title (max ~45 chars).
 */
function generateSessionTitle(firstMessage, firstAssistantResponse, recentUserMessages, recentAssistantMessages) {
  // Helper: strip common conversational prefixes from user messages
  function stripPrefixes(text) {
    return text
      .replace(/^(hey|hi|hello|ok|okay|so|well|alright|please|pls|now)\b[,.]?\s*/i, '')
      .replace(/^(can you|could you|would you|will you|i need you to|i want you to|i'd like you to|help me|i need to|i want to|let's|lets)\s+/i, '')
      .replace(/^(go ahead and|make sure to|make sure|try to|please)\s+/i, '')
      .trim();
  }

  // Helper: smart truncate at word boundary
  function truncateTitle(text, maxLen) {
    if (text.length <= maxLen) return text;
    let truncated = text.substring(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.5) truncated = truncated.substring(0, lastSpace);
    return truncated;
  }

  function capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Extract a descriptive phrase from assistant response
  // Assistants often start with "I'll...", "Let me...", "Here's...", or describe the task directly
  function extractAssistantTopic(text) {
    if (!text) return '';
    // Take first 2 sentences max
    const sentences = text.match(/[^.!?\n]+[.!?]?/g) || [text];
    let combined = sentences.slice(0, 2).join(' ').trim();

    // Strip common assistant preambles
    combined = combined
      .replace(/^(sure|okay|alright|of course|absolutely|great|perfect|no problem|got it|understood)[,!.]?\s*/i, '')
      .replace(/^(let me|i'll|i will|i'm going to|i am going to)\s+/i, '')
      .replace(/^(here's|here is)\s+(a|an|the|my|your)\s+/i, '')
      .replace(/^(i can|i'd be happy to|happy to)\s+/i, '')
      .trim();

    return combined.replace(/[.!?]+$/, '').trim();
  }

  // Extract action/topic from user message
  function extractUserTopic(text) {
    if (!text) return '';
    let cleaned = stripPrefixes(text);
    cleaned = cleaned.replace(/[.!?]+$/, '').trim();
    cleaned = stripPrefixes(cleaned);
    // Take first sentence if multi-sentence
    const sentenceEnd = cleaned.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < cleaned.length - 5) {
      cleaned = cleaned.substring(0, sentenceEnd);
    }
    return cleaned;
  }

  // Check if a string is too vague/short to be a good title
  function isTooVague(text) {
    if (!text || text.length < 10) return true;
    const vaguePatterns = /^(yes|no|do it|go ahead|looks good|that works|fix it|sure|thanks|thank you|LGTM|ship it|perfect|great|good|nice|cool|fine|done|next|continue|proceed|ready|approved)/i;
    return vaguePatterns.test(text);
  }

  // ── Strategy: Build title from best available source ──
  // Priority: assistant summary > user first message > recent assistant > recent user
  // Assistants describe the WORK, users describe the REQUEST - work descriptions make better titles

  let title = '';

  // 1. Try assistant's first response (often the best summary of what the session does)
  const assistantTopic = extractAssistantTopic(firstAssistantResponse);
  const userTopic = extractUserTopic(firstMessage);

  // 2. Try recent assistant messages for sessions that have evolved
  let recentAssistantTopic = '';
  if (recentAssistantMessages && recentAssistantMessages.length > 0) {
    // Use the most recent assistant message
    recentAssistantTopic = extractAssistantTopic(recentAssistantMessages[recentAssistantMessages.length - 1]);
  }

  // 3. Recent user messages as fallback
  let recentUserTopic = '';
  if (recentUserMessages && recentUserMessages.length > 0) {
    const lastUser = recentUserMessages[recentUserMessages.length - 1];
    recentUserTopic = extractUserTopic(lastUser);
  }

  // Pick the best title source:
  // If user's first message is a clear task description, prefer it
  if (userTopic && !isTooVague(userTopic) && userTopic.length >= 15 && userTopic.length <= 60) {
    title = userTopic;
  }
  // If assistant summarized the work well, prefer that
  else if (assistantTopic && !isTooVague(assistantTopic) && assistantTopic.length >= 10) {
    title = assistantTopic;
  }
  // Fall back to user topic even if short
  else if (userTopic && !isTooVague(userTopic)) {
    title = userTopic;
  }
  // Try recent assistant
  else if (recentAssistantTopic && !isTooVague(recentAssistantTopic)) {
    title = recentAssistantTopic;
  }
  // Try recent user
  else if (recentUserTopic && !isTooVague(recentUserTopic)) {
    title = recentUserTopic;
  }
  // Last resort: raw first message
  else {
    title = userTopic || firstMessage || 'Untitled Session';
  }

  // Final cleanup and truncation
  title = capitalize(truncateTitle(title, 50));

  if (!title || title.length < 4) {
    title = capitalize(truncateTitle(firstMessage || 'Untitled Session', 50));
  }

  return title;
}

/**
 * POST /api/sessions/:id/auto-title
 * Reads the Claude session's .jsonl file and generates a title
 * from the conversation content. Produces a concise, descriptive title.
 */
app.post('/api/sessions/:id/auto-title', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);

  // Support both store sessions and project sessions (direct Claude UUID)
  const claudeSessionId = (session && session.resumeSessionId) || req.body.claudeSessionId || req.params.id;
  if (!claudeSessionId) {
    return res.status(400).json({ error: 'No Claude session ID available' });
  }

  // Find the .jsonl file in ~/.claude/projects/
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  let jsonlPath = null;

  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of projectDirs) {
        const candidate = path.join(claudeProjectsDir, dir.name, claudeSessionId + '.jsonl');
        if (fs.existsSync(candidate)) {
          jsonlPath = candidate;
          break;
        }
      }
    }
  } catch (_) {}

  if (!jsonlPath) {
    return res.status(404).json({ error: 'Session conversation file not found' });
  }

  try {
    // Helper to extract text from a JSONL message (user or assistant)
    function extractMessageText(line) {
      try {
        const msg = JSON.parse(line);
        const inner = msg.message || msg;
        const role = msg.type || inner.role;
        const isUser = role === 'user' || role === 'human';
        const isAssistant = role === 'assistant';
        if (!isUser && !isAssistant) return null;
        const c = inner.content;
        let text = '';
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          const textBlocks = c.filter(b => b.type === 'text' && b.text);
          text = textBlocks.map(b => b.text).join(' ');
        }
        // Skip system-generated messages, tool results, very short messages
        if (!text || text.length < 5) return null;
        if (text.startsWith('<') && text.includes('system-reminder')) return null;
        return { role: isUser ? 'user' : 'assistant', text: text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() };
      } catch (_) { return null; }
    }

    const stat = fs.statSync(jsonlPath);
    const fileSize = stat.size;
    let title = '';

    // Strategy: Read head (first exchange) + tail (recent activity) for full context.
    const headSize = Math.min(30 * 1024, fileSize);
    const headBuf = Buffer.alloc(headSize);
    // Wrap fd operations in try-finally to prevent file descriptor leak if readSync or Buffer.alloc throws
    let fd;
    let headBytesRead;
    let tailBytesRead;
    const tailSize = Math.min(50 * 1024, fileSize);
    const tailOffset = Math.max(0, fileSize - tailSize);
    const tailBuf = Buffer.alloc(tailSize);
    try {
      fd = fs.openSync(jsonlPath, 'r');
      headBytesRead = fs.readSync(fd, headBuf, 0, headSize, 0);
      tailBytesRead = fs.readSync(fd, tailBuf, 0, tailSize, tailOffset);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    // Parse head messages (first user message + first assistant response)
    const headContent = headBuf.toString('utf-8', 0, headBytesRead);
    const headLines = headContent.split('\n').filter(l => l.trim());
    let firstUserMessage = '';
    let firstAssistantResponse = '';
    for (const line of headLines) {
      const parsed = extractMessageText(line);
      if (!parsed) continue;
      if (parsed.role === 'user' && !firstUserMessage) {
        firstUserMessage = parsed.text;
      } else if (parsed.role === 'assistant' && !firstAssistantResponse && firstUserMessage) {
        firstAssistantResponse = parsed.text.substring(0, 500);
      }
      if (firstUserMessage && firstAssistantResponse) break;
    }

    // Parse tail messages (recent exchanges for current focus)
    const tailContent = tailBuf.toString('utf-8', 0, tailBytesRead);
    const tailLines = tailContent.split('\n').filter(l => l.trim());
    if (tailOffset > 0 && tailLines.length > 0) tailLines.shift();

    const recentUserMessages = [];
    const recentAssistantMessages = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (recentUserMessages.length >= 3 && recentAssistantMessages.length >= 3) break;
      const parsed = extractMessageText(tailLines[i]);
      if (!parsed) continue;
      if (parsed.role === 'user' && recentUserMessages.length < 3) {
        recentUserMessages.unshift(parsed.text);
      } else if (parsed.role === 'assistant' && recentAssistantMessages.length < 3) {
        recentAssistantMessages.unshift(parsed.text.substring(0, 500));
      }
    }

    if (!firstUserMessage && recentUserMessages.length === 0) {
      return res.status(404).json({ error: 'No user message found in session' });
    }

    // ── Generate a concise title from session content ──
    // Pass both user and assistant messages for better context
    title = generateSessionTitle(firstUserMessage, firstAssistantResponse, recentUserMessages, recentAssistantMessages);

    // Update the session name if it's a store session
    if (session) {
      store.updateSession(req.params.id, { name: title });
    }
    return res.json({ success: true, title, claudeSessionId });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read session: ' + err.message });
  }
});

/**
 * Extract summary-shaped messages from a transcript using the PROVIDER's own
 * per-line parser, for a provider whose artifact is not Claude-shaped.
 *
 * BUILD-CONTRACT P9 (CODEX-PARITY B12). Reads the same bounded head and tail
 * windows the Claude path reads, for the same reason: the head carries the
 * opening request, which is the theme, and the tail carries what is happening
 * now. A whole-file read is not an option here; the largest rollout on the
 * reference machine is 924 MB.
 *
 * Uses `provider.mirror.parseLine`, which is pure, synchronous and contractually
 * non-throwing, so a corrupt line costs one line rather than the request.
 *
 * @param {object} provider - Provider exposing mirror.parseLine.
 * @param {string} headText - First window of the file.
 * @param {string} tailText - Last window of the file.
 * @param {number} headLimit - Max early messages to collect.
 * @param {number} tailLimit - Max recent messages to collect.
 * @returns {{early: Array<{role:string,text:string}>, recent: Array<{role:string,text:string}>}}
 */
function extractProviderSummaryMessages(provider, headText, tailText, headLimit, tailLimit) {
  const parseLine =
    provider && provider.mirror && typeof provider.mirror.parseLine === 'function'
      ? provider.mirror.parseLine
      : null;
  const empty = { early: [], recent: [] };
  if (!parseLine) return empty;

  /**
   * Map one window of raw lines into {role, text} pairs, keeping only the
   * conversational roles. Tool calls and tool results are deliberately excluded:
   * a summary of "what is this session about" is not served by the text of a
   * shell command.
   *
   * @param {string} text
   * @param {number} limit
   * @param {boolean} fromEnd - Collect from the end (recent) rather than the start.
   * @returns {Array<{role:string,text:string}>}
   */
  const collect = (text, limit, fromEnd) => {
    const out = [];
    if (typeof text !== 'string' || text.length === 0) return out;
    const lines = text.split('\n');
    const order = fromEnd ? lines.slice().reverse() : lines;
    for (const line of order) {
      if (out.length >= limit) break;
      if (!line) continue;
      let msg = null;
      try {
        msg = parseLine(line);
      } catch (_) {
        continue; // parseLine is non-throwing by contract; belt and braces
      }
      if (!msg) continue;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      if (!msg.text || msg.text.length < 5) continue;
      const cleaned = msg.text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      const entry = { role: msg.role, text: cleaned.substring(0, 500) };
      if (fromEnd) out.unshift(entry);
      else out.push(entry);
    }
    return out;
  };

  return {
    early: collect(headText, headLimit, false),
    recent: collect(tailText, tailLimit, true),
  };
}

/**
 * POST /api/sessions/:id/summarize
 * Reads the session's transcript and generates a summary of the overall theme
 * and most recent tasking.
 * Also works for project sessions by passing claudeSessionId in body.
 *
 * BUILD-CONTRACT P9 (CODEX-PARITY B12). Two things were wrong here and both are
 * fixed without deleting a line:
 *
 *   1. THE SHADOWED ROUTE. Two handlers were registered on this exact path, one
 *      here and one much further down the file. Express serves the first, so the
 *      second, the provider-aware one that appends a summary to the workspace
 *      docs, was unreachable dead code. Two live frontend callers wanted it:
 *      `summarizeSessionToDocs()` and the mobile client's `summarize()`, both of
 *      which read `data.summary` and always got undefined.
 *
 *      Resolved by DELEGATION rather than by deleting the shadowing
 *      registration. The docs behaviour now lives in a named function,
 *      `summarizeSessionToDocsHandler`, which is registered on its own
 *      unshadowed route AND invoked from here when the caller opts in. The
 *      original second registration is retained, untouched, and is still
 *      shadowed; it now points at the same function, so the code that was dead
 *      is the code that runs.
 *
 *   2. THE HARDCODED CLAUDE WALK. Artifact resolution scanned
 *      `~/.claude/projects` for `<id>.jsonl` and nothing else, so every Codex
 *      session got a hard 404. Resolution now dispatches through the provider
 *      registry first and keeps the original walk as the last fallback, which is
 *      still needed for a project session that has no store record and therefore
 *      no provider tag.
 *
 * The Claude response shape is unchanged, field for field.
 */
app.post('/api/sessions/:id/summarize', requireAuth, (req, res) => {
  // Opt-in delegation to the previously-unreachable docs summariser. A client
  // asks for it with `{toDocs: true}` in the body or `?toDocs=1`, and gets the
  // `{summary}` shape plus the workspace-note append. The default is unchanged,
  // which matters: the modal summariser must never write to a user's project
  // docs as a side effect of being opened.
  const wantsDocs =
    (req.body && req.body.toDocs === true) ||
    req.query.toDocs === '1' ||
    req.query.toDocs === 'true';
  if (wantsDocs) {
    return summarizeSessionToDocsHandler(req, res);
  }

  const store = getStore();
  // For store sessions, use resumeSessionId. For project sessions, accept direct ID.
  const session = store.getSession(req.params.id);
  const claudeSessionId = (session && session.resumeSessionId) || req.body.claudeSessionId || req.params.id;

  if (!claudeSessionId) {
    return res.status(400).json({ error: 'No Claude session ID available' });
  }

  // Provider-first artifact resolution (CODEX-PARITY B12). The literal walk
  // below is retained as the final fallback because a project session carries no
  // store record, and therefore no provider tag, yet still resolves by id.
  const provider = getProviderForSession(session);
  let jsonlPath = null;
  try {
    if (provider && typeof provider.findArtifactPath === 'function') {
      jsonlPath = provider.findArtifactPath(claudeSessionId) || null;
    }
    if (!jsonlPath && provider && session && session.workingDir &&
        typeof provider.findArtifactByWorkingDir === 'function') {
      const byDir = provider.findArtifactByWorkingDir(session.workingDir);
      if (byDir && byDir.jsonlPath) jsonlPath = byDir.jsonlPath;
    }
  } catch (_) {
    // A provider that throws must not cost the request; the walk still runs.
    jsonlPath = null;
  }

  // Find the .jsonl file in ~/.claude/projects/
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  try {
    if (!jsonlPath && fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of projectDirs) {
        const candidate = path.join(claudeProjectsDir, dir.name, claudeSessionId + '.jsonl');
        if (fs.existsSync(candidate)) {
          jsonlPath = candidate;
          break;
        }
      }
    }
  } catch (_) {}

  if (!jsonlPath) {
    return res.status(404).json({ error: 'Session conversation file not found' });
  }

  try {
    const stat = fs.statSync(jsonlPath);
    const fileSize = stat.size;

    // Read last 100KB to get recent messages, and first 50KB for overall context
    const headBuf = Buffer.alloc(Math.min(50 * 1024, fileSize));
    const fd = fs.openSync(jsonlPath, 'r');
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);

    const tailSize = Math.min(100 * 1024, fileSize);
    const tailBuf = Buffer.alloc(tailSize);
    fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, fileSize - tailSize));
    fs.closeSync(fd);

    const headContent = headBuf.toString('utf-8');
    const tailContent = tailBuf.toString('utf-8');

    // Parse messages from head (for overall theme)
    const headLines = headContent.split('\n').filter(l => l.trim());
    const tailLines = tailContent.split('\n').filter(l => l.trim());

    const extractMessages = (lines, limit) => {
      const msgs = [];
      for (const line of lines) {
        if (msgs.length >= limit) break;
        try {
          const entry = JSON.parse(line);
          // Claude Code JSONL: top-level has "type" ("user"/"assistant")
          // and "message" object with "role", "content"
          const role = entry.type || (entry.message && entry.message.role) || entry.role;
          const contentSource = (entry.message && entry.message.content) || entry.content;

          if (role === 'user' || role === 'human') {
            let text = '';
            if (typeof contentSource === 'string') text = contentSource;
            else if (Array.isArray(contentSource)) {
              const tb = contentSource.find(b => b.type === 'text');
              if (tb) text = tb.text || '';
            }
            if (text) msgs.push({ role: 'user', text: text.substring(0, 500) });
          } else if (role === 'assistant') {
            let text = '';
            if (typeof contentSource === 'string') text = contentSource;
            else if (Array.isArray(contentSource)) {
              const textBlocks = contentSource.filter(b => b.type === 'text');
              text = textBlocks.map(b => b.text || '').join(' ');
            }
            if (text) msgs.push({ role: 'assistant', text: text.substring(0, 500) });
          }
        } catch (_) {}
      }
      return msgs;
    };

    let earlyMessages = extractMessages(headLines, 5);
    let recentMessages = extractMessages(tailLines.slice(-20), 10);

    // CODEX-PARITY B12: the extractor above understands ONE transcript shape,
    // Claude's `{type, message: {role, content}}`. A Codex rollout is an
    // envelope log and yields zero messages from it, which is how a summarize
    // request on a Codex session produced "Unable to determine theme" even when
    // the artifact resolved.
    //
    // The provider's own per-line parser is consulted only when the historical
    // extractor found NOTHING. That ordering is deliberate: it keeps the Claude
    // path byte-identical rather than merely equivalent, because the historical
    // extractor always succeeds on a Claude file and therefore the fallback can
    // never run for one. It also avoids branching on a provider id, so a future
    // provider whose artifact happens to be Claude-shaped keeps working.
    if (earlyMessages.length === 0 && recentMessages.length === 0) {
      const viaProvider = extractProviderSummaryMessages(
        provider,
        headContent,
        tailContent,
        5,
        10
      );
      earlyMessages = viaProvider.early;
      recentMessages = viaProvider.recent;
    }

    // Build summary
    let overallTheme = 'Unable to determine theme';
    let recentTasking = 'No recent activity found';
    const sessionName = session ? session.name : claudeSessionId;

    // Overall theme from first user message
    const firstUser = earlyMessages.find(m => m.role === 'user');
    if (firstUser) {
      overallTheme = firstUser.text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (overallTheme.length > 200) {
        overallTheme = overallTheme.substring(0, 200).replace(/\s+\S*$/, '') + '...';
      }
    }

    // Recent tasking from last user messages
    const recentUserMsgs = recentMessages.filter(m => m.role === 'user');
    if (recentUserMsgs.length > 0) {
      const last = recentUserMsgs[recentUserMsgs.length - 1];
      recentTasking = last.text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (recentTasking.length > 300) {
        recentTasking = recentTasking.substring(0, 300).replace(/\s+\S*$/, '') + '...';
      }
    }

    // Recent assistant summary
    let recentAssistant = '';
    const recentAssistantMsgs = recentMessages.filter(m => m.role === 'assistant');
    if (recentAssistantMsgs.length > 0) {
      const last = recentAssistantMsgs[recentAssistantMsgs.length - 1];
      recentAssistant = last.text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (recentAssistant.length > 300) {
        recentAssistant = recentAssistant.substring(0, 300).replace(/\s+\S*$/, '') + '...';
      }
    }

    return res.json({
      sessionName,
      claudeSessionId,
      overallTheme,
      recentTasking,
      recentAssistant,
      messageCount: headLines.length + tailLines.length,
      fileSize,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read session: ' + err.message });
  }
});


// ──────────────────────────────────────────────────────────
//  SEARCH CONVERSATIONS
// ──────────────────────────────────────────────────────────

/**
 * POST /api/search-conversations
 * Searches across all Claude session JSONL files for conversations matching the query.
 * Reads user messages from each session and matches against search terms.
 * Body: { query: "string" }
 * Returns: { results: [{ sessionId, projectPath, projectName, preview, modified, size }] }
 */
app.post('/api/search-conversations', requireAuth, async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  const searchTerms = query.toLowerCase().trim().split(/\s+/);
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeProjectsDir)) {
    return res.json({ results: [] });
  }

  const results = [];
  const MAX_RESULTS = 50;
  const SAMPLE_SIZE = 20 * 1024; // Read 20KB from head and tail of each file

  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      if (results.length >= MAX_RESULTS) break;

      const projectDir = path.join(claudeProjectsDir, dir.name);
      const realPath = resolveProjectPath(projectDir, dir.name);
      const projectName = getProjectDisplayName(dir.name, realPath);

      let jsonlFiles;
      try {
        jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      } catch (_) { continue; }

      for (const file of jsonlFiles) {
        if (results.length >= MAX_RESULTS) break;

        const filePath = path.join(projectDir, file);
        const sessionId = file.replace('.jsonl', '');
        let stat;
        try { stat = fs.statSync(filePath); } catch (_) { continue; }

        // Read head and tail samples
        const fileSize = stat.size;
        if (fileSize === 0) continue;

        let content = '';
        try {
          const fd = fs.openSync(filePath, 'r');

          // Head sample
          const headSize = Math.min(SAMPLE_SIZE, fileSize);
          const headBuf = Buffer.alloc(headSize);
          fs.readSync(fd, headBuf, 0, headSize, 0);
          content = headBuf.toString('utf-8');

          // Tail sample (if file is larger than head)
          if (fileSize > SAMPLE_SIZE * 2) {
            const tailSize = Math.min(SAMPLE_SIZE, fileSize);
            const tailBuf = Buffer.alloc(tailSize);
            fs.readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize);
            content += '\n' + tailBuf.toString('utf-8');
          }

          fs.closeSync(fd);
        } catch (_) { continue; }

        // Extract user messages
        const lines = content.split('\n').filter(l => l.trim());
        const userTexts = [];

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            const inner = msg.message || msg;
            const isUser = msg.type === 'user' || msg.type === 'human' || inner.role === 'user';
            if (!isUser) continue;

            const c = inner.content;
            let text = '';
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) {
              const tb = c.find(b => b.type === 'text' && b.text);
              if (tb) text = tb.text;
            }
            if (text && text.length >= 5 && !text.startsWith('<system-reminder')) {
              userTexts.push(text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
            }
          } catch (_) {}
        }

        if (userTexts.length === 0) continue;

        // Check if any user message matches ALL search terms
        const allText = userTexts.join(' ').toLowerCase();
        const matches = searchTerms.every(term => allText.includes(term));
        if (!matches) continue;

        // Find the best matching message for preview
        let bestPreview = '';
        let bestScore = 0;
        for (const text of userTexts) {
          const lower = text.toLowerCase();
          const score = searchTerms.filter(t => lower.includes(t)).length;
          if (score > bestScore) {
            bestScore = score;
            bestPreview = text;
          }
        }

        // Truncate preview
        if (bestPreview.length > 200) {
          bestPreview = bestPreview.substring(0, 200).replace(/\s+\S*$/, '') + '...';
        }

        // First user message as topic hint
        let topic = userTexts[0] || '';
        if (topic.length > 100) {
          topic = topic.substring(0, 100).replace(/\s+\S*$/, '') + '...';
        }

        results.push({
          sessionId,
          projectPath: realPath,
          projectEncoded: dir.name,
          projectName,
          topic,
          preview: bestPreview,
          modified: stat.mtime,
          size: stat.size,
          messageCount: userTexts.length,
        });
      }
    }

    // Sort by modification time (most recent first)
    results.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});


// ──────────────────────────────────────────────────────────
//  ANTHROPIC API KEY
// ──────────────────────────────────────────────────────────

/**
 * GET /api/keys/anthropic
 * Returns whether an Anthropic API key is configured and a masked preview.
 */
app.get('/api/keys/anthropic', requireAuth, (req, res) => {
  const store = getStore();
  const key = (store.state.settings || {}).anthropicApiKey || '';
  if (!key) return res.json({ configured: false, masked: null });
  const masked = '...' + key.slice(-8);
  return res.json({ configured: true, masked });
});

/**
 * PUT /api/keys/anthropic
 * Persist an Anthropic API key in the store settings.
 * Body: { key } - the full API key string (empty string clears it).
 */
app.put('/api/keys/anthropic', requireAuth, (req, res) => {
  const key = ((req.body && req.body.key) || '').trim();
  getStore().updateSettings({ anthropicApiKey: key });
  const masked = key ? '...' + key.slice(-8) : null;
  return res.json({ success: true, configured: !!key, masked });
});

// ──────────────────────────────────────────────────────────
//  AI-POWERED VOICE PUNCTUATION
// ──────────────────────────────────────────────────────────

/**
 * POST /api/ai/punctuate
 * Adds punctuation, capitalization, and grammar to raw voice dictation text.
 * Uses Claude Haiku for fast, low-cost cleanup. Returns 400 if no API key.
 * Body: { text: "raw voice text without punctuation" }
 * Returns: { text: "Cleaned text with proper punctuation." }
 */
app.post('/api/ai/punctuate', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 2) {
    return res.status(400).json({ error: 'Text is required (at least 2 characters)' });
  }

  const store = getStore();
  const apiKey = (store.state.settings || {}).anthropicApiKey || '';
  if (!apiKey) {
    return res.status(400).json({ error: 'No Anthropic API key configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are a punctuation and grammar fixer for voice dictation. Given raw speech-to-text output, add proper punctuation (periods, commas, question marks, exclamation points), capitalization, and fix obvious grammar issues. Keep the original meaning and wording intact. Do NOT add, remove, or rephrase words. Do NOT add quotes around the text. Return ONLY the corrected text, nothing else.`,
        messages: [{ role: 'user', content: text.trim() }],
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Claude API returned ${response.status}` });
    }

    const data = await response.json();
    const cleaned = (data.content && data.content[0] && data.content[0].text) || text;
    return res.json({ text: cleaned.trim() });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Claude API: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  AI-POWERED SESSION FINDER
// ──────────────────────────────────────────────────────────

/**
 * POST /api/ai/find-session
 * Uses Claude to semantically match a natural language description against
 * all known workspaces, sessions, and discovered projects.
 * Falls back to keyword matching when no API key is configured.
 * Body: { query: "description of the session" }
 * Returns: { results: [...], model?: string, fallback: boolean }
 */
app.post('/api/ai/find-session', requireAuth, async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return res.status(400).json({ error: 'Query must be at least 3 characters' });
  }

  const store = getStore();
  const apiKey = (store.state.settings || {}).anthropicApiKey || '';

  // Gather all metadata
  const workspaces = store.getAllWorkspacesList();
  const sessions = store.getAllSessionsList();

  // Plan 15-02 (DISC-01): dispatch the discovery scan through the provider
  // registry instead of walking ~/.claude/projects/ inline. The dispatch
  // re-uses groupProviderSessionsForUI so the per-project accordion shape
  // is identical to what GET /api/discover produces. Provider failure is
  // isolated (one failing provider does not poison other providers'
  // contributions). Downstream consumers (enrichMatch and the keyword
  // fallback below) read `encodedName`, `name`, `path`, `sessionCount`,
  // `lastActive`, `sessionTitles`; all are preserved. `provider` is added
  // as a forward-compat field surfaced into the LLM prompt metadata.
  const enabledForFindSession = registry.listEnabled();
  let discoveredProjects = [];
  for (const findSessionProvider of enabledForFindSession) {
    let providerSessions;
    try {
      providerSessions = await findSessionProvider.discover({ forceRefresh: false });
    } catch (err) {
      console.error('[find-session] provider ' + findSessionProvider.id + ' failed: ' + (err && err.message ? err.message : err));
      continue;
    }
    if (!Array.isArray(providerSessions)) continue;
    const grouped = groupProviderSessionsForUI(providerSessions, findSessionProvider);
    for (const g of grouped) {
      discoveredProjects.push({
        provider: findSessionProvider.id,
        encodedName: g.encodedName,
        name: g.displayName,
        path: g.realPath,
        sessionCount: g.sessionCount,
        lastActive: g.lastActive,
        sessionTitles: g.sessions.map((s) => s.title).filter(Boolean),
      });
    }
  }

  // Build compact metadata for AI matching
  const metadata = {
    workspaces: workspaces.map(ws => ({
      id: ws.id, name: ws.name, description: ws.description || ''
    })),
    sessions: sessions.map(s => ({
      id: s.id, name: s.name, topic: s.topic || '',
      workspaceId: s.workspaceId, workingDir: s.workingDir || '',
      status: s.status, lastActive: s.lastActive, createdAt: s.createdAt
    })),
    discoveredProjects: discoveredProjects.map(p => ({
      // Plan 15-02 (DISC-01): provider is forward-compat metadata for
      // the LLM; the prompt does not require the LLM to use it, but
      // including it lets future-aware prompts disambiguate by provider.
      provider: p.provider,
      encodedName: p.encodedName, name: p.name, path: p.path,
      sessionCount: p.sessionCount, lastActive: p.lastActive,
      sessionTitles: p.sessionTitles
    }))
  };

  /**
   * Enrich a raw match object with full metadata from our data sources.
   * Adds name, path, lastActive, sessionCount, status, etc.
   */
  function enrichMatch(m) {
    const enriched = { ...m };
    if (m.type === 'session') {
      const session = sessions.find(s => s.id === m.id);
      if (session) {
        enriched.name = session.name;
        enriched.path = session.workingDir || '';
        enriched.lastActive = session.lastActive;
        enriched.status = session.status;
        enriched.workspaceId = session.workspaceId;
        enriched.topic = session.topic || '';
        // Carry the session's provider so the find-result card can resolve the
        // correct CLI binary on open (a Codex session must spawn `codex`, not
        // the default). Absent provider stays undefined; the frontend helper
        // applies its own back-compat default.
        if (session.provider) enriched.provider = session.provider;
        const ws = workspaces.find(w => w.id === session.workspaceId);
        enriched.workspaceName = ws ? ws.name : '';
      }
    } else if (m.type === 'workspace') {
      const ws = workspaces.find(w => w.id === m.id);
      if (ws) {
        enriched.name = ws.name;
        enriched.description = ws.description || '';
        const wsSessions = sessions.filter(s => s.workspaceId === ws.id);
        enriched.sessionCount = wsSessions.length;
        enriched.lastActive = wsSessions.reduce((latest, s) => {
          if (!s.lastActive) return latest;
          return !latest || new Date(s.lastActive) > new Date(latest) ? s.lastActive : latest;
        }, null);
        const firstDir = wsSessions.find(s => s.workingDir);
        enriched.path = firstDir ? firstDir.workingDir : '';
      }
    } else if (m.type === 'project') {
      const proj = discoveredProjects.find(p => p.encodedName === m.id);
      if (proj) {
        enriched.name = proj.name;
        enriched.path = proj.path;
        enriched.sessionCount = proj.sessionCount;
        enriched.lastActive = proj.lastActive;
        // Carry the discovered project's provider so the card opens the right CLI.
        if (proj.provider) enriched.provider = proj.provider;
      }
    }
    return enriched;
  }

  // Keyword fallback when no API key is configured
  if (!apiKey) {
    const terms = query.toLowerCase().split(/\s+/);
    const scored = [];

    for (const ws of workspaces) {
      const text = `${ws.name} ${ws.description || ''}`.toLowerCase();
      const score = terms.filter(t => text.includes(t)).length / terms.length;
      if (score > 0.2) scored.push({ type: 'workspace', id: ws.id, confidence: score, summary: 'Matched by name or description' });
    }
    for (const s of sessions) {
      const text = `${s.name} ${s.topic || ''} ${s.workingDir || ''}`.toLowerCase();
      const score = terms.filter(t => text.includes(t)).length / terms.length;
      if (score > 0.2) scored.push({ type: 'session', id: s.id, confidence: score, summary: 'Matched by name, topic, or path' });
    }
    for (const p of discoveredProjects) {
      const text = `${p.name} ${p.path} ${(p.sessionTitles || []).join(' ')}`.toLowerCase();
      const score = terms.filter(t => text.includes(t)).length / terms.length;
      if (score > 0.2) scored.push({ type: 'project', id: p.encodedName, confidence: score, summary: 'Matched by project name, path, or session title' });
    }

    scored.sort((a, b) => b.confidence - a.confidence);
    const results = scored.slice(0, 5).map(enrichMatch).filter(m => m.name);
    return res.json({ results, fallback: true });
  }

  // AI-powered search via Claude Haiku
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are a project/session finder for a workspace manager. Given a user's natural language description, analyze all available projects and sessions to find the best matches.

Return ONLY a valid JSON array (no markdown, no explanation outside the array). Each element:
{
  "type": "session" or "workspace" or "project",
  "id": "<session id, workspace id, or project encodedName>",
  "confidence": 0.0 to 1.0,
  "summary": "1-2 sentence explanation of why this matches"
}

Rules:
- Return up to 5 matches, ordered by confidence (highest first)
- Only include matches with confidence above 0.3
- Consider name similarity, path keywords, topic relevance, recency
- "project" type means a discovered Claude project not yet tracked in a workspace
- If the description mentions recency ("last week", "yesterday"), weight lastActive heavily
- If nothing matches well, return an empty array []
- Do NOT use em dashes in summaries`,
        messages: [{
          role: 'user',
          content: `Find sessions/projects matching: "${query.trim()}"\n\nAvailable data:\n${JSON.stringify(metadata)}`
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      return res.status(502).json({ error: `Claude API returned ${response.status}`, detail: errText });
    }

    const data = await response.json();
    const content = (data.content && data.content[0] && data.content[0].text) || '[]';

    // Parse Claude's JSON response (handle potential markdown wrapping)
    let matches;
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      matches = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      matches = [];
    }

    const results = matches.map(enrichMatch).filter(m => m.name);
    return res.json({ results, model: data.model, fallback: false });

  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Claude API: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  COST TRACKING
// ──────────────────────────────────────────────────────────

/**
 * Token pricing per million tokens, by model.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Cache write = 5-minute cache (1.25× base input). Cache read = 0.10× base input.
 * Last verified: 2026-02-12
 */
const TOKEN_PRICING = {
  // Current models
  'claude-opus-4-6':            { input: 5,    output: 25,   cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-5-20251101':   { input: 5,    output: 25,   cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-5':            { input: 5,    output: 25,   cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-4-5-20250929': { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5':          { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5-20251001':  { input: 1,    output: 5,    cacheWrite: 1.25,  cacheRead: 0.10 },
  'claude-haiku-4-5':           { input: 1,    output: 5,    cacheWrite: 1.25,  cacheRead: 0.10 },
  // Legacy models (still usable)
  'claude-opus-4-1-20250805':   { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-1':            { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-20250514':     { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-0':            { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-20250514':   { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-0':          { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-3-7-sonnet-20250219': { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output: 4,    cacheWrite: 1.00,  cacheRead: 0.08 },
  'claude-3-haiku-20240307':    { input: 0.25, output: 1.25, cacheWrite: 0.30,  cacheRead: 0.03 },
};
// Default to Sonnet pricing for unknown models
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

/** In-memory cost cache: keyed by sessionId, stores { mtime, result } */
const _costCache = new Map();
const COST_CACHE_TTL = 60000; // 60 seconds

/**
 * Resolve the Claude CLI binary path. Tries the bare command first,
 * then checks common installation paths across platforms.
 * Caches the result after first successful resolution.
 * @returns {string|null} Path to the claude binary, or null if not found
 */
let _cachedClaudePath = undefined;
function resolveClaudeCli() {
  if (_cachedClaudePath !== undefined) return _cachedClaudePath;

  // Try bare command first (works if claude is on PATH)
  try {
    execSync(process.platform === 'win32' ? 'where claude' : 'which claude', {
      stdio: 'pipe', timeout: 5000, windowsHide: true,
    });
    // Plan 15-01: PATH-resolved bare-command form. Use the Claude provider's
    // canonical cliBinary so the value is sourced from the provider object
    // rather than a duplicated literal here.
    _cachedClaudePath = claudeProvider.cliBinary;
    return _cachedClaudePath;
  } catch (_) {}

  // Check common installation paths
  const home = os.homedir();
  const candidates = process.platform === 'win32' ? [
    path.join(home, '.claude', 'local', 'claude.exe'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude'), // gsd:provider-literal-allowed (Claude CLI install probe; binary name literal belongs to claudeProvider.cliBinary)
    path.join(home, '.npm-global', 'bin', 'claude'), // gsd:provider-literal-allowed (Claude CLI install probe; binary name literal belongs to claudeProvider.cliBinary)
    path.join(home, 'scoop', 'shims', 'claude.cmd'),
  ] : [
    path.join(home, '.claude', 'local', 'claude'), // gsd:provider-literal-allowed (Claude CLI install probe; binary name literal belongs to claudeProvider.cliBinary)
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'), // gsd:provider-literal-allowed (Claude CLI install probe; binary name literal belongs to claudeProvider.cliBinary)
    '/opt/homebrew/bin/claude',
    path.join(home, '.local', 'bin', 'claude'), // gsd:provider-literal-allowed (Claude CLI install probe; binary name literal belongs to claudeProvider.cliBinary)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      _cachedClaudePath = candidate;
      return _cachedClaudePath;
    }
  }

  _cachedClaudePath = null;
  return null;
}

/**
 * Parse a JSONL file and calculate token usage and estimated cost.
 * Aggregates usage across all assistant messages, grouped by model.
 * @param {string} jsonlPath - Absolute path to the .jsonl file
 * @returns {object} Token and cost breakdown
 */
function calculateSessionCost(jsonlPath) {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const modelBreakdown = {};
  let messageCount = 0;
  let firstMessage = null;
  let lastMessage = null;

  // Context growth tracking: per-message input_tokens shows context window size
  // A growing value means the session is accumulating context and may need compaction
  let latestInputTokens = 0;       // Most recent message's input_tokens (= current context size)
  let peakInputTokens = 0;         // Highest input_tokens seen (peak context size)
  const contextSamples = [];       // Sampled input token progression for graphing

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;

      const msg = entry.message;
      if (!msg || !msg.usage) continue;

      messageCount++;
      const ts = entry.timestamp || null;
      if (ts && (!firstMessage || ts < firstMessage)) firstMessage = ts;
      if (ts && (!lastMessage || ts > lastMessage)) lastMessage = ts;

      const usage = msg.usage;
      const model = msg.model || 'unknown';
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;

      totals.input += inputTokens;
      totals.output += outputTokens;
      totals.cacheWrite += cacheWriteTokens;
      totals.cacheRead += cacheReadTokens;

      // Track context window growth (input_tokens per message = current context size)
      latestInputTokens = inputTokens;
      if (inputTokens > peakInputTokens) peakInputTokens = inputTokens;
      // Sample every message for the growth timeline (capped at 100 samples)
      contextSamples.push({ msg: messageCount, tokens: inputTokens, ts });

      // Per-model breakdown
      if (!modelBreakdown[model]) {
        modelBreakdown[model] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
      }
      modelBreakdown[model].input += inputTokens;
      modelBreakdown[model].output += outputTokens;
      modelBreakdown[model].cacheWrite += cacheWriteTokens;
      modelBreakdown[model].cacheRead += cacheReadTokens;

      // Calculate per-message cost and add to model total
      const pricing = TOKEN_PRICING[model] || DEFAULT_PRICING;
      const msgCost =
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output +
        (cacheWriteTokens / 1_000_000) * pricing.cacheWrite +
        (cacheReadTokens / 1_000_000) * pricing.cacheRead;
      modelBreakdown[model].cost = Math.round((modelBreakdown[model].cost + msgCost) * 1_000_000) / 1_000_000;
    } catch (_) {
      // Skip malformed lines
    }
  }

  // Downsample context growth to max 50 points for the timeline
  let contextGrowth = contextSamples;
  if (contextSamples.length > 50) {
    const step = Math.ceil(contextSamples.length / 50);
    contextGrowth = contextSamples.filter((_, i) => i % step === 0 || i === contextSamples.length - 1);
  }

  // Calculate total costs using weighted model pricing
  const cost = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  for (const [model, breakdown] of Object.entries(modelBreakdown)) {
    const pricing = TOKEN_PRICING[model] || DEFAULT_PRICING;
    cost.input += (breakdown.input / 1_000_000) * pricing.input;
    cost.output += (breakdown.output / 1_000_000) * pricing.output;
    cost.cacheWrite += (breakdown.cacheWrite / 1_000_000) * pricing.cacheWrite;
    cost.cacheRead += (breakdown.cacheRead / 1_000_000) * pricing.cacheRead;
  }
  // Round cost values to 6 decimal places to avoid floating point noise
  cost.input = Math.round(cost.input * 1_000_000) / 1_000_000;
  cost.output = Math.round(cost.output * 1_000_000) / 1_000_000;
  cost.cacheWrite = Math.round(cost.cacheWrite * 1_000_000) / 1_000_000;
  cost.cacheRead = Math.round(cost.cacheRead * 1_000_000) / 1_000_000;
  cost.total = Math.round((cost.input + cost.output + cost.cacheWrite + cost.cacheRead) * 1_000_000) / 1_000_000;

  return {
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheWrite: totals.cacheWrite,
      cacheRead: totals.cacheRead,
      total: totals.input + totals.output + totals.cacheWrite + totals.cacheRead,
    },
    cost,
    modelBreakdown,
    messageCount,
    firstMessage,
    lastMessage,
    // Quota / context growth metrics
    quota: {
      latestInputTokens,       // Current context window size (last message's input_tokens)
      peakInputTokens,         // Highest context window size observed
      contextGrowth,           // Sampled timeline: [{ msg, tokens, ts }, ...]
    },
  };
}

// ──────────────────────────────────────────────────────────
//  COST CAPABILITY GATE (BUILD-CONTRACT P9.3, CODEX-PARITY B10)
// ──────────────────────────────────────────────────────────
//
// The cost routes below run a Claude-shaped parser over whatever transcript
// they are handed: it matches `entry.type === 'assistant' && message.usage`.
// A Codex rollout yields ZERO matches against 618 `event_msg/token_count`
// entries in the file CODEX-PARITY measured, so the route returned a
// fully-formed cost object of zeroes and the UI rendered `$0.00` for a session
// that had 226 million tokens against it.
//
// `$0.00` is a claim, and it was the wrong one. These helpers make the routes
// say "this provider does not report money", with the real token counts
// attached, instead.

/**
 * Machine-readable reasons a money figure is absent, mirrored from
 * src/providers/codex/usage.js so a non-Codex provider that lacks cost support
 * gets the same vocabulary without importing a provider module.
 */
const COST_UNAVAILABLE_REASONS = Object.freeze({
  NO_PRICE_MODEL: 'provider-has-no-price-model',
  NO_USAGE: 'provider-reports-no-usage',
  NO_ARTIFACT: 'no-transcript-artifact',
});

/**
 * Does this provider report a MONEY figure.
 *
 * Defensive on both ends: an absent flag means "yes" (Claude semantics, which
 * is what every caller assumed before providers existed), and a throwing flag
 * is treated the same way rather than failing the request. Only an explicit
 * `false` gates.
 *
 * @param {object|null} provider
 * @returns {boolean}
 */
function providerSupportsCost(provider) {
  if (!provider || typeof provider.supportsCost !== 'function') return true;
  try {
    return provider.supportsCost() !== false;
  } catch (_) {
    return true;
  }
}

/**
 * Build the response for a provider that has no price model.
 *
 * Shape contract, consumed by the session peek and by any future token display:
 *
 *   costSupported          false. The single field a client should branch on.
 *   costUnavailableReason  one of COST_UNAVAILABLE_REASONS.
 *   cost                   null, NEVER a zeroed object. A client that does
 *                          `if (!data.cost)` hides its money panel, which is
 *                          the correct outcome and is what app.js already does.
 *   tokens                 real counts in the SAME field names the Claude path
 *                          uses (input, output, cacheRead, cacheWrite, total),
 *                          plus `reasoning`, so existing token-bar arithmetic
 *                          works unchanged. Null when nothing is known.
 *   tokensSource           'state-db' | 'rollout' | 'state-db+rollout' | null.
 *   usage                  the provider's full native report, for callers that
 *                          want the context window, the last turn or the plan
 *                          and rate-limit snapshot.
 *
 * @param {object|null} provider
 * @param {string} sessionId - Workbook session id.
 * @param {string|null} resumeSessionId - Upstream provider session id.
 * @param {string|null} jsonlPath - Resolved artifact, when one was found.
 * @returns {Promise<object>} Always resolves; never rejects.
 */
async function buildUnpricedCostResponse(provider, sessionId, resumeSessionId, jsonlPath) {
  const base = {
    sessionId: sessionId,
    resumeSessionId: resumeSessionId || null,
    provider: provider && provider.id ? provider.id : null,
    costSupported: false,
    cost: null,
    modelBreakdown: {},
    messageCount: 0,
    firstMessage: null,
    lastMessage: null,
  };

  const canReportUsage =
    provider &&
    typeof provider.parseUsage === 'function' &&
    (typeof provider.supportsTokenUsage !== 'function' || provider.supportsTokenUsage() !== false);

  if (!canReportUsage) {
    return Object.assign(base, {
      costUnavailableReason: COST_UNAVAILABLE_REASONS.NO_USAGE,
      tokens: null,
      tokensSource: null,
      usage: null,
    });
  }

  let report = null;
  try {
    report = await provider.parseUsage(resumeSessionId || sessionId, {
      artifactPath: jsonlPath || undefined,
    });
  } catch (_) {
    // parseUsage is contractually non-throwing; the guard keeps a broken
    // contract from turning an honest disclosure into a 500.
    report = null;
  }

  if (!report) {
    return Object.assign(base, {
      costUnavailableReason: COST_UNAVAILABLE_REASONS.NO_ARTIFACT,
      tokens: null,
      tokensSource: null,
      usage: null,
    });
  }

  return Object.assign(base, {
    costUnavailableReason: COST_UNAVAILABLE_REASONS.NO_PRICE_MODEL,
    tokens: report.tokens || null,
    tokensSource: report.source || null,
    contextWindow: typeof report.contextWindow === 'number' ? report.contextWindow : null,
    lastTurn: report.lastTurn || null,
    rateLimits: report.rateLimits || null,
    model: report.model || null,
    usage: report,
  });
}

/**
 * GET /api/sessions/:id/cost
 * Reads the session's JSONL file and calculates token usage and estimated cost.
 * Results are cached for 60 seconds, invalidated when the file mtime changes.
 *
 * BUILD-CONTRACT P9.3: gated on provider.supportsCost(). A provider with no
 * price model gets the explicit unsupported disclosure above, carrying its real
 * token counts, instead of a zeroed cost object that renders as `$0.00`.
 */
app.get('/api/sessions/:id/cost', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);

  // Plan 15-01 (DISC-03): dispatch through provider abstraction. Reused
  // across primary, workingDir-fallback, and last-resort lookups below.
  const provider = getProviderForSession(session);

  let resumeSessionId = (session && session.resumeSessionId) || null;
  let jsonlPath = (resumeSessionId && provider) ? provider.findArtifactPath(resumeSessionId) : null;

  // Fallback: if no JSONL found by resumeSessionId, try matching by workingDir.
  // This handles discovered/imported sessions that don't have resumeSessionId set.
  if (!jsonlPath && session && session.workingDir) {
    const fallback = provider ? provider.findArtifactByWorkingDir(session.workingDir) : null;
    if (fallback) {
      jsonlPath = fallback.jsonlPath;
      // Backfill the resumeSessionId so future lookups are fast
      if (!session.resumeSessionId) {
        store.updateSession(req.params.id, { resumeSessionId: fallback.claudeSessionId });
        resumeSessionId = fallback.claudeSessionId;
      }
    }
  }

  // Last resort: try the Myrlin session ID directly (unlikely to match, but try)
  if (!jsonlPath && !resumeSessionId) {
    jsonlPath = provider ? provider.findArtifactPath(req.params.id) : null;
    resumeSessionId = req.params.id;
  }

  // BUILD-CONTRACT P9.3: the capability gate, placed BEFORE the missing-artifact
  // branch on purpose. A provider whose totals live in its own store can answer
  // with real numbers even when no transcript file was resolved, and it must
  // never fall through to the zeroed cost object below.
  if (!providerSupportsCost(provider)) {
    buildUnpricedCostResponse(provider, req.params.id, resumeSessionId, jsonlPath)
      .then((payload) => res.json(payload))
      .catch((err) =>
        res.status(500).json({ error: 'Failed to read usage: ' + (err && err.message ? err.message : err) })
      );
    return;
  }

  if (!jsonlPath) {
    return res.json({
      sessionId: req.params.id,
      resumeSessionId,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
      cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
      modelBreakdown: {},
      messageCount: 0,
      firstMessage: null,
      lastMessage: null,
    });
  }

  try {
    // Check cache: keyed by resumeSessionId, validated by file mtime
    const stat = fs.statSync(jsonlPath);
    const mtimeMs = stat.mtimeMs;
    const cached = _costCache.get(resumeSessionId);
    const now = Date.now();

    if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < COST_CACHE_TTL) {
      return res.json(cached.result);
    }

    // Use worker thread for async cost calculation to avoid blocking terminal I/O
    calculateSessionCostAsync(jsonlPath).then((costData) => {
      const result = {
        sessionId: req.params.id,
        resumeSessionId,
        ...costData,
      };
      // Store in cache
      _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
      res.json(result);
    }).catch((err) => {
      // Fallback to sync calculation if worker fails
      try {
        const costData = calculateSessionCost(jsonlPath);
        const result = { sessionId: req.params.id, resumeSessionId, ...costData };
        _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
        res.json(result);
      } catch (syncErr) {
        res.status(500).json({ error: 'Failed to calculate cost: ' + syncErr.message });
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to calculate cost: ' + err.message });
  }
});

/**
 * GET /api/cost/batch
 * Returns cost totals for all sessions in a single response, avoiding N+1 requests.
 * Each entry includes sessionId, totalCost, and lastActive for sidebar badge rendering.
 * Uses the same cache as per-session cost endpoints.
 */
app.get('/api/cost/batch', requireAuth, async (req, res) => {
  try {
    const store = getStore();
    const allWorkspaces = store.getAllWorkspacesList();
    const costs = {};
    const pending = []; // Async calculations to run off the main thread

    for (const workspace of allWorkspaces) {
      const sessions = store.getWorkspaceSessions(workspace.id);
      for (const session of sessions) {
        const resumeSessionId = session.resumeSessionId;
        if (!resumeSessionId) continue;
        // Plan 15-01 (DISC-03): dispatch through provider abstraction.
        const provider = getProviderForSession(session);

        // BUILD-CONTRACT P9.3: the same capability gate the single-session route
        // applies, applied here too and BEFORE any artifact resolution.
        //
        // Without it, a cost-unsupported provider's rows ran the Claude parser,
        // matched nothing, and returned `cost: 0`, which is the false zero this
        // phase exists to remove. `cost: null` is the honest answer, and it is
        // also the value the frontend's badge patcher already skips, so a stale
        // batch response can never overwrite the em-dash disclosure.
        //
        // The token total is a warm-cache map lookup, so this branch performs no
        // IO at all and cannot slow a batch that spans every session on the
        // machine. A cold cache yields null, which means "unknown", not "zero".
        if (!providerSupportsCost(provider)) {
          let tokenTotal = null;
          try {
            if (provider && typeof provider.totalTokensSync === 'function') {
              tokenTotal = provider.totalTokensSync(resumeSessionId);
            }
          } catch (_) {
            tokenTotal = null;
          }
          costs[session.id] = {
            cost: null,
            costSupported: false,
            costUnavailableReason: COST_UNAVAILABLE_REASONS.NO_PRICE_MODEL,
            tokens: tokenTotal,
            lastActive: session.lastActive || null,
          };
          continue;
        }

        const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;
        if (!jsonlPath) continue;

        try {
          const stat = fs.statSync(jsonlPath);
          if (stat.size >= 500 * 1024 * 1024) continue;
          const mtimeMs = stat.mtimeMs;
          const cached = _costCache.get(resumeSessionId);
          const now = Date.now();

          if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < COST_CACHE_TTL) {
            // Cache hit: resolve immediately, no event loop blocking
            costs[session.id] = {
              cost: cached.result.cost ? cached.result.cost.total : 0,
              lastActive: cached.result.lastMessage || session.lastActive || null,
            };
          } else {
            // Cache miss: queue async worker calculation
            const sid = session.id;
            const lastActive = session.lastActive;
            pending.push(
              calculateSessionCostAsync(jsonlPath).then(costData => {
                const result = { sessionId: sid, resumeSessionId, ...costData };
                _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
                costs[sid] = {
                  cost: costData.cost ? costData.cost.total : 0,
                  lastActive: costData.lastMessage || lastActive || null,
                };
              }).catch(() => {
                // Fallback: sync calculation (only for this single session)
                try {
                  const costData = calculateSessionCost(jsonlPath);
                  const result = { sessionId: sid, resumeSessionId, ...costData };
                  _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
                  costs[sid] = {
                    cost: costData.cost ? costData.cost.total : 0,
                    lastActive: costData.lastMessage || lastActive || null,
                  };
                } catch (_) {}
              })
            );
          }
        } catch (_) {}
      }
    }

    // Wait for all async calculations to complete
    if (pending.length > 0) await Promise.all(pending);

    return res.json({ costs });
  } catch (err) {
    return res.status(500).json({ error: 'Batch cost failed: ' + err.message });
  }
});

/**
 * GET /api/quota-overview
 * Returns all sessions ranked by context window size (heaviness).
 * Helps identify sessions that need compaction or are consuming the most tokens.
 * Sorted by latestInputTokens descending (heaviest first).
 */
app.get('/api/quota-overview', requireAuth, async (req, res) => {
  try {
    const store = getStore();
    const allWorkspaces = store.getAllWorkspacesList();
    const entries = []; // { session, workspace, costData }
    const pending = [];

    for (const workspace of allWorkspaces) {
      const sessions = store.getWorkspaceSessions(workspace.id);
      for (const session of sessions) {
        const resumeSessionId = session.resumeSessionId;
        if (!resumeSessionId) continue;

        // Plan 15-01 (DISC-03): dispatch through provider abstraction.
        const provider = getProviderForSession(session);
        const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;
        if (!jsonlPath) continue;

        try {
          const stat = fs.statSync(jsonlPath);
          if (stat.size >= 500 * 1024 * 1024) continue;
          const mtimeMs = stat.mtimeMs;
          const cached = _costCache.get(resumeSessionId);
          const now = Date.now();

          if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < COST_CACHE_TTL) {
            entries.push({ session, workspace, costData: cached.result, stat });
          } else {
            const idx = entries.length;
            entries.push({ session, workspace, costData: null, stat });
            pending.push(
              calculateSessionCostAsync(jsonlPath).catch(() => calculateSessionCost(jsonlPath))
                .then(costData => {
                  const result = { sessionId: session.id, resumeSessionId, ...costData };
                  _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
                  entries[idx].costData = result;
                }).catch(() => {})
            );
          }

        } catch (_) {}
      }
    }

    if (pending.length > 0) await Promise.all(pending);

    const sessionQuotas = [];
    for (const { session, workspace, costData, stat } of entries) {
      if (!costData) continue;
      const latestInput = costData.quota ? costData.quota.latestInputTokens : 0;
      const peakInput = costData.quota ? costData.quota.peakInputTokens : 0;
      const totalCost = costData.cost ? costData.cost.total : 0;
      const totalTokens = costData.tokens ? costData.tokens.total : 0;
      const messages = costData.messageCount || 0;
      const contextPct = Math.round((latestInput / 200000) * 100);
      const urgency = contextPct >= 80 ? 'critical' : contextPct >= 50 ? 'warning' : 'ok';

      sessionQuotas.push({
        sessionId: session.id,
        sessionName: session.name || session.id.substring(0, 12),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        latestInputTokens: latestInput,
        peakInputTokens: peakInput,
        contextPct,
        urgency,
        totalTokens,
        totalCost,
        messageCount: messages,
        fileSize: stat.size,
        lastMessage: costData.lastMessage || null,
      });
    }

    // Sort by context window size descending (heaviest first)
    sessionQuotas.sort((a, b) => b.latestInputTokens - a.latestInputTokens);

    // Summary stats
    const totalSessions = sessionQuotas.length;
    const criticalCount = sessionQuotas.filter(s => s.urgency === 'critical').length;
    const warningCount = sessionQuotas.filter(s => s.urgency === 'warning').length;
    const totalTokensAll = sessionQuotas.reduce((sum, s) => sum + s.totalTokens, 0);
    const totalCostAll = sessionQuotas.reduce((sum, s) => sum + s.totalCost, 0);

    res.json({
      summary: {
        totalSessions,
        criticalCount,
        warningCount,
        totalTokens: totalTokensAll,
        totalCost: Math.round(totalCostAll * 1000) / 1000,
      },
      sessions: sessionQuotas,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get quota overview: ' + err.message });
  }
});

/**
 * GET /api/workspaces/:id/cost
 * Aggregates token usage and cost across all sessions in a workspace.
 */
app.get('/api/workspaces/:id/cost', requireAuth, async (req, res) => {
  const store = getStore();
  const workspace = store.getWorkspace(req.params.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }

  const sessions = store.getWorkspaceSessions(req.params.id);
  const totals = {
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
    modelBreakdown: {},
    messageCount: 0,
    firstMessage: null,
    lastMessage: null,
    sessionCount: sessions.length,
    sessionsWithData: 0,
  };

  // Resolve cost data for all sessions (async for cache misses)
  const costResults = [];
  const pending = [];

  for (const session of sessions) {
    const resumeSessionId = session.resumeSessionId;
    if (!resumeSessionId) continue;

    // Plan 15-01 (DISC-03): dispatch through provider abstraction.
    const provider = getProviderForSession(session);
    const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;
    if (!jsonlPath) continue;

    try {
      const stat = fs.statSync(jsonlPath);
      const mtimeMs = stat.mtimeMs;
      const cached = _costCache.get(resumeSessionId);
      const now = Date.now();

      if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < COST_CACHE_TTL) {
        costResults.push(cached.result);
      } else {
        const idx = costResults.length;
        costResults.push(null);
        pending.push(
          calculateSessionCostAsync(jsonlPath).catch(() => calculateSessionCost(jsonlPath))
            .then(costData => {
              const result = { sessionId: session.id, resumeSessionId, ...costData };
              _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
              costResults[idx] = result;
            }).catch(() => {})
        );
      }
    } catch (_) {}
  }

  if (pending.length > 0) await Promise.all(pending);

  for (const costData of costResults) {
    if (!costData || !costData.tokens || !costData.cost) continue;

    totals.tokens.input += costData.tokens.input;
    totals.tokens.output += costData.tokens.output;
    totals.tokens.cacheWrite += costData.tokens.cacheWrite;
    totals.tokens.cacheRead += costData.tokens.cacheRead;
    totals.tokens.total += costData.tokens.total;

    totals.cost.input += costData.cost.input;
    totals.cost.output += costData.cost.output;
    totals.cost.cacheWrite += costData.cost.cacheWrite;
    totals.cost.cacheRead += costData.cost.cacheRead;
    totals.cost.total += costData.cost.total;

    totals.messageCount += costData.messageCount;
    totals.sessionsWithData++;

    if (costData.firstMessage && (!totals.firstMessage || costData.firstMessage < totals.firstMessage)) {
      totals.firstMessage = costData.firstMessage;
    }
    if (costData.lastMessage && (!totals.lastMessage || costData.lastMessage > totals.lastMessage)) {
      totals.lastMessage = costData.lastMessage;
    }

    // Merge model breakdowns
    if (costData.modelBreakdown) {
      for (const [model, breakdown] of Object.entries(costData.modelBreakdown)) {
        if (!totals.modelBreakdown[model]) {
          totals.modelBreakdown[model] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
        }
        totals.modelBreakdown[model].input += breakdown.input;
        totals.modelBreakdown[model].output += breakdown.output;
        totals.modelBreakdown[model].cacheWrite += breakdown.cacheWrite;
        totals.modelBreakdown[model].cacheRead += breakdown.cacheRead;
        totals.modelBreakdown[model].cost += breakdown.cost;
      }
    }
  }

  // Round aggregated cost values
  totals.cost.input = Math.round(totals.cost.input * 1_000_000) / 1_000_000;
  totals.cost.output = Math.round(totals.cost.output * 1_000_000) / 1_000_000;
  totals.cost.cacheWrite = Math.round(totals.cost.cacheWrite * 1_000_000) / 1_000_000;
  totals.cost.cacheRead = Math.round(totals.cost.cacheRead * 1_000_000) / 1_000_000;
  totals.cost.total = Math.round(totals.cost.total * 1_000_000) / 1_000_000;
  for (const model of Object.keys(totals.modelBreakdown)) {
    totals.modelBreakdown[model].cost = Math.round(totals.modelBreakdown[model].cost * 1_000_000) / 1_000_000;
  }

  return res.json({
    workspaceId: req.params.id,
    workspaceName: workspace.name,
    ...totals,
  });
});

/**
 * GET /api/workspaces/:id/analytics
 * Aggregates per-workspace metrics: session counts by status, cost/token
 * totals (reusing the cost cache where available), and top sessions by cost.
 */
app.get('/api/workspaces/:id/analytics', requireAuth, (req, res) => {
  try {
    const store = getStore();
    const workspace = store.getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found.' });

    const sessions = store.getWorkspaceSessions(req.params.id);
    const running = sessions.filter(s => s.status === 'running').length;
    const stopped = sessions.filter(s => s.status === 'stopped' || !s.status).length;
    const crashed = sessions.filter(s => s.status === 'crashed' || s.status === 'error').length;

    // Find most recent activity
    let lastActivity = workspace.createdAt;
    sessions.forEach(s => {
      if (s.lastActive && s.lastActive > lastActivity) lastActivity = s.lastActive;
    });

    // Calculate time span (first session created to last activity)
    let firstCreated = workspace.createdAt;
    sessions.forEach(s => {
      if (s.createdAt && s.createdAt < firstCreated) firstCreated = s.createdAt;
    });

    // Aggregate cost data from sessions, reusing cache where available
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let costAvailable = false;
    const sessionCosts = [];

    for (const s of sessions.slice(0, 20)) {
      const resumeSessionId = s.resumeSessionId;
      if (!resumeSessionId) continue;

      // Plan 15-01 (DISC-03): dispatch through provider abstraction.
      const provider = getProviderForSession(s);
      const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;
      if (!jsonlPath) continue;

      try {
        const stat = fs.statSync(jsonlPath);
        const mtimeMs = stat.mtimeMs;
        const cached = _costCache.get(resumeSessionId);
        const now = Date.now();
        let costData;

        if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < COST_CACHE_TTL) {
          costData = cached.result;
        } else {
          // Only process files under 500MB to avoid blocking
          if (stat.size >= 500 * 1024 * 1024) continue;
          costData = calculateSessionCost(jsonlPath);
          const result = { sessionId: s.id, resumeSessionId, ...costData };
          _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
        }

        const sessionTotal = costData.cost ? costData.cost.total : 0;
        totalCost += sessionTotal;
        totalInputTokens += costData.tokens ? costData.tokens.input : 0;
        totalOutputTokens += costData.tokens ? costData.tokens.output : 0;
        sessionCosts.push({ name: s.name || s.id.substring(0, 12), cost: sessionTotal });
        costAvailable = true;
      } catch (_) {
        // Skip sessions whose JSONL files can't be read
      }
    }

    // Sort sessions by cost descending, keep top 5
    sessionCosts.sort((a, b) => b.cost - a.cost);

    res.json({
      totalSessions: sessions.length,
      runningSessions: running,
      stoppedSessions: stopped,
      crashedSessions: crashed,
      lastActivity,
      firstCreated,
      costAvailable,
      totalCost: Math.round(totalCost * 1000) / 1000,
      totalInputTokens,
      totalOutputTokens,
      avgSessionCost: sessions.length > 0 ? Math.round((totalCost / sessions.length) * 1000) / 1000 : 0,
      topSessions: sessionCosts.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get analytics: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  COST DASHBOARD
// ──────────────────────────────────────────────────────────

/**
 * GET /api/cost/dashboard?period=week
 * Returns aggregated cost dashboard data: summary, timeline, model/workspace
 * breakdowns, and per-session costs. Used by the Costs tab.
 * @param {string} [period=week] - One of: day, week, month, all
 */
app.get('/api/cost/dashboard', requireAuth, async (req, res) => {
  try {
    const period = req.query.period || 'week';
    const store = getStore();
    const allWorkspaces = store.getAllWorkspacesList();

    // Period cutoff calculation
    const now = Date.now();
    const periodMs = {
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      all: Infinity,
    };
    const cutoffMs = periodMs[period] || periodMs.week;
    const cutoffDate = cutoffMs === Infinity ? null : new Date(now - cutoffMs).toISOString();

    // Phase 1: resolve cost data for all sessions (async for cache misses)
    const sessionEntries = []; // { session, workspace, costData }
    const pending = [];

    for (const workspace of allWorkspaces) {
      const sessions = store.getWorkspaceSessions(workspace.id);
      for (const session of sessions) {
        const resumeSessionId = session.resumeSessionId;
        if (!resumeSessionId) continue;
        // Plan 15-01 (DISC-03): dispatch through provider abstraction.
        const provider = getProviderForSession(session);
        const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;
        if (!jsonlPath) continue;

        try {
          const stat = fs.statSync(jsonlPath);
          if (stat.size >= 500 * 1024 * 1024) continue;
          const mtimeMs = stat.mtimeMs;
          const cached = _costCache.get(resumeSessionId);
          const cacheNow = Date.now();

          if (cached && cached.mtimeMs === mtimeMs && (cacheNow - cached.timestamp) < COST_CACHE_TTL) {
            sessionEntries.push({ session, workspace, costData: cached.result });
          } else {
            // Queue async calculation and push a placeholder
            const idx = sessionEntries.length;
            sessionEntries.push({ session, workspace, costData: null });
            pending.push(
              calculateSessionCostAsync(jsonlPath).catch(() => {
                // Fallback to sync if worker fails
                return calculateSessionCost(jsonlPath);
              }).then(costData => {
                const result = { sessionId: session.id, resumeSessionId, ...costData };
                _costCache.set(resumeSessionId, { mtimeMs, timestamp: cacheNow, result });
                sessionEntries[idx].costData = result;
              }).catch(() => {})
            );
          }
        } catch (_) {}
      }
    }

    // Wait for all async calculations off the main thread
    if (pending.length > 0) await Promise.all(pending);

    // Phase 2: aggregate all cost data (pure arithmetic, no I/O)
    const allSessionCosts = [];
    const dailyCosts = {};
    const modelAgg = {};
    const workspaceAgg = {};
    let totalCost = 0;
    let totalTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    let totalMessages = 0;
    let periodCost = 0;

    for (const { session, workspace, costData } of sessionEntries) {
      if (!costData) continue;

      if (!workspaceAgg[workspace.id]) {
        workspaceAgg[workspace.id] = { id: workspace.id, name: workspace.name, cost: 0, sessionCount: 0 };
      }

      const sessionCost = costData.cost ? costData.cost.total : 0;
      totalCost += sessionCost;
      totalMessages += costData.messageCount || 0;

      if (costData.tokens) {
        totalTokens.input += costData.tokens.input || 0;
        totalTokens.output += costData.tokens.output || 0;
        totalTokens.cacheWrite += costData.tokens.cacheWrite || 0;
        totalTokens.cacheRead += costData.tokens.cacheRead || 0;
      }

      workspaceAgg[workspace.id].cost += sessionCost;
      workspaceAgg[workspace.id].sessionCount++;

      if (costData.modelBreakdown) {
        for (const [model, breakdown] of Object.entries(costData.modelBreakdown)) {
          if (!modelAgg[model]) {
            modelAgg[model] = { model, cost: 0, tokens: 0 };
          }
          modelAgg[model].cost += breakdown.cost || 0;
          modelAgg[model].tokens += (breakdown.input || 0) + (breakdown.output || 0) +
            (breakdown.cacheWrite || 0) + (breakdown.cacheRead || 0);
        }
      }

      const samples = costData.quota ? costData.quota.contextGrowth : [];
      if (samples && samples.length > 0) {
        const perMsgCost = costData.messageCount > 0
          ? sessionCost / costData.messageCount : 0;
        for (const sample of samples) {
          if (!sample.ts) continue;
          const dayKey = sample.ts.substring(0, 10);
          if (!dailyCosts[dayKey]) {
            dailyCosts[dayKey] = { date: dayKey, cost: 0, tokens: 0, messages: 0 };
          }
          dailyCosts[dayKey].cost += perMsgCost;
          dailyCosts[dayKey].tokens += sample.tokens || 0;
          dailyCosts[dayKey].messages++;
        }
      }

      if (!cutoffDate) {
        periodCost += sessionCost;
      } else if (samples && samples.length > 0 && costData.messageCount > 0) {
        const perMsgCost = sessionCost / costData.messageCount;
        let periodMessages = 0;
        for (const sample of samples) {
          if (sample.ts && sample.ts >= cutoffDate) periodMessages++;
        }
        periodCost += perMsgCost * periodMessages;
      } else if (costData.lastMessage && costData.lastMessage >= cutoffDate) {
        periodCost += sessionCost;
      }

      let primaryModel = 'unknown';
      let maxModelCost = 0;
      if (costData.modelBreakdown) {
        for (const [model, breakdown] of Object.entries(costData.modelBreakdown)) {
          if (breakdown.cost > maxModelCost) {
            maxModelCost = breakdown.cost;
            primaryModel = model;
          }
        }
      }

      allSessionCosts.push({
        id: session.id,
        name: session.name || session.id.substring(0, 12),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        // Plan 18-04 (COST-02/03): forward the session's provider so the
        // dashboard table can render an em-dash for cost-unsupported
        // providers instead of an inaccurate '$0.00'.
        provider: session.provider || 'claude', // gsd:provider-literal-allowed
        cost: Math.round(sessionCost * 1000) / 1000,
        messageCount: costData.messageCount || 0,
        model: primaryModel,
        lastActive: costData.lastMessage || session.lastActive || null,
        firstMessage: costData.firstMessage || null,
      });
    }

    // Build timeline sorted by date, filtered to period
    let timeline = Object.values(dailyCosts).sort((a, b) => a.date.localeCompare(b.date));
    if (cutoffDate) {
      const cutoffDay = cutoffDate.substring(0, 10);
      timeline = timeline.filter(d => d.date >= cutoffDay);
    }
    // Round cost values in timeline
    timeline.forEach(d => {
      d.cost = Math.round(d.cost * 1000) / 1000;
    });

    // Build model breakdown sorted by cost descending
    const totalCostForPct = totalCost || 1;
    const byModel = Object.values(modelAgg)
      .map(m => ({
        model: m.model,
        cost: Math.round(m.cost * 1000) / 1000,
        tokens: m.tokens,
        pct: Math.round((m.cost / totalCostForPct) * 100),
      }))
      .sort((a, b) => b.cost - a.cost);

    // Build workspace breakdown sorted by cost descending
    const byWorkspace = Object.values(workspaceAgg)
      .filter(w => w.cost > 0)
      .map(w => ({
        id: w.id,
        name: w.name,
        cost: Math.round(w.cost * 1000) / 1000,
        sessionCount: w.sessionCount,
        pct: Math.round((w.cost / totalCostForPct) * 100),
      }))
      .sort((a, b) => b.cost - a.cost);

    // Sort sessions by cost descending
    allSessionCosts.sort((a, b) => b.cost - a.cost);

    // Calculate cache savings: cacheRead tokens charged at cacheRead rate instead of full input rate
    // Savings = cacheRead tokens * (input_rate - cacheRead_rate)
    // Use average input rate across models for simplicity
    const avgInputRate = byModel.length > 0
      ? byModel.reduce((sum, m) => {
          const pricing = TOKEN_PRICING[m.model] || DEFAULT_PRICING;
          return sum + pricing.input;
        }, 0) / byModel.length
      : DEFAULT_PRICING.input;
    const avgCacheReadRate = byModel.length > 0
      ? byModel.reduce((sum, m) => {
          const pricing = TOKEN_PRICING[m.model] || DEFAULT_PRICING;
          return sum + pricing.cacheRead;
        }, 0) / byModel.length
      : DEFAULT_PRICING.cacheRead;
    const cacheSavings = Math.round(
      (totalTokens.cacheRead / 1_000_000) * (avgInputRate - avgCacheReadRate) * 1000
    ) / 1000;

    // Period labels
    const periodLabels = {
      day: 'Last 24 hours',
      week: 'Last 7 days',
      month: 'Last 30 days',
      all: 'All time',
    };

    res.json({
      summary: {
        totalCost: Math.round(totalCost * 1000) / 1000,
        totalTokens,
        periodCost: Math.round(periodCost * 1000) / 1000,
        periodLabel: periodLabels[period] || periodLabels.week,
        messageCount: totalMessages,
        avgCostPerMessage: totalMessages > 0
          ? Math.round((totalCost / totalMessages) * 10000) / 10000 : 0,
        cacheSavings,
      },
      timeline,
      byModel,
      byWorkspace,
      sessions: allSessionCosts,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get cost dashboard: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  SESSION CONTEXT EXPORT / HANDOFF
// ──────────────────────────────────────────────────────────

/**
 * Extract text content from a JSONL message entry.
 * Returns { role, text } or null if the entry is not a user/assistant message.
 * Shared helper used by the export-context endpoint.
 */
function extractExportMessageText(line) {
  try {
    const msg = JSON.parse(line);
    const inner = msg.message || msg;
    const role = msg.type || inner.role;
    const isUser = role === 'user' || role === 'human';
    const isAssistant = role === 'assistant';
    if (!isUser && !isAssistant) return null;

    const c = inner.content;
    let text = '';
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      const textBlocks = c.filter(b => b.type === 'text' && b.text);
      text = textBlocks.map(b => b.text).join(' ');
    }
    // Skip system-generated messages and very short messages
    if (!text || text.length < 5) return null;
    if (text.startsWith('<') && text.includes('system-reminder')) return null;

    return {
      role: isUser ? 'user' : 'assistant',
      text: text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Extract file paths from text content using common patterns.
 * Looks for paths like src/foo.js, ./bar.ts, /path/to/file.py, etc.
 * Returns a deduplicated sorted array of file path strings.
 */
function extractFilePaths(text) {
  const pathSet = new Set();

  // Match paths with common source file extensions
  // Patterns: src/foo.js, ./bar/baz.ts, path/to/file.py, C:\Users\...\file.js, etc.
  const extensionPattern = /(?:[\w./-]+\/)?[\w.-]+\.(?:js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|swift|kt|scala|sh|bash|zsh|ps1|psm1|json|yaml|yml|toml|xml|html|css|scss|sass|less|sql|md|mdx|vue|svelte|astro|prisma|graphql|gql|proto|tf|hcl)\b/gi;

  // Match explicit relative or absolute paths (./foo, ../bar, /src/baz, src/qux)
  const pathPattern = /(?:\.{1,2}\/|\bsrc\/|\blib\/|\btest\/|\btests\/|\bapp\/|\bpages\/|\bcomponents\/|\butils\/|\bcore\/|\bweb\/|\bapi\/|\bconfig\/|\bdist\/|\bbuild\/)[\w./-]+/gi;

  const extensionMatches = text.match(extensionPattern) || [];
  const pathMatches = text.match(pathPattern) || [];

  for (const match of [...extensionMatches, ...pathMatches]) {
    // Clean up the match: remove trailing punctuation, quotes, parens
    let cleaned = match.replace(/[,;:'")\]}>]+$/, '').replace(/^['"(\[{<]+/, '');
    // Skip very short or obviously not-a-path strings
    if (cleaned.length < 4) continue;
    // Skip things that look like URLs
    if (cleaned.includes('://')) continue;
    // Normalize backslashes to forward slashes for consistency
    cleaned = cleaned.replace(/\\/g, '/');
    pathSet.add(cleaned);
  }

  return Array.from(pathSet).sort();
}

/**
 * GET /api/sessions/:id/export-context
 * Generates a structured context export for session handoff.
 * When a Claude session runs out of context, this endpoint produces a
 * markdown summary with the original request, work done, files touched,
 * and token usage - ready to paste into a new session.
 * Protected by auth.
 */
app.get('/api/sessions/:id/export-context', requireAuth, async (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);

  // Support both store sessions and direct Claude UUID
  const claudeSessionId = (session && session.resumeSessionId) || req.params.id;
  const sessionName = (session && session.name) || claudeSessionId || 'Unknown Session';

  if (!claudeSessionId) {
    return res.status(400).json({ error: 'No Claude session ID available' });
  }

  // Plan 15-01 (DISC-03): dispatch through provider abstraction. Falls back
  // to claudeProvider when req.params.id is a direct Claude UUID (no store
  // session record), preserving the route's pre-Phase-15 behavior.
  const provider = getProviderForSession(session) || claudeProvider;
  const jsonlPath = provider.findArtifactPath(claudeSessionId);

  if (!jsonlPath) {
    // No JSONL file found - return basic info from store session data
    return res.json({
      sessionId: req.params.id,
      sessionName,
      export: {
        markdown: `# Session Context: ${sessionName}\n\n_No conversation data found. The JSONL file for this session could not be located._`,
        filesTouched: [],
        messageCount: 0,
        tokenSummary: { input: 0, output: 0, cost: 0 },
      },
    });
  }

  try {
    const stat = fs.statSync(jsonlPath);
    const fileSize = stat.size;

    // ── Read head (first 5 user messages) and tail (last 5 assistant messages) ──
    // Strategy: read first 50KB for early messages, last 100KB for recent messages
    const headSize = Math.min(50 * 1024, fileSize);
    const tailSize = Math.min(100 * 1024, fileSize);
    const tailOffset = Math.max(0, fileSize - tailSize);

    const fd = fs.openSync(jsonlPath, 'r');

    const headBuf = Buffer.alloc(headSize);
    fs.readSync(fd, headBuf, 0, headSize, 0);

    const tailBuf = Buffer.alloc(tailSize);
    fs.readSync(fd, tailBuf, 0, tailSize, tailOffset);

    fs.closeSync(fd);

    // Parse head messages - collect first 5 user messages
    const headContent = headBuf.toString('utf-8');
    const headLines = headContent.split('\n').filter(l => l.trim());
    const firstUserMessages = [];
    for (const line of headLines) {
      if (firstUserMessages.length >= 5) break;
      const parsed = extractExportMessageText(line);
      if (parsed && parsed.role === 'user') {
        firstUserMessages.push(parsed.text);
      }
    }

    // Parse tail messages - collect last 5 assistant messages
    const tailContent = tailBuf.toString('utf-8');
    const tailLines = tailContent.split('\n').filter(l => l.trim());
    // Drop partial first line if we started mid-file
    if (tailOffset > 0 && tailLines.length > 0) tailLines.shift();

    const lastAssistantMessages = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (lastAssistantMessages.length >= 5) break;
      const parsed = extractExportMessageText(tailLines[i]);
      if (parsed && parsed.role === 'assistant') {
        lastAssistantMessages.unshift(parsed.text);
      }
    }

    // ── Count total messages via cost calculation (off main thread) ──
    let costData;
    try {
      costData = await calculateSessionCostAsync(jsonlPath).catch(() => calculateSessionCost(jsonlPath));
    } catch (_) {
      costData = {
        tokens: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        messageCount: 0,
      };
    }

    // ── Count all user+assistant messages for the total message count ──
    // costData.messageCount only counts assistant messages with usage data,
    // so we'll also count from head+tail for a more complete picture
    const allParsedLines = [];
    // Read the full file for accurate message count and file path extraction
    let fullContent;
    try {
      fullContent = fs.readFileSync(jsonlPath, 'utf-8');
    } catch (_) {
      fullContent = headContent + '\n' + tailContent;
    }
    const fullLines = fullContent.split('\n').filter(l => l.trim());
    let totalMessageCount = 0;
    const allTextForPaths = [];

    for (const line of fullLines) {
      const parsed = extractExportMessageText(line);
      if (parsed) {
        totalMessageCount++;
        // Collect text for file path extraction (limit per message to avoid huge strings)
        allTextForPaths.push(parsed.text.substring(0, 2000));
      }
    }

    // ── Extract file paths from all message content ──
    const combinedText = allTextForPaths.join('\n');
    const filesTouched = extractFilePaths(combinedText);

    // ── Build the token summary ──
    const tokenSummary = {
      input: costData.tokens.input,
      output: costData.tokens.output,
      cost: Math.round(costData.cost.total * 100) / 100,
    };

    // ── Build the markdown export ──
    const mdParts = [];
    mdParts.push(`# Session Context: ${sessionName}`);
    mdParts.push('');

    // Original Request - first user message in full
    mdParts.push('## Original Request');
    if (firstUserMessages.length > 0) {
      mdParts.push(firstUserMessages[0]);
    } else {
      mdParts.push('_No user messages found._');
    }
    mdParts.push('');

    // Additional early context (if more than 1 user message in the head)
    if (firstUserMessages.length > 1) {
      mdParts.push('## Early Follow-ups');
      for (let i = 1; i < firstUserMessages.length; i++) {
        const truncated = firstUserMessages[i].length > 500
          ? firstUserMessages[i].substring(0, 500).replace(/\s+\S*$/, '') + '...'
          : firstUserMessages[i];
        mdParts.push(`- ${truncated}`);
      }
      mdParts.push('');
    }

    // Work Done - last 3 assistant messages, truncated to 500 chars each
    mdParts.push('## Work Done');
    if (lastAssistantMessages.length > 0) {
      const workMessages = lastAssistantMessages.slice(-3);
      for (const msg of workMessages) {
        const truncated = msg.length > 500
          ? msg.substring(0, 500).replace(/\s+\S*$/, '') + '...'
          : msg;
        mdParts.push(`- ${truncated}`);
      }
    } else {
      mdParts.push('_No assistant messages found._');
    }
    mdParts.push('');

    // Files Touched
    mdParts.push('## Files Touched');
    if (filesTouched.length > 0) {
      for (const fp of filesTouched) {
        mdParts.push(`- ${fp}`);
      }
    } else {
      mdParts.push('_No file paths detected in conversation._');
    }
    mdParts.push('');

    // Token Usage
    mdParts.push('## Token Usage');
    mdParts.push(`- Input: ${tokenSummary.input.toLocaleString()}`);
    mdParts.push(`- Output: ${tokenSummary.output.toLocaleString()}`);
    mdParts.push(`- Estimated cost: $${tokenSummary.cost.toFixed(2)}`);
    mdParts.push('');

    // Last State - last assistant message content, truncated to 2000 chars
    mdParts.push('## Last State');
    if (lastAssistantMessages.length > 0) {
      const lastMsg = lastAssistantMessages[lastAssistantMessages.length - 1];
      const truncatedLast = lastMsg.length > 2000
        ? lastMsg.substring(0, 2000).replace(/\s+\S*$/, '') + '...'
        : lastMsg;
      mdParts.push(truncatedLast);
    } else {
      mdParts.push('_No assistant messages found._');
    }

    const markdown = mdParts.join('\n');

    return res.json({
      sessionId: req.params.id,
      sessionName,
      export: {
        markdown,
        filesTouched,
        messageCount: totalMessageCount,
        tokenSummary,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to export session context: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  TASK SPINOFF: EXTRACT TASKS + GENERATE CONTEXT PACKAGES
// ──────────────────────────────────────────────────────────

/**
 * Read conversation text from a session's JSONL file for task extraction.
 * Returns the last ~150KB of conversation as user/assistant message pairs.
 * Filters system reminders and very short messages.
 * @param {string} jsonlPath - Path to the JSONL file
 * @param {number} [maxBytes=153600] - Maximum bytes to read from tail
 * @returns {{ messages: Array<{role: string, text: string}>, filesTouched: string[] }}
 */
function readConversationForExtraction(jsonlPath, maxBytes = 150 * 1024) {
  const stat = fs.statSync(jsonlPath);
  let content;

  if (stat.size <= maxBytes) {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } else {
    // Read only the tail for recent context
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      content = buf.toString('utf-8');
      // Drop partial first line from seeking mid-file
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) content = content.slice(firstNewline + 1);
    } finally {
      fs.closeSync(fd);
    }
  }

  const lines = content.split('\n').filter(l => l.trim());
  const messages = [];
  const allText = [];

  for (const line of lines) {
    const parsed = extractExportMessageText(line);
    if (parsed) {
      messages.push(parsed);
      allText.push(parsed.text.substring(0, 2000));
    }
  }

  // Extract file paths from all message content
  const filesTouched = extractFilePaths(allText.join('\n'));

  return { messages, filesTouched };
}

/**
 * Build a condensed conversation summary for the AI task extraction prompt.
 * Keeps total under ~8000 chars to fit within Claude --print context.
 * @param {Array<{role: string, text: string}>} messages - Parsed conversation messages
 * @returns {string} Condensed conversation text
 */
function buildConversationSummary(messages) {
  const MAX_CHARS = 8000;
  const parts = [];
  let charCount = 0;

  // Include first 3 user messages in full (establish original intent)
  let userCount = 0;
  for (const msg of messages) {
    if (msg.role === 'user' && userCount < 3) {
      const line = `USER: ${msg.text.substring(0, 800)}`;
      parts.push(line);
      charCount += line.length;
      userCount++;
    }
    if (userCount >= 3) break;
  }

  // Include last 15 messages (recent context) with truncation
  const recentMessages = messages.slice(-15);
  for (const msg of recentMessages) {
    if (charCount >= MAX_CHARS) break;
    const prefix = msg.role === 'user' ? 'USER' : 'ASSISTANT';
    const truncated = msg.text.substring(0, 500);
    const line = `${prefix}: ${truncated}`;
    parts.push(line);
    charCount += line.length;
  }

  return parts.join('\n\n');
}

/**
 * POST /api/sessions/:id/extract-tasks
 * AI-extracts actionable tasks from a session's conversation history.
 * Uses claude --print to analyze the conversation and return structured tasks.
 * Returns: { tasks: Array<{ title, description, relevantFiles, acceptanceCriteria, branch }> }
 */
app.post('/api/sessions/:id/extract-tasks', requireAuth, async (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);
  const claudeSessionId = (session && session.resumeSessionId) || req.params.id;

  if (!claudeSessionId) {
    return res.status(400).json({ error: 'No Claude session ID available' });
  }

  // Plan 15-01 (DISC-03): dispatch through provider abstraction.
  const provider = getProviderForSession(session) || claudeProvider;
  const jsonlPath = provider.findArtifactPath(claudeSessionId);
  if (!jsonlPath) {
    return res.status(404).json({ error: 'No conversation data found. This session may not have an active Claude conversation yet. Start Claude in this terminal first, or try a discovered session.' });
  }

  const claudeBin = resolveClaudeCli();
  if (!claudeBin) {
    return res.status(400).json({ error: 'Claude CLI not found. Install it (npm install -g @anthropic-ai/claude-code) or make sure it is on your PATH.' });
  }

  try {
    // Read and parse conversation
    const { messages, filesTouched } = readConversationForExtraction(jsonlPath);
    if (messages.length < 2) {
      return res.status(400).json({ error: 'Session has too few messages to extract tasks from. Have a longer conversation first.' });
    }

    // Build condensed conversation for the prompt
    const conversationSummary = buildConversationSummary(messages);

    const prompt = `You are analyzing a Claude Code session conversation to extract independent, actionable tasks that can be spun off as separate worktree branches.

CONVERSATION:
${conversationSummary}

FILES REFERENCED IN SESSION:
${filesTouched.slice(0, 30).join('\n') || 'None detected'}

INSTRUCTIONS:
1. Identify 1-6 independent, actionable tasks discussed or implied in this conversation
2. Each task should be a self-contained unit of work suitable for a separate git branch
3. Focus on tasks that were discussed but not yet completed, or improvements mentioned
4. Include enough context in each description for a fresh Claude session to understand and execute
5. Generate a short kebab-case branch name for each (e.g., "add-user-auth", "fix-sidebar-layout")

Respond ONLY with a JSON array (no markdown, no explanation). Each element must have exactly these fields:
- "title": string (short, imperative, under 60 chars)
- "description": string (2-4 sentences describing what to build/fix and why)
- "relevantFiles": string[] (file paths likely involved, from the conversation)
- "acceptanceCriteria": string[] (2-4 concrete conditions for "done")
- "branch": string (kebab-case branch name, no "feat/" prefix)

Example:
[{"title":"Add error handling to API endpoints","description":"Several API routes lack proper error handling...","relevantFiles":["src/web/server.js"],"acceptanceCriteria":["All routes return proper error codes","Error responses follow {error: string} shape"],"branch":"add-api-error-handling"}]

JSON array:`;

    const result = await new Promise((resolve, reject) => {
      execFile(claudeBin, ['--print', '-p', prompt], {
        cwd: session ? (session.workingDir || process.cwd()) : process.cwd(),
        timeout: 90000,
        maxBuffer: 1024 * 512,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) return reject(new Error('Task extraction failed: ' + (err.message || 'unknown error')));
        resolve(stdout.trim());
      });
    });

    // Parse the JSON response -- handle potential markdown wrapping
    let tasks;
    try {
      // Strip markdown code fences if present
      let cleaned = result;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      tasks = JSON.parse(cleaned);
    } catch (parseErr) {
      // Try to extract JSON array from the response
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          tasks = JSON.parse(jsonMatch[0]);
        } catch {
          return res.status(500).json({ error: 'Failed to parse AI response as JSON', raw: result.substring(0, 500) });
        }
      } else {
        return res.status(500).json({ error: 'AI did not return valid JSON', raw: result.substring(0, 500) });
      }
    }

    // Validate and sanitize the task array
    if (!Array.isArray(tasks)) {
      return res.status(500).json({ error: 'AI returned non-array response' });
    }

    const sanitized = tasks.slice(0, 6).map(t => ({
      title: String(t.title || '').substring(0, 100),
      description: String(t.description || '').substring(0, 1000),
      relevantFiles: Array.isArray(t.relevantFiles) ? t.relevantFiles.map(f => String(f)).slice(0, 20) : [],
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(c => String(c)).slice(0, 6) : [],
      branch: String(t.branch || '').replace(/[^a-z0-9-]/gi, '-').substring(0, 60).toLowerCase(),
    })).filter(t => t.title && t.description);

    res.json({
      tasks: sanitized,
      sessionId: req.params.id,
      sessionName: session ? session.name : claudeSessionId,
      filesTouched,
    });
  } catch (err) {
    res.status(500).json({ error: 'Task extraction failed: ' + err.message });
  }
});

/**
 * POST /api/sessions/:id/spinoff-context
 * Generate a rich context package for a spinoff task.
 * Takes a task spec and produces a structured handoff document
 * that gives a fresh Claude session full context to execute the task.
 *
 * Body: { title, description, relevantFiles, acceptanceCriteria, repoDir }
 * Returns: { contextPackage: string } -- a markdown document for the new session
 */
app.post('/api/sessions/:id/spinoff-context', requireAuth, async (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);
  const { title, description, relevantFiles, acceptanceCriteria, repoDir } = req.body || {};

  if (!title || !description) {
    return res.status(400).json({ error: 'title and description are required' });
  }

  const claudeSessionId = (session && session.resumeSessionId) || req.params.id;
  const workingDir = repoDir || (session && session.workingDir) || process.cwd();

  try {
    // Gather file snippets for relevant files (first 80 lines each, max 5 files)
    const fileSnippets = [];
    const filesToRead = (relevantFiles || []).slice(0, 5);
    for (const relPath of filesToRead) {
      try {
        // Try both the path as-is and resolved against workingDir
        let fullPath = path.resolve(workingDir, relPath);
        if (!fs.existsSync(fullPath)) {
          // Try without leading src/ or with different base
          fullPath = relPath;
        }
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          const snippet = lines.slice(0, 80).join('\n');
          const truncated = lines.length > 80 ? `\n... (${lines.length - 80} more lines)` : '';
          fileSnippets.push(`### ${relPath}\n\`\`\`\n${snippet}${truncated}\n\`\`\``);
        }
      } catch { /* skip unreadable files */ }
    }

    // Get project structure (top-level + src/ listing)
    let projectStructure = '';
    try {
      const topLevel = fs.readdirSync(workingDir).filter(f => !f.startsWith('.')).slice(0, 30);
      projectStructure = topLevel.join('\n');
      const srcDir = path.join(workingDir, 'src');
      if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        const srcFiles = fs.readdirSync(srcDir, { withFileTypes: true }).slice(0, 20);
        projectStructure += '\n\nsrc/\n' + srcFiles.map(f => `  ${f.name}${f.isDirectory() ? '/' : ''}`).join('\n');
      }
    } catch { /* best effort */ }

    // Read CLAUDE.md if it exists in the project
    let claudeMd = '';
    try {
      const claudeMdPath = path.join(workingDir, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        claudeMd = content.substring(0, 2000);
      }
    } catch { /* optional */ }

    // Get recent git log for context on what's been changing
    let recentCommits = '';
    try {
      recentCommits = await gitExec(['log', '--oneline', '-10'], workingDir);
    } catch { /* not a git repo or no commits */ }

    // Build the context package markdown
    const pkg = [];
    pkg.push(`# Task: ${title}`);
    pkg.push('');
    pkg.push('## What to Build');
    pkg.push(description);
    pkg.push('');

    if (acceptanceCriteria && acceptanceCriteria.length > 0) {
      pkg.push('## Acceptance Criteria');
      for (const ac of acceptanceCriteria) {
        pkg.push(`- [ ] ${ac}`);
      }
      pkg.push('');
    }

    if (relevantFiles && relevantFiles.length > 0) {
      pkg.push('## Key Files');
      for (const f of relevantFiles) {
        pkg.push(`- \`${f}\``);
      }
      pkg.push('');
    }

    if (fileSnippets.length > 0) {
      pkg.push('## File Context');
      pkg.push(fileSnippets.join('\n\n'));
      pkg.push('');
    }

    if (projectStructure) {
      pkg.push('## Project Structure');
      pkg.push('```');
      pkg.push(projectStructure);
      pkg.push('```');
      pkg.push('');
    }

    if (claudeMd) {
      pkg.push('## Project Instructions (CLAUDE.md)');
      pkg.push(claudeMd);
      pkg.push('');
    }

    if (recentCommits) {
      pkg.push('## Recent Commits');
      pkg.push('```');
      pkg.push(recentCommits.trim());
      pkg.push('```');
      pkg.push('');
    }

    pkg.push('## Constraints');
    pkg.push('- Do NOT modify files outside the scope listed above unless necessary');
    pkg.push('- Keep changes modular -- this is a feature branch that will be merged');
    pkg.push('- Run tests after changes if a test suite exists');
    pkg.push('- Commit your work with descriptive messages');
    pkg.push('');

    const contextPackage = pkg.join('\n');

    res.json({
      contextPackage,
      sessionId: req.params.id,
      title,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate context package: ' + err.message });
  }
});

/**
 * POST /api/sessions/:id/spinoff-batch
 * Create multiple worktree tasks from extracted tasks in one request.
 * Each task gets a worktree, session, and optional context prompt injection.
 * Body: { tasks: Array<{ title, description, relevantFiles, acceptanceCriteria, branch, tags, model }>, repoDir, workspaceId, startImmediately }
 * Returns: { created: Array<{ task, session? }>, errors: Array<{ index, error }> }
 */
app.post('/api/sessions/:id/spinoff-batch', requireAuth, async (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);
  const { tasks, repoDir, workspaceId, startImmediately } = req.body || {};

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'tasks array is required' });
  }
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }

  const dir = repoDir || (session && session.workingDir) || process.cwd();
  const created = [];
  const errors = [];

  // Process tasks sequentially to avoid git conflicts
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const branch = 'feat/' + (t.branch || '').replace(/^feat\//, '');
    const safeTags = Array.isArray(t.tags) ? t.tags.filter(tg => typeof tg === 'string' && tg.length <= 30).slice(0, 10) : [];
    const desc = `${t.title}\n\n${t.description || ''}${t.acceptanceCriteria && t.acceptanceCriteria.length > 0 ? '\n\nAcceptance Criteria:\n' + t.acceptanceCriteria.map(c => '- ' + c).join('\n') : ''}`;

    if (startImmediately) {
      // Create worktree + session immediately
      try {
        const root = await gitRepoRoot(dir);
        if (!root) {
          errors.push({ index: i, error: 'Not a git repository' });
          continue;
        }
        const repoName = path.basename(root);
        const worktreePath = path.join(path.dirname(root), `${repoName}-wt`, branch.replace(/\//g, '-'));

        let branchExists = false;
        try {
          await gitExec(['rev-parse', '--verify', branch], root);
          branchExists = true;
        } catch {}

        const args = ['worktree', 'add'];
        if (!branchExists) args.push('-b', branch);
        args.push(worktreePath);
        if (branchExists) args.push(branch);
        await gitExec(args, root);

        // Run init hooks if configured
        const initHooks = store.getWorktreeInitHooks();
        if (initHooks) {
          if (Array.isArray(initHooks.copy_files)) {
            for (const relPath of initHooks.copy_files) {
              try {
                const src = path.join(root, relPath);
                const dest = path.join(worktreePath, relPath);
                const destDir = path.dirname(dest);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                fs.copyFileSync(src, dest);
              } catch { /* skip */ }
            }
          }
          if (initHooks.init_script && typeof initHooks.init_script === 'string') {
            try {
              const { execSync } = require('child_process');
              execSync(initHooks.init_script, { cwd: worktreePath, timeout: 30000, stdio: 'pipe', windowsHide: true });
            } catch { /* non-fatal */ }
          }
        }

        // Create session
        const sessionName = (t.branch || t.title).replace(/^feat\//, '') + ' (spinoff)';
        const newSession = store.createSession({
          workspaceId,
          name: sessionName,
          workingDir: worktreePath,
          command: 'claude', // gsd:provider-literal-allowed (worktree-task default command; v1.1 back-compat; revisit when worktree-task supports multi-provider)
          model: t.model || undefined,
        });

        // Create worktree task record
        const task = store.createWorktreeTask({
          workspaceId,
          sessionId: newSession ? newSession.id : null,
          branch,
          worktreePath,
          repoDir: root,
          description: desc,
          baseBranch: 'main',
          model: t.model || null,
          tags: safeTags,
        });

        broadcastSSE('worktreeTask:created', { task });
        created.push({ task, session: newSession, index: i });
      } catch (err) {
        errors.push({ index: i, error: err.message });
      }
    } else {
      // Backlog mode -- just create the task record
      try {
        const task = store.createWorktreeTask({
          workspaceId,
          sessionId: null,
          branch,
          worktreePath: null,
          repoDir: dir,
          description: desc,
          baseBranch: 'main',
          model: t.model || null,
          tags: safeTags,
        });
        store.updateWorktreeTask(task.id, { status: 'backlog' });
        broadcastSSE('worktreeTask:created', { task });
        created.push({ task, index: i });
      } catch (err) {
        errors.push({ index: i, error: err.message });
      }
    }
  }

  res.json({ created, errors, total: tasks.length });
});

// ──────────────────────────────────────────────────────────
//  SESSION REFOCUS (DISTILL + RESET/COMPACT)
// ──────────────────────────────────────────────────────────

/**
 * POST /api/sessions/:id/refocus
 * Generates a comprehensive refocus document from the session's conversation,
 * writes it to the session's working directory as .refocus-context.md, and
 * returns the file path + content. The frontend then sends /clear or /compact
 * to the terminal and injects the document back into the session.
 *
 * Request body: { mode: 'reset' | 'compact' }
 * Response: { success, filePath, content, sessionName }
 */
app.post('/api/sessions/:id/refocus', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);
  const mode = req.body.mode;

  if (!mode || (mode !== 'reset' && mode !== 'compact')) {
    return res.status(400).json({ error: 'Invalid mode. Must be "reset" or "compact".' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const claudeSessionId = session.resumeSessionId || req.params.id;
  const sessionName = session.name || claudeSessionId || 'Unknown Session';

  if (!claudeSessionId) {
    return res.status(400).json({ error: 'No Claude session ID available' });
  }

  // Need a working directory to write the refocus file
  const workingDir = session.workingDir;
  if (!workingDir || !fs.existsSync(workingDir)) {
    return res.status(400).json({ error: 'Session has no valid working directory' });
  }

  // Plan 15-01 (DISC-03): dispatch through provider abstraction.
  const provider = getProviderForSession(session);
  const jsonlPath = provider ? provider.findArtifactPath(claudeSessionId) : null;
  if (!jsonlPath) {
    return res.status(404).json({ error: 'No conversation data found. This session may not have an active Claude conversation yet. Start Claude in this terminal first, or try a discovered session.' });
  }

  try {
    const stat = fs.statSync(jsonlPath);
    const fileSize = stat.size;

    // Read more of the conversation than export-context for comprehensive coverage
    // Head: first 50KB for early messages, Tail: last 200KB for recent context
    const headSize = Math.min(50 * 1024, fileSize);
    const tailSize = Math.min(200 * 1024, fileSize);
    const tailOffset = Math.max(0, fileSize - tailSize);

    const fd = fs.openSync(jsonlPath, 'r');

    const headBuf = Buffer.alloc(headSize);
    fs.readSync(fd, headBuf, 0, headSize, 0);

    const tailBuf = Buffer.alloc(tailSize);
    fs.readSync(fd, tailBuf, 0, tailSize, tailOffset);

    fs.closeSync(fd);

    // Parse head messages, collect first 10 user messages
    const headContent = headBuf.toString('utf-8');
    const headLines = headContent.split('\n').filter(l => l.trim());
    const firstUserMessages = [];
    for (const line of headLines) {
      if (firstUserMessages.length >= 10) break;
      const parsed = extractExportMessageText(line);
      if (parsed && parsed.role === 'user') {
        firstUserMessages.push(parsed.text);
      }
    }

    // Parse tail messages, collect last 15 user + last 15 assistant messages
    const tailContent = tailBuf.toString('utf-8');
    const tailLines = tailContent.split('\n').filter(l => l.trim());
    // Drop partial first line if we started mid-file
    if (tailOffset > 0 && tailLines.length > 0) tailLines.shift();

    const lastUserMessages = [];
    const lastAssistantMessages = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const parsed = extractExportMessageText(tailLines[i]);
      if (!parsed) continue;
      if (parsed.role === 'user' && lastUserMessages.length < 15) {
        lastUserMessages.unshift(parsed);
      }
      if (parsed.role === 'assistant' && lastAssistantMessages.length < 15) {
        lastAssistantMessages.unshift(parsed);
      }
      if (lastUserMessages.length >= 15 && lastAssistantMessages.length >= 15) break;
    }

    // Extract file paths from the full conversation (combine head + tail text)
    const allText = [];
    for (const line of headLines) {
      const parsed = extractExportMessageText(line);
      if (parsed) allText.push(parsed.text.substring(0, 2000));
    }
    for (const line of tailLines) {
      const parsed = extractExportMessageText(line);
      if (parsed) allText.push(parsed.text.substring(0, 2000));
    }
    const filesTouched = extractFilePaths(allText.join('\n'));

    // ── Build the structured refocus document ──
    const timestamp = new Date().toISOString();
    const mdParts = [];

    mdParts.push(`# Session Refocus: ${sessionName}`);
    mdParts.push(`_Generated: ${timestamp} | This file will be auto-deleted after ingestion._`);
    mdParts.push('');

    // Project Overview, the original request/goal
    mdParts.push('## Project Overview');
    if (firstUserMessages.length > 0) {
      const overview = firstUserMessages[0].length > 3000
        ? firstUserMessages[0].substring(0, 3000) + '...'
        : firstUserMessages[0];
      mdParts.push(overview);
    } else {
      mdParts.push('_No initial user message found._');
    }
    mdParts.push('');

    // What Was Accomplished, last 3-5 assistant messages summarized
    mdParts.push('## What Was Accomplished');
    if (lastAssistantMessages.length > 0) {
      const workMsgs = lastAssistantMessages.slice(-5);
      for (const msg of workMsgs) {
        const truncated = msg.text.length > 800
          ? msg.text.substring(0, 800).replace(/\s+\S*$/, '') + '...'
          : msg.text;
        mdParts.push(`- ${truncated}`);
      }
    } else {
      mdParts.push('_No assistant messages found._');
    }
    mdParts.push('');

    // Key Decisions & Context, early user follow-ups (decisions, clarifications)
    mdParts.push('## Key Decisions & Context');
    if (firstUserMessages.length > 1) {
      const decisions = firstUserMessages.slice(1, 8);
      for (const msg of decisions) {
        const truncated = msg.length > 600
          ? msg.substring(0, 600).replace(/\s+\S*$/, '') + '...'
          : msg;
        mdParts.push(`- ${truncated}`);
      }
    } else {
      mdParts.push('_No additional context decisions found._');
    }
    mdParts.push('');

    // Files Modified
    mdParts.push('## Files Modified');
    if (filesTouched.length > 0) {
      for (const fp of filesTouched) {
        mdParts.push(`- \`${fp}\``);
      }
    } else {
      mdParts.push('_No file paths detected in conversation._');
    }
    mdParts.push('');

    // Current State, last assistant message
    mdParts.push('## Current State');
    if (lastAssistantMessages.length > 0) {
      const lastMsg = lastAssistantMessages[lastAssistantMessages.length - 1];
      const truncated = lastMsg.text.length > 3000
        ? lastMsg.text.substring(0, 3000).replace(/\s+\S*$/, '') + '...'
        : lastMsg.text;
      mdParts.push(truncated);
    } else {
      mdParts.push('_No assistant messages found._');
    }
    mdParts.push('');

    // Open Issues, scan recent messages for TODO/FIXME/error/issue/bug patterns
    mdParts.push('## Open Issues');
    const issuePatterns = /\b(?:TODO|FIXME|HACK|BUG|ERROR|ISSUE|PROBLEM|BROKEN|FAILING|BLOCKED)\b/i;
    const issues = [];
    for (const msg of [...lastUserMessages, ...lastAssistantMessages].slice(-10)) {
      if (issuePatterns.test(msg.text)) {
        const truncated = msg.text.length > 400
          ? msg.text.substring(0, 400).replace(/\s+\S*$/, '') + '...'
          : msg.text;
        issues.push(`- [${msg.role}] ${truncated}`);
      }
    }
    if (issues.length > 0) {
      mdParts.push(...issues);
    } else {
      mdParts.push('_No explicit issues/TODOs detected in recent messages._');
    }
    mdParts.push('');

    // Next Steps, derived from recent user messages
    mdParts.push('## Next Steps');
    if (lastUserMessages.length > 0) {
      const recentUserMsgs = lastUserMessages.slice(-3);
      for (const msg of recentUserMsgs) {
        const truncated = msg.text.length > 600
          ? msg.text.substring(0, 600).replace(/\s+\S*$/, '') + '...'
          : msg.text;
        mdParts.push(`- ${truncated}`);
      }
    } else {
      mdParts.push('_No recent user instructions found._');
    }
    mdParts.push('');

    // Important Notes, environment info from the session
    mdParts.push('## Important Notes');
    mdParts.push(`- Working directory: \`${workingDir}\``);
    if (session.model) mdParts.push(`- Model: ${session.model}`);
    if (session.command) mdParts.push(`- Command: ${session.command}`);
    mdParts.push(`- Mode used: ${mode === 'reset' ? 'Reset & Refocus' : 'Compact & Refocus'}`);
    mdParts.push('');

    const content = mdParts.join('\n');
    const filePath = path.join(workingDir, '.refocus-context.md');

    // Write the refocus document to the session's working directory
    fs.writeFileSync(filePath, content, 'utf-8');

    return res.json({
      success: true,
      filePath,
      content,
      sessionName,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate refocus document: ' + err.message });
  }
});

/**
 * DELETE /api/refocus-cleanup
 * Cleans up a .refocus-context.md file after ingestion.
 * Only deletes files that end with '.refocus-context.md' for safety.
 *
 * Query param: filePath - absolute path to the file to delete
 */
app.delete('/api/refocus-cleanup', requireAuth, (req, res) => {
  const filePath = req.query.filePath;

  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Missing filePath query parameter' });
  }

  // Safety: only allow deleting .refocus-context.md files
  if (!filePath.endsWith('.refocus-context.md')) {
    return res.status(403).json({ error: 'Can only delete .refocus-context.md files' });
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete refocus file: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  SUBAGENT TRACKING
// ──────────────────────────────────────────────────────────

/** In-memory subagent cache: keyed by sessionId, stores { mtimeMs, timestamp, result } */
const _subagentCache = new Map();
const SUBAGENT_CACHE_TTL_RUNNING = 30000;  // 30 seconds for running sessions
const SUBAGENT_CACHE_TTL_STOPPED = 300000; // 5 minutes for stopped sessions

/**
 * Parse a JSONL file and extract subagent (Task tool) usage information.
 * Scans for assistant messages containing tool_use blocks with name === 'Task',
 * then matches them against tool_result entries to determine completion status.
 * @param {string} jsonlPath - Absolute path to the .jsonl file
 * @returns {object} Subagent data with agents array and summary
 */
function parseSubagents(jsonlPath) {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Maps: toolUseId -> subagent spawn data
  const spawns = new Map();
  // Maps: toolUseId -> tool_result data
  const completions = new Map();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Check for subagent spawns: assistant messages with Task tool_use blocks
      if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name === 'Task' && block.id) {
            const input = block.input || {};
            spawns.set(block.id, {
              id: block.id,
              description: input.description || '(no description)',
              subagentType: input.subagent_type || 'general-purpose',
              background: !!input.run_in_background,
              spawnedAt: entry.timestamp || null,
            });
          }
        }
      }

      // Check for subagent completions: tool_result entries matching a spawn
      if (entry.type === 'tool_result' && entry.tool_use_id) {
        completions.set(entry.tool_use_id, {
          completedAt: entry.timestamp || null,
          content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || ''),
        });
      }
    } catch (_) {
      // Skip malformed lines
    }
  }

  // Build the subagents array
  const subagents = [];
  const byType = {};

  for (const [toolUseId, spawn] of spawns) {
    const completion = completions.get(toolUseId);
    const status = completion ? 'completed' : 'running';
    const resultSnippet = completion
      ? (completion.content.length > 200 ? completion.content.substring(0, 200) : completion.content)
      : null;

    subagents.push({
      id: spawn.id,
      description: spawn.description,
      subagentType: spawn.subagentType,
      background: spawn.background,
      status,
      spawnedAt: spawn.spawnedAt,
      completedAt: completion ? completion.completedAt : null,
      resultSnippet,
    });

    // Count by type for the summary
    byType[spawn.subagentType] = (byType[spawn.subagentType] || 0) + 1;
  }

  const running = subagents.filter(s => s.status === 'running').length;
  const completed = subagents.filter(s => s.status === 'completed').length;

  return {
    subagents,
    summary: {
      total: subagents.length,
      running,
      completed,
      byType,
    },
  };
}

/**
 * GET /api/sessions/:id/subagents
 * Reads the session's JSONL file and extracts subagent (Task tool) usage.
 * Results are cached: 30 seconds for running sessions, 5 minutes for stopped.
 * Protected by auth.
 */
app.get('/api/sessions/:id/subagents', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);

  const resumeSessionId = (session && session.resumeSessionId) || req.params.id;
  if (!resumeSessionId) {
    return res.json({
      sessionId: req.params.id,
      subagents: [],
      summary: { total: 0, running: 0, completed: 0, byType: {} },
    });
  }

  // Plan 15-01 (DISC-03): dispatch through provider abstraction. Falls back
  // to claudeProvider when req.params.id is a direct Claude UUID with no
  // store session record (preserves pre-Phase-15 behavior).
  const provider = getProviderForSession(session) || claudeProvider;
  const jsonlPath = provider.findArtifactPath(resumeSessionId);
  if (!jsonlPath) {
    return res.json({
      sessionId: req.params.id,
      resumeSessionId,
      subagents: [],
      summary: { total: 0, running: 0, completed: 0, byType: {} },
    });
  }

  try {
    // Determine cache TTL based on session status
    const isRunning = session && session.status === 'running';
    const cacheTtl = isRunning ? SUBAGENT_CACHE_TTL_RUNNING : SUBAGENT_CACHE_TTL_STOPPED;

    // Check cache: keyed by resumeSessionId, validated by file mtime and TTL
    const stat = fs.statSync(jsonlPath);
    const mtimeMs = stat.mtimeMs;
    const cached = _subagentCache.get(resumeSessionId);
    const now = Date.now();

    if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < cacheTtl) {
      return res.json(cached.result);
    }

    const subagentData = parseSubagents(jsonlPath);
    const result = {
      sessionId: req.params.id,
      resumeSessionId,
      ...subagentData,
    };

    // Store in cache
    _subagentCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to parse subagents: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  AUTO-DOCS: SESSION SUMMARIZER
// ──────────────────────────────────────────────────────────

/**
 * Generate a short summary of a session from its JSONL data.
 * Extracts first user request and last assistant response,
 * then produces a concise summary line with files modified and tools used.
 * @param {string} jsonlPath - Path to the JSONL file
 * @returns {string} Summary text
 */
function generateSessionSummary(jsonlPath) {
  // Read only the tail (last 200KB) for summary generation to avoid blocking
  // the event loop on large JSONL files. The summary only needs recent context.
  const stat = fs.statSync(jsonlPath);
  const maxRead = 200 * 1024; // 200KB cap
  let content;
  if (stat.size <= maxRead) {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } else {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(maxRead);
      fs.readSync(fd, buf, 0, maxRead, stat.size - maxRead);
      content = buf.toString('utf-8');
      // Find the first complete line (partial line from seeking into the middle)
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) content = content.slice(firstNewline + 1);
    } finally {
      fs.closeSync(fd);
    }
  }
  const lines = content.split('\n').filter(l => l.trim());

  let firstUserMsg = null;
  let lastAssistantMsg = null;
  let toolsUsed = new Set();
  let filesModified = new Set();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Extract first user message (the "task")
      if (entry.type === 'user' || (entry.message && entry.message.role === 'user')) {
        const msg = entry.message || entry;
        const c = msg.content;
        let text = '';
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          text = c.filter(b => b.type === 'text').map(b => b.text).join(' ');
        }
        if (text && text.length > 5 && !text.startsWith('<system-reminder')) {
          if (!firstUserMsg) firstUserMsg = text.substring(0, 200);
        }
      }

      // Extract last assistant message and track tool usage
      if (entry.type === 'assistant' && entry.message) {
        const c = entry.message.content;
        if (Array.isArray(c)) {
          for (const block of c) {
            if (block.type === 'text' && block.text && block.text.length > 10) {
              lastAssistantMsg = block.text.substring(0, 300);
            }
            if (block.type === 'tool_use') {
              toolsUsed.add(block.name);
              // Track file modifications from Edit and Write tools
              if (block.name === 'Edit' || block.name === 'Write') {
                const fp = block.input && (block.input.file_path || block.input.path);
                if (fp) {
                  // Extract just filename for brevity
                  const parts = fp.replace(/\\/g, '/').split('/');
                  filesModified.add(parts[parts.length - 1]);
                }
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // Build summary from extracted data
  const parts = [];

  if (firstUserMsg) {
    // Truncate to first sentence or 100 chars for readability
    let task = firstUserMsg.replace(/[\r\n]+/g, ' ').trim();
    const sentenceEnd = task.search(/[.!?]\s/);
    if (sentenceEnd > 0 && sentenceEnd < 100) task = task.substring(0, sentenceEnd + 1);
    else if (task.length > 100) task = task.substring(0, 100) + '...';
    parts.push(task);
  }

  if (filesModified.size > 0) {
    const fileList = Array.from(filesModified).slice(0, 5);
    parts.push('Files: ' + fileList.join(', '));
  }

  if (toolsUsed.size > 0) {
    // Filter out read-only tools for a cleaner summary
    const tools = Array.from(toolsUsed).filter(t => t !== 'Read' && t !== 'Glob' && t !== 'Grep');
    if (tools.length > 0) {
      parts.push('Tools: ' + tools.slice(0, 4).join(', '));
    }
  }

  return parts.join(' | ') || 'Session completed (no summary available)';
}

/**
 * Generate a summary of a session and append it to its workspace docs.
 *
 * BUILD-CONTRACT P9 (CODEX-PARITY B12). This was an inline handler on a SECOND
 * `POST /api/sessions/:id/summarize` registration. Express serves the first
 * matching route, so it never ran: it was dead code, and the two live callers
 * that wanted its `{summary}` shape, `summarizeSessionToDocs()` in app.js and
 * `summarize()` in the mobile client, always read `data.summary` as undefined
 * and showed "No summary data available".
 *
 * Lifting it into a named function is what makes the dead code reachable
 * WITHOUT deleting the shadowing registration. Three call sites now share it:
 *
 *   - `POST /api/sessions/:id/summarize-to-docs`, its own unshadowed route.
 *   - `POST /api/sessions/:id/summarize` with `{toDocs: true}` or `?toDocs=1`,
 *     delegated from the live handler near the top of this file.
 *   - The original second registration below, retained untouched. It is still
 *     shadowed, and it now points at this same function, so the behaviour it
 *     always described is the behaviour that runs.
 *
 * Note for whoever wires the frontend: the append is opt-in on the shared route
 * on purpose. The modal summariser and this one call the same URL with the same
 * empty body and are otherwise indistinguishable, and a modal that silently
 * writes a note into a user's project docs every time it is opened would be a
 * worse bug than the one being fixed.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
function summarizeSessionToDocsHandler(req, res) {
  const store = getStore();
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const resumeSessionId = session.resumeSessionId || req.params.id;
  // Plan 15-01 (DISC-03): dispatch through provider abstraction.
  const provider = getProviderForSession(session);
  const jsonlPath = provider ? provider.findArtifactPath(resumeSessionId) : null;

  if (!jsonlPath) {
    return res.json({ summary: null, message: 'No JSONL data found' });
  }

  try {
    const summaryText = generateSessionSummary(jsonlPath);
    const fullSummary = `**${session.name}**: ${summaryText}`;

    // Auto-append to workspace docs if session has a workspace
    if (session.workspaceId) {
      const ws = store.getWorkspace(session.workspaceId);
      if (ws) {
        store.addWorkspaceNote(session.workspaceId, fullSummary);
      }
    }

    return res.json({ summary: fullSummary, sessionId: req.params.id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate summary: ' + err.message });
  }
}

/**
 * POST /api/sessions/:id/summarize-to-docs
 *
 * The unshadowed route for the docs summariser. Same handler, same response,
 * reachable by name so a client does not have to know about an opt-in flag on
 * an overloaded path.
 */
app.post('/api/sessions/:id/summarize-to-docs', requireAuth, summarizeSessionToDocsHandler);

/**
 * POST /api/sessions/:id/summarize
 * Manually generate a summary of a session from its JSONL data.
 * Appends the summary as a timestamped note to the session's workspace docs.
 * Returns the generated summary text.
 *
 * RETAINED, and still shadowed by the registration near the top of this file:
 * Express serves the first match, so this line has never executed and still does
 * not. It is kept rather than deleted per the code-preservation rule, and it now
 * references the shared handler above, so the file no longer contains a second
 * copy of the logic that can drift from the copy that runs.
 */
app.post('/api/sessions/:id/summarize', requireAuth, summarizeSessionToDocsHandler);

// ──────────────────────────────────────────────────────────
//  FEATURE TRACKING BOARD
// ──────────────────────────────────────────────────────────

/**
 * GET /api/workspaces/:id/features
 * Returns all features for a workspace.
 */
app.get('/api/workspaces/:id/features', requireAuth, (req, res) => {
  const store = getStore();
  const features = store.listFeatures(req.params.id);
  res.json({ features });
});

/**
 * POST /api/workspaces/:id/features
 * Body: { name, description?, status?, priority?, sessionIds? }
 * Creates a new feature for a workspace.
 */
app.post('/api/workspaces/:id/features', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const { name, description, status, priority, sessionIds } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const feature = store.createFeature({
    workspaceId: req.params.id,
    name: name.trim(),
    description,
    status,
    priority,
    sessionIds: sessionIds || [],
  });

  res.json({ feature });
});

/**
 * PUT /api/features/:id
 * Body: partial feature fields (status, description, priority, name, etc.)
 * Updates a feature (status change, edit, etc.).
 */
app.put('/api/features/:id', requireAuth, (req, res) => {
  const store = getStore();
  const feature = store.updateFeature(req.params.id, req.body || {});
  if (!feature) return res.status(404).json({ error: 'Feature not found' });
  res.json({ feature });
});

/**
 * DELETE /api/features/:id
 * Deletes a feature.
 */
app.delete('/api/features/:id', requireAuth, (req, res) => {
  const store = getStore();
  const success = store.deleteFeature(req.params.id);
  if (!success) return res.status(404).json({ error: 'Feature not found' });
  res.json({ success: true });
});

/**
 * POST /api/features/:id/sessions/:sessionId
 * Links a session to a feature.
 */
app.post('/api/features/:id/sessions/:sessionId', requireAuth, (req, res) => {
  const store = getStore();
  const feature = store.linkSessionToFeature(req.params.id, req.params.sessionId);
  if (!feature) return res.status(404).json({ error: 'Feature not found' });
  res.json({ feature });
});

/**
 * DELETE /api/features/:id/sessions/:sessionId
 * Unlinks a session from a feature.
 */
app.delete('/api/features/:id/sessions/:sessionId', requireAuth, (req, res) => {
  const store = getStore();
  const feature = store.unlinkSessionFromFeature(req.params.id, req.params.sessionId);
  if (!feature) return res.status(404).json({ error: 'Feature not found' });
  res.json({ feature });
});

// ──────────────────────────────────────────────────────────
//  SESSION TEMPLATES
// ──────────────────────────────────────────────────────────

/**
 * GET /api/templates
 * Returns all session templates.
 */
app.get('/api/templates', requireAuth, (req, res) => {
  const store = getStore();
  return res.json({ templates: store.listTemplates() });
});

/**
 * POST /api/templates
 * Body: { name, command?, workingDir?, bypassPermissions?, verbose?, model?, agentTeams? }
 * Creates a new session template.
 */
app.post('/api/templates', requireAuth, (req, res) => {
  const { name, command, workingDir, bypassPermissions, verbose, model, agentTeams } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Template name is required.' });
  }
  if (name.trim().length > 200) {
    return res.status(400).json({ error: 'Template name must be 200 characters or fewer.' });
  }

  // Validate fields that flow into shell commands. Default v1.1 back-compat:
  // claudeProvider.cliBinary (Plan 15-01 replaced the bare provider-name literal).
  const safeCommand = command ? sanitizeCommand(command) : claudeProvider.cliBinary;
  if (command && !safeCommand) {
    return res.status(400).json({ error: 'Invalid command. Must not contain shell metacharacters.' });
  }
  const safeDir = workingDir ? sanitizeWorkingDir(workingDir) : '';
  if (workingDir && !safeDir) {
    return res.status(400).json({ error: 'Invalid working directory path.' });
  }
  const safeModel = model ? sanitizeModel(model) : '';
  if (model && !safeModel) {
    return res.status(400).json({ error: 'Invalid model identifier.' });
  }

  const store = getStore();
  const template = store.createTemplate({
    name: name.trim(),
    command: safeCommand,
    workingDir: safeDir,
    bypassPermissions: bypassPermissions || false,
    verbose: verbose || false,
    model: safeModel,
    agentTeams: agentTeams || false,
  });

  return res.status(201).json({ template });
});

/**
 * DELETE /api/templates/:id
 * Deletes a session template.
 */
app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const store = getStore();
  const deleted = store.deleteTemplate(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: 'Template not found.' });
  }

  return res.json({ success: true });
});

// ──────────────────────────────────────────────────────────
//  PTY Session Control
// ──────────────────────────────────────────────────────────

/**
 * GET /api/pty
 * Lists all active PTY sessions with client counts and status.
 */
app.get('/api/pty', requireAuth, (req, res) => {
  const ptyMgr = getPtyManager();
  if (!ptyMgr) {
    return res.json({ sessions: [] });
  }
  return res.json({ sessions: ptyMgr.listSessions() });
});

/**
 * POST /api/pty/kill-orphaned
 * Kills all PTY sessions that have zero connected WebSocket clients.
 */
app.post('/api/pty/kill-orphaned', requireAuth, (req, res) => {
  const ptyMgr = getPtyManager();
  if (!ptyMgr) {
    return res.json({ killed: 0 });
  }
  const all = ptyMgr.listSessions();
  let killed = 0;
  for (const s of all) {
    if (s.clientCount === 0) {
      ptyMgr.killSession(s.sessionId);
      killed++;
    }
  }
  console.log(`[API] Killed ${killed} orphaned PTY sessions`);
  return res.json({ killed });
});

/**
 * POST /api/pty/:sessionId/kill
 * Kills the PTY process for a session. The session can then be restarted
 * by reconnecting (dropping it into a terminal pane again).
 */
app.post('/api/pty/:sessionId/kill', requireAuth, (req, res) => {
  const ptyMgr = getPtyManager();
  if (!ptyMgr) {
    return res.status(503).json({ error: 'PTY manager not available' });
  }

  const sessionId = decodeURIComponent(req.params.sessionId);
  const session = ptyMgr.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'No active PTY session found' });
  }

  const pid = session.pid;
  const killed = ptyMgr.killSession(sessionId);

  if (killed) {
    console.log(`[API] Killed PTY session ${sessionId} (PID: ${pid})`);
    return res.json({ success: true, pid });
  } else {
    return res.status(500).json({ error: 'Failed to kill session' });
  }
});

// ── Image upload for terminal sessions ──
app.post('/api/pty/:sessionId/upload-image',
  requireAuth,
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: '10mb' }),
  (req, res) => {
    const { sessionId } = req.params;
    const filename = req.headers['x-filename'] || 'image.png';
    const contentType = req.headers['content-type'] || 'image/png';

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No image data received' });
    }

    // Sanitize and save
    const ext = path.extname(filename).toLowerCase() || '.png';
    const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    if (!allowedExts.includes(ext)) {
      return res.status(400).json({ error: 'Unsupported image format' });
    }

    const safeName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    // Save uploads to the data dir (~/.myrlin/uploads/) so paths are stable
    // across npx runs and accessible to Claude Code.
    const { getDataDir } = require('../utils/data-dir');
    const dir = path.join(getDataDir(), 'uploads', sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, safeName);
    fs.writeFileSync(filePath, req.body);

    console.log(`[Upload] Saved image for session ${sessionId}: ${safeName} (${req.body.length} bytes)`);

    res.json({
      path: path.resolve(filePath),
      filename: safeName,
      originalName: filename,
      size: req.body.length,
    });
  }
);


// ──────────────────────────────────────────────────────────
//  SSE - Server-Sent Events for live updates
// ──────────────────────────────────────────────────────────

// Track connected SSE clients: clientId -> { res, token, deviceId, connectedAt, heartbeatInterval }
const sseClients = new Map();
let _sseClientId = 0;

/**
 * Global event types that should always be sent to all connected clients,
 * regardless of any workspace-level filtering (prepared for Plan 11-02).
 */
const GLOBAL_EVENT_TYPES = new Set([
  'settings:updated',
  'group:created',
  'group:updated',
  'group:deleted',
  'workspaces:reordered',
  'workspace:created',
  'discover:refreshed', // Plan 22-03: fs.watch -> broadcast to all SSE clients
  'credentials:changed', // credential switcher: apply/capture/rename/delete
  'credentials:usage',   // credential switcher: usage refresh results
  'credentials:mac',     // credential switcher: Mac inventory sweep results (names/uuids only)
  'provider-accounts:changed', // provider account switchers (e.g. Codex tab): apply/capture/rename/delete
  'provider-accounts:usage',   // provider account switchers: usage refresh results (safe rows only)
]);

/**
 * Dead connection sweep. Runs every 60 seconds to remove SSE clients whose
 * writable stream ended without triggering the close/error events (common
 * when mobile devices lose signal or switch networks).
 */
const _deadClientSweep = setInterval(() => {
  for (const [clientId, client] of sseClients) {
    if (client.res.writableEnded) {
      clearInterval(client.heartbeatInterval);
      sseClients.delete(clientId);
    }
  }
}, 60000);
// Allow the process to exit cleanly without waiting for the sweep timer
if (_deadClientSweep.unref) _deadClientSweep.unref();

/**
 * GET /api/events
 * Server-Sent Events endpoint. Streams store events to the browser.
 * Protected by auth (token passed as query param or header).
 * Accepts optional deviceId query param for device-specific tracking.
 */
app.get('/api/events', (req, res) => {
  // SSE (EventSource) can't set custom headers, so accept token as query param
  const token = req.query.token || null;
  const valid = isValidToken(token);

  if (!valid) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid token required. Pass ?token=<token> query parameter.',
    });
  }

  // Optional deviceId for mobile device tracking
  const deviceId = req.query.deviceId || null;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if proxied

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  // Add client to tracking map with auth token, deviceId, and connection time
  const clientId = ++_sseClientId;
  const clientRecord = { res, token, deviceId, connectedAt: Date.now(), heartbeatInterval: null, subscriptions: null };

  // Load workspace subscriptions for device clients so broadcastSSE can filter.
  // A null value means "no filtering" (receive all). An empty array also means
  // "receive all" per WSUB-04 (only a non-empty array enables filtering).
  if (deviceId) {
    const device = getStore().findDevice(deviceId);
    const subs = device?.workspaceSubscriptions;
    clientRecord.subscriptions = (Array.isArray(subs) && subs.length > 0) ? subs : null;
  }

  sseClients.set(clientId, clientRecord);

  // Per-client heartbeat: sends an SSE comment every 30 seconds to keep the
  // connection alive through proxies and NAT (mobile/cellular). Uses a comment
  // (`: heartbeat`) instead of a data event so EventSource.onmessage does not fire.
  const heartbeatInterval = setInterval(() => {
    if (clientRecord.res.writableEnded) {
      clearInterval(heartbeatInterval);
      sseClients.delete(clientId);
      return;
    }
    try {
      clientRecord.res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeatInterval);
      sseClients.delete(clientId);
    }
  }, 30000);
  // Allow process to exit without waiting for per-client heartbeat timers
  if (heartbeatInterval.unref) heartbeatInterval.unref();
  clientRecord.heartbeatInterval = heartbeatInterval;

  // Clean up on disconnect: clear heartbeat before removing client
  req.on('close', () => {
    clearInterval(sseClients.get(clientId)?.heartbeatInterval);
    sseClients.delete(clientId);
  });

  // Also handle request errors (e.g. aborted connections) to prevent stale client references
  req.on('error', () => {
    clearInterval(sseClients.get(clientId)?.heartbeatInterval);
    sseClients.delete(clientId);
  });
});

/**
 * Broadcast an SSE event to all connected clients, with workspace subscription filtering.
 *
 * Filtering rules:
 *   - GLOBAL_EVENT_TYPES always reach all clients (settings, groups, workspace:created, reorder)
 *   - Events without a workspaceId are sent to all clients (safe default, e.g. template events)
 *   - Clients with null or empty subscriptions receive all events (desktop browser default)
 *   - Clients with a non-empty subscriptions array only receive events whose workspaceId is in the list
 *
 * @param {string} eventType - The event name (e.g. 'workspace:created')
 * @param {object} data - The event payload
 */
function broadcastSSE(eventType, data) {
  const payload = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
  // Send as unnamed event so EventSource.onmessage fires (named events require addEventListener per type)
  const message = `data: ${payload}\n\n`;

  // Issue #10 Phase 3: mirror events are scoped to the devices that opened
  // the mirror key, NEVER global (a busy session's message bursts must not
  // hit every connected client), and deliberately absent from
  // GLOBAL_EVENT_TYPES. Clients that connected without a deviceId can never
  // subscribe to a mirror, so they are skipped outright.
  if (eventType.startsWith('mirror:')) {
    const subs = mirrorService.subscribersOf(data && data.mirrorKey);
    if (subs.size === 0) return;
    for (const [clientId, client] of sseClients) {
      if (client.res.writableEnded) {
        clearInterval(client.heartbeatInterval);
        sseClients.delete(clientId);
        continue;
      }
      if (!client.deviceId || !subs.has(client.deviceId)) continue;
      try {
        client.res.write(message);
      } catch (_) {
        clearInterval(client.heartbeatInterval);
        sseClients.delete(clientId);
      }
    }
    return;
  }

  // Extract workspaceId from event data (various shapes across event types)
  const workspaceId = data?.workspaceId || data?.workspace?.id || data?.id || null;
  const isGlobal = GLOBAL_EVENT_TYPES.has(eventType);

  for (const [clientId, client] of sseClients) {
    // Skip and remove clients whose writable stream has already ended
    if (client.res.writableEnded) {
      clearInterval(client.heartbeatInterval);
      sseClients.delete(clientId);
      continue;
    }

    // Subscription filtering: only applies to non-global, workspace-scoped events
    // when the client has an active subscription list with entries
    if (!isGlobal && workspaceId && client.subscriptions && client.subscriptions.length > 0) {
      if (!client.subscriptions.includes(workspaceId)) continue;
    }

    try {
      client.res.write(message);
    } catch (_) {
      // Client may have disconnected; clean up heartbeat and remove
      clearInterval(client.heartbeatInterval);
      sseClients.delete(clientId);
    }
  }
}

/**
 * Wire up store events to SSE broadcasts.
 * Called once when the server starts.
 */
function attachStoreEvents() {
  const store = getStore();

  const events = [
    'workspace:created',
    'workspace:updated',
    'workspace:deleted',
    'workspace:activated',
    'session:created',
    'session:updated',
    'session:deleted',
    'session:log',
    'settings:updated',
    'group:created',
    'group:updated',
    'group:deleted',
    'workspaces:reordered',
    'docs:updated',
    'template:created',
    'template:deleted',
  ];

  for (const eventName of events) {
    store.on(eventName, (data) => {
      broadcastSSE(eventName, data);
    });
  }
}

// ──────────────────────────────────────────────────────────
//  LAYOUT PERSISTENCE
// ──────────────────────────────────────────────────────────

const LAYOUT_FILE = path.join(getDataDir(), 'layout.json');

/**
 * GET /api/layout
 * Returns the saved terminal pane layout, or an empty object if none saved.
 */
app.get('/api/layout', requireAuth, (req, res) => {
  try {
    if (fs.existsSync(LAYOUT_FILE)) {
      const raw = fs.readFileSync(LAYOUT_FILE, 'utf-8');
      return res.json(JSON.parse(raw));
    }
  } catch (_) {
    // Fall through to default
  }
  return res.json({});
});

/**
 * PUT /api/layout
 * Body: arbitrary layout JSON to persist.
 */
app.put('/api/layout', requireAuth, (req, res) => {
  try {
    const dataDir = getDataDir();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save layout: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  RESOURCE MONITORING
// ──────────────────────────────────────────────────────────

// Track previous CPU times for delta calculation
let _prevCpuTimes = null;
let _prevCpuTimestamp = null;

function getCpuUsagePercent() {
  const cpus = os.cpus();
  const totals = { idle: 0, total: 0 };
  cpus.forEach(cpu => {
    const times = cpu.times;
    totals.idle += times.idle;
    totals.total += times.user + times.nice + times.sys + times.idle + times.irq;
  });

  if (_prevCpuTimes) {
    const idleDiff = totals.idle - _prevCpuTimes.idle;
    const totalDiff = totals.total - _prevCpuTimes.total;
    _prevCpuTimes = totals;
    if (totalDiff === 0) return 0;
    return Math.round((1 - idleDiff / totalDiff) * 1000) / 10;
  }

  _prevCpuTimes = totals;
  return 0; // First call - no delta yet
}

function getProcessMemory(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        // Format: "name","pid","session","session#","mem usage"
        // Mem usage: "123,456 K" or "123 456 K"
        const match = stdout.match(/"([^"]*\sK)"/);
        if (match) {
          const kb = parseInt(match[1].replace(/[\s,\.]/g, ''), 10);
          if (!isNaN(kb)) return resolve(kb / 1024); // Return MB
        }
        resolve(null);
      });
    } else {
      // Linux/macOS: ps -o rss= -p PID → returns RSS in KB
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        const kb = parseInt(stdout.trim(), 10);
        if (!isNaN(kb)) return resolve(kb / 1024);
        resolve(null);
      });
    }
  });
}

function getChildPids(pid) {
  return new Promise((resolve) => {
    const allPids = [pid];
    if (process.platform === 'win32') {
      execFile('wmic', ['process', 'where', `ParentProcessId=${pid}`, 'get', 'ProcessId', '/format:csv'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout) {
          stdout.split('\n').forEach(line => {
            const parts = line.trim().split(',');
            const childPid = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(childPid) && childPid > 0 && childPid !== pid) {
              allPids.push(childPid);
            }
          });
        }
        resolve(allPids);
      });
    } else {
      execFile('pgrep', ['-P', String(pid)], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout) {
          stdout.trim().split('\n').forEach(line => {
            const childPid = parseInt(line.trim(), 10);
            if (!isNaN(childPid) && childPid > 0) allPids.push(childPid);
          });
        }
        resolve(allPids);
      });
    }
  });
}

function getProcessPorts(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      getChildPids(pid).then((allPids) => {
        const pidList = allPids.join(',');
        const psScript = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${pidList}) -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort`;
        execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout.trim()) return resolve([]);
          const ports = [...new Set(
            stdout.trim().split('\n')
              .map(p => parseInt(p.trim(), 10))
              .filter(p => !isNaN(p) && p > 0)
          )].sort((a, b) => a - b);
          resolve(ports);
        });
      });
    } else {
      getChildPids(pid).then((allPids) => {
        const pidArg = allPids.join(',');
        execFile('lsof', ['-i', '-P', '-n', '-a', '-p', pidArg], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout.trim()) return resolve([]);
          const ports = [];
          stdout.split('\n').forEach(line => {
            if (line.includes('LISTEN')) {
              const match = line.match(/:(\d+)\s/);
              if (match) ports.push(parseInt(match[1], 10));
            }
          });
          resolve([...new Set(ports)].sort((a, b) => a - b));
        });
      });
    }
  });
}

// Track per-process CPU times for delta calculation
const _prevProcessCpuTimes = {};

function getProcessStats(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Single WMIC call gets memory + CPU times
      execFile('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'WorkingSetSize,KernelModeTime,UserModeTime', '/format:csv'],
        { timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout.trim()) return resolve({ memoryMB: null, cpuPercent: null });
          const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.startsWith('Node'));
          if (lines.length === 0) return resolve({ memoryMB: null, cpuPercent: null });
          const parts = lines[lines.length - 1].trim().split(',');
          // CSV order: Node, KernelModeTime, UserModeTime, WorkingSetSize
          if (parts.length < 4) return resolve({ memoryMB: null, cpuPercent: null });
          const kernelTime = parseInt(parts[1], 10) || 0; // 100-nanosecond intervals
          const userTime = parseInt(parts[2], 10) || 0;
          const workingSet = parseInt(parts[3], 10) || 0;
          const memoryMB = Math.round(workingSet / 1024 / 1024 * 10) / 10;

          // Calculate CPU% from time delta
          const totalCpuTime = kernelTime + userTime;
          const now = Date.now();
          const prev = _prevProcessCpuTimes[pid];
          let cpuPercent = null;
          if (prev) {
            const timeDelta = (now - prev.timestamp) * 10000; // ms to 100-ns intervals
            if (timeDelta > 0) {
              const cpuDelta = totalCpuTime - prev.totalCpuTime;
              cpuPercent = Math.round((cpuDelta / timeDelta) * 100 * 10) / 10;
              if (cpuPercent < 0) cpuPercent = 0;
              if (cpuPercent > 100 * os.cpus().length) cpuPercent = null; // Sanity check
            }
          }
          _prevProcessCpuTimes[pid] = { totalCpuTime, timestamp: now };

          resolve({ memoryMB, cpuPercent });
        });
    } else {
      // Linux/macOS: use ps to get both RSS and %CPU
      execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve({ memoryMB: null, cpuPercent: null });
        const parts = stdout.trim().split(/\s+/);
        const rss = parseInt(parts[0], 10);
        const cpu = parseFloat(parts[1]);
        resolve({
          memoryMB: !isNaN(rss) ? Math.round(rss / 1024 * 10) / 10 : null,
          cpuPercent: !isNaN(cpu) ? cpu : null,
        });
      });
    }
  });
}

/**
 * GET /api/resources
 * Returns system resource usage and per-Claude-session resource consumption.
 */
app.get('/api/resources', requireAuth, async (req, res) => {
  try {
    const store = getStore();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuUsage = getCpuUsagePercent();

    const system = {
      cpuCount: os.cpus().length,
      cpuUsage,
      totalMemoryMB: Math.round(totalMem / 1024 / 1024),
      freeMemoryMB: Math.round(freeMem / 1024 / 1024),
      usedMemoryMB: Math.round(usedMem / 1024 / 1024),
      uptimeSeconds: Math.round(os.uptime()),
    };

    // Get running Claude sessions and their PIDs
    const allSessions = store.getAllSessionsList ? store.getAllSessionsList() : [];
    const runningSessions = allSessions.filter(s => s.status === 'running' && s.pid);

    // Fetch per-session memory, CPU, and port discovery in parallel
    const claudeSessions = await Promise.all(
      runningSessions.map(async (s) => {
        const [stats, ports] = await Promise.all([
          getProcessStats(s.pid),
          getProcessPorts(s.pid),
        ]);
        // Find workspace name for this session
        const workspaces = store.getAllWorkspacesList();
        const workspace = workspaces.find(w => w.id === s.workspaceId);
        return {
          sessionId: s.id,
          sessionName: s.name || s.id.substring(0, 12),
          workspaceName: workspace ? workspace.name : null,
          workingDir: s.workingDir || null,
          pid: s.pid,
          memoryMB: stats.memoryMB || 0,
          cpuPercent: stats.cpuPercent,
          ports: ports || [],
          status: s.status,
        };
      })
    );

    const totalClaudeMemoryMB = claudeSessions.reduce((sum, s) => sum + (s.memoryMB || 0), 0);
    const totalClaudeCpuPercent = claudeSessions.reduce((sum, s) => sum + (s.cpuPercent || 0), 0);

    res.json({
      system,
      claudeSessions,
      totalClaudeMemoryMB: Math.round(totalClaudeMemoryMB * 10) / 10,
      totalClaudeCpuPercent: Math.round(totalClaudeCpuPercent * 10) / 10,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get resources: ' + err.message });
  }
});

/**
 * POST /api/resources/kill-process
 * Sends SIGTERM to a process by PID. For advanced users who want to kill
 * a child process from the Resources view.
 */
app.post('/api/resources/kill-process', requireAuth, (req, res) => {
  const { pid } = req.body;
  if (!pid || typeof pid !== 'number') {
    return res.status(400).json({ error: 'pid is required and must be a number' });
  }
  try {
    process.kill(pid, 'SIGTERM');
    res.json({ success: true, message: `Sent SIGTERM to PID ${pid}` });
  } catch (err) {
    res.status(500).json({ error: `Failed to kill PID ${pid}: ${err.message}` });
  }
});

// ──────────────────────────────────────────────────────────
//  GIT OPERATIONS
// ──────────────────────────────────────────────────────────

/**
 * Maximum number of concurrent git child processes.
 * Prevents resource exhaustion when frontend polls many sessions at once.
 */
const GIT_MAX_CONCURRENT = 3;
let gitRunning = 0;
const gitQueue = [];

// Short-TTL cache for `git status --porcelain`, used by the workspace
// conflict endpoint below. WHY: the frontend polls conflicts on a timer;
// without a cache every poll re-spawned one git process per running
// session. Entries are keyed by resolved repo path, expire after
// GIT_CONFLICT_CACHE_TTL_MS, and are invalidated eagerly whenever a
// mutating git command for the same path flows through gitExec.
const { createGitStatusCache } = require('./git-status-cache');
const conflictGitStatusCache = createGitStatusCache();

/**
 * Execute a git command with concurrency limiting.
 * At most GIT_MAX_CONCURRENT git processes run simultaneously;
 * additional calls are queued and drained in FIFO order.
 * @param {string[]} args - git subcommand and arguments
 * @param {string} cwd - working directory for the git command
 * @returns {Promise<string>} stdout from the git process
 */
function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    const run = () => {
      gitRunning++;
      // A mutating git command makes any cached `status --porcelain` for
      // this repo path stale; drop it eagerly so the conflict endpoint
      // never serves pre-mutation state (TTL alone could lag ~15s).
      conflictGitStatusCache.invalidateIfMutating(args, cwd);
      // windowsHide keeps each git spawn from flashing an OpenConsole/conhost
      // window on Windows (with Windows Terminal as the default console host a
      // windowless parent otherwise pops a visible terminal per spawn). This is
      // the source-level guarantee so no git call, on any code path, ever pops
      // a terminal, independent of how often callers poll.
      execFile('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        gitRunning--;
        // Drain next queued command if any
        const next = gitQueue.shift();
        if (next) next();
        if (err) {
          const msg = (stderr || err.message || '').trim();
          return reject(new Error(msg || 'git command failed'));
        }
        resolve(stdout);
      });
    };
    if (gitRunning < GIT_MAX_CONCURRENT) {
      run();
    } else {
      gitQueue.push(run);
    }
  });
}

// ─── Server-side git status cache ─────────────────────────
// Prevents OOM from excessive child process spawning when the
// frontend polls git status for every visible session.
const GIT_STATUS_CACHE_TTL = 15000; // 15 seconds
const gitStatusCache = new Map();

// Evict stale entries every 60 seconds to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of gitStatusCache) {
    if (now - entry.ts > GIT_STATUS_CACHE_TTL * 2) {
      gitStatusCache.delete(key);
    }
  }
}, 60000).unref();

async function gitRepoRoot(dir) {
  try {
    const root = await gitExec(['rev-parse', '--show-toplevel'], dir);
    return root.trim();
  } catch {
    return null;
  }
}

app.get('/api/git/status', requireAuth, async (req, res) => {
  let dir = req.query.dir;
  if (!dir && req.query.workspaceId) {
    dir = resolveWorkspaceDir(getStore(), req.query.workspaceId);
  }
  if (!dir) return res.status(400).json({ error: 'dir query parameter required' });

  // Return cached result if fresh enough
  const cached = gitStatusCache.get(dir);
  if (cached && Date.now() - cached.ts < GIT_STATUS_CACHE_TTL) {
    return res.json(cached.data);
  }

  // Validate directory exists before spawning git processes
  const fs = require('fs');
  if (!fs.existsSync(dir)) {
    const result = { isGitRepo: false };
    gitStatusCache.set(dir, { data: result, ts: Date.now() });
    return res.json(result);
  }

  try {
    const root = await gitRepoRoot(dir);
    if (!root) {
      const result = { isGitRepo: false };
      gitStatusCache.set(dir, { data: result, ts: Date.now() });
      return res.json(result);
    }
    const branch = (await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
    let dirty = false;
    try {
      const status = await gitExec(['status', '--porcelain'], dir);
      dirty = status.trim().length > 0;
    } catch {}
    let remote = null;
    try {
      remote = (await gitExec(['rev-parse', '--abbrev-ref', '@{upstream}'], dir)).trim();
    } catch {}
    let ahead = 0, behind = 0;
    if (remote) {
      try {
        const counts = (await gitExec(['rev-list', '--left-right', '--count', `HEAD...${remote}`], dir)).trim();
        const [a, b] = counts.split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch {}
    }
    const result = { isGitRepo: true, repoRoot: root, branch, dirty, remote, ahead, behind };
    gitStatusCache.set(dir, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/git/branches', requireAuth, async (req, res) => {
  let dir = req.query.dir;
  if (!dir && req.query.workspaceId) {
    dir = resolveWorkspaceDir(getStore(), req.query.workspaceId);
  }
  if (!dir) return res.status(400).json({ error: 'dir query parameter required' });
  try {
    const root = await gitRepoRoot(dir);
    if (!root) return res.status(400).json({ error: 'Not a git repository' });
    const localRaw = await gitExec(['branch', '--format=%(refname:short)'], dir);
    const local = localRaw.trim().split('\n').filter(Boolean);
    let remote = [];
    try {
      const remoteRaw = await gitExec(['branch', '-r', '--format=%(refname:short)'], dir);
      remote = remoteRaw.trim().split('\n').filter(Boolean);
    } catch {}
    const current = (await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
    res.json({ local, remote, current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/git/worktrees', requireAuth, async (req, res) => {
  const dir = req.query.dir;
  if (!dir) return res.status(400).json({ error: 'dir query parameter required' });
  try {
    const root = await gitRepoRoot(dir);
    if (!root) return res.status(400).json({ error: 'Not a git repository' });
    const raw = await gitExec(['worktree', 'list', '--porcelain'], root);
    const worktrees = [];
    let current = {};
    raw.split('\n').forEach(line => {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.substring(9).trim() };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.substring(5).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7).trim().replace('refs/heads/', '');
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === 'detached') {
        current.detached = true;
      } else if (line.trim() === '') {
        if (current.path) worktrees.push(current);
        current = {};
      }
    });
    if (current.path) worktrees.push(current);
    res.json({ repoRoot: root, worktrees });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/git/worktrees', requireAuth, async (req, res) => {
  const { repoDir, branch, path: wtPath } = req.body || {};
  if (!repoDir) return res.status(400).json({ error: 'repoDir is required' });
  if (!branch) return res.status(400).json({ error: 'branch is required' });
  try {
    const root = await gitRepoRoot(repoDir);
    if (!root) return res.status(400).json({ error: 'Not a git repository' });
    const repoName = path.basename(root);
    const targetPath = wtPath || path.join(path.dirname(root), `${repoName}-wt`, branch.replace(/\//g, '-'));
    let branchExists = false;
    try {
      await gitExec(['rev-parse', '--verify', branch], root);
      branchExists = true;
    } catch {}
    const args = ['worktree', 'add'];
    if (!branchExists) {
      args.push('-b', branch);
    }
    args.push(targetPath);
    if (branchExists) {
      args.push(branch);
    }
    await gitExec(args, root);
    res.status(201).json({ success: true, path: targetPath, branch, repoRoot: root });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/git/worktrees', requireAuth, async (req, res) => {
  const { path: wtPath } = req.body || {};
  if (!wtPath) return res.status(400).json({ error: 'path is required' });
  try {
    const root = await gitRepoRoot(wtPath);
    if (!root) return res.status(400).json({ error: 'Not a git worktree' });
    await gitExec(['worktree', 'remove', wtPath], root);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  WORKTREE TASKS
// ──────────────────────────────────────────────────────────

/**
 * GET /api/worktree-tasks
 * List all worktree tasks, optionally filtered by workspaceId.
 */
app.get('/api/worktree-tasks', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks(req.query.workspaceId || undefined);

  // Enrich tasks with git branch info (commits ahead, changed file count)
  const enriched = await Promise.all(tasks.map(async (task) => {
    const info = { ...task, branchAhead: 0, changedFiles: 0 };
    if (!task.worktreePath || !task.branch) return info;
    try {
      const base = task.baseBranch || 'main';
      // Count commits ahead of base branch
      const ahead = await new Promise((resolve) => {
        const p = require('child_process').execFile('git', ['rev-list', '--count', `${base}..${task.branch}`], { cwd: task.worktreePath, timeout: 5000, windowsHide: true }, (err, stdout) => {
          resolve(err ? 0 : parseInt(stdout.trim(), 10) || 0);
        });
      });
      info.branchAhead = ahead;
      // Count changed files (uncommitted + committed vs base)
      const changed = await new Promise((resolve) => {
        require('child_process').execFile('git', ['diff', '--name-only', base], { cwd: task.worktreePath, timeout: 5000, windowsHide: true }, (err, stdout) => {
          resolve(err ? 0 : stdout.trim().split('\n').filter(Boolean).length);
        });
      });
      info.changedFiles = changed;
    } catch (_) { /* git info is best-effort */ }
    return info;
  }));

  res.json({ tasks: enriched });
});

/**
 * POST /api/worktree-tasks
 * Create a worktree task: creates git worktree, session, and task record.
 */
app.post('/api/worktree-tasks', requireAuth, async (req, res) => {
  const { workspaceId, repoDir, branch, description, baseBranch, featureId, model, tags, startNow, prompt, flags } = req.body || {};
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
  if (!repoDir) return res.status(400).json({ error: 'repoDir is required' });
  if (!branch) return res.status(400).json({ error: 'branch is required' });
  if (!description) return res.status(400).json({ error: 'description is required' });

  // Validate tags: must be array of short strings
  const safeTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.length <= 30).slice(0, 10) : [];

  const store = getStore();

  // Backlog mode: create task record without worktree or session
  if (startNow === false) {
    try {
      const task = store.createWorktreeTask({
        workspaceId,
        sessionId: null,
        branch,
        worktreePath: null,
        repoDir: repoDir,
        description,
        baseBranch: baseBranch || 'main',
        featureId: featureId || null,
        model: model || null,
        tags: safeTags,
      });
      // Override status to backlog (createWorktreeTask defaults to running)
      store.updateWorktreeTask(task.id, { status: 'backlog' });
      broadcastSSE('worktreeTask:created', { task });
      return res.status(201).json({ task });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    // 1. Create the git worktree
    const root = await gitRepoRoot(repoDir);
    if (!root) return res.status(400).json({ error: 'Not a git repository' });
    const repoName = path.basename(root);
    let worktreePath = path.join(path.dirname(root), `${repoName}-wt`, branch.replace(/\//g, '-'));

    let branchExists = false;
    try {
      await gitExec(['rev-parse', '--verify', branch], root);
      branchExists = true;
    } catch {}

    // Check existing worktrees to avoid two fatal git errors:
    //   1. "already exists", target path is already a registered worktree
    //   2. "already checked out", the branch is checked out in a different worktree
    // Parse `git worktree list --porcelain` once and handle both cases.
    let skipWorktreeAdd = false;
    try {
      const listOut = await gitExec(['worktree', 'list', '--porcelain'], root);

      // Case 1: exact path already registered, reuse it as-is
      if (listOut.includes(`worktree ${worktreePath}`)) {
        skipWorktreeAdd = true;
      }

      // Case 2: branch already checked out in a *different* worktree path, // redirect worktreePath to that existing location so the rest of task
      // creation (session, record) still succeeds pointing at the right dir.
      if (!skipWorktreeAdd) {
        const branchRef = `refs/heads/${branch}`;
        const blocks = listOut.split('\n\n').filter(Boolean);
        for (const block of blocks) {
          const pathMatch = block.match(/^worktree (.+)$/m);
          const branchMatch = block.match(/^branch (.+)$/m);
          if (pathMatch && branchMatch && branchMatch[1].trim() === branchRef) {
            worktreePath = pathMatch[1].trim();
            skipWorktreeAdd = true;
            break;
          }
        }
      }
    } catch {}

    if (!skipWorktreeAdd) {
      const args = ['worktree', 'add'];
      if (!branchExists) args.push('-b', branch);
      args.push(worktreePath);
      if (branchExists) args.push(branch);
      await gitExec(args, root);
    }

    // 1.5. Run init hooks (copy_files and init_script) if configured
    const initHooks = store.getWorktreeInitHooks();
    if (initHooks) {
      // copy_files: array of relative paths to copy from repo root to worktree
      if (Array.isArray(initHooks.copy_files)) {
        for (const relPath of initHooks.copy_files) {
          const src = path.join(root, relPath);
          const dest = path.join(worktreePath, relPath);
          try {
            const destDir = path.dirname(dest);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(src, dest);
          } catch (e) {
            console.error(`[init-hook] Failed to copy ${relPath}: ${e.message}`);
          }
        }
      }
      // init_script: shell command to run in the worktree directory
      if (initHooks.init_script && typeof initHooks.init_script === 'string') {
        try {
          const { execSync } = require('child_process');
          execSync(initHooks.init_script, {
            cwd: worktreePath,
            timeout: 30000,
            stdio: 'pipe',
            windowsHide: true,
          });
        } catch (e) {
          console.error(`[init-hook] init_script failed: ${e.message}`);
        }
      }
    }

    // 2. Create a session in this workspace pointing at the worktree
    const sessionName = branch.replace(/^feat\//, '') + ' (worktree task)';
    const safePrompt = (typeof prompt === 'string' && prompt.trim()) ? prompt.trim() : null;
    const safeFlags = Array.isArray(flags) ? flags.filter(f => typeof f === 'string' && /^[a-zA-Z0-9-]+$/.test(f)) : [];
    const session = store.createSession({
      workspaceId,
      name: sessionName,
      workingDir: worktreePath,
      command: 'claude', // gsd:provider-literal-allowed (worktree-session default command; v1.1 back-compat; revisit when worktree-session supports multi-provider)
      model: model || undefined,
      initialPrompt: safePrompt,
      flags: safeFlags,
    });
    if (!session) {
      return res.status(500).json({ error: 'Failed to create session' });
    }

    // 3. Create the worktree task record
    const task = store.createWorktreeTask({
      workspaceId,
      sessionId: session.id,
      branch,
      worktreePath,
      repoDir: root,
      description,
      baseBranch: baseBranch || 'main',
      featureId: featureId || null,
      model: model || null,
      tags: safeTags,
    });

    broadcastSSE('worktreeTask:created', { task });
    res.status(201).json({ task, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/worktree-tasks/:id
 * Update a worktree task's status or other fields.
 */
app.put('/api/worktree-tasks/:id', requireAuth, (req, res) => {
  const store = getStore();
  const updates = { ...req.body };
  // Validate tags if provided
  if (updates.tags !== undefined) {
    updates.tags = Array.isArray(updates.tags) ? updates.tags.filter(t => typeof t === 'string' && t.length <= 30).slice(0, 10) : [];
  }
  // Validate model if provided
  if (updates.model !== undefined) {
    const safe = sanitizeModel(updates.model);
    if (!safe && updates.model) return res.status(400).json({ error: 'Invalid model identifier.' });
    updates.model = safe || null;
  }
  const task = store.updateWorktreeTask(req.params.id, updates);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });
  broadcastSSE('worktreeTask:updated', { task });
  res.json({ task });
});

/**
 * POST /api/worktree-tasks/:id/merge
 * Merge the worktree branch back to the base branch, cleanup worktree and branch.
 * Accepts optional body: { squash, commitMessage, pushToRemote }
 */
app.post('/api/worktree-tasks/:id/merge', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });
  if (task.status !== 'review') return res.status(400).json({ error: 'Task must be in review status to merge' });

  const { squash, commitMessage, pushToRemote } = req.body || {};

  try {
    const repoDir = task.repoDir;
    const baseBranch = task.baseBranch || 'main';
    const defaultMsg = `Merge worktree task: ${task.description}`;
    const msg = commitMessage && commitMessage.trim() ? commitMessage.trim() : defaultMsg;

    // Checkout base branch
    await gitExec(['checkout', baseBranch], repoDir);

    if (squash) {
      // Squash merge: combines all commits into one
      await gitExec(['merge', '--squash', task.branch], repoDir);
      await gitExec(['commit', '-m', msg], repoDir);
    } else {
      // Regular merge with no-ff for clean history
      await gitExec(['merge', '--no-ff', '-m', msg, task.branch], repoDir);
    }

    // Push to remote if requested
    let pushed = false;
    if (pushToRemote) {
      try {
        await gitExec(['push'], repoDir);
        pushed = true;
      } catch { /* push failure is non-fatal */ }
    }

    // Remove worktree
    try { await gitExec(['worktree', 'remove', task.worktreePath], repoDir); } catch { /* may already be removed */ }
    // Delete branch (force if squash since -d may not recognize merge)
    try { await gitExec(['branch', squash ? '-D' : '-d', task.branch], repoDir); } catch { /* branch may not exist */ }

    // Update task status
    store.updateWorktreeTask(task.id, { status: 'merged', completedAt: new Date().toISOString() });

    // If linked to a feature, mark it done
    if (task.featureId) {
      store.updateFeature(task.featureId, { status: 'done' });
    }

    broadcastSSE('worktreeTask:updated', { task: store.getWorktreeTasks().find(t => t.id === task.id) });
    res.json({ success: true, message: `Merged ${task.branch} into ${baseBranch}${pushed ? ' and pushed' : ''}`, pushed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/worktree-tasks/:id/push
 * Push the worktree branch to remote (for PR workflows).
 */
app.post('/api/worktree-tasks/:id/push', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  try {
    await gitExec(['push', '-u', 'origin', task.branch], task.worktreePath || task.repoDir);
    res.json({ success: true, message: `Pushed ${task.branch} to origin` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/worktree-tasks/:id/reject
 * Reject the task: delete worktree, mark as rejected.
 */
app.post('/api/worktree-tasks/:id/reject', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  try {
    // Remove worktree
    try { await gitExec(['worktree', 'remove', '--force', task.worktreePath], task.repoDir); } catch { /* may already be removed */ }
    // Delete branch
    try { await gitExec(['branch', '-D', task.branch], task.repoDir); } catch { /* may not exist */ }

    store.updateWorktreeTask(task.id, { status: 'rejected', completedAt: new Date().toISOString() });
    broadcastSSE('worktreeTask:updated', { task: store.getWorktreeTasks().find(t => t.id === task.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/worktree-tasks/:id
 * Delete a worktree task record (cleanup only, does not touch git).
 */
app.delete('/api/worktree-tasks/:id', requireAuth, (req, res) => {
  const store = getStore();
  const deleted = store.deleteWorktreeTask(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Worktree task not found' });
  broadcastSSE('worktreeTask:deleted', { id: req.params.id });
  res.json({ success: true });
});

/**
 * GET /api/worktree-init-hooks
 * Get the current worktree init hooks configuration.
 */
app.get('/api/worktree-init-hooks', requireAuth, (req, res) => {
  const store = getStore();
  res.json({ hooks: store.getWorktreeInitHooks() || { copy_files: [], init_script: '' } });
});

/**
 * PUT /api/worktree-init-hooks
 * Update worktree init hooks configuration.
 * Body: { copy_files: string[], init_script: string }
 */
app.put('/api/worktree-init-hooks', requireAuth, (req, res) => {
  const store = getStore();
  const { copy_files, init_script } = req.body || {};
  store.setWorktreeInitHooks({
    copy_files: Array.isArray(copy_files) ? copy_files : [],
    init_script: typeof init_script === 'string' ? init_script : '',
  });
  res.json({ success: true });
});

// ─── GitHub CLI helper ───────────────────────────────────
/**
 * Execute a `gh` CLI command with given args in the specified cwd.
 * @param {string[]} args - Arguments for the gh command
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} stdout
 */
function ghExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout: 30000, maxBuffer: 1024 * 512, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        return reject(new Error(msg || 'gh command failed'));
      }
      resolve(stdout);
    });
  });
}

/**
 * POST /api/worktree-tasks/:id/pr
 * Create a GitHub pull request for the task's branch.
 * Body: { title, body, baseBranch, draft, labels }
 */
app.post('/api/worktree-tasks/:id/pr', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  // Don't create if PR already exists
  if (task.pr && task.pr.url) {
    return res.status(400).json({ error: 'PR already exists', pr: task.pr });
  }

  const { title, body, baseBranch, draft, labels } = req.body || {};
  const prTitle = (title || '').trim() || task.description || task.branch;
  const prBody = (body || '').trim() || '';
  const base = (baseBranch || '').trim() || task.baseBranch || 'main';

  try {
    // Ensure branch is pushed
    const taskCwd = task.worktreePath || task.repoDir;
    try {
      await gitExec(['push', '-u', 'origin', task.branch], taskCwd);
    } catch { /* may already be pushed */ }

    // Build gh pr create command
    const ghArgs = ['pr', 'create', '--title', prTitle, '--head', task.branch, '--base', base];
    if (prBody) ghArgs.push('--body', prBody);
    if (draft) ghArgs.push('--draft');
    if (Array.isArray(labels) && labels.length > 0) {
      for (const label of labels) ghArgs.push('--label', label);
    }

    const output = await ghExec(ghArgs, task.repoDir);
    // gh pr create returns the PR URL on stdout
    const prUrl = output.trim();

    // Extract PR number from URL (e.g. https://github.com/org/repo/pull/42)
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

    // Store PR metadata on the task
    const prData = {
      url: prUrl,
      number: prNumber,
      state: draft ? 'draft' : 'open',
      title: prTitle,
      createdAt: new Date().toISOString(),
    };
    store.updateWorktreeTask(task.id, { pr: prData });

    broadcastSSE('worktreeTask:updated', { task: store.getWorktreeTasks().find(t => t.id === task.id) });
    res.status(201).json({ pr: prData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/worktree-tasks/:id/pr
 * Get the current PR status for a task. Refreshes state from GitHub.
 */
app.get('/api/worktree-tasks/:id/pr', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  if (!task.pr || !task.pr.number) {
    return res.json({ pr: null });
  }

  try {
    // Fetch PR status from GitHub
    const output = await ghExec(
      ['pr', 'view', String(task.pr.number), '--json', 'state,title,url,isDraft,reviewDecision,additions,deletions,changedFiles'],
      task.repoDir
    );
    const prInfo = JSON.parse(output);

    // Map GitHub state to our state
    let state = 'open';
    if (prInfo.state === 'MERGED') state = 'merged';
    else if (prInfo.state === 'CLOSED') state = 'closed';
    else if (prInfo.isDraft) state = 'draft';

    const prData = {
      ...task.pr,
      state,
      title: prInfo.title || task.pr.title,
      url: prInfo.url || task.pr.url,
      reviewDecision: prInfo.reviewDecision || null,
      additions: prInfo.additions,
      deletions: prInfo.deletions,
      changedFiles: prInfo.changedFiles,
    };

    // Update stored state if changed
    if (state !== task.pr.state || prInfo.reviewDecision !== task.pr.reviewDecision) {
      store.updateWorktreeTask(task.id, { pr: prData });
      broadcastSSE('worktreeTask:updated', { task: store.getWorktreeTasks().find(t => t.id === task.id) });

      // Auto-advance to completed if PR was merged
      if (state === 'merged' && task.status !== 'completed' && task.status !== 'merged') {
        store.updateWorktreeTask(task.id, { status: 'completed', completedAt: new Date().toISOString() });
        broadcastSSE('worktreeTask:updated', { task: store.getWorktreeTasks().find(t => t.id === task.id) });
      }
    }

    res.json({ pr: prData });
  } catch (err) {
    // gh CLI not installed or not authenticated -- return stored data
    res.json({ pr: task.pr, error: err.message });
  }
});

/**
 * POST /api/worktree-tasks/:id/pr/generate-description
 * Generate a PR description from the diff using Claude --print.
 */
app.post('/api/worktree-tasks/:id/pr/generate-description', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  try {
    const base = task.baseBranch || 'main';
    const taskCwd = task.worktreePath || task.repoDir;

    // Get the diff summary
    let diffSummary = '';
    try {
      diffSummary = await gitExec(['diff', '--stat', `${base}...${task.branch}`], taskCwd);
    } catch { /* branch may not have diverged */ }

    let commitLog = '';
    try {
      commitLog = await gitExec(['log', '--oneline', `${base}..${task.branch}`], taskCwd);
    } catch { /* no commits yet */ }

    // Use Claude --print for non-interactive description generation
    const prompt = `Generate a concise GitHub pull request description in markdown for the following changes.
Branch: ${task.branch}
Base: ${base}
Description: ${task.description || 'No description'}

Commits:
${commitLog || 'No commits yet'}

Diff summary:
${diffSummary || 'No changes'}

Format: Start with a ## Summary section with 2-3 bullet points, then a ## Changes section. Keep it under 300 words. Do not include a title line.`;

    const cliPath = resolveClaudeCli();
    if (!cliPath) {
      return res.status(400).json({ error: 'Claude CLI not found. Install it (npm install -g @anthropic-ai/claude-code) or make sure it is on your PATH.' });
    }
    const description = await new Promise((resolve, reject) => {
      execFile(cliPath, ['--print', '-p', prompt], {
        cwd: taskCwd,
        timeout: 60000,
        maxBuffer: 1024 * 256,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) return reject(new Error('PR description generation failed: ' + (err.message || 'unknown error')));
        resolve(stdout.trim());
      });
    });

    res.json({ description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/worktree-tasks/:id/changes
 * List changed files between the worktree branch and its base branch.
 * Returns per-file additions, deletions, and status (A/M/D/R).
 */
app.get('/api/worktree-tasks/:id/changes', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  try {
    const base = task.baseBranch || 'main';
    const range = `${base}...${task.branch}`;

    // Get per-file additions/deletions counts
    const numstat = await gitExec(['diff', '--numstat', range], task.repoDir);
    // Get per-file status (Added/Modified/Deleted/Renamed)
    const nameStatus = await gitExec(['diff', '--name-status', range], task.repoDir);

    // Parse --name-status into { path: status } map
    const statusMap = {};
    nameStatus.trim().split('\n').filter(Boolean).forEach(line => {
      const parts = line.split('\t');
      const statusCode = parts[0].charAt(0); // M, A, D, R, C
      const filePath = parts.length > 2 ? parts[2] : parts[1]; // renamed: old → new
      const oldPath = parts.length > 2 ? parts[1] : undefined;
      statusMap[filePath] = { status: statusCode, oldPath };
    });

    // Parse --numstat into file objects
    const files = numstat.trim().split('\n').filter(Boolean).map(line => {
      const [addStr, delStr, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t'); // handles paths with tabs (rare)
      const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
      const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
      const info = statusMap[filePath] || { status: 'M' };
      return {
        path: filePath,
        additions,
        deletions,
        status: info.status,
        oldPath: info.oldPath || undefined,
      };
    });

    res.json({ files });
  } catch (err) {
    if (err.message.includes('unknown revision')) {
      // Branch may not have diverged yet
      res.json({ files: [] });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * POST /api/worktree-tasks/:id/diff
 * Get the diff between the worktree branch and its base branch.
 * Optional body.file to get diff for a single file.
 */
app.post('/api/worktree-tasks/:id/diff', requireAuth, async (req, res) => {
  const store = getStore();
  const tasks = store.getWorktreeTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Worktree task not found' });

  try {
    const base = task.baseBranch || 'main';
    const range = `${base}...${task.branch}`;
    const { file } = req.body || {};

    if (file) {
      // Single file diff
      const fileDiff = await gitExec(['diff', range, '--', file], task.repoDir);
      res.json({ diff: fileDiff.trim(), file });
    } else {
      // Full diff with stat summary
      const stat = await gitExec(['diff', '--stat', range], task.repoDir);
      const fullDiff = await gitExec(['diff', range], task.repoDir);
      res.json({ stat: stat.trim(), diff: fullDiff.trim() });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  SELF-UPDATE
// ──────────────────────────────────────────────────────────

app.get('/api/version', requireAuth, async (req, res) => {
  try {
    const pkg = require('../../package.json');
    const currentVersion = pkg.version;

    // Check git for updates
    const appDir = path.resolve(__dirname, '..', '..');
    let updateAvailable = false;
    let remoteVersion = currentVersion;
    let commitsBehind = 0;

    if (!HERMETIC_UI_TEST) {
      try {
        // Fetch latest from remote
        execSync('git fetch origin main --quiet', { cwd: appDir, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        // Check how many commits behind
        const behindOutput = execSync('git rev-list HEAD..origin/main --count', { cwd: appDir, timeout: 5000, encoding: 'utf-8', windowsHide: true }).trim();
        commitsBehind = parseInt(behindOutput, 10) || 0;
        updateAvailable = commitsBehind > 0;

        // Get the latest commit message from remote
        if (updateAvailable) {
          const latestMsg = execSync('git log origin/main -1 --format=%s', { cwd: appDir, timeout: 5000, encoding: 'utf-8', windowsHide: true }).trim();
          remoteVersion = `${currentVersion}+${commitsBehind}`;
        }
      } catch (_) {
        // Git operations may fail if not a git repo or no network
      }
    }

    res.json({
      version: currentVersion,
      updateAvailable,
      commitsBehind,
      remoteVersion,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check version: ' + err.message });
  }
});

app.post('/api/update', requireAuth, async (req, res) => {
  if (HERMETIC_UI_TEST) {
    return res.status(503).json({ error: 'Self-update is disabled in hermetic UI tests' });
  }
  const appDir = path.resolve(__dirname, '..', '..');

  // Use chunked transfer to stream progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const sendStep = (step, status, detail) => {
    res.write(JSON.stringify({ step, status, detail, timestamp: Date.now() }) + '\n');
  };

  try {
    // Step 1: Git pull
    sendStep('pull', 'running', 'Pulling latest changes from origin/main...');
    try {
      const pullOutput = execSync('git pull origin main', { cwd: appDir, timeout: 30000, encoding: 'utf-8' });
      sendStep('pull', 'done', pullOutput.trim().substring(0, 200));
    } catch (err) {
      sendStep('pull', 'error', (err.stderr || err.message || '').substring(0, 200));
      res.end();
      return;
    }

    // Step 2: npm install (in case dependencies changed)
    sendStep('install', 'running', 'Installing dependencies...');
    try {
      const installOutput = execSync('npm install --production', { cwd: appDir, timeout: 120000, encoding: 'utf-8', windowsHide: true });
      // Count packages
      const match = installOutput.match(/added (\d+)/);
      const detail = match ? `Installed ${match[1]} new packages` : 'Dependencies up to date';
      sendStep('install', 'done', detail);
    } catch (err) {
      sendStep('install', 'error', (err.stderr || err.message || '').substring(0, 200));
      res.end();
      return;
    }

    // Step 3: Read new version
    sendStep('version', 'running', 'Checking new version...');
    try {
      // Clear require cache to get fresh package.json
      delete require.cache[require.resolve('../../package.json')];
      const newPkg = require('../../package.json');
      sendStep('version', 'done', `Updated to v${newPkg.version}`);
    } catch (_) {
      sendStep('version', 'done', 'Version check skipped');
    }

    // Step 4: Auto-restart - write a restart script, close server, spawn it, then exit
    sendStep('restart', 'running', 'Restarting server...');
    res.end();

    setTimeout(() => {
      const { spawn } = require('child_process');
      const path = require('path');
      const fs = require('fs');
      const projectRoot = path.join(__dirname, '..', '..');
      const guiPath = path.join(__dirname, '..', 'gui.js');

      // Write a tiny restart script that waits for the port to free up, then starts
      const restartScript = path.join(projectRoot, 'state', '_restart.js');
      const port = parseInt(process.env.PORT, 10) || 3456;
      fs.writeFileSync(restartScript, `
        const { spawn } = require('child_process');
        const net = require('net');
        const path = require('path');
        const port = ${port};
        // Poll until the port is free (old server exited)
        function waitForPort() {
          const s = net.createServer();
          s.once('error', () => setTimeout(waitForPort, 200));
          s.once('listening', () => {
            s.close(() => {
              // Port is free - start the GUI server
              const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'gui.js')], {
                detached: true,
                stdio: 'ignore',
                env: Object.assign({}, process.env, { CWM_NO_OPEN: '1' }),
                cwd: path.join(__dirname, '..'),
                windowsHide: true,
              });
              child.unref();
              process.exit(0);
            });
          });
          s.listen(port);
        }
        waitForPort();
      `.trim());

      // Spawn the restart script detached so it survives our exit
      const child = spawn(process.execPath, [restartScript], {
        detached: true,
        stdio: 'ignore',
        cwd: projectRoot,
        windowsHide: true,
      });
      child.unref();

      // Now exit - the restart script will wait for the port and re-launch
      process.exit(0);
    }, 1500);

  } catch (err) {
    sendStep('error', 'error', err.message);
    res.end();
  }
});

// ──────────────────────────────────────────────────────────
//  TUNNEL MANAGEMENT (Cloudflare Quick Tunnels)
// ──────────────────────────────────────────────────────────

const _tunnels = new Map();
let _tunnelIdCounter = 0;
let _cloudflaredAvailable = null;

function checkCloudflared() {
  if (HERMETIC_UI_TEST) {
    return Promise.resolve({ available: false, version: null });
  }
  return new Promise((resolve) => {
    execFile('cloudflared', ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ available: false, version: null });
      const version = stdout.trim().split('\n')[0] || stdout.trim();
      resolve({ available: true, version });
    });
  });
}

app.get('/api/tunnels', requireAuth, async (req, res) => {
  if (_cloudflaredAvailable === null) {
    const check = await checkCloudflared();
    _cloudflaredAvailable = check.available;
  }
  const tunnels = [];
  for (const [, t] of _tunnels) {
    tunnels.push({ id: t.id, port: t.port, url: t.url, pid: t.pid, label: t.label, createdAt: t.createdAt });
  }
  res.json({ cloudflaredAvailable: _cloudflaredAvailable, tunnels });
});

app.post('/api/tunnels', requireAuth, async (req, res) => {
  const { port, label } = req.body || {};
  if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Valid port number (1-65535) is required' });
  }
  const check = await checkCloudflared();
  if (!check.available) {
    return res.status(400).json({ error: 'cloudflared is not installed. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/' });
  }
  for (const [, t] of _tunnels) {
    if (t.port === port) {
      return res.status(409).json({ error: `Port ${port} already has a tunnel: ${t.url}`, existing: { id: t.id, url: t.url } });
    }
  }
  try {
    const { spawn } = require('child_process');
    const id = String(++_tunnelIdCounter);
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
    const tunnel = { id, port, url: null, pid: proc.pid, process: proc, label: label || `Port ${port}`, createdAt: new Date().toISOString() };
    _tunnels.set(id, tunnel);

    let urlResolved = false;
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const parseUrl = (data) => {
      if (urlResolved) return;
      const match = data.toString().match(urlRegex);
      if (match) { tunnel.url = match[0]; urlResolved = true; }
    };
    if (proc.stdout) proc.stdout.on('data', parseUrl);
    if (proc.stderr) proc.stderr.on('data', parseUrl);

    proc.on('exit', (code) => {
      _tunnels.delete(id);
      broadcastSSE('tunnel:closed', { id, port });
    });
    proc.on('error', () => { _tunnels.delete(id); });

    // Wait up to 15s for URL
    const startTime = Date.now();
    while (!urlResolved && (Date.now() - startTime) < 15000) {
      await new Promise(r => setTimeout(r, 500));
    }

    res.status(201).json({ id: tunnel.id, port: tunnel.port, url: tunnel.url, pid: tunnel.pid, label: tunnel.label, createdAt: tunnel.createdAt });
    broadcastSSE('tunnel:opened', { id: tunnel.id, port: tunnel.port, url: tunnel.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start tunnel: ' + err.message });
  }
});

app.delete('/api/tunnels/:id', requireAuth, (req, res) => {
  const tunnel = _tunnels.get(req.params.id);
  if (!tunnel) return res.status(404).json({ error: 'Tunnel not found' });
  try {
    if (tunnel.process && !tunnel.process.killed) {
      tunnel.process.kill('SIGTERM');
      setTimeout(() => {
        try { if (tunnel.process && !tunnel.process.killed) tunnel.process.kill('SIGKILL'); } catch {}
      }, 2000);
    }
    _tunnels.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to kill tunnel: ' + err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  NAMED TUNNEL (Cloudflare token-based, persistent domain)
// ──────────────────────────────────────────────────────────

const NAMED_TUNNEL_HOME_CONFIG = path.join(getDataDir(), 'config.json');
const NAMED_TUNNEL_LOCAL_CONFIG = path.join(__dirname, '..', '..', 'state', 'config.json');

function readMyrlinConfig() {
  if (HERMETIC_UI_TEST) return {};
  for (const p of [NAMED_TUNNEL_HOME_CONFIG, NAMED_TUNNEL_LOCAL_CONFIG]) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) {}
  }
  return {};
}

function writeMyrlinConfig(updates) {
  if (HERMETIC_UI_TEST) return false;
  const cfg = readMyrlinConfig();
  Object.assign(cfg, updates);
  const homeDir = path.join(os.homedir(), '.myrlin');
  try {
    if (!fs.existsSync(homeDir)) fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(NAMED_TUNNEL_HOME_CONFIG, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Tunnel] Failed to save config to home:', err.message);
  }
  try {
    const localDir = path.dirname(NAMED_TUNNEL_LOCAL_CONFIG);
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(NAMED_TUNNEL_LOCAL_CONFIG, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (_) {}
  return true;
}

let _namedTunnel = null; // { process, status, startedAt, tunnelId }

function getNamedTunnelStatus() {
  if (!_namedTunnel) return { running: false, status: 'stopped' };
  return {
    running: true,
    status: _namedTunnel.status,
    startedAt: _namedTunnel.startedAt,
    tunnelId: _namedTunnel.tunnelId || null,
    pid: _namedTunnel.process ? _namedTunnel.process.pid : null,
  };
}

function startNamedTunnel(token) {
  if (HERMETIC_UI_TEST) {
    return { error: 'Named tunnels are disabled in hermetic UI tests' };
  }
  if (_namedTunnel && _namedTunnel.process && !_namedTunnel.process.killed) {
    return { error: 'Tunnel already running' };
  }
  const { spawn } = require('child_process');
  let proc;
  try {
    // Token passed as array arg, no shell injection possible regardless of content
    proc = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
  } catch (err) {
    return { error: 'Failed to spawn cloudflared: ' + err.message };
  }
  _namedTunnel = { process: proc, status: 'connecting', startedAt: new Date().toISOString(), tunnelId: null };

  const parseLine = (data) => {
    if (!_namedTunnel) return;
    const line = data.toString().trim();
    const idMatch = line.match(/tunnelID=([a-zA-Z0-9-]+)/);
    if (idMatch) _namedTunnel.tunnelId = idMatch[1];
    if (/Registered tunnel connection|connection registered/i.test(line)) {
      _namedTunnel.status = 'connected';
      broadcastSSE('namedTunnel:status', getNamedTunnelStatus());
    } else if (/error|failed|unable to/i.test(line) && _namedTunnel.status === 'connecting') {
      _namedTunnel.status = 'error';
      broadcastSSE('namedTunnel:status', getNamedTunnelStatus());
    }
  };
  if (proc.stdout) proc.stdout.on('data', parseLine);
  if (proc.stderr) proc.stderr.on('data', parseLine);
  proc.on('exit', () => {
    _namedTunnel = null;
    broadcastSSE('namedTunnel:status', { running: false, status: 'stopped' });
  });
  proc.on('error', (err) => {
    console.error('[Tunnel] cloudflared error:', err.message);
    if (_namedTunnel) {
      _namedTunnel.status = 'error';
      broadcastSSE('namedTunnel:status', getNamedTunnelStatus());
    }
  });
  return { started: true };
}

app.get('/api/tunnel/named', requireAuth, (req, res) => {
  if (HERMETIC_UI_TEST) {
    return res.json({
      configured: false,
      autoStart: false,
      disabled: true,
      ...getNamedTunnelStatus(),
    });
  }
  const cfg = readMyrlinConfig();
  res.json({
    configured: !!(process.env.CWM_CF_TOKEN || cfg.cfTunnelToken),
    autoStart: !!cfg.cfTunnelAutoStart,
    ...getNamedTunnelStatus(),
  });
});

app.put('/api/tunnel/named/config', requireAuth, (req, res) => {
  if (HERMETIC_UI_TEST) {
    return res.status(503).json({ error: 'Named tunnels are disabled in hermetic UI tests' });
  }
  const { token, autoStart } = req.body || {};
  const updates = {};
  if (token !== undefined) {
    if (typeof token !== 'string' || token.length > 2048) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    if (token.length > 0 && !/^[A-Za-z0-9._=+-]+$/.test(token)) {
      return res.status(400).json({ error: 'Token contains invalid characters' });
    }
    updates.cfTunnelToken = token;
  }
  if (autoStart !== undefined) updates.cfTunnelAutoStart = !!autoStart;
  writeMyrlinConfig(updates);
  res.json({ success: true });
});

app.post('/api/tunnel/named/start', requireAuth, async (req, res) => {
  if (HERMETIC_UI_TEST) {
    return res.status(503).json({ error: 'Named tunnels are disabled in hermetic UI tests' });
  }
  const cfg = readMyrlinConfig();
  const token = process.env.CWM_CF_TOKEN || cfg.cfTunnelToken;
  if (!token) {
    return res.status(400).json({ error: 'No tunnel token configured. Add one in Settings > Remote Access.' });
  }
  const check = await checkCloudflared();
  if (!check.available) {
    return res.status(400).json({ error: 'cloudflared not installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/' });
  }
  const result = startNamedTunnel(token);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ started: true, status: getNamedTunnelStatus() });
});

app.post('/api/tunnel/named/stop', requireAuth, (req, res) => {
  if (HERMETIC_UI_TEST) {
    return res.status(503).json({ error: 'Named tunnels are disabled in hermetic UI tests' });
  }
  if (!_namedTunnel || !_namedTunnel.process) {
    return res.status(404).json({ error: 'No named tunnel running' });
  }
  try {
    _namedTunnel.process.kill('SIGTERM');
    setTimeout(() => {
      try { if (_namedTunnel && !_namedTunnel.process.killed) _namedTunnel.process.kill('SIGKILL'); } catch (_) {}
    }, 3000);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-start on server init if configured
(async () => {
  if (HERMETIC_UI_TEST) return;
  const cfg = readMyrlinConfig();
  const token = process.env.CWM_CF_TOKEN || cfg.cfTunnelToken;
  if (cfg.cfTunnelAutoStart && token) {
    const check = await checkCloudflared();
    if (check.available) {
      console.log('[Tunnel] Auto-starting named tunnel...');
      startNamedTunnel(token);
    } else {
      console.warn('[Tunnel] Auto-start skipped: cloudflared not found');
    }
  }
})();

// ──────────────────────────────────────────────────────────
//  SESSION SEARCH (full-text across all JSONL files)
// ──────────────────────────────────────────────────────────
//
// Plan 16-01 (SRCH-01..04, SRCH-06): the file-list cache and the JSONL read
// loop that used to live inline here MOVED into src/providers/claude/search.js
// as module-scoped private state. The GET /api/search route below is now a
// per-provider Promise.allSettled dispatcher; see the route handler further
// down for the dispatch + merge logic.

// ── Files API ──────────────────────────────────────────────────────────────
const fileManager = require('./file-manager');

/**
 * Resolve the primary working directory for a workspace.
 * Uses the most common workingDir across the workspace's sessions.
 * Returns null if no sessions have a workingDir set.
 *
 * @param {Object} store - App store instance
 * @param {string} workspaceId - Workspace ID
 * @returns {string|null}
 */
function resolveWorkspaceDir(store, workspaceId) {
  const sessions = store.getWorkspaceSessions(workspaceId);
  if (!sessions || sessions.length === 0) return null;
  const counts = {};
  for (const s of sessions) {
    if (s.workingDir) counts[s.workingDir] = (counts[s.workingDir] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

/**
 * GET /api/files/tree?workspaceId=<id>&subpath=<rel>
 * Returns directory entries for a subpath within the workspace root.
 * Skips .git, node_modules, and other build artifacts.
 */
app.get('/api/files/tree', requireAuth, async (req, res) => {
  try {
    const { workspaceId, subpath = '' } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const store = getStore();
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const workingDir = resolveWorkspaceDir(store, workspaceId);
    if (!workingDir) return res.status(400).json({ error: 'Workspace has no sessions with a working directory' });
    const tree = await fileManager.getTree(workingDir, subpath);
    res.json(tree);
  } catch (err) {
    const status = err.message.includes('traversal') ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/files/content?workspaceId=<id>&file=<rel>
 * Returns file content as text with a CodeMirror language hint.
 * Rejects files larger than 1MB.
 */
app.get('/api/files/content', requireAuth, async (req, res) => {
  try {
    const { workspaceId, file } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!file) return res.status(400).json({ error: 'file param required' });
    const store = getStore();
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const workingDir = resolveWorkspaceDir(store, workspaceId);
    if (!workingDir) return res.status(400).json({ error: 'Workspace has no sessions with a working directory' });
    const result = await fileManager.getContent(workingDir, file);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('traversal') ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/files/save
 * Body: { workspaceId, file, content }
 * Atomically saves file content (write temp → rename).
 */
app.post('/api/files/save', requireAuth, async (req, res) => {
  try {
    const { workspaceId, file, content } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!file) return res.status(400).json({ error: 'file required' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    const store = getStore();
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const workingDir = resolveWorkspaceDir(store, workspaceId);
    if (!workingDir) return res.status(400).json({ error: 'Workspace has no sessions with a working directory' });
    const result = await fileManager.saveContent(workingDir, file, content);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('traversal') ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// ─── Search Dispatcher Constants (Plan 16-01, SRCH-04) ───────────────────────
//
// The 5000ms total budget is preserved verbatim from v1.1. With one enabled
// provider (Claude only, the default for existing users) the per-provider
// budget equals the full 5000ms so latency parity holds. With two providers
// enabled the budget splits as floor(5000/2) = 2500ms each.
const SEARCH_TOTAL_BUDGET_MS = 5000;
// The race timer fires at perProviderBudget + GRACE; the provider's own
// self-check (Date.now() - startTime > timeBudgetMs) is the primary timeout
// mechanism, the race is the second-line defense for a runaway provider.
const SEARCH_TIMEOUT_GRACE_MS = 100;

/**
 * Race a provider's search against a hard timeout. The provider's own loop
 * already self-checks against timeBudgetMs and returns timedOut: true on
 * exceed; the race timer is the second-line defense for a runaway provider
 * (e.g. one that synchronously blocks past its budget). The timer is
 * registered with .unref() so it cannot pin the event loop, and is cleared
 * in the resolve handler so memory stays bounded across burst requests.
 *
 * @param {Object} provider - Registry-resolved provider object (must have id and search()).
 * @param {string} query - Trimmed query string.
 * @param {number} limit - Result count cap.
 * @param {number} timeBudgetMs - Per-provider self-check budget (passed through).
 * @param {number} graceMs - Extra time before the race resolves with __timedOut.
 * @returns {Promise<{results: Array, timedOut: boolean, searchedFiles: number}|{__timedOut: true, providerId: string}>}
 */
function racedSearch(provider, query, limit, timeBudgetMs, graceMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ __timedOut: true, providerId: provider.id }),
      timeBudgetMs + graceMs
    );
    // Do not pin the event loop on this timer; it must not block process exit.
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve().then(() => provider.search({ query, limit, timeBudgetMs })),
    timeout,
  ]).then((value) => {
    clearTimeout(timer);
    return value;
  });
}

/**
 * GET /api/search?q=<query>&limit=20
 *
 * v1.2 dispatcher (Plan 16-01): calls every enabled provider's .search() in
 * parallel via Promise.allSettled, merges results sorted by descending
 * timestamp, slices to limit, and returns {partial, timedOutProviders}
 * alongside the legacy fields. Each result carries its provider field
 * (set by the provider, not re-tagged at the dispatcher).
 *
 * Auth-protected. Total budget preserved at SEARCH_TOTAL_BUDGET_MS (5000ms);
 * per-provider budget is floor(TOTAL / enabled.length) so Claude-only callers
 * (the v1.2 default for existing users) receive the full 5000ms and stay
 * within the +/-5% latency-parity acceptance criterion.
 *
 * Response shape:
 *   {
 *     query: string,
 *     results: SearchResult[],     // merged, sorted desc by timestamp, sliced to limit
 *     totalMatches: number,        // sum of returned result counts across providers
 *     searchedFiles: number,       // sum across providers (diagnostic)
 *     durationMs: number,
 *     partial: boolean,            // any provider timed out OR rejected
 *     timedOutProviders: string[], // ids of providers that timed out / rejected
 *     timedOut: boolean,           // legacy alias = partial; deprecated, removed in a future release
 *   }
 *
 * Requirements: SRCH-01 (allSettled dispatch + merge), SRCH-02 (provider field),
 * SRCH-03 (partial-results contract), SRCH-04 (split budget; no Claude-only
 * regression), SRCH-06 (single execution context, not N workers).
 */
app.get('/api/search', requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" must be at least 2 characters.' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const trimmedQuery = query.trim();
  const startTime = Date.now();

  // PITFALL F7 (mirrors Plan 15-02): snapshot the enabled provider set ONCE
  // on the first executable line. A mid-request toggle does NOT change this
  // snapshot.
  const enabled = registry.listEnabled();
  if (enabled.length === 0) {
    return res.json({
      query: trimmedQuery,
      results: [],
      totalMatches: 0,
      searchedFiles: 0,
      durationMs: 0,
      partial: false,
      timedOutProviders: [],
      timedOut: false,
    });
  }

  // Per-provider budget. Claude-only users (default v1.2) get the full 5000ms;
  // Claude+Codex users get 2500ms each, etc.
  const perProviderBudget = Math.floor(SEARCH_TOTAL_BUDGET_MS / enabled.length);

  // Dispatch in parallel. Promise.allSettled is required so a single failed
  // provider does not crash the response (SRCH-03).
  const settled = await Promise.allSettled(
    enabled.map((p) => racedSearch(p, trimmedQuery, limit, perProviderBudget, SEARCH_TIMEOUT_GRACE_MS))
  );

  const merged = [];
  const timedOutProviders = [];
  let totalMatches = 0;
  let searchedFiles = 0;

  for (let i = 0; i < enabled.length; i++) {
    const provider = enabled[i];
    const result = settled[i];
    if (result.status === 'rejected') {
      console.error('[search] provider ' + provider.id + ' rejected: ' +
        (result.reason && result.reason.message ? result.reason.message : result.reason));
      timedOutProviders.push(provider.id);
      continue;
    }
    const v = result.value;
    if (v && v.__timedOut === true) {
      timedOutProviders.push(provider.id);
      continue;
    }
    if (v && Array.isArray(v.results)) {
      // Each result already carries its provider field (set inside the
      // provider). The dispatcher does NOT re-tag; the provider owns its
      // own identity (SRCH-02).
      for (const r of v.results) merged.push(r);
      totalMatches += v.results.length;
    }
    if (v && typeof v.searchedFiles === 'number') {
      searchedFiles += v.searchedFiles;
    }
    if (v && v.timedOut === true) {
      timedOutProviders.push(provider.id);
      // The provider's own results may still be partially populated; we keep
      // them in merged but mark the provider in timedOutProviders so the
      // frontend can surface the partial-results state in the UI.
    }
  }

  // ── Title-override merge + name-match synthetic results ───────────────────
  // Provider content search only reads transcript bodies. Two categories of
  // match would otherwise be invisible:
  //   (a) A content result whose session was renamed: we swap in the custom
  //       name so the result list shows what the user called it.
  //   (b) A session that matches ONLY by its custom name (Myrlin record
  //       name/topic OR a title override for a discovered session): we emit a
  //       synthetic "Matched by name" result so custom names are searchable.
  // All of this lives in the dispatcher (providers stay pure) and keys off
  // provider ids sourced from data (result.provider, session.provider,
  // registry-enabled ids), never a string literal. Best-effort: any store
  // hiccup leaves the content results untouched.
  try {
    const searchStore = getStore();
    const lowerQuery = trimmedQuery.toLowerCase();

    // (a) Override onto content results, keyed by (provider, sessionId).
    for (const r of merged) {
      if (!r || !r.provider || !r.sessionId) continue;
      let override = null;
      try { override = searchStore.getProviderSessionTitle(r.provider, r.sessionId); } catch (_) { override = null; }
      if (override) r.sessionName = override;
    }

    // Dedup key: provider + space + sessionId. Neither a registry provider id
    // (^[a-z][a-z0-9_-]*$) nor a sanitized session id contains a space, so the
    // separator is unambiguous.
    const keyOf = (provider, sid) => String(provider) + ' ' + String(sid || '');
    const seenKeys = new Set();
    for (const r of merged) {
      if (r && r.provider && r.sessionId) seenKeys.add(keyOf(r.provider, r.sessionId));
    }

    const synthetic = [];
    const SYNTHETIC_CAP = limit; // never emit more than the page can show

    // (b1) Store sessions matched by name/topic.
    let storeSessions = [];
    try { storeSessions = searchStore.getAllSessionsList() || []; } catch (_) { storeSessions = []; }
    const fallbackProviderId = (enabled[0] && enabled[0].id) || null;
    for (const s of storeSessions) {
      if (synthetic.length >= SYNTHETIC_CAP) break;
      const name = typeof s.name === 'string' ? s.name : '';
      const topic = typeof s.topic === 'string' ? s.topic : '';
      if (name.toLowerCase().indexOf(lowerQuery) === -1 && topic.toLowerCase().indexOf(lowerQuery) === -1) continue;
      const provider = s.provider || fallbackProviderId;
      if (!provider) continue;
      const sid = s.resumeSessionId || '';
      const key = keyOf(provider, sid);
      if (sid && seenKeys.has(key)) continue; // already surfaced by content search
      if (sid) seenKeys.add(key);
      const projectPath = s.workingDir || null;
      synthetic.push({
        provider: provider,
        sessionId: sid || null,
        sessionName: name || sid || null,
        projectPath: projectPath,
        projectName: projectPath ? path.basename(projectPath) : (name || null),
        timestamp: s.lastActive || null,
        role: 'name-match',
        snippet: 'Matched by name',
        lineNumber: 0,
      });
    }

    // (b2) Title overrides matched by value (covers discovered sessions that
    // have no Myrlin store record at all).
    const titleRoot = (searchStore._state && searchStore._state.providerSessionTitles) || {};
    for (const providerId of Object.keys(titleRoot)) {
      if (synthetic.length >= SYNTHETIC_CAP) break;
      const byUuid = titleRoot[providerId];
      if (!byUuid || typeof byUuid !== 'object') continue;
      for (const uuid of Object.keys(byUuid)) {
        if (synthetic.length >= SYNTHETIC_CAP) break;
        const title = byUuid[uuid];
        if (typeof title !== 'string' || title.toLowerCase().indexOf(lowerQuery) === -1) continue;
        const key = keyOf(providerId, uuid);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        synthetic.push({
          provider: providerId,
          sessionId: uuid,
          sessionName: title,
          projectPath: null,
          projectName: null,
          timestamp: null,
          role: 'name-match',
          snippet: 'Matched by name',
          lineNumber: 0,
        });
      }
    }

    for (const r of synthetic) merged.push(r);
    totalMatches += synthetic.length;
  } catch (_) {
    // Name-match augmentation is best-effort; never fails the search response.
  }

  // Merge sort: descending timestamp (matches v1.1 sort exactly).
  // null timestamps sink to the end so the v1.1 wire shape is preserved.
  merged.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  const sliced = merged.slice(0, limit);
  const partial = timedOutProviders.length > 0;

  return res.json({
    query: trimmedQuery,
    results: sliced,
    totalMatches,
    searchedFiles,
    durationMs: Date.now() - startTime,
    partial,
    timedOutProviders,
    timedOut: partial, // legacy alias for v1.1 callers; deprecated, kept for one release
  });
});

// ──────────────────────────────────────────────────────────
//  CONFLICT DETECTION (JSONL-based global + per workspace)
// ──────────────────────────────────────────────────────────

// ─── JSONL Conflict Cache (30s TTL) ────────────────────────
// In-memory map of sessionId -> Set<filePath> extracted from JSONL Write/Edit tool_use blocks.
// Cached for 30 seconds to avoid repeatedly reading JSONL files on every poll.
let _jsonlConflictCache = null;
let _jsonlConflictCacheTime = 0;
const JSONL_CONFLICT_CACHE_TTL = 30000; // 30 seconds

/**
 * Normalize a file path for consistent comparison across platforms.
 * Converts backslashes to forward slashes and lowercases on Windows.
 * @param {string} filePath - Raw file path from JSONL data
 * @returns {string} Normalized path
 */
function normalizeConflictPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  let normalized = filePath.replace(/\\/g, '/');
  // Lowercase on Windows for case-insensitive comparison
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Extract file paths from Edit and Write tool_use blocks in JSONL data.
 * Reads only the last 50KB of the JSONL file to keep the check lightweight.
 * @param {string} jsonlPath - Absolute path to the .jsonl file
 * @returns {Set<string>} Set of normalized file paths modified by this session
 */
function extractModifiedFilesFromJsonl(jsonlPath) {
  const files = new Set();
  try {
    const stat = fs.statSync(jsonlPath);
    const maxRead = 50 * 1024; // 50KB cap -- only need recent activity
    let content;
    if (stat.size <= maxRead) {
      content = fs.readFileSync(jsonlPath, 'utf-8');
    } else {
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        const buf = Buffer.alloc(maxRead);
        fs.readSync(fd, buf, 0, maxRead, stat.size - maxRead);
        content = buf.toString('utf-8');
        // Skip the first partial line from seeking into the middle of the file
        const firstNewline = content.indexOf('\n');
        if (firstNewline > 0) content = content.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    }

    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant' || !entry.message) continue;
        const blocks = entry.message.content;
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
          if (block.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write')) {
            const fp = block.input && (block.input.file_path || block.input.path);
            if (fp) {
              files.add(normalizeConflictPath(fp));
            }
          }
        }
      } catch (_) {
        // Skip malformed JSONL lines
      }
    }
  } catch (_) {
    // File read error -- return empty set
  }
  return files;
}

/**
 * Build a map of sessionId -> { id, name, files: Set<string> } for all active sessions.
 * Uses 30-second caching to avoid hammering the filesystem.
 * @returns {{ sessionFiles: Map<string, {id: string, name: string, files: Set<string>}>, checkedSessions: number }}
 */
function getGlobalSessionFileMap() {
  const now = Date.now();
  if (_jsonlConflictCache && (now - _jsonlConflictCacheTime) < JSONL_CONFLICT_CACHE_TTL) {
    return _jsonlConflictCache;
  }

  const store = getStore();
  const allSessions = store.getAllSessionsList();
  // Only check sessions that are running or recently active (have a resumeSessionId for JSONL lookup)
  const activeSessions = allSessions.filter(s =>
    (s.status === 'running' || s.status === 'idle') && s.resumeSessionId
  );

  const sessionFiles = new Map();
  let checkedSessions = 0;

  for (const session of activeSessions) {
    // Plan 15-01 (DISC-03): dispatch through provider abstraction.
    const provider = getProviderForSession(session);
    const jsonlPath = provider ? provider.findArtifactPath(session.resumeSessionId) : null;
    if (!jsonlPath) continue;
    checkedSessions++;
    const files = extractModifiedFilesFromJsonl(jsonlPath);
    if (files.size > 0) {
      sessionFiles.set(session.id, {
        id: session.id,
        name: session.name || session.id.substring(0, 12),
        files,
      });
    }
  }

  _jsonlConflictCache = { sessionFiles, checkedSessions };
  _jsonlConflictCacheTime = now;
  return _jsonlConflictCache;
}

/**
 * GET /api/conflicts
 * Global JSONL-based conflict detection across all active sessions.
 * Scans recent JSONL entries (last 50KB) for Edit and Write tool_use blocks,
 * extracts file paths, and cross-references across sessions to find overlaps.
 * Results are cached for 30 seconds to avoid hammering the filesystem.
 * Protected by auth.
 *
 * @returns {{ conflicts: Array<{ file: string, sessions: Array<{ id: string, name: string }> }>, checkedSessions: number, timestamp: string }}
 */
app.get('/api/conflicts', requireAuth, (req, res) => {
  const { sessionFiles, checkedSessions } = getGlobalSessionFileMap();

  // Cross-reference: find files that appear in 2+ sessions
  const fileToSessions = new Map(); // normalizedPath -> [{ id, name }]

  for (const [, sessionInfo] of sessionFiles) {
    for (const file of sessionInfo.files) {
      if (!fileToSessions.has(file)) {
        fileToSessions.set(file, []);
      }
      fileToSessions.get(file).push({ id: sessionInfo.id, name: sessionInfo.name });
    }
  }

  const conflicts = [];
  for (const [file, sessionsInConflict] of fileToSessions) {
    if (sessionsInConflict.length >= 2) {
      conflicts.push({
        file,
        sessions: sessionsInConflict,
      });
    }
  }

  // Sort by most sessions involved first
  conflicts.sort((a, b) => b.sessions.length - a.sessions.length);

  return res.json({
    conflicts,
    checkedSessions,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/workspaces/:id/conflicts
 * Checks if multiple running sessions in a workspace are modifying the same files.
 * Runs `git status --porcelain` in each session's workingDir to discover modified files,
 * then cross-references to find overlapping edits. Status output is cached
 * per repo path for GIT_CONFLICT_CACHE_TTL_MS (see git-status-cache.js) so
 * rapid repeated polls do not re-spawn git per session.
 * Protected by auth.
 */
app.get('/api/workspaces/:id/conflicts', requireAuth, async (req, res) => {
  const store = getStore();
  const workspace = store.getWorkspace(req.params.id);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }

  const sessions = store.getWorkspaceSessions(req.params.id);

  // Only consider running sessions with a workingDir
  const runningSessions = sessions.filter(
    (s) => s.status === 'running' && s.workingDir
  );

  if (runningSessions.length === 0) {
    return res.json({
      conflicts: [],
      checkedSessions: 0,
      timestamp: new Date().toISOString(),
    });
  }

  // Collect modified files per session (async, routed through concurrency pool)
  // Map: sessionId → { id, name, files: string[] }
  const sessionFiles = new Map();
  let checkedSessions = 0;

  // Run git status for all sessions concurrently (pool limits actual spawns)
  await Promise.all(runningSessions.map(async (session) => {
    try {
      // Served through the short-TTL per-repo-path cache: rapid repeated
      // polls (and sessions sharing one workingDir) reuse one git spawn.
      const stdout = await conflictGitStatusCache.get(session.workingDir, (dir) => gitExec(['status', '--porcelain'], dir));

      checkedSessions++;

      const modifiedFiles = [];
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        // git status --porcelain format: XY filename
        // X = staging area, Y = working tree
        // Lines start with status codes like M, A, ??, D, R, etc.
        const statusCode = line.substring(0, 2).trim();
        if (!statusCode) continue;

        // Skip deleted files (they're not actively being edited)
        if (statusCode === 'D' || statusCode === 'DD') continue;

        // Extract filename - for renamed files (R), the new name is after " -> "
        let filename = line.substring(3).trim();
        if (filename.includes(' -> ')) {
          filename = filename.split(' -> ')[1].trim();
        }
        // Remove quotes if present (git adds them for special chars)
        if (filename.startsWith('"') && filename.endsWith('"')) {
          filename = filename.slice(1, -1);
        }

        // Normalize path separators to forward slashes for consistent comparison
        filename = filename.replace(/\\/g, '/');

        if (filename) {
          modifiedFiles.push(filename);
        }
      }

      if (modifiedFiles.length > 0) {
        sessionFiles.set(session.id, {
          id: session.id,
          name: session.name || session.id.substring(0, 12),
          files: modifiedFiles,
        });
      }
    } catch (_) {
      // git status failed (not a git repo, timeout, etc.) - skip this session
      checkedSessions++;
    }
  }));

  // Cross-reference: find files that appear in 2+ sessions
  const fileToSessions = new Map(); // filename → [{ id, name }]

  for (const [, sessionInfo] of sessionFiles) {
    for (const file of sessionInfo.files) {
      if (!fileToSessions.has(file)) {
        fileToSessions.set(file, []);
      }
      fileToSessions.get(file).push({ id: sessionInfo.id, name: sessionInfo.name });
    }
  }

  const conflicts = [];
  for (const [file, sessionsInConflict] of fileToSessions) {
    if (sessionsInConflict.length >= 2) {
      conflicts.push({
        file,
        sessions: sessionsInConflict,
      });
    }
  }

  // Sort conflicts by number of sessions involved (most conflicts first)
  conflicts.sort((a, b) => b.sessions.length - a.sessions.length);

  return res.json({
    conflicts,
    checkedSessions,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/browse
 * Lists directories at a given path for the folder browser UI.
 * Returns only directories (not files) since session creation needs a directory.
 * Protected by auth.
 *
 * @query {string} [path] - Directory to list (default: user's home directory)
 * @returns {{ currentPath: string, parent: string|null, entries: Array<{name: string, path: string}> }}
 */
app.get('/api/browse', requireAuth, (req, res) => {
  const os = require('os');
  const fs = require('fs');

  let targetPath = req.query.path || os.homedir();
  targetPath = path.resolve(targetPath);

  // Validate path exists and is a directory
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Path does not exist or is not accessible' });
  }

  // Compute parent directory (null at filesystem root)
  const parent = path.dirname(targetPath);
  const hasParent = parent !== targetPath;

  // Read directory entries, filter to directories only
  const entries = [];
  try {
    const items = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const item of items) {
      // Skip hidden and system directories
      if (item.name.startsWith('.') || item.name === '$RECYCLE.BIN' || item.name === 'System Volume Information') {
        continue;
      }
      try {
        if (item.isDirectory()) {
          entries.push({ name: item.name, path: path.join(targetPath, item.name) });
        }
      } catch (_) {
        // Skip entries we can't stat (permission denied)
      }
    }
  } catch (err) {
    return res.status(403).json({ error: 'Cannot read directory: ' + err.message });
  }

  // Sort alphabetically, case-insensitive
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  res.json({ currentPath: targetPath, parent: hasParent ? parent : null, entries });
});

// ── Git API endpoints (log + diff) ────────────────────────────────────────────
// Note: /api/git/status and /api/git/branches are registered earlier in the file
// (upstream routes) and now also accept workspaceId via resolveWorkspaceDir().

const gitManager = require('./git-manager');

/**
 * GET /api/git/log
 * Returns the commit log for a workspace's working directory.
 *
 * @query {string} workspaceId - The workspace ID
 * @query {number} [limit=20] - Maximum number of commits to return
 * @returns {{ commits: Array<{ hash, shortHash, author, date, message }> }}
 */
app.get('/api/git/log', requireAuth, async (req, res) => {
  try {
    const { workspaceId, limit } = req.query;
    const store = getStore();
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const workingDir = resolveWorkspaceDir(store, workspaceId);
    if (!workingDir) return res.status(400).json({ error: 'Workspace has no sessions with a working directory' });
    const log = await gitManager.getLog(workingDir, limit);
    res.json({ commits: log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/git/diff
 * Returns the unified diff for a specific file in a workspace.
 *
 * @query {string} workspaceId - The workspace ID
 * @query {string} file - File path relative to the workspace working directory
 * @query {string} [staged] - 'true' to show staged diff, omit for unstaged
 * @returns {{ diff: string }}
 */
app.get('/api/git/diff', requireAuth, async (req, res) => {
  try {
    const { workspaceId, file, staged } = req.query;
    const store = getStore();
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const workingDir = resolveWorkspaceDir(store, workspaceId);
    if (!workingDir) return res.status(400).json({ error: 'Workspace has no sessions with a working directory' });
    const diff = await gitManager.getDiff(workingDir, file, staged === 'true');
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/git/commit-diff
 * Returns the full patch output (git show) for a specific commit.
 *
 * @query {string} workspaceId - The workspace ID
 * @query {string} hash - Commit hash (full or short, 4-40 hex chars)
 * @returns {{ diff: string }}
 */
app.get('/api/git/commit-diff', requireAuth, async (req, res) => {
  try {
    const { workspaceId, hash } = req.query;
    const store = getStore();
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!hash) return res.status(400).json({ error: 'hash required' });
    const ws = store.getWorkspace(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const workingDir = resolveWorkspaceDir(store, workspaceId);
    if (!workingDir) return res.status(400).json({ error: 'Workspace has no sessions with a working directory' });
    const diff = await gitManager.getCommitDiff(workingDir, hash);
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
//  EXPRESS ERROR MIDDLEWARE
// ──────────────────────────────────────────────────────────

/**
 * Catch-all error handler for Express routes.
 * Prevents unhandled route errors from crashing the process.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled route error:', err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────
//  SERVER START
// ──────────────────────────────────────────────────────────

/**
 * Start the Express server on the given port.
 * Attaches store event listeners for SSE and returns the http.Server instance.
 *
 * @param {number} port - Port to listen on (default 3456)
 * @returns {import('http').Server} The Node.js HTTP server instance
 */
// Reference to PTY manager for cleanup on shutdown
let _ptyManager = null;
let _scheduler = null;

/**
 * Backfill resumeSessionId for sessions that have a workingDir but no resumeSessionId.
 * This ensures cost tracking works for discovered/imported sessions and any sessions
 * where PTY backfill failed. Runs once at startup, non-blocking.
 */
function backfillResumeSessionIds() {
  try {
    const store = getStore();
    const sessions = store.getAllSessionsList();
    let backfilled = 0;

    for (const session of sessions) {
      if (session.resumeSessionId || !session.workingDir) continue;

      // Plan 15-01 (DISC-03): dispatch through provider abstraction.
      const provider = getProviderForSession(session);
      const result = provider ? provider.findArtifactByWorkingDir(session.workingDir) : null;
      if (result) {
        store.updateSession(session.id, { resumeSessionId: result.claudeSessionId });
        backfilled++;
      }
    }

    if (backfilled > 0) {
      console.log(`[Server] Backfilled resumeSessionId for ${backfilled} session(s)`);
    }
  } catch (err) {
    console.error('[Server] Failed to backfill resumeSessionIds:', err.message);
  }
}

function startServer(port = 3456, host = '127.0.0.1') {
  // Wire store events to SSE before accepting connections
  attachStoreEvents();

  // Restore device tokens from disk so mobile stays authenticated across restarts
  setStoreGetter(getStore);
  reloadTokensFromStore(getStore);

  // Backfill missing resumeSessionIds so cost tracking works for all sessions
  setImmediate(() => backfillResumeSessionIds());

  const server = app.listen(port, host, () => {
    // Server is ready - caller handles the log message
  });

  // Keep-alive for SSE connections
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  // Attach PTY WebSocket server.
  //
  // Boot resilience (issue #68): node-pty load failures are now contained
  // inside pty-manager (pty stays null, spawns fail per-call), so this require
  // + attach no longer throws on the reported crash. This try/catch is
  // belt-and-braces for ANY future load-time failure: even then, the rest of
  // startServer (scheduler, credential watcher, schedule routes, shutdown
  // cleanup) must still wire up. On a throw, ptyManager stays null and the
  // downstream `if (_ptyManager)` guards + the scheduler's null-tolerant
  // getSession() checks keep the process at its normal ready state.
  let ptyManager = null;
  try {
    const { attachPtyWebSocket } = require('./pty-server');
    ({ ptyManager } = attachPtyWebSocket(server));
  } catch (err) {
    console.error('[Server] Failed to attach PTY WebSocket server:', (err && err.message) || err);
  }
  _ptyManager = ptyManager;

  // Degraded-boot banner (issue #68): if the native terminal engine did not
  // load, print ONE prominent, platform-specific remediation banner. Terminal
  // panes are disabled; everything else keeps working. Best effort only.
  try {
    const ptyDiag = require('./pty-diagnostics');
    if (!ptyDiag.getPtyAvailability().available) {
      console.error(ptyDiag.buildRemediationText(process.platform));
    }
  } catch (_) { /* diagnostics must never block boot */ }

  // ─── Scheduler ───────────────────────────────────────────────
  const { Scheduler } = require('./scheduler');
  const { mountScheduleRoutes } = require('./scheduler-routes');
  _scheduler = new Scheduler({ ptyManager: _ptyManager, store: getStore() });
  _scheduler.start();
  mountScheduleRoutes(app, { requireAuth, scheduler: _scheduler, store: getStore() });

  // One-time claude-swap roster import, queued BEFORE the watcher starts so
  // the watcher's initial sync (which self-captures the ACTIVE account into
  // the store) lands on an already-seeded roster instead of poisoning the
  // old snapshot-count guard. The manager's serialize() chain preserves this
  // ordering, and the seed itself is sentinel-gated (<accountsDir>/.seeded)
  // so it runs at most once per store no matter how often it is called.
  // A bad or missing seed dir must never block boot: failures only log.
  try {
    credentialManager.seedFromClaudeSwap().catch((err) => {
      console.warn('[Credentials] startup seed skipped:', (err && err.message) || err);
    });
  } catch (err) {
    console.warn('[Credentials] startup seed skipped:', (err && err.message) || err);
  }

  // Task #37: one-time repair of a stored Mac host that names a retired
  // tailnet address. Purely local and offline-safe (it contacts nothing), so
  // it is correct to run at boot with the Mac powered off. Runs BEFORE the
  // watcher only so the corrected host is in place for the first sweep;
  // nothing depends on the ordering. A failure only logs, exactly like the
  // seed above: a settings repair must never be able to block boot.
  try {
    const macHostMigration = credentialManager.migrateLegacyMacHost();
    if (macHostMigration && macHostMigration.migrated) {
      console.log('[Credentials] Mac host migrated from "' + macHostMigration.from
        + '" to "' + macHostMigration.to + '" (the old address is retired).');
    }
  } catch (err) {
    console.warn('[Credentials] Mac host migration skipped:', (err && err.message) || err);
  }

  // Credential rotation write-back watcher (design Decision 3): keeps the
  // account snapshots in sync with the live token file as the CLI rotates
  // tokens. Crash-proof by construction; a start failure only logs.
  try {
    credentialManager.startCredentialWatcher();
  } catch (err) {
    console.warn('[Credentials] watcher failed to start:', err.message);
  }

  // Proactive credential refresh sweep (expiry-fix spec Phase 3; ON BY
  // DEFAULT). WHY: refresh tokens are one-time-use; a successful refresh
  // rotates the pair and kills the old refresh token server-side, so
  // whichever lineage holder refreshes first wins and every other stored
  // copy dies. Parked accounts were expiring ~8 to 13h after their last
  // rotation because some OTHER holder (a CLI session left running on a
  // switched-away account, a Mac profile, an old claude-swap copy) rotated
  // first. This sweep keeps the workbook the winner by rotating inactive,
  // believed-good accounts just before their access token lapses.
  //
  // ACCEPTED RISK (Arthur's decision, 2026-07-16): when the workbook wins
  // the lineage, a CLI session still running on that switched-away account
  // loses it and can be logged out mid-session, and the OAuth server's
  // reuse detection can revoke the whole token family. The manager's gates
  // (never PC-active, never Mac-active, tokenState ok only, no recent
  // suspect backoff, 30-minute expiry window) minimize but do not
  // eliminate this; /login on the affected account recovers it either way.
  //
  // The tick re-reads settings, so setting proactiveRefreshMinutes to 0
  // disables the sweep live; the interval LENGTH is read once at boot (a
  // cadence change applies on the next restart). Clamped to the named
  // floor so a typo like 1 cannot hammer the token endpoint.
  let credProactiveTimer = null;
  try {
    const configuredMinutes = Number(credentialManager.getSettings().proactiveRefreshMinutes);
    if (configuredMinutes > 0) {
      const intervalMinutes = Math.max(PROACTIVE_REFRESH_FLOOR_MIN, configuredMinutes);
      credProactiveTimer = setInterval(() => {
        try {
          const minutesNow = Number(credentialManager.getSettings().proactiveRefreshMinutes);
          if (!(minutesNow > 0)) return; // disabled at runtime: skip the tick
          credentialManager.proactiveRefreshSweep().then((result) => {
            // Repaint connected clients only when something changed; the
            // payload is the safe projection (never token material).
            if (result && (result.refreshed > 0 || result.rejected > 0 || result.suspect > 0)) {
              try {
                broadcastSSE('credentials:usage', { profiles: credentialManager.getSafeList().profiles });
              } catch (_) { /* broadcast is best effort */ }
            }
          }).catch((err) => {
            console.warn('[Credentials] proactive refresh sweep failed:', (err && err.message) || err);
          });
        } catch (err) {
          console.warn('[Credentials] proactive refresh tick failed:', (err && err.message) || err);
        }
      }, intervalMinutes * 60 * 1000);
      if (credProactiveTimer.unref) credProactiveTimer.unref();
    }
  } catch (err) {
    console.warn('[Credentials] proactive refresh setup failed:', (err && err.message) || err);
  }

  // Provider account watcher(s): same write-back pattern for the generic
  // account switchers (Codex tab). Auto-captures the live login within
  // ~1s of a CLI login. A start failure only logs; never blocks boot.
  try {
    codexAccountManager.startWatcher();
  } catch (err) {
    console.warn('[ProviderAccounts] watcher failed to start:', err.message);
  }

  // Cleanup tunnels, scheduler, and PTY sessions on shutdown
  const cleanup = () => {
    if (_scheduler) {
      try { _scheduler.stop(); } catch (_) {}
    }
    if (_ptyManager) {
      try { _ptyManager.destroyAll(); } catch (_) {}
    }
    try { credentialManager.stopCredentialWatcher(); } catch (_) {}
    if (credProactiveTimer) {
      try { clearInterval(credProactiveTimer); } catch (_) {}
      credProactiveTimer = null;
    }
    try { codexAccountManager.stopWatcher(); } catch (_) {}
    // Issue #10 Phase 3: stop every mirror tailer (fs.watch handles + timers).
    try { mirrorService.disposeAll(); } catch (_) {}
    for (const [, t] of _tunnels) {
      try { if (t.process) t.process.kill(); } catch {}
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return server;
}

/**
 * Get the PTY manager instance (available after startServer is called).
 * @returns {import('./pty-manager').PtySessionManager|null}
 */
function getPtyManager() {
  return _ptyManager;
}

// ─── Exports ───────────────────────────────────────────────

/**
 * Plan 22-03: invoked by the provider registry when a provider's
 * filesystem watcher (or fallback poll) detects a change. Invalidates
 * the cached discover entry for that provider and broadcasts
 * 'discover:refreshed' so connected SSE clients re-fetch /api/discover.
 *
 * @param {string} providerId
 */
function onProviderDiscoverChange(providerId) {
  if (!providerId || typeof providerId !== 'string') return;
  try { _discoverCache.delete(providerId); } catch (_) {}
  try { broadcastSSE('discover:refreshed', { provider: providerId }); } catch (_) {}
}

module.exports = {
  app,
  startServer,
  getPtyManager,
  structuredError,
  extractCustomTitle,
  onProviderDiscoverChange,
  // Plan 15-01 (DISC-03): exposed for unit tests in
  // test/find-jsonl-refactor.test.js. Production callers do not consume
  // this export; the helper is invoked inline by route handlers above.
  getProviderForSession,
  // Plan 15-02 (DISC-01/02/04/05): exposed for the integration tests in
  // test/discover-route.test.js (cache-spy, snapshot semantics, per-
  // provider invalidation). Production callers do not consume these
  // exports; they are inline state inside the /api/discover handler.
  _discoverCache,
  DISCOVER_CACHE_TTL,
  groupProviderSessionsForUI,
  registry,
  claudeProvider,
  // Plan 16-01 (SRCH-01..04, SRCH-06): exposed for the integration tests in
  // test/search-dispatch.test.js (budget-split assertions, racedSearch
  // shape spying). Production callers do not consume these exports.
  racedSearch,
  SEARCH_TOTAL_BUDGET_MS,
  SEARCH_TIMEOUT_GRACE_MS,
  // Issue #10 Tier 1: exposed for test/mirror-routes.test.js (SSE scoping
  // assertions, watcher-limit setup/teardown) and the Phase 0 liveness test.
  // Production callers go through the /api/mirror/* routes.
  mirrorService,
  LIVE_THRESHOLD_MS,
};
