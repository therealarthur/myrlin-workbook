/**
 * Codex path normalization and project identity.
 *
 * BUILD-CONTRACT P8.3 / CODEX-PARITY P0-3 (gap B2).
 *
 * Why this module exists
 * ----------------------
 * The Codex desktop app stores a working directory on every thread, and that
 * value is the ONLY folder association that exists: there is no folder-name
 * table anywhere on disk. Two different spellings of the same directory
 * therefore render as two different folders in a sidebar.
 *
 * Measured on a live machine (CODEX-PARITY A.6): 19 distinct raw `threads.cwd`
 * values collapse to 18 once the Windows extended-length prefix is stripped and
 * case is folded. The concrete collision is:
 *
 *     C:\Users\<user>\Documents\New project 2
 *     \\?\C:\Users\<user>\Documents\New project 2
 *
 * Unnormalized, that is two sidebar rows with the same visible name. The
 * rollout JSONL's `session_meta.cwd` and `local_thread_catalog.cwd` are always
 * clean; only `threads.cwd` and `threads.rollout_path` carry the prefix. So the
 * moment the SQLite store becomes a discovery source, normalization stops being
 * cosmetic and becomes a correctness requirement.
 *
 * Three separate values, three separate jobs
 * -----------------------------------------
 * These must not be conflated, and each is derived from a different form of the
 * path. Getting this wrong silently breaks either grouping or the project id.
 *
 *   normalizeCodexPath(p) -> display form.  Prefix stripped, separators
 *       collapsed, trailing separator dropped, CASE PRESERVED. This is what a
 *       human sees and what the basename is taken from.
 *
 *   projectKeyFor(p)      -> grouping key.  normalizeCodexPath lowercased.
 *       Windows paths are case-insensitive, so the two spellings above must
 *       collapse to one bucket. This is also the cross-provider merge key
 *       (BUILD-CONTRACT P8.6): a Claude session and a Codex session in the same
 *       directory produce the same key and therefore one sidebar row.
 *
 *   projectIdFor(p, host) -> stable synthetic id.  sha256 of the NON-lowercased
 *       normalized path, first 32 hex chars, namespaced by host. Lowercasing
 *       here would break the id, because the app hashes the cased path. Proven
 *       by exact hash match against two independent folders recorded in
 *       .codex-global-state.json (CODEX-PARITY A.3); both are asserted in
 *       test/codex-paths.test.js.
 *
 * Host namespacing
 * ----------------
 * `codex-dev.db` declares hosts as first class:
 *   host_kind IN ('local','ssh','wsl','remote-control')
 * Only 'local' exists on the measured machine, so non-local behaviour is
 * UNCONFIRMED. The id format namespaces by host precisely so it tolerates the
 * others later. `hostId` is therefore a parameter with a default, never a
 * hardcoded literal at the call site (CODEX-PARITY D.3 item 3).
 *
 * Every function here is pure, total and never throws. Bad input returns a
 * defined empty-ish value rather than raising, because these run inside
 * discovery, which is contractually forbidden from throwing.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * @module src/providers/codex/paths
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants (no magic values at call sites)
// ---------------------------------------------------------------------------

/**
 * The Windows extended-length path prefix. Codex writes this on some rows and
 * not others, from the same app, on the same machine. Stripping it is the
 * single highest-value normalization step.
 */
const EXTENDED_LENGTH_PREFIX = '\\\\?\\';

/**
 * The UNC form of the extended-length prefix: \\?\UNC\server\share is the long
 * spelling of \\server\share. Restoring it to the familiar double-backslash
 * form keeps UNC shares grouping with their normal spelling.
 */
const EXTENDED_LENGTH_UNC_PREFIX = '\\\\?\\UNC\\';

/** Number of hex characters kept from the sha256 digest for a project id. */
const PROJECT_ID_HASH_LENGTH = 32;

