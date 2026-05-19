#!/usr/bin/env node
/**
 * Integration tests for token persistence across server restarts.
 *
 * Tests the critical path: paired device tokens survive restarts and
 * expired tokens are cleaned on startup. A bug here means every mobile
 * device loses auth whenever the server restarts.
 *
 * Tests both HTTP-level behavior (end-to-end) and module-level behavior
 * (store persistence and auth reload internals).
 *
 * Usage: CWM_PASSWORD=test123 PORT=3460 node test/token-persistence.test.js
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

const PORT = process.env.PORT || 3460;
const PASSWORD = process.env.CWM_PASSWORD || 'test123';
const BASE = `http://localhost:${PORT}`;

let TOKEN = '';
let serverProcess = null;

// ─── Test Framework ─────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * Log a test result.
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
 * Send an HTTP request with optional auth token.
 * @param {string} method - HTTP method
 * @param {string} urlPath - Request path
 * @param {Object|null} body - JSON body (optional)
 * @param {Object} customHeaders - Override headers
 * @returns {Promise<{status: number, body: string}>}
 */
function request(method, urlPath, body, customHeaders) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...customHeaders };
    if (TOKEN && !(customHeaders && 'Authorization' in customHeaders)) {
      headers['Authorization'] = `Bearer ${TOKEN}`;
    }
    const req = http.request(BASE + urlPath, { method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const get = (p, h) => request('GET', p, null, h);
const post = (p, b, h) => request('POST', p, b, h);

/**
 * Safely parse JSON from a response body.
 * @param {Object} r - Response with .body string
 * @returns {Object|null}
 */
function json(r) {
  try { return JSON.parse(r.body); } catch { return null; }
}

// ─── Module-Level Helpers ───────────────────────────────────

/**
 * Clear the require cache for store and auth modules so we get fresh instances.
 */
function resetModules() {
  const storeKey = require.resolve('../src/state/store');
  const authKey = require.resolve('../src/web/auth');
  delete require.cache[storeKey];
  delete require.cache[authKey];
}

/**
 * Get a clean store instance that loads state from disk.
 * @returns {Object} Store instance
 */
function loadFreshStore() {
  resetModules();
  const { Store } = require('../src/state/store');
  return new Store().init();
}

// ─── Server Lifecycle ───────────────────────────────────────

/**
 * Start the server for testing.
 * @returns {Promise<void>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    serverProcess = spawn(process.execPath, [
      path.join(__dirname, '..', 'src', 'gui.js'),
      '--no-open',
    ], {
      env: { ...process.env, PORT: String(PORT), CWM_PASSWORD: PASSWORD, NODE_ENV: 'test', CWM_NO_OPEN: '1' },
      stdio: 'pipe',
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        started = true;
        reject(new Error('Server did not start within 10 seconds'));
      }
    }, 10000);

    serverProcess.stdout.on('data', (data) => {
      const text = data.toString();
      if (!started && (text.includes('CWM GUI running') || text.includes('http://') || text.includes('listening'))) {
        started = true;
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.includes('EADDRINUSE')) {
        started = true;
        clearTimeout(timeout);
        reject(new Error(`Port ${PORT} already in use`));
      }
    });

    serverProcess.on('exit', (code) => {
      if (!started) {
        started = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

/**
 * Stop the test server.
 */
function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ─── Tests ──────────────────────────────────────────────────

/**
 * Run the token persistence test suite.
 * Part 1 uses HTTP (live server), Part 2 uses module-level operations.
 */
async function run() {
  console.log('\n  Token Persistence Tests');
  console.log('  ' + '-'.repeat(40));

  // ═══════════════════════════════════════════
  // Part 1: HTTP-level tests (server is running)
  // ═══════════════════════════════════════════

  // Authenticate as admin
  const loginRes = await post('/api/auth/login', { password: PASSWORD });
  const loginData = json(loginRes);
  TOKEN = (loginData && loginData.token) || '';
  check('Login succeeds', loginRes.status === 200 && TOKEN.length > 0);

  if (!TOKEN) {
    console.error('\nFATAL: Could not authenticate. Is the server running?');
    process.exit(1);
  }

  // Pair a device via API for end-to-end verification
  console.log('\n  --- HTTP: Pair and Verify ---');

  let r = await get('/api/auth/pairing-code');
  const codeData = json(r);
  check('Generate pairing code', r.status === 200 && codeData?.pairingToken);

  r = await post('/api/auth/pair', {
    pairingToken: codeData.pairingToken,
    deviceName: 'Persistence Test Phone',
    platform: 'ios',
    appVersion: '1.0.0',
  }, { Authorization: '' });
  const pairData = json(r);
  check('Pair device succeeds', r.status === 200 && pairData?.token);

  const deviceToken = pairData?.token || '';

  // Verify paired device token is valid via HTTP
  r = await get('/api/auth/check', { Authorization: `Bearer ${deviceToken}` });
  check('Paired device token is valid via HTTP', json(r)?.authenticated === true);

  // Stop server, we will test module-level from here
  stopServer();
  await new Promise(res => setTimeout(res, 1000));

  // ═══════════════════════════════════════════
  // Part 2: Module-level persistence tests
  // Uses store and auth modules directly, no server needed.
  // ═══════════════════════════════════════════

  console.log('\n  --- Module: Store Persistence ---');

  // Test 1: Create store, add device, save, reload into new instance
  const store1 = loadFreshStore();

  const testDeviceId = crypto.randomUUID();
  const testToken = crypto.randomBytes(32).toString('hex');
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  store1.addPairedDevice({
    deviceId: testDeviceId,
    token: testToken,
    deviceName: 'Module Test Phone',
    platform: 'android',
    pairedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: futureDate,
  });
  store1.save(); // Explicit save (bypass debounce)
  store1.destroy();

  // Load a completely new store instance from disk
  const store2 = loadFreshStore();
  const reloadedDevices = store2.getPairedDevices();
  const reloadedDevice = reloadedDevices.find(d => d.deviceId === testDeviceId);
  check('Device persisted to disk and reloaded in new store', !!reloadedDevice);
  check('Reloaded device has correct token', reloadedDevice?.token === testToken);
  check('Reloaded device has correct name', reloadedDevice?.deviceName === 'Module Test Phone');

  // Test 2: reloadTokensFromStore populates activeTokens
  console.log('\n  --- Module: Token Reload ---');

  resetModules();
  const auth = require('../src/web/auth');
  const { Store: S3 } = require('../src/state/store');
  const store3 = new S3().init();

  // Token should not be valid in fresh auth module
  check('Token is NOT valid before reload', !auth.isValidToken(testToken));

  // Reload tokens from store
  auth.reloadTokensFromStore(() => store3);
  check('Token IS valid after reloadTokensFromStore', auth.isValidToken(testToken));

  // Test 3: Expired device cleanup
  console.log('\n  --- Module: Expiration Cleanup ---');

  const expiredDeviceId = crypto.randomUUID();
  const expiredToken = crypto.randomBytes(32).toString('hex');
  store3.addPairedDevice({
    deviceId: expiredDeviceId,
    token: expiredToken,
    deviceName: 'Expired Device',
    platform: 'android',
    pairedAt: '2025-01-01T00:00:00.000Z',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
    expiresAt: '2025-06-01T00:00:00.000Z', // well in the past
  });
  store3.save();

  const beforeClean = store3.getPairedDevices();
  check('Expired device was added', !!beforeClean.find(d => d.deviceId === expiredDeviceId));

  // Test 4: Non-expired devices survive cleanup
  const validDeviceId = crypto.randomUUID();
  const validToken = crypto.randomBytes(32).toString('hex');
  store3.addPairedDevice({
    deviceId: validDeviceId,
    token: validToken,
    deviceName: 'Still Valid Device',
    platform: 'ios',
    pairedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: futureDate,
  });
  store3.save();

  const removed = store3.cleanExpiredDevices();
  check('cleanExpiredDevices removed at least 1 device', removed >= 1);

  const afterClean = store3.getPairedDevices();
  check('Expired device is gone after cleanup', !afterClean.find(d => d.deviceId === expiredDeviceId));
  check('Non-expired device survived cleanup', !!afterClean.find(d => d.deviceId === validDeviceId));
  check('Module test device survived cleanup', !!afterClean.find(d => d.deviceId === testDeviceId));

  store3.save();
  store3.destroy();

  // Test 5: Full simulated restart cycle
  console.log('\n  --- Module: Simulated Restart ---');

  resetModules();
  const authFresh = require('../src/web/auth');
  const { Store: S4 } = require('../src/state/store');
  const store4 = new S4().init();

  // Tokens not valid before reload
  check('Tokens invalid in fresh auth module', !authFresh.isValidToken(testToken));
  check('Valid device token also invalid before reload', !authFresh.isValidToken(validToken));

  // Simulate startup: reload tokens (includes expired cleanup)
  authFresh.reloadTokensFromStore(() => store4);

  // Non-expired tokens should work; expired should not
  check('Module test token works after restart', authFresh.isValidToken(testToken));
  check('Valid device token works after restart', authFresh.isValidToken(validToken));
  check('Expired token does NOT work after restart', !authFresh.isValidToken(expiredToken));

  // Test 6: Token removal on device revoke
  console.log('\n  --- Module: Revoke Invalidates Token ---');

  check('Token valid before revoke', authFresh.isValidToken(testToken));
  authFresh.removeToken(testToken);
  check('Token invalid after removeToken', !authFresh.isValidToken(testToken));

  // Clean up all test devices from store
  store4.removePairedDevice(testDeviceId);
  store4.removePairedDevice(validDeviceId);
  // Also clean up any leftover device from the HTTP pair test
  const leftover = store4.getPairedDevices().filter(d => d.deviceName === 'Persistence Test Phone');
  for (const d of leftover) {
    store4.removePairedDevice(d.deviceId);
  }
  store4.save();
  store4.destroy();

  // ── Results ──
  console.log('\n  ' + '-'.repeat(40));
  console.log(`  Token persistence: ${passed} passed, ${failed} failed`);
  console.log('  ' + '-'.repeat(40) + '\n');

  return failed;
}

// ─── Main ───────────────────────────────────────────────────

(async () => {
  try {
    console.log(`\n  Starting test server on port ${PORT}...`);
    await startServer();
    const failures = await run();
    stopServer();
    process.exit(failures > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n  ERROR:', err.message);
    stopServer();
    process.exit(1);
  }
})();
