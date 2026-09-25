/**
 * Claude Code file-lock interop for the PC apply transaction (Quota widget
 * support, W1 hardening, 2026-09-25).
 *
 * WHY: the Claude apply is a read-modify-write of two files that Claude Code
 * itself writes: ~/.claude/.credentials.json (claudeAiOauth plus mcpOAuth
 * and other keys) and ~/.claude.json (the global config that holds
 * oauthAccount). Claude Code serializes its own writers with
 * proper-lockfile locks and re-reads the file inside the lock. A Workbook
 * write that ignores those locks can land between Claude Code's read and
 * its rename, so one side's change is silently lost: a rotated MCP token,
 * a rotated claudeAiOauth pair, or the identity we just installed. Taking
 * the same locks for the few milliseconds of our write closes that window.
 *
 * The protocol (proper-lockfile, verified in Claude Code 2.1.283): a lock is
 * a DIRECTORY created with mkdir next to the thing it guards. The holder
 * refreshes the directory's mtime while it holds the lock (update interval
 * below the stale window), so a lock dir whose mtime is older than the stale
 * window belongs to a holder that died and may be taken over. Locks used by
 * the apply, in acquisition order:
 *
 *   <claudeDir>/.oauth_refresh.lock     token refresh (realpath:false, stale
 *                                       60 s), taken first
 *   <realpath(claudeDir)>.lock          legacy refresh lock Claude Code also
 *                                       takes right after the one above
 *   <claude.json path>.lock             global config writes (.claude.json)
 *   <claudeDir>/.storage-write.lock     secure-storage writes
 *                                       (.credentials.json; realpath:false,
 *                                       stale 15 s, 10 retries on its side)
 *
 * Holding the refresh lock across the whole apply also closes the narrow
 * race where a running session is mid-refresh of the outgoing account
 * (claude-swap research 2026-09-25-claude-usage-auth.md section 4): the
 * apply waits for that refresh to save, so step 1's sync-back captures the
 * rotated pair.
 *
 * Contention never blocks forever: acquisition retries on a short, bounded
 * schedule and then reports `held`, which the caller turns into a retryable
 * 409 before anything is written. A lock that cannot be created for another
 * reason (missing parent dir, a non-directory squatting on the path,
 * permissions) is reported as `unavailable`; the caller proceeds without it,
 * exactly as Claude Code does for its legacy refresh lock, because refusing
 * every apply over a lock nobody can hold would be worse than the race.
 *
 * Nothing here reads or logs file content. Only directory entries are
 * created, stat'ed and removed.
 *
 * Design: claude-swap docs/plans/2026-09-25-usage-widget-design.md section 7
 * (W1) and docs/research/2026-09-25-claude-usage-auth.md section 4.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Named constants ────────────────────────────────────────────────────────
// Stale windows. Ours are equal to or LONGER than Claude Code's own, so a
// lock Claude Code is actively holding (mtime refreshed every few seconds)
// can never look stale to us.
const STORAGE_WRITE_LOCK_STALE_MS = 15000;
const OAUTH_REFRESH_LOCK_STALE_MS = 60000;
// Claude Code's global-config lock options are not pinned down in the
// research; proper-lockfile's default stale window is 10 s, so 15 s is on
// the conservative side of it.
const GLOBAL_CONFIG_LOCK_STALE_MS = 15000;
// Retry schedule while a lock is held by someone else (ms between tries).
// About 2.3 s in total: Claude Code holds these locks for a file write or a
// token refresh, so a longer wait would only delay the retryable 409.
const DEFAULT_LOCK_RETRY_DELAYS_MS = Object.freeze([20, 40, 80, 160, 320, 640, 1000]);
const STORAGE_WRITE_LOCK_NAME = '.storage-write.lock';
const OAUTH_REFRESH_LOCK_NAME = '.oauth_refresh.lock';
const LOCK_SUFFIX = '.lock';

/**
 * Path of Claude Code's secure-storage write lock for a config dir.
 *
 * @param {string} claudeDir - Dir holding .credentials.json.
 * @returns {string} Lock directory path.
 */
function storageWriteLockPath(claudeDir) {
  return path.join(claudeDir, STORAGE_WRITE_LOCK_NAME);
}

