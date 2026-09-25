/**
 * Path allowlist for isolated credential imports (Quota widget support, W3).
 *
 * The Quota desktop widget adds or re-logs an account by running the CLI's
 * own login with its config/home dir pointed at a throwaway folder under
 * %LOCALAPPDATA%\Quota\capture\, then asks Workbook (the only credential
 * owner on this PC) to import what the login wrote. This module is the ONE
 * gate that decides whether a client-supplied directory may be read:
 *
 *   - the directory is resolved to its REAL path (symlinks and junctions
 *     followed) and must sit strictly inside the real capture root; the root
 *     itself is not an acceptable import dir;
 *   - every file read from it is resolved again and must stay inside that
 *     resolved dir and be a regular file, so a link planted inside the
 *     capture dir cannot point an import at a live credential file (for
 *     example ~/.claude/.credentials.json) somewhere else.
 *
 * Self-contained on purpose (no require of credential-manager.js): both the
 * Claude manager and the generic provider manager use it, and
 * credential-manager.js requiring it must never create a require cycle. Its
 * errors carry the same {status, code, retryable} fields as credError so the
 * route layers map them through structuredError unchanged.
 *
 * Nothing here ever reads a file's content into a log or an error message.
 *
 * Design: claude-swap docs/plans/2026-09-25-usage-widget-design.md section 7.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Named constants ────────────────────────────────────────────────────────
// Folder names under %LOCALAPPDATA% owned by the Quota widget (design section 3).
const QUOTA_DATA_DIR_NAME = 'Quota';
const QUOTA_CAPTURE_DIR_NAME = 'capture';
// Upper bound for one captured file. Real captures are a few KB (a fresh
// config dir holds a tiny .claude.json and a sub-1KB token file); the bound
// only exists so a hostile or runaway file can never be slurped into memory.
const CAPTURE_FILE_MAX_BYTES = 8 * 1024 * 1024;
// Machine-readable code for every allowlist refusal (design section 7).
const PATH_NOT_ALLOWED_CODE = 'PATH_NOT_ALLOWED';

/**
 * Build an Error carrying an HTTP status and a machine-readable code, the
 * same shape credential-manager's credError produces (duplicated here to
 * keep this module free of a require cycle).
 *
 * @param {number} status - HTTP status for the route layer.
 * @param {string} code - Machine-readable error code.
 * @param {string} message - Human-readable message (never file content).
 * @param {boolean} [retryable=false] - Whether the client may retry.
 * @returns {Error} Error with .status, .code, .retryable attached.
 */
function captureError(status, code, message, retryable = false) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.retryable = retryable;
  return err;
}

/**
 * Default capture root: %LOCALAPPDATA%\Quota\capture. Evaluated per call so
 * hermetic tests can repoint LOCALAPPDATA after this module loads. When
 * LOCALAPPDATA is unset (non-Windows hosts) it falls back to the Windows
 * default layout under the home dir, which simply will not exist there and
 * therefore refuses every import (fail closed).
 *
 * @returns {string} Absolute capture root path (not yet resolved).
 */
function defaultCaptureRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, QUOTA_DATA_DIR_NAME, QUOTA_CAPTURE_DIR_NAME);
}

/**
 * Resolve a path to its real, final form. Prefers the native resolver
 * (GetFinalPathNameByHandle on Windows: follows junctions and symlinks and
 * canonicalizes 8.3 short names) and falls back to the JS resolver.
 *
 * @param {string} p - Path to resolve.
 * @returns {string} Real path. Throws when the path does not exist.
 */
function realPathOf(p) {
  if (typeof fs.realpathSync.native === 'function') return fs.realpathSync.native(p);
  return fs.realpathSync(p);
}

/**
 * True when `child` is strictly inside `parent` (never equal to it, never a
 * sibling that merely shares a prefix, never on another drive). path.relative
 * compares case-insensitively on Windows, matching NTFS semantics.
 *
 * @param {string} parent - Real parent directory.
 * @param {string} child - Real candidate path.
 * @returns {boolean}
 */
function isStrictlyInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel) return false; // same path
  if (path.isAbsolute(rel)) return false; // different drive or root
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false;
  return true;
}

/**
 * Resolve a client-supplied capture directory against the allowlist. The
 * directory must be absolute, must exist, and its real path must be a
 * directory strictly inside the real capture root.
 *
 * @param {*} candidate - Directory path from the request body.
 * @param {string} [captureRoot] - Root override (tests); default
 *   defaultCaptureRoot().
 * @returns {{dir: string, root: string}} Real dir and real root.
 *   Throws 400 VALIDATION for a non-string, and 400 PATH_NOT_ALLOWED for
 *   anything outside the allowlist or not resolvable.
 */
function resolveCaptureDir(candidate, captureRoot) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw captureError(400, 'VALIDATION', 'The capture directory must be a non-empty string.');
  }
  const rootPath = captureRoot || defaultCaptureRoot();
  const refuse = (why) => captureError(400, PATH_NOT_ALLOWED_CODE,
    'Imports are only allowed from a directory inside ' + rootPath + ' (' + why + ').');
  if (!path.isAbsolute(candidate)) throw refuse('the path is not absolute');
  let realRoot;
  try {
    realRoot = realPathOf(rootPath);
  } catch (_) {
    throw refuse('the capture root does not exist');
  }
  let realDir;
  try {
    realDir = realPathOf(candidate);
  } catch (_) {
    throw refuse('the directory does not exist or cannot be resolved');
  }
  if (!isStrictlyInside(realRoot, realDir)) {
    throw refuse('the resolved path is outside the capture root');
  }
  let st;
  try { st = fs.statSync(realDir); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) throw refuse('the path is not a directory');
  return { dir: realDir, root: realRoot };
}

/**
 * Read one named file from an already-resolved capture directory. The file
 * is resolved again (a link inside the capture dir must not escape it) and
 * must be a regular file under CAPTURE_FILE_MAX_BYTES.
 *
 * @param {{dir: string, root: string}} resolved - From resolveCaptureDir.
 * @param {string} fileName - Plain base name (internal constant, never
 *   client input).
 * @returns {string|null} File text, or null when the file does not exist.
 *   Throws 400 PATH_NOT_ALLOWED when the file resolves outside the capture
 *   dir or is not a regular file, and 422 CAPTURE_FILE_TOO_LARGE when over
 *   the size bound.
 */
function readCaptureFile(resolved, fileName) {
  const filePath = path.join(resolved.dir, fileName);
  try {
    fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw captureError(400, PATH_NOT_ALLOWED_CODE, 'The captured ' + fileName + ' cannot be inspected.');
  }
  let realFile;
  try {
    realFile = realPathOf(filePath);
  } catch (_) {
    // A dangling link: treat like a missing file rather than guessing.
    return null;
  }
  if (!isStrictlyInside(resolved.dir, realFile)) {
    throw captureError(400, PATH_NOT_ALLOWED_CODE,
      'The captured ' + fileName + ' resolves outside the capture directory; refusing to read it.');
  }
  const st = fs.statSync(realFile);
  if (!st.isFile()) {
    throw captureError(400, PATH_NOT_ALLOWED_CODE, 'The captured ' + fileName + ' is not a regular file.');
  }
  if (st.size > CAPTURE_FILE_MAX_BYTES) {
    throw captureError(422, 'CAPTURE_FILE_TOO_LARGE',
      'The captured ' + fileName + ' is larger than ' + CAPTURE_FILE_MAX_BYTES + ' bytes.');
  }
  return fs.readFileSync(realFile, 'utf-8');
}

module.exports = {
  defaultCaptureRoot,
  resolveCaptureDir,
  readCaptureFile,
  isStrictlyInside,
  captureError,
  PATH_NOT_ALLOWED_CODE,
  CAPTURE_FILE_MAX_BYTES,
};
