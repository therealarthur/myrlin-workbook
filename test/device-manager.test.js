#!/usr/bin/env node
/**
 * Integration tests for the device management API.
 *
 * Tests CRUD operations on paired devices:
 *   GET    /api/devices           - List all paired devices
 *   GET    /api/devices/:id       - Get single device
 *   PUT    /api/devices/:id       - Update device name and push prefs
 *   DELETE /api/devices/:id       - Revoke device (invalidate token)
 *
 * Verifies: auth requirements, response shapes, token stripping,
 * name validation, push preference validation, and revocation
 * invalidating the device's Bearer token.
 *
 * Usage: CWM_PASSWORD=test123 PORT=3461 node test/device-manager.test.js
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

const PORT = process.env.PORT || 3461;
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
const put = (p, b, h) => request('PUT', p, b, h);
const del = (p, h) => request('DELETE', p, null, h);

/**
 * Safely parse JSON from a response body.
 * @param {Object} r - Response with .body string
 * @returns {Object|null}
 */
function json(r) {
  try { return JSON.parse(r.body); } catch { return null; }
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

/**
 * Pair a new device and return { deviceId, token }.
 * Generates a pairing code, then exchanges it for a device token.
 * @param {string} deviceName - Human-readable device name
 * @param {string} platform - Device platform (ios, android)
 * @returns {Promise<{deviceId: string, token: string}>}
 */
async function pairDevice(deviceName, platform) {
  const codeRes = await get('/api/auth/pairing-code');
  const codeData = json(codeRes);
  if (!codeData?.pairingToken) throw new Error('Failed to generate pairing code');

  const pairRes = await post('/api/auth/pair', {
    pairingToken: codeData.pairingToken,
    deviceName,
    platform,
    appVersion: '1.0.0',
  }, { Authorization: '' });
  const pairData = json(pairRes);
  if (!pairData?.token) throw new Error('Failed to pair device');

  return { deviceId: pairData.deviceId, token: pairData.token };
}

// ─── Tests ──────────────────────────────────────────────────

/**
 * Run the device management test suite against a live server.
 */
async function run() {
  console.log('\n  Device Management API Tests');
  console.log('  ' + '-'.repeat(40));

  // ── Authenticate as admin ──
  const loginRes = await post('/api/auth/login', { password: PASSWORD });
  const loginData = json(loginRes);
  TOKEN = (loginData && loginData.token) || '';
  check('Login succeeds', loginRes.status === 200 && TOKEN.length > 0);

  if (!TOKEN) {
    console.error('\nFATAL: Could not authenticate. Is the server running?');
    process.exit(1);
  }

  // ── Test 1: Empty device list ──
  console.log('\n  --- List Devices ---');

  let r = await get('/api/devices');
  let data = json(r);
  check('GET /api/devices returns 200', r.status === 200);
  check('Returns devices array', Array.isArray(data?.devices));
  // Note: there may be leftover devices from previous tests; we test the shape

  // ── Test 2: Pair a device, then verify it appears in list ──
  console.log('\n  --- Pair and List ---');

  const device1 = await pairDevice('Test Phone', 'ios');
  check('Pair device returns deviceId', typeof device1.deviceId === 'string' && device1.deviceId.length > 0);
  check('Pair device returns token', typeof device1.token === 'string' && device1.token.length > 0);

  r = await get('/api/devices');
  data = json(r);
  const listed = data?.devices?.find(d => d.deviceId === device1.deviceId);
  check('Paired device appears in device list', !!listed);
  check('Listed device has deviceName', listed?.deviceName === 'Test Phone');
  check('Listed device has platform', listed?.platform === 'ios');
  check('Listed device has pairedAt', typeof listed?.pairedAt === 'string');
  check('Listed device has lastSeenAt', typeof listed?.lastSeenAt === 'string');

  // ── Test 3: Token field is NOT in response (security) ──
  check('Token field NOT in list response', listed?.token === undefined);
  check('Listed device has isOnline field', typeof listed?.isOnline === 'boolean');

  // ── Test 4: Get single device ──
  console.log('\n  --- Get Single Device ---');

  r = await get(`/api/devices/${device1.deviceId}`);
  data = json(r);
  check('GET /api/devices/:id returns 200', r.status === 200);
  check('Single device has correct deviceId', data?.deviceId === device1.deviceId);
  check('Single device has isOnline', typeof data?.isOnline === 'boolean');
  check('Single device token is NOT exposed', data?.token === undefined);

  // ── Test 5: Get nonexistent device returns 404 ──
  r = await get('/api/devices/nonexistent-device-id');
  check('GET /api/devices/:nonexistent returns 404', r.status === 404);

  // ── Test 6: Update device name ──
  console.log('\n  --- Update Device ---');

  r = await put(`/api/devices/${device1.deviceId}`, { deviceName: 'Updated Phone' });
  data = json(r);
  check('PUT /api/devices/:id returns 200', r.status === 200);
  check('Updated device has new name', data?.deviceName === 'Updated Phone');
  check('Updated response has isOnline', typeof data?.isOnline === 'boolean');
  check('Updated response token NOT exposed', data?.token === undefined);

  // ── Test 7: Update push preferences ──
  r = await put(`/api/devices/${device1.deviceId}`, {
    pushPreferences: { sessionComplete: false },
  });
  data = json(r);
  check('Push preference update returns 200', r.status === 200);
  check('Push preferences updated', data?.pushPreferences?.sessionComplete === false);

  // ── Test 8: Reject name > 100 chars ──
  const longName = 'A'.repeat(101);
  r = await put(`/api/devices/${device1.deviceId}`, { deviceName: longName });
  check('PUT with name > 100 chars returns 400', r.status === 400);

  // ── Test 9: Delete device (revoke) ──
  console.log('\n  --- Revoke Device ---');

  r = await del(`/api/devices/${device1.deviceId}`);
  data = json(r);
  check('DELETE /api/devices/:id returns 200', r.status === 200);
  check('Delete response has success: true', data?.success === true);

  // ── Test 10: After DELETE, device token is invalid ──
  r = await get('/api/auth/check', { Authorization: `Bearer ${device1.token}` });
  data = json(r);
  check('Revoked device token is invalid', data?.authenticated === false);

  // ── Test 11: After DELETE, device no longer in list ──
  r = await get('/api/devices');
  data = json(r);
  const stillExists = data?.devices?.find(d => d.deviceId === device1.deviceId);
  check('Revoked device no longer in device list', !stillExists);

  // ── Test 12: 401 without auth ──
  console.log('\n  --- Auth Requirements ---');

  r = await get('/api/devices', { Authorization: '' });
  check('GET /api/devices without auth returns 401', r.status === 401);

  r = await get(`/api/devices/some-id`, { Authorization: '' });
  check('GET /api/devices/:id without auth returns 401', r.status === 401);

  r = await put(`/api/devices/some-id`, { deviceName: 'Test' }, { Authorization: '' });
  check('PUT /api/devices/:id without auth returns 401', r.status === 401);

  r = await del(`/api/devices/some-id`, { Authorization: '' });
  check('DELETE /api/devices/:id without auth returns 401', r.status === 401);

  // ── Results ──
  console.log('\n  ' + '-'.repeat(40));
  console.log(`  Device management: ${passed} passed, ${failed} failed`);
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
