/**
 * Credential Manager for the Claude account switcher.
 *
 * Owns the per-account credential snapshot store, the rotation write-back
 * watcher, usage fetching, inactive-token refresh, and the PC apply
 * transaction. Ported from the proven primitives in claude-swap.ps1
 * (usage fetch, credentials-file text builder, profile store, Invoke-PcSwap)
 * with one deliberate CORRECTION: the reference tool marks a profile
 * permanently dead on ANY refresh failure (network error, timeout, 429,
 * 5xx, and real auth rejections all collapse to null), which wrongly greys
 * out healthy accounts. This module replaces that binary tokenDead flag
 * with a three-state model:
 *
 *   tokenState: 'ok'          the stored refresh token is believed good
 *               'needs_login' a DEFINITIVE auth rejection (invalid_grant)
 *                             was observed; only /login revives it
 *               'unverified'  imported or migrated without fresh evidence
 *
 * "Access token expired" is NEVER a stored state. OAuth access tokens are
 * supposed to expire (about every 12h) and self-heal via refresh; expiry is
 * derived at read time from expiresAt. Transient failures (network, timeout,
 * 429, 5xx, protocol bugs on our side) never change tokenState; they are
 * recorded in lastRefreshError and the prior state is kept.
 *
 * Expiry-fix additions (docs/plans/2026-07-16-credential-expiry-fix-spec.md):
 * ambiguous auth answers (403 / bodyless 401) are 'suspect', not death;
 * they escalate to needs_login only after SUSPECT_ESCALATE_COUNT
 * consecutive hits. Rejections PRESERVE their evidence in lastRefreshError
 * (never nulled). Dead rows self-retry after DEAD_RETRY_MIN. A proactive
 * sweep rotates inactive ok accounts just before expiry (lineage-gated).
 * A write-back guard refuses to adopt live tokens that provably belong to
 * a different snapshot (post-switch CLI write-back theft).
 *
 * Deadlock hardening (2026-07-24): an unguarded token-endpoint body read in
 * refreshInactiveToken could pend forever and wedge the serialize() mutex,
 * hanging every credential operation (production outage: switcher and usage
 * meter down). Fixed at the source (the abort deadline now spans the body
 * read) plus two defense layers: a per-op deadline inside both mutexes
 * (CRED_OP_TIMEOUT) and a stalled-chain watchdog that force-resets a chain
 * held past CHAIN_STALL_FACTOR times its deadline.
 *
 * Design: docs/plans/2026-07-02-credential-switcher-design.md sections 2, 3.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { getDataDir } = require('../utils/data-dir');

// ─── Endpoint and protocol constants (named, never inlined) ────────────────
// Ported from claude-swap.ps1 L554 to 558. The client id is Claude Code's own
// public OAuth client id; refreshes must present the same client.
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// ─── Token state model constants ────────────────────────────────────────────
const TOKEN_STATE_OK = 'ok';
const TOKEN_STATE_NEEDS_LOGIN = 'needs_login';
const TOKEN_STATE_UNVERIFIED = 'unverified';

// ─── Timing and limit constants ─────────────────────────────────────────────
// Refresh timeout is deliberately generous (15s, not the 5s the reference
// tool used); a slow link must classify as transient, never as a dead token.
const REFRESH_TIMEOUT_MS = 15000;
// Suspect ladder (expiry-fix spec Phase 1): a 'suspect' auth response (403,
// or 401 with no parseable body) is ambiguous evidence; Cloudflare's WAF in
// front of the token endpoint produces 403 false positives. Only this many
// CONSECUTIVE suspects escalate a row to needs_login; anything less keeps
// the prior tokenState and records auth_suspect evidence instead.
const SUSPECT_ESCALATE_COUNT = 3;
// Dead-retry window (expiry-fix spec Phase 1): a needs_login account is
// retried WITHOUT force once its last rejection evidence is older than this
// (ms). A repeat invalid_grant is harmless, and the retry self-heals rows
// that were killed by a WAF false positive or by the legacy nulled-evidence
// bug (those rows have no timestamp at all and retry immediately).
const DEAD_RETRY_MIN = 6 * 60 * 60 * 1000;
// Proactive refresh (expiry-fix spec Phase 3): the sweep only rotates an
// inactive account when its access token is within this many minutes of
// lapsing (just-in-time, not constantly), and the server clamps the sweep
// interval to at least the floor below.
const PROACTIVE_REFRESH_WINDOW_MIN = 30;
const PROACTIVE_REFRESH_FLOOR_MIN = 10;
// Treat an access token as expired 5 minutes early so an apply never hands
// the CLI a token that dies seconds later.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// Watcher events within this window after our own apply are ignored.
const SELF_WRITE_GUARD_MS = 3000;
// Atomic rename retry policy (Windows EPERM/EBUSY/EACCES under antivirus
// and concurrent readers; same lesson as store.js save()).
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 50;
// ─── Serialized-operation deadlines (deadlock hardening, 2026-07-24) ────────
// WHY these exist: the promise-chain mutex (`serialize`) advances only when
// the running operation's promise settles. On 2026-07-24 one operation whose
// promise NEVER settled (an unguarded token-endpoint body read inside
// refreshInactiveToken) wedged the chain in production for hours, hanging
// GET /api/credentials and blanking the account switcher and usage meter.
// The body-read bug is fixed at its source, but as defense in depth NO
// serialized operation may hold the chain longer than this deadline; past
// it the caller receives a typed, retryable CRED_OP_TIMEOUT (HTTP 503) and
// the chain advances. 60s is ~4x the worst legitimate apply (15s refresh
// plus 5s usage plus disk writes), so a deadline hit means a genuine wedge,
// never a slow-but-healthy operation.
const OP_TIMEOUT_MS = 60000;
// Mac operations ride multi-second SSH round trips (inventory sweep, then
// install + activate + verify), so their chain gets a roomier deadline.
const MAC_OP_TIMEOUT_MS = 120000;
// Stalled-chain watchdog (third layer, ON by default): check cadence and
// the multiple of the op deadline past which the chain is force-reset.
// With the deadline layer active this should never fire; it exists so a
// future code path that bypasses the deadline cannot resurrect the outage.
const CHAIN_WATCHDOG_INTERVAL_MS = 30000;
const CHAIN_STALL_FACTOR = 3;
const LABEL_MAX_LENGTH = 60;
const CREDENTIALS_FILE_NAME = '.credentials.json';
// Cross-process ownership contract shared with Myrlin's bridge credential
// router. The bridge creates this exclusive marker in the snapshot-pool
// root while it owns token refresh/write-back. CWM only honors the contract
// after an explicit opt-in, so the shipped default remains unchanged.
const POOL_OWNER_MARKER_FILE = '.myrlin-credential-pool-owner.json';
const EXTERNAL_BRIDGE_OWNER = 'myrlin-bridge-gateway';
const EXTERNAL_OWNER_ENV = 'CWM_CRED_EXTERNAL_BRIDGE_OWNER';
const CRED_POOL_EXTERNAL_OWNER_CODE = 'CRED_POOL_EXTERNAL_OWNER';
const POOL_OWNER_MARKER_MAX_BYTES = 8 * 1024;
// One-time claude-swap seed sentinel, written into the accounts dir after the
// first import attempt completes. The sentinel's PRESENCE (not snapshot
// count) is the "already seeded" signal: snapshot count is wrong evidence
// because the boot watcher self-captures the active account before the first
// seed can run (making the store non-empty and killing the import on any
// machine with a live login), and because deleting an account later must
// never trigger a silent re-import from the old tool's stale profiles.
const SEED_SENTINEL_FILE = '.seeded';

// ─── Default settings (section 2.3 of the design) ───────────────────────────
const DEFAULT_CRED_SETTINGS = Object.freeze({
  // Fail-safe handoff to an external bridge process. When true, CWM is a
  // passive reader of the credential pool even when the marker is absent
  // or malformed; operators must explicitly turn this back off before CWM
  // may resume ownership.
  externalBridgeOwner: false,
  mac: Object.freeze({
    enabled: false,
    host: 'arthurs-mac-mini',
    user: 'arthur',
    profileTool: '$HOME/.local/bin/claude-profile',
    postSwapCommand: '',
  }),
  usageCacheMinutes: 10,
  httpTimeoutSec: 5,
  sshTimeoutSec: 8,
  backupKeep: 20,
  claudeSwapSeedDir: '',
  // Proactive background refresh cadence in minutes; 0 disables the sweep.
  // ON BY DEFAULT (Arthur's decision, 2026-07-16): refresh tokens are
  // one-time-use, so whichever lineage holder refreshes first wins and the
  // others' stored pairs die server-side. Rotating parked accounts just
  // before expiry keeps the workbook the winner. The server clamps this to
  // PROACTIVE_REFRESH_FLOOR_MIN. See the accepted-risk note in server.js.
  proactiveRefreshMinutes: 20,
  // Lineage hint: the accountUuid live on the Mac (null = none known).
  // Persisted so the usage poller's lineage gate survives restarts; see
  // setMacActiveHint and the gate in _updateSnapshotUsageUnlocked.
  macActiveProfileId: null,
});

// ─── Module-level pure helpers (exported for tests and reuse) ───────────────

/**
 * Gate every profileId before it is used in path construction.
 * Accepts only hex digits and dashes, 8 to 64 chars (covers real UUIDs and
 * defends against path separators, dots, and other junk).
 *
 * @param {*} id - Candidate account uuid.
 * @returns {boolean} true when safe to use as a filename component.
 */
function validateAccountUuid(id) {
  return typeof id === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(id);
}

/**
 * Display fallback chain (design section 2.2), the single source of truth:
 * label if non-empty, else email, else the first 8 chars of the uuid plus
 * ' unnamed'. Never returns an empty string for a snapshot with a uuid.
 *
 * @param {{label?: string, email?: string, accountUuid?: string}} snapshot
 * @returns {string} Human-facing display name.
 */
function displayNameFor(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'unnamed';
  const label = typeof snapshot.label === 'string' ? snapshot.label.trim() : '';
  if (label) return label;
  const email = typeof snapshot.email === 'string' ? snapshot.email.trim() : '';
  if (email) return email;
  const uuid = typeof snapshot.accountUuid === 'string' ? snapshot.accountUuid : '';
  return (uuid.slice(0, 8) || 'unknown') + ' unnamed';
}

/**
 * Map a tokenState to the UI health string. Expired-but-refreshable renders
 * exactly like healthy (never amber): expiry is normal and self-healing.
 * One exception (expiry-fix spec Phase 1): an 'ok' row sitting under an
 * unresolved auth_suspect ladder renders amber (needs-attention), because
 * the last refresh attempt was answered suspiciously and the row is in a
 * retry-and-watch state, neither proven healthy nor proven dead.
 *
 * @param {string} tokenState - One of the TOKEN_STATE_* values.
 * @param {object|null} [lastRefreshError] - The snapshot's lastRefreshError
 *   evidence record, when available ({ at, kind, status, ... }).
 * @returns {'healthy'|'needs-attention'|'needs-re-login'}
 */
function healthFor(tokenState, lastRefreshError) {
  if (tokenState === TOKEN_STATE_OK) {
    if (lastRefreshError && lastRefreshError.kind === 'auth_suspect') return 'needs-attention';
    return 'healthy';
  }
  if (tokenState === TOKEN_STATE_NEEDS_LOGIN) return 'needs-re-login';
  return 'needs-attention';
}

/**
 * Serialize a credentials object back to .credentials.json file text.
 * Compact JSON shaped {"claudeAiOauth":{...}}, the same shape the reference
 * tool's New-CredentialsFileText writes in production. This is the ONLY
 * writer format for the live token file.
 *
 * @param {object} credentials - Parsed claudeAiOauth object.
 * @returns {string} Compact JSON text.
 */
function serializeCredentialsFile(credentials) {
  return JSON.stringify({ claudeAiOauth: credentials });
}

/**
 * Synchronous sleep used only inside the atomic-write retry loop.
 * Atomics.wait blocks without spinning; the fallback spin loop only runs
 * where SharedArrayBuffer is unavailable (never in stock Node).
 *
 * @param {number} ms - Milliseconds to block.
 * @returns {void}
 */
function _sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* bounded spin fallback */ }
  }
}

/**
 * Write a file atomically: temp file in the same directory (pid + random
 * suffix), verify the temp re-reads non-empty and not zero-filled, then
 * fs.renameSync with a Windows EPERM/EBUSY/EACCES retry (5 attempts, backoff
 * of 50ms times the attempt number). The temp file is unlinked in finally.
 *
 * @param {string} filePath - Destination path (parent dirs are created).
 * @param {string} text - Full file content.
 * @param {{mode?: number}} [opts] - Optional chmod applied best effort after
 *   the rename (pass 0o600 for secret files; ignored errors on Windows).
 * @returns {void} Throws on unrecoverable write or rename failure.
 */
