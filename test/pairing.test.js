#!/usr/bin/env node
/**
 * Integration tests for the pairing endpoint flow.
 *
 * Tests the two-step QR code pairing:
 *   1. GET /api/auth/pairing-code (generates pairing token)
 *   2. POST /api/auth/pair (exchanges pairing token for Bearer token)
 *
 * Verifies: auth requirements, token lifecycle, expiry, single-use,
 * rate limiting, and response shapes.
 *
 * Usage: CWM_PASSWORD=test123 PORT=3459 node test/pairing.test.js
 */

const http = require('http');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

const PORT = process.env.PORT || 3459;
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
    if (TOKEN && !(customHeaders && 'Authorization' in customHeaders)) headers['Authorization'] = `Bearer ${TOKEN}`;
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
        // Small delay to ensure routes are mounted
        setTimeout(resolve, 500);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      // Suppress stderr noise in tests, but check for fatal errors
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
 * Run the pairing test suite against a live server.
 */
async function run() {
  console.log('\n  Pairing Endpoint Tests');
  console.log('  ' + '-'.repeat(40));

  // ── Authenticate first ──
  const loginRes = await post('/api/auth/login', { password: PASSWORD });
  const loginData = json(loginRes);
  TOKEN = (loginData && loginData.token) || '';
  check('Login succeeds', loginRes.status === 200 && TOKEN.length > 0);

  if (!TOKEN) {
    console.error('\nFATAL: Could not authenticate. Is the server running?');
    process.exit(1);
  }

  // ── GET /api/auth/pairing-code ──
  console.log('\n  --- Pairing Code Generation ---');

  // Send request with no valid auth. Use explicit empty header to override default token.
  let r = await get('/api/auth/pairing-code', { Authorization: '' });
  check('GET /api/auth/pairing-code without auth returns 401', r.status === 401);

  r = await get('/api/auth/pairing-code', { Authorization: 'Bearer bad-token' });
  check('GET /api/auth/pairing-code with bad token returns 401', r.status === 401);

  r = await get('/api/auth/pairing-code');
  const codeData = json(r);
  check('GET /api/auth/pairing-code returns 200', r.status === 200);
  check('Response has pairingToken', typeof codeData?.pairingToken === 'string' && codeData.pairingToken.length > 0);
  check('Response has expiresAt', typeof codeData?.expiresAt === 'string');
  check('Response has qrPayload', typeof codeData?.qrPayload === 'string');

  // Validate QR payload structure
  let qrData = null;
  try { qrData = JSON.parse(codeData.qrPayload); } catch { qrData = null; }
  check('QR payload is valid JSON', qrData !== null);
  check('QR payload has url', typeof qrData?.url === 'string');
  check('QR payload has pairingToken', qrData?.pairingToken === codeData?.pairingToken);
  check('QR payload has serverName', typeof qrData?.serverName === 'string');
  check('QR payload has version', typeof qrData?.version === 'string');

  // ── POST /api/auth/pair ──
  // Note: rate limiter is shared with login (5 per IP per minute).
  // Login used 1 attempt, so we have 4 remaining POST calls before rate limiting.
  // Tests are ordered to maximize coverage within the rate limit budget.
  console.log('\n  --- Token Exchange ---');

  // Invalid token (POST attempt 2 of 5)
  r = await post('/api/auth/pair', { pairingToken: 'not-a-real-token' }, { Authorization: '' });
  check('POST /api/auth/pair with invalid token returns 403', r.status === 403);

  // Valid pairing flow: generate code, then pair (POST attempt 3 of 5)
  r = await get('/api/auth/pairing-code');
  const freshCode = json(r);
  check('Generate fresh pairing code', r.status === 200 && freshCode?.pairingToken);

  r = await post('/api/auth/pair', {
    pairingToken: freshCode.pairingToken,
    deviceName: 'Test Phone',
    platform: 'ios',
  }, { Authorization: '' });
  const pairData = json(r);
  check('POST /api/auth/pair with valid token returns 200', r.status === 200);
  check('Pair response has success=true', pairData?.success === true);
  check('Pair response has token', typeof pairData?.token === 'string' && pairData.token.length > 0);
  check('Pair response has serverName', typeof pairData?.serverName === 'string');
  check('Pair response has serverVersion', typeof pairData?.serverVersion === 'string');

  // Verify the returned token actually works for auth (GET, no rate limit hit)
  if (pairData?.token) {
    r = await get('/api/auth/check', { Authorization: `Bearer ${pairData.token}` });
    const authCheck = json(r);
    check('Paired token is valid for auth', authCheck?.authenticated === true);
  }

  // ── Single-use enforcement ──
  // Generate a new code, use it, then try reusing
  console.log('\n  --- Single-Use Enforcement ---');

  r = await get('/api/auth/pairing-code');
  const singleUseCode = json(r);
  check('Generate pairing code for single-use test', r.status === 200);

  // First use succeeds (POST attempt 4 of 5)
  r = await post('/api/auth/pair', { pairingToken: singleUseCode.pairingToken }, { Authorization: '' });
  check('First use of pairing token succeeds', r.status === 200);

  // Second use fails (POST attempt 5 of 5, still within rate limit)
  r = await post('/api/auth/pair', { pairingToken: singleUseCode.pairingToken }, { Authorization: '' });
  check('Second use of same pairing token returns 403', r.status === 403);

  // ── Rate limiting verification ──
  // The 6th POST should trigger rate limiting
  console.log('\n  --- Rate Limiting ---');

  r = await post('/api/auth/pair', { pairingToken: 'rate-limit-test' }, { Authorization: '' });
  check('POST /api/auth/pair returns 429 after rate limit exceeded', r.status === 429);

  // ── Results ──
  console.log('\n  ' + '-'.repeat(40));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
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
