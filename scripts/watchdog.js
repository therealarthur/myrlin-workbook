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
 *   taskkill /F /FI "WINDOWTITLE eq watchdog*"    (Windows — adjust)
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
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.env.WORKBOOK_PORT, 10) || 3457;
const POLL_MS = 10_000;
const SPAWN_TIMEOUT_MS = 4_000;
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
    log(`backing off — ${RESTART_HISTORY.length} restarts in last ${RESTART_WINDOW_MS / 60000}min; next attempt in ${BACKOFF_MS / 60000}min`);
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

async function tick() {
  const alive = await probe();
  if (alive) {
    // Healthy. Reset back-off counter implicitly via the cleanup
    // pass at the top of spawnWorkbook (no respawn = no entry).
    nextDelay = POLL_MS;
  } else {
    log(`workbook not responding on ${PORT}; spawning replacement`);
    nextDelay = spawnWorkbook();
  }
  setTimeout(tick, nextDelay);
}

log(`watchdog up. polling http://127.0.0.1:${PORT} every ${POLL_MS / 1000}s. gui script: ${guiScript}`);
tick();

process.on('SIGINT', () => { log('SIGINT received; exiting'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM received; exiting'); process.exit(0); });