function writeFileAtomic(filePath, text, opts = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmpPath, text, 'utf-8');
    // Verify before renaming: catch the Windows write-cache zero-fill mode.
    const written = fs.readFileSync(tmpPath, 'utf-8');
    if (!written || !written.trim() || written.charCodeAt(0) === 0) {
      throw new Error('atomic write verification failed: temp file empty or zero-filled');
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        fs.renameSync(tmpPath, filePath);
        break;
      } catch (err) {
        const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
        if (!transient || attempt >= RENAME_MAX_ATTEMPTS) throw err;
        _sleepSync(RENAME_BACKOFF_MS * attempt);
      }
    }
    if (opts.mode) {
      try { fs.chmodSync(filePath, opts.mode); } catch (_) { /* best effort */ }
    }
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
  }
}

/**
 * Build an Error carrying an HTTP status and a machine-readable code so the
 * route layer can map it straight through structuredError.
 *
 * @param {number} status - HTTP status code for the route layer.
 * @param {string} code - Machine-readable error code (e.g. CRED_NOT_FOUND).
 * @param {string} message - Human-readable message.
 * @param {boolean} [retryable=false] - Whether the client may retry.
 * @returns {Error} Error with .status, .code, .retryable attached.
 */
function credError(status, code, message, retryable = false) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.retryable = retryable;
  return err;
}

/**
 * Run fn under a hard deadline: resolves/rejects with fn's own outcome when
 * it settles in time, and rejects with a typed, retryable CRED_OP_TIMEOUT
 * (HTTP 503) when it does not. Used by the serialized-operation mutexes so
 * one never-settling operation can no longer wedge every later credential
 * operation (the 2026-07-24 production deadlock).
 *
 * The deadline timer is unref'd (it can never hold the process open) and is
 * always cleared once fn settles. NOTE, documented tradeoff: a timed-out
 * operation is not cancelled (promises cannot be); the chain simply stops
 * waiting for it. A post-timeout straggler write is theoretically possible
 * but the deadline is ~4x the worst legitimate operation, so a straggler is
 * overwhelmingly a network zombie, and a wedged mutex (total outage) is
 * strictly worse than that rare race.
 *
 * @param {() => (Promise<*>|*)} fn - Operation to run.
 * @param {number} timeoutMs - Hard deadline in ms.
 * @param {string} label - Short operation label for diagnosable errors.
 * @returns {Promise<*>} fn's outcome, or a CRED_OP_TIMEOUT rejection.
 */
function withOpDeadline(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      timer = null;
      reject(credError(503, 'CRED_OP_TIMEOUT',
        "serialized operation '" + label + "' did not settle within " + timeoutMs +
        'ms and was timed out so queued credential operations can proceed; retry shortly', true));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    Promise.resolve().then(fn).then(
      (value) => { if (timer) { clearTimeout(timer); timer = null; } resolve(value); },
      (err) => { if (timer) { clearTimeout(timer); timer = null; } reject(err); }
    );
  });
}

/**
 * Await `work`, but stop waiting after `ms`. Resolves true when work settled
 * (resolved OR rejected) inside the window, false when the deadline won.
 * Both outcomes of `work` are observed up front, so a late rejection can
 * never surface as an unhandled rejection. The work itself is never
 * cancelled; callers use this to serve best-effort results (e.g. the roster
 * list) without letting a wedged serialized call hang the response.
 *
 * @param {Promise<*>} work - The promise to wait on.
 * @param {number} ms - Maximum wait in ms.
 * @returns {Promise<boolean>} true = settled in time, false = still pending.
 */