/**
 * Path of Claude Code's current OAuth refresh lock for a config dir.
 *
 * @param {string} claudeDir - Dir holding .credentials.json.
 * @returns {string} Lock directory path.
 */
function oauthRefreshLockPath(claudeDir) {
  return path.join(claudeDir, OAUTH_REFRESH_LOCK_NAME);
}

/**
 * Path of Claude Code's legacy OAuth refresh lock: the REAL path of the
 * config dir with ".lock" appended (a sibling of the dir, not inside it).
 * Falls back to the given path when the dir cannot be resolved.
 *
 * @param {string} claudeDir - Dir holding .credentials.json.
 * @returns {string} Lock directory path.
 */
function legacyOauthRefreshLockPath(claudeDir) {
  let real = claudeDir;
  try { real = fs.realpathSync(claudeDir); } catch (_) { real = claudeDir; }
  return String(real).replace(/[\\/]+$/, '') + LOCK_SUFFIX;
}

/**
 * Path of Claude Code's global-config lock (proper-lockfile default: the
 * guarded file's path plus ".lock").
 *
 * @param {string} claudeJsonPath - Path of the live .claude.json.
 * @returns {string} Lock directory path.
 */
function globalConfigLockPath(claudeJsonPath) {
  return claudeJsonPath + LOCK_SUFFIX;
}

/**
 * One attempt to take a proper-lockfile style lock directory.
 *
 * @param {string} lockPath - Lock directory to create.
 * @param {number} staleMs - Age past which an existing lock dir is dead.
 * @param {number} nowMs - Wall-clock now (lock mtimes are wall-clock).
 * @returns {{outcome: 'acquired'|'held'|'unavailable', tookOverStale?: boolean, code?: string}}
 */
function _tryAcquireOnce(lockPath, staleMs, nowMs) {
  try {
    fs.mkdirSync(lockPath);
    return { outcome: 'acquired' };
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      return { outcome: 'unavailable', code: (err && err.code) || 'ERROR' };
    }
  }
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch (err) {
    // Released between our mkdir and stat: report held so the caller simply
    // tries again on its schedule.
    if (err && err.code === 'ENOENT') return { outcome: 'held' };
    return { outcome: 'unavailable', code: (err && err.code) || 'ERROR' };
  }
  if (!st.isDirectory()) {
    // Not a proper-lockfile lock; nobody can hold it, and it is not ours
    // to remove.
    return { outcome: 'unavailable', code: 'ENOTDIR' };
  }
  if ((nowMs - st.mtimeMs) > staleMs) {
    // Stale: its holder died without releasing. Take it over the way
    // proper-lockfile does (remove, then create). A racing process that
    // wins the mkdir makes ours fail with EEXIST, which reads as held.
    try { fs.rmdirSync(lockPath); } catch (_) { /* raced or not empty; the mkdir decides */ }
    try {
      fs.mkdirSync(lockPath);
      return { outcome: 'acquired', tookOverStale: true };
    } catch (err) {
      if (err && err.code === 'EEXIST') return { outcome: 'held' };
      return { outcome: 'unavailable', code: (err && err.code) || 'ERROR' };
    }
  }
  return { outcome: 'held' };
}

/**
 * Remove a lock directory this process created. Idempotent and silent: a
 * lock that is already gone (or was taken over as stale) is not an error.
 *
 * @param {string} lockPath - Lock directory to remove.
 * @returns {void}
 */
function _releaseLock(lockPath) {
  try { fs.rmdirSync(lockPath); } catch (_) { /* already gone */ }
}

/**
 * Default async sleep between lock attempts.
 *
 * @param {number} ms - Delay.
 * @returns {Promise<void>}
 */
function _defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take one lock directory, retrying on the given schedule while another
 * process holds it. Never throws.
 *
 * @param {string} lockPath - Lock directory path.
 * @param {object} lockOpts
 * @param {number} lockOpts.staleMs - Stale window for takeover.
 * @param {number[]} [lockOpts.retryDelaysMs] - Waits between attempts.
 * @param {() => number} [lockOpts.now] - Wall clock (default Date.now).
 * @param {(ms: number) => Promise<void>} [lockOpts.sleep] - Async sleep.
 * @returns {Promise<{outcome: 'acquired'|'held'|'unavailable', release: () => void, tookOverStale?: boolean, code?: string}>}
 *   `release` is a no-op unless the outcome is `acquired`.
 */
