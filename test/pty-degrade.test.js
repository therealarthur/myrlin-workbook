#!/usr/bin/env node
/**
 * Issue #68: node-pty native-module load failure containment.
 *
 * Verifies the server degrades gracefully (instead of crashing / half-booting)
 * when node-pty cannot be loaded. Coverage:
 *
 *   A. pty-diagnostics.buildRemediationText:
 *        - linux mentions the build toolchain, the install-scripts approve
 *          step, the rebuild step, and the npx cache repair step.
 *        - win32 mentions the rebuild step.
 *        - no output contains an em dash (U+2014) or horizontal bar (U+2015).
 *   B. Available state (node-pty loads on this host):
 *        - getPtyAvailability().available === true
 *        - getHealthPtyField() === { available: true }
 *   C. Route shape (available state): GET /api/health includes pty.available.
 *   D. Simulated-unavailable state (CWM_SIMULATE_PTY_LOAD_FAILURE=1):
 *        - getPtyAvailability() reports unavailable with PTY_NATIVE_LOAD_FAILED
 *        - getHealthPtyField() is { available:false, code } and leaks no path
 *        - attachClient(fakeWs) records close(1011, 'PTY_UNAVAILABLE')
 *        - read-only manager methods return empty results (no throw)
 *        - a spawn-path call throws an Error carrying code
 *          PTY_NATIVE_LOAD_FAILED, NOT a TypeError on the null module
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 on green /
 * 1 on any failure. Registered in test/run.js standaloneTests.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const http = require('http');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Never point tests at the production ./state/.
require('./_test-data-dir');

// ─── Assertion helpers (inlined per standalone-test convention) ────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + (err && err.message ? err.message : err) + '\x1b[0m');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
  }
}

/** Fresh-require a module by clearing its require cache entry first. */
function freshRequire(rel) {
  const resolved = require.resolve(rel);
  delete require.cache[resolved];
  return require(rel);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Issue #68: node-pty load-failure containment');
  console.log('  ' + '-'.repeat(60));

  // ── A. Remediation text ──────────────────────────────────────────────────
  const diag = require('../src/web/pty-diagnostics');

  await test('buildRemediationText(linux) covers toolchain/approve/rebuild/npx', () => {
    const t = diag.buildRemediationText('linux');
    assert(t.includes('build-essential'), 'missing build toolchain line');
    assert(t.includes('python3'), 'missing python3 in toolchain line');
    assert(t.includes('install-scripts approve node-pty'), 'missing approve line');
    assert(t.includes('npm rebuild node-pty --foreground-scripts'), 'missing rebuild line');
    assert(t.includes('clear-npx-cache') || t.includes('_npx'), 'missing npx cache repair line');
    assert(t.includes('keep working') || t.includes('keeps working'), 'missing "everything else works" note');
  });

  await test('buildRemediationText(win32) mentions rebuild', () => {
    const t = diag.buildRemediationText('win32');
    assert(t.includes('npm rebuild node-pty --foreground-scripts'), 'missing rebuild line');
  });

  await test('buildRemediationText(darwin) mentions rebuild', () => {
    const t = diag.buildRemediationText('darwin');
    assert(t.includes('npm rebuild node-pty --foreground-scripts'), 'missing rebuild line');
  });

  await test('remediation text contains no em dash / horizontal bar', () => {
    // Build the forbidden characters from their code points so this source
    // file itself stays free of literal em dash / horizontal bar characters.
    const EM_DASH = String.fromCharCode(0x2014);
    const HORIZONTAL_BAR = String.fromCharCode(0x2015);
    for (const p of ['linux', 'win32', 'darwin', 'freebsd']) {
      const t = diag.buildRemediationText(p);
      assert(t.indexOf(EM_DASH) === -1, 'found em dash (U+2014) for platform ' + p);
      assert(t.indexOf(HORIZONTAL_BAR) === -1, 'found horizontal bar (U+2015) for platform ' + p);
    }
  });

  // ── B. Available state (node-pty loads on this host) ──────────────────────
  await test('getPtyAvailability() reports available in the normal case', () => {
    const avail = freshRequire('../src/web/pty-diagnostics').getPtyAvailability();
    assertEqual(avail.available, true, 'expected available true when node-pty loads');
  });

  await test('getHealthPtyField() is { available:true } in the normal case', () => {
    const field = require('../src/web/pty-diagnostics').getHealthPtyField();
    assertEqual(JSON.stringify(field), JSON.stringify({ available: true }));
  });

  // ── C. Route shape: GET /api/health includes the pty field (available) ────
  await test('GET /api/health includes pty.available === true', async () => {
    // Boot the provider registry (mirrors discover-route.test.js) then require
    // the Express app WITHOUT startServer so this test owns the port lifecycle.
    const registry = require('../src/providers');
    const fakeStore = { state: { settings: { providers: { claude: true } } } };
    await registry.initRegistry(fakeStore);
    const { app } = require('../src/web/server');
    assert(app, 'server.app must be exported');

    const httpServer = http.createServer(app);
    await new Promise((resolve, reject) => {
      httpServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    const port = httpServer.address().port;
    try {
      const body = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
            catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
      assertEqual(body.status, 200, 'health status should be 200');
      assertEqual(body.json.status, 'ok', 'health body status should be ok');
      assert(body.json.pty && typeof body.json.pty === 'object', 'health body must include a pty object');
      assertEqual(body.json.pty.available, true, 'pty.available should be true when node-pty loads');
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  // ── D. Simulated-unavailable state ────────────────────────────────────────
  // Flip the module-level pty to null by forcing the simulated load failure
  // and re-requiring pty-manager (and pty-diagnostics) fresh.
  process.env.CWM_SIMULATE_PTY_LOAD_FAILURE = '1';
  const ptyManager = freshRequire('../src/web/pty-manager');
  const diag2 = freshRequire('../src/web/pty-diagnostics');
  const { PtySessionManager, PTY_UNAVAILABLE_CODE } = ptyManager;

  await test('getPtyAvailability() reports unavailable with the stable code', () => {
    const avail = diag2.getPtyAvailability();
    assertEqual(avail.available, false, 'expected available false under simulated failure');
    assertEqual(avail.code, 'PTY_NATIVE_LOAD_FAILED', 'expected stable machine code');
    assertEqual(PTY_UNAVAILABLE_CODE, 'PTY_NATIVE_LOAD_FAILED', 'exported code constant mismatch');
  });

  await test('getHealthPtyField() is { available:false, code } and leaks no path', () => {
    const field = diag2.getHealthPtyField();
    assertEqual(field.available, false);
    assertEqual(field.code, 'PTY_NATIVE_LOAD_FAILED');
    const serialized = JSON.stringify(field);
    assert(!serialized.includes('/'), 'health pty field must not leak a path (found /)');
    assert(!serialized.includes('\\\\'), 'health pty field must not leak a windows path');
    assert(!serialized.toLowerCase().includes('prebuilds'), 'health pty field must not leak the raw error');
  });

  await test('attachClient closes the WebSocket with 1011 PTY_UNAVAILABLE', () => {
    const mgr = new PtySessionManager();
    const fakeWs = {
      readyState: 1,
      sent: [],
      closed: null,
      send(d) { this.sent.push(d); },
      close(code, reason) { this.closed = { code, reason }; },
    };
    mgr.attachClient('sid-attach', fakeWs, {});
    assert(fakeWs.closed, 'attachClient should have closed the socket');
    assertEqual(fakeWs.closed.code, 1011, 'close code should be 1011');
    assertEqual(fakeWs.closed.reason, 'PTY_UNAVAILABLE', 'close reason should be PTY_UNAVAILABLE');
  });

  await test('read-only manager methods return empties without throwing', () => {
    const mgr = new PtySessionManager();
    assertEqual(JSON.stringify(mgr.listSessions()), '[]', 'listSessions should be empty');
    const sb = mgr.getScrollbackLines('nope');
    assertEqual(sb.total, 0, 'scrollback total should be 0');
    assertEqual(JSON.stringify(sb.lines), '[]', 'scrollback lines should be empty');
    assertEqual(mgr.getSession('nope'), undefined, 'getSession should be undefined');
  });

  await test('spawn-path call throws a coded error, not a TypeError', () => {
    const mgr = new PtySessionManager();
    let threw = null;
    try {
      mgr.spawnSession('sid-spawn', { command: 'claude' });
    } catch (e) {
      threw = e;
    }
    assert(threw, 'spawnSession should throw when node-pty is unavailable');
    assert(!(threw instanceof TypeError), 'must not be a raw TypeError on the null module');
    assertEqual(threw.code, 'PTY_NATIVE_LOAD_FAILED', 'error must carry the stable code');
  });

  // ── Results ────────────────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(60));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log('    - ' + f.name);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('  Uncaught error in pty-degrade.test.js:', err && err.stack ? err.stack : err);
  process.exit(1);
});
