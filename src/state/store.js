/**
 * Core state store for Claude Workspace Manager
 * Handles JSON persistence, CRUD operations, and state transitions.
 * All state is persisted to ~/.myrlin/workspaces.json so that every
 * launch method (npm run gui, npx, global install) shares the same data.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const docsManager = require('./docs-manager');
const { expandHome } = require('../utils/path-utils');
const { getDataDir, migrateFromLegacy } = require('../utils/data-dir');

// Legacy project-local state dir (for migration on first run)
const LEGACY_STATE_DIR = path.join(__dirname, '..', '..', 'state');

const STATE_DIR = getDataDir();
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const STATE_FILE = path.join(STATE_DIR, 'workspaces.json');
const BACKUP_FILE = path.join(STATE_DIR, 'workspaces.backup.json');
// Backup retention. Three tiers protect against different failure modes:
//   1. Rolling ring: the N most-recent backups. Tuned big enough that a crash
//      loop on startup can't evict every historical snapshot (10 was too small
//      on 2026-05-11 — a 10-restart loop ate the entire backup history).
//   2. Daily tier: one backup per calendar day for the last N days.
//   3. Weekly tier: one backup per ISO week for the last N weeks.
// A backup is kept if it qualifies for ANY tier. The tiers compose, so worst
// case is: ring (50) + daily (30) + weekly (8) ≈ 88 files. JSON is small.
const MAX_TIMESTAMPED_BACKUPS = 50;
const TIERED_DAILY_DAYS = 30;
const TIERED_WEEKLY_WEEKS = 8;

// Default state shape
const MAX_RECENT = 10;

const DEFAULT_STATE = {
  version: 2,
  workspaces: {},
  sessions: {},
  activeWorkspace: null,
  recentSessions: [], // Last N session IDs, most recent last
  workspaceGroups: {},    // { groupId: { id, name, color, workspaceIds: [], order: 0 } }
  workspaceOrder: [],     // mixed array of workspace IDs and group IDs for sidebar ordering
  templates: {},          // { templateId: { id, name, command, workingDir, ... } }
  features: {},           // { featureId: { id, workspaceId, name, description, status, priority, sessionIds, ... } }
  worktreeTasks: {},      // { taskId: { id, workspaceId, sessionId, featureId, branch, worktreePath, repoDir, description, baseBranch, status, createdAt, completedAt } }
  pushDevices: [],        // [{ token: string, platform: 'ios' | 'android', registeredAt: string }]
  pairedDevices: [],      // [{ deviceId, token, deviceName, platform, appVersion, pairedAt, lastSeenAt, expiresAt, pushToken, pushPreferences }]
  // Ad-hoc per-(provider, providerSessionId) settings bundle.
  // For discovered Codex Desktop sessions opened via right-click "Open in
  // Terminal" there is no Myrlin store record (the session lives in
  // ~/.codex/sessions/), so per-session provider-settings have nowhere to
  // live on state.sessions. This slot stores them keyed by the upstream
  // CLI's session UUID instead. pty-manager.spawnSession looks here when
  // no store record exists. Phase 21 Plan 21-01 alpha.6 fix.
  providerSessionSettings: {}, // { [providerId]: { [uuid]: { ...settings } } }
  settings: {
    autoRecover: true,
    notificationLevel: 'all', // 'all' | 'errors' | 'none'
    theme: 'dark',
    confirmBeforeClose: true,
    tdBinary: '',              // Absolute path to td binary (empty = use $TD_BINARY env or 'td')
    enableTd: true,            // Show td issue tracking integration
    providers: { claude: true, codex: false }, // gsd:provider-literal-allowed - bootstrap default providers map for v1.2 multi-provider support
  },
};

/**
 * Pure idempotent migration from state schema v1 to v2.
 *
 * v2 adds:
 *   - state.version === 2 (was 1)
 *   - state.settings.providers = { claude: true, codex: false } (default if missing)
 *   - every session entry gets a `provider` field (defaults to 'claude' if missing) gsd:provider-literal-allowed
 *
 * Idempotency: passing a state already at v2 returns it unchanged (same reference).
 * Defense in depth: this is the explicit migration; _tryLoadFile also normalizes
 * sessions on read so unexpected pre-v2 entries get tagged on the way in too.
 *
 * Throws if the input is not a usable object, or if state.sessions is the wrong
 * shape (e.g. a string). Throws are propagated by Store.init() to refuse-to-start.
 *
 * @param {object} state - The pre-migration state object.
 * @returns {object} A new v2 state object (or `state` unchanged if already v2).
 */
function migrateStateV1toV2(state) {
  if (state === null || state === undefined || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('migrateStateV1toV2: input is not an object');
  }
  // Already migrated, return same reference for cheap idempotency
  if (state.version === 2) return state;
  // Allow null/undefined version (very-old state) AND version === 1; reject anything else
  if (state.version !== undefined && state.version !== null && state.version !== 1) {
    throw new Error('migrateStateV1toV2: unsupported version ' + state.version);
  }
  // Validate sessions shape BEFORE iterating (catches the corrupt fixture case)
  if (state.sessions !== undefined && state.sessions !== null
      && (typeof state.sessions !== 'object' || Array.isArray(state.sessions))) {
    throw new Error('migrateStateV1toV2: state.sessions is not an object');
  }

  // Tag every session with provider: 'claude' (input wins on conflict via spread order) gsd:provider-literal-allowed
  const sessions = {};
  for (const [sid, s] of Object.entries(state.sessions || {})) {
    sessions[sid] = { provider: 'claude', ...s }; // gsd:provider-literal-allowed - default-tag legacy sessions
  }

  // Build providers default; preserve any user-set fields (input wins on conflict)
  const existingProviders = (state.settings && state.settings.providers) || {};
  const settings = {
    ...(state.settings || {}),
    providers: {
      claude: true, // gsd:provider-literal-allowed - bootstrap default
      codex: false, // gsd:provider-literal-allowed - bootstrap default
      ...existingProviders,
    },
  };

  return { ...state, version: 2, sessions, settings };
}

