#!/usr/bin/env node
/**
 * User-space workbook watchdog.
 *
 * Polls http://127.0.0.1:3457 every 10 seconds. If the workbook stops
 * answering, spawns a replacement via the installed npm package
 * (matches the user's manual launch shape: node node_modules/myrlin-workbook/src/gui.js).
 * The new workbook inherits PORT=3457 from this script's env.
 *
 * Why this exists: the alpha.5 Scheduled Task fires only at boot (and
 * needs admin to reconfigure mid-session). This watchdog gives
 * kill-and-recover safety in user-space, no UAC required. If the
 * workbook process is killed manually or crashes for any reason,
 * the watchdog notices within 10s and respawns it.
 *
 * Run detached (so it survives the launching shell):
 *   Windows:   start /b "" node scripts/watchdog.js > logs/watchdog.log 2>&1
 *   POSIX:     nohup node scripts/watchdog.js > logs/watchdog.log 2>&1 &
 *
 * Stop:
 *   pkill -f scripts/watchdog.js     (POSIX)
 *   taskkill /F /FI "WINDOWTITLE eq watchdog*"    (Windows, adjust)
 *
 * Idempotent: if a workbook is already serving on 3457, the watchdog
 * does nothing. Multiple watchdog instances are safe (they all check
 * the same port and only one will spawn a replacement at a time;
 * worst case is a brief duplicate-spawn that resolves to EADDRINUSE
 * for the loser).
 *
 * Restart cap: if the watchdog has spawned > 6 replacements in the
 * past 5 minutes, it backs off to one attempt per 5 minutes to avoid
 * pinning the CPU on a wedged config.
 */

'use strict';

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.env.WORKBOOK_PORT, 10) || 3457;
const POLL_MS = 10_000;
const SPAWN_TIMEOUT_MS = 4_000;
// Consecutive missed HTTP probes required before we treat the workbook as
// truly down. A single miss is almost always a briefly-blocked event loop
// (heavy search, git status/fetch sweep across many workspaces, transient
// machine load), NOT a dead process. Requiring several consecutive misses,
// combined with the TCP port-bound gate below, stops the watchdog from
// spawning duplicate workbooks that then cannot bind PORT and linger as
// inert zombies (the multiple-gui.js incident on 2026-07-02).
const FAILS_BEFORE_SPAWN = 3;
// Timeout for the raw TCP liveness gate. A completed TCP handshake proves a
// listening socket exists (the OS kernel accepts the connection even when the
// Node event loop is blocked), which distinguishes "alive but busy" from
// "process actually gone / port free".
const PORT_CHECK_TIMEOUT_MS = 2_000;
const RESTART_HISTORY = []; // timestamps of recent respawns
const RESTART_WINDOW_MS = 5 * 60_000;
const RESTART_BURST_LIMIT = 6;
const BACKOFF_MS = 5 * 60_000;

