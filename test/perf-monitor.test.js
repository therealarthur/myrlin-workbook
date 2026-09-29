#!/usr/bin/env node
/**
 * Unit coverage for src/web/perf-monitor.js (the lag monitor behind
 * GET /api/perf, the Ctrl+Alt+P overlay and perf.log).
 *
 * Hermetic: the monitor is built with timers off, stalls are recorded by
 * hand, and the CPU profile is a synthetic one. Locks:
 *   - sync, op, route and count land in the current window's top lists
 *   - a stall names the operations that ran inside it
 *   - the profile summary finds long blocks and names the app frame
 *   - timeAsync records even when the promise rejects
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { createPerfMonitor, summariseProfile } = require('../src/web/perf-monitor');

let passed = 0;
let failed = 0;

/** Minimal async-aware pass/fail runner matching the other standalone tests. */
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

async function main() {
  await check('sync, op, route and count reach the snapshot', async () => {
    const mon = createPerfMonitor({ timers: false });
    mon.sync('spawn:git', 40);
    mon.sync('spawn:git', 10);
    mon.op('discover:codex', 300);
    mon.route('GET /api/git/status', 12);
    mon.count('sse:discover:refreshed');
    mon.count('sse:discover:refreshed');
    const cur = mon.snapshot().current;
    const git = cur.spawns.find((e) => e.key === 'spawn:git');
    assert.deepStrictEqual([git.n, git.ms, git.max], [2, 50, 40]);
    assert.strictEqual(cur.ops[0].key, 'discover:codex');
    assert.strictEqual(cur.routes[0].key, 'GET /api/git/status');
    assert.strictEqual(cur.sse[0].n, 2);
    mon.stop();
  });

  await check('a stall names the operations that ran inside it', async () => {
    const mon = createPerfMonitor({ timers: false, autoProfile: false });
    mon.sync('spawn:git', 180);
    mon._recordStall(220);
    const snap = mon.snapshot();
    assert.strictEqual(snap.current.stalls, 1);
    assert.strictEqual(snap.recentStalls[0].ms, 220);
    assert.ok(snap.recentStalls[0].during.some((d) => d.op === 'spawn:git'), JSON.stringify(snap.recentStalls[0]));
    mon.stop();
  });

  await check('timeAsync records a rejected operation and rethrows', async () => {
    const mon = createPerfMonitor({ timers: false });
    await assert.rejects(() => mon.timeAsync('discover:claude', () => Promise.reject(new Error('boom'))), /boom/);
    assert.strictEqual(mon.snapshot().current.ops[0].key, 'discover:claude');
    mon.stop();
  });

  await check('the profile summary finds long blocks and names the app frame', async () => {
    const appRoot = path.join('C:', 'app', 'src');
    const url = 'file:///' + path.join(appRoot, 'web', 'server.js').replace(/\\/g, '/');
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3, 4] },
        { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
        { id: 3, callFrame: { functionName: 'gitStatus', url, lineNumber: 41 }, children: [5] },
        { id: 4, callFrame: { functionName: '(program)', url: '', lineNumber: -1 } },
        { id: 5, callFrame: { functionName: 'spawn', url: 'node:internal/child_process', lineNumber: 1 } },
      ],
      // idle, then 60 ms busy in spawn under gitStatus, then idle, then a 10 ms blip.
      samples: [2, 5, 5, 5, 5, 5, 5, 2, 3, 2],
      timeDeltas: [0, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000],
    };
    const s = summariseProfile(profile, appRoot);
    assert.strictEqual(s.blocks, 1, JSON.stringify(s));
    assert.ok(s.causes[0].key.startsWith('gitStatus web/server.js:42'), s.causes[0].key);
    assert.ok(s.busyPct > 0 && s.busyPct < 100);
  });

  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
