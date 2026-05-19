#!/usr/bin/env node
/**
 * Process supervisor for Claude Workspace Manager GUI.
 *
 * Spawns src/gui.js as a child process and automatically restarts it
 * if it exits unexpectedly. Graceful shutdown via Ctrl+C or SIGTERM
 * stops the restart loop and tears down the child cleanly.
 *
 * --daemon mode: spawns the supervisor as a fully detached background
 * process that survives parent shell death. Output goes to logs/server.log.
 * This is the recommended way to start the server from scripts and CLI.
 *
 * Usage:
 *   node src/supervisor.js [--demo] [--cdp] [--daemon]
 *
 * All CLI flags (except --daemon) are forwarded to gui.js.
 *
 * Environment:
 *   CWM_RESTART_DELAY=2000   Delay (ms) before restart after crash (default 2000)
 *   CWM_MAX_RESTARTS=20      Max consecutive restarts before giving up (default 20)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Daemon mode: re-spawn self as detached process ──────
// On Windows, bash's `&` does NOT detach the process tree.
// When the parent shell exits, all children die. --daemon solves
// this by re-spawning the supervisor with stdio redirected to a
// log file and the process fully detached from the parent.
if (process.argv.includes('--daemon')) {
  const logDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'server.log');
  const pidFile = path.join(logDir, 'server.pid');

  // Strip --daemon from args so the child runs in foreground (supervised) mode
  const childArgs = process.argv.slice(2).filter(a => a !== '--daemon');
  const nodeExe = process.execPath;
  const scriptArgs = [__filename, ...childArgs].map(a => `"${a}"`).join(' ');

  if (process.platform === 'win32') {
    // On Windows, Node's detached:true still inherits the console session's
    // Job Object. When the parent shell (Git Bash, cmd, Claude Code) exits,
    // Windows kills the entire job group. Use cmd.exe /c start to create a
    // process in a completely new console session, then redirect its output.
    const { execSync } = require('child_process');
    const cmd = `cmd.exe /c start /b "" "${nodeExe}" --max-old-space-size=4096 ${scriptArgs} >> "${logFile}" 2>&1`;
    execSync(cmd, { stdio: 'ignore', windowsHide: true });

    // The PID isn't directly available from start /b. Write a marker so we
    // can find it via tasklist. Wait briefly for the process to appear.
    setTimeout(() => {
      try {
        const { execSync: es } = require('child_process');
        const psCmd = `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*supervisor.js*' -and $_.CommandLine -notlike '*--daemon*' } | Select-Object -ExpandProperty ProcessId"`;
        const out = es(psCmd, { encoding: 'utf8', timeout: 10000 });
        const pids = out.trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (pids.length > 0) {
          const pid = pids[pids.length - 1];
          fs.writeFileSync(pidFile, pid, 'utf8');
          console.log(`[supervisor] Daemonized server (PID ${pid}), logs at ${logFile}`);
        } else {
          console.log(`[supervisor] Daemonized server, logs at ${logFile}`);
        }
      } catch (_) {
        console.log(`[supervisor] Daemonized server, logs at ${logFile}`);
      }
      process.exit(0);
    }, 2000);
  } else {
    // Unix: standard detach with file descriptors
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');
    const child = spawn(nodeExe, ['--max-old-space-size=4096', __filename, ...childArgs], {
      stdio: ['ignore', out, err],
      detached: true,
      env: { ...process.env },
    });
    fs.writeFileSync(pidFile, String(child.pid), 'utf8');
    child.unref();
    console.log(`[supervisor] Daemonized server (PID ${child.pid}), logs at ${logFile}`);
    process.exit(0);
  }
  return; // Guard: don't fall through to supervisor logic while waiting
}

// ─── EPIPE Protection ────────────────────────────────────
// Supervisor can outlive its parent shell; guard against broken pipe.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const { logCrash } = require('./crash-logger');

// Forward all CLI args after supervisor.js to gui.js
const guiArgs = process.argv.slice(2);
const guiScript = path.join(__dirname, 'gui.js');

const RESTART_DELAY = parseInt(process.env.CWM_RESTART_DELAY, 10) || 2000;
// Default raised from 20 to Infinity (alpha.5) so an unattended autostart
// session (Windows Task Scheduler at system boot) never gives up restarting
// after a transient hiccup. Hard cap still settable via CWM_MAX_RESTARTS for
// debug runs that want to fail loud.
const MAX_RESTARTS = (() => {
  const env = parseInt(process.env.CWM_MAX_RESTARTS, 10);
  return Number.isFinite(env) && env > 0 ? env : Infinity;
})();
// Crash-loop back-off: after this many consecutive fast-fails, escalate the
// retry delay so a bad config doesn't peg the CPU. Caps the back-off so the
// supervisor still recovers when the underlying cause clears (e.g., the
// port was busy, then freed).
const BACKOFF_AFTER = 5;       // consecutive fast restarts before backing off
const BACKOFF_MAX_DELAY = 60000; // 60s ceiling on the back-off delay
// Reset the consecutive restart counter after this many ms of stable uptime
const STABLE_THRESHOLD = 30000; // 30 seconds

// Hard-stop guard against sub-second crash loops.
// On 2026-05-11 the server crash-looped 10 times in 75s, calling
// store.createTimestampedBackup() on each startup and EVICTING all clean
// timestamped backups from ~/.myrlin/backups/. After SUBSECOND_THRESHOLD_MS
// uptime on N consecutive restarts, write a review-lock file and refuse to
// auto-restart. The lock must be removed manually before the supervisor
// will retry, giving you a chance to inspect state/backups first.
const SUBSECOND_THRESHOLD_MS = 1500;
const MAX_SUBSECOND_CRASHES = parseInt(process.env.CWM_MAX_SUBSECOND_CRASHES, 10) || 5;
const REVIEW_LOCK = path.join(__dirname, '..', 'logs', 'needs-manual-review.lock');

// Refuse to start if a previous run left a review lockfile in place.
if (fs.existsSync(REVIEW_LOCK)) {
  try {
    const body = fs.readFileSync(REVIEW_LOCK, 'utf8');
    console.error('[supervisor] HALTED: ' + REVIEW_LOCK + ' exists.');
    console.error(body);
    console.error('[supervisor] Inspect state and backups, then delete the lockfile to resume.');
  } catch (_) {
    console.error('[supervisor] HALTED: ' + REVIEW_LOCK + ' exists. Remove it to resume.');
  }
  process.exit(2);
}

let child = null;
let shuttingDown = false;
let consecutiveRestarts = 0;
let subsecondCrashes = 0;
let lastStartTime = 0;

/**
 * Start the GUI server as a child process.
 * Inherits stdio so the user sees all output inline.
 */
