#!/usr/bin/env node
/**
 * Integration tests for session pagination, logs pagination, and token refresh.
 *
 * Tests store.getPaginatedSessions with various filter combinations:
 * limit/offset, status filter, sort/order, search, workspaceId, combined filters,
 * edge cases (offset beyond total, limit clamping), backward compatibility.
 *
 * Also tests logs pagination (addSessionLog + slice) and token refresh
 * (refreshDeviceToken + findDeviceByToken).
 *
 * Usage: node test/pagination.test.js
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

// ---- Test Framework ----

let passed = 0;
let failed = 0;

/**
 * Log a test result and increment counters.
 * @param {string} name - Test description
 * @param {boolean} ok - Whether the test passed
 */
function check(name, ok) {
  if (ok) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name);
  }
}

/**
 * Clear the require cache for the store module so we get a fresh instance.
 */
function resetModules() {
  const storeKey = require.resolve('../src/state/store');
  delete require.cache[storeKey];
  // Also clear docs-manager and data-dir if cached
  try { delete require.cache[require.resolve('../src/state/docs-manager')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/utils/data-dir')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/utils/path-utils')]; } catch (_) {}
}

/**
 * Get a fresh store instance for testing.
 * @returns {Object} Initialized Store instance
 */
function loadFreshStore() {
  resetModules();
  const { Store } = require('../src/state/store');
  return new Store().init();
}

/**
 * Delete state files to prevent leaking between test runs.
 */
function cleanup() {
  const stateDir = process.env.CWM_DATA_DIR;
  const stateFile = path.join(stateDir, 'workspaces.json');
  const backupFile = path.join(stateDir, 'workspaces.backup.json');
  try { fs.unlinkSync(stateFile); } catch (_) {}
  try { fs.unlinkSync(backupFile); } catch (_) {}
}

// ---- Test Data Setup ----

/**
 * Seed the store with test workspaces and sessions for pagination tests.
 * Creates 2 workspaces and 12 sessions with varied names, statuses, and topics.
 * @param {Object} store - Store instance
 * @returns {{ wsA: Object, wsB: Object, sessions: Object[] }}
 */
function seedTestData(store) {
  const wsA = store.createWorkspace({ name: 'Workspace Alpha', color: 'blue' });
  const wsB = store.createWorkspace({ name: 'Workspace Beta', color: 'green' });

  // Sessions with deterministic names for sort testing.
  // Stagger createdAt so sort-by-created is testable.
  const sessionDefs = [
    { name: 'Alice Session', workspaceId: wsA.id, topic: 'backend api', status: 'running' },
    { name: 'Bob Session', workspaceId: wsA.id, topic: 'frontend ui', status: 'stopped' },
    { name: 'Charlie Session', workspaceId: wsA.id, topic: 'backend api', status: 'running' },
    { name: 'Delta Session', workspaceId: wsB.id, topic: 'testing', status: 'stopped' },
    { name: 'Echo Session', workspaceId: wsB.id, topic: 'deployment', status: 'running' },
    { name: 'Foxtrot Session', workspaceId: wsA.id, topic: 'frontend ui', status: 'stopped' },
    { name: 'Golf Session', workspaceId: wsB.id, topic: 'backend api', status: 'running' },
    { name: 'Hotel Session', workspaceId: wsA.id, topic: 'database', status: 'error' },
    { name: 'India Session', workspaceId: wsB.id, topic: 'CI pipeline', status: 'stopped' },
    { name: 'Juliet Session', workspaceId: wsA.id, topic: 'BACKEND refactor', status: 'running' },
    { name: 'Kilo Session', workspaceId: wsB.id, topic: 'frontend ui', status: 'idle' },
    { name: 'Lima Session', workspaceId: wsA.id, topic: 'testing utils', status: 'stopped' },
  ];

  const sessions = [];
  for (let i = 0; i < sessionDefs.length; i++) {
    const def = sessionDefs[i];
    const s = store.createSession({
      name: def.name,
      workspaceId: def.workspaceId,
      topic: def.topic,
    });
    // Set status (createSession defaults to 'stopped', update if different)
    if (def.status !== 'stopped') {
      store.updateSession(s.id, { status: def.status });
    }
    // Stagger createdAt for deterministic sort-by-created ordering
    const baseTime = new Date('2026-01-01T00:00:00Z');
    baseTime.setMinutes(baseTime.getMinutes() + i * 10);
    store.updateSession(s.id, { createdAt: baseTime.toISOString(), lastActive: baseTime.toISOString() });
    sessions.push(store.getSession(s.id));
  }

  return { wsA, wsB, sessions };
}

