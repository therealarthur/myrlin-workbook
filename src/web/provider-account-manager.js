/**
 * Generic provider account manager (account switcher, any provider).
 *
 * Mirrors the proven discipline of src/web/credential-manager.js (the
 * Claude switcher) but is fully parameterized by a provider-owned
 * capability object (see src/providers/codex/accounts.js for the first
 * one), so this file contains ZERO provider literals: every path, header,
 * parser, and hint comes from the capability. The Claude manager is NOT
 * migrated onto this factory in this build (1698 proven lines; the
 * code-preservation rule); a future phase may re-express it as a claude
 * capability.
 *
 * Capability contract (all required unless noted):
 *   providerId      string  stable provider id (registry vocabulary)
 *   displayName     string  human name for messages
 *   authFilePath()  string  absolute path of the live single-account file
 *   watchDir()      string  directory to fs.watch (file-watching drops on
 *                           Windows after atomic rename)
 *   watchFileName   string  the file name to filter watcher events on
 *   storeDirName    string  snapshot dir name under getDataDir()
 *   backupsDirName  string  backups dir name beside the snapshot dir
 *   parseAccount(authJson) -> {accountId, email, plan, name, authMode,
 *                              lastRefresh, accessTokenExp}
 *   serializeAuth(obj)     -> string (round-trips ALL fields)
 *   isNewerThan(a, b)      -> boolean (strictly-newer live-vs-stored)
 *   usage: { url: string|() => string, headers(auth) -> object,
 *            map(raw, nowIso) -> mappedUsage|null }
 *   loginHint       string  actionable "how to log in" copy for errors
 *
 * Token-state model (three states, provider-adapted semantics):
 *   ok          believed good
 *   unverified  no fresh evidence
 *   needs_login DEFINITIVE evidence only: a usage 401/403 received while
 *               the stored access token was NOT yet expired per its exp
 *               claim (an expired-token 401 is expected and says nothing).
 *               Expiry itself is derived at read time from accessTokenExp,
 *               never stored as a state.
 *
 * Token-refresh policy v1: this manager NEVER calls any provider token
 * endpoint. Switching restores the full stored auth file (refresh token
 * included); the provider CLI heals the pair on next use. Consequence: an
 * inactive account whose access token aged out shows accessExpired until
 * it is made active once. Honest and zero-risk (design doc 5.2).
 *
 * SECURITY: snapshots and backups hold live token material; they are
 * written 0600 (best effort) via writeFileAtomic and live under
 * getDataDir(), outside any repo. getSafeList() is THE ONLY shape routes
 * may serialize: derived fields only, never the auth object, never any
 * token, never a JWT.
 *
 * Design: docs/plans/2026-07-03-codex-account-switcher-design.md Part 3.2.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../utils/data-dir');
// Reuse the Claude manager's exported, battle-tested primitives: the
// atomic writer (temp+verify+rename with the Windows EPERM retry loop),
// the route-mappable error builder, and the id validator (provider account
// ids observed so far are uuid-shaped; the hex/dash 8..64 rule gates path
// construction for all of them).
const { writeFileAtomic, credError, validateAccountUuid } = require('./credential-manager');

// ─── Token state constants (same vocabulary as the Claude switcher) ────────
const TOKEN_STATE_OK = 'ok';
const TOKEN_STATE_NEEDS_LOGIN = 'needs_login';
const TOKEN_STATE_UNVERIFIED = 'unverified';

// ─── Timing and limit constants ─────────────────────────────────────────────
// Treat a stored access token as expired 5 minutes early, mirroring the
// Claude manager's skew, so a "not expired" verdict is never seconds from
// being wrong.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// Watcher events within this window after our own apply are ignored.
const SELF_WRITE_GUARD_MS = 3000;
const LABEL_MAX_LENGTH = 60;

// ─── Default settings (merged under settingsProvider output) ────────────────
const DEFAULT_ACCOUNT_SETTINGS = Object.freeze({
  usageCacheMinutes: 10,
  httpTimeoutSec: 5,
  backupKeep: 20,
});

/**
 * Display fallback chain, identical to the Claude switcher's: label if
 * non-empty, else email, else the first 8 chars of the account id plus
 * ' unnamed'. Never empty for a snapshot with an id.
 *
 * @param {{label?: string, email?: string, accountId?: string}} snapshot
 * @returns {string} Human-facing display name.
 */
function accountDisplayName(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'unnamed';
  const label = typeof snapshot.label === 'string' ? snapshot.label.trim() : '';
  if (label) return label;
  const email = typeof snapshot.email === 'string' ? snapshot.email.trim() : '';
  if (email) return email;
  const id = typeof snapshot.accountId === 'string' ? snapshot.accountId : '';
  return (id.slice(0, 8) || 'unknown') + ' unnamed';
}

/**
 * Map a tokenState to the UI health string (shared vocabulary with the
 * Claude rows so the frontend renders both through one helper).
 *
 * @param {string} tokenState - One of the TOKEN_STATE_* values.
 * @returns {'healthy'|'needs-attention'|'needs-re-login'}
 */
function accountHealthFor(tokenState) {
  if (tokenState === TOKEN_STATE_OK) return 'healthy';
  if (tokenState === TOKEN_STATE_NEEDS_LOGIN) return 'needs-re-login';
  return 'needs-attention';
}

