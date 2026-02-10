/**
 * Core state store for Claude Workspace Manager
 * Handles JSON persistence, CRUD operations, and state transitions.
 * All state is persisted to ./state/workspaces.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const docsManager = require('./docs-manager');

const STATE_DIR = path.join(__dirname, '..', '..', 'state');
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const STATE_FILE = path.join(STATE_DIR, 'workspaces.json');
const BACKUP_FILE = path.join(STATE_DIR, 'workspaces.backup.json');
const MAX_TIMESTAMPED_BACKUPS = 10; // Keep last N timestamped backups

// Default state shape
const MAX_RECENT = 10;

const DEFAULT_STATE = {
  version: 1,
  workspaces: {},
  sessions: {},
  activeWorkspace: null,
  recentSessions: [], // Last N session IDs, most recent last
  workspaceGroups: {},    // { groupId: { id, name, color, workspaceIds: [], order: 0 } }
  workspaceOrder: [],     // mixed array of workspace IDs and group IDs for sidebar ordering
  templates: {},          // { templateId: { id, name, command, workingDir, ... } }
  settings: {
    autoRecover: true,
    notificationLevel: 'all', // 'all' | 'errors' | 'none'
    theme: 'dark',
    confirmBeforeClose: true,
  },
};

class Store extends EventEmitter {
  constructor() {
    super();
    this._state = null;
    this._dirty = false;
    this._saveTimer = null;
  }

  /**
   * Initialize the store - load from disk or create default
   */
  init() {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    docsManager.ensureDocsDir();
    // Create a timestamped backup BEFORE loading (preserves last known good state)
    this.createTimestampedBackup();
    this._state = this._load();
    return this;
  }

  /**
   * Load state from disk
   */
  _load() {
    // Try primary state file
    const loaded = this._tryLoadFile(STATE_FILE);
    if (loaded) return loaded;

    // Try rolling backup
    console.warn('[Store] Primary state file missing or corrupt, trying backup...');
    const backup = this._tryLoadFile(BACKUP_FILE);
    if (backup) {
      console.warn('[Store] Recovered from workspaces.backup.json');
      return backup;
    }

    // Try timestamped backups (newest first)
    if (fs.existsSync(BACKUP_DIR)) {
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('workspaces-') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const file of backups) {
        const recovered = this._tryLoadFile(path.join(BACKUP_DIR, file));
        if (recovered) {
          console.warn('[Store] Recovered from timestamped backup:', file);
          return recovered;
        }
      }
    }

    console.warn('[Store] No state files found, starting with defaults');
    return { ...DEFAULT_STATE };
  }

  /**
   * Try to load and parse a state file. Returns merged state or null.
   */
  _tryLoadFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (!raw.trim()) return null; // Empty file
      const parsed = JSON.parse(raw);
      if (!parsed.workspaces) return null; // Invalid structure
      return {
        ...DEFAULT_STATE,
        ...parsed,
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        workspaceGroups: parsed.workspaceGroups || {},
        workspaceOrder: parsed.workspaceOrder || [],
        templates: parsed.templates || {},
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Save state to disk (with backup).
   * Uses write-to-temp-then-rename for atomic writes on crash.
   */
  save() {
    try {
      // Backup current file before overwriting
      if (fs.existsSync(STATE_FILE)) {
        fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      }
      // Atomic write: write to temp file, then rename over the target.
      // If the process is killed mid-write, the temp file is lost but
      // the original STATE_FILE (or BACKUP_FILE) survives intact.
      const tmpFile = STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this._state, null, 2), 'utf-8');
      fs.renameSync(tmpFile, STATE_FILE);
      this._dirty = false;
    } catch (err) {
      this.emit('error', { type: 'save_failed', error: err.message });
    }
  }

  /**
   * Create a timestamped backup. Called on server startup to preserve
   * state before any mutations. Keeps up to MAX_TIMESTAMPED_BACKUPS files.
   */
  createTimestampedBackup() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(BACKUP_DIR, `workspaces-${ts}.json`);
      fs.copyFileSync(STATE_FILE, backupFile);

      // Prune old backups, keep only the most recent N
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('workspaces-') && f.endsWith('.json'))
        .sort();
      while (backups.length > MAX_TIMESTAMPED_BACKUPS) {
        const oldest = backups.shift();
        try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch (_) {}
      }
    } catch (err) {
      console.error('[Store] Failed to create timestamped backup:', err.message);
    }
  }

  /**
   * Debounced save - batches rapid changes
   */
  _debouncedSave() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 150);
  }

  // ─── Getters ─────────────────────────────────────────────

  get state() { return this._state; }
  get workspaces() { return this._state.workspaces; }
  get sessions() { return this._state.sessions; }
  get settings() { return this._state.settings; }
  get activeWorkspace() { return this._state.activeWorkspace; }

  getWorkspace(id) { return this._state.workspaces[id] || null; }
  getSession(id) { return this._state.sessions[id] || null; }

  getWorkspaceSessions(workspaceId) {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return [];
    return ws.sessions.map(sid => this._state.sessions[sid]).filter(Boolean);
  }

  getActiveWorkspace() {
    if (!this._state.activeWorkspace) return null;
    return this.getWorkspace(this._state.activeWorkspace);
  }

  getAllWorkspacesList() {
    return Object.values(this._state.workspaces).sort((a, b) =>
      new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)
    );
  }

  getAllSessionsList() {
    return Object.values(this._state.sessions).sort((a, b) =>
      new Date(b.lastActive || b.createdAt) - new Date(a.lastActive || a.createdAt)
    );
  }

  // ─── Workspace CRUD ──────────────────────────────────────

  createWorkspace({ name, description = '', color = 'cyan' }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const workspace = {
      id,
      name,
      description,
      color,
      sessions: [],
      createdAt: now,
      lastActive: now,
    };
    this._state.workspaces[id] = workspace;
    // Auto-activate if first workspace
    if (!this._state.activeWorkspace) {
      this._state.activeWorkspace = id;
    }
    this.save(); // Immediate save — workspace creation is critical
    this.emit('workspace:created', workspace);
    return workspace;
  }

  updateWorkspace(id, updates) {
    const ws = this._state.workspaces[id];
    if (!ws) return null;
    Object.assign(ws, updates, { lastActive: new Date().toISOString() });
    this._debouncedSave();
    this.emit('workspace:updated', ws);
    return ws;
  }

  deleteWorkspace(id) {
    const ws = this._state.workspaces[id];
    if (!ws) return false;
    // Remove associated sessions
    for (const sid of ws.sessions) {
      delete this._state.sessions[sid];
    }
    delete this._state.workspaces[id];
    if (this._state.activeWorkspace === id) {
      const remaining = Object.keys(this._state.workspaces);
      this._state.activeWorkspace = remaining.length > 0 ? remaining[0] : null;
    }
    // Clean up workspace documentation file
    docsManager.deleteDocs(id);
    this.save(); // Immediate save — workspace deletion is critical
    this.emit('workspace:deleted', { id });
    return true;
  }

  setActiveWorkspace(id) {
    if (!this._state.workspaces[id]) return false;
    this._state.activeWorkspace = id;
    this.save(); // Immediate save — active workspace is critical
    this.emit('workspace:activated', this._state.workspaces[id]);
    return true;
  }

  // ─── Session CRUD ────────────────────────────────────────

  createSession({ name, workspaceId, workingDir = '', topic = '', command = 'claude', resumeSessionId = null }) {
    if (!this._state.workspaces[workspaceId]) return null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session = {
      id,
      name,
      workspaceId,
      workingDir,
      topic,
      command,
      resumeSessionId,
      status: 'stopped', // 'running' | 'stopped' | 'error' | 'idle'
      pid: null,
      createdAt: now,
      lastActive: now,
      logs: [],
    };
    this._state.sessions[id] = session;
    this._state.workspaces[workspaceId].sessions.push(id);
    this._state.workspaces[workspaceId].lastActive = now;
    this.save(); // Immediate save — session creation is critical
    this.emit('session:created', session);
    return session;
  }

  updateSession(id, updates) {
    const session = this._state.sessions[id];
    if (!session) return null;

    // Handle workspace move — update both workspace session arrays
    if (updates.workspaceId && updates.workspaceId !== session.workspaceId) {
      const oldWs = this._state.workspaces[session.workspaceId];
      const newWs = this._state.workspaces[updates.workspaceId];
      if (!newWs) return null; // Target workspace doesn't exist
      if (oldWs) {
        oldWs.sessions = oldWs.sessions.filter(sid => sid !== id);
      }
      newWs.sessions.push(id);
    }

    Object.assign(session, updates, { lastActive: new Date().toISOString() });
    // Status changes and workspace moves save immediately, other updates debounce
    if (updates.status || updates.pid !== undefined || updates.workspaceId) {
      this.save();
    } else {
      this._debouncedSave();
    }
    this.emit('session:updated', session);
    return session;
  }

  deleteSession(id) {
    const session = this._state.sessions[id];
    if (!session) return false;
    // Remove from workspace
    const ws = this._state.workspaces[session.workspaceId];
    if (ws) {
      ws.sessions = ws.sessions.filter(sid => sid !== id);
    }
    delete this._state.sessions[id];
    this.save(); // Immediate save — deletion is critical
    this.emit('session:deleted', { id });
    return true;
  }

  updateSessionStatus(id, status, pid = null) {
    return this.updateSession(id, { status, pid });
  }

  addSessionLog(id, message) {
    const session = this._state.sessions[id];
    if (!session) return;
    session.logs = session.logs || [];
    session.logs.push({ time: new Date().toISOString(), message });
    // Keep last 100 log entries
    if (session.logs.length > 100) {
      session.logs = session.logs.slice(-100);
    }
    this._debouncedSave();
    this.emit('session:log', { id, message });
  }

  // ─── Recent Sessions ─────────────────────────────────────

  /**
   * Mark a session as recently interacted with (moves to front of recents)
   */
  touchRecent(sessionId) {
    if (!this._state.sessions[sessionId]) return;
    this._state.recentSessions = this._state.recentSessions || [];
    // Remove if already present, then add to end (most recent)
    this._state.recentSessions = this._state.recentSessions.filter(id => id !== sessionId);
    this._state.recentSessions.push(sessionId);
    // Trim to max
    if (this._state.recentSessions.length > MAX_RECENT) {
      this._state.recentSessions = this._state.recentSessions.slice(-MAX_RECENT);
    }
    this._debouncedSave();
  }

  /**
   * Get recent session objects (most recent first)
   */
  getRecentSessions(count = MAX_RECENT) {
    const ids = (this._state.recentSessions || []).slice(-count).reverse();
    return ids.map(id => this._state.sessions[id]).filter(Boolean);
  }

  // ─── Workspace Groups ───────────────────────────────────

  /**
   * Create a new workspace group.
   * @param {{ name: string, color?: string }} params
   * @returns {object} The created group
   */
  createGroup({ name, color = 'blue' }) {
    const id = crypto.randomUUID();
    const group = {
      id,
      name,
      color,
      workspaceIds: [],
      order: Object.keys(this._state.workspaceGroups).length,
    };
    this._state.workspaceGroups[id] = group;
    this._state.workspaceOrder.push(id);
    this.save();
    this.emit('group:created', group);
    return group;
  }

  /**
   * Update a workspace group's name, color, or workspaceIds.
   * @param {string} id - Group ID
   * @param {object} updates - Partial group fields
   * @returns {object|null} Updated group or null if not found
   */
  updateGroup(id, updates) {
    const group = this._state.workspaceGroups[id];
    if (!group) return null;
    // Only allow safe fields to be updated
    if (updates.name !== undefined) group.name = updates.name;
    if (updates.color !== undefined) group.color = updates.color;
    if (updates.workspaceIds !== undefined) group.workspaceIds = updates.workspaceIds;
    if (updates.order !== undefined) group.order = updates.order;
    this.save();
    this.emit('group:updated', group);
    return group;
  }

  /**
   * Delete a workspace group. Workspaces in the group become ungrouped.
   * @param {string} id - Group ID
   * @returns {boolean} True if deleted
   */
  deleteGroup(id) {
    const group = this._state.workspaceGroups[id];
    if (!group) return false;
    // Remove group from workspaceOrder
    this._state.workspaceOrder = this._state.workspaceOrder.filter(oid => oid !== id);
    // Workspaces that were in this group are now ungrouped (they stay in workspaceOrder individually)
    delete this._state.workspaceGroups[id];
    this.save();
    this.emit('group:deleted', { id });
    return true;
  }

  /**
   * Move a workspace into a group. Removes it from any existing group first.
   * @param {string} workspaceId
   * @param {string} groupId
   * @returns {boolean} True on success
   */
  moveWorkspaceToGroup(workspaceId, groupId) {
    const group = this._state.workspaceGroups[groupId];
    if (!group) return false;
    if (!this._state.workspaces[workspaceId]) return false;
    // Remove from any existing group
    this._removeWorkspaceFromAllGroups(workspaceId);
    // Add to the target group
    if (!group.workspaceIds.includes(workspaceId)) {
      group.workspaceIds.push(workspaceId);
    }
    // Remove workspace from top-level workspaceOrder since it's now in a group
    this._state.workspaceOrder = this._state.workspaceOrder.filter(oid => oid !== workspaceId);
    this.save();
    this.emit('group:updated', group);
    return true;
  }

  /**
   * Remove a workspace from whichever group it belongs to (becomes ungrouped).
   * @param {string} workspaceId
   * @returns {boolean} True if it was removed from a group
   */
  removeWorkspaceFromGroup(workspaceId) {
    const removed = this._removeWorkspaceFromAllGroups(workspaceId);
    if (removed) {
      // Add back to top-level workspaceOrder if not already there
      if (!this._state.workspaceOrder.includes(workspaceId)) {
        this._state.workspaceOrder.push(workspaceId);
      }
      this.save();
      this.emit('workspaces:reordered', this._state.workspaceOrder);
    }
    return removed;
  }

  /**
   * Internal: remove a workspace from all groups.
   * @param {string} workspaceId
   * @returns {boolean} True if it was in any group
   */
  _removeWorkspaceFromAllGroups(workspaceId) {
    let found = false;
    for (const group of Object.values(this._state.workspaceGroups)) {
      const idx = group.workspaceIds.indexOf(workspaceId);
      if (idx !== -1) {
        group.workspaceIds.splice(idx, 1);
        found = true;
      }
    }
    return found;
  }

  /**
   * Set the full ordering of workspaces and groups in the sidebar.
   * @param {string[]} orderedIds - Mixed array of workspace IDs and group IDs
   */
  reorderWorkspaces(orderedIds) {
    this._state.workspaceOrder = orderedIds;
    this.save();
    this.emit('workspaces:reordered', orderedIds);
  }

  /**
   * Get all workspace groups as an array.
   * @returns {object[]}
   */
  getAllGroups() {
    return Object.values(this._state.workspaceGroups);
  }

  // ─── Workspace Documentation ─────────────────────────────

  /**
   * Get parsed documentation for a workspace.
   * @param {string} workspaceId
   * @returns {{ raw: string, notes: Array, goals: Array, tasks: Array } | null}
   */
  getWorkspaceDocs(workspaceId) {
    if (!this._state.workspaces[workspaceId]) return null;
    return docsManager.readDocs(workspaceId);
  }

  /**
   * Replace the entire workspace documentation with raw markdown.
   * @param {string} workspaceId
   * @param {string} content - Raw markdown
   */
  updateWorkspaceDocs(workspaceId, content) {
    if (!this._state.workspaces[workspaceId]) return null;
    docsManager.writeDocs(workspaceId, content);
    this.emit('docs:updated', { workspaceId });
  }

  /**
   * Add a timestamped note to workspace documentation.
   * @param {string} workspaceId
   * @param {string} text
   */
  addWorkspaceNote(workspaceId, text) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return null;
    docsManager.appendNote(workspaceId, ws.name, text);
    this.emit('docs:updated', { workspaceId, section: 'notes' });
  }

  /**
   * Add a goal to workspace documentation.
   * @param {string} workspaceId
   * @param {string} text
   */
  addWorkspaceGoal(workspaceId, text) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return null;
    docsManager.appendGoal(workspaceId, ws.name, text);
    this.emit('docs:updated', { workspaceId, section: 'goals' });
  }

  /**
   * Add a task to workspace documentation.
   * @param {string} workspaceId
   * @param {string} text
   */
  addWorkspaceTask(workspaceId, text) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return null;
    docsManager.appendTask(workspaceId, ws.name, text);
    this.emit('docs:updated', { workspaceId, section: 'tasks' });
  }

  /**
   * Toggle done state of a goal or task.
   * @param {string} workspaceId
   * @param {string} section - 'goals' or 'tasks'
   * @param {number} index
   */
  toggleWorkspaceItem(workspaceId, section, index) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return false;
    const result = docsManager.toggleItem(workspaceId, ws.name, section, index);
    if (result) this.emit('docs:updated', { workspaceId, section });
    return result;
  }

  /**
   * Remove an item from workspace documentation.
   * @param {string} workspaceId
   * @param {string} section - 'notes', 'goals', 'tasks', or 'roadmap'
   * @param {number} index
   */
  removeWorkspaceItem(workspaceId, section, index) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return false;
    const result = docsManager.removeItem(workspaceId, ws.name, section, index);
    if (result) this.emit('docs:updated', { workspaceId, section });
    return result;
  }

  /**
   * Add a roadmap item to workspace documentation.
   * @param {string} workspaceId
   * @param {string} text
   * @param {string} [status='planned'] - 'planned' | 'active' | 'done'
   */
  addWorkspaceRoadmapItem(workspaceId, text, status = 'planned') {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return;
    docsManager.appendRoadmapItem(workspaceId, ws.name, text, status);
    this.emit('docs:updated', { workspaceId, section: 'roadmap' });
  }

  /**
   * Cycle a roadmap item's status: planned -> active -> done -> planned.
   * @param {string} workspaceId
   * @param {number} index
   * @returns {boolean} success
   */
  cycleWorkspaceRoadmapStatus(workspaceId, index) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return false;
    const result = docsManager.cycleRoadmapStatus(workspaceId, ws.name, index);
    if (result) this.emit('docs:updated', { workspaceId, section: 'roadmap' });
    return result;
  }

  addWorkspaceRule(workspaceId, text) {
    const ws = this._state.workspaces[workspaceId];
    if (!ws) return;
    docsManager.appendRule(workspaceId, ws.name, text);
    this.emit('docs:updated', { workspaceId });
  }

  // ─── Session Templates ──────────────────────────────────

  /**
   * Create a new session template.
   * @param {{ name: string, command?: string, workingDir?: string, bypassPermissions?: boolean, verbose?: boolean, model?: string, agentTeams?: boolean }} params
   * @returns {object} The created template
   */
  createTemplate({ name, command = 'claude', workingDir = '', bypassPermissions = false, verbose = false, model = '', agentTeams = false }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const template = {
      id,
      name,
      command,
      workingDir,
      bypassPermissions,
      verbose,
      model,
      agentTeams,
      createdAt: now,
    };
    this._state.templates[id] = template;
    this.save();
    this.emit('template:created', template);
    return template;
  }

  /**
   * List all session templates.
   * @returns {object[]} Array of template objects sorted by creation date (newest first)
   */
  listTemplates() {
    return Object.values(this._state.templates).sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  /**
   * Get a single template by ID.
   * @param {string} id - Template ID
   * @returns {object|null} The template or null if not found
   */
  getTemplate(id) {
    return this._state.templates[id] || null;
  }

  /**
   * Delete a template by ID.
   * @param {string} id - Template ID
   * @returns {boolean} True if deleted, false if not found
   */
  deleteTemplate(id) {
    if (!this._state.templates[id]) return false;
    delete this._state.templates[id];
    this.save();
    this.emit('template:deleted', { id });
    return true;
  }

  // ─── Settings ────────────────────────────────────────────

  updateSettings(updates) {
    Object.assign(this._state.settings, updates);
    this._debouncedSave();
    this.emit('settings:updated', this._state.settings);
  }

  // ─── Cleanup ─────────────────────────────────────────────

  destroy() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._dirty) this.save();
  }
}

// Singleton
let instance = null;
function getStore() {
  if (!instance) {
    instance = new Store().init();

    // Flush pending saves on process exit to prevent data loss
    const flushOnExit = () => {
      if (instance && instance._dirty) {
        try { instance.save(); } catch (_) {}
      }
    };
    process.on('exit', flushOnExit);
    process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
    process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });
    process.on('uncaughtException', (err) => {
      console.error('[Store] Uncaught exception, flushing state:', err.message);
      flushOnExit();
    });
  }
  return instance;
}

module.exports = { Store, getStore };