function settleWithin(work, ms) {
  let timer = null;
  const settled = Promise.resolve(work).then(() => true, () => true);
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([settled, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Format an epoch-ms timestamp as yyyyMMdd-HHmmss for backup filenames.
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
 * Create a credential manager instance. Every dependency is injectable so
 * tests never touch the real HOME or the network.
 *
 * @param {object} [opts]
 * @param {string} [opts.claudeDir] - Dir holding .credentials.json. Default:
 *   CWM_CLAUDE_DIR env, else ~/.claude.
 * @param {string} [opts.claudeJsonPath] - Path to the identity file. Default:
 *   CWM_CLAUDE_JSON env, else ~/.claude.json.
 * @param {string} [opts.accountsDir] - Snapshot store dir. Default:
 *   <dataDir>/claude-accounts.
 * @param {() => object} [opts.settingsProvider] - Returns the raw
 *   settings.credentialSwitcher object (merged over defaults at read time).
 * @param {Function} [opts.fetchImpl] - fetch implementation (global fetch).
 * @param {string} [opts.usageUrl] - Usage endpoint. Default: env
 *   CWM_CRED_USAGE_URL, else the real Anthropic endpoint.
 * @param {string} [opts.tokenUrl] - Token endpoint. Default: env
 *   CWM_CRED_TOKEN_URL, else the real Anthropic endpoint.
 * @param {string} [opts.seedDir] - claude-swap seed dir override. Default:
 *   env CWM_CRED_SEED_DIR, else settings, else <home>/Desktop/claude-swap.
 * @param {() => number} [opts.clock] - Epoch-ms clock. Default Date.now.
 * @param {number} [opts.watchDebounceMs] - Watcher debounce. Default 500.
 * @param {number} [opts.pollIntervalMs] - Fallback poll. Default 30000.
 * @param {number} [opts.refreshTimeoutMs] - Refresh HTTP timeout. Default
 *   REFRESH_TIMEOUT_MS (15000). Injectable for hermetic timeout tests.
 * @param {number} [opts.opTimeoutMs] - Serialized-op deadline. Default
 *   OP_TIMEOUT_MS (60000). Injectable for hermetic deadlock tests.
 * @param {number} [opts.macOpTimeoutMs] - Mac-op deadline. Default
 *   MAC_OP_TIMEOUT_MS (120000). Injectable for hermetic deadlock tests.
 * @param {number} [opts.watchdogIntervalMs] - Stalled-chain watchdog check
 *   cadence. Default CHAIN_WATCHDOG_INTERVAL_MS (30000). Injectable.
 * @param {object} [opts.log] - Logger with warn/error/log. Default console.
 * @param {boolean} [opts.externalBridgeOwner] - Explicit passive-mode
 *   override. When omitted, CWM_CRED_EXTERNAL_BRIDGE_OWNER=1 or
 *   settings.externalBridgeOwner=true enables the mode.
 * @param {(patch: object) => void} [opts.settingsPatcher] - Optional write-back
 *   for manager-owned settings (the Mac-active lineage hint). Wired to the
 *   store by the server; absent in most tests (hint stays in memory).
 * @returns {object} The manager API (see the design section 3.1 table).
 */
function createCredentialManager(opts = {}) {
  const claudeDir = opts.claudeDir || process.env.CWM_CLAUDE_DIR || path.join(os.homedir(), '.claude');
  const claudeJsonPath = opts.claudeJsonPath || process.env.CWM_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
  const accountsDir = opts.accountsDir || path.join(getDataDir(), 'claude-accounts');
  const backupsDir = path.join(accountsDir, '..', 'claude-accounts-backups');
  const settingsProvider = typeof opts.settingsProvider === 'function' ? opts.settingsProvider : () => ({});
  // Optional write-back for manager-owned settings (currently only the
  // Mac-active lineage hint). Injected by the server so the manager never
  // learns store internals; absent in most tests, where the hint then
  // lives in memory for the manager's lifetime.
  const settingsPatcher = typeof opts.settingsPatcher === 'function' ? opts.settingsPatcher : null;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const usageUrl = opts.usageUrl || process.env.CWM_CRED_USAGE_URL || ANTHROPIC_USAGE_URL;
  const tokenUrl = opts.tokenUrl || process.env.CWM_CRED_TOKEN_URL || ANTHROPIC_TOKEN_URL;
  const seedDirOverride = opts.seedDir || process.env.CWM_CRED_SEED_DIR || '';
  const clock = opts.clock || Date.now;
  const watchDebounceMs = opts.watchDebounceMs || 500;
  const pollIntervalMs = opts.pollIntervalMs || 30000;
  const refreshTimeoutMs = opts.refreshTimeoutMs || REFRESH_TIMEOUT_MS;
  const opTimeoutMs = opts.opTimeoutMs || OP_TIMEOUT_MS;
  const macOpTimeoutMs = opts.macOpTimeoutMs || MAC_OP_TIMEOUT_MS;
  const watchdogIntervalMs = opts.watchdogIntervalMs || CHAIN_WATCHDOG_INTERVAL_MS;
  const log = opts.log || console;
  const externalBridgeOwnerOverride = opts.externalBridgeOwner;

  const credFilePath = path.join(claudeDir, CREDENTIALS_FILE_NAME);

  // Watcher and mutex state, per manager instance.
  let _watcher = null;
  let _debounceTimer = null;
  let _pollTimer = null;
  let _lastPollMtime = null;
  let _selfWriteUntil = 0;
  let _chain = Promise.resolve();
  // Dedicated Mac operation chain. WHY a second mutex: Mac bridge calls ride
  // on SSH round trips that can take seconds; holding the snapshot mutex
  // (`_chain`) across them would freeze every credential operation (list,
  // apply, rename) behind the network. Mac operations therefore serialize
  // against EACH OTHER here, and take the snapshot mutex only for the short
  // local read/merge portions.
  let _macChain = Promise.resolve();
  // In-memory cache of the last Mac inventory sweep (whitelisted fields
  // only; never token material). Null until the first sweep completes.
  let _macState = null;
  // Session copy of the Mac-active lineage hint. undefined = not read yet
  // (fall back to persisted settings); null = known none; string = uuid.
  let _macActiveHint;
  // Callback that pulls fresh Mac state (one inventory sweep + sync-back).
  // Registered by the routes layer, because the manager requiring the
  // bridge directly would create a circular require (the bridge already
  // requires this module for serializeCredentialsFile).
  let _macStateRefresher = null;
  // Stalled-chain watchdog bookkeeping (deadlock hardening, 2026-07-24):
  // the label and clock() start stamp of the serialized op CURRENTLY
  // holding each mutex (0 = idle), a sequence counter so a straggler op
  // settling late can never clear a NEWER op's stamp, and the watchdog
  // interval handle.
  let _opStartedAt = 0;
  let _opLabel = '';
  let _opSeq = 0;
  let _macOpStartedAt = 0;
  let _macOpLabel = '';
  let _macOpSeq = 0;
  let _chainWatchdogTimer = null;

  /**
   * Promise-chain mutex. Serializes every mutating operation so two GUI
   * clients and the watcher can never interleave snapshot or live-file
   * writes. Errors propagate to the caller but never break the chain.
   *
   * DEADLOCK HARDENING (2026-07-24): every op runs under withOpDeadline,
   * so a never-settling operation (the outage class) rejects its caller
   * with CRED_OP_TIMEOUT after opTimeoutMs instead of holding the chain
   * forever, and the running op's label + start stamp are recorded for the
   * stalled-chain watchdog.
   *
   * @param {() => (Promise<*>|*)} fn - Operation to run exclusively.
   * @param {string} [label] - Short op label for timeout errors and logs.
   * @returns {Promise<*>} Resolves/rejects with fn's outcome.
   */
  function serialize(fn, label) {
    const opLabel = String(label || 'op');
    const run = _chain.then(() => {
      _opSeq += 1;
      const mySeq = _opSeq;
      _opStartedAt = clock();
      _opLabel = opLabel;
      // Clear the stamp only if no newer op has taken the chain since
      // (a post-timeout straggler must not blind the watchdog to op N+1).
      const clearStamp = () => { if (_opSeq === mySeq) { _opStartedAt = 0; _opLabel = ''; } };
      return withOpDeadline(fn, opTimeoutMs, opLabel).then(
        (value) => { clearStamp(); return value; },
        (err) => { clearStamp(); throw err; }
      );
    });
    _chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Promise-chain mutex for Mac bridge operations (inventory sweeps and
   * profile applies). Two Mac operations can never interleave their SSH
   * conversations; see the _macChain WHY comment above. Errors propagate to
   * the caller but never break the chain.
   *
   * Same deadlock hardening as serialize(), with the roomier
   * macOpTimeoutMs because these ops ride multi-second SSH round trips.
   *
   * @param {() => (Promise<*>|*)} fn - Mac operation to run exclusively.
   * @param {string} [label] - Short op label for timeout errors and logs.
   * @returns {Promise<*>} Resolves/rejects with fn's outcome.
   */
  function runMacExclusive(fn, label) {
    const opLabel = String(label || 'mac-op');
    const run = _macChain.then(() => {
      _macOpSeq += 1;
      const mySeq = _macOpSeq;
      _macOpStartedAt = clock();
      _macOpLabel = opLabel;
      const clearStamp = () => { if (_macOpSeq === mySeq) { _macOpStartedAt = 0; _macOpLabel = ''; } };
      return withOpDeadline(fn, macOpTimeoutMs, opLabel).then(
        (value) => { clearStamp(); return value; },
        (err) => { clearStamp(); throw err; }
      );
    });
    _macChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Start the stalled-chain watchdog (idempotent; ON by default from
   * construction). Every watchdogIntervalMs it checks whether the op
   * currently holding either mutex has exceeded CHAIN_STALL_FACTOR times
   * its deadline; if so it logs loudly and force-resets that chain so
   * queued credential operations can run again. With the withOpDeadline
   * layer in place this should never fire; it is the last line of defense
   * against a future code path that bypasses the deadline. The interval is
   * unref'd so it can never hold the process (or a test run) open.
   *
   * @returns {void}
   */
  function _startChainWatchdog() {
    if (_chainWatchdogTimer) return; // already running
    _chainWatchdogTimer = setInterval(() => {
      try {
        const now = clock();
        const stallMs = opTimeoutMs * CHAIN_STALL_FACTOR;
        if (_opStartedAt && (now - _opStartedAt) > stallMs) {
          log.error("[Credentials] STALLED operation chain: op '" + _opLabel + "' has held the mutex for "
            + (now - _opStartedAt) + 'ms (limit ' + stallMs + 'ms); force-resetting the chain so credential operations can resume');
          _chain = Promise.resolve();
          _opStartedAt = 0;
          _opLabel = '';
        }
        const macStallMs = macOpTimeoutMs * CHAIN_STALL_FACTOR;
        if (_macOpStartedAt && (now - _macOpStartedAt) > macStallMs) {
          log.error("[Credentials] STALLED Mac operation chain: op '" + _macOpLabel + "' has held the Mac mutex for "
            + (now - _macOpStartedAt) + 'ms (limit ' + macStallMs + 'ms); force-resetting the Mac chain');
          _macChain = Promise.resolve();
          _macOpStartedAt = 0;
          _macOpLabel = '';
        }
      } catch (_) { /* the watchdog must never throw */ }
    }, watchdogIntervalMs);
    if (_chainWatchdogTimer.unref) _chainWatchdogTimer.unref();
  }

  /**
   * Stop the stalled-chain watchdog (idempotent). Called from
   * stopCredentialWatcher so shutdown and tests never leak the interval.
   *
   * @returns {void}
   */
  function _stopChainWatchdog() {
    if (_chainWatchdogTimer) { clearInterval(_chainWatchdogTimer); _chainWatchdogTimer = null; }
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
    return {
      ...DEFAULT_CRED_SETTINGS,
      ...raw,
      mac: { ...DEFAULT_CRED_SETTINGS.mac, ...(raw.mac || {}) },
    };
  }

  /**
   * Whether CWM has explicitly handed credential-pool ownership to the
   * external bridge. An injected override wins in tests/embedders, then the
   * strict "=1" environment flag, then the persisted credential-switcher
   * setting. The marker itself never opts CWM in: this preserves legacy
   * behavior unless an operator deliberately enables the guard.
   *
   * Once configured, the answer stays fail-closed regardless of marker
   * validity/presence. A missing marker means "external owner not currently
   * observable", not permission for CWM to start mutating the pool again.
   *
   * @returns {boolean}
   */
  function isCredentialPoolReadOnly() {
    if (externalBridgeOwnerOverride !== undefined) return externalBridgeOwnerOverride === true;
    if (process.env[EXTERNAL_OWNER_ENV] === '1') return true;
    return getSettings().externalBridgeOwner === true;
  }

  /**
   * Read and validate the Myrlin bridge ownership marker without exposing
   * its lease id. The read is bounded and accepts exactly the v1 owner shape
   * written by bridge-credential-provider-router.js.
   *
   * @returns {{path: string, present: boolean, valid: boolean, owner: string|null, pid: number|null, startedAt: string|null}}
   */
  function readCredentialPoolOwnerMarker() {
    const markerPath = path.join(accountsDir, POOL_OWNER_MARKER_FILE);
    const empty = {
      path: markerPath,
      present: false,
      valid: false,
      owner: null,
      pid: null,
      startedAt: null,
    };
    try {
      const stat = fs.statSync(markerPath);
      if (!stat.isFile() || stat.size < 1 || stat.size > POOL_OWNER_MARKER_MAX_BYTES) {
        return { ...empty, present: true };
      }
      const value = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      const valid = !!value && typeof value === 'object' && !Array.isArray(value)
        && value.version === 1
        && value.owner === EXTERNAL_BRIDGE_OWNER
        && Number.isSafeInteger(value.pid) && value.pid > 0
        && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
        && typeof value.leaseId === 'string' && /^[a-f0-9]{32}$/.test(value.leaseId);
      if (!valid) return { ...empty, present: true };
      return {
        path: markerPath,
        present: true,
        valid: true,
        owner: value.owner,
        pid: value.pid,
        startedAt: value.startedAt,
      };
    } catch (_) {
      return fs.existsSync(markerPath) ? { ...empty, present: true } : empty;
    }
  }

  /**
   * Safe ownership diagnostics for routes/tests. Contains no credentials or
   * lease secret, only the configured/passive state and sanitized marker
   * metadata.
   *
   * @returns {{configured: boolean, readOnly: boolean, marker: object}}
   */
  function getCredentialPoolState() {
    const configured = isCredentialPoolReadOnly();
    return {
      configured,
      readOnly: configured,
      marker: readCredentialPoolOwnerMarker(),
    };
  }

  /**
   * Throw the typed HTTP-409 conflict used at every credential mutation
   * boundary while the bridge owns the pool.
   *
   * @param {string} [operation] - Human-readable blocked operation.
   * @returns {void}
   */
  function assertCredentialPoolWritable(operation) {
    if (!isCredentialPoolReadOnly()) return;
    const marker = readCredentialPoolOwnerMarker();
    const owner = marker.valid ? marker.owner : EXTERNAL_BRIDGE_OWNER;
    const action = operation ? String(operation).trim() : 'Credential mutation';
    throw credError(
      409,
      CRED_POOL_EXTERNAL_OWNER_CODE,
      action + ' is disabled because credential-pool ownership is assigned to ' + owner + '. CWM is in passive read-only mode.',
      false,
    );
  }

  /**
   * Resolve the claude-swap seed directory: explicit override (opts/env)
   * wins, then the settings value, then <home>/Desktop/claude-swap.
   *
   * @returns {string} Directory to probe for profiles/pc/*.json.
   */
  function resolveSeedDir() {
    if (seedDirOverride) return seedDirOverride;
    const cfg = getSettings().claudeSwapSeedDir;
    if (cfg) return cfg;
    return path.join(os.homedir(), 'Desktop', 'claude-swap');
  }

  /**
   * Read the live PC token file: verbatim text plus the parsed claudeAiOauth
   * object. Null-safe; a missing or malformed file degrades to null.
   *
   * @returns {{credText: string, oauth: object}|null}
   */
  function readActiveCredential() {
    try {
      const credText = fs.readFileSync(credFilePath, 'utf-8');
      const parsed = JSON.parse(credText);
      const oauth = parsed && parsed.claudeAiOauth;
      if (!oauth || typeof oauth !== 'object') return null;
      return { credText, oauth };
    } catch (_) {
      return null;
    }
  }

  /**
   * Read the live PC identity file (.claude.json, possibly multiple MB;
   * JSON.parse collapses duplicate keys last-wins, byte-identical behavior
   * to the node -e path claude-swap already uses) and return oauthAccount.
   *
   * @returns {object|null} The oauthAccount object, or null.
   */
  function readActiveIdentity() {
    try {
      const text = fs.readFileSync(claudeJsonPath, 'utf-8');
      const parsed = JSON.parse(text);
      const account = parsed && parsed.oauthAccount;
      if (!account || typeof account !== 'object') return null;
      return account;
    } catch (_) {
      return null;
    }
  }

  /**
   * Convenience: the accountUuid of the account active on this machine.
   *
   * @returns {string|null}
   */
  function getActiveAccountUuid() {
    const identity = readActiveIdentity();
    const uuid = identity && identity.accountUuid;
    return (typeof uuid === 'string' && uuid) ? uuid : null;
  }

  /**
   * Convenience: the email of the account active on this machine.
   *
   * @returns {string|null}
   */
  function getActiveEmail() {
    const identity = readActiveIdentity();
    const email = identity && identity.emailAddress;
    return (typeof email === 'string' && email) ? email : null;
  }

  /**
   * Path of the snapshot file for one account. Validates the uuid first so
   * no unvalidated id ever reaches path construction.
   *
   * @param {string} accountUuid
   * @returns {string} Absolute snapshot path.
   */
  function snapshotPath(accountUuid) {
    if (!validateAccountUuid(accountUuid)) {
      throw credError(400, 'VALIDATION', 'profileId must be 8 to 64 hex/dash characters');
    }
    return path.join(accountsDir, accountUuid + '.json');
  }

  /**
   * Normalize a raw parsed snapshot to the current schema. Missing
   * tokenState migrates from any legacy tokenDead flag, but conservatively:
   * legacy dead flags come from the buggy reference tool and are treated as
   * 'unverified' (cheap to re-derive), never as needs_login.
   *
   * @param {object} snap - Parsed snapshot object.
   * @returns {object} Normalized snapshot.
   */
  function _normalizeSnapshot(snap) {
    if (!snap.tokenState) {
      snap.tokenState = snap.tokenDead === true ? TOKEN_STATE_UNVERIFIED : TOKEN_STATE_OK;
    }
    if (snap.lastRefreshError === undefined) snap.lastRefreshError = null;
    if (snap.usage === undefined) snap.usage = null;
    if (typeof snap.label !== 'string') snap.label = '';
    delete snap.tokenDead; // legacy field; derived at read time from tokenState
    return snap;
  }

  /**
   * Read one snapshot by accountUuid. Missing or corrupt files degrade to
   * null (the next capture self-heals them).
   *
   * @param {string} accountUuid
   * @returns {object|null} Normalized snapshot or null.
   */
  function readSnapshot(accountUuid) {
    if (!validateAccountUuid(accountUuid)) return null;
    try {
      const text = fs.readFileSync(path.join(accountsDir, accountUuid + '.json'), 'utf-8');
      const snap = JSON.parse(text);
      if (!snap || typeof snap !== 'object' || !validateAccountUuid(snap.accountUuid)) return null;
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
      const uuid = f.slice(0, -5);
      const snap = readSnapshot(uuid);
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
    assertCredentialPoolWritable('Credential snapshot write');
    const p = snapshotPath(snapshot.accountUuid);
    writeFileAtomic(p, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    return snapshot;
  }

  /**
   * Read-modify-write one snapshot: apply the patch fields over the current
   * on-disk state and bump updatedAt. Throws CRED_NOT_FOUND when missing.
   *
   * @param {string} accountUuid
   * @param {object} patch - Fields to overwrite.
   * @returns {object} The updated snapshot.
   */
  function _mutateSnapshot(accountUuid, patch) {
    const current = readSnapshot(accountUuid);
    if (!current) {
      throw credError(404, 'CRED_NOT_FOUND', 'No stored credential snapshot for profile ' + accountUuid + '.');
    }
    const next = { ...current, ...patch, updatedAt: new Date(clock()).toISOString() };
    return _writeSnapshot(next);
  }

  /**
   * Persist a snapshot with carry-forward semantics (design 2.1/2.2): an
   * existing non-empty label survives unless preserveLabel is explicitly
   * false; usage, tokenState, lastRefreshError, and savedAt carry forward
   * when the incoming snapshot omits them.
   *
   * @param {object} snapshot - Partial or full snapshot (accountUuid required).
   * @param {{preserveLabel?: boolean}} [saveOpts]
   * @returns {object} The merged, persisted snapshot.
   */
  function saveSnapshot(snapshot, saveOpts = {}) {
    assertCredentialPoolWritable('Credential snapshot save');
    if (!snapshot || !validateAccountUuid(snapshot.accountUuid)) {
      throw credError(400, 'VALIDATION', 'snapshot.accountUuid is required and must be a valid account uuid');
    }
    const preserveLabel = saveOpts.preserveLabel !== false;
    const existing = readSnapshot(snapshot.accountUuid);
    const nowIso = new Date(clock()).toISOString();
    const existingLabel = existing && existing.label ? existing.label : '';
    const incomingLabel = snapshot.label != null ? String(snapshot.label) : '';
    const merged = {
      accountUuid: snapshot.accountUuid,
      email: snapshot.email != null ? snapshot.email : (existing ? existing.email : ''),
      label: (preserveLabel && existingLabel) ? existingLabel : (incomingLabel || existingLabel),
      savedAt: (existing && existing.savedAt) || snapshot.savedAt || nowIso,
      updatedAt: nowIso,
      credentials: snapshot.credentials !== undefined ? snapshot.credentials : (existing ? existing.credentials : null),
      identity: snapshot.identity !== undefined ? snapshot.identity : (existing ? existing.identity : null),
      usage: snapshot.usage !== undefined ? snapshot.usage : (existing ? existing.usage : null),
      tokenState: snapshot.tokenState !== undefined ? snapshot.tokenState : ((existing && existing.tokenState) || TOKEN_STATE_UNVERIFIED),
      lastRefreshError: snapshot.lastRefreshError !== undefined ? snapshot.lastRefreshError : ((existing && existing.lastRefreshError) || null),
    };
    return _writeSnapshot(merged);
  }

  /**
   * Sanitize the raw usage-endpoint response to the stored shape:
   * five_hour/seven_day {utilization, resets_at}, optional per-model weekly
   * windows (seven_day_opus / seven_day_sonnet, usually null upstream), plus
   * a sanitized limits[] array. Per-model breakdown: 'weekly_scoped' limit
   * rows carry an OBJECT scope whose scope.model.display_name is the model
   * name (e.g. 'Opus', 'Fable'); that display name is extracted onto
   * row.model so the UI can render per-model meters. String scopes are kept
   * as row.scope (legacy shape). The raw scope object itself is NEVER
   * stored (whitelist discipline; only the display name survives).
   * Null-tolerant everywhere; endpoint drift degrades to nulls, never to a
   * crash.
   *
   * @param {object|null} raw - Parsed usage response body.
   * @returns {object|null} Stored usage shape, or null.
   */
  function _mapUsageResponse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pickWindow = (w) => {
      if (!w || typeof w !== 'object') return null;
      return {
        utilization: typeof w.utilization === 'number' ? w.utilization : null,
        resets_at: typeof w.resets_at === 'string' ? w.resets_at : null,
      };
    };
    const usage = {
      five_hour: pickWindow(raw.five_hour),
      seven_day: pickWindow(raw.seven_day),
      fetchedAt: new Date(clock()).toISOString(),
    };
    // Top-level per-model weekly windows. The endpoint sends these as null
    // for most accounts; capture them only when present and object-shaped so
    // the stored snapshot stays lean and old snapshots keep their shape.
    const sevenDayOpus = pickWindow(raw.seven_day_opus);
    if (sevenDayOpus) usage.seven_day_opus = sevenDayOpus;
    const sevenDaySonnet = pickWindow(raw.seven_day_sonnet);
    if (sevenDaySonnet) usage.seven_day_sonnet = sevenDaySonnet;
    if (Array.isArray(raw.limits)) {
      usage.limits = raw.limits
        .filter((l) => l && typeof l === 'object')
        .map((l) => {
          const row = {};
          if (typeof l.kind === 'string') row.kind = l.kind;
          if (typeof l.group === 'string') row.group = l.group;
          if (typeof l.percent === 'number') row.percent = l.percent;
          if (typeof l.severity === 'string') row.severity = l.severity;
          if (typeof l.resets_at === 'string') row.resets_at = l.resets_at;
          if (typeof l.is_active === 'boolean') row.is_active = l.is_active;
          if (typeof l.scope === 'string') {
            row.scope = l.scope;
          } else if (l.scope && typeof l.scope === 'object'
            && l.scope.model && typeof l.scope.model === 'object'
            && typeof l.scope.model.display_name === 'string') {
            // Object scope: the per-model breakdown. Extract ONLY the
            // display name; a malformed scope (missing model or a non-string
            // display_name) degrades to no model field, never a throw.
            row.model = l.scope.model.display_name;
          }
          return row;
        });
    }
    return usage;
  }

  /**
   * Read-only usage fetch for one access token. Safe for the ACTIVE
   * account's live token (a GET never mutates tokens). Returns null on any
   * failure; usage failures never say anything about the refresh token and
   * never change tokenState.
   *
   * LOCK-IN (2026-07-24 deadlock): the abort timer is cleared ONLY in the
   * finally block so it spans the res.json() body read. Do not "optimize"
   * the clearTimeout up to the header arrival; that exact pattern in
   * refreshInactiveToken caused a production deadlock (a stalled body read
   * that never settles wedges the serialize() mutex forever). A hermetic
   * stalled-body test in test/credential-deadlock.test.js enforces this.
   *
   * @param {string} accessToken - A live or stored OAuth access token.
   * @returns {Promise<object|null>} Stored usage shape or null.
   */
  async function fetchUsage(accessToken) {
    if (!accessToken || typeof fetchImpl !== 'function') return null;
    const timeoutMs = Math.max(1, Number(getSettings().httpTimeoutSec) || 5) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(usageUrl, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
        },
        signal: controller.signal,
      });
      if (!res || !res.ok) return null;
      const raw = await res.json().catch(() => null);
      return _mapUsageResponse(raw);
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Exchange a refresh token for a fresh pair at the OAuth token endpoint,
   * with the CORRECTED failure classification (this is where the reference
   * tool's bug lived; it returned null for every failure kind), further
   * split per the expiry-fix spec Phase 1 (rejected vs suspect):
   *
   *   ok         { ok:true, tokens:{accessToken, refreshToken, expiresAt} }
   *   rejected   DEFINITIVE auth rejection ONLY: HTTP 400/401 whose JSON
   *              body has error === 'invalid_grant' (or no stored refresh
   *              token at all, kind 'no_refresh_token'). Only /login
   *              revives the account.
   *   suspect    AMBIGUOUS auth answer: any HTTP 403 (Cloudflare's WAF in
   *              front of the token endpoint throws 403 false positives)
   *              or a 401 with no parseable body. NOT a death verdict on
   *              its own; callers run the suspect ladder and escalate only
   *              after SUSPECT_ESCALATE_COUNT consecutive suspects.
   *   transient  network errors, AbortError timeouts, HTTP 429, HTTP 5xx.
   *              NEVER a death verdict.
   *   protocol   any other rejection (e.g. a non-invalid_grant 400): OUR
   *              request bug; logged loudly, caller keeps the prior state.
   *
   * A response without refresh_token keeps the old one. expires_in seconds
   * convert to absolute epoch ms. MUST NEVER be called for the account
   * active on this machine (races the CLI's own rotation).
   *
   * @param {string} refreshToken - The stored refresh token to exchange.
   * @returns {Promise<object>} Classification object per above.
   */
  async function refreshInactiveToken(refreshToken) {
    assertCredentialPoolWritable('OAuth token refresh');
    if (!refreshToken) {
      return { ok: false, verdict: 'rejected', kind: 'no_refresh_token', status: null, detail: 'no stored refresh token' };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, verdict: 'transient', kind: 'network', status: null, detail: 'no fetch implementation available' };
    }
    // ─── ROOT CAUSE OF THE 2026-07-24 PRODUCTION DEADLOCK, DO NOT REGRESS ───
    // WHY the abort deadline must span the BODY READ and not just the
    // headers: the old code cleared this timer the moment response headers
    // arrived and only AFTER that awaited res.json(). When a connection
    // dies without the runtime propagating the failure to the body stream
    // (reproduced on Node v22: res.json() pending 300+ seconds; in
    // production, hours), that unguarded body read never settles. Because
    // this function runs INSIDE the serialize() mutex (usage updates,
    // applies, the proactive sweep), the chain then never advances and
    // every later credential operation hangs forever, taking down the
    // account switcher and usage meter. One controller now covers the
    // request AND the body read, and the timer is cleared ONLY in finally,
    // mirroring fetchUsage (the correct pattern in this file).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
    if (timer.unref) timer.unref();
    let res;
    let body = null;
    try {
      try {
        res = await fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: ANTHROPIC_OAUTH_CLIENT_ID,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR'));
        return {
          ok: false,
          verdict: 'transient',
          kind: timedOut ? 'timeout' : 'network',
          status: null,
          detail: String((err && err.message) || err),
        };
      }
      try {
        body = await res.json();
      } catch (err) {
        // An abort-shaped failure HERE means our deadline fired while the
        // body was still streaming. A timeout is NEVER evidence the
        // credential is dead, so this classifies transient even when the
        // status line alone (e.g. a stalled 401) would otherwise have read
        // as suspect. Malformed-but-received JSON falls through with a
        // null body to the status-based classification below, exactly as
        // it did before this hardening.
        const aborted = controller.signal.aborted ||
          !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR'));
        if (aborted) {
          return {
            ok: false,
            verdict: 'transient',
            kind: 'timeout',
            status: null,
            detail: 'token endpoint sent HTTP ' + (res && res.status) + ' headers but the body read did not finish within ' + refreshTimeoutMs + 'ms',
          };
        }
        body = null;
      }
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const accessToken = body && typeof body.access_token === 'string' ? body.access_token : '';
      if (!accessToken) {
        return { ok: false, verdict: 'protocol', status: res.status, detail: 'token response missing access_token' };
      }
      const newRefresh = (body && typeof body.refresh_token === 'string' && body.refresh_token) ? body.refresh_token : refreshToken;
      const expiresInSec = (body && Number.isFinite(Number(body.expires_in))) ? Number(body.expires_in) : 0;
      return {
        ok: true,
        tokens: { accessToken, refreshToken: newRefresh, expiresAt: clock() + (expiresInSec * 1000) },
      };
    }
    const status = res.status;
    const bodyError = (body && typeof body.error === 'string') ? body.error : null;
    if (status === 403) {
      // Demoted from a death verdict (expiry-fix spec): a 403 is usually
      // the Cloudflare WAF, not the OAuth server; the ladder decides.
      return { ok: false, verdict: 'suspect', status, detail: bodyError || 'HTTP 403 from token endpoint' };
    }
    if ((status === 400 || status === 401) && bodyError === 'invalid_grant') {
      return { ok: false, verdict: 'rejected', kind: 'auth', status, detail: 'invalid_grant' };
    }
    if (status === 401 && body === null) {
      // Demoted from a death verdict (expiry-fix spec): without a parseable
      // body there is no invalid_grant evidence; the ladder decides.
      return { ok: false, verdict: 'suspect', status, detail: 'HTTP 401 with no parseable body' };
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
      return { ok: false, verdict: 'transient', kind: 'server', status, detail: 'HTTP ' + status + ' from token endpoint' };
    }
    // Anything else (including a non-invalid_grant 400) is OUR request bug:
    // log loudly and keep the prior stored state.
    return { ok: false, verdict: 'protocol', status, detail: 'unexpected token endpoint response HTTP ' + status + (bodyError ? ' (' + bodyError + ')' : '') };
  }

  /**
   * True when the stored access token should be treated as expired at
   * `now` (5 minute early skew, missing expiry reads as already expired).
   *
   * @param {object|null} credentials - Stored claudeAiOauth object.
   * @param {number} now - Epoch ms.
   * @returns {boolean}
   */
  function _isAccessTokenExpired(credentials, now) {
    const expMs = credentials ? Number(credentials.expiresAt) || 0 : 0;
    return (expMs - EXPIRY_SKEW_MS) <= now;
  }

  /**
   * Record a transient or protocol refresh failure on a snapshot without
   * touching tokenState. Protocol failures log loudly (they are our bug).
   *
   * @param {string} accountUuid
   * @param {object} r - Non-ok classification from refreshInactiveToken.
   * @returns {object} The updated snapshot.
   */
  function _recordRefreshFailure(accountUuid, r) {
    if (r.verdict === 'protocol') {
      log.error('[Credentials] token refresh PROTOCOL error for ' + accountUuid + ': ' + r.detail +
        ' (this is a request bug on our side, not a dead token; prior state kept)');
    } else {
      log.warn('[Credentials] transient token refresh failure for ' + accountUuid + ': ' + (r.kind || 'unknown') + ' ' + (r.detail || ''));
    }
    return _mutateSnapshot(accountUuid, {
      lastRefreshError: {
        at: new Date(clock()).toISOString(),
        kind: r.verdict === 'protocol' ? 'protocol' : (r.kind || 'network'),
        status: r.status != null ? r.status : null,
        detail: String(r.detail || ''),
      },
    });
  }

  /**
   * Record a DEFINITIVE auth rejection: tokenState becomes needs_login and,
   * crucially, the evidence is PRESERVED (the old code wrote
   * lastRefreshError: null here, erasing the at/kind/status story and
   * making every dead row undiagnosable; expiry-fix spec Phase 1 item 2).
   * The detail string never carries token material: it comes from the
   * token endpoint's error field or our own fixed strings.
   *
   * @param {string} accountUuid - Snapshot to mark.
   * @param {{kind?: string, status?: number|null, detail?: string}} r -
   *   Rejection classification (from refreshInactiveToken) or a synthetic
   *   record (e.g. kind 'no_refresh_token' from the no-token early outs).
   * @returns {object} The updated snapshot.
   */
  function _recordAuthRejection(accountUuid, r) {
    return _mutateSnapshot(accountUuid, {
      tokenState: TOKEN_STATE_NEEDS_LOGIN,
      lastRefreshError: {
        at: new Date(clock()).toISOString(),
        kind: (r && r.kind) || 'auth',
        status: (r && r.status != null) ? r.status : null,
        detail: String((r && r.detail) || ''),
      },
    });
  }

  /**
   * Run one rung of the suspect ladder (expiry-fix spec Phase 1 item 3):
   * an ambiguous auth answer (403 / bodyless 401) increments a consecutive
   * counter carried on lastRefreshError. Below SUSPECT_ESCALATE_COUNT the
   * prior tokenState is KEPT (a single Cloudflare 403 no longer nukes the
   * row); at the threshold the row escalates to needs_login with the full
   * escalation story preserved. Any successful refresh or usage fetch
   * clears lastRefreshError and thereby resets the counter, so only truly
   * consecutive suspects escalate.
   *
   * @param {string} accountUuid - Snapshot to update.
   * @param {{status?: number|null, detail?: string}} r - Suspect
   *   classification from refreshInactiveToken.
   * @returns {{snap: object, escalated: boolean}} The updated snapshot and
   *   whether this rung crossed the escalation threshold.
   */
  function _recordSuspect(accountUuid, r) {
    const current = readSnapshot(accountUuid);
    const prior = current ? current.lastRefreshError : null;
    const priorCount = (prior && prior.kind === 'auth_suspect' && Number.isFinite(Number(prior.count)))
      ? Number(prior.count) : 0;
    const count = priorCount + 1;
    const status = (r && r.status != null) ? r.status : null;
    if (count >= SUSPECT_ESCALATE_COUNT) {
      log.warn('[Credentials] suspect auth response for ' + accountUuid + ' (HTTP ' + status + '): '
        + count + ' consecutive; escalating to needs_login');
      const snap = _mutateSnapshot(accountUuid, {
        tokenState: TOKEN_STATE_NEEDS_LOGIN,
        lastRefreshError: {
          at: new Date(clock()).toISOString(),
          kind: 'auth',
          status,
          count,
          detail: 'escalated after ' + count + ' consecutive suspect auth responses (last: '
            + String((r && r.detail) || '') + ')',
        },
      });
      return { snap, escalated: true };
    }
    log.warn('[Credentials] suspect auth response for ' + accountUuid + ' (HTTP ' + status + '): '
      + count + ' of ' + SUSPECT_ESCALATE_COUNT + ' before escalation; prior state kept');
    const snap = _mutateSnapshot(accountUuid, {
      lastRefreshError: {
        at: new Date(clock()).toISOString(),
        kind: 'auth_suspect',
        status,
        count,
        detail: String((r && r.detail) || ''),
      },
    });
    return { snap, escalated: false };
  }

  /**
   * Whether a needs_login snapshot is due for an automatic (non-forced)
   * retry (expiry-fix spec Phase 1 item 4). True when the last rejection
   * evidence is older than DEAD_RETRY_MIN, or when there is no readable
   * timestamp at all (legacy rows whose evidence the old code nulled out).
   * A repeat invalid_grant is harmless, and the retry self-heals rows that
   * were killed by a WAF false positive.
   *
   * @param {object} snap - The needs_login snapshot.
   * @param {number} now - Epoch ms.
   * @returns {boolean} True when the dead row should be retried.
   */
  function _isDeadRetryDue(snap, now) {
    const atText = snap && snap.lastRefreshError && snap.lastRefreshError.at;
    const at = atText ? Date.parse(atText) : NaN;
    if (!Number.isFinite(at)) return true; // no evidence: retry is harmless
    return (now - at) >= DEAD_RETRY_MIN;
  }

  /**
   * Unlocked core of updateSnapshotUsage. Full token policy with the
   * corrected state model:
   *   cache fresher than usageCacheMinutes and no force: zero network;
   *   account ACTIVE here: read-only live token, NEVER refresh;
   *   inactive + expired: refresh, PERSIST THE ROTATED PAIR IMMEDIATELY
   *     (before the usage call; the old refresh token dies server-side the
   *     instant the new one exists);
   *   refresh classification: needs_login only on a definitive rejection;
   *     transient/protocol failures keep the prior state;
   *   usage success writes usage and clears needs_login; usage failure
   *     keeps the prior cache and NEVER changes tokenState.
   *
   * @param {string} accountUuid
   * @param {{force?: boolean}} [usageOpts]
   * @returns {Promise<object>} The (possibly updated) snapshot.
   */
  async function _updateSnapshotUsageUnlocked(accountUuid, usageOpts = {}) {
    const force = !!usageOpts.force;
    if (!validateAccountUuid(accountUuid)) {
      throw credError(400, 'VALIDATION', 'profileId must be a valid account uuid');
    }
    let snap = readSnapshot(accountUuid);
    if (!snap) {
      throw credError(404, 'CRED_NOT_FOUND', 'No stored credential snapshot for profile ' + accountUuid + '.');
    }
    // Passive mode serves the last safely cached usage projection only.
    // It performs no usage request (which would otherwise need a snapshot
    // cache write) and, critically, never reaches the refresh-token path.
    if (isCredentialPoolReadOnly()) return snap;
    const now = clock();
    const cacheMs = Math.max(0, Number(getSettings().usageCacheMinutes) || 10) * 60000;
    const fetchedAtMs = snap.usage && snap.usage.fetchedAt ? Date.parse(snap.usage.fetchedAt) : NaN;
    if (!force && Number.isFinite(fetchedAtMs) && (now - fetchedAtMs) < cacheMs) {
      return snap; // fresh cache: zero network calls
    }

    const activeUuid = getActiveAccountUuid();
    if (activeUuid && activeUuid === snap.accountUuid) {
      // ACTIVE on this machine: strictly read-only with the LIVE token.
      // Refreshing here would race the CLI's own rotation and brick the
      // live login. Locked by a dedicated unit test.
      const live = readActiveCredential();
      const liveToken = live && live.oauth && live.oauth.accessToken ? live.oauth.accessToken : null;
      if (!liveToken) return snap;
      const usage = await fetchUsage(liveToken);
      if (usage) {
        // Usage success is positive evidence the account is alive.
        snap = _mutateSnapshot(accountUuid, { usage, tokenState: TOKEN_STATE_OK, lastRefreshError: null });
      }
      return snap;
    }

    // ─── LINEAGE GATE (Mac-active account) ───
    // WHY: when this account is live on the Mac, the MAC's own Claude Code
    // owns the refresh-token lineage: it rotates the pair on its schedule,
    // and the OAuth server revokes the OLD refresh token the moment a new
    // one is issued. If the PC's background usage polling refreshed here,
    // the PC would steal that lineage and the Mac's stored pair would die
    // on its next rotation (~12h), silently logging the Mac out. So the
    // Mac-active account NEVER calls refreshInactiveToken from this
    // machine. Usage is fetched strictly read-only with the stored access
    // token; when that token is expired, the serialized wrapper has
    // already tried to adopt fresher tokens from the Mac itself
    // (readMacInventory + syncBackFromMac via _pullMacActiveStateIfNeeded).
    // Still-expired here means the Mac is offline or has not rotated yet:
    // skip the round entirely, with ZERO token-endpoint calls.
    if (getMacActiveHint() === snap.accountUuid) {
      const storedToken = (snap.credentials && snap.credentials.accessToken) ? snap.credentials.accessToken : null;
      if (!storedToken || _isAccessTokenExpired(snap.credentials, now)) {
        return snap; // read-only policy: never refresh, never mark dead
      }
      const usage = await fetchUsage(storedToken);
      if (usage) {
        snap = _mutateSnapshot(accountUuid, { usage, tokenState: TOKEN_STATE_OK, lastRefreshError: null });
      }
      return snap;
    }

    // Inactive account.
    let accessToken = snap.credentials ? snap.credentials.accessToken : null;
    if (_isAccessTokenExpired(snap.credentials, now)) {
      const storedRefresh = (snap.credentials && snap.credentials.refreshToken) ? String(snap.credentials.refreshToken) : '';
      if (!storedRefresh) {
        // Expired access token AND no refresh token: definitively dead,
        // no network call needed. Evidence preserved (never nulled).
        return _recordAuthRejection(accountUuid, {
          kind: 'no_refresh_token',
          status: null,
          detail: 'expired access token with no stored refresh token',
        });
      }
      if (snap.tokenState === TOKEN_STATE_NEEDS_LOGIN && !force && !_isDeadRetryDue(snap, now)) {
        // Known-dead refresh token with FRESH rejection evidence: skip the
        // pointless round trip. A force retry (the user's Retry button) or
        // evidence older than DEAD_RETRY_MIN goes through anyway; one extra
        // invalid_grant is harmless and self-heals WAF false positives.
        return snap;
      }
      const r = await refreshInactiveToken(storedRefresh);
      if (r.ok) {
        const prior = snap.credentials || {};
        const rotated = { ...prior, accessToken: r.tokens.accessToken, refreshToken: r.tokens.refreshToken, expiresAt: r.tokens.expiresAt };
        // PERSIST IMMEDIATELY, before any usage call.
        snap = _mutateSnapshot(accountUuid, { credentials: rotated, tokenState: TOKEN_STATE_OK, lastRefreshError: null });
        accessToken = r.tokens.accessToken;
      } else if (r.verdict === 'rejected') {
        // Definitive rejection: needs_login WITH the evidence preserved
        // (the old code nulled lastRefreshError here, a diagnosability bug).
        return _recordAuthRejection(accountUuid, r);
      } else if (r.verdict === 'suspect') {
        // Ambiguous auth answer: run the ladder; prior state kept until
        // SUSPECT_ESCALATE_COUNT consecutive suspects.
        return _recordSuspect(accountUuid, r).snap;
      } else {
        return _recordRefreshFailure(accountUuid, r);
      }
    }

    if (!accessToken) return snap;
    const usage = await fetchUsage(accessToken);
    if (usage) {
      // Usage success clears needs_login/unverified: fresh positive evidence.
      snap = _mutateSnapshot(accountUuid, { usage, tokenState: TOKEN_STATE_OK, lastRefreshError: null });
    }
    // Usage failure: keep the prior cache and the prior state. A usage 401
    // may just be an expired access token; it says NOTHING about the
    // refresh token.
    return snap;
  }

  /**
   * Unlocked core of syncActiveTokenToProfile (the rotation write-back loop,
   * design Decision 3). Matches the live pair to a snapshot by the active
   * accountUuid; writes rotated credentials back only when the live
   * expiresAt is strictly newer; auto-captures when no snapshot exists; and
   * ALWAYS resurrects the active account's tokenState to ok (a live login
   * is definitive proof the account works; mandatory per the corrected
   * state model).
   *
   * @returns {string|null} The synced accountUuid, or null when live state
   *   is unreadable (nothing written).
   */
  function _syncActiveTokenToProfileUnlocked() {
    if (isCredentialPoolReadOnly()) return null;
    try {
      const live = readActiveCredential();
      if (!live || !live.oauth) return null;
      const identity = readActiveIdentity();
      const uuid = identity && identity.accountUuid ? String(identity.accountUuid) : '';
      if (!validateAccountUuid(uuid)) return null;
      // ─── WRITE-BACK THEFT GUARD (expiry-fix spec Phase 4) ───
      // WHY: after a switch, a still-running CLI session from the PREVIOUS
      // account can refresh its own pair and write those rotated tokens
      // into the live .credentials.json. The identity file, however,
      // already names the NEW account, so adopting here would graft the
      // old account's tokens onto the new account's snapshot (an identity/
      // token mismatch that corrupts which snapshot owns which lineage and
      // accelerates lineage death). When the live access token is the
      // stored token of a DIFFERENT snapshot, the live pair provably
      // belongs to that other account: skip the whole adoption (merge AND
      // resurrection; the "live login" evidence is not about this account)
      // and leave both snapshots intact. Diagnostic carries uuid prefixes
      // only, NEVER token values.
      const liveToken = (live.oauth && typeof live.oauth.accessToken === 'string') ? live.oauth.accessToken : '';
      if (liveToken) {
        const owner = listSnapshots().find((s) => s.accountUuid !== uuid
          && s.credentials && s.credentials.accessToken === liveToken);
        if (owner) {
          log.warn('[Credentials] write-back guard: the live token belongs to a different saved account ('
            + owner.accountUuid.slice(0, 8) + ') than the active identity (' + uuid.slice(0, 8)
            + '); adoption skipped, both snapshots left intact');
          return null;
        }
      }
      const existing = readSnapshot(uuid);
      if (!existing) {
        const nowIso = new Date(clock()).toISOString();
        _writeSnapshot({
          accountUuid: uuid,
          email: identity.emailAddress || '',
          label: '',
          savedAt: nowIso,
          updatedAt: nowIso,
          credentials: live.oauth,
          identity,
          usage: null,
          tokenState: TOKEN_STATE_OK,
          lastRefreshError: null,
        });
        return uuid;
      }
      const liveExp = Number(live.oauth.expiresAt) || 0;
      const storedExp = existing.credentials ? Number(existing.credentials.expiresAt) || 0 : 0;
      const patch = {};
      if (liveExp > storedExp) {
        patch.credentials = live.oauth;
        patch.identity = identity;
      }
      if (existing.tokenState !== TOKEN_STATE_OK) {
        // Watcher recapture of a live login always resurrects the account.
        patch.tokenState = TOKEN_STATE_OK;
        patch.lastRefreshError = null;
      }
      if (Object.keys(patch).length > 0) _mutateSnapshot(uuid, patch);
      return uuid;
    } catch (err) {
      log.warn('[Credentials] sync-back skipped: ' + ((err && err.message) || err));
      return null;
    }
  }

  /**
   * Unlocked core of syncBackFromMac: merge the Mac's LIVE token file text
   * into the matching local snapshot. The merge rule is identical to the PC
   * rotation write-back (_syncActiveTokenToProfileUnlocked): credentials
   * are adopted ONLY when the incoming expiresAt is STRICTLY newer than the
   * stored one, so a stale Mac copy can never regress a fresher local
   * snapshot. A live Mac login is definitive positive evidence, so the
   * snapshot's tokenState is resurrected to ok either way.
   *
   * SECURITY: liveCredText is secret material. It is parsed here and
   * written only into the 0600 snapshot file; it must never be logged,
   * returned to a route, or stored anywhere else.
   *
   * @param {string} accountUuid - The local snapshot to merge into.
   * @param {string} liveCredText - Raw Mac ~/.claude/.credentials.json text.
   * @returns {{synced: boolean, resurrected: boolean, reason?: string}}
   */
  function _syncBackFromMacUnlocked(accountUuid, liveCredText) {
    const out = { synced: false, resurrected: false };
    if (isCredentialPoolReadOnly()) {
      return { ...out, reason: 'credential pool is externally owned and read-only' };
    }
    if (!validateAccountUuid(accountUuid)) {
      return { ...out, reason: 'invalid accountUuid' };
    }
    let oauth = null;
    try {
      const parsed = JSON.parse(String(liveCredText || ''));
      oauth = parsed && parsed.claudeAiOauth;
    } catch (_) {
      oauth = null;
    }
    if (!oauth || typeof oauth !== 'object' || !oauth.accessToken) {
      return { ...out, reason: 'unparseable live credential text' };
    }
    const existing = readSnapshot(accountUuid);
    if (!existing) {
      // Never fabricate a snapshot from Mac-side data alone: the identity
      // half of the pair is not trustworthy from the Mac (it lags by
      // design), so an unknown account is left for a proper PC capture.
      return { ...out, reason: 'no local snapshot for that account' };
    }
    const incomingExp = Number(oauth.expiresAt) || 0;
    const storedExp = existing.credentials ? Number(existing.credentials.expiresAt) || 0 : 0;
    const patch = {};
    if (incomingExp > storedExp) {
      // Merge over the stored credentials so lean Mac copies cannot drop
      // metadata fields (subscriptionType etc.); incoming fields win.
      patch.credentials = { ...(existing.credentials || {}), ...oauth };
      out.synced = true;
    }
    if (existing.tokenState !== TOKEN_STATE_OK) {
      patch.tokenState = TOKEN_STATE_OK;
      patch.lastRefreshError = null;
      out.resurrected = true;
    }
    if (Object.keys(patch).length > 0) _mutateSnapshot(accountUuid, patch);
    return out;
  }

  /**
   * Read the cached result of the last Mac inventory sweep, or null when no
   * sweep has completed since boot. Serving this cache is always instant
   * and never triggers SSH; POST /api/credentials/mac-state/refresh is the
   * only path that talks to the Mac.
   *
   * @returns {object|null} The cached state (whitelisted fields only).
   */
  function getMacState() {
    return _macState;
  }

  /**
   * Store the Mac inventory sweep result. The fields are WHITELISTED here
   * (defense in depth): even if a future caller passed a raw inventory
   * object, liveCredText or any other secret-bearing field could never ride
   * into the cache that routes serialize.
   *
   * @param {object|null} state - Sweep result, or null to clear.
   * @returns {object|null} The stored (sanitized) state.
   */
  function setMacState(state) {
    if (!state || typeof state !== 'object') {
      _macState = null;
      return null;
    }
    _macState = {
      checkedAt: typeof state.checkedAt === 'string' ? state.checkedAt : new Date(clock()).toISOString(),
      reachable: !!state.reachable,
      activeName: typeof state.activeName === 'string' ? state.activeName : null,
      activeProfileId: (typeof state.activeProfileId === 'string' && validateAccountUuid(state.activeProfileId))
        ? state.activeProfileId : null,
      profiles: Array.isArray(state.profiles)
        ? state.profiles
          .filter((p) => p && typeof p === 'object' && typeof p.name === 'string')
          .map((p) => ({
            name: p.name,
            profileId: (typeof p.profileId === 'string' && validateAccountUuid(p.profileId)) ? p.profileId : null,
          }))
        : [],
      ...(state.error ? { error: String(state.error) } : {}),
    };
    return _macState;
  }

  /**
   * Read the Mac-active lineage hint: the accountUuid believed to be LIVE
   * on the Mac right now, or null when none is known. Session memory wins;
   * otherwise the persisted settings value is used (so the lineage gate
   * survives server restarts). Invalid stored values read as null.
   *
   * @returns {string|null} The Mac-active accountUuid, or null.
   */
  function getMacActiveHint() {
    if (_macActiveHint !== undefined) return _macActiveHint;
    const v = getSettings().macActiveProfileId;
    _macActiveHint = (typeof v === 'string' && validateAccountUuid(v)) ? v : null;
    return _macActiveHint;
  }

  /**
   * Record which account is live on the Mac (null clears it). Set by a
   * successful applyProfileOnMac and corrected by every inventory sweep
   * (observed reality wins). Persisted via settingsPatcher when the server
   * wired one; persistence failure degrades to session-only memory, which
   * is still enough for the lineage gate until the next restart.
   *
   * WHY this exists: the account live on the Mac has its refresh-token
   * lineage OWNED by the Mac's own Claude Code. The PC must never rotate
   * that pair (the OAuth server kills the old refresh token the moment a
   * new one is issued, which would silently log the Mac out within ~12h).
   *
   * @param {string|null} uuid - Mac-active accountUuid, or null for none.
   * @returns {string|null} The normalized stored value.
   */
  function setMacActiveHint(uuid) {
    const v = (typeof uuid === 'string' && validateAccountUuid(uuid)) ? uuid : null;
    _macActiveHint = v;
    if (settingsPatcher) {
      try {
        settingsPatcher({ macActiveProfileId: v });
      } catch (err) {
        log.warn('[Credentials] persisting the Mac-active hint failed (kept in memory): ' + ((err && err.message) || err));
      }
    }
    return v;
  }

  /**
   * Register the "pull fresh Mac state" callback (one inventory sweep plus
   * sync-back). The routes layer owns it because the manager cannot
   * require the bridge (circular require). Pass null to unregister.
   *
   * @param {Function|null} fn - Async refresher, or null.
   * @returns {void}
   */
  function setMacStateRefresher(fn) {
    _macStateRefresher = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Pre-step for updateSnapshotUsage, run OUTSIDE both mutexes: when the
   * requested account is the Mac-active one and its stored access token
   * has expired, pull fresh Mac state first (the Mac may have rotated the
   * pair; adopting it gives the usage fetch a working token WITHOUT ever
   * touching the token endpoint).
   *
   * WHY outside the mutexes: the refresher takes the Mac mutex and then
   * (inside syncBackFromMac) the snapshot mutex. Awaiting it while already
   * holding the snapshot mutex would deadlock the manager, so this runs
   * before serialize() enqueues the locked usage update. Best effort: any
   * failure leaves the lineage gate to skip the round instead.
   *
   * @param {string} accountUuid - The profileId about to be usage-polled.
   * @returns {Promise<void>} Never rejects.
   */
  async function _pullMacActiveStateIfNeeded(accountUuid) {
    try {
      if (!validateAccountUuid(accountUuid)) return;
      if (getMacActiveHint() !== accountUuid) return;
      const snap = readSnapshot(accountUuid);
      if (!snap || !snap.credentials) return;
      if (!_isAccessTokenExpired(snap.credentials, clock())) return;
      if (!_macStateRefresher) return;
      await _macStateRefresher();
    } catch (err) {
      log.warn('[Credentials] Mac pre-pull skipped: ' + ((err && err.message) || err));
    }
  }

  /**
   * Unlocked core of captureCurrent: explicit snapshot of the live PC pair
   * (first run, post /login). Captured state is definitionally alive, so
   * tokenState is set to ok.
   *
   * @param {{label?: string}} [captureOpts] - Optional friendly label.
   * @returns {object} The persisted snapshot.
   */
  function _captureCurrentUnlocked(captureOpts = {}) {
    assertCredentialPoolWritable('Credential capture');
    const live = readActiveCredential();
    const identity = readActiveIdentity();
    if (!live || !live.oauth || !identity || !identity.accountUuid) {
      throw credError(500, 'CRED_LIVE_STATE_UNREADABLE',
        'The live credential pair is unreadable (token file or identity missing). Run /login in a terminal first.');
    }
    const uuid = String(identity.accountUuid);
    if (!validateAccountUuid(uuid)) {
      throw credError(500, 'CRED_LIVE_STATE_UNREADABLE', 'live oauthAccount.accountUuid is not a valid account uuid');
    }
    let label = '';
    if (captureOpts.label != null) {
      if (typeof captureOpts.label !== 'string') throw credError(400, 'VALIDATION', 'label must be a string');
      label = captureOpts.label.trim();
      if (label.length > LABEL_MAX_LENGTH) {
        throw credError(400, 'VALIDATION', 'label must be ' + LABEL_MAX_LENGTH + ' characters or fewer');
      }
    }
    const existing = readSnapshot(uuid);
    const nowIso = new Date(clock()).toISOString();
    return _writeSnapshot({
      accountUuid: uuid,
      email: identity.emailAddress || '',
      label: label || (existing && existing.label) || '',
      savedAt: (existing && existing.savedAt) || nowIso,
      updatedAt: nowIso,
      credentials: live.oauth,
      identity,
      usage: (existing && existing.usage) || null,
      tokenState: TOKEN_STATE_OK,
      lastRefreshError: null,
    });
  }

  /**
   * Unlocked core of seedFromClaudeSwap: one-time READ-ONLY conversion of
   * claude-swap's profiles/pc/*.json into our schema. Idempotence comes from
   * an explicit sentinel file (<accountsDir>/.seeded) written after the
   * first import attempt, NEVER from snapshot count: the boot watcher's
   * initial sync self-captures the active account before any seed can run,
   * so a count-based guard is dead on arrival on every machine with a live
   * login, and it would also re-import deleted accounts once the store
   * emptied. The sentinel is written even when zero profiles import
   * (including when the seed dir does not exist) so a machine without
   * claude-swap never re-scans on every boot. The old tool's tokenDead
   * flags are IGNORED entirely (they come from its buggy refresh
   * classification and are provably wrong); every import lands as
   * 'unverified' and the first refresh, usage success, apply verification,
   * or watcher recapture converts it to ok or needs_login with fresh
   * evidence.
   *
   * @param {string} [dir] - Seed root; defaults to resolveSeedDir().
   * @returns {{imported: number, skipped: number}}
   */
  function _seedFromClaudeSwapUnlocked(dir) {
    if (isCredentialPoolReadOnly()) {
      return { imported: 0, skipped: 0, readOnly: true };
    }
    const source = dir || resolveSeedDir();
    const result = { imported: 0, skipped: 0 };
    const sentinelPath = path.join(accountsDir, SEED_SENTINEL_FILE);
    if (fs.existsSync(sentinelPath)) return result; // one-time import already ran
    const pcDir = path.join(source, 'profiles', 'pc');
    let files = [];
    try {
      files = fs.readdirSync(pcDir).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch (_) {
      files = []; // no seed dir: nothing to import, but the attempt still counts
    }
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(pcDir, f), 'utf-8'));
        const credParsed = JSON.parse(String(raw.credentialsFileText || ''));
        const oauth = credParsed && credParsed.claudeAiOauth;
        const identity = JSON.parse(String(raw.oauthAccountJson || ''));
        const uuid = identity && identity.accountUuid;
        if (!oauth || typeof oauth !== 'object' || !validateAccountUuid(uuid)) {
          result.skipped += 1;
          continue;
        }
        if (readSnapshot(uuid)) { result.skipped += 1; continue; } // duplicate uuid
        const nowIso = new Date(clock()).toISOString();
        _writeSnapshot({
          accountUuid: uuid,
          email: identity.emailAddress || raw.email || '',
          label: raw.label ? String(raw.label) : '',
          savedAt: nowIso,
          updatedAt: nowIso,
          credentials: oauth,
          identity,
          usage: null,
          tokenState: TOKEN_STATE_UNVERIFIED,
          lastRefreshError: null,
        });
        result.imported += 1;
      } catch (_) {
        result.skipped += 1;
      }
    }
    if (result.imported > 0) {
      log.log('[Credentials] seeded ' + result.imported + ' snapshot(s) from claude-swap (all unverified; old dead flags ignored)');
    }
    // Mark the one-time import as done regardless of outcome (zero imports
    // included) so it never re-runs and never resurrects deleted accounts.
    // A failed sentinel write only degrades to a harmless re-scan next boot
    // (duplicate uuids are skipped), so it warns instead of throwing.
    try {
      writeFileAtomic(sentinelPath, JSON.stringify({
        seededAt: new Date(clock()).toISOString(),
        source,
        imported: result.imported,
        skipped: result.skipped,
      }, null, 2));
    } catch (err) {
      log.warn('[Credentials] seed sentinel write failed (seed may re-scan next boot): ' + ((err && err.message) || err));
    }
    return result;
  }

  /**
   * Unlocked core of setLabel: trim, cap at 60 chars (VALIDATION beyond),
   * empty clears (display falls back per the chain). Updates only the label.
   *
   * @param {string} accountUuid
   * @param {string} label
   * @returns {object} The updated snapshot.
   */
  function _setLabelUnlocked(accountUuid, label) {
    assertCredentialPoolWritable('Credential snapshot label update');
    if (!validateAccountUuid(accountUuid)) {
      throw credError(400, 'VALIDATION', 'profileId must be a valid account uuid');
    }
    if (label == null) label = '';
    if (typeof label !== 'string') throw credError(400, 'VALIDATION', 'label must be a string');
    const trimmed = label.trim();
    if (trimmed.length > LABEL_MAX_LENGTH) {
      throw credError(400, 'VALIDATION', 'label must be ' + LABEL_MAX_LENGTH + ' characters or fewer');
    }
    return _mutateSnapshot(accountUuid, { label: trimmed });
  }

  /**
   * Timestamped backup of one live file into the backups dir, pruning the
   * oldest beyond backupKeep per basename. The just-created backup is never
   * a prune candidate (NTFS tunneling lesson from the reference tool).
   * A missing or uncopyable source degrades to null (nothing to back up).
   *
   * @param {string} livePath - File to back up.
   * @returns {string|null} The backup path, or null.
   */
  function backupLiveFile(livePath) {
    assertCredentialPoolWritable('Credential backup write');
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
      log.warn('[Credentials] backup of ' + livePath + ' failed: ' + ((err && err.message) || err));
      return null;
    }
  }

  /**
   * Unlocked core of applyCredential: the PC swap transaction, step order
   * load-bearing (ported from Invoke-PcSwap), with the corrected apply
   * rules: an expired access token ALONE never blocks apply; a definitive
   * needs_login state is the ONLY blocker. When the target is expired and
   * ok/unverified, an inline verification refresh runs first (safe: the
   * account is inactive here); transient verification failures apply anyway
   * with a warning instead of blocking.
   *
   * @param {string} accountUuid - The target profileId.
   * @returns {Promise<{applied: boolean, alreadyActive: boolean, email: string, warning?: string}>}
   */
  async function _applyCredentialUnlocked(accountUuid) {
    assertCredentialPoolWritable('Credential apply');
    // Step 0: validate and load.
    if (!validateAccountUuid(accountUuid)) {
      throw credError(400, 'VALIDATION', 'profileId must be a valid account uuid');
    }
    let snap = readSnapshot(accountUuid);
    if (!snap) {
      throw credError(404, 'CRED_NOT_FOUND', 'No stored credential snapshot for that profile. /login as that account once; it recaptures automatically.');
    }
    if (!snap.credentials || !snap.credentials.accessToken || !snap.identity) {
      throw credError(422, 'CRED_INCOMPLETE', 'The stored snapshot for ' + (snap.email || accountUuid) + ' is missing one half of the credential pair. /login as that account once; it recaptures automatically.');
    }
    const activeUuid = getActiveAccountUuid();
    if (activeUuid && activeUuid === accountUuid) {
      return { applied: false, alreadyActive: true, email: snap.email || '' };
    }
    if (snap.tokenState === TOKEN_STATE_NEEDS_LOGIN) {
      throw credError(409, 'CRED_TOKEN_DEAD', 'The stored token for ' + (snap.email || accountUuid) + ' needs a fresh login. /login as that account once; it recaptures automatically.');
    }

    // Step 0.5: inline verification. Expired access token alone NEVER
    // blocks; verify the refresh token instead (safe: inactive here).
    let warning = null;
    const now = clock();
    if (_isAccessTokenExpired(snap.credentials, now)) {
      const storedRefresh = snap.credentials.refreshToken ? String(snap.credentials.refreshToken) : '';
      if (!storedRefresh) {
        // Evidence preserved (never nulled): the apply-path twin of the
        // usage path's no-refresh-token rejection.
        _recordAuthRejection(accountUuid, {
          kind: 'no_refresh_token',
          status: null,
          detail: 'expired access token with no stored refresh token',
        });
        throw credError(409, 'CRED_TOKEN_DEAD', 'The stored token for ' + (snap.email || accountUuid) + ' is expired and has no refresh token. /login as that account once; it recaptures automatically.');
      }
      const r = await refreshInactiveToken(storedRefresh);
      if (r.ok) {
        const rotated = { ...snap.credentials, accessToken: r.tokens.accessToken, refreshToken: r.tokens.refreshToken, expiresAt: r.tokens.expiresAt };
        // Persist the rotated pair BEFORE applying (the old refresh token
        // dies server-side the instant the new one is issued).
        snap = _mutateSnapshot(accountUuid, { credentials: rotated, tokenState: TOKEN_STATE_OK, lastRefreshError: null });
      } else if (r.verdict === 'rejected') {
        // Definitive rejection blocks the apply, WITH evidence preserved.
        _recordAuthRejection(accountUuid, r);
        throw credError(409, 'CRED_TOKEN_DEAD', 'The stored token for ' + (snap.email || accountUuid) + ' was rejected by the auth server. /login as that account once; it recaptures automatically.');
      } else if (r.verdict === 'suspect') {
        // Ambiguous auth answer: run the ladder. Only an escalation (the
        // SUSPECT_ESCALATE_COUNT-th consecutive suspect) blocks the apply;
        // below that the swap proceeds with a warning, because a single
        // Cloudflare 403 must not block switching to a working account.
        const rung = _recordSuspect(accountUuid, r);
        if (rung.escalated) {
          throw credError(409, 'CRED_TOKEN_DEAD', 'The stored token for ' + (snap.email || accountUuid) + ' was rejected repeatedly by the auth server. /login as that account once; it recaptures automatically.');
        }
        warning = 'The auth server answered suspiciously (HTTP ' + (r.status != null ? r.status : 'unknown') + '); applied anyway. If the CLI demands login, run /login once.';
        snap = rung.snap;
      } else {
        // Transient (network/timeout/5xx/429) or protocol failure: apply
        // anyway; never block on transience.
        warning = 'Could not verify the stored token over the network; applied anyway. If the CLI demands login, run /login once.';
        snap = _recordRefreshFailure(accountUuid, r);
      }
    }

    // Step a: arm the self-write guard so the watcher ignores our writes.
    _selfWriteUntil = clock() + SELF_WRITE_GUARD_MS;
    // Step 1: capture the CURRENT account's freshest rotated tokens before
    // anything is replaced (no-op on unreadable live state).
    _syncActiveTokenToProfileUnlocked();
    // Step 2: backups. The .claude.json backup doubles as the rollback source.
    const credBackup = backupLiveFile(credFilePath);
    const jsonBackup = backupLiveFile(claudeJsonPath);
    // Step 3: IDENTITY FIRST. Surgical oauthAccount replacement.
    let claudeJsonObj = {};
    try {
      const text = fs.readFileSync(claudeJsonPath, 'utf-8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) claudeJsonObj = parsed;
    } catch (_) {
      claudeJsonObj = {}; // missing identity file: create a minimal one
    }
    claudeJsonObj.oauthAccount = snap.identity;
    try {
      writeFileAtomic(claudeJsonPath, JSON.stringify(claudeJsonObj, null, 2));
    } catch (err) {
      // Atomic write means the identity file is untouched on failure.
      throw credError(500, 'CRED_APPLY_FAILED', 'Identity write failed; live files are unchanged. ' + ((err && err.message) || err));
    }
    // Step 4: TOKENS LAST. On failure restore the identity file atomically
    // (a live Claude process may be mid-read; same torn-write-proof path).
    try {
      writeFileAtomic(credFilePath, serializeCredentialsFile(snap.credentials));
    } catch (credWriteErr) {
      const detail = (credWriteErr && credWriteErr.message) || String(credWriteErr);
      if (jsonBackup) {
        try {
          writeFileAtomic(claudeJsonPath, fs.readFileSync(jsonBackup, 'utf-8'));
        } catch (rollbackErr) {
          throw credError(500, 'CRED_ROLLBACK_FAILED',
            'Credentials write failed AND the identity rollback also failed (' + ((rollbackErr && rollbackErr.message) || rollbackErr) +
            '). Recover manually from the backups in ' + backupsDir + '. Swap aborted: ' + detail);
        }
        throw credError(500, 'CRED_APPLY_FAILED', 'Credentials write failed; the identity file was restored from its backup. Swap aborted: ' + detail);
      }
      throw credError(500, 'CRED_APPLY_FAILED', 'Credentials write failed; no identity backup existed, so nothing was restored. Swap aborted: ' + detail);
    }
    // Step 5: VERIFY the live identity now reports the target account.
    const verifyUuid = getActiveAccountUuid();
    if (verifyUuid !== accountUuid) {
      // Restore BOTH halves (deliberately stronger than the reference tool's
      // identity-only rollback: restoring only the identity would recreate
      // the exact identity/token mismatch this transaction exists to avoid).
      try {
        if (jsonBackup) writeFileAtomic(claudeJsonPath, fs.readFileSync(jsonBackup, 'utf-8'));
        if (credBackup) writeFileAtomic(credFilePath, fs.readFileSync(credBackup, 'utf-8'));
      } catch (_) { /* verify rollback is best effort; backups remain on disk */ }
      throw credError(500, 'CRED_VERIFY_FAILED',
        'Post-apply verification failed: the live identity does not report the target account. Backups are in ' + backupsDir + '.');
    }
    // Step 6: reconcile the snapshot with what is now live, then report.
    _syncActiveTokenToProfileUnlocked();
    const result = { applied: true, alreadyActive: false, email: snap.email || '' };
    if (warning) result.warning = warning;
    return result;
  }

  /**
   * Unlocked core of deleteSnapshot: removes the snapshot file only (never
   * live files, never remote files).
   *
   * @param {string} accountUuid
   * @returns {{deleted: boolean}}
   */
  function _deleteSnapshotUnlocked(accountUuid) {
    assertCredentialPoolWritable('Credential snapshot delete');
    if (!validateAccountUuid(accountUuid)) {
      throw credError(400, 'VALIDATION', 'profileId must be a valid account uuid');
    }
    const p = path.join(accountsDir, accountUuid + '.json');
    if (!fs.existsSync(p)) {
      throw credError(404, 'CRED_NOT_FOUND', 'No stored credential snapshot for profile ' + accountUuid + '.');
    }
    fs.unlinkSync(p);
    return { deleted: true };
  }

  /**
   * Unlocked core of one proactive-refresh candidate (expiry-fix spec
   * Phase 3). Re-reads the snapshot and re-checks EVERY gate under the
   * mutex, because the world may have changed between the sweep's roster
   * listing and this account's turn (an apply can make it PC-active, a Mac
   * sweep can flag it Mac-active). Gates, all of which must pass:
   *
   *   1. never the PC-active account (refreshing it races the CLI's own
   *      rotation and can brick the live login),
   *   2. never the Mac-active account (the Mac owns that lineage; see the
   *      lineage gate in _updateSnapshotUsageUnlocked),
   *   3. tokenState ok only (dead rows ride the dead-retry window on the
   *      usage path; unverified rows wait for positive evidence first),
   *   4. no recent auth_suspect backoff (a suspect ladder in progress means
   *      the endpoint is answering strangely; do not hammer it. Suspect
   *      evidence older than DEAD_RETRY_MIN no longer blocks, so a stale
   *      ladder cannot park an account out of the sweep forever),
   *   5. expiresAt within PROACTIVE_REFRESH_WINDOW_MIN of lapsing
   *      (just-in-time rotation, not constant churn; missing expiresAt
   *      reads as already lapsed, same as _isAccessTokenExpired).
   *
   * On refresh success the rotated pair is PERSISTED FIRST (the old
   * refresh token dies server-side the instant the new one is issued);
   * only then is the fresh access token used for a best-effort usage
   * fetch. Failures classify exactly like the usage path (rejected /
   * suspect ladder / transient), so the sweep tells the same honest story.
   *
   * @param {string} accountUuid - Candidate snapshot id.
   * @returns {Promise<string>} Outcome tag: 'refreshed', 'skipped',
   *   'rejected', 'suspect', or 'transient'.
   */
  async function _proactiveRefreshOneUnlocked(accountUuid) {
    const snap = readSnapshot(accountUuid);
    if (!snap || !snap.credentials) return 'skipped';
    const now = clock();
    const activeUuid = getActiveAccountUuid();
    if (activeUuid && activeUuid === snap.accountUuid) return 'skipped'; // gate 1
    if (getMacActiveHint() === snap.accountUuid) return 'skipped'; // gate 2
    if (snap.tokenState !== TOKEN_STATE_OK) return 'skipped'; // gate 3
    if (snap.lastRefreshError && snap.lastRefreshError.kind === 'auth_suspect') { // gate 4
      const at = snap.lastRefreshError.at ? Date.parse(snap.lastRefreshError.at) : NaN;
      if (!Number.isFinite(at) || (now - at) < DEAD_RETRY_MIN) return 'skipped';
    }
    const expMs = Number(snap.credentials.expiresAt) || 0;
    if ((expMs - now) > PROACTIVE_REFRESH_WINDOW_MIN * 60000) return 'skipped'; // gate 5
    const storedRefresh = snap.credentials.refreshToken ? String(snap.credentials.refreshToken) : '';
    if (!storedRefresh) return 'skipped'; // the usage path owns that death verdict
    const r = await refreshInactiveToken(storedRefresh);
    if (r.ok) {
      const rotated = { ...snap.credentials, accessToken: r.tokens.accessToken, refreshToken: r.tokens.refreshToken, expiresAt: r.tokens.expiresAt };
      // ROTATE-THEN-PERSIST: on disk before ANY use of the new pair.
      _mutateSnapshot(accountUuid, { credentials: rotated, tokenState: TOKEN_STATE_OK, lastRefreshError: null });
      // Freebie: the fresh token also refreshes the usage cache. Best
      // effort; a usage failure keeps the rotated pair and the prior cache.
      const usage = await fetchUsage(r.tokens.accessToken);
      if (usage) _mutateSnapshot(accountUuid, { usage });
      return 'refreshed';
    }
    if (r.verdict === 'rejected') { _recordAuthRejection(accountUuid, r); return 'rejected'; }
    if (r.verdict === 'suspect') { _recordSuspect(accountUuid, r); return 'suspect'; }
    _recordRefreshFailure(accountUuid, r);
    return 'transient';
  }

  /**
   * Proactive background refresh sweep over the whole roster (expiry-fix
   * spec Phase 3; called by the server's guarded interval). Serializes PER
   * ACCOUNT rather than around the whole sweep so an apply or usage call
   * can interleave between candidates instead of waiting out N network
   * round trips. Never rejects: per-account errors are logged and counted,
   * and one bad snapshot cannot stop the rest of the sweep.
   *
   * @returns {Promise<{scanned: number, refreshed: number, skipped: number,
   *   rejected: number, suspect: number, transient: number, errors: number}>}
   *   Outcome counters (for logs and tests).
   */
  async function proactiveRefreshSweep() {
    const out = { scanned: 0, refreshed: 0, skipped: 0, rejected: 0, suspect: 0, transient: 0, errors: 0 };
    // MERGE NOTE (passive mode x proactive sweep): the sweep postdates the
    // passive-mode branch, so it gets the same gate its sibling mutation
    // paths carry. Without this, every timer tick would queue one serialize
    // op per snapshot only for refreshInactiveToken's ownership assert to
    // throw a 409 into the error counters and warn-log once per account.
    // Passive mode is a deliberate state, not an error; skip the sweep
    // entirely (zero mutex entries, zero network), flagged like the seed
    // path's readOnly result so callers and tests can tell skip from idle.
    if (isCredentialPoolReadOnly()) return { ...out, readOnly: true };
    let snaps = [];
    try { snaps = listSnapshots(); } catch (_) { snaps = []; }
    for (const s of snaps) {
      out.scanned += 1;
      try {
        const outcome = await serialize(() => _proactiveRefreshOneUnlocked(s.accountUuid), 'proactive-refresh');
        out[outcome] = (out[outcome] || 0) + 1;
      } catch (err) {
        out.errors += 1;
        log.warn('[Credentials] proactive refresh of ' + s.accountUuid + ' failed: ' + ((err && err.message) || err));
      }
    }
    if (out.refreshed > 0 || out.rejected > 0 || out.suspect > 0) {
      log.log('[Credentials] proactive refresh sweep: ' + out.refreshed + ' refreshed, '
        + out.rejected + ' rejected, ' + out.suspect + ' suspect, '
        + out.skipped + ' skipped of ' + out.scanned);
    }
    return out;
  }

  /**
   * Fire one serialized sync-back, swallowing every error (the watcher can
   * never crash the server).
   *
   * @returns {void}
   */
  function _fireSync() {
    if (isCredentialPoolReadOnly()) return;
    if (clock() < _selfWriteUntil) return; // our own apply is writing
    serialize(() => _syncActiveTokenToProfileUnlocked(), 'watcher-sync').catch((err) => {
      log.warn('[Credentials] watcher sync failed: ' + ((err && err.message) || err));
    });
  }

  /**
   * Start the rotation write-back loop (design Decision 3): a dir-scoped
   * fs.watch on the claude dir filtered to .credentials.json (watching the
   * file itself drops on Windows when it is replaced by rename), debounced,
   * plus a low-frequency mtime poll fallback because Windows watchers can
   * silently die. Idempotent. Also fires one initial sync so the active
   * account self-registers at boot.
   *
   * @returns {void}
   */
  function startCredentialWatcher() {
    _startChainWatchdog(); // idempotent; re-arms after a stopCredentialWatcher
    // MERGE NOTE (deadlock hardening x passive mode): the watchdog arms
    // BEFORE the passive-mode return on purpose. Passive reads still ride
    // the serialize() chain (cached usage projections), so they deserve the
    // same stall insurance, and a stop/start cycle must re-arm it in every
    // mode. Passive mode only skips the rotation write-back machinery below
    // (fs.watch + poll + initial sync), because the external bridge owns
    // every write to the pool and the live credential file.
    if (isCredentialPoolReadOnly()) return;
    if (_watcher || _pollTimer) return; // already running
    try {
      _watcher = fs.watch(claudeDir, (event, filename) => {
        try {
          if (filename && String(filename).toLowerCase() !== CREDENTIALS_FILE_NAME) return;
          if (_debounceTimer) clearTimeout(_debounceTimer);
          _debounceTimer = setTimeout(_fireSync, watchDebounceMs);
          if (_debounceTimer.unref) _debounceTimer.unref();
        } catch (_) { /* watcher callback must never throw */ }
      });
      _watcher.on('error', (err) => {
        log.warn('[Credentials] watcher error, degrading to poll-only: ' + ((err && err.message) || err));
        try { _watcher.close(); } catch (_) { /* best effort */ }
        _watcher = null;
      });
    } catch (err) {
      log.warn('[Credentials] fs.watch unavailable (' + ((err && err.message) || err) + '); poll fallback only');
      _watcher = null;
    }
    _pollTimer = setInterval(() => {
      try {
        const st = fs.statSync(credFilePath);
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
  function stopCredentialWatcher() {
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_watcher) { try { _watcher.close(); } catch (_) { /* best effort */ } _watcher = null; }
    _lastPollMtime = null;
    _stopChainWatchdog(); // never leak the stall watchdog past shutdown/tests
  }

  /**
   * Browser-safe projection of the roster. THE ONLY SHAPE ROUTES MAY
   * SERIALIZE. Never contains accessToken, refreshToken, raw credentials,
   * or the raw identity blob; only whitelisted org/display fields.
   *
   * @returns {{activeProfileId: string|null, profiles: object[]}}
   */
  function getSafeList() {
    const activeProfileId = getActiveAccountUuid();
    const profiles = listSnapshots().map((snap) => {
      const tokenState = snap.tokenState || TOKEN_STATE_UNVERIFIED;
      return {
        profileId: snap.accountUuid,
        email: snap.email || '',
        label: snap.label || '',
        displayName: displayNameFor(snap),
        isActive: !!activeProfileId && snap.accountUuid === activeProfileId,
        tokenState,
        tokenDead: tokenState === TOKEN_STATE_NEEDS_LOGIN,
        // Health carries the suspect-ladder nuance: ok + auth_suspect
        // renders amber (needs-attention), not healthy and not red.
        health: healthFor(tokenState, snap.lastRefreshError),
        savedAt: snap.savedAt || null,
        updatedAt: snap.updatedAt || null,
        subscriptionType: (snap.credentials && snap.credentials.subscriptionType) || null,
        rateLimitTier: (snap.credentials && snap.credentials.rateLimitTier) || null,
        organizationType: (snap.identity && snap.identity.organizationType) || null,
        organizationName: (snap.identity && snap.identity.organizationName) || '',
        usage: snap.usage || null,
        lastRefreshError: snap.lastRefreshError ? {
          at: snap.lastRefreshError.at || null,
          kind: snap.lastRefreshError.kind || null,
          status: snap.lastRefreshError.status != null ? snap.lastRefreshError.status : null,
        } : null,
      };
    });
    profiles.sort((a, b) => (Number(b.isActive) - Number(a.isActive)) ||
      String(a.displayName).localeCompare(String(b.displayName)));
    return { activeProfileId: activeProfileId || null, profiles };
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

  // The stalled-chain watchdog is ON from construction (cheap insurance;
  // unref'd, so it can never hold the process or a test run open). It is
  // cleared by stopCredentialWatcher and re-armed by startCredentialWatcher.
  _startChainWatchdog();

  return {
    // Paths and config (read-only introspection for routes and tests)
    claudeDir,
    claudeJsonPath,
    accountsDir,
    backupsDir,
    getSettings,
    resolveSeedDir,
    isCredentialPoolReadOnly,
    getCredentialPoolState,
    readCredentialPoolOwnerMarker,
    assertCredentialPoolWritable,
    // Pure helpers re-exposed on the instance for convenience
    validateAccountUuid,
    displayNameFor,
    serializeCredentialsFile,
    // Live-state readers
    readActiveCredential,
    readActiveIdentity,
    getActiveAccountUuid,
    getActiveEmail,
    // Snapshot store
    snapshotPath,
    readSnapshot,
    saveSnapshot,
    listSnapshots,
    deleteSnapshot: (uuid) => serialize(() => _deleteSnapshotUnlocked(uuid), 'delete-snapshot'),
    // Watcher (rotation write-back loop)
    startCredentialWatcher,
    stopCredentialWatcher,
    syncActiveTokenToProfile: () => serialize(() => _syncActiveTokenToProfileUnlocked(), 'sync-active'),
    // Mac bridge support: sync-back merge (short, snapshot-mutex guarded),
    // the SSH-op mutex, the sweep cache (never secret-bearing), the
    // Mac-active lineage hint, and the routes-registered state refresher.
    syncBackFromMac: (uuid, credText) => serialize(() => _syncBackFromMacUnlocked(uuid, credText), 'mac-sync-back'),
    runMacExclusive,
    getMacState,
    setMacState,
    getMacActiveHint,
    setMacActiveHint,
    setMacStateRefresher,
    // Capture / seed / labels
    captureCurrent: (o) => serialize(() => _captureCurrentUnlocked(o), 'capture'),
    seedFromClaudeSwap: (dir) => serialize(() => _seedFromClaudeSwapUnlocked(dir), 'seed'),
    setLabel: (uuid, label) => serialize(() => _setLabelUnlocked(uuid, label), 'set-label'),
    // Network
    fetchUsage,
    refreshInactiveToken,
    // Usage update. The Mac pre-pull runs BEFORE the snapshot mutex is
    // taken (see _pullMacActiveStateIfNeeded: awaiting the refresher while
    // holding the snapshot mutex would deadlock, because the refresher's
    // sync-back needs that same mutex).
    updateSnapshotUsage: async (uuid, o) => {
      if (isCredentialPoolReadOnly()) {
        // Passive mode: skip the Mac pre-pull (an SSH round trip that only
        // exists to feed a sync-back write) and serve the cached projection
        // through the mutex. Labeled per the hardening rule that every
        // export site names its op for CRED_OP_TIMEOUT and watchdog logs.
        return serialize(() => _updateSnapshotUsageUnlocked(uuid, o), 'usage-update');
      }
      await _pullMacActiveStateIfNeeded(uuid);
      return serialize(() => _updateSnapshotUsageUnlocked(uuid, o), 'usage-update');
    },
    // Proactive background refresh (expiry-fix spec Phase 3). Serializes
    // internally per account; safe to call from a timer. Each per-account
    // serialize inherits the op deadline, so one wedged account rejects
    // (counted as an error) instead of freezing the sweep and the chain.
    proactiveRefreshSweep,
    // Apply transaction
    backupLiveFile,
    applyCredential: (uuid) => serialize(() => _applyCredentialUnlocked(uuid), 'apply'),
    // Safe projection (the only route-serializable shape)
    getSafeList,
    // Internal, for tests only
    _armSelfWriteGuard,
    _serialize: serialize,
    _hasChainWatchdog: () => !!_chainWatchdogTimer,
  };
}

module.exports = {
  createCredentialManager,
  serializeCredentialsFile,
  validateAccountUuid,
  writeFileAtomic,
  displayNameFor,
  healthFor,
  credError,
  withOpDeadline,
  settleWithin,
  DEFAULT_CRED_SETTINGS,
  ANTHROPIC_TOKEN_URL,
  ANTHROPIC_USAGE_URL,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_CLIENT_ID,
  REFRESH_TIMEOUT_MS,
  OP_TIMEOUT_MS,
  MAC_OP_TIMEOUT_MS,
  CHAIN_WATCHDOG_INTERVAL_MS,
  CHAIN_STALL_FACTOR,
  EXPIRY_SKEW_MS,
  SUSPECT_ESCALATE_COUNT,
  DEAD_RETRY_MIN,
  PROACTIVE_REFRESH_WINDOW_MIN,
  PROACTIVE_REFRESH_FLOOR_MIN,
  TOKEN_STATE_OK,
  TOKEN_STATE_NEEDS_LOGIN,
  TOKEN_STATE_UNVERIFIED,
  POOL_OWNER_MARKER_FILE,
  EXTERNAL_BRIDGE_OWNER,
  EXTERNAL_OWNER_ENV,
  CRED_POOL_EXTERNAL_OWNER_CODE,
};