class Store extends EventEmitter {
  constructor() {
    super();
    this._state = null;
    this._dirty = false;
    this._saveTimer = null;
    this._lastDiskMtimeMs = 0; // Track last known mtime for cross-process sync
    // Shape-drift detector: track the workspace count we last saw on disk so we
    // can refuse saves that 10x it (a near-certain sign of test pollution or
    // corruption). Initialized after load/save. 2026-05-11 incident reference.
    this._lastKnownWorkspaceCount = 0;
  }

  /**
   * Initialize the store - load from disk or create default.
   *
   * Migration ordering:
   *   1. migrateFromLegacy moves project-local state into ~/.myrlin/ (filesystem).
   *   2. _load() reads the file (with read-side normalization in _tryLoadFile).
   *   3. migrateStateV1toV2 explicitly bumps schema; if it throws, refuse to start.
   *   4. _migrateBackupFiles walks BACKUP_FILE + BACKUP_DIR UNCONDITIONALLY so a
   *      partial-launch (live=v2, backup=v1) heals on the next boot. Per-file
   *      idempotency guard inside makes this cheap when nothing needs doing.
   */
  init() {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    // Migrate legacy project-local state to ~/.myrlin/ on first run
    migrateFromLegacy(LEGACY_STATE_DIR);
    docsManager.ensureDocsDir();
    // Create a timestamped backup BEFORE loading (preserves last known good state)
    this.createTimestampedBackup();
    this._state = this._load();
    // ── State migration v1 -> v2 ────────────────────────────────
    // Explicit schema migration. Failure here is FATAL: the live state file
    // is the source of truth; if we cannot interpret it, we refuse to start
    // rather than risk silently overwriting it with default state.
    try {
      const before = this._state;
      this._state = migrateStateV1toV2(this._state);
      if (this._state !== before) {
        // Persist the migrated shape immediately via the existing atomic-save path.
        this._dirty = true;
        this.save();
      }
    } catch (err) {
      const msg = '[Store] FATAL: state migration failed for ' + STATE_FILE + ': ' + err.message + '\n'
        + 'The server cannot start. Inspect the file for corruption or restore from a backup in ' + BACKUP_DIR + '.';
      console.error(msg);
      throw new Error(msg);
    }
    // Backups are migrated UNCONDITIONALLY on every init() with a per-file
    // idempotency guard inside _migrateBackupFiles. This catches the
    // partial-launch hole where the live file is already v2 but a backup is
    // still v1 (e.g. a previous boot crashed mid-migration). Failures here
    // are non-fatal: the live file is the source of truth.
    try {
      this._migrateBackupFiles();
    } catch (err) {
      console.warn('[Store] _migrateBackupFiles unexpected error: ' + err.message);
    }
    this._recordDiskMtime();
    this._recordWorkspaceBaseline();
    return this;
  }

