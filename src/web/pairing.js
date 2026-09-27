/**
 * Pairing module for mobile device authentication.
 *
 * Implements a two-step QR code pairing flow:
 *   1. GET /api/auth/pairing-code (auth required) - generates a short-lived pairing token
 *   2. POST /api/auth/pair (public, rate-limited) - exchanges pairing token for Bearer token
 *
 * Pairing tokens are single-use, expire after 5 minutes, and stored in memory.
 * The QR payload contains the server URL, pairing token, server name, and version.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');

// ─── Configuration ─────────────────────────────────────────

/** How long a pairing token remains valid (5 minutes) */
const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Byte length for pairing tokens (32 bytes = 64 hex characters) */
const PAIRING_TOKEN_BYTES = 32;

/** In-memory store for active pairing tokens. Map of token -> { createdAt, used } */
const pairingTokens = new Map();

// Clean up expired or used pairing tokens every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pairingTokens) {
    if (entry.used || now - entry.createdAt > PAIRING_TTL_MS) {
      pairingTokens.delete(token);
    }
  }
}, 2 * 60 * 1000).unref();

// ─── URL Detection Helpers ─────────────────────────────────

/**
 * Detect the first non-internal LAN IPv4 address and return an HTTP URL.
 * Skips loopback (127.x) and Tailscale CGNAT (100.x) addresses.
 * @param {number} port - The server port
 * @returns {string|null} URL like http://192.168.1.5:3456, or null if none found
 */
function detectLanIP(port) {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Skip Tailscale CGNAT range (100.64.0.0/10 per RFC 6598)
        if (iface.address.startsWith('100.')) continue;
        return `http://${iface.address}:${port}`;
      }
    }
  }
  return null;
}

/**
 * Detect a Tailscale IPv4 address (100.x.x.x CGNAT range) and return an HTTP URL.
 * @param {number} port - The server port
 * @returns {string|null} URL like http://100.64.22.118:3456, or null if not on Tailscale
 */
function detectTailscaleIP(port) {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('100.')) {
        return `http://${iface.address}:${port}`;
      }
    }
  }
  return null;
}

/**
 * Detect all available connection URLs for the server.
 * Returns an object with local, LAN, Tailscale, tunnel, and custom URLs.
 * @param {number} port - The server port
 * @param {Object} store - Store instance (or object with state.settings)
 * @returns {{ local: string, lan: string|null, tailscale: string|null, tunnel: string|null, custom: string|null }}
 */
function detectAllUrls(port, store) {
  const settings = (store && store.state && store.state.settings) || {};
  return {
    local: `http://localhost:${port}`,
    lan: detectLanIP(port),
    tailscale: detectTailscaleIP(port),
    tunnel: settings.tunnelUrl || null,
    custom: settings.externalUrl || null,
  };
}

// ─── Route Setup ───────────────────────────────────────────

/**
 * Read the server name and version from package.json.
 * @returns {{ name: string, version: string }}
 */
function getServerInfo() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    return { name: pkg.name || 'myrlin-workbook', version: pkg.version || '0.0.0' };
  } catch (_) {
    return { name: 'myrlin-workbook', version: '0.0.0' };
  }
}

/**
 * Mount pairing routes on the Express app.
 *
 * @param {import('express').Express} app - The Express application
 * @param {Object} deps - Injected dependencies from auth module
 * @param {Function} deps.requireAuth - Express middleware for Bearer token auth
 * @param {Function} deps.addToken - Registers a new token in the active set
 * @param {Function} deps.generateToken - Creates a cryptographically random hex token
 * @param {Function} deps.isRateLimited - Checks if an IP is rate-limited
 */
