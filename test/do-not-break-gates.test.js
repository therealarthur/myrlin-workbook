#!/usr/bin/env node
/**
 * do-not-break-gates.test.js - runs the restyle's mechanical floor inside the
 * normal test suite.
 * Created: 2026-08-13 (phase P0, work package P0.6).
 *
 * scripts/do-not-break-gates.js implements gates G1 to G13 from
 * BUILD-CONTRACT.md 5.3. A gate nobody runs is not a gate, and the contract's
 * standing gate (5.1 block 4) expects it at every phase boundary. Registering
 * this thin wrapper in test/run.js means `npm test` fails the moment a protected
 * id, class or data-* key disappears, or a drift counter moves the wrong way,
 * rather than at review time.
 *
 * Ratchet mode only. Phase targets (zero radius literals, zero gradients, one
 * uppercase rule) are reported as outstanding work, not failed here, because
 * they describe the end state of P2 to P4. Run the script with --strict for the
 * final acceptance sweep in P12.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const GATE_SCRIPT = path.join(__dirname, '..', 'scripts', 'do-not-break-gates.js');

console.log('\n  \x1b[1mDO-NOT-BREAK gates (BUILD-CONTRACT 5.3, ratchet mode)\x1b[0m');

const result = spawnSync(process.execPath, [GATE_SCRIPT, '--json'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
});

if (result.error) {
  console.log('  \x1b[31m✗\x1b[0m the gate script could not be executed: ' + result.error.message);
  console.log('  [do-not-break-gates] 0/1 tests passed');
  process.exit(1);
}

let report = null;
try {
  report = JSON.parse(result.stdout);
} catch (parseError) {
  console.log('  \x1b[31m✗\x1b[0m the gate script did not emit parseable JSON');
  console.log((result.stdout || '').slice(0, 2000));
  console.log((result.stderr || '').slice(0, 2000));
  console.log('  [do-not-break-gates] 0/1 tests passed');
  process.exit(1);
}

let passed = 0;
let failed = 0;
for (const gate of report.results) {
  const line = gate.id + ' ' + gate.name +
    (gate.direction === 'set'
      ? ' (' + gate.measured + '/' + gate.baseline + ')'
      : ' (measured ' + gate.measured + ', baseline ' + (gate.baseline === null ? 'n/a' : gate.baseline) + ')');
  if (gate.status === 'FAIL') {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + line);
    if (gate.detail) console.log('    \x1b[31m' + gate.detail + '\x1b[0m');
  } else {
    passed++;
    const suffix = gate.status === 'TODO'
      ? ' \x1b[33m[target ' + gate.target + ' due in ' + gate.phase + ']\x1b[0m'
      : (gate.status === 'WARN' ? ' \x1b[33m[' + gate.detail + ']\x1b[0m' : '');
    console.log('  \x1b[32m✓\x1b[0m ' + line + suffix);
  }
}

console.log('  [do-not-break-gates] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 || result.status !== 0 ? 1 : 0);
