#!/usr/bin/env node
/**
 * run-all.js: runs every test/mobile/*.test.js as its own child process and
 * exits non zero when any of them fails (BUILD-CONTRACT 3.2, 5.1).
 *
 * WHY: test/run.js runs this one entry (S21), so B1, B2 and B3 each add test
 * files without editing a shared list. Each file runs in a fresh process with
 * its own sandboxed CWM_DATA_DIR (test/_test-data-dir.js), so no test can
 * leak state into another or touch the real Workbook data.
 *
 * Sandbox guard (after the 2026-09-27 incident, see _harness.js): before any
 * child starts, a static preflight refuses a test file that loads a local
 * module before ../_test-data-dir or ./_harness, and every child starts with a
 * fresh temp CWM_DATA_DIR and a random CWM_PASSWORD already in its
 * environment, so even a file that got the order wrong can never reach the
 * live data folder or make src/web/auth.js copy the live password.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/** Per file timeout. */
const FILE_TIMEOUT_MS = 10 * 60 * 1000;
/** Random bytes in a child's throwaway desktop password. */
const CHILD_PASSWORD_BYTES = 18;
/** Prefix of the temp folder each child starts with. */
const CHILD_DIR_PREFIX = 'cwm-mobile-run-';
/**
 * The modules that sandbox a test process, as a test file requires them
 * (test/mobile/*.test.js and one folder deeper).
 */
const SANDBOX_SPECIFIERS = new Set(['../_test-data-dir', '../_test-data-dir.js', './_harness', './_harness.js', '../../_test-data-dir', '../../_test-data-dir.js', '../_harness', '../_harness.js']);

/**
 * Remove comments from JavaScript source so a require inside a comment is not
 * counted. Strings are left alone; this is a preflight, not a parser, and it
 * errs toward flagging a file.
 *
 * @param {string} source - File text.
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

/**
 * The first require in a test file that could load Workbook code before the
 * sandbox exists, or null when the sandbox comes first. Node built ins and
 * package names are fine before it; a relative module or a computed path is
 * not, because it may reach src/. A file that never requires the sandbox is
 * refused too.
 *
 * @param {string} source - Test file text.
 * @returns {string|null} The offending specifier (or a sentence), or null.
 */
function firstUnsafeRequire(source) {
  const re = /\brequire\s*\(\s*([^)]*?)\s*\)/g;
  const text = stripComments(source);
  let m;
  while ((m = re.exec(text)) !== null) {
    const arg = m[1];
    const lit = /^(['"`])([^'"`$]+)\1$/.exec(arg);
    if (!lit) return 'a computed require (' + arg.slice(0, 40) + ')';
    const spec = lit[2];
    if (SANDBOX_SPECIFIERS.has(spec)) return null;
    if (spec.startsWith('.') || path.isAbsolute(spec)) return spec;
  }
  return 'no require of ../_test-data-dir or ./_harness at all';
}

/**
 * The environment of one test child: the parent's, with a fresh sandbox data
 * folder and a throwaway desktop password in place before the child's first
 * line runs, and the opt in to the real data folder removed.
 *
 * @param {object} baseEnv - The parent environment.
 * @param {string} dataDir - A fresh folder under the system temp folder.
 * @returns {object} The child environment.
 */
function childEnv(baseEnv, dataDir) {
  const env = Object.assign({}, baseEnv);
  // Never inherit a real data dir, the opt in to it, or a live password.
  delete env.CWM_TEST_ALLOW_PROD_DIR;
  env.CWM_DATA_DIR = dataDir;
  env.CWM_PASSWORD = 'cwm-mobile-' + crypto.randomBytes(CHILD_PASSWORD_BYTES).toString('base64url');
  return env;
}

/**
 * The test files to run, in name order.
 *
 * @param {string} dir - test/mobile.
 * @param {string[]} only - Substring filters from argv (none runs all).
 * @returns {string[]} File names.
 */
function listTestFiles(dir, only) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
    .sort();
}

/** Entry point: preflight, then one sandboxed child per file. */
function main() {
  const dir = __dirname;
  const files = listTestFiles(dir, process.argv.slice(2));
  let failed = 0;
  const started = Date.now();
  for (const file of files) {
    console.log('\n  mobile: ' + file);
    const unsafe = firstUnsafeRequire(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (unsafe) {
      failed += 1;
      console.log('  REFUSED: ' + file + ' loads ' + unsafe + ' before the sandbox; require ./_harness (or ../_test-data-dir) first');
      continue;
    }
    const childDir = fs.mkdtempSync(path.join(os.tmpdir(), CHILD_DIR_PREFIX));
    try {
      const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit', env: childEnv(process.env, childDir), timeout: FILE_TIMEOUT_MS });
      if (r.status !== 0) {
        failed += 1;
        console.log('  FAILED: ' + file + (r.signal ? ' (signal ' + r.signal + ')' : ' (exit ' + r.status + ')'));
      }
    } finally {
      try { fs.rmSync(childDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }
  console.log('\n  mobile: ' + (files.length - failed) + '/' + files.length + ' files passed in ' + Math.round((Date.now() - started) / 1000) + ' s');
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { firstUnsafeRequire, stripComments, childEnv, listTestFiles, SANDBOX_SPECIFIERS, CHILD_DIR_PREFIX };