function setupPairing(app, { requireAuth, addToken, generateToken, isRateLimited, getStore }) {
  const serverInfo = getServerInfo();

  /**
   * Mobile v2 (A4, critic F20, BUILD-CONTRACT S11): the v1 pair routes stay in
   * the code but answer 410 LEGACY_PAIR_DISABLED unless the setting
   * mobile.legacyPairEnabled is true, because v1 tokens carry full desktop
   * privilege. Returns true when the request was answered.
   *
   * @param {object} res - Express response.
   * @returns {boolean}
   */
  function refuseWhenLegacyOff(res) {
    let enabled = false;
    try {
      const store = getStore ? getStore() : null;
      const mobile = store && store.settings && store.settings.mobile;
      enabled = !!(mobile && mobile.legacyPairEnabled === true);
    } catch (_) {
      enabled = false;
    }
    if (enabled) return false;
    res.status(410).json({
      error: 'Pairing moved to the Myrlin app. Update the app and scan again.',
      code: 'LEGACY_PAIR_DISABLED',
    });
    return true;
  }

  /**
   * GET /api/auth/pairing-code
   * Requires Bearer auth. Generates a short-lived pairing token and
   * returns a QR payload that the mobile app scans.
   *
   * Query params:
   *   url (optional) - Override the server URL in the QR payload
   *
   * Response: { pairingToken, expiresAt, qrPayload }
   */
  app.get('/api/auth/pairing-code', requireAuth, (req, res) => {
    if (refuseWhenLegacyOff(res)) return undefined;
    const pairingToken = crypto.randomBytes(PAIRING_TOKEN_BYTES).toString('hex');

    pairingTokens.set(pairingToken, {
      createdAt: Date.now(),
      used: false,
    });

    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    const port = req.socket.localPort || 3456;
    const store = getStore ? getStore() : { state: { settings: {} } };
    const urls = detectAllUrls(port, store);

    // Primary URL preference: custom > tunnel > lan > local
    const primaryUrl = req.query.url || urls.custom || urls.tunnel || urls.lan || urls.local;

    const qrPayload = JSON.stringify({
      url: primaryUrl,
      urls,
      primaryUrl,
      pairingToken,
      serverName: serverInfo.name,
      version: serverInfo.version,
    });

    return res.json({ pairingToken, expiresAt, qrPayload });
  });

  /**
   * POST /api/auth/pair
   * Public endpoint (no auth required). Rate-limited.
   * Exchanges a valid pairing token for a long-lived Bearer token.
   *
   * Body: { pairingToken, deviceName?, platform? }
   * Response: { success: true, token, serverName, serverVersion }
   */
  app.post('/api/auth/pair', (req, res) => {
    if (refuseWhenLegacyOff(res)) return undefined;
    // Rate limiting. W1 fix: isRateLimited returns {limited, retryAfter}
    // (auth.js:45-61); the object itself is always truthy, so read .limited.
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const rate = isRateLimited(clientIp);
    if (rate && rate.limited) {
      res.setHeader('Retry-After', String(Math.max(1, rate.retryAfter || 60)));
      return res.status(429).json({
        success: false,
        error: 'Too many pairing attempts. Try again in 1 minute.',
      });
    }

    const { pairingToken } = req.body || {};

    if (!pairingToken || typeof pairingToken !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid pairingToken field in request body.',
      });
    }

    const entry = pairingTokens.get(pairingToken);

    // Token not found
    if (!entry) {
      return res.status(403).json({
        success: false,
        error: 'Invalid pairing token.',
      });
    }

    // Token already used
    if (entry.used) {
      pairingTokens.delete(pairingToken);
      return res.status(403).json({
        success: false,
        error: 'Pairing token has already been used.',
      });
    }

    // Token expired
    if (Date.now() - entry.createdAt > PAIRING_TTL_MS) {
      pairingTokens.delete(pairingToken);
      return res.status(403).json({
        success: false,
        error: 'Pairing token has expired.',
      });
    }

    // Consume the token (single-use)
    pairingTokens.delete(pairingToken);

    // Generate a long-lived Bearer token and register it
    const token = generateToken();
    addToken(token);

    // Extract device metadata from request body
    const { deviceName, platform, appVersion } = req.body || {};
    const deviceId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    // Build device record and persist via store
    const deviceRecord = {
      deviceId,
      token,
      deviceName: deviceName || 'Unknown Device',
      platform: platform || 'unknown',
      appVersion: appVersion || '0.0.0',
      pairedAt: now,
      lastSeenAt: now,
      expiresAt,
      pushToken: null,
      pushPreferences: {
        sessionComplete: true,
        sessionNeedsInput: true,
        fileConflicts: true,
        taskReview: true,
        serverOnline: false,
      },
    };

    // Persist device to store (survives server restart)
    if (getStore) {
      try {
        getStore().addPairedDevice(deviceRecord);
      } catch (err) {
        console.error('[Pairing] Failed to persist device record:', err.message);
      }
    }

    return res.json({
      success: true,
      token,
      deviceId,
      serverName: serverInfo.name,
      serverVersion: serverInfo.version,
      capabilities: {
        push: true,
        sse: true,
        terminal: true,
        search: true,
        costTracking: true,
        aiSearch: !!process.env.ANTHROPIC_API_KEY,
      },
    });
  });
}

// ─── Exports ───────────────────────────────────────────────

module.exports = {
  setupPairing,
  detectAllUrls,
  _pairingTokens: pairingTokens,
  _PAIRING_TTL_MS: PAIRING_TTL_MS,
};
