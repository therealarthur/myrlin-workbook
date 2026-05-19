/**
 * Shared sandbox for tests. MUST be require()'d at the top of every test file,
 * BEFORE anything that touches src/state/store or src/utils/data-dir.
 *
 *   require('./_test-data-dir');
 *
 * Sets CWM_DATA_DIR to a fresh tmpdir per test process and removes it on exit.
 *
 * Why this exists: every test file used to do
 *     process.env.CWM_DATA_DIR = path.join(__dirname, '..', 'state');
 * which pointed the store at the PRODUCTION ./state/ directory. On 2026-05-11
 * that wiped the user's real workspaces and replaced them with 1019
 * pty-test-ws-* / codex-test-ws-* entries. Never again. Tests get a tmpdir.
 *
 * Allowing the old behavior is still possible by setting
 *     CWM_TEST_ALLOW_PROD_DIR=1
 * before invoking the test; the helper then leaves CWM_DATA_DIR untouched.
 * Do not set that flag unless you understand the blast radius.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.CWM_TEST_ALLOW_PROD_DIR === '1') {
  // Caller has opted into prod-dir behavior. Nothing to do.
  module.exports = { dir: process.env.CWM_DATA_DIR || null, isolated: false };
  return;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-test-'));
process.env.CWM_DATA_DIR = dir;

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

module.exports = { dir, isolated: true, cleanup };
