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

const { setupAuth, requireAuth, isValidToken } = require('./auth');
const { getStore } = require('../state/store');
const { launchSession, stopSession, restartSession } = require('../core/session-manager');
const { backupFrontend, restoreFrontend, getBackupStatus } = require('./backup');

// ─── App Creation ──────────────────────────────────────────

const app = express();

// ─── Core Middleware ────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS headers — restrict to localhost origins only
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
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ─── Security Headers ────────────────────────────────────────
app.use((req, res, next) => {
  // Content Security Policy — allow self + inline styles (for dynamic UI) + WebSocket
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:*; " +
    "img-src 'self' data:; font-src 'self';"
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
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    timestamp: new Date().toISOString(),
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
  if (!manifest) return res.status(500).json({ error: 'Restore failed — no backup found' });
  return res.json({ success: true, restored: manifest });
});

// ─── Auth Routes (public, no token required) ───────────────

setupAuth(app);

// ─── Protected API Routes ──────────────────────────────────
// All routes below require a valid Bearer token.

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
  const { name, description, color } = req.body || {};

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
  });

  return res.status(201).json({ workspace });
});

/**
 * PUT /api/workspaces/:id
 * Body: partial workspace fields to update
 */
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

/**
 * PUT /api/workspaces/reorder
 * Body: { order: [...ids] }
 * Saves the sidebar ordering (mix of workspace IDs and group IDs).
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

// ──────────────────────────────────────────────────────────
//  SESSIONS
// ──────────────────────────────────────────────────────────

/**
 * GET /api/sessions
 * Query params:
 *   mode=all          All sessions (default)
 *   mode=workspace    Sessions for a specific workspace (requires workspaceId)
 *   mode=recent       Recently used sessions (optional count)
 *   workspaceId=xxx   Required when mode=workspace
 *   count=N           Number of recent sessions to return (default 10)
 */
app.get('/api/sessions', requireAuth, (req, res) => {
  const store = getStore();
  const mode = req.query.mode || 'all';

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
});

/**
 * POST /api/sessions
 * Body: { name, workspaceId, workingDir?, topic?, command?, resumeSessionId? }
 */
app.post('/api/sessions', requireAuth, (req, res) => {
  const { name, workspaceId, workingDir, topic, command, resumeSessionId } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Session name is required.' });
  }
  if (name.trim().length > 200) {
    return res.status(400).json({ error: 'Session name must be 200 characters or fewer.' });
  }
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required.' });
  }

  const store = getStore();
  const session = store.createSession({
    name: name.trim(),
    workspaceId,
    workingDir: workingDir || '',
    topic: topic || '',
    command: command || 'claude',
    resumeSessionId: resumeSessionId || null,
  });

  if (!session) {
    return res.status(404).json({ error: 'Workspace not found. Cannot create session.' });
  }

  return res.status(201).json({ session });
});

/**
 * PUT /api/sessions/:id
 * Body: partial session fields to update
 */
