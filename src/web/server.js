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
const express = require('express');

const { setupAuth, requireAuth, isValidToken } = require('./auth');
const { getStore } = require('../state/store');
const { launchSession, stopSession, restartSession } = require('../core/session-manager');

// ─── App Creation ──────────────────────────────────────────

const app = express();

// ─── Core Middleware ────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS headers for local development (GUI may run on a different port)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ─── Static Files ──────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Debug Middleware ─────────────────────────────────────────
// Log every request to trace auth issues

app.use((req, res, next) => {
  const hasAuth = !!req.headers.authorization;
  const hasQueryToken = !!req.query.token;
  console.log(`[REQ] ${req.method} ${req.originalUrl} auth-header:${hasAuth} query-token:${hasQueryToken}`);
  next();
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

  return res.json({ workspaces });
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
      // Decode directory name to real path: C--Users-Arthur-Desktop-foo → C:\Users\Arthur\Desktop\foo
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
 *   C--Users-Arthur-Desktop-claude-workspace-manager
 *     → C:\Users\Arthur\Desktop\claude-workspace-manager
 *   C--Users-Arthur--claude
 *     → C:\Users\Arthur\.claude
 */
function decodeClaudePath(encoded) {
  const driveMatch = encoded.match(/^([A-Z])--(.*)/);
  if (!driveMatch) return encoded;

  const drive = driveMatch[1] + ':\\';
  const rest = driveMatch[2];
  if (!rest) return drive;

  // Split on '--' to handle dot-prefixed dirs (Arthur--claude → Arthur\.claude)
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
 * POST /api/sessions/:id/auto-title
 * Reads the Claude session's .jsonl file and generates a title
 * from the first user message or conversation content.
 */
app.post('/api/sessions/:id/auto-title', requireAuth, (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const claudeSessionId = session.resumeSessionId;
  if (!claudeSessionId) {
    return res.status(400).json({ error: 'Session has no Claude conversation to read' });
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
    // Read first 50KB to find user messages (don't read huge files)
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(50 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const content = buf.toString('utf-8', 0, bytesRead);
    const lines = content.split('\n').filter(l => l.trim());

    let title = '';

    // Look for the first human/user message
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        // Claude JSONL format: { role: 'user', content: ... } or { type: 'human', ... }
        if (msg.role === 'user' || msg.type === 'human') {
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            // Content blocks: [{ type: 'text', text: '...' }]
            const textBlock = msg.content.find(b => b.type === 'text');
            if (textBlock) text = textBlock.text;
          } else if (msg.message && typeof msg.message === 'string') {
            text = msg.message;
          }

          if (text) {
            // Clean and truncate to make a title
            title = text
              .replace(/[\r\n]+/g, ' ')  // collapse newlines
              .replace(/\s+/g, ' ')       // collapse whitespace
              .trim();
            // Truncate to ~60 chars at word boundary
            if (title.length > 60) {
              title = title.substring(0, 60).replace(/\s+\S*$/, '') + '...';
            }
            break;
          }
        }
      } catch (_) { /* skip malformed lines */ }
    }

    if (!title) {
      return res.status(404).json({ error: 'No user message found in session' });
    }

    // Update the session name
    store.updateSession(req.params.id, { name: title });
    return res.json({ success: true, title });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read session: ' + err.message });
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
  const rawUrl = req.originalUrl;
  const queryObj = req.query;
  const token = req.query.token || null;
  const valid = isValidToken(token);

  console.log('[SSE] ===== SSE CONNECTION ATTEMPT =====');
  console.log('[SSE] Raw URL:', rawUrl);
  console.log('[SSE] req.query:', JSON.stringify(queryObj));
  console.log('[SSE] Token present:', !!token);
  console.log('[SSE] Token (first 16):', token ? token.substring(0, 16) : 'NONE');
  console.log('[SSE] Token length:', token ? token.length : 0);
  console.log('[SSE] isValidToken result:', valid);
  console.log('[SSE] typeof isValidToken:', typeof isValidToken);
  console.log('[SSE] =====================================');

  if (!valid) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid token required. Pass ?token=<token> query parameter.',
      debug: {
        tokenPresent: !!token,
        tokenLength: token ? token.length : 0,
        queryKeys: Object.keys(queryObj),
        rawUrl: rawUrl,
        isValidTokenType: typeof isValidToken,
        handlerReached: true,
      },
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