async function acquireLock(lockPath, lockOpts) {
  const staleMs = lockOpts.staleMs;
  const delays = Array.isArray(lockOpts.retryDelaysMs) ? lockOpts.retryDelaysMs : DEFAULT_LOCK_RETRY_DELAYS_MS;
  const now = typeof lockOpts.now === 'function' ? lockOpts.now : Date.now;
  const sleep = typeof lockOpts.sleep === 'function' ? lockOpts.sleep : _defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    const r = _tryAcquireOnce(lockPath, staleMs, now());
    if (r.outcome === 'acquired') {
      let released = false;
      return {
        outcome: 'acquired',
        tookOverStale: !!r.tookOverStale,
        release: () => {
          if (released) return;
          released = true;
          _releaseLock(lockPath);
        },
      };
    }
    if (r.outcome === 'unavailable') {
      return { outcome: 'unavailable', code: r.code, release: () => {} };
    }
    if (attempt >= delays.length) {
      return { outcome: 'held', release: () => {} };
    }
    await sleep(delays[attempt]);
  }
}

/**
 * Take every lock the PC apply needs, in Claude Code's own order (refresh,
 * legacy refresh, global config, secure storage), all or nothing. When any
 * lock is held by another process past the retry schedule, every lock
 * already taken is released and the result says which one was busy, so the
 * caller can abort before writing anything. Locks that are merely
 * unavailable (see the module header) are skipped and listed.
 *
 * @param {object} target
 * @param {string} target.claudeDir - Dir holding .credentials.json.
 * @param {string} target.claudeJsonPath - Path of the live .claude.json.
 * @param {object} [lockOpts] - retryDelaysMs, now, sleep (see acquireLock).
 * @returns {Promise<{ok: boolean, busy: string|null, skipped: string[], release: () => void}>}
 *   `busy` names the contended lock (a short label, never a path with
 *   content); `release` frees every lock taken, in reverse order.
 */
async function acquireApplyLocks(target, lockOpts = {}) {
  const plan = [
    { label: 'oauth-refresh', lockPath: oauthRefreshLockPath(target.claudeDir), staleMs: OAUTH_REFRESH_LOCK_STALE_MS },
    { label: 'oauth-refresh-legacy', lockPath: legacyOauthRefreshLockPath(target.claudeDir), staleMs: OAUTH_REFRESH_LOCK_STALE_MS },
    { label: 'global-config', lockPath: globalConfigLockPath(target.claudeJsonPath), staleMs: GLOBAL_CONFIG_LOCK_STALE_MS },
    { label: 'storage-write', lockPath: storageWriteLockPath(target.claudeDir), staleMs: STORAGE_WRITE_LOCK_STALE_MS },
  ];
  const held = [];
  const skipped = [];
  const releaseAll = () => {
    while (held.length > 0) {
      const lock = held.pop();
      try { lock.release(); } catch (_) { /* release never throws; belt and braces */ }
    }
  };
  for (const step of plan) {
    const lock = await acquireLock(step.lockPath, {
      staleMs: step.staleMs,
      retryDelaysMs: lockOpts.retryDelaysMs,
      now: lockOpts.now,
      sleep: lockOpts.sleep,
    });
    if (lock.outcome === 'acquired') {
      held.push(lock);
      continue;
    }
    if (lock.outcome === 'unavailable') {
      skipped.push(step.label + ':' + (lock.code || 'ERROR'));
      continue;
    }
    releaseAll();
    return { ok: false, busy: step.label, skipped, release: () => {} };
  }
  return { ok: true, busy: null, skipped, release: releaseAll };
}

module.exports = {
  acquireLock,
  acquireApplyLocks,
  storageWriteLockPath,
  oauthRefreshLockPath,
  legacyOauthRefreshLockPath,
  globalConfigLockPath,
  STORAGE_WRITE_LOCK_STALE_MS,
  OAUTH_REFRESH_LOCK_STALE_MS,
  GLOBAL_CONFIG_LOCK_STALE_MS,
  DEFAULT_LOCK_RETRY_DELAYS_MS,
};