/** Default host namespace. Read from data where available; never assumed. */
const DEFAULT_HOST_ID = 'local';

/** Prefix that namespaces a Codex project id away from other providers. */
const PROJECT_ID_NAMESPACE = 'codex'; // gsd:provider-literal-allowed

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Codex-recorded path to its canonical display form.
 *
 * Steps, in order, each of which is load-bearing:
 *   1. Reject non-strings and empty strings up front, returning ''. Callers
 *      treat '' as "no folder association" rather than crashing.
 *   2. Strip the extended-length prefix. `\\?\UNC\srv\share` becomes
 *      `\\srv\share`; `\\?\C:\x` becomes `C:\x`.
 *   3. Collapse runs of separators to a single one, while preserving a leading
 *      UNC double backslash. `C:\\a\\\b` becomes `C:\a\b`, and `\\srv\share`
 *      keeps both leading slashes.
 *   4. Normalize forward slashes to backslashes when the path is clearly a
 *      Windows path (drive letter or UNC). POSIX paths keep forward slashes, so
 *      this module is safe on the Mac Mini as well as on Windows.
 *   5. Drop a trailing separator, but never turn a root (`C:\`, `/`) into ''.
 *
 * Case is deliberately preserved. Use projectKeyFor for comparisons.
 *
 * @param {*} p - Raw path from threads.cwd, threads.rollout_path, or a rollout
 *   session_meta.cwd.
 * @returns {string} Normalized path, or '' when the input is unusable.
 */
function normalizeCodexPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  if (s.length === 0) return '';

  // 2. Extended-length prefix. UNC form first, because it is a longer match
  //    that also starts with the plain prefix.
  if (s.toUpperCase().startsWith(EXTENDED_LENGTH_UNC_PREFIX.toUpperCase())) {
    s = '\\\\' + s.slice(EXTENDED_LENGTH_UNC_PREFIX.length);
  } else if (s.startsWith(EXTENDED_LENGTH_PREFIX)) {
    s = s.slice(EXTENDED_LENGTH_PREFIX.length);
  }
  if (s.length === 0) return '';

  // 4. Decide the separator dialect BEFORE collapsing, so a mixed path such as
  //    `C:/Users/x\y` lands on one consistent form.
  const looksWindows = /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s);
  if (looksWindows) s = s.replace(/\//g, '\\');

  // 3. Collapse duplicate separators, preserving a leading UNC pair.
  if (looksWindows) {
    const isUnc = /^\\{2}[^\\]/.test(s);
    const body = isUnc ? s.slice(2) : s;
    const collapsed = body.replace(/\\{2,}/g, '\\');
    s = isUnc ? '\\\\' + collapsed : collapsed;
  } else {
    s = s.replace(/\/{2,}/g, '/');
  }

  // 5. Trailing separator, unless the result would stop being a root.
  if (s.length > 1) {
    const isDriveRoot = /^[a-zA-Z]:\\$/.test(s);
    const isPosixRoot = s === '/';
    if (!isDriveRoot && !isPosixRoot) {
      s = s.replace(/[\\/]+$/, '');
    }
  }

  return s;
}

/**
 * The grouping key for a working directory.
 *
 * This is the value two sessions must share to appear under one folder, and it
 * is deliberately provider-agnostic: BUILD-CONTRACT P8.6 merges a Claude folder
 * and a Codex folder when their keys match, so one directory is one sidebar row
 * carrying both providers' sessions.
 *
 * Lowercasing is correct on Windows and macOS (case-insensitive by default) and
 * is a deliberate, documented compromise on Linux, where two directories can
 * legitimately differ only by case. Merging them is a far smaller harm than
 * splitting one directory into two rows on the platforms this app actually
 * ships on, and the display name still carries the original casing.
 *
 * @param {*} p - Raw or normalized path.
 * @returns {string} Lowercased normalized path, or '' when unusable.
 */
function projectKeyFor(p) {
  return normalizeCodexPath(p).toLowerCase();
}

/**
 * The human-facing folder label for a working directory.
 *
 * The Codex app has no stored display name for a project (verified negatively:
 * no folder-name table exists anywhere on disk), so it synthesizes the label
 * from the path. The workbook already does the same at app.js:2322 and :4295,
 * so this matches existing behaviour rather than inventing a new convention.
 *
 * Casing comes from the NON-lowercased normalized path, so the capitalisation
 * the user chose for their directory survives.
 *
 * @param {*} p - Raw or normalized path.
 * @returns {string} Final path segment, or '' when unusable.
 */
function projectDisplayNameFor(p) {
  const normalized = normalizeCodexPath(p);
  if (!normalized) return '';
  // Split on either separator so a POSIX path on macOS resolves too.
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return normalized;
  const last = parts[parts.length - 1];
  // `C:` alone is a drive root; show it as the drive rather than as ''.
  return last.length > 0 ? last : normalized;
}

/**
 * The stable synthetic project id, in the exact format the Codex desktop app
 * uses in `.codex-global-state.json`.
 *
 *     codex:<hostId>-<sha256(normalizedCwd) first 32 hex chars>
 *
 * Reproduced exactly by brute-forcing the app's own keys against every distinct
 * cwd in the database across md5, sha1 and sha256 over raw, prefix-stripped,
 * lowercased and forward-slash variants. Only ONE variant matched, and it is
 * the one implemented here: sha256 over the prefix-stripped, case-PRESERVED,
 * backslash-separated path. Both proven pairs are asserted as unit tests.
 *
 * Consequence worth stating plainly: because the hash is case-sensitive while
 * the grouping key is not, two spellings that differ only by case share a
 * grouping key but produce different project ids. The grouping key is the
 * authority for merging; the project id is the authority for talking to the
 * Codex app's own state. Do not swap their roles.
 *
 * @param {*} p - Working directory, raw or normalized.
 * @param {string} [hostId] - Host namespace. `local`, `ssh`, `wsl` or
 *   `remote-control` per codex-dev.db. Read it from data where available.
 * @returns {string} The project id, or '' when the path is unusable.
 */
function projectIdFor(p, hostId) {
  const normalized = normalizeCodexPath(p);
  if (!normalized) return '';
  const host = typeof hostId === 'string' && hostId.length > 0 ? hostId : DEFAULT_HOST_ID;
  let digest;
  try {
    digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  } catch (_) {
    // crypto is always present in Node, but discovery is never allowed to
    // throw, so a defensive empty return beats an exception escaping.
    return '';
  }
  return PROJECT_ID_NAMESPACE + ':' + host + '-' + digest.slice(0, PROJECT_ID_HASH_LENGTH);
}

/**
 * Convenience bundle: every derived form of one working directory, computed
 * once. Discovery attaches this to each session so the frontend never has to
 * re-derive (and never has to guess which form to use).
 *
 * @param {*} p - Working directory, raw.
 * @param {string} [hostId] - Host namespace.
 * @returns {{raw: string, path: string, key: string, displayName: string, id: string}}
 */
function describeProject(p, hostId) {
  const normalized = normalizeCodexPath(p);
  return {
    raw: typeof p === 'string' ? p : '',
    path: normalized,
    key: normalized.toLowerCase(),
    displayName: projectDisplayNameFor(normalized),
    id: projectIdFor(normalized, hostId),
  };
}

module.exports = {
  normalizeCodexPath,
  projectKeyFor,
  projectDisplayNameFor,
  projectIdFor,
  describeProject,
  // Exported so tests and future callers reference the constant rather than
  // re-typing the literal, per the no-magic-values rule.
  EXTENDED_LENGTH_PREFIX,
  EXTENDED_LENGTH_UNC_PREFIX,
  PROJECT_ID_HASH_LENGTH,
  DEFAULT_HOST_ID,
  PROJECT_ID_NAMESPACE,
};