app.put('/api/sessions/:id', requireAuth, (req, res) => {
  const store = getStore();

  // Capture previous status before applying updates so we can detect
  // running->stopped transitions for auto-summary generation.
  const existingSession = store.getSession(req.params.id);
  const previousStatus = existingSession ? existingSession.status : null;

  const session = store.updateSession(req.params.id, req.body);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  // Auto-generate summary when a session transitions from running to stopped
  // and the workspace has autoSummary enabled (defaults to true).
  const updates = req.body || {};
  if (updates.status === 'stopped' && previousStatus === 'running') {
    const ws = session.workspaceId ? store.getWorkspace(session.workspaceId) : null;
    const autoSummaryEnabled = ws ? (ws.autoSummary !== false) : false;

    if (autoSummaryEnabled) {
      // Generate summary in background so we don't block the response
      setImmediate(() => {
        try {
          const resumeSessionId = session.resumeSessionId || req.params.id;
          const jsonlPath = findJsonlFile(resumeSessionId);
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
          // Best-effort — don't crash on summary failure
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

// ─── Discover Cache (30s TTL) ──────────────────────────────
let _discoverCache = null;
let _discoverCacheTime = 0;
const DISCOVER_CACHE_TTL = 30000; // 30 seconds

/**
 * GET /api/discover
 * Scans ~/.claude/projects/ for all Claude Code sessions.
 * Returns projects with their session counts, paths, and total file sizes.
 * Results are cached in memory for 30 seconds.
 */
app.get('/api/discover', requireAuth, (req, res) => {
  const now = Date.now();
  if (_discoverCache && (now - _discoverCacheTime) < DISCOVER_CACHE_TTL) {
    return res.json(_discoverCache);
  }

  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    const result = { projects: [] };
    _discoverCache = result;
    _discoverCacheTime = now;
    return res.json(result);
  }

  try {
    const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = path.join(claudeDir, entry.name);
      // Decode directory name to real path: C--Users-Jane-Desktop-foo → C:\Users\Jane\Desktop\foo
      const realPath = decodeClaudePath(entry.name);

      // Count .jsonl session files and compute total size
      let sessionFiles = [];
      let totalSize = 0;
      try {
        sessionFiles = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const stat = fs.statSync(path.join(projectDir, f));
            totalSize += stat.size;
            return { name: f.replace('.jsonl', ''), modified: stat.mtime, size: stat.size };
          })
          .sort((a, b) => b.modified - a.modified);
      } catch (_) {
        // skip if can't read
      }

      // Check for CLAUDE.md
      let hasClaudeMd = false;
      try {
        hasClaudeMd = fs.existsSync(path.join(realPath, 'CLAUDE.md'));
      } catch (_) {}

      // Check if directory actually exists
      let dirExists = false;
      try {
        dirExists = fs.existsSync(realPath);
      } catch (_) {}

      projects.push({
        encodedName: entry.name,
        realPath,
        dirExists,
        hasClaudeMd,
        sessionCount: sessionFiles.length,
        totalSize,
        lastActive: sessionFiles.length > 0 ? sessionFiles[0].modified : null,
        sessions: sessionFiles.map(s => ({ name: s.name, modified: s.modified, size: s.size })),
      });
    }

    // Sort by lastActive descending
    projects.sort((a, b) => {
      if (!a.lastActive) return 1;
      if (!b.lastActive) return -1;
      return new Date(b.lastActive) - new Date(a.lastActive);
    });

    const result = { projects };
    _discoverCache = result;
    _discoverCacheTime = now;
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to scan projects: ' + err.message });
  }
});

/**
 * Decode a Claude projects directory name to a real filesystem path.
 * Uses filesystem-aware greedy matching to correctly handle hyphens in directory names.
 *
 * Encoding rules:
 *   "C--"  at start    →  "C:\"          (drive separator)
 *   "--"   in middle   →  "\."           (dot-prefixed dir, e.g. .claude)
 *   "-"    elsewhere   →  "\" OR literal "-"  (ambiguous — resolved via fs)
 *
 * Examples:
 *   C--Users-Jane-Desktop-my-project
 *     → C:\Users\Jane\Desktop\my-project
 *   C--Users-Jane--claude
 *     → C:\Users\Jane\.claude
 */
function decodeClaudePath(encoded) {
  const driveMatch = encoded.match(/^([A-Z])--(.*)/);
  if (!driveMatch) return encoded;

  const drive = driveMatch[1] + ':\\';
  const rest = driveMatch[2];
  if (!rest) return drive;

  // Split on '--' to handle dot-prefixed dirs (Jane--claude → Jane\.claude)
  const majorParts = rest.split('--');
  let resolved = drive;

  for (let i = 0; i < majorParts.length; i++) {
    const part = majorParts[i];
    const dotPrefix = i > 0 ? '.' : '';
    const tokens = part.split('-').filter(t => t.length > 0);

    if (tokens.length === 0) continue;

    // Dot-prefixed segments (after --) are a single directory name
    if (dotPrefix) {
      resolved = path.join(resolved, '.' + tokens.join('-'));
      continue;
    }

    // For regular segments, greedily match against the real filesystem.
    // Try the longest hyphenated name first so "claude-workspace-manager"
    // resolves as ONE directory instead of three.
    let idx = 0;
    while (idx < tokens.length) {
      let matched = false;

      for (let len = tokens.length - idx; len > 1; len--) {
        const candidate = tokens.slice(idx, idx + len).join('-');
        const candidatePath = path.join(resolved, candidate);
        try {
          if (fs.existsSync(candidatePath)) {
            resolved = candidatePath;
            idx += len;
            matched = true;
            break;
          }
        } catch (_) { /* skip */ }
      }

      if (!matched) {
        // Single token — treat as its own directory segment
        resolved = path.join(resolved, tokens[idx]);
        idx++;
      }
    }
  }

  return resolved;
}

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
  // Assistants describe the WORK, users describe the REQUEST — work descriptions make better titles

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
    const fd = fs.openSync(jsonlPath, 'r');
    const headBytesRead = fs.readSync(fd, headBuf, 0, headSize, 0);

    const tailSize = Math.min(50 * 1024, fileSize);
    const tailOffset = Math.max(0, fileSize - tailSize);
    const tailBuf = Buffer.alloc(tailSize);
    const tailBytesRead = fs.readSync(fd, tailBuf, 0, tailSize, tailOffset);
    fs.closeSync(fd);

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
 * POST /api/sessions/:id/summarize
 * Reads the Claude session's .jsonl file and generates a summary
 * of the overall theme and most recent tasking.
 * Also works for project sessions by passing claudeSessionId in body.
 */
app.post('/api/sessions/:id/summarize', requireAuth, (req, res) => {
  const store = getStore();
  // For store sessions, use resumeSessionId. For project sessions, accept direct ID.
  const session = store.getSession(req.params.id);
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

    const earlyMessages = extractMessages(headLines, 5);
    const recentMessages = extractMessages(tailLines.slice(-20), 10);

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
      const realPath = decodeClaudePath(dir.name);
      const projectName = realPath.split('\\').pop() || realPath.split('/').pop() || dir.name;

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
//  COST TRACKING
// ──────────────────────────────────────────────────────────

/** Token pricing per million tokens, by model */
const TOKEN_PRICING = {
  'claude-opus-4-6': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-5-20251101': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4, cacheWrite: 1.00, cacheRead: 0.08 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

/** In-memory cost cache: keyed by sessionId, stores { mtime, result } */
const _costCache = new Map();
const COST_CACHE_TTL = 60000; // 60 seconds

/**
 * Find a JSONL file for a given Claude session UUID by scanning
 * all project directories under ~/.claude/projects/.
 * @param {string} claudeSessionId - The Claude session UUID
 * @returns {string|null} Full path to the .jsonl file, or null if not found
 */
function findJsonlFile(claudeSessionId) {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeProjectsDir)) return null;

  try {
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      const candidate = path.join(claudeProjectsDir, dir.name, claudeSessionId + '.jsonl');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch (_) {}
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
  };
}

/**
 * GET /api/sessions/:id/cost
 * Reads the session's JSONL file and calculates token usage and estimated cost.
 * Results are cached for 60 seconds, invalidated when the file mtime changes.
 */
app.get('/api/sessions/:id/cost', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);

  const resumeSessionId = (session && session.resumeSessionId) || req.params.id;
  if (!resumeSessionId) {
    return res.json({
      sessionId: req.params.id,
      resumeSessionId: null,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
      cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
      modelBreakdown: {},
      messageCount: 0,
      firstMessage: null,
      lastMessage: null,
    });
  }

  const jsonlPath = findJsonlFile(resumeSessionId);
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

    const costData = calculateSessionCost(jsonlPath);
    const result = {
      sessionId: req.params.id,
      resumeSessionId,
      ...costData,
    };

    // Store in cache
    _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to calculate cost: ' + err.message });
  }
});

/**
 * GET /api/workspaces/:id/cost
 * Aggregates token usage and cost across all sessions in a workspace.
 */
app.get('/api/workspaces/:id/cost', requireAuth, (req, res) => {
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

  for (const session of sessions) {
    const resumeSessionId = session.resumeSessionId;
    if (!resumeSessionId) continue;

    const jsonlPath = findJsonlFile(resumeSessionId);
    if (!jsonlPath) continue;

    try {
      // Check cache for individual session cost
      const stat = fs.statSync(jsonlPath);
      const mtimeMs = stat.mtimeMs;
      const cached = _costCache.get(resumeSessionId);
      const now = Date.now();
      let costData;

      if (cached && cached.mtimeMs === mtimeMs && (now - cached.timestamp) < COST_CACHE_TTL) {
        costData = cached.result;
      } else {
        costData = calculateSessionCost(jsonlPath);
        const result = { sessionId: session.id, resumeSessionId, ...costData };
        _costCache.set(resumeSessionId, { mtimeMs, timestamp: now, result });
      }

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
    } catch (_) {
      // Skip sessions whose JSONL files can't be read
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

      const jsonlPath = findJsonlFile(resumeSessionId);
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
          // Only process files under 10MB to avoid blocking
          if (stat.size >= 10 * 1024 * 1024) continue;
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
 * and token usage — ready to paste into a new session.
 * Protected by auth.
 */
app.get('/api/sessions/:id/export-context', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);

  // Support both store sessions and direct Claude UUID
  const claudeSessionId = (session && session.resumeSessionId) || req.params.id;
  const sessionName = (session && session.name) || claudeSessionId || 'Unknown Session';

  if (!claudeSessionId) {
    return res.status(400).json({ error: 'No Claude session ID available' });
  }

  // Find the JSONL file using the shared helper
  const jsonlPath = findJsonlFile(claudeSessionId);

  if (!jsonlPath) {
    // No JSONL file found — return basic info from store session data
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

    // Parse head messages — collect first 5 user messages
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

    // Parse tail messages — collect last 5 assistant messages
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

    // ── Count total messages by reading full file line-by-line ──
    // Use the cost calculation helper which already reads the full file
    // and gives us token usage, cost, and message count
    let costData;
    try {
      costData = calculateSessionCost(jsonlPath);
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

    // Original Request — first user message in full
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

    // Work Done — last 3 assistant messages, truncated to 500 chars each
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

    // Last State — last assistant message content, truncated to 2000 chars
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

  const jsonlPath = findJsonlFile(resumeSessionId);
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
  const content = fs.readFileSync(jsonlPath, 'utf-8');
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
 * POST /api/sessions/:id/summarize
 * Manually generate a summary of a session from its JSONL data.
 * Appends the summary as a timestamped note to the session's workspace docs.
 * Returns the generated summary text.
 */
app.post('/api/sessions/:id/summarize', requireAuth, (req, res) => {
  const store = getStore();
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const resumeSessionId = session.resumeSessionId || req.params.id;
  const jsonlPath = findJsonlFile(resumeSessionId);

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
});

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

  const store = getStore();
  const template = store.createTemplate({
    name: name.trim(),
    command: command || 'claude',
    workingDir: workingDir || '',
    bypassPermissions: bypassPermissions || false,
    verbose: verbose || false,
    model: model || '',
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


// ──────────────────────────────────────────────────────────
//  SSE - Server-Sent Events for live updates
// ──────────────────────────────────────────────────────────

// Track connected SSE clients
const sseClients = new Set();

/**
 * GET /api/events
 * Server-Sent Events endpoint. Streams store events to the browser.
 * Protected by auth (token passed as query param or header).
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

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if proxied

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  // Add client to tracking set
  sseClients.add(res);

  // Clean up on disconnect
  req.on('close', () => {
    sseClients.delete(res);
  });
});

/**
 * Broadcast an SSE event to all connected clients.
 * @param {string} eventType - The event name (e.g. 'workspace:created')
 * @param {object} data - The event payload
 */
function broadcastSSE(eventType, data) {
  const payload = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
  // Send as unnamed event so EventSource.onmessage fires (named events require addEventListener per type)
  const message = `data: ${payload}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (_) {
      // Client may have disconnected; remove it
      sseClients.delete(client);
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

const LAYOUT_FILE = path.join(__dirname, '..', '..', 'state', 'layout.json');

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
    const stateDir = path.join(__dirname, '..', '..', 'state');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
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
  return 0; // First call — no delta yet
}

function getProcessMemory(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 5000 }, (err, stdout) => {
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
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
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
      execFile('wmic', ['process', 'where', `ParentProcessId=${pid}`, 'get', 'ProcessId', '/format:csv'], { timeout: 5000 }, (err, stdout) => {
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
      execFile('pgrep', ['-P', String(pid)], { timeout: 5000 }, (err, stdout) => {
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
        execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, (err, stdout) => {
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
        execFile('lsof', ['-i', '-P', '-n', '-a', '-p', pidArg], { timeout: 5000 }, (err, stdout) => {
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
        { timeout: 5000 }, (err, stdout) => {
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
      execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
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
        const workspaces = store.getState().workspaces || [];
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

function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        return reject(new Error(msg || 'git command failed'));
      }
      resolve(stdout);
    });
  });
}

async function gitRepoRoot(dir) {
  try {
    const root = await gitExec(['rev-parse', '--show-toplevel'], dir);
    return root.trim();
  } catch {
    return null;
  }
}

app.get('/api/git/status', requireAuth, async (req, res) => {
  const dir = req.query.dir;
  if (!dir) return res.status(400).json({ error: 'dir query parameter required' });
  try {
    const root = await gitRepoRoot(dir);
    if (!root) return res.json({ isGitRepo: false });
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
    res.json({ isGitRepo: true, repoRoot: root, branch, dirty, remote, ahead, behind });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/git/branches', requireAuth, async (req, res) => {
  const dir = req.query.dir;
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

    try {
      // Fetch latest from remote
      execSync('git fetch origin main --quiet', { cwd: appDir, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });

      // Check how many commits behind
      const behindOutput = execSync('git rev-list HEAD..origin/main --count', { cwd: appDir, timeout: 5000, encoding: 'utf-8' }).trim();
      commitsBehind = parseInt(behindOutput, 10) || 0;
      updateAvailable = commitsBehind > 0;

      // Get the latest commit message from remote
      if (updateAvailable) {
        const latestMsg = execSync('git log origin/main -1 --format=%s', { cwd: appDir, timeout: 5000, encoding: 'utf-8' }).trim();
        remoteVersion = `${currentVersion}+${commitsBehind}`;
      }
    } catch (_) {
      // Git operations may fail if not a git repo or no network
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
      const installOutput = execSync('npm install --production', { cwd: appDir, timeout: 120000, encoding: 'utf-8' });
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

    // Step 4: Signal restart
    sendStep('restart', 'running', 'Restarting server in 2 seconds...');
    res.end();

    // Graceful restart after response is sent
    setTimeout(() => {
      process.exit(0); // Process manager (pm2/systemd) or user will restart
    }, 2000);

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
  return new Promise((resolve) => {
    execFile('cloudflared', ['--version'], { timeout: 5000 }, (err, stdout) => {
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
//  SESSION SEARCH (full-text across all JSONL files)
// ──────────────────────────────────────────────────────────

// ─── Search File List Cache (30s TTL) ──────────────────────
let _searchFileCache = null;
let _searchFileCacheTime = 0;
const SEARCH_FILE_CACHE_TTL = 30000; // 30 seconds

/**
 * Build a list of all JSONL session files under ~/.claude/projects/.
 * Returns an array of { filePath, sessionId, projectDir, encodedName, realPath, projectName }.
 * Cached in memory for 30 seconds.
 */
function getSearchableFiles() {
  const now = Date.now();
  if (_searchFileCache && (now - _searchFileCacheTime) < SEARCH_FILE_CACHE_TTL) {
    return _searchFileCache;
  }

  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) {
    _searchFileCache = [];
    _searchFileCacheTime = now;
    return _searchFileCache;
  }

  const files = [];
  try {
    const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = path.join(claudeDir, entry.name);
      const realPath = decodeClaudePath(entry.name);
      const projectName = realPath.split('\\').pop() || realPath.split('/').pop() || entry.name;

      try {
        const dirFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        for (const f of dirFiles) {
          files.push({
            filePath: path.join(projectDir, f),
            sessionId: f.replace('.jsonl', ''),
            projectDir,
            encodedName: entry.name,
            realPath,
            projectName,
          });
        }
      } catch (_) {
        // Skip directories that can't be read
      }
    }
  } catch (_) {
    // If the top-level read fails, return empty
  }

  _searchFileCache = files;
  _searchFileCacheTime = now;
  return files;
}

/**
 * Extract a session name from the first user or assistant message content
 * in a JSONL file (first 50 chars), or fall back to the session UUID.
 * @param {string} filePath - Path to the .jsonl file
 * @param {string} sessionId - Fallback UUID
 * @returns {string} A human-readable session name
 */
function extractSessionName(filePath, sessionId) {
  try {
    // Read just the first 10KB to find the first meaningful message
    const fd = fs.openSync(filePath, 'r');
    const headSize = Math.min(10 * 1024, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(headSize);
    fs.readSync(fd, buf, 0, headSize, 0);
    fs.closeSync(fd);

    const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const inner = entry.message || entry;
        const role = entry.type || inner.role;
        if (role !== 'user' && role !== 'human' && role !== 'assistant') continue;

        const c = inner.content;
        let text = '';
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          const textBlocks = c.filter(b => b.type === 'text' && b.text);
          text = textBlocks.map(b => b.text).join(' ');
        }
        // Skip system-generated and very short messages
        if (!text || text.length < 5) continue;
        if (text.startsWith('<') && text.includes('system-reminder')) continue;

        // Clean up and truncate to 50 chars
        text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 50) {
          text = text.substring(0, 50).replace(/\s+\S*$/, '') + '...';
        }
        return text;
      } catch (_) {
        // Skip unparseable lines
      }
    }
  } catch (_) {
    // Fall through to UUID
  }
  return sessionId;
}

/**
 * GET /api/search?q=<query>&limit=20
 * Full-text search across all Claude Code JSONL session files.
 * Searches the message.content field (both string and array forms) case-insensitively.
 * Returns matches with ~200 char snippets, sorted by timestamp descending.
 * Protected by auth. Enforces a 5-second timeout, returning partial results if exceeded.
 */
app.get('/api/search', requireAuth, (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" must be at least 2 characters.' });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const searchQuery = query.trim().toLowerCase();
  const startTime = Date.now();
  const TIMEOUT_MS = 5000; // 5-second timeout

  const files = getSearchableFiles();
  const results = [];
  let totalMatches = 0;
  let searchedFiles = 0;
  let timedOut = false;

  for (const fileInfo of files) {
    // Check timeout before processing each file
    if (Date.now() - startTime > TIMEOUT_MS) {
      timedOut = true;
      break;
    }

    searchedFiles++;

    let content;
    try {
      content = fs.readFileSync(fileInfo.filePath, 'utf-8');
    } catch (_) {
      continue; // Skip files that can't be read
    }

    const lines = content.split('\n');
    let sessionName = null; // Lazy — computed on first match

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      // Check timeout inside large files too
      if (Date.now() - startTime > TIMEOUT_MS) {
        timedOut = true;
        break;
      }

      const line = lines[lineIdx];
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue; // Skip corrupt/binary lines
      }

      const inner = entry.message || entry;
      const role = entry.type || inner.role;
      if (role !== 'user' && role !== 'human' && role !== 'assistant') continue;

      const c = inner.content;
      let text = '';
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        const textBlocks = c.filter(b => b.type === 'text' && b.text);
        text = textBlocks.map(b => b.text).join('');
      }

      if (!text) continue;

      // Case-insensitive search
      const lowerText = text.toLowerCase();
      const matchIndex = lowerText.indexOf(searchQuery);
      if (matchIndex === -1) continue;

      totalMatches++;

      // Only collect up to `limit` result objects
      if (results.length < limit) {
        // Lazy-load session name on first match for this file
        if (sessionName === null) {
          sessionName = extractSessionName(fileInfo.filePath, fileInfo.sessionId);
        }

        // Build ~200 char snippet around the match
        const snippetRadius = 100;
        const snippetStart = Math.max(0, matchIndex - snippetRadius);
        const snippetEnd = Math.min(text.length, matchIndex + searchQuery.length + snippetRadius);
        let snippet = text.substring(snippetStart, snippetEnd)
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (snippetStart > 0) snippet = '...' + snippet;
        if (snippetEnd < text.length) snippet = snippet + '...';

        // Extract timestamp from the entry
        const timestamp = entry.timestamp || null;

        results.push({
          sessionId: fileInfo.sessionId,
          sessionName,
          projectPath: fileInfo.realPath,
          projectName: fileInfo.projectName,
          timestamp,
          role: (role === 'human') ? 'user' : role,
          snippet,
          lineNumber: lineIdx + 1, // 1-based line number
        });
      }
    }

    if (timedOut) break;
  }

  // Sort by timestamp descending (most recent first); null timestamps go last
  results.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  const durationMs = Date.now() - startTime;

  return res.json({
    query: query.trim(),
    results,
    totalMatches,
    searchedFiles,
    durationMs,
    timedOut,
  });
});

// ──────────────────────────────────────────────────────────
//  CONFLICT DETECTION (per workspace)
// ──────────────────────────────────────────────────────────

/**
 * GET /api/workspaces/:id/conflicts
 * Checks if multiple running sessions in a workspace are modifying the same files.
 * Runs `git status --porcelain` in each session's workingDir to discover modified files,
 * then cross-references to find overlapping edits.
 * Protected by auth.
 */
app.get('/api/workspaces/:id/conflicts', requireAuth, (req, res) => {
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

  // Collect modified files per session
  // Map: sessionId → { id, name, files: string[] }
  const sessionFiles = new Map();
  let checkedSessions = 0;

  for (const session of runningSessions) {
    try {
      const stdout = execSync('git status --porcelain', {
        cwd: session.workingDir,
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr output
      });

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

        // Extract filename — for renamed files (R), the new name is after " -> "
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
      // git status failed (not a git repo, timeout, etc.) — skip this session
      checkedSessions++;
    }
  }

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

function startServer(port = 3456) {
  // Wire store events to SSE before accepting connections
  attachStoreEvents();

  const server = app.listen(port, () => {
    // Server is ready - caller handles the log message
  });

  // Keep-alive for SSE connections
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  // Attach PTY WebSocket server
  const { attachPtyWebSocket } = require('./pty-server');
  const { ptyWss, ptyManager } = attachPtyWebSocket(server);
  _ptyManager = ptyManager;

  // Cleanup tunnels on shutdown
  const cleanupTunnels = () => {
    for (const [, t] of _tunnels) {
      try { if (t.process) t.process.kill(); } catch {}
    }
  };
  process.on('SIGINT', cleanupTunnels);
  process.on('SIGTERM', cleanupTunnels);

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

module.exports = {
  app,
  startServer,
  getPtyManager,
};