// ---- Tests ----

/**
 * Run the full test suite for pagination, logs, and token refresh.
 */
function run() {
  console.log('\n  Pagination, Logs, and Token Refresh Tests');
  console.log('  ' + '-'.repeat(50));

  cleanup();
  const store = loadFreshStore();
  const { wsA, wsB, sessions } = seedTestData(store);

  // ---- Default pagination ----
  console.log('\n  --- Default Pagination ---');

  let result = store.getPaginatedSessions();
  check('Default returns all 12 sessions (limit 50 > total)', result.sessions.length === 12);
  check('Default total is 12', result.total === 12);
  check('Default limit is 50', result.limit === 50);
  check('Default offset is 0', result.offset === 0);
  check('Default hasMore is false', result.hasMore === false);

  // ---- Limit and offset ----
  console.log('\n  --- Limit and Offset ---');

  result = store.getPaginatedSessions({ limit: 3, offset: 0 });
  check('limit=3 offset=0 returns 3 sessions', result.sessions.length === 3);
  check('limit=3 offset=0 hasMore is true', result.hasMore === true);
  check('limit=3 offset=0 total is 12', result.total === 12);

  result = store.getPaginatedSessions({ limit: 3, offset: 3 });
  check('limit=3 offset=3 returns 3 sessions (page 2)', result.sessions.length === 3);
  check('limit=3 offset=3 hasMore is true', result.hasMore === true);

  result = store.getPaginatedSessions({ limit: 3, offset: 9 });
  check('limit=3 offset=9 returns 3 sessions (page 4)', result.sessions.length === 3);
  check('limit=3 offset=9 hasMore is false (last page)', result.hasMore === false);

  // ---- Status filter ----
  console.log('\n  --- Status Filter ---');

  result = store.getPaginatedSessions({ status: 'running' });
  const runningCount = sessions.filter(s => s.status === 'running').length;
  check('status=running returns correct count (' + runningCount + ')', result.sessions.length === runningCount);
  check('status=running all sessions are running', result.sessions.every(s => s.status === 'running'));

  result = store.getPaginatedSessions({ status: 'stopped' });
  const stoppedCount = sessions.filter(s => s.status === 'stopped').length;
  check('status=stopped returns correct count (' + stoppedCount + ')', result.sessions.length === stoppedCount);
  check('status=stopped all sessions are stopped', result.sessions.every(s => s.status === 'stopped'));

  result = store.getPaginatedSessions({ status: 'error' });
  check('status=error returns 1 session', result.sessions.length === 1);
  check('status=error session is Hotel Session', result.sessions[0].name === 'Hotel Session');

  result = store.getPaginatedSessions({ status: 'idle' });
  check('status=idle returns 1 session', result.sessions.length === 1);

  // ---- Sort and order ----
  console.log('\n  --- Sort and Order ---');

  result = store.getPaginatedSessions({ sort: 'name', order: 'asc' });
  check('sort=name order=asc: first is Alice', result.sessions[0].name === 'Alice Session');
  check('sort=name order=asc: last is Lima', result.sessions[result.sessions.length - 1].name === 'Lima Session');
  // Verify alphabetical ordering
  const names = result.sessions.map(s => s.name);
  const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  check('sort=name order=asc: names are alphabetically sorted', JSON.stringify(names) === JSON.stringify(sorted));

  result = store.getPaginatedSessions({ sort: 'name', order: 'desc' });
  check('sort=name order=desc: first is Lima', result.sessions[0].name === 'Lima Session');
  check('sort=name order=desc: last is Alice', result.sessions[result.sessions.length - 1].name === 'Alice Session');

  result = store.getPaginatedSessions({ sort: 'created', order: 'asc' });
  check('sort=created order=asc: first is Alice (earliest)', result.sessions[0].name === 'Alice Session');
  check('sort=created order=asc: last is Lima (latest)', result.sessions[result.sessions.length - 1].name === 'Lima Session');

  result = store.getPaginatedSessions({ sort: 'lastActive', order: 'desc' });
  check('sort=lastActive order=desc: first is Lima (most recent)', result.sessions[0].name === 'Lima Session');

  // ---- Search ----
  console.log('\n  --- Search ---');

  result = store.getPaginatedSessions({ search: 'backend' });
  check('search=backend returns sessions with backend in name or topic', result.total >= 3);
  check('search=backend all match', result.sessions.every(s =>
    s.name.toLowerCase().includes('backend') || s.topic.toLowerCase().includes('backend')
  ));

  result = store.getPaginatedSessions({ search: 'BACKEND' });
  check('search=BACKEND (uppercase) is case-insensitive', result.total >= 3);

  result = store.getPaginatedSessions({ search: 'frontend ui' });
  check('search="frontend ui" matches topic substring', result.total >= 2);

  result = store.getPaginatedSessions({ search: 'nonexistent-term-xyz' });
  check('search for nonexistent term returns empty', result.total === 0);
  check('search empty result has hasMore=false', result.hasMore === false);

  // ---- WorkspaceId filter ----
  console.log('\n  --- WorkspaceId Filter ---');

  result = store.getPaginatedSessions({ workspaceId: wsA.id });
  const wsASessions = sessions.filter(s => s.workspaceId === wsA.id);
  check('workspaceId=wsA returns correct count (' + wsASessions.length + ')', result.total === wsASessions.length);

  result = store.getPaginatedSessions({ workspaceId: wsB.id });
  const wsBSessions = sessions.filter(s => s.workspaceId === wsB.id);
  check('workspaceId=wsB returns correct count (' + wsBSessions.length + ')', result.total === wsBSessions.length);

  result = store.getPaginatedSessions({ workspaceId: 'nonexistent-id' });
  check('workspaceId=nonexistent returns empty', result.total === 0);

  // ---- Combined filters ----
  console.log('\n  --- Combined Filters ---');

  result = store.getPaginatedSessions({ status: 'running', workspaceId: wsA.id });
  const wsARunning = sessions.filter(s => s.workspaceId === wsA.id && s.status === 'running');
  check('status=running + workspaceId=wsA: count=' + wsARunning.length, result.total === wsARunning.length);

  result = store.getPaginatedSessions({ status: 'running', search: 'backend' });
  check('status=running + search=backend: all are running', result.sessions.every(s => s.status === 'running'));
  check('status=running + search=backend: all match search', result.sessions.every(s =>
    s.name.toLowerCase().includes('backend') || s.topic.toLowerCase().includes('backend')
  ));

  result = store.getPaginatedSessions({ status: 'stopped', workspaceId: wsA.id, search: 'frontend' });
  check('Triple filter (stopped + wsA + frontend): returns matching sessions', result.sessions.every(s =>
    s.status === 'stopped' && s.workspaceId === wsA.id &&
    (s.name.toLowerCase().includes('frontend') || s.topic.toLowerCase().includes('frontend'))
  ));

  // ---- Edge cases ----
  console.log('\n  --- Edge Cases ---');

  result = store.getPaginatedSessions({ limit: 200 });
  check('limit=200 clamped to 100', result.limit === 100);

  result = store.getPaginatedSessions({ limit: 0 });
  check('limit=0 clamped to minimum 1', result.limit >= 1);

  result = store.getPaginatedSessions({ offset: 999 });
  check('offset=999 (beyond total) returns empty sessions', result.sessions.length === 0);
  check('offset=999 total is still 12', result.total === 12);
  check('offset=999 hasMore is false', result.hasMore === false);

  // ---- Backward compatibility ----
  console.log('\n  --- Backward Compatibility ---');

  const allSessions = store.getAllSessionsList();
  check('getAllSessionsList returns all 12 sessions', allSessions.length === 12);
  check('getAllSessionsList returns plain array (no pagination metadata)', Array.isArray(allSessions));
  check('getAllSessionsList items have id and name', allSessions.every(s => s.id && s.name));

  // ---- Logs pagination ----
  console.log('\n  --- Logs Pagination ---');

  const logSession = sessions[0];
  // Add 20 log entries
  for (let i = 0; i < 20; i++) {
    store.addSessionLog(logSession.id, `Log message ${i + 1}`);
  }

  const updated = store.getSession(logSession.id);
  check('Session has 20 log entries', updated.logs.length === 20);

  // Simulate logs pagination (slice the logs array, as the API endpoint does)
  const logsPage1 = updated.logs.slice(0, 5);
  check('Logs page 1 (offset=0, limit=5): 5 entries', logsPage1.length === 5);
  check('Logs page 1 first entry is "Log message 1"', logsPage1[0].message === 'Log message 1');

  const logsPage4 = updated.logs.slice(15, 20);
  check('Logs page 4 (offset=15, limit=5): 5 entries', logsPage4.length === 5);
  check('Logs page 4 last entry is "Log message 20"', logsPage4[4].message === 'Log message 20');

  const logsBeyond = updated.logs.slice(25, 30);
  check('Logs beyond total (offset=25): empty array', logsBeyond.length === 0);

  // ---- Token refresh ----
  console.log('\n  --- Token Refresh ---');

  const oldToken = 'old-device-token-' + crypto.randomUUID();
  const deviceId = 'test-device-' + crypto.randomUUID();
  const oldExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  store.addPairedDevice({
    deviceId,
    token: oldToken,
    deviceName: 'Test Phone',
    platform: 'ios',
    pairedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: oldExpiry,
  });

  // Verify the old token is findable
  let found = store.findDeviceByToken(oldToken);
  check('Old token is findable before refresh', found !== null && found.deviceId === deviceId);

  // Refresh the token
  const newToken = 'new-device-token-' + crypto.randomUUID();
  const newExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const refreshed = store.refreshDeviceToken(deviceId, newToken, newExpiry);

  check('refreshDeviceToken returns the updated device', refreshed !== null);
  check('refreshDeviceToken: new token is set', refreshed && refreshed.token === newToken);
  check('refreshDeviceToken: new expiresAt is set', refreshed && refreshed.expiresAt === newExpiry);

  // Old token should no longer resolve
  found = store.findDeviceByToken(oldToken);
  check('Old token no longer found after refresh', found === null);

  // New token should resolve
  found = store.findDeviceByToken(newToken);
  check('New token found after refresh', found !== null && found.deviceId === deviceId);

  // Refresh nonexistent device returns null
  const noDevice = store.refreshDeviceToken('no-such-device', 'tok', '2099-01-01');
  check('refreshDeviceToken on nonexistent device returns null', noDevice === null);

  // ---- Results ----
  console.log('\n  ' + '-'.repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('  ' + '-'.repeat(50) + '\n');

  cleanup();
  return failed;
}

// ---- Main ----

try {
  const failures = run();
  process.exit(failures > 0 ? 1 : 0);
} catch (err) {
  console.error('\n  ERROR:', err.message);
  console.error(err.stack);
  cleanup();
  process.exit(1);
}
