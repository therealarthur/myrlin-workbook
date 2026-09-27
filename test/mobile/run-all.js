#!/usr/bin/env node
/**
 * run-all.js: runs every test/mobile/*.test.js as its own child process and
 * exits non zero when any of them fails (BUILD-CONTRACT 3.2, 5.1).
 *
 * WHY: test/run.js runs this one entry (S21), so B1, B2 and B3 each add test
 * files without editing a shared list. Each file runs in a fresh process with
 * its own sandboxed CWM_DATA_DIR (test/_test-data-dir.js), so no test can
 * leak state into another or touch the real Workbook data.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Per file timeout. */
const FILE_TIMEOUT_MS = 10 * 60 * 1000;

const dir = __dirname;
const only = process.argv.slice(2);
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

let failed = 0;
const started = Date.now();
for (const file of files) {
  console.log('\n  mobile: ' + file);
  const env = Object.assign({}, process.env);
  // Never inherit a real data dir or the live password into a mobile test.
  delete env.CWM_DATA_DIR;
  delete env.CWM_TEST_ALLOW_PROD_DIR;
  const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit', env, timeout: FILE_TIMEOUT_MS });
  if (r.status !== 0) {
    failed += 1;
    console.log('  FAILED: ' + file + (r.signal ? ' (signal ' + r.signal + ')' : ' (exit ' + r.status + ')'));
  }
}
console.log('\n  mobile: ' + (files.length - failed) + '/' + files.length + ' files passed in ' + Math.round((Date.now() - started) / 1000) + ' s');
process.exit(failed === 0 ? 0 : 1);