const repoRoot = path.resolve(__dirname, '..');
const npmGuiPath = path.join(repoRoot, 'node_modules', 'myrlin-workbook', 'src', 'gui.js');
const localGuiPath = path.join(repoRoot, 'src', 'gui.js');
// Prefer the locally-installed npm package (matches user's manual shape).
// Fall back to the project's own src/gui.js if the npm copy is missing.
const guiScript = fs.existsSync(npmGuiPath) ? npmGuiPath : localGuiPath;

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[watchdog ${ts}] ${msg}\n`);
}

/**
 * Resolve a Promise to true if the workbook answers on PORT within
 * SPAWN_TIMEOUT_MS. Treats any HTTP response (even 302/4xx) as alive;
 * connection refused / timeout / DNS error counts as dead.
 */
function probe() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/',
      method: 'HEAD',
      timeout: SPAWN_TIMEOUT_MS,
    }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Resolve true if something is bound and listening on PORT, false otherwise.
 *
 * Why a raw TCP connect and not the HTTP probe: the OS kernel completes the
 * TCP handshake for a listening socket even when the owning Node process has
 * a blocked event loop and never calls accept(). So a successful connect is a
 * reliable "the workbook process is alive and holding the port" signal, while
 * ECONNREFUSED means nothing is listening (the port is genuinely free). This
 * is the final gate that prevents spawning a duplicate against a workbook that
 * is merely busy rather than dead.
 */
function isPortBound() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (bound) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) { /* already closed */ }
      resolve(bound);
    };
    const sock = net.connect({ host: '127.0.0.1', port: PORT });
    sock.setTimeout(PORT_CHECK_TIMEOUT_MS);
    sock.on('connect', () => finish(true));   // a listener accepted us
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));     // ECONNREFUSED => port is free
  });
}

/**
 * Spawn a replacement workbook detached + unref'd so the watchdog
 * doesn't accumulate child references. The replacement inherits
 * PORT=<PORT> so it binds to the same port the tunnel routes to.
 */
function spawnWorkbook() {
  const now = Date.now();
  // Restart-burst back-off: drop oldest entries outside the window
  // first, then check the cap.
  while (RESTART_HISTORY.length && RESTART_HISTORY[0] < now - RESTART_WINDOW_MS) {
    RESTART_HISTORY.shift();
  }
  if (RESTART_HISTORY.length >= RESTART_BURST_LIMIT) {
    log(`backing off, ${RESTART_HISTORY.length} restarts in last ${RESTART_WINDOW_MS / 60000}min; next attempt in ${BACKOFF_MS / 60000}min`);
    return BACKOFF_MS;
  }
  RESTART_HISTORY.push(now);
  log(`spawning replacement: node "${guiScript}" (PORT=${PORT})`);
  const child = spawn(process.execPath, [guiScript], {
    detached: true,
    stdio: 'ignore',
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT), CWM_NO_OPEN: '1' },
    windowsHide: true,
  });
  child.unref();
  return POLL_MS;
}

let nextDelay = POLL_MS;
// Count of consecutive failed HTTP probes. Reset to 0 on any success or when
// the TCP gate proves the workbook is alive-but-busy. Only when this reaches
// FAILS_BEFORE_SPAWN AND the port is confirmed free do we spawn a replacement.
let consecutiveFails = 0;

async function tick() {
  const alive = await probe();
  if (alive) {
    // Healthy. Reset the miss counter and the back-off counter (the latter
    // implicitly, via the cleanup pass at the top of spawnWorkbook).
    consecutiveFails = 0;
    nextDelay = POLL_MS;
  } else {
    consecutiveFails += 1;
    log(`workbook not responding on ${PORT} (miss ${consecutiveFails}/${FAILS_BEFORE_SPAWN})`);
    if (consecutiveFails < FAILS_BEFORE_SPAWN) {
      // Not enough consecutive misses yet; a briefly-blocked event loop
      // recovers on its own. Keep polling, do not spawn.
      nextDelay = POLL_MS;
    } else {
      // Enough misses to suspect death. Final gate: if the port is still
      // bound, the workbook is alive but busy (event loop blocked), so we
      // must NOT spawn a duplicate that would only fail to bind and linger.
      const bound = await isPortBound();
      if (bound) {
        log(`port ${PORT} still bound; workbook is alive but busy, not spawning`);
        consecutiveFails = 0;
        nextDelay = POLL_MS;
      } else {
        log(`workbook confirmed down (${consecutiveFails} misses, port free); spawning replacement`);
        consecutiveFails = 0;
        nextDelay = spawnWorkbook();
      }
    }
  }
  setTimeout(tick, nextDelay);
}

log(`watchdog up. polling http://127.0.0.1:${PORT} every ${POLL_MS / 1000}s. gui script: ${guiScript}`);
tick();

process.on('SIGINT', () => { log('SIGINT received; exiting'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM received; exiting'); process.exit(0); });
