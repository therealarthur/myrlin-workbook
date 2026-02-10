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
const { execFile } = require('child_process');
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
    return res.json({ raw: null, notes: [], goals: [], tasks: [] });
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
 * PUT /api/workspaces/:id/docs/:section/:index
 * Toggle done state of a goal or task.
 */
app.put('/api/workspaces/:id/docs/:section/:index', requireAuth, (req, res) => {
  const store = getStore();
  const ws = store.getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found.' });

  const { section, index } = req.params;
  if (!['goals', 'tasks'].includes(section)) {
    return res.status(400).json({ error: 'Section must be "goals" or "tasks".' });
  }
  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Invalid index.' });
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
  if (!['notes', 'goals', 'tasks'].includes(section)) {
    return res.status(400).json({ error: 'Section must be "notes", "goals", or "tasks".' });
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
  const session = store.updateSession(req.params.id, req.body);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
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
function generateSessionTitle(firstMessage, recentMessages) {
  // Helper: strip common conversational prefixes
  function stripPrefixes(text) {
    return text
      .replace(/^(hey|hi|hello|ok|okay|so|well|alright|please|pls|now)\b[,.]?\s*/i, '')
      .replace(/^(can you|could you|would you|will you|i need you to|i want you to|i'd like you to|help me|i need to|i want to|let's|lets)\s+/i, '')
      .replace(/^(go ahead and|make sure to|make sure|try to|please)\s+/i, '')
      .trim();
  }

  // Helper: extract the core action phrase from a message
  function extractCoreTopic(text) {
    let cleaned = stripPrefixes(text);
    // Remove trailing punctuation
    cleaned = cleaned.replace(/[.!?]+$/, '').trim();
    // If still starts with common filler, strip again
    cleaned = stripPrefixes(cleaned);
    return cleaned;
  }

  // Helper: smart truncate at word boundary, title case
  function truncateTitle(text, maxLen) {
    if (text.length <= maxLen) return text;
    let truncated = text.substring(0, maxLen);
    // Cut at last word boundary
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.5) {
      truncated = truncated.substring(0, lastSpace);
    }
    return truncated;
  }

  // Helper: capitalize first letter
  function capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Extract topic from first message
  let topic = '';
  if (firstMessage) {
    topic = extractCoreTopic(firstMessage);
    // Take first sentence if multi-sentence
    const sentenceEnd = topic.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < topic.length - 5) {
      topic = topic.substring(0, sentenceEnd);
    }
  }

  // Extract recent focus from last message
  let recentFocus = '';
  if (recentMessages.length > 0) {
    const lastMsg = recentMessages[recentMessages.length - 1];
    recentFocus = extractCoreTopic(lastMsg);
    const sentenceEnd = recentFocus.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < recentFocus.length - 5) {
      recentFocus = recentFocus.substring(0, sentenceEnd);
    }
  }

  let title = '';

  // If only one message or first and recent are similar, use topic
  if (!recentFocus || recentFocus === topic || recentMessages.length <= 1) {
    title = topic || recentFocus || 'Untitled Session';
  } else {
    // Combine: use recent focus as primary, topic provides context
    // Check if recent focus is very short (like "yes" or "do it") — use topic instead
    if (recentFocus.length < 15) {
      title = topic;
    } else {
      title = recentFocus;
    }
  }

  // Final cleanup and truncation
  title = capitalize(truncateTitle(title, 45));

  // If title is too generic or empty, try harder
  if (!title || title.length < 4) {
    title = capitalize(truncateTitle(topic || firstMessage || 'Untitled Session', 45));
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
    // Helper to extract text from a JSONL user message
    function extractUserText(line) {
      try {
        const msg = JSON.parse(line);
        const inner = msg.message || msg;
        const isUser = msg.type === 'user' || msg.type === 'human' || inner.role === 'user';
        if (!isUser) return null;
        const c = inner.content;
        let text = '';
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          const textBlock = c.find(b => b.type === 'text' && b.text);
          if (textBlock) text = textBlock.text;
        }
        // Skip system-generated messages, tool results, very short messages
        if (!text || text.length < 5) return null;
        // Skip messages that look like tool results or system prompts
        if (text.startsWith('<') && text.includes('system-reminder')) return null;
        return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      } catch (_) { return null; }
    }

    const stat = fs.statSync(jsonlPath);
    const fileSize = stat.size;
    let title = '';

    // Strategy: Read the TAIL of the file to get recent activity.
    // Use the last ~30KB for recent messages, which better reflects current work.
    const tailSize = Math.min(30 * 1024, fileSize);
    const tailOffset = Math.max(0, fileSize - tailSize);
    const tailBuf = Buffer.alloc(tailSize);
    const fd = fs.openSync(jsonlPath, 'r');
    const tailBytesRead = fs.readSync(fd, tailBuf, 0, tailSize, tailOffset);

    // Also read first 10KB to get the initial user message as fallback
    const headSize = Math.min(10 * 1024, fileSize);
    const headBuf = Buffer.alloc(headSize);
    const headBytesRead = fs.readSync(fd, headBuf, 0, headSize, 0);
    fs.closeSync(fd);

    // Extract recent user messages from tail
    const tailContent = tailBuf.toString('utf-8', 0, tailBytesRead);
    const tailLines = tailContent.split('\n').filter(l => l.trim());
    // Skip the first line of tail — it's likely a partial line from offset
    if (tailOffset > 0 && tailLines.length > 0) tailLines.shift();

    const recentUserMessages = [];
    for (let i = tailLines.length - 1; i >= 0 && recentUserMessages.length < 3; i--) {
      const text = extractUserText(tailLines[i]);
      if (text) recentUserMessages.unshift(text);
    }

    // Also extract first user message from head for topic context
    const headContent = headBuf.toString('utf-8', 0, headBytesRead);
    const headLines = headContent.split('\n').filter(l => l.trim());
    let firstUserMessage = '';
    for (const line of headLines) {
      const text = extractUserText(line);
      if (text) { firstUserMessage = text; break; }
    }

    // Collect all available user messages for context
    const allMessages = [];
    if (firstUserMessage) allMessages.push(firstUserMessage);
    for (const msg of recentUserMessages) {
      if (msg !== firstUserMessage) allMessages.push(msg);
    }

    if (allMessages.length === 0) {
      return res.status(404).json({ error: 'No user message found in session' });
    }

    // ── Generate a concise title from session content ──
    // Combine messages to understand the session topic
    title = generateSessionTitle(firstUserMessage, recentUserMessages);

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

    // Fetch per-session memory usage and port discovery in parallel
    const claudeSessions = await Promise.all(
      runningSessions.map(async (s) => {
        const [memoryMB, ports] = await Promise.all([
          getProcessMemory(s.pid),
          getProcessPorts(s.pid),
        ]);
        return {
          sessionId: s.id,
          sessionName: s.name || s.id.substring(0, 12),
          pid: s.pid,
          memoryMB: memoryMB || 0,
          ports: ports || [],
          status: s.status,
        };
      })
    );

    const totalClaudeMemoryMB = claudeSessions.reduce((sum, s) => sum + (s.memoryMB || 0), 0);

    res.json({
      system,
      claudeSessions,
      totalClaudeMemoryMB: Math.round(totalClaudeMemoryMB * 10) / 10,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get resources: ' + err.message });
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
