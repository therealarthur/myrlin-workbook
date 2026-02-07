/**
 * Authentication module for Claude Workspace Manager Web API.
 * Uses a simple in-memory token approach with Bearer token auth.
 *
 * - POST /api/auth/login  - Validates password, returns a Bearer token
 * - POST /api/auth/logout - Invalidates the token
 * - GET  /api/auth/check  - Validates current token
 *
 * Protected routes use the requireAuth middleware which checks
 * the Authorization: Bearer <token> header.
 *
 * Password is loaded from (in priority order):
 *   1. CWM_PASSWORD environment variable
 *   2. state/config.json file
 *   3. Auto-generated on first run (saved to state/config.json)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Configuration ─────────────────────────────────────────
const TOKEN_BYTE_LENGTH = 32;
const CONFIG_DIR = path.join(__dirname, '..', '..', 'state');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ─── Rate Limiting ─────────────────────────────────────────
// Simple in-memory rate limiter: max 5 login attempts per IP per 60 seconds
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const loginAttempts = new Map(); // IP -> { count, resetAt }

/**
 * Check if a login attempt from this IP should be rate-limited.
 * @param {string} ip - Client IP address
 * @returns {boolean} true if rate limited (should reject)
 */
function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now > entry.resetAt) {
    // Window expired or new IP — start fresh
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
    return false;
  }

  entry.count++;
  if (entry.count > LOGIN_RATE_LIMIT) {
    return true;
  }
  return false;
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) {
      loginAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

// ─── Password Management ──────────────────────────────────

/**
 * Load or generate the auth password.
 * Priority: env var > config file > auto-generate.
 * @returns {string}
 */
function loadPassword() {
  // 1. Environment variable
  if (process.env.CWM_PASSWORD) {
    return process.env.CWM_PASSWORD;
  }

  // 2. Config file
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (config.password && typeof config.password === 'string') {
        return config.password;
      }
    }
  } catch (_) {
    // Corrupted config — regenerate
  }

  // 3. Auto-generate and save
  const generated = crypto.randomBytes(16).toString('base64url');
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const config = {};
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
      }
    } catch (_) {}
    config.password = generated;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[AUTH] Failed to save generated password to config:', err.message);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  CWM auto-generated password: ' + generated);
  console.log('  Saved to: state/config.json');
  console.log('  Set CWM_PASSWORD env var to override.');
  console.log('══════════════════════════════════════════════════');
  console.log('');

  return generated;
}

const AUTH_PASSWORD = loadPassword();

// In-memory set of valid tokens. Tokens survive for the lifetime of
// the server process. A restart invalidates all tokens (acceptable
// for a local dev-tool).
const activeTokens = new Set();

// ─── Helpers ───────────────────────────────────────────────

/**
 * Generate a cryptographically random hex token.
 * @returns {string} 64-character hex string
 */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
}

/**
 * Extract the Bearer token from an Authorization header value.
 * Returns null if the header is missing or malformed.
 * @param {string|undefined} headerValue - The raw Authorization header
 * @returns {string|null}
 */
function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const parts = headerValue.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

// ─── Middleware ─────────────────────────────────────────────

/**
 * Express middleware that requires a valid Bearer token.
 * Responds with 401 if the token is missing or invalid.
 */
function requireAuth(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid Bearer token required. POST /api/auth/login to authenticate.',
    });
  }

  // Attach token to request for downstream use (e.g. logout)
  req.authToken = token;
  next();
}

// ─── Route Setup ───────────────────────────────────────────

/**
 * Mount authentication routes on the Express app.
 * These routes are NOT protected by requireAuth — they are public.
 *
 * @param {import('express').Express} app - The Express application
 */
function setupAuth(app) {
  /**
   * POST /api/auth/login
   * Body: { password: string }
   * Returns: { success: true, token: string } or { success: false, error: string }
   */
  app.post('/api/auth/login', (req, res) => {
    // Rate limiting
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
      return res.status(429).json({
        success: false,
        error: 'Too many login attempts. Try again in 1 minute.',
      });
    }

    const { password } = req.body || {};

    if (!password || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid password field in request body.',
      });
    }

    // Constant-time comparison to mitigate timing attacks
    const passwordBuffer = Buffer.from(password, 'utf-8');
    const expectedBuffer = Buffer.from(AUTH_PASSWORD, 'utf-8');
    const isValid =
      passwordBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(passwordBuffer, expectedBuffer);

    if (!isValid) {
      return res.status(403).json({
        success: false,
        error: 'Invalid password.',
      });
    }

    const token = generateToken();
    activeTokens.add(token);

    return res.json({ success: true, token });
  });

  /**
   * POST /api/auth/logout
   * Requires Authorization: Bearer <token>
   * Removes the token from the active set.
   */
  app.post('/api/auth/logout', (req, res) => {
    const token = extractBearerToken(req.headers.authorization);

    if (token) {
      activeTokens.delete(token);
    }

    return res.json({ success: true });
  });

  /**
   * GET /api/auth/check
   * Returns whether the provided Bearer token is still valid.
   */
  app.get('/api/auth/check', (req, res) => {
    const token = extractBearerToken(req.headers.authorization);
    const authenticated = !!token && activeTokens.has(token);

    return res.json({ authenticated });
  });
}

/**
 * Check if a raw token string is valid (exists in activeTokens).
 * Used by SSE endpoint which can't use requireAuth middleware.
 * @param {string} token - The raw token string
 * @returns {boolean}
 */
function isValidToken(token) {
  return !!token && activeTokens.has(token);
}

// ─── Exports ───────────────────────────────────────────────

module.exports = {
  setupAuth,
  requireAuth,
  isValidToken,
};