/**
 * Format an epoch-ms timestamp as yyyyMMdd-HHmmss for backup filenames
 * (same format as the Claude backups so the backups dirs read uniformly).
 *
 * @param {number} epochMs - Timestamp in epoch milliseconds.
 * @returns {string} Compact local-time stamp.
 */
function _formatStamp(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/**
 * Create a provider account manager bound to one capability. Every
 * dependency is injectable so tests never touch the real HOME or network.
 *
 * @param {object} capability - Provider capability (contract in header).
 * @param {object} [opts]
 * @param {string} [opts.accountsDir] - Snapshot store dir override.
 *   Default: <getDataDir()>/<capability.storeDirName>.
 * @param {() => object} [opts.settingsProvider] - Returns the raw settings
 *   object for this provider (merged over defaults at read time).
 * @param {Function} [opts.fetchImpl] - fetch implementation (global fetch).
 * @param {() => number} [opts.clock] - Epoch-ms clock. Default Date.now.
 * @param {number} [opts.watchDebounceMs] - Watcher debounce. Default 500.
 * @param {number} [opts.pollIntervalMs] - Fallback poll. Default 30000.
 * @param {object} [opts.log] - Logger with warn/error/log. Default console.
 * @returns {object} The manager API.
 */
function createProviderAccountManager(capability, opts = {}) {
  if (!capability || typeof capability !== 'object' || !capability.providerId) {
    throw new Error('createProviderAccountManager requires a capability object with a providerId');
  }
  const accountsDir = opts.accountsDir || path.join(getDataDir(), capability.storeDirName);
  const backupsDir = path.join(accountsDir, '..', capability.backupsDirName);
  const settingsProvider = typeof opts.settingsProvider === 'function' ? opts.settingsProvider : () => ({});
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const clock = opts.clock || Date.now;
  const watchDebounceMs = opts.watchDebounceMs || 500;
  const pollIntervalMs = opts.pollIntervalMs || 30000;
  const log = opts.log || console;
  const logTag = '[Accounts:' + capability.providerId + ']';

  // Watcher and mutex state, per manager instance.
  let _watcher = null;
  let _debounceTimer = null;
  let _pollTimer = null;
  let _lastPollMtime = null;
  let _selfWriteUntil = 0;
  let _chain = Promise.resolve();

  /**
   * Promise-chain mutex. Serializes every mutating operation so two GUI
   * clients and the watcher can never interleave snapshot or live-file
   * writes. Errors propagate to the caller but never break the chain.
   * Identical to credential-manager serialize().
   *
   * @param {() => (Promise<*>|*)} fn - Operation to run exclusively.
   * @returns {Promise<*>} Resolves/rejects with fn's outcome.
   */
  function serialize(fn) {
    const run = _chain.then(() => fn());
    _chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Merged settings: defaults overlaid with whatever settingsProvider
   * returns (null-tolerant, never throws).
   *
   * @returns {object} Fully populated settings object.
   */
  function getSettings() {
    let raw = {};
    try { raw = settingsProvider() || {}; } catch (_) { raw = {}; }
    return { ...DEFAULT_ACCOUNT_SETTINGS, ...raw };
  }

  /**
   * Resolve the live auth file path from the capability (evaluated per
   * call: env overrides like CODEX_HOME may change under tests).
   *
   * @returns {string} Absolute auth file path.
   */
  function authFilePath() {
    return capability.authFilePath();
  }

  /**
   * Resolve the usage endpoint URL. The capability may supply a string or
   * a function (function form lets env overrides apply after module load).
   *
   * @returns {string} Usage endpoint URL.
   */
  function usageUrl() {
    const u = capability.usage && capability.usage.url;
    return typeof u === 'function' ? u() : String(u || '');
  }

  /**
   * Read the live auth file: parsed object plus the derived identity.
   * Null-safe; a missing, mid-write, or malformed file degrades to null
   * (the debounce + poll retries; never crash, never log file contents).
   *
   * @returns {{authObj: object, parsed: object}|null}
   */
  function readActiveAuth() {
    try {
      const text = fs.readFileSync(authFilePath(), 'utf-8');
      const authObj = JSON.parse(text);
      if (!authObj || typeof authObj !== 'object') return null;
      return { authObj, parsed: capability.parseAccount(authObj) };
    } catch (_) {
      return null;
    }
  }

  /**
   * Convenience: the accountId of the account live on this machine, or
   * null (missing file, malformed file, or apikey mode).
   *
   * @returns {string|null}
   */
  function getActiveAccountId() {
    const live = readActiveAuth();
    const id = live && live.parsed && live.parsed.accountId;
    return (typeof id === 'string' && id) ? id : null;
  }

  /**
   * Path of the snapshot file for one account. Validates the id first so
   * no unvalidated id ever reaches path construction.
   *
   * @param {string} accountId
   * @returns {string} Absolute snapshot path.
   */
  function snapshotPath(accountId) {
    if (!validateAccountUuid(accountId)) {
      throw credError(400, 'VALIDATION', 'accountId must be 8 to 64 hex/dash characters');
    }
    return path.join(accountsDir, accountId + '.json');
  }

  /**
   * Normalize a raw parsed snapshot to the current schema (missing fields
   * get their defaults; nothing is ever removed).
   *
   * @param {object} snap - Parsed snapshot object.
   * @returns {object} Normalized snapshot.
   */
  function _normalizeSnapshot(snap) {
    if (!snap.tokenState) snap.tokenState = TOKEN_STATE_UNVERIFIED;
    if (snap.lastError === undefined) snap.lastError = null;
    if (snap.usage === undefined) snap.usage = null;
    if (typeof snap.label !== 'string') snap.label = '';
    return snap;
  }

  /**
   * Read one snapshot by accountId. Missing or corrupt files degrade to
   * null (the next capture self-heals them).
   *
   * @param {string} accountId
   * @returns {object|null} Normalized snapshot or null.
   */
  function readSnapshot(accountId) {
    if (!validateAccountUuid(accountId)) return null;
    try {
      const text = fs.readFileSync(path.join(accountsDir, accountId + '.json'), 'utf-8');
      const snap = JSON.parse(text);
      if (!snap || typeof snap !== 'object' || !validateAccountUuid(snap.accountId)) return null;
      return _normalizeSnapshot(snap);
    } catch (_) {
      return null;
    }
  }

  /**
   * List every valid snapshot in the accounts dir; unparseable files are
   * skipped silently.
   *
   * @returns {object[]} Normalized snapshots.
   */
  function listSnapshots() {
    let files;
    try {
      files = fs.readdirSync(accountsDir).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch (_) {
      return [];
    }
    const out = [];
    for (const f of files) {
      const id = f.slice(0, -5);
      const snap = readSnapshot(id);
      if (snap) out.push(snap);
    }
    return out;
  }

  /**
   * Write one snapshot exactly as given (atomic, chmod 0600 best effort).
   * Internal writer; callers own the merge semantics.
   *
   * @param {object} snapshot - Fully formed snapshot.
   * @returns {object} The same snapshot.
   */
  function _writeSnapshot(snapshot) {
    const p = snapshotPath(snapshot.accountId);
    writeFileAtomic(p, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    return snapshot;
  }

  /**
   * Read-modify-write one snapshot: apply the patch fields over the
   * current on-disk state and bump updatedAt. Throws ACCT_NOT_FOUND when
   * missing.
   *
   * @param {string} accountId
   * @param {object} patch - Fields to overwrite.
   * @returns {object} The updated snapshot.
   */
  function _mutateSnapshot(accountId, patch) {
    const current = readSnapshot(accountId);
    if (!current) {
      throw credError(404, 'ACCT_NOT_FOUND', 'No stored account snapshot for ' + accountId + '.');
    }
    const next = { ...current, ...patch, updatedAt: new Date(clock()).toISOString() };
    return _writeSnapshot(next);
  }

  /**
   * Persist a snapshot with carry-forward semantics matching the Claude
   * store: an existing non-empty label survives unless preserveLabel is
   * explicitly false; usage, tokenState, lastError, and savedAt carry
   * forward when the incoming snapshot omits them.
   *
   * @param {object} snapshot - Partial or full snapshot (accountId required).
   * @param {{preserveLabel?: boolean}} [saveOpts]
   * @returns {object} The merged, persisted snapshot.
   */
  function saveSnapshot(snapshot, saveOpts = {}) {
    if (!snapshot || !validateAccountUuid(snapshot.accountId)) {
      throw credError(400, 'VALIDATION', 'snapshot.accountId is required and must be a valid account id');
    }
    const preserveLabel = saveOpts.preserveLabel !== false;
    const existing = readSnapshot(snapshot.accountId);
    const nowIso = new Date(clock()).toISOString();
    const existingLabel = existing && existing.label ? existing.label : '';
    const incomingLabel = snapshot.label != null ? String(snapshot.label) : '';
    const merged = {
      accountId: snapshot.accountId,
      email: snapshot.email != null ? snapshot.email : (existing ? existing.email : ''),
      label: (preserveLabel && existingLabel) ? existingLabel : (incomingLabel || existingLabel),
      plan: snapshot.plan != null ? snapshot.plan : ((existing && existing.plan) || ''),
      authMode: snapshot.authMode != null ? snapshot.authMode : ((existing && existing.authMode) || 'unknown'),
      name: snapshot.name != null ? snapshot.name : ((existing && existing.name) || ''),
      savedAt: (existing && existing.savedAt) || snapshot.savedAt || nowIso,
      updatedAt: nowIso,
      auth: snapshot.auth !== undefined ? snapshot.auth : (existing ? existing.auth : null),
      lastRefresh: snapshot.lastRefresh !== undefined ? snapshot.lastRefresh : ((existing && existing.lastRefresh) || null),
      usage: snapshot.usage !== undefined ? snapshot.usage : (existing ? existing.usage : null),
      tokenState: snapshot.tokenState !== undefined ? snapshot.tokenState : ((existing && existing.tokenState) || TOKEN_STATE_UNVERIFIED),
      lastError: snapshot.lastError !== undefined ? snapshot.lastError : ((existing && existing.lastError) || null),
    };
    return _writeSnapshot(merged);
  }

  /**
   * True when a stored/live access token should be treated as expired at
   * `now` per its decoded exp claim (5 minute early skew). A null exp
   * (undecodable token) also reads as expired: without a readable claim
   * there is no basis for a needs_login verdict on a 401, so the caller
   * skips the network round entirely. Missing tokens read as expired too.
   *
   * @param {number|null} accessTokenExp - Epoch ms exp, or null.
   * @param {number} now - Epoch ms.
   * @returns {boolean}
   */
  function _isAccessExpired(accessTokenExp, now) {
    const expMs = Number(accessTokenExp) || 0;
    return (expMs - EXPIRY_SKEW_MS) <= now;
  }

  /**
   * Unlocked core of captureCurrent: explicit snapshot of the live account
   * (first run, or the empty-state CTA). Captured state is definitionally
   * alive, so tokenState is set to ok.
   *
   * @param {{label?: string}} [captureOpts] - Optional friendly label.
   * @returns {object} The persisted snapshot.
   */
  function _captureCurrentUnlocked(captureOpts = {}) {
    const live = readActiveAuth();
    if (!live) {
      throw credError(500, 'ACCT_LIVE_STATE_UNREADABLE',
        'The live account state is unreadable (auth file missing or malformed). ' + capability.loginHint);
    }
    const parsed = live.parsed || {};
    if (parsed.authMode === 'apikey' || !validateAccountUuid(parsed.accountId)) {
      throw credError(422, 'ACCT_NO_IDENTITY',
        'The live login has no switchable account identity (API-key auth has no account). ' + capability.loginHint);
    }
    let label = '';
    if (captureOpts.label != null) {
      if (typeof captureOpts.label !== 'string') throw credError(400, 'VALIDATION', 'label must be a string');
      label = captureOpts.label.trim();
      if (label.length > LABEL_MAX_LENGTH) {
        throw credError(400, 'VALIDATION', 'label must be ' + LABEL_MAX_LENGTH + ' characters or fewer');
      }
    }
    const existing = readSnapshot(parsed.accountId);
    const nowIso = new Date(clock()).toISOString();
    return _writeSnapshot({
      accountId: parsed.accountId,
      email: parsed.email || '',
      label: label || (existing && existing.label) || '',
      plan: parsed.plan || '',
      authMode: parsed.authMode || 'unknown',
      name: parsed.name || '',
      savedAt: (existing && existing.savedAt) || nowIso,
      updatedAt: nowIso,
      auth: live.authObj,
      lastRefresh: parsed.lastRefresh || null,
      usage: (existing && existing.usage) || null,
      tokenState: TOKEN_STATE_OK,
      lastError: null,
    });
  }

  /**
   * Unlocked core of syncActiveAuthToSnapshot (the watcher's write-back
   * loop). Skips silently when the live file is unreadable or in apikey
   * mode; auto-captures an unknown accountId (this gives capture-within-1s
   * of a CLI login); merges auth + identity only when the live file is
   * STRICTLY newer per capability.isNewerThan (never regresses a fresher
   * snapshot); and ALWAYS resurrects tokenState to ok (a live login is
   * definitive positive evidence).
   *
   * @returns {string|null} The synced accountId, or null (nothing written).
   */
  function _syncActiveAuthToSnapshotUnlocked() {
    try {
      const live = readActiveAuth();
      if (!live) return null;
      const parsed = live.parsed || {};
      if (parsed.authMode === 'apikey' || !validateAccountUuid(parsed.accountId)) return null;
      const existing = readSnapshot(parsed.accountId);
      if (!existing) {
        const nowIso = new Date(clock()).toISOString();
        _writeSnapshot({
          accountId: parsed.accountId,
          email: parsed.email || '',
          label: '',
          plan: parsed.plan || '',
          authMode: parsed.authMode || 'unknown',
          name: parsed.name || '',
          savedAt: nowIso,
          updatedAt: nowIso,
          auth: live.authObj,
          lastRefresh: parsed.lastRefresh || null,
          usage: null,
          tokenState: TOKEN_STATE_OK,
          lastError: null,
        });
        return parsed.accountId;
      }
      const patch = {};
      if (capability.isNewerThan(live.authObj, existing.auth || {})) {
        patch.auth = live.authObj;
        patch.lastRefresh = parsed.lastRefresh || null;
        // Identity fields ride with a fresher auth file (a plan change or
        // rename lands with the login that produced it).
        if (parsed.email) patch.email = parsed.email;
        if (parsed.plan) patch.plan = parsed.plan;
        if (parsed.name) patch.name = parsed.name;
        patch.authMode = parsed.authMode || existing.authMode || 'unknown';
      }
      if (existing.tokenState !== TOKEN_STATE_OK) {
        // Watcher recapture of a live login always resurrects the account.
        patch.tokenState = TOKEN_STATE_OK;
        patch.lastError = null;
      }
      if (Object.keys(patch).length > 0) _mutateSnapshot(parsed.accountId, patch);
      return parsed.accountId;
    } catch (err) {
      log.warn(logTag + ' sync-back skipped: ' + ((err && err.message) || err));
      return null;
    }
  }

  /**
   * Unlocked core of setLabel: trim, cap at 60 chars (VALIDATION beyond),
   * empty clears (display falls back per the chain). Label only.
   *
   * @param {string} accountId
   * @param {string} label
   * @returns {object} The updated snapshot.
   */
  function _setLabelUnlocked(accountId, label) {
    if (!validateAccountUuid(accountId)) {
      throw credError(400, 'VALIDATION', 'accountId must be a valid account id');
    }
    if (label == null) label = '';
    if (typeof label !== 'string') throw credError(400, 'VALIDATION', 'label must be a string');
    const trimmed = label.trim();
    if (trimmed.length > LABEL_MAX_LENGTH) {
      throw credError(400, 'VALIDATION', 'label must be ' + LABEL_MAX_LENGTH + ' characters or fewer');
    }
    return _mutateSnapshot(accountId, { label: trimmed });
  }

  /**
   * Unlocked core of deleteSnapshot: removes the snapshot file ONLY. Never
   * the live auth file, never anything remote. The mirror of the Claude
   * manager's delete.
   *
   * @param {string} accountId
   * @returns {{deleted: boolean}}
   */
  function _deleteSnapshotUnlocked(accountId) {
    if (!validateAccountUuid(accountId)) {
      throw credError(400, 'VALIDATION', 'accountId must be a valid account id');
    }
    const p = path.join(accountsDir, accountId + '.json');
    if (!fs.existsSync(p)) {
      throw credError(404, 'ACCT_NOT_FOUND', 'No stored account snapshot for ' + accountId + '.');
    }
    fs.unlinkSync(p);
    return { deleted: true };
  }

  /**
   * Timestamped backup of the live auth file into the backups dir, pruning
   * the oldest beyond backupKeep per basename. The just-created backup is
   * never a prune candidate (NTFS tunneling lesson). A missing or
   * uncopyable source degrades to null. Reimplemented here because the
   * Claude manager's equivalent is closure-private.
   *
   * @param {string} livePath - File to back up.
   * @returns {string|null} The backup path, or null.
   */
  function backupLiveFile(livePath) {
    try {
      if (!livePath || !fs.existsSync(livePath) || !fs.statSync(livePath).isFile()) return null;
    } catch (_) {
      return null;
    }
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      const base = path.basename(livePath);
      const stamp = _formatStamp(clock());
      let candidate = path.join(backupsDir, base + '.' + stamp + '.bak');
      let n = 0;
      while (fs.existsSync(candidate)) {
        n += 1;
        candidate = path.join(backupsDir, base + '.' + stamp + '.' + n + '.bak');
      }
      fs.copyFileSync(livePath, candidate);
      try { fs.chmodSync(candidate, 0o600); } catch (_) { /* best effort */ }
      const keep = Math.max(1, Number(getSettings().backupKeep) || 20);
      try {
        const others = fs.readdirSync(backupsDir)
          .filter((f) => f.startsWith(base + '.') && f.endsWith('.bak'))
          .map((f) => path.join(backupsDir, f))
          .filter((p) => p !== candidate)
          .map((p) => {
            let m = 0;
            try { m = fs.statSync(p).mtimeMs; } catch (_) { m = 0; }
            return { p, m };
          })
          .sort((a, b) => a.m - b.m);
        const allowedOthers = keep > 0 ? keep - 1 : 0;
        while (others.length > allowedOthers) {
          const victim = others.shift();
          try { fs.unlinkSync(victim.p); } catch (_) { /* best effort */ }
        }
      } catch (_) { /* prune is best effort */ }
      return candidate;
    } catch (err) {
      log.warn(logTag + ' backup of ' + livePath + ' failed: ' + ((err && err.message) || err));
      return null;
    }
  }

  /**
   * Read-only usage fetch against the capability's endpoint with the
   * capability's headers. Returns a classification object rather than a
   * bare result so the caller can apply the corrected state model:
   *
   *   { ok: true, usage, raw }        HTTP 200 with mappable body
   *   { ok: false, kind: 'auth', status }    HTTP 401/403 (dead ONLY if
   *                                          the token was not expired)
   *   { ok: false, kind: 'transient', status?, detail }  everything else:
   *     network errors, timeouts, 429, 5xx, unmappable bodies.
   *
   * The token rides ONLY in the headers built by the capability; it is
   * never logged and never appears in the returned detail strings.
   *
   * @param {object} auth - Live or stored auth object (token source).
   * @returns {Promise<object>} Classification per above.
   */
  async function _fetchUsage(auth) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, kind: 'transient', status: null, detail: 'no fetch implementation available' };
    }
    const timeoutMs = Math.max(1, Number(getSettings().httpTimeoutSec) || 5) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(usageUrl(), {
        method: 'GET',
        headers: capability.usage.headers(auth),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR'));
      return { ok: false, kind: 'transient', status: null, detail: timedOut ? 'timeout' : 'network error' };
    }
    clearTimeout(timer);
    if (res && (res.status === 401 || res.status === 403)) {
      return { ok: false, kind: 'auth', status: res.status };
    }
    if (!res || !res.ok) {
      return { ok: false, kind: 'transient', status: res ? res.status : null, detail: 'HTTP ' + (res ? res.status : 'no response') };
    }
    const raw = await res.json().catch(() => null);
    const usage = capability.usage.map(raw, new Date(clock()).toISOString());
    if (!usage) {
      return { ok: false, kind: 'transient', status: res.status, detail: 'unmappable usage response' };
    }
    return { ok: true, usage, raw };
  }

  /**
   * Unlocked core of updateSnapshotUsage. Full v1 token policy:
   *   cache fresher than usageCacheMinutes and no force: zero network;
   *   token source: the ACTIVE account uses the LIVE auth file strictly
   *     read-only; inactive accounts use the stored auth;
   *   expired (or undecodable) access token: SKIP the network round
   *     entirely and return unchanged (no refresh in v1; the row keeps its
   *     stale usage and the safe list flags accessExpired);
   *   200: store mapped usage, heal email/plan from the response,
   *     tokenState ok, clear lastError;
   *   401/403 with an unexpired token: DEFINITIVE -> needs_login;
   *   timeout/network/429/5xx: record lastError, keep the prior state.
   * NEVER calls any token-refresh endpoint.
   *
   * @param {string} accountId
   * @param {{force?: boolean}} [usageOpts]
   * @returns {Promise<object>} The (possibly updated) snapshot.
   */
  async function _updateSnapshotUsageUnlocked(accountId, usageOpts = {}) {
    const force = !!usageOpts.force;
    if (!validateAccountUuid(accountId)) {
      throw credError(400, 'VALIDATION', 'accountId must be a valid account id');
    }
    let snap = readSnapshot(accountId);
    if (!snap) {
      throw credError(404, 'ACCT_NOT_FOUND', 'No stored account snapshot for ' + accountId + '.');
    }
    const now = clock();
    const cacheMs = Math.max(0, Number(getSettings().usageCacheMinutes) || 10) * 60000;
    const fetchedAtMs = snap.usage && snap.usage.fetchedAt ? Date.parse(snap.usage.fetchedAt) : NaN;
    if (!force && Number.isFinite(fetchedAtMs) && (now - fetchedAtMs) < cacheMs) {
      return snap; // fresh cache: zero network calls
    }

    // Token source. The ACTIVE account reads the LIVE auth file (strictly
    // read-only; a GET never mutates tokens); inactive accounts use the
    // stored auth object.
    let auth = snap.auth;
    const activeId = getActiveAccountId();
    if (activeId && activeId === snap.accountId) {
      const live = readActiveAuth();
      if (!live) return snap;
      auth = live.authObj;
    }
    if (!auth || !auth.tokens || !auth.tokens.access_token) return snap;

    // Expiry gate (v1: no refresh, ever). An expired token's 401 would say
    // NOTHING about the account, so the round is skipped entirely and the
    // row keeps its stale usage; the safe list surfaces accessExpired.
    const parsedAuth = capability.parseAccount(auth);
    if (_isAccessExpired(parsedAuth ? parsedAuth.accessTokenExp : null, now)) {
      return snap;
    }

    const r = await _fetchUsage(auth);
    if (r.ok) {
      const patch = { usage: r.usage, tokenState: TOKEN_STATE_OK, lastError: null };
      // Identity healing: the endpoint echoes email + plan_type; adopt them
      // as whitelisted strings (JWT-free identity refresh).
      if (r.raw && typeof r.raw.email === 'string' && r.raw.email) patch.email = r.raw.email;
      if (r.raw && typeof r.raw.plan_type === 'string' && r.raw.plan_type) patch.plan = r.raw.plan_type;
      return _mutateSnapshot(accountId, patch);
    }
    if (r.kind === 'auth') {
      // 401/403 while the token was NOT expired: definitive rejection.
      return _mutateSnapshot(accountId, {
        tokenState: TOKEN_STATE_NEEDS_LOGIN,
        lastError: { at: new Date(clock()).toISOString(), kind: 'auth', status: r.status != null ? r.status : null, detail: 'usage endpoint rejected an unexpired token' },
      });
    }
    // Transient: record and keep the prior state (never a death verdict).
    log.warn(logTag + ' transient usage failure for ' + accountId + ': ' + (r.detail || 'unknown'));
    return _mutateSnapshot(accountId, {
      lastError: { at: new Date(clock()).toISOString(), kind: 'transient', status: r.status != null ? r.status : null, detail: String(r.detail || '') },
    });
  }

  /**
   * Unlocked core of applyAccount: the switch transaction. Single-file
   * (simpler than Claude's two-file identity+token dance) but the same
   * load-bearing order:
   *   validate -> load -> alreadyActive no-op -> needs_login blocks ->
   *   arm self-write guard -> CAPTURE-BEFORE-OVERWRITE (sync the current
   *   live account into its snapshot; auto-captures an unknown one so the
   *   user never loses the account being replaced; an apikey-mode or
   *   unparseable live file is not capturable and the backup is its only
   *   preservation) -> backup -> atomic 0600 write -> VERIFY the live file
   *   now reports the target (restore the backup on mismatch) ->
   *   reconcile -> report.
   *
   * @param {string} accountId - The target account id.
   * @returns {Promise<{applied: boolean, alreadyActive: boolean, email: string, warning?: string}>}
   */
  async function _applyAccountUnlocked(accountId) {
    // Step 0: validate and load.
    if (!validateAccountUuid(accountId)) {
      throw credError(400, 'VALIDATION', 'accountId must be a valid account id');
    }
    const snap = readSnapshot(accountId);
    if (!snap) {
      throw credError(404, 'ACCT_NOT_FOUND',
        'No stored account snapshot for that account. ' + capability.loginHint);
    }
    if (!snap.auth || !snap.auth.tokens) {
      throw credError(422, 'ACCT_INCOMPLETE',
        'The stored snapshot for ' + (snap.email || accountId) + ' has no auth payload. ' + capability.loginHint);
    }
    const activeId = getActiveAccountId();
    if (activeId && activeId === accountId) {
      return { applied: false, alreadyActive: true, email: snap.email || '' };
    }
    if (snap.tokenState === TOKEN_STATE_NEEDS_LOGIN) {
      throw credError(409, 'ACCT_TOKEN_DEAD',
        'The stored login for ' + (snap.email || accountId) + ' was rejected and needs a fresh login. ' + capability.loginHint);
    }

    // accessExpired is a WARNING, never a blocker: the provider CLI
    // refreshes with the stored refresh token on next use, and there is no
    // way to test that refresh token without spending it (v1 policy).
    let warning = null;
    const parsedStored = capability.parseAccount(snap.auth);
    if (_isAccessExpired(parsedStored ? parsedStored.accessTokenExp : null, clock())) {
      warning = 'Stored token is past its access window; ' + capability.displayName
        + ' will refresh it on next use, or ask for login if the refresh is rejected.';
    }

    // Step a: arm the self-write guard so the watcher ignores our write.
    _selfWriteUntil = clock() + SELF_WRITE_GUARD_MS;
    // Step 1: CAPTURE-BEFORE-OVERWRITE. If the current live account has no
    // snapshot this auto-captures it, so switching away never loses it.
    _syncActiveAuthToSnapshotUnlocked();
    // Step 2: backup the live file (also the rollback source for verify).
    const backupPath = backupLiveFile(authFilePath());
    // Step 3: atomic 0600 write of the stored auth payload.
    try {
      writeFileAtomic(authFilePath(), capability.serializeAuth(snap.auth), { mode: 0o600 });
    } catch (err) {
      // Atomic write means the live file is untouched on failure.
      throw credError(500, 'ACCT_APPLY_FAILED',
        'Auth write failed; the live file is unchanged. ' + ((err && err.message) || err));
    }
    // Step 4: VERIFY the live file now reports the target account.
    const verifyId = getActiveAccountId();
    if (verifyId !== accountId) {
      try {
        if (backupPath) writeFileAtomic(authFilePath(), fs.readFileSync(backupPath, 'utf-8'), { mode: 0o600 });
      } catch (_) { /* verify rollback is best effort; the backup remains on disk */ }
      throw credError(500, 'ACCT_VERIFY_FAILED',
        'Post-apply verification failed: the live auth file does not report the target account. Backups are in ' + backupsDir + '.');
    }
    // Step 5: reconcile the snapshot with what is now live, then report.
    _syncActiveAuthToSnapshotUnlocked();
    const result = { applied: true, alreadyActive: false, email: snap.email || '' };
    if (warning) result.warning = warning;
    return result;
  }

  /**
   * Fire one serialized sync-back, swallowing every error (the watcher can
   * never crash the server).
   *
   * @returns {void}
   */
  function _fireSync() {
    if (clock() < _selfWriteUntil) return; // our own apply is writing
    serialize(() => _syncActiveAuthToSnapshotUnlocked()).catch((err) => {
      log.warn(logTag + ' watcher sync failed: ' + ((err && err.message) || err));
    });
  }

  /**
   * Start the login write-back watcher: a dir-scoped fs.watch on the
   * capability's watch dir filtered to its auth file name (the FIRST line
   * of the callback, because the dir may churn constantly), debounced,
   * plus a low-frequency mtime poll on the auth file itself because
   * Windows watchers can silently die. Idempotent. Fires one initial sync
   * so the active account self-registers at boot. Watch errors degrade to
   * poll-only; a missing dir/file is tolerated (statSync catch).
   *
   * @returns {void}
   */
  function startWatcher() {
    if (_watcher || _pollTimer) return; // already running
    const fileNameLower = String(capability.watchFileName || '').toLowerCase();
    try {
      _watcher = fs.watch(capability.watchDir(), (event, filename) => {
        try {
          // Cheap name filter FIRST: the watched dir is busy (e.g. sqlite
          // WAL churn); everything but the auth file is ignored outright.
          if (filename && String(filename).toLowerCase() !== fileNameLower) return;
          if (_debounceTimer) clearTimeout(_debounceTimer);
          _debounceTimer = setTimeout(_fireSync, watchDebounceMs);
          if (_debounceTimer.unref) _debounceTimer.unref();
        } catch (_) { /* watcher callback must never throw */ }
      });
      _watcher.on('error', (err) => {
        log.warn(logTag + ' watcher error, degrading to poll-only: ' + ((err && err.message) || err));
        try { _watcher.close(); } catch (_) { /* best effort */ }
        _watcher = null;
      });
    } catch (err) {
      log.warn(logTag + ' fs.watch unavailable (' + ((err && err.message) || err) + '); poll fallback only');
      _watcher = null;
    }
    _pollTimer = setInterval(() => {
      try {
        const st = fs.statSync(authFilePath());
        if (_lastPollMtime !== null && st.mtimeMs !== _lastPollMtime) _fireSync();
        _lastPollMtime = st.mtimeMs;
      } catch (_) { /* live file missing: nothing to sync */ }
    }, pollIntervalMs);
    if (_pollTimer.unref) _pollTimer.unref();
    // Initial sync: the active account self-registers on first run.
    setImmediate(_fireSync);
  }

  /**
   * Stop the watcher and every timer. Idempotent; called on shutdown.
   *
   * @returns {void}
   */
  function stopWatcher() {
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_watcher) { try { _watcher.close(); } catch (_) { /* best effort */ } _watcher = null; }
    _lastPollMtime = null;
  }

  /**
   * Browser-safe projection of the roster. THE ONLY SHAPE ROUTES MAY
   * SERIALIZE. Never contains the auth object, any token, or any JWT;
   * derived display fields only. `installed` (auth file exists OR store
   * non-empty) drives the frontend empty state; `accessExpired` is derived
   * at read time from the stored token's exp claim; `loginHint` gives the
   * frontend its provider-appropriate empty-state copy.
   *
   * @returns {{providerId: string, displayName: string, installed: boolean,
   *   activeAccountId: string|null, activeAuthMode: string|null,
   *   loginHint: string, accounts: object[]}}
   */
  function getSafeList() {
    const live = readActiveAuth();
    const activeAccountId = (live && live.parsed && validateAccountUuid(live.parsed.accountId))
      ? live.parsed.accountId : null;
    const activeAuthMode = live && live.parsed ? (live.parsed.authMode || 'unknown') : null;
    let authFileExists = false;
    try { authFileExists = fs.existsSync(authFilePath()); } catch (_) { authFileExists = false; }
    const now = clock();
    const accounts = listSnapshots().map((snap) => {
      const tokenState = snap.tokenState || TOKEN_STATE_UNVERIFIED;
      const parsed = capability.parseAccount(snap.auth);
      return {
        accountId: snap.accountId,
        email: snap.email || '',
        label: snap.label || '',
        displayName: accountDisplayName(snap),
        plan: snap.plan || '',
        authMode: snap.authMode || 'unknown',
        isActive: !!activeAccountId && snap.accountId === activeAccountId,
        tokenState,
        health: accountHealthFor(tokenState),
        accessExpired: _isAccessExpired(parsed ? parsed.accessTokenExp : null, now),
        savedAt: snap.savedAt || null,
        updatedAt: snap.updatedAt || null,
        usage: snap.usage || null,
        lastError: snap.lastError ? {
          at: snap.lastError.at || null,
          kind: snap.lastError.kind || null,
          status: snap.lastError.status != null ? snap.lastError.status : null,
        } : null,
      };
    });
    accounts.sort((a, b) => (Number(b.isActive) - Number(a.isActive)) ||
      String(a.displayName).localeCompare(String(b.displayName)));
    return {
      providerId: capability.providerId,
      displayName: capability.displayName,
      installed: authFileExists || accounts.length > 0,
      activeAccountId,
      activeAuthMode,
      loginHint: capability.loginHint || '',
      accounts,
    };
  }

  /**
   * Arm the self-write guard window manually. Internal, exposed for tests
   * that exercise the watcher guard without running a full apply.
   *
   * @param {number} ms - Guard duration from now.
   * @returns {void}
   */
  function _armSelfWriteGuard(ms) {
    _selfWriteUntil = clock() + (Number(ms) || 0);
  }

  return {
    // Identity and config (read-only introspection for routes and tests)
    providerId: capability.providerId,
    displayName: capability.displayName,
    accountsDir,
    backupsDir,
    getSettings,
    authFilePath,
    // Live-state readers
    readActiveAuth,
    getActiveAccountId,
    // Snapshot store
    snapshotPath,
    readSnapshot,
    saveSnapshot,
    listSnapshots,
    deleteSnapshot: (id) => serialize(() => _deleteSnapshotUnlocked(id)),
    // Watcher (login write-back loop)
    startWatcher,
    stopWatcher,
    syncActiveAuthToSnapshot: () => serialize(() => _syncActiveAuthToSnapshotUnlocked()),
    // Capture / labels
    captureCurrent: (o) => serialize(() => _captureCurrentUnlocked(o)),
    setLabel: (id, label) => serialize(() => _setLabelUnlocked(id, label)),
    // Usage (read-only; NEVER calls a token endpoint in v1)
    updateSnapshotUsage: (id, o) => serialize(() => _updateSnapshotUsageUnlocked(id, o)),
    // Apply transaction
    backupLiveFile,
    applyAccount: (id) => serialize(() => _applyAccountUnlocked(id)),
    // Safe projection (the only route-serializable shape)
    getSafeList,
    // Internal, for tests only
    _armSelfWriteGuard,
  };
}

module.exports = {
  createProviderAccountManager,
  accountDisplayName,
  accountHealthFor,
  DEFAULT_ACCOUNT_SETTINGS,
  EXPIRY_SKEW_MS,
  TOKEN_STATE_OK,
  TOKEN_STATE_NEEDS_LOGIN,
  TOKEN_STATE_UNVERIFIED,
};