  /**
   * Walk BACKUP_FILE and every workspaces-*.json in BACKUP_DIR, migrating any
   * v1 entries to v2 in place via an atomic temp-file-then-rename write.
   *
   * Idempotency: per-file `if (parsed.version === 2) continue` makes this a
   * cheap no-op on subsequent boots when nothing needs doing.
   *
   * Failure isolation: a single corrupt backup logs a warning and does NOT
   * abort the walk; the live file already migrated successfully so backup
   * recovery is best-effort.
   */
  _migrateBackupFiles() {
    const files = [];
    if (fs.existsSync(BACKUP_FILE)) files.push(BACKUP_FILE);
    if (fs.existsSync(BACKUP_DIR)) {
      try {
        for (const f of fs.readdirSync(BACKUP_DIR)) {
          if (f.startsWith('workspaces-') && f.endsWith('.json')) {
            files.push(path.join(BACKUP_DIR, f));
          }
        }
      } catch (err) {
        console.warn('[Store] _migrateBackupFiles: could not list ' + BACKUP_DIR + ': ' + err.message);
      }
    }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(f, 'utf-8');
        if (!raw.trim()) continue; // empty file - skip
        const parsed = JSON.parse(raw);
        // Per-file idempotency guard: cheap no-op when nothing to do
        if (parsed && parsed.version === 2) continue;
        const migrated = migrateStateV1toV2(parsed);
        const tmp = f + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(migrated, null, 2), 'utf-8');
        fs.renameSync(tmp, f);
        console.log('[Store] Migrated backup to v2: ' + f);
      } catch (err) {
        // Backup migration is best-effort; log and continue.
        console.warn('[Store] Backup migration failed for ' + f + ': ' + err.message + '; leaving as-is');
      }
    }
  }

  /**
   * Record the current mtime of the state file for cross-process sync detection.
   */
  _recordDiskMtime() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this._lastDiskMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
      }
    } catch (_) {
      // Ignore stat errors
    }
  }

  /**
   * Update the baseline workspace count used by the shape-drift detector.
   * Called after any successful load or save so a legitimate growth (user
   * adding workspaces over time) doesn't trip the guard later.
   */
  _recordWorkspaceBaseline() {
    try {
      this._lastKnownWorkspaceCount = Object.keys((this._state && this._state.workspaces) || {}).length;
    } catch (_) {
      this._lastKnownWorkspaceCount = 0;
    }
  }

  /**
   * Detect suspicious state drift that almost certainly indicates test pollution
   * or corruption. Returns a string reason if the save should be aborted, or
   * null if safe.
   *
   * Checks:
   *   1. Count balloon: in-memory workspaces > 10x last known AND > 50 absolute.
   *      Real users don't 10x their workspace count between saves; test scripts do.
   *   2. Test-shaped names: > 50 workspaces named like pty-test-*, codex-test-*,
   *      test-*, recovery-test-*. Even ONE legitimate workspace with that name
   *      is rare; 50+ means a test script polluted the store.
   *
   * Both can be bypassed with CWM_LARGE_STATE_OK=1 for legitimate bulk imports.
   *
   * History: on 2026-05-11 a misconfigured test wrote 1019 pty-test-ws-* and
   * codex-test-ws-* workspaces over the real production state. This guard would
   * have caught it BEFORE the bad save landed on disk.
   */
  _checkShapeDrift() {
    if (process.env.CWM_LARGE_STATE_OK === '1') return null;
    const wss = (this._state && this._state.workspaces) || {};
    const currentCount = Object.keys(wss).length;

    // Check 1: count balloon
    const lastCount = this._lastKnownWorkspaceCount;
    if (lastCount > 0 && currentCount > 50 && currentCount > lastCount * 10) {
      return 'workspaces count ballooned from ' + lastCount + ' to ' + currentCount
        + ' (>10x). Set CWM_LARGE_STATE_OK=1 to override.';
    }

    // Check 2: test-shaped names
    let testShaped = 0;
    for (const w of Object.values(wss)) {
      if (/^(pty-test|codex-test|test-|recovery-test)/i.test(w.name || '')) testShaped++;
    }
    if (testShaped > 50) {
      return testShaped + ' workspaces have test-shaped names (pty-test-*, codex-test-*, test-*). '
        + 'Set CWM_LARGE_STATE_OK=1 to override.';
    }

    return null;
  }

  /**
   * Common abort path for the shape-drift detector. Logs loudly, emits an
   * error event, and dumps the rejected state to disk for forensic review
   * (NOT a backup — it sits next to STATE_FILE with a .rejected suffix so
   * it's obvious it isn't authoritative).
   */
  _handleShapeDriftAbort(drift) {
    console.error('[Store] SHAPE DRIFT DETECTED, refusing to save:', drift);
    this.emit('error', { type: 'shape_drift', error: drift });
    try {
      const dump = STATE_FILE + '.rejected.' + Date.now() + '.json';
      fs.writeFileSync(dump, JSON.stringify(this._state, null, 2), 'utf-8');
      console.error('[Store] Rejected in-memory state dumped to ' + dump
        + ' for review. Disk state is unchanged.');
    } catch (e) {
      console.error('[Store] Could not dump rejected state: ' + e.message);
    }
  }

  /**
   * Check if another process has modified the state file since we last read it.
   * If so, reload from disk. Enables TUI/GUI cross-process state sync.
   */
  checkDiskSync() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const currentMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
      if (currentMtimeMs > this._lastDiskMtimeMs) {
        const reloaded = this._load();
        if (reloaded) {
          this._state = reloaded;
          this._lastDiskMtimeMs = currentMtimeMs;
          this._recordWorkspaceBaseline();
          this.emit('state:reloaded');
        }
      }
    } catch (_) {
      // Ignore stat/read errors; serve from memory as fallback
    }
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
   *
   * Read-side defensive default: every session loaded without a `provider`
   * field is normalized to `provider: 'claude'`. This is layered defense in gsd:provider-literal-allowed
   * addition to the explicit migrateStateV1toV2 call in init(), so any
   * pre-v2 entry that slips through (e.g. a backup recovered after the
   * explicit migration ran) still gets tagged on the way in. (MIG-02)
   *
   * If parsed.sessions is the wrong shape we skip normalization here and
   * let migrateStateV1toV2 throw with a useful message during init().
   */
  _tryLoadFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (!raw.trim()) return null; // Empty file
      const parsed = JSON.parse(raw);
      if (!parsed.workspaces) return null; // Invalid structure
      // Normalize sessions on read: tag missing provider field with 'claude'. gsd:provider-literal-allowed
      // Skip if shape is wrong; migrateStateV1toV2 will throw with detail later.
      let normalizedSessions;
      if (parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
        normalizedSessions = {};
        for (const [sid, s] of Object.entries(parsed.sessions)) {
          if (s && typeof s === 'object') {
            normalizedSessions[sid] = { provider: 'claude', ...s }; // gsd:provider-literal-allowed - read-side defensive default
          } else {
            normalizedSessions[sid] = s; // pass through; migration will throw if non-object
          }
        }
      } else {
        normalizedSessions = parsed.sessions; // pass through wrong shape so migration can flag it
      }
      return {
        ...DEFAULT_STATE,
        ...parsed,
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        sessions: normalizedSessions,
        workspaceGroups: parsed.workspaceGroups || {},
        workspaceOrder: parsed.workspaceOrder || [],
        templates: parsed.templates || {},
        features: parsed.features || {},
        pushDevices: parsed.pushDevices || [],
        pairedDevices: parsed.pairedDevices || [],
        providerSessionSettings: parsed.providerSessionSettings && typeof parsed.providerSessionSettings === 'object' && !Array.isArray(parsed.providerSessionSettings)
          ? parsed.providerSessionSettings
          : {},
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Save state to disk (with backup).
   * Uses write-to-temp-then-rename for atomic writes on crash.
   * Verifies written data after rename to detect zero-fill corruption.
   */
  save() {
    // Shape-drift detector runs BEFORE we touch disk so a polluted in-memory
    // state can't overwrite a good file. Bypass with CWM_LARGE_STATE_OK=1.
    const drift = this._checkShapeDrift();
    if (drift) {
      this._handleShapeDriftAbort(drift);
      return;
    }
    try {
      // Only backup current file if it contains real data (not zero-filled)
      if (fs.existsSync(STATE_FILE)) {
        if (this._isFileValid(STATE_FILE)) {
          fs.copyFileSync(STATE_FILE, BACKUP_FILE);
        } else {
          console.warn('[Store] Skipping backup of corrupt primary file');
        }
      }
      // Atomic write: write to PID-unique temp file, then rename over the target.
      // PID suffix prevents collisions when TUI and GUI write concurrently.
      const json = JSON.stringify(this._state, null, 2);
      const tmpFile = STATE_FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmpFile, json, 'utf-8');

      // Verify the temp file before renaming: re-read and check for zero-fill
      // corruption (Windows write-cache failure mode)
      const written = fs.readFileSync(tmpFile, 'utf-8');
      if (!written.trim() || written.charCodeAt(0) === 0) {
        console.error('[Store] CORRUPTION DETECTED: temp file is zero-filled, aborting save');
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        this.emit('error', { type: 'save_corruption', error: 'Written file was zero-filled' });
        return;
      }
      // Sanity check: verify it parses as valid JSON with workspaces
      try {
        const check = JSON.parse(written);
        if (!check.workspaces) {
          throw new Error('Missing workspaces key');
        }
      } catch (parseErr) {
        console.error('[Store] CORRUPTION DETECTED: temp file not valid JSON, aborting save');
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        this.emit('error', { type: 'save_corruption', error: parseErr.message });
        return;
      }

      fs.renameSync(tmpFile, STATE_FILE);

      // Post-rename verification: re-read the final file to catch filesystem-level corruption
      try {
        const final = fs.readFileSync(STATE_FILE, 'utf-8');
        if (!final.trim() || final.charCodeAt(0) === 0) {
          console.error('[Store] POST-RENAME CORRUPTION: primary file is zero-filled after rename');
          // Restore from backup if available
          if (fs.existsSync(BACKUP_FILE) && this._isFileValid(BACKUP_FILE)) {
            fs.copyFileSync(BACKUP_FILE, STATE_FILE);
            console.warn('[Store] Restored primary from backup after corruption');
          }
        }
      } catch (_) {}

      this._recordDiskMtime();
      this._recordWorkspaceBaseline();
      this._dirty = false;
    } catch (err) {
      this.emit('error', { type: 'save_failed', error: err.message });
    }
  }

  /**
   * Check if a file contains real data (not zero-filled or empty).
   * Returns false for zero-filled files, empty files, or unreadable files.
   * @param {string} filePath - Path to check
   * @returns {boolean} true if the file has valid non-zero content
   */
  _isFileValid(filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length === 0) return false;
      // Check first 64 bytes for any non-zero content
      const checkLen = Math.min(buf.length, 64);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] !== 0) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /**
   * Create a timestamped backup. Called on server startup to preserve
   * state before any mutations. Retains backups in three composing tiers
   * (rolling ring + daily + weekly) so a single crash loop cannot evict
   * the entire backup history. See MAX_TIMESTAMPED_BACKUPS constant block
   * for tier sizes.
   */
  createTimestampedBackup() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      // Never back up a corrupt/zero-filled file
      if (!this._isFileValid(STATE_FILE)) {
        console.warn('[Store] Skipping timestamped backup: primary file is corrupt/zero-filled');
        return;
      }
      // Defense in depth: never back up a file that would trip the shape-drift
      // detector. Otherwise we'd dutifully back up the 1019-test-workspace
      // pollution and immediately evict the clean backup that sits next to it.
      const baselineCheck = this._checkShapeDriftOnFile(STATE_FILE);
      if (baselineCheck) {
        console.warn('[Store] Skipping timestamped backup: ' + baselineCheck);
        return;
      }
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(BACKUP_DIR, `workspaces-${ts}.json`);
      fs.copyFileSync(STATE_FILE, backupFile);

      this._pruneBackups();
    } catch (err) {
      console.error('[Store] Failed to create timestamped backup:', err.message);
    }
  }

  /**
   * Re-run the shape-drift heuristics on a file on disk (not the in-memory
   * state). Used by createTimestampedBackup to refuse archiving a file that
   * already looks polluted. Returns a reason string if the file looks bad,
   * or null if it's clean.
   */
  _checkShapeDriftOnFile(filePath) {
    if (process.env.CWM_LARGE_STATE_OK === '1') return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw);
      const wss = (parsed && parsed.workspaces) || {};
      const count = Object.keys(wss).length;
      let testShaped = 0;
      for (const w of Object.values(wss)) {
        if (/^(pty-test|codex-test|test-|recovery-test)/i.test(w.name || '')) testShaped++;
      }
      if (testShaped > 50) {
        return 'file contains ' + testShaped + ' test-shaped workspace names — likely polluted.';
      }
      if (this._lastKnownWorkspaceCount > 0
          && count > 50
          && count > this._lastKnownWorkspaceCount * 10) {
        return 'file has ' + count + ' workspaces, prior baseline ' + this._lastKnownWorkspaceCount
          + ' (>10x ratio) — likely polluted.';
      }
      return null;
    } catch (_) {
      // Couldn't parse — leave it to the existing _isFileValid path.
      return null;
    }
  }

  /**
   * Parse a backup filename to its Date. Filenames look like
   * "workspaces-2026-05-13T08-38-03-412Z.json" (the stock createTimestampedBackup
   * format with colons/dots replaced by hyphens). Returns null on malformed input.
   */
  _parseBackupTimestamp(filename) {
    const m = filename.match(/^workspaces-(.+)\.json$/);
    if (!m) return null;
    const stamp = m[1];
    const tIdx = stamp.indexOf('T');
    if (tIdx < 0) return null;
    const date = stamp.slice(0, tIdx);
    const time = stamp.slice(tIdx + 1);
    // time is like '08-38-03-412Z'; last hyphen separates seconds from millis
    const lastHyphen = time.lastIndexOf('-');
    if (lastHyphen < 0) return null;
    const hms = time.slice(0, lastHyphen).replace(/-/g, ':');
    const msZ = time.slice(lastHyphen + 1);
    const iso = date + 'T' + hms + '.' + msZ;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Decide which timestamped backups to keep and delete the rest. A backup
   * survives if it qualifies for ANY retention tier:
   *
   *   - Rolling: one of the MAX_TIMESTAMPED_BACKUPS most-recent
   *   - Daily:   the most recent backup of its calendar day, for the
   *              last TIERED_DAILY_DAYS days
   *   - Weekly:  the most recent backup of its week-bucket, for the
   *              last TIERED_WEEKLY_WEEKS weeks
   */
  _pruneBackups() {
    let entries = [];
    try {
      entries = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('workspaces-') && f.endsWith('.json'));
    } catch (_) {
      return;
    }
    const parsed = entries
      .map((f) => ({ file: f, date: this._parseBackupTimestamp(f) }))
      .filter((e) => e.date)
      .sort((a, b) => b.date.getTime() - a.date.getTime()); // newest first

    const keep = new Set();
    // Tier 1: rolling ring
    for (let i = 0; i < Math.min(parsed.length, MAX_TIMESTAMPED_BACKUPS); i++) {
      keep.add(parsed[i].file);
    }
    // Tier 2: daily
    const dayClaim = new Set();
    const now = Date.now();
    const dayMs = 86400000;
    for (const e of parsed) {
      const ageDays = (now - e.date.getTime()) / dayMs;
      if (ageDays > TIERED_DAILY_DAYS) break;
      const dayKey = Math.floor(e.date.getTime() / dayMs);
      if (!dayClaim.has(dayKey)) {
        dayClaim.add(dayKey);
        keep.add(e.file);
      }
    }
    // Tier 3: weekly
    const weekClaim = new Set();
    const weekMs = 7 * dayMs;
    for (const e of parsed) {
      const ageWeeks = (now - e.date.getTime()) / weekMs;
      if (ageWeeks > TIERED_WEEKLY_WEEKS) break;
      const weekKey = Math.floor(e.date.getTime() / weekMs);
      if (!weekClaim.has(weekKey)) {
        weekClaim.add(weekKey);
        keep.add(e.file);
      }
    }

    // Delete everything not kept. Anything that couldn't be parsed (e.g., a
    // hand-renamed file the user wants to preserve) is left alone.
    for (const e of parsed) {
      if (!keep.has(e.file)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, e.file)); } catch (_) {}
      }
    }
  }

  /**
   * Async save - performs all disk I/O off the event loop.
   * Falls back to sync save() on error.
   */
  async saveAsync() {
    // Shape-drift detector runs BEFORE we touch disk. Same guard as save().
    const drift = this._checkShapeDrift();
    if (drift) {
      this._handleShapeDriftAbort(drift);
      return;
    }
    try {
      const json = JSON.stringify(this._state, null, 2);
      const tmpFile = STATE_FILE + '.' + process.pid + '.tmp';

      // Backup current file if it exists and is valid
      if (fs.existsSync(STATE_FILE) && this._isFileValid(STATE_FILE)) {
        await fs.promises.copyFile(STATE_FILE, BACKUP_FILE);
      }

      await fs.promises.writeFile(tmpFile, json, 'utf-8');

      // Verify temp file before rename
      const written = await fs.promises.readFile(tmpFile, 'utf-8');
      if (!written.trim() || written.charCodeAt(0) === 0) {
        console.error('[Store] CORRUPTION DETECTED in async save, aborting');
        try { await fs.promises.unlink(tmpFile); } catch (_) {}
        return;
      }
      try {
        const check = JSON.parse(written);
        if (!check.workspaces) throw new Error('Missing workspaces key');
      } catch (parseErr) {
        console.error('[Store] CORRUPTION DETECTED: invalid JSON in async save');
        try { await fs.promises.unlink(tmpFile); } catch (_) {}
        return;
      }

      await fs.promises.rename(tmpFile, STATE_FILE);
      this._recordDiskMtime();
      this._recordWorkspaceBaseline();
      this._dirty = false;
    } catch (err) {
      console.error('[Store] Async save failed, falling back to sync:', err.message);
      this.save();
    }
  }

  /**
   * Debounced save - batches rapid changes, uses async I/O
   * to avoid blocking the event loop during frequent updates.
   */
  _debouncedSave() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveAsync(), 150);
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

  /**
   * Get sessions with pagination, filtering, sorting, and search.
   * Returns a subset of sessions plus pagination metadata.
   *
   * @param {Object} options - Query options
   * @param {number} [options.limit=50] - Max sessions to return (clamped 1-100)
   * @param {number} [options.offset=0] - Number of sessions to skip (min 0)
   * @param {string} [options.status='all'] - Filter by status: running, stopped, error, idle, or all
   * @param {string} [options.sort='lastActive'] - Sort field: lastActive, name, or created
   * @param {string} [options.order='desc'] - Sort direction: asc or desc
   * @param {string} [options.search] - Case-insensitive substring match on name and topic
   * @param {string} [options.workspaceId] - Filter to sessions in a specific workspace
   * @returns {{ sessions: Array, total: number, limit: number, offset: number, hasMore: boolean }}
   */
  getPaginatedSessions(options = {}) {
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 50));
    const offset = Math.max(0, parseInt(options.offset, 10) || 0);
    const status = options.status || 'all';
    const sort = options.sort || 'lastActive';
    const order = options.order || 'desc';
    const search = options.search ? options.search.toLowerCase() : null;
    const workspaceId = options.workspaceId || null;

    // Start with all sessions
    let filtered = Object.values(this._state.sessions);

    // Filter by workspaceId
    if (workspaceId) {
      filtered = filtered.filter(s => s.workspaceId === workspaceId);
    }

    // Filter by status
    if (status !== 'all') {
      filtered = filtered.filter(s => s.status === status);
    }

    // Filter by search (case-insensitive substring on name and topic)
    if (search) {
      filtered = filtered.filter(s => {
        const name = (s.name || '').toLowerCase();
        const topic = (s.topic || '').toLowerCase();
        return name.includes(search) || topic.includes(search);
      });
    }

    // Sort
    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sort) {
        case 'name':
          cmp = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
          break;
        case 'created':
          cmp = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
          break;
        case 'lastActive':
        default:
          cmp = new Date(a.lastActive || a.createdAt || 0) - new Date(b.lastActive || b.createdAt || 0);
          break;
      }
      return order === 'asc' ? cmp : -cmp;
    });

    // Calculate total before slicing
    const total = filtered.length;

    // Slice for pagination
    const sessions = filtered.slice(offset, offset + limit);

    return {
      sessions,
      total,
      limit,
      offset,
      hasMore: (offset + sessions.length) < total,
    };
  }

  // ─── Workspace CRUD ──────────────────────────────────────

  createWorkspace({ name, description = '', color = 'cyan', icon = null }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const workspace = {
      id,
      name,
      description,
      color,
      icon,
      sessions: [],
      createdAt: now,
      lastActive: now,
      autoSummary: true,  // Auto-generate session summaries on stop
    };
    this._state.workspaces[id] = workspace;
    // Auto-activate if first workspace
    if (!this._state.activeWorkspace) {
      this._state.activeWorkspace = id;
    }
    this.save(); // Immediate save - workspace creation is critical
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
    this.save(); // Immediate save - workspace deletion is critical
    this.emit('workspace:deleted', { id });
    return true;
  }

  setActiveWorkspace(id) {
    if (!this._state.workspaces[id]) return false;
    this._state.activeWorkspace = id;
    this.save(); // Immediate save - active workspace is critical
    this.emit('workspace:activated', this._state.workspaces[id]);
    return true;
  }

  // ─── Session CRUD ────────────────────────────────────────

  createSession({ name, workspaceId, workingDir = '', topic = '', command = 'claude', resumeSessionId = null, tags = [], initialPrompt = null, flags = [] }) { // gsd:provider-literal-allowed (v1.1 back-compat default; refactor deferred to Phase 15+)
    if (!this._state.workspaces[workspaceId]) return null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session = {
      id,
      name,
      workspaceId,
      workingDir: expandHome(workingDir) || '',
      topic,
      command,
      resumeSessionId,
      status: 'stopped', // 'running' | 'stopped' | 'error' | 'idle'
      pid: null,
      tags: Array.isArray(tags) ? tags : [],
      initialPrompt: initialPrompt || null,  // One-shot prompt for first launch
      flags: Array.isArray(flags) ? flags : [],  // Extra CLI flags (e.g. --dangerously-skip-permissions)
      createdAt: now,
      lastActive: now,
      logs: [],
    };
    this._state.sessions[id] = session;
    this._state.workspaces[workspaceId].sessions.push(id);
    this._state.workspaces[workspaceId].lastActive = now;
    this.save(); // Immediate save - session creation is critical
    this.emit('session:created', session);
    return session;
  }

  updateSession(id, updates) {
    const session = this._state.sessions[id];
    if (!session) return null;

    // Handle workspace move - update both workspace session arrays
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
    this.save(); // Immediate save - deletion is critical
    this.emit('session:deleted', { id });
    return true;
  }

  updateSessionStatus(id, status, pid = null) {
    return this.updateSession(id, { status, pid });
  }

  /**
   * Persist per-session provider settings (Phase 21 Plan 21-01).
   *
   * Shape:
   *   session.providerSettings = { [providerId]: { ...settings } }
   *
   * Per-provider merging: the new settings object REPLACES the existing
   * bundle for that providerId. Other providers' bundles on the same
   * session are untouched. Caller is responsible for shallow-merging if
   * a partial update is desired (the route currently sends a full
   * canonical bundle, so replace-on-write is the right default).
   *
   * @param {string} sessionId
   * @param {string} providerId - Provider id string (registry-issued).
   * @param {Object} settings - The canonical settings bundle to persist.
   * @returns {Object|null} Updated session or null if not found.
   */
  updateSessionProviderSettings(sessionId, providerId, settings) {
    const session = this._state.sessions[sessionId];
    if (!session) return null;
    if (!session.providerSettings || typeof session.providerSettings !== 'object') {
      session.providerSettings = {};
    }
    session.providerSettings[providerId] = settings;
    session.lastActive = new Date().toISOString();
    this.save();
    this.emit('session:updated', session);
    return session;
  }

  /**
   * Read ad-hoc provider settings keyed by (providerId, upstreamSessionId).
   *
   * Used for sessions that exist only in the upstream provider's storage
   * (e.g. a Codex Desktop session in ~/.codex/sessions/) and have no
   * Myrlin store record. Returns null when no bundle is set so the caller
   * can fall back to defaults or skip.
   *
   * @param {string} providerId - Registry-issued provider id.
   * @param {string} upstreamSessionId - Provider-native session UUID
   *   (Codex rollout UUID, Claude session UUID, etc.).
   * @returns {Object|null} Settings bundle or null.
   */
  getProviderSessionSettings(providerId, upstreamSessionId) {
    if (!providerId || !upstreamSessionId) return null;
    const root = this._state.providerSessionSettings;
    if (!root || typeof root !== 'object') return null;
    const byProvider = root[providerId];
    if (!byProvider || typeof byProvider !== 'object') return null;
    const bundle = byProvider[upstreamSessionId];
    return bundle && typeof bundle === 'object' ? bundle : null;
  }

  /**
   * Persist ad-hoc provider settings for an upstream session UUID. Used by
   * the PUT /api/sessions/:id/provider-settings route when no Myrlin store
   * record exists for the session id.
   *
   * Behavior:
   *   - Replaces (does not merge) the existing bundle for that
   *     (providerId, upstreamSessionId) pair. Caller sends the canonical
   *     full bundle each PUT so this matches the in-store behavior.
   *   - Initializes the nested objects lazily.
   *   - Saves immediately (settings changes are user-intent; durability
   *     matters even if the user closes the tab right after).
   *
   * @param {string} providerId
   * @param {string} upstreamSessionId
   * @param {Object} settings
   * @returns {Object} The persisted bundle.
   */
  setProviderSessionSettings(providerId, upstreamSessionId, settings) {
    if (!this._state.providerSessionSettings || typeof this._state.providerSessionSettings !== 'object') {
      this._state.providerSessionSettings = {};
    }
    if (!this._state.providerSessionSettings[providerId] || typeof this._state.providerSessionSettings[providerId] !== 'object') {
      this._state.providerSessionSettings[providerId] = {};
    }
    this._state.providerSessionSettings[providerId][upstreamSessionId] = settings;
    this.save();
    this.emit('providerSessionSettings:updated', { providerId, upstreamSessionId });
    return settings;
  }

  /**
   * Read the effective provider settings for a session, with fallback to
   * the per-provider defaults in `state.settings.providerDefaults[providerId]`.
   * Used by the route handler so the UI sees defaults when a session has
   * no overrides yet.
   *
   * @param {string} sessionId
   * @param {string} providerId
   * @returns {Object} Settings bundle (may be empty object).
   */
  getSessionProviderSettings(sessionId, providerId) {
    const session = this._state.sessions[sessionId];
    const fromSession = session
      && session.providerSettings
      && typeof session.providerSettings === 'object'
      && session.providerSettings[providerId]
      && typeof session.providerSettings[providerId] === 'object'
      ? session.providerSettings[providerId]
      : null;
    if (fromSession) return fromSession;
    const defaults = this._state.settings
      && this._state.settings.providerDefaults
      && typeof this._state.settings.providerDefaults === 'object'
      && this._state.settings.providerDefaults[providerId]
      && typeof this._state.settings.providerDefaults[providerId] === 'object'
      ? this._state.settings.providerDefaults[providerId]
      : {};
    return defaults;
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
    const session = this._state.sessions[sessionId];
    if (!session) return;
    // Update lastActive timestamp so "last seen" stays current
    session.lastActive = new Date().toISOString();
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
  createTemplate({ name, command = 'claude', workingDir = '', bypassPermissions = false, verbose = false, model = '', agentTeams = false }) { // gsd:provider-literal-allowed (v1.1 back-compat default; refactor deferred to Phase 15+)
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

  // ─── Feature Board ─────────────────────────────────────

  /**
   * Create a new feature for a workspace.
   * @param {{ workspaceId: string, name: string, description?: string, status?: string, sessionIds?: string[], priority?: string }} params
   * @returns {object} The created feature
   */
  createFeature({ workspaceId, name, description = '', status = 'planned', sessionIds = [], priority = 'normal' }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const feature = {
      id,
      workspaceId,
      name,
      description,
      status, // planned | active | review | done
      priority, // low | normal | high | urgent
      sessionIds, // linked session IDs
      createdAt: now,
      updatedAt: now,
    };
    this._state.features[id] = feature;
    this._debouncedSave();
    this.emit('feature:created', feature);
    return feature;
  }

  /**
   * Get a single feature by ID.
   * @param {string} id - Feature ID
   * @returns {object|null} The feature or null if not found
   */
  getFeature(id) {
    return this._state.features[id] || null;
  }

  /**
   * List all features for a workspace.
   * @param {string} workspaceId
   * @returns {object[]} Array of feature objects
   */
  listFeatures(workspaceId) {
    return Object.values(this._state.features).filter(f => f.workspaceId === workspaceId);
  }

  /**
   * Update a feature's fields (status, description, priority, etc.).
   * @param {string} id - Feature ID
   * @param {object} updates - Partial feature fields
   * @returns {object|null} Updated feature or null if not found
   */
  updateFeature(id, updates) {
    const feature = this._state.features[id];
    if (!feature) return null;
    // Don't allow changing the ID
    delete updates.id;
    Object.assign(feature, updates, { updatedAt: new Date().toISOString() });
    this._debouncedSave();
    this.emit('feature:updated', feature);
    return feature;
  }

  /**
   * Delete a feature by ID.
   * @param {string} id - Feature ID
   * @returns {boolean} True if deleted, false if not found
   */
  deleteFeature(id) {
    const feature = this._state.features[id];
    if (!feature) return false;
    delete this._state.features[id];
    this._debouncedSave();
    this.emit('feature:deleted', { id });
    return true;
  }

  /**
   * Link a session to a feature.
   * @param {string} featureId
   * @param {string} sessionId
   * @returns {object|null} Updated feature or null if not found
   */
  linkSessionToFeature(featureId, sessionId) {
    const feature = this._state.features[featureId];
    if (!feature) return null;
    if (!feature.sessionIds.includes(sessionId)) {
      feature.sessionIds.push(sessionId);
      feature.updatedAt = new Date().toISOString();
      this._debouncedSave();
      this.emit('feature:updated', feature);
    }
    return feature;
  }

  /**
   * Unlink a session from a feature.
   * @param {string} featureId
   * @param {string} sessionId
   * @returns {object|null} Updated feature or null if not found
   */
  unlinkSessionFromFeature(featureId, sessionId) {
    const feature = this._state.features[featureId];
    if (!feature) return null;
    feature.sessionIds = feature.sessionIds.filter(id => id !== sessionId);
    feature.updatedAt = new Date().toISOString();
    this._debouncedSave();
    this.emit('feature:updated', feature);
    return feature;
  }

  // ─── Worktree Tasks ─────────────────────────────────────

  /**
   * Create a worktree task linking a workspace, session, branch, and optional feature.
   * @param {Object} params
   * @param {string} params.workspaceId - Workspace the task belongs to
   * @param {string} params.sessionId - Spawned Claude session ID
   * @param {string} params.branch - Git branch name (e.g. feat/auth-flow)
   * @param {string} params.worktreePath - Filesystem path to the worktree
   * @param {string} params.repoDir - Path to the main repository
   * @param {string} params.description - What the task should accomplish
   * @param {string} [params.baseBranch='main'] - Branch to merge back into
   * @param {string} [params.featureId] - Linked feature board card ID
   * @returns {Object} The created worktree task
   */
  createWorktreeTask({ workspaceId, sessionId, branch, worktreePath, repoDir, description, baseBranch = 'main', featureId = null, model = null, tags = [] }) {
    if (!this._state.worktreeTasks) this._state.worktreeTasks = {};
    const id = 'wt_' + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const task = {
      id,
      workspaceId,
      sessionId,
      featureId,
      branch,
      worktreePath,
      repoDir,
      baseBranch,
      description,
      model: model || null,
      tags: Array.isArray(tags) ? tags : [],
      status: 'running',
      blockedBy: [],
      history: [{ status: 'running', at: now }],
      createdAt: now,
      completedAt: null,
    };
    this._state.worktreeTasks[id] = task;
    this._debouncedSave();
    this.emit('worktreeTask:created', task);
    return task;
  }

  /**
   * Update a worktree task's fields (typically status transitions).
   * Records status changes in the task's history array for audit trail.
   * @param {string} id - Worktree task ID
   * @param {Object} updates - Fields to update
   * @returns {Object|null} Updated task or null if not found
   */
  updateWorktreeTask(id, updates) {
    if (!this._state.worktreeTasks) this._state.worktreeTasks = {};
    const task = this._state.worktreeTasks[id];
    if (!task) return null;

    // Record status transitions in history
    if (updates.status && updates.status !== task.status) {
      if (!task.history) task.history = [];
      task.history.push({ status: updates.status, at: new Date().toISOString() });
    }

    Object.assign(task, updates);
    this._debouncedSave();
    this.emit('worktreeTask:updated', task);
    return task;
  }

  /**
   * Get all worktree tasks, optionally filtered by workspace.
   * @param {string} [workspaceId] - Filter by workspace ID
   * @returns {Array<Object>} Array of worktree tasks
   */
  getWorktreeTasks(workspaceId) {
    if (!this._state.worktreeTasks) this._state.worktreeTasks = {};
    const all = Object.values(this._state.worktreeTasks);
    if (workspaceId) return all.filter(t => t.workspaceId === workspaceId);
    return all;
  }

  /**
   * Get worktree init hooks configuration.
   * @returns {Object|null} { copy_files: string[], init_script: string } or null
   */
  getWorktreeInitHooks() {
    return this._state.worktreeInitHooks || null;
  }

  /**
   * Set worktree init hooks configuration.
   * @param {Object} hooks - { copy_files: string[], init_script: string }
   */
  setWorktreeInitHooks(hooks) {
    this._state.worktreeInitHooks = hooks;
    this._debouncedSave();
  }

  /**
   * Delete a worktree task record.
   * @param {string} id - Worktree task ID
   * @returns {boolean} True if deleted
   */
  deleteWorktreeTask(id) {
    if (!this._state.worktreeTasks) this._state.worktreeTasks = {};
    const task = this._state.worktreeTasks[id];
    if (!task) return false;
    delete this._state.worktreeTasks[id];
    this._debouncedSave();
    this.emit('worktreeTask:deleted', { id });
    return true;
  }

  // ─── Settings ────────────────────────────────────────────

  updateSettings(updates) {
    Object.assign(this._state.settings, updates);
    this._debouncedSave();
    this.emit('settings:updated', this._state.settings);
  }

  // ─── Push Device Registry ─────────────────────────────────

  /**
   * Register a push device token. Deduplicates by token string.
   * @param {{ token: string, platform: 'ios' | 'android', registeredAt: string }} device
   */
  addPushDevice(device) {
    if (!Array.isArray(this._state.pushDevices)) {
      this._state.pushDevices = [];
    }
    // Deduplicate by token
    const existing = this._state.pushDevices.findIndex(d => d.token === device.token);
    if (existing !== -1) {
      // Update platform and timestamp if re-registering
      this._state.pushDevices[existing] = device;
    } else {
      this._state.pushDevices.push(device);
    }
    this._debouncedSave();
    this.emit('push:registered', device);
  }

  /**
   * Remove a push device token from the registry.
   * @param {string} token - The Expo push token to remove
   */
  removePushDevice(token) {
    if (!Array.isArray(this._state.pushDevices)) {
      this._state.pushDevices = [];
      return;
    }
    const before = this._state.pushDevices.length;
    this._state.pushDevices = this._state.pushDevices.filter(d => d.token !== token);
    if (this._state.pushDevices.length !== before) {
      this._debouncedSave();
      this.emit('push:unregistered', { token });
    }
  }

  // ─── Paired Device Registry ──────────────────────────────

  /**
   * Add a paired device record to state. Deduplicates by deviceId.
   * @param {Object} device - Device record with deviceId, token, deviceName, platform, etc.
   */
  addPairedDevice(device) {
    if (!Array.isArray(this._state.pairedDevices)) {
      this._state.pairedDevices = [];
    }
    const existing = this._state.pairedDevices.findIndex(d => d.deviceId === device.deviceId);
    if (existing !== -1) {
      this._state.pairedDevices[existing] = device;
    } else {
      this._state.pairedDevices.push(device);
    }
    this._debouncedSave();
    this.emit('device:paired', device);
  }

  /**
   * Remove a paired device by deviceId. Returns the removed device or null.
   * @param {string} deviceId
   * @returns {Object|null}
   */
  removePairedDevice(deviceId) {
    if (!Array.isArray(this._state.pairedDevices)) return null;
    const idx = this._state.pairedDevices.findIndex(d => d.deviceId === deviceId);
    if (idx === -1) return null;
    const removed = this._state.pairedDevices.splice(idx, 1)[0];
    this._debouncedSave();
    this.emit('device:revoked', removed);
    return removed;
  }

  /**
   * Find a paired device by its Bearer token.
   * @param {string} token
   * @returns {Object|null}
   */
  findDeviceByToken(token) {
    if (!Array.isArray(this._state.pairedDevices)) return null;
    return this._state.pairedDevices.find(d => d.token === token) || null;
  }

  /**
   * Find a paired device by deviceId.
   * @param {string} deviceId
   * @returns {Object|null}
   */
  findDevice(deviceId) {
    if (!Array.isArray(this._state.pairedDevices)) return null;
    return this._state.pairedDevices.find(d => d.deviceId === deviceId) || null;
  }

  /**
   * Get all paired devices.
   * @returns {Array}
   */
  getPairedDevices() {
    return this._state.pairedDevices || [];
  }

  /**
   * Update a paired device's fields (e.g. lastSeenAt, pushToken, pushPreferences).
   * @param {string} deviceId
   * @param {Object} updates - Fields to merge
   * @returns {Object|null} Updated device or null if not found
   */
  updatePairedDevice(deviceId, updates) {
    if (!Array.isArray(this._state.pairedDevices)) return null;
    const device = this._state.pairedDevices.find(d => d.deviceId === deviceId);
    if (!device) return null;
    Object.assign(device, updates);
    this._debouncedSave();
    this.emit('device:updated', device);
    return device;
  }

  /**
   * Refresh a paired device's token and expiration.
   * Replaces the old token with a new one and updates expiresAt.
   * @param {string} deviceId - Device to refresh
   * @param {string} newToken - Replacement Bearer token
   * @param {string} newExpiresAt - New ISO expiration timestamp
   * @returns {Object|null} Updated device or null if not found
   */
  refreshDeviceToken(deviceId, newToken, newExpiresAt) {
    if (!Array.isArray(this._state.pairedDevices)) return null;
    const device = this._state.pairedDevices.find(d => d.deviceId === deviceId);
    if (!device) return null;
    device.token = newToken;
    device.expiresAt = newExpiresAt;
    this._debouncedSave();
    this.emit('device:refreshed', device);
    return device;
  }

  /**
   * Remove all expired paired devices (expiresAt in the past).
   * Returns the count of removed devices.
   * @returns {number}
   */
  cleanExpiredDevices() {
    if (!Array.isArray(this._state.pairedDevices)) return 0;
    const now = new Date().toISOString();
    const before = this._state.pairedDevices.length;
    this._state.pairedDevices = this._state.pairedDevices.filter(d => {
      if (!d.expiresAt) return true;
      return d.expiresAt > now;
    });
    const removed = before - this._state.pairedDevices.length;
    if (removed > 0) {
      this._debouncedSave();
      this.emit('devices:cleaned', { removed });
    }
    return removed;
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
      // Guard: console.error can itself throw EPIPE if stdout is broken,
      // which triggers another uncaughtException, creating an infinite loop.
      try { console.error('[Store] Uncaught exception, flushing state:', err.message); } catch (_) {}
      flushOnExit();
    });
  }
  return instance;
}

module.exports = { Store, getStore, migrateStateV1toV2 };