function startChild() {
  lastStartTime = Date.now();
  console.log(`[supervisor] Starting GUI server (attempt ${consecutiveRestarts + 1})...`);

  child = spawn(process.execPath, ['--max-old-space-size=4096', guiScript, ...guiArgs], {
    stdio: 'inherit',
    env: { ...process.env, CWM_NO_OPEN: consecutiveRestarts > 0 ? '1' : '' },
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (shuttingDown) {
      console.log('[supervisor] Graceful shutdown complete.');
      process.exit(0);
      return;
    }

    // If the process ran for a while before dying, reset the counter
    const uptime = Date.now() - lastStartTime;
    if (uptime > STABLE_THRESHOLD) {
      consecutiveRestarts = 0;
      subsecondCrashes = 0;
    }

    // Sub-second-crash tracking: a process that exits this fast almost
    // certainly hit something during startup (bad config, corrupt state,
    // missing dep). Each startup writes a timestamped backup, so allowing
    // unlimited fast-restarts is what evicted clean backups during the
    // 2026-05-11 incident. Hard-stop after MAX_SUBSECOND_CRASHES.
    if (uptime < SUBSECOND_THRESHOLD_MS) {
      subsecondCrashes++;
    } else {
      subsecondCrashes = 0;
    }
    if (subsecondCrashes >= MAX_SUBSECOND_CRASHES) {
      const msg = '[supervisor] ' + subsecondCrashes + ' consecutive sub-' + SUBSECOND_THRESHOLD_MS
        + 'ms crashes — refusing to restart. Likely a bad config or corrupt state. '
        + 'Inspect ~/.myrlin/ and logs/crash.log, then delete ' + REVIEW_LOCK + ' to resume.';
      try {
        fs.writeFileSync(REVIEW_LOCK,
          msg + '\nWritten at: ' + new Date().toISOString()
          + '\nLast exit: ' + (signal ? 'signal ' + signal : 'exit code ' + code)
          + '\nUptimes (recent): see logs/crash.log\n', 'utf8');
      } catch (_) {}
      logCrash('supervisor', 'HALTED: sub-second crash loop hit hard-stop', {
        subsecondCrashes,
        threshold: SUBSECOND_THRESHOLD_MS,
        max: MAX_SUBSECOND_CRASHES,
      });
      try { console.error(msg); } catch (_) {}
      process.exit(3);
      return;
    }

    consecutiveRestarts++;

    if (consecutiveRestarts > MAX_RESTARTS) {
    logCrash('supervisor', `Server crashed ${MAX_RESTARTS} times consecutively, giving up`, {
        consecutiveRestarts,
      });
      try { console.error(`[supervisor] Server crashed ${MAX_RESTARTS} times consecutively. Giving up.`); } catch (_) {}
      process.exit(1);
      return;
    }

    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    // Exponential back-off when crashes happen in quick succession so a
    // wedged dependency (e.g., port 3456 held by a zombie) doesn't burn
    // CPU spinning at 2s intervals. Resets to RESTART_DELAY after a
    // stable run (STABLE_THRESHOLD reset above).
    let delay = RESTART_DELAY;
    if (consecutiveRestarts > BACKOFF_AFTER) {
      const excess = consecutiveRestarts - BACKOFF_AFTER;
      delay = Math.min(BACKOFF_MAX_DELAY, RESTART_DELAY * Math.pow(2, excess));
    }
    logCrash('supervisor', `Server exited (${reason}), restart #${consecutiveRestarts}`, {
      exitCode: code,
      signal,
      uptimeMs: uptime,
      consecutiveRestarts,
      delayMs: delay,
    });
    try { console.log(`[supervisor] Server exited (${reason}). Restarting in ${delay}ms (attempt ${consecutiveRestarts})...`); } catch (_) {}

    setTimeout(startChild, delay);
  });

  child.on('error', (err) => {
    logCrash('supervisor', `Failed to start server: ${err.message}`, err);
    try { console.error(`[supervisor] Failed to start server: ${err.message}`); } catch (_) {}
    child = null;

    if (!shuttingDown) {
      consecutiveRestarts++;
      if (consecutiveRestarts <= MAX_RESTARTS) {
        setTimeout(startChild, RESTART_DELAY);
      } else {
        try { console.error(`[supervisor] Too many failures. Exiting.`); } catch (_) {}
        process.exit(1);
      }
    }
  });
}

/**
 * Graceful shutdown: signal the child to stop and don't restart it.
 */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { console.log('\n[supervisor] Shutting down...'); } catch (_) {}

  if (child) {
    // Send SIGINT so gui.js runs its graceful shutdown handler
    child.kill('SIGINT');

    // Force kill after 5 seconds if it hasn't exited
    const forceTimer = setTimeout(() => {
      if (child) {
        try { console.log('[supervisor] Force killing server...'); } catch (_) {}
        child.kill('SIGKILL');
      }
    }, 5000);
    forceTimer.unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
startChild();
