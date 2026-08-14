#!/usr/bin/env node
/**
 * test-assertion-count.js - normalise an `npm test` transcript into one table.
 * Created: 2026-08-13 (phase P0, work package P0.1 support).
 *
 * WHY THIS EXISTS
 *
 * The standing gate in BUILD-CONTRACT.md 5.1 says "assertion count must be at or
 * above the P0.1 baseline". `npm test` cannot answer that question on its own:
 * test/run.js runs an inline suite and then spawns 78 standalone files, each
 * printing its own summary in one of five different formats, and nothing prints
 * a grand total. Comparing phases by eye across five formats is how a silently
 * deleted assertion gets through.
 *
 * This reads a transcript and prints a per-file table plus a total, using one
 * fixed rule per known format. An unrecognised section falls back to counting
 * tick and cross lines and is marked, so a new format is visible rather than
 * silently counted as zero.
 *
 * Usage:
 *   npm test > transcript.txt 2>&1
 *   node scripts/test-assertion-count.js transcript.txt
 *   node scripts/test-assertion-count.js transcript.txt --json
 *   npm test 2>&1 | node scripts/test-assertion-count.js -
 *
 * Exit code 0 when the transcript parses and reports no failures, 1 otherwise.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const source = args.find((a) => !a.startsWith('--'));

if (!source) {
  console.error('usage: node scripts/test-assertion-count.js <transcript|-> [--json]');
  process.exit(1);
}

const raw = source === '-'
  ? fs.readFileSync(0, 'utf8')
  : fs.readFileSync(source, 'utf8');

// Strip ANSI colour so the format patterns below stay simple.
const plain = raw.replace(/\[[0-9;]*m/g, '');
const lines = plain.split(/\r?\n/);

/**
 * The five summary formats the suite emits today, in priority order. The first
 * pattern that matches within a section wins, scanning from the end so a
 * section's own final summary beats any earlier line that looks similar.
 */
const PATTERNS = [
  { re: /Results:\s*(\d+) passed,\s*(\d+) failed/, pass: 1, fail: 2 },
  { re: /\[[\w-]+\]\s*(\d+)\/(\d+) tests passed/, pass: 1, total: 2 },
  { re: /ALL PASS \((\d+) passed\)/, pass: 1 },
  { re: /Grep gate PASSED/, fixed: 1 },
  { re: /(\d+)\/(\d+) tests passed/, pass: 1, total: 2 },
];

const sections = [];
let current = { file: '(inline suite in test/run.js)', lines: [] };
for (const line of lines) {
  const started = line.match(/^\s*Running ([\w.-]+\.test\.js)\s*$/);
  if (started) {
    sections.push(current);
    current = { file: started[1], lines: [] };
    continue;
  }
  current.lines.push(line);
}
sections.push(current);

const rows = [];
let totalPass = 0;
let totalFail = 0;
for (const section of sections) {
  let found = null;
  for (let i = section.lines.length - 1; i >= 0 && !found; i--) {
    for (const pattern of PATTERNS) {
      const match = section.lines[i].match(pattern.re);
      if (!match) continue;
      found = pattern.fixed !== undefined
        ? { pass: pattern.fixed, fail: 0 }
        : {
          pass: Number(match[pattern.pass]),
          fail: pattern.fail ? Number(match[pattern.fail]) : 0,
        };
      break;
    }
  }
  if (!found) {
    const ticks = section.lines.filter((l) => /^\s*(✓|PASS )/.test(l)).length;
    const crosses = section.lines.filter((l) => /^\s*(✗|FAIL )/.test(l)).length;
    found = { pass: ticks, fail: crosses, inferred: true };
  }
  totalPass += found.pass;
  totalFail += found.fail;
  rows.push(Object.assign({ file: section.file }, found));
}

if (jsonOut) {
  console.log(JSON.stringify({ files: rows.length, passed: totalPass, failed: totalFail, rows }, null, 2));
} else {
  for (const row of rows) {
    console.log(
      String(row.pass).padStart(6) +
      (row.fail ? '  FAIL:' + row.fail : '       ') +
      (row.inferred ? ' ~ ' : '   ') +
      row.file
    );
  }
  console.log('-'.repeat(60));
  console.log('files:      ' + rows.length);
  console.log('assertions: ' + totalPass + ' passed, ' + totalFail + ' failed');
  const inferred = rows.filter((r) => r.inferred);
  if (inferred.length) {
    console.log('note: ' + inferred.length + ' section(s) had no recognised summary line and were ' +
      'counted by tick lines: ' + inferred.map((r) => r.file).join(', '));
  }
}

process.exit(totalFail > 0 ? 1 : 0);
