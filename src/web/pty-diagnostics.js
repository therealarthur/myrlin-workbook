/**
 * PTY diagnostics: single source of truth for node-pty availability reporting
 * and the operator-facing remediation text shown when the native terminal
 * engine fails to load.
 *
 * Background (issue #68): node-pty is a native addon. Its published package
 * ships prebuilt binaries only for macOS and Windows; on Linux it must compile
 * during install via its lifecycle script. Modern npm blocks dependency
 * install scripts by default, and an npx cache can hold a copy whose binary
 * was never built, so require('node-pty') can throw at load time. When that
 * happens the server now boots in a DEGRADED mode: the in-app terminal panes
 * are disabled, but every other feature keeps working. This module centralizes
 * (a) the capability probe consumed by the health endpoint, (b) the sanitized
 * health payload projection (no filesystem paths / usernames leak publicly),
 * and (c) the platform-specific remediation banner printed to the server
 * console on a degraded boot.
 *
 * Keeping the remediation wording in ONE place is the point: the exact steps
 * may get refined later, and a single module means a future edit touches one
 * file instead of several.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const os = require('os');

/**
 * Re-export the native-PTY capability probe. Lazily requires pty-manager so
 * this module never forces node-pty to load merely by being imported (e.g. a
 * test that only exercises buildRemediationText should not pull in the native
 * addon). Never throws: a probe failure is reported as "available" so a bug in
 * diagnostics can never itself take the server down.
 *
 * @returns {{ available: boolean, code: string|null, message: string|null }}
 */
function getPtyAvailability() {
  try {
    return require('./pty-manager').getPtyAvailability();
  } catch (_) {
    // If the probe itself is unreachable, fail OPEN: do not let a diagnostics
    // fault mask or manufacture a degraded state.
    return { available: true, code: null, message: null };
  }
}

/**
 * Build the sanitized `pty` object embedded in the PUBLIC GET /api/health
 * response. Only the boolean availability and a stable machine code are
 * exposed; the raw error message (which may contain filesystem paths or a
 * username) is deliberately withheld and remains in the server logs only.
 *
 * @returns {{ available: true } | { available: false, code: string }}
 */
function getHealthPtyField() {
  const avail = getPtyAvailability();
  if (avail.available) return { available: true };
  return { available: false, code: avail.code || 'PTY_NATIVE_LOAD_FAILED' };
}

/**
 * Build the multi-line console banner shown on a degraded boot, tailored to
 * the host platform. The text is intentionally generic about "AI CLI sessions"
 * and "terminal panes" so it does not hard-code any single provider name.
 *
 * Wording rules enforced repo-wide: no em dash and no double-hyphen used as
 * prose punctuation. Double hyphens appear ONLY inside literal CLI flags such
 * as the foreground-scripts flag, which is legitimate.
 *
 * @param {string} [platform=process.platform] - Node platform id
 *   ('linux' | 'darwin' | 'win32' | ...).
 * @returns {string} The full banner text (already framed with rule lines).
 */
function buildRemediationText(platform = process.platform) {
  const rule = '='.repeat(70);
  const lines = [];
  lines.push('');
  lines.push(rule);
  lines.push('  Myrlin Workbook started in DEGRADED mode');
  lines.push('  The native terminal engine (node-pty) could not be loaded.');
  lines.push('');
  lines.push('  Impact: in-app terminal panes and live AI CLI sessions are');
  lines.push('  disabled. Everything else (discovery, search, docs, kanban,');
  lines.push('  cost tracking, themes) keeps working normally.');
  lines.push('');

  if (platform === 'linux') {
    lines.push('  Why this happened on Linux:');
    lines.push('    node-pty ships prebuilt binaries only for macOS and');
    lines.push('    Windows. On Linux it must COMPILE during install, so a');
    lines.push('    missing build toolchain or a blocked install script leaves');
    lines.push('    the native binary absent.');
    lines.push('');
    lines.push('  How to fix (pick the item that matches your setup):');
    lines.push('');
    lines.push('  1. Install the build toolchain (Debian / Ubuntu):');
    lines.push('       sudo apt install build-essential python3');
    lines.push('     (On Fedora/RHEL use: sudo dnf groupinstall "Development Tools" && sudo dnf install python3)');
    lines.push('');
    lines.push('  2. If npm BLOCKED the dependency install script, approve it');
    lines.push('     and rebuild:');
    lines.push('       npm install-scripts approve node-pty');
    lines.push('       npm rebuild node-pty --foreground-scripts');
    lines.push('');
    lines.push('  3. If you launched with npx, the cached copy may hold a stale');
    lines.push('     unbuilt binary. Clear the npx cache so it reinstalls fresh,');
    lines.push('     then rerun:');
    lines.push('       npx clear-npx-cache');
    lines.push('     (or remove it manually: rm -rf ~/.npm/_npx )');
  } else if (platform === 'darwin' || platform === 'win32') {
    const osName = platform === 'darwin' ? 'macOS' : 'Windows';
    lines.push('  Why this is unusual on ' + osName + ':');
    lines.push('    node-pty ships prebuilt binaries for this platform, so a');
    lines.push('    load failure usually means the download was skipped or the');
    lines.push('    install scripts were disabled.');
    lines.push('');
    lines.push('  How to fix:');
    lines.push('');
    lines.push('  1. Rebuild the native module:');
    lines.push('       npm rebuild node-pty --foreground-scripts');
    lines.push('');
    lines.push('  2. Or reinstall with install scripts allowed (do not pass');
    lines.push('     --ignore-scripts), then restart the app.');
  } else {
    lines.push('  How to fix:');
    lines.push('');
    lines.push('  1. Rebuild the native module:');
    lines.push('       npm rebuild node-pty --foreground-scripts');
    lines.push('');
    lines.push('  2. Ensure a C/C++ build toolchain and python3 are installed,');
    lines.push('     then reinstall with install scripts allowed.');
  }

  lines.push('');
  lines.push('  Detected platform: ' + platform + ' (' + os.arch() + ')');
  lines.push('  More help: README Troubleshooting section.');
  lines.push(rule);
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  getPtyAvailability,
  getHealthPtyField,
  buildRemediationText,
};
