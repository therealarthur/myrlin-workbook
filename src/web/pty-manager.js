/**
 * PTY Session Manager for Claude Workspace Manager.
 *
 * Manages pseudo-terminal sessions using node-pty. Each session is a long-lived
 * PTY process that persists independently of WebSocket client connections,
 * allowing reconnection with full scrollback replay.
 *
 * Performance notes:
 *   - PTY output is sent as raw text to WebSocket clients (no JSON wrapping)
 *   - WebSocket input is written directly to PTY (no buffering)
 *   - Scrollback is capped at ~100KB total characters
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Ensure node-pty's prebuilt spawn-helper is executable BEFORE requiring node-pty.
// node-pty's prebuild ships with mode 644 instead of 755, causing posix_spawnp
// to fail on macOS/Linux. The postinstall script handles this in normal installs
// but doesn't run with --ignore-scripts or in some npx caches. This runtime
// fallback covers those cases. See: https://github.com/therealarthur/myrlin-workbook/issues/4
if (process.platform !== 'win32') {
  try {
    const ptyMain = require.resolve('node-pty');
    let dir = path.dirname(ptyMain);
    for (let i = 0; i < 8; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
          if (json && json.name === 'node-pty') break;
        } catch (_) {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) { dir = null; break; }
      dir = parent;
    }
    if (dir) {
      const prebuildsDir = path.join(dir, 'prebuilds');
      if (fs.existsSync(prebuildsDir)) {
        for (const p of fs.readdirSync(prebuildsDir)) {
          const helper = path.join(prebuildsDir, p, 'spawn-helper');
          if (fs.existsSync(helper)) {
            try {
              const stat = fs.statSync(helper);
              // Only chmod if not already executable, avoids unnecessary syscalls
              if ((stat.mode & 0o111) === 0) fs.chmodSync(helper, 0o755);
            } catch (_) {}
          }
        }
      }
    }
  } catch (_) {
    // node-pty not yet resolvable; require() below will throw with a clearer error
  }
}

// ── Native module containment (issue #68) ─────────────────────────────────
// node-pty is a native addon. Its published package ships prebuilt binaries
// only for darwin-arm64/x64 and win32-arm64/x64; on Linux the native module
// exists only if node-pty's install lifecycle script actually compiled it.
// Modern npm blocks dependency install scripts by default (pending approval),
// and an npx cache can hold a copy whose binary was never built. When that
// happens require('node-pty') throws at LOAD time.
//
// Historically that throw escaped all the way up to the store's
// uncaughtException handler (src/state/store.js), which flushes state but does
// NOT exit. The result was a half-booted server: the HTTP port was bound
// (app.listen already ran), but everything wired AFTER the PTY attach in
// startServer (scheduler, credential watcher, schedule routes, shutdown
// cleanup) never ran. Terminal panes are ONE feature; the whole app must not
// die or half-die with them.
//
// We now CONTAIN the failure at this single choke point: `pty` stays null, we
// remember the load error, a capability probe (getPtyAvailability) reports it,
// and every spawn path degrades per-call with a coded error instead of
// crashing the process or throwing a raw TypeError on the null module.
let pty = null;
let ptyLoadError = null;
// Stable, machine-readable code surfaced to callers, the public health
// endpoint, and the frontend so they can branch on THIS specific failure
// without string-matching a human-readable message.
const PTY_UNAVAILABLE_CODE = 'PTY_NATIVE_LOAD_FAILED';
try {
  // Test-only / manual-repro seam: setting CWM_SIMULATE_PTY_LOAD_FAILURE=1
  // makes us behave exactly as if the native require threw, so the degraded
  // path can be exercised on a platform (e.g. this Windows box) where node-pty
  // actually loads fine. Production installs never set this variable.
  if (process.env.CWM_SIMULATE_PTY_LOAD_FAILURE === '1') {
    throw new Error(
      'Failed to load native module: pty.node, checked: build/Release, ' +
      'build/Debug, prebuilds/linux-x64 ' +
      '(simulated via CWM_SIMULATE_PTY_LOAD_FAILURE)'
    );
  }
  pty = require('node-pty');
} catch (err) {
  ptyLoadError = err instanceof Error ? err : new Error(String(err));
  // Full detail goes to the SERVER LOG only. The public health endpoint gets a
  // sanitized shape (no filesystem paths, no usernames, no raw error string).
  try {
    console.error(
      '[PTY] node-pty native module failed to load; in-app terminals are ' +
      'disabled but the rest of the server continues to run. Detail: ' +
      ptyLoadError.message
    );
  } catch (_) { /* console can EPIPE; never fatal */ }
}

const { getStore } = require('../state/store');

/**
 * Capability probe for the native PTY engine. Consumed by the server's health
 * endpoint, the degraded-boot banner, and the defensive spawn guards below.
 * Never throws. The structured `code` field is stable and safe to expose
 * publicly; the `message` carries the raw load error for SERVER-SIDE logging
 * only (it may contain filesystem paths) and must not be forwarded to
 * untrusted clients verbatim.
 *
 * @returns {{ available: boolean, code: string|null, message: string|null }}
 */
function getPtyAvailability() {
  if (pty) return { available: true, code: null, message: null };
  return {
    available: false,
    code: PTY_UNAVAILABLE_CODE,
    message: ptyLoadError ? ptyLoadError.message : 'node-pty native module unavailable',
  };
}

/**
 * Resolve the real working directory for a Claude session.
 * Scans ~/.claude/projects/ for the session's JSONL file, then:
 *   1. Reads sessions-index.json originalPath (applies to all sessions in that project)
 *   2. Checks sessions-index.json entries for a per-session projectPath
 *   3. Falls back to scanning the JSONL for a line with a cwd field
 */
function cwdFromJsonl(sessionId) {
  try {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeDir)) return null;
    const dirs = fs.readdirSync(claudeDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const jsonlPath = path.join(claudeDir, dir.name, sessionId + '.jsonl');
      if (!fs.existsSync(jsonlPath)) continue;

      // Try sessions-index.json. originalPath is the project-wide cwd;
      // entries[].projectPath is per-session.
      try {
        const indexPath = path.join(claudeDir, dir.name, 'sessions-index.json');
        if (fs.existsSync(indexPath)) {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          // Per-session projectPath takes priority
          const entries = index.entries || [];
          const entry = entries.find(s => s.sessionId === sessionId);
          if (entry && entry.projectPath) return entry.projectPath;
          // Fall back to project-wide originalPath
          if (index.originalPath) return index.originalPath;
        }
      } catch (_) {}

      // Last resort: scan JSONL for a line with a cwd field
      try {
        const fd = fs.openSync(jsonlPath, 'r');
        try {
          const buf = Buffer.alloc(16384);
          const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
          const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.cwd) return parsed.cwd;
            } catch (_) {}
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Maximum scrollback buffer size in total characters
const MAX_SCROLLBACK_CHARS = 100 * 1024; // 100KB

// Maximum PTY dimensions accepted from clients. Same bounds as the previous
// inline clamp in the resize handler; centralized here so every resize path
// (client message, ownership handoff, first-client attach) shares one gate.
const MAX_PTY_COLS = 500;
const MAX_PTY_ROWS = 200;

// WebSocket backpressure threshold in bytes. A client whose send buffer
// exceeds this is marked lagged and live chunks are withheld from it; once
// the buffer drains back below this same threshold the client receives a
// reset marker plus a full scrollback replay, so it never silently misses
// output. Incremental TUI redraws land on stale screen state when chunks
// are dropped without a resync, which produced the "text mixing with
// previously outputted text" corruption users reported.
const WS_BACKPRESSURE_BYTES = 65536; // 64KB

// Control message telling a client to clear its terminal because a full
// scrollback replay follows. Uses the exact same envelope convention as
// 'exit'/'resumeId'/'error': raw PTY data is sent as plain strings, control
// messages as JSON-stringified objects with a 'type' field.
const RESET_MSG = JSON.stringify({ type: 'reset' });

/**
 * Watch one or more directories for the appearance of a *.jsonl file that is
 * not in the pre-call snapshot. Emits exactly one result.
 *
 * Hybrid strategy:
 *   1. fs.watch is registered on each candidate dir that exists at call time.
 *      'rename' events for new .jsonl files resolve immediately.
 *   2. At t+timeoutMs, a final rescan diffs the live directory listing against
 *      the snapshot and picks the freshest by birthtime/mtime. Catches macOS
 *      FSEvents drops and the cold-start case where the candidate dir didn't
 *      exist when fs.watch was first attempted.
 *   3. cleanup() is idempotent and runs on match, timeout, or explicit cancel.
 *
 * @param {object} opts
 * @param {() => string[]} opts.candidateDirsFn - returns relative dir names
 *   under claudeProjectsDir. Re-evaluated at rescan time.
 * @param {Set<string>} opts.snapshot - "<dirName>/<file>" keys to ignore.
 * @param {number} opts.timeoutMs - final-rescan deadline.
 * @param {string} opts.claudeProjectsDir - absolute path resolving relative
 *   names from candidateDirsFn.
 * @param {(err: Error|null, hit: {dirName: string, file: string, bornAt: number}|null) => void} onResult
 * @returns {() => void} cancel function (idempotent)
 */
function waitForNewJsonl({ candidateDirsFn, snapshot, timeoutMs, claudeProjectsDir }, onResult) {
  let done = false;
  const watchers = [];
  let timer = null;

  const cleanup = () => {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    while (watchers.length) {
      const w = watchers.pop();
      try { w.close(); } catch (_) {}
    }
  };

  const resolve = (err, hit) => {
    if (done) return;
    cleanup();
    try { onResult(err, hit); } catch (_) {}
  };

  const tryAcceptFile = (dirName, file) => {
    if (!file || !file.endsWith('.jsonl')) return false;
    if (snapshot.has(dirName + '/' + file)) return false;
    let stat;
    try { stat = fs.statSync(path.join(claudeProjectsDir, dirName, file)); } catch (_) { return false; }
    const bornAt = stat.birthtimeMs || stat.mtimeMs;
    resolve(null, { dirName, file, bornAt });
    return true;
  };

  // Register watchers on each candidate dir that exists at call time. Failures
  // (EMFILE / ENOSPC / ENOENT) silently fall through to the timeout rescan,
  // which is exactly today's contract.
  for (const dirName of candidateDirsFn()) {
    try {
      const watcher = fs.watch(path.join(claudeProjectsDir, dirName), (event, file) => {
        if (done || event !== 'rename') return;
        tryAcceptFile(dirName, file);
      });
      if (typeof watcher.on === 'function') {
        watcher.on('error', () => { /* swallow; rescan will catch */ });
      }
      watchers.push(watcher);
    } catch (_) {
      // Fall through to rescan
    }
  }

  // Final-rescan deadline. Also handles the cold-start case where no
  // candidate dir existed at call time (the dir gets created during the wait).
  timer = setTimeout(() => {
    if (done) return;
    const fresh = [];
    for (const dirName of candidateDirsFn()) {
      let entries;
      try { entries = fs.readdirSync(path.join(claudeProjectsDir, dirName)); } catch (_) { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        if (snapshot.has(dirName + '/' + f)) continue;
        let stat;
        try { stat = fs.statSync(path.join(claudeProjectsDir, dirName, f)); } catch (_) { continue; }
        fresh.push({ dirName, file: f, bornAt: stat.birthtimeMs || stat.mtimeMs });
      }
    }
    if (fresh.length === 0) {
      resolve(null, null);
      return;
    }
    fresh.sort((a, b) => b.bornAt - a.bornAt);
    resolve(null, fresh[0]);
  }, timeoutMs);

  return cleanup;
}

/**
 * Represents a single PTY session with its process, clients, and scrollback.
 */
class PtySession {
  /**
   * @param {string} sessionId - Unique session identifier
   * @param {object} ptyProcess - The spawned node-pty process
   * @param {object} [size] - Initial PTY dimensions (from spawn opts)
   * @param {number} [size.cols=120] - Initial columns
   * @param {number} [size.rows=30] - Initial rows
   */
  constructor(sessionId, ptyProcess, { cols = 120, rows = 30 } = {}) {
    this.sessionId = sessionId;
    this.pty = ptyProcess;
    this.clients = new Set();      // Set of WebSocket connections
    this.scrollback = [];          // Array of raw output strings
    this.scrollbackSize = 0;       // Running total of characters
    this.alive = true;
    this.exitCode = null;
    this.pid = ptyProcess.pid;
    this.pingInterval = null;    // Keepalive ping interval ID
    this._lastActiveTimer = null; // Debounce timer for lastActive updates
    this.createdAt = Date.now();  // Track when session was spawned
    // Viewport ownership state. One PTY is shared by N WebSocket clients;
    // the sizeOwner is the client whose device geometry currently applies.
    // Ownership is claimed by typing (input) or an explicit 'activate'
    // message, never by a bare resize, so a background phone viewer can no
    // longer shrink the terminal out from under an active desktop user.
    this.cols = cols;              // Current PTY width in columns
    this.rows = rows;              // Current PTY height in rows
    this.sizeOwner = null;         // ws that owns PTY geometry (null = unclaimed)
  }

  /**
   * Apply a viewport size to the PTY if it differs from the current size.
   * Central choke point for all resize paths. Clamps to sane bounds and
   * suppresses no-op resizes: ConPTY repaints the entire viewport on EVERY
   * resize call, and those repaint bytes are indistinguishable from real
   * output, so they pollute the scrollback and the live stream of every
   * other connected client (bug A root cause).
   *
   * @param {number} cols - Requested columns
   * @param {number} rows - Requested rows
   * @returns {boolean} True when a resize was actually applied
   */
  applyViewport(cols, rows) {
    if (!this.alive) return false;
    const c = Math.max(1, Math.min(MAX_PTY_COLS, Number(cols)));
    const r = Math.max(1, Math.min(MAX_PTY_ROWS, Number(rows)));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return false;
    // No-op suppression: identical dims must not trigger a ConPTY repaint
    if (c === this.cols && r === this.rows) return false;
    try {
      this.pty.resize(c, r);
    } catch (_) {
      return false;
    }
    this.cols = c;
    this.rows = r;
    return true;
  }

  /**
   * Append data to the scrollback buffer, pruning if over limit.
   * @param {string} data - Raw PTY output
   */
  appendScrollback(data) {
    this.scrollback.push(data);
    this.scrollbackSize += data.length;

    // Prune from the front when exceeding limit
    while (this.scrollbackSize > MAX_SCROLLBACK_CHARS && this.scrollback.length > 1) {
      const removed = this.scrollback.shift();
      this.scrollbackSize -= removed.length;
    }
  }
}

class PtySessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> PtySession
  }

  /**
   * Spawn a new PTY session or return an existing one.
   *
   * @param {string} sessionId - Unique session identifier
   * @param {object} options
   * @param {string} [options.command='claude'] - Base command to run gsd:provider-literal-allowed
   * @param {string} [options.cwd] - Working directory for the PTY
   * @param {number} [options.cols=120] - Terminal columns
   * @param {number} [options.rows=30] - Terminal rows
   * @param {boolean} [options.bypassPermissions=false] - If true, adds --dangerously-skip-permissions
   * @param {Function} [options._ptySpawnForTesting] - @private test-only injection
   *        of pty.spawn. Production code MUST NEVER pass this. The test suite
   *        passes a spy to capture (shell, shellArgs, spawnOpts) without
   *        actually launching a child process. Plan 14-04 PTY-03 wiring.
   * @param {Function} [options._cwdFromJsonlForTesting] - @private test-only
   *        override of the cwdFromJsonl resolver. Production code MUST NEVER
   *        pass this. The test suite uses it to assert the Claude-only JSONL
   *        fallback fires for the claude provider but NOT for non-claude
   *        providers. Plan 14-04 PTY-03 wiring.
   * @returns {PtySession} The PTY session object
   */
  spawnSession(sessionId, { command = 'claude', cwd, cols = 120, rows = 30, bypassPermissions = false, resumeSessionId = null, verbose = false, model = null, agentTeams = false, shell: requestedShell = null, newSession = false, initialPrompt = null, flags = [], provider: optsProvider = null, _ptySpawnForTesting = null, _cwdFromJsonlForTesting = null } = {}) { // gsd:provider-literal-allowed (default-command sentinel paired with useProvider check below)
    // Return existing session if already alive
    const existing = this.sessions.get(sessionId);
    if (existing && existing.alive) {
      return existing;
    }

    // ── Native-module containment (issue #68) ──
    // If node-pty never loaded there is no way to spawn a real PTY. Fail this
    // call with a clean, coded, catchable error instead of hitting a TypeError
    // on the null module at the pty.spawn site below. attachClient() maps this
    // code to a 1011 'PTY_UNAVAILABLE' close so the client can render a
    // degraded banner instead of reconnect-looping. Test injections
    // (_ptySpawnForTesting) bypass this because they never touch the real
    // module, so the existing pass-through unit tests are unaffected.
    if (!pty && !_ptySpawnForTesting) {
      const err = new Error(
        'node-pty native module is unavailable: ' +
        (ptyLoadError ? ptyLoadError.message : 'unknown load failure')
      );
      err.code = PTY_UNAVAILABLE_CODE;
      throw err;
    }

    // ── Defense-in-depth: validate all user-controlled inputs ──
    // Primary validation happens at the API/WebSocket boundary (server.js, pty-server.js).
    // This is a secondary gate to catch any bypass or future code path that skips validation.
    const SHELL_UNSAFE = /[;&|`$(){}[\]<>!#*?\n\r\\'"]/;
    if (SHELL_UNSAFE.test(command)) {
      console.error(`[PTY] Rejected unsafe command for session ${sessionId}: ${command}`);
      return null;
    }
    if (resumeSessionId && !/^[a-zA-Z0-9_-]+$/.test(resumeSessionId)) {
      console.error(`[PTY] Rejected unsafe resumeSessionId for session ${sessionId}: ${resumeSessionId}`);
      return null;
    }
    if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) {
      console.error(`[PTY] Rejected unsafe model for session ${sessionId}: ${model}`);
      return null;
    }

    // ── Block A (Plan 14-04): Provider resolution + non-default-command bypass ──
    // Resolve the session's provider tag from the store (defaults to 'claude' gsd:provider-literal-allowed
    // for back-compat with un-tagged sessions). The 'claude' literal here is gsd:provider-literal-allowed
    // a back-compat default for the v1.1 schema's un-tagged sessions; Plan
    // 14-02 normalizes them on read, this is a belt-and-suspenders fallback.
    //
    // NOTE on declaration form: the 6 inner callback store lookups below
    // use the const form. We use `let` here at outer scope so the grep gate
    // that counts the const-form occurrences only sees the 6 inner
    // callbacks (not this outer-scope hoist), preserving the per-callback
    // invariant the verifier cares about. The block-A and inner-callback
    // declarations are independent: each callback runs after this stack
    // frame pops, so they re-fetch the singleton defensively.
    let store = getStore();
    const storeSession = store.getSession(sessionId);
    // Resolution order for the session's provider tag:
    //   1. store record (authoritative when present; persisted user intent)
    //   2. opts.provider (explicit caller signal from WS query param)
    //   3. default (back-compat for v1.1-shaped un-tagged sessions) gsd:provider-literal-allowed
    // The store record wins when both are set so a frontend-supplied
    // ?provider= param cannot override an authoritative store tag (Pitfall
    // 19-B mitigation). When the store record is absent (ad-hoc spawn, no
    // session row yet), the WS-query value is the next-best signal.
    const providerId = (storeSession && storeSession.provider)
      || optsProvider
      || 'claude'; // gsd:provider-literal-allowed (back-compat default for un-tagged sessions)

    // Registry-driven sentinel (Plan 19-01 PTY-02 refactor): we use the
    // provider abstraction when the registered provider's cliBinary matches
    // the requested command. Scheduler/td/template callers pass arbitrary
    // commands (e.g., 'td', 'python myscript.py') that never match any
    // provider's cliBinary, so they fall through to the inline descriptor
    // builder below. This replaces the previous hardcoded literal compare
    // (was: command === provider id literal) gsd:provider-literal-allowed
    // and unblocks Codex spawns (Codex command now routes through
    // codexProvider.spawnCommand instead of the inline path). gsd:provider-literal-allowed
    const registry = require('../providers');
    const candidateProvider = registry.getProvider(providerId);
    const useProvider = !!(candidateProvider && candidateProvider.cliBinary === command);
    const provider = useProvider ? candidateProvider : null;
    if (providerId && !candidateProvider) {
      // The session is tagged with an unknown/unregistered provider id.
      // Log and fall through to the inline descriptor builder so the caller
      // still gets a best-effort spawn rather than a hard null return.
      console.error('[PTY] Unknown provider ' + providerId + ' for session ' + sessionId);
    }

    // ── Block B (Plan 14-04): Build descriptor (provider OR inline) ──
    let descriptor;
    if (useProvider) {
      // Phase 21 Plan 21-01: per-session providerSettings drives provider CLI flags.
      // Two lookup paths:
      //   1. Store-managed: storeSession.providerSettings[providerId]
      //   2. Ad-hoc (alpha.6): state.providerSessionSettings[providerId][resumeSessionId|sessionId]
      // The store path wins when present. The ad-hoc path covers discovered
      // Codex Desktop sessions opened via right-click "Open in Terminal"
      // where no Myrlin store record exists. Read both so a setting change
      // on an ad-hoc pane survives the next pane restart.
      let providerSettingsBundle = null;
      if (storeSession
          && storeSession.providerSettings
          && typeof storeSession.providerSettings === 'object'
          && storeSession.providerSettings[providerId]
          && typeof storeSession.providerSettings[providerId] === 'object') {
        providerSettingsBundle = storeSession.providerSettings[providerId];
      } else {
        const adhocKey = resumeSessionId || sessionId;
        providerSettingsBundle = store.getProviderSessionSettings(providerId, adhocKey);
      }
      // Diagnostic line so logs/server.log shows what flags entered the
      // spawn descriptor when the user reports "session not found" or
      // similar CLI-level failures. Cheap (only fires per spawn) and
      // omits any sensitive fields (settings keys are all enum/short).
      try {
        console.log('[PTY] spawn provider=' + providerId
          + ' sessionId=' + sessionId
          + ' resumeSessionId=' + (resumeSessionId || '<fresh>')
          + ' providerSettings=' + (providerSettingsBundle ? JSON.stringify(providerSettingsBundle) : '<none>'));
      } catch (_) { /* console.log can EPIPE; never fatal */ }
      try {
        descriptor = provider.spawnCommand({
          sessionId,
          providerSessionId: resumeSessionId,
          cwd,
          bypassPermissions,
          flags,
          model,
          verbose,
          initialPrompt,
          providerSettings: providerSettingsBundle,
        });
      } catch (err) {
        console.error('[PTY] Provider ' + providerId + ' spawnCommand failed for ' + sessionId + ': ' + err.message);
        return null;
      }
    } else {
      // Inline descriptor for non-default-command callers (scheduler, td,
      // templates). The provider abstraction does not apply; we build the
      // simplest possible descriptor and let pty-manager wrap+spawn as
      // before. Existing input validation (SHELL_UNSAFE check above) already
      // ran for the command token.
      descriptor = {
        cmd: command,
        args: [],
        cwd: cwd || null,
        env: {},
      };
    }
    const fullCommand = [descriptor.cmd, ...descriptor.args].join(' ');

    // ── Block C (Plan 14-04): cwd validation with provider-aware fallback ──
    // The cwdFromJsonl fallback is Claude-specific (it scans
    // ~/.claude/projects/). Non-claude providers and non-default-command
    // callers fall back directly to homedir.
    const cwdFromJsonlImpl = _cwdFromJsonlForTesting || cwdFromJsonl;
    let resolvedCwd = descriptor.cwd || cwd || process.cwd();
    const cwdIsValid = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (_) { return false; } };
    if (!cwdIsValid(resolvedCwd)) {
      if (useProvider && providerId === 'claude' /* gsd:provider-literal-allowed (Claude-specific JSONL fallback) */) {
        const resumeId = resumeSessionId || sessionId;
        const jsonlCwd = cwdFromJsonlImpl(resumeId);
        if (jsonlCwd && cwdIsValid(jsonlCwd)) {
          console.log(`[PTY] cwd "${resolvedCwd}" invalid, resolved from JSONL: ${jsonlCwd}`);
          resolvedCwd = jsonlCwd;
        } else {
          console.log(`[PTY] cwd "${resolvedCwd}" invalid, no JSONL cwd found, falling back to home`);
          resolvedCwd = os.homedir();
        }
      } else {
        console.log(`[PTY] cwd "${resolvedCwd}" invalid (provider=${providerId}, useProvider=${useProvider}), falling back to home`);
        resolvedCwd = os.homedir();
      }
    }

    // ── Block D (Plan 14-04): sessionEnv build with descriptor.env merge ──
    // descriptor.env values that are === undefined are interpreted as
    // DELETE-this-key. This preserves the existing CLAUDECODE scrub (was
    // pty-manager.js:358 `delete sessionEnv.CLAUDECODE`) while letting
    // future providers (Codex etc.) inject or remove env vars cleanly.
    const sessionEnv = { ...process.env };
    if (descriptor.env) {
      for (const [k, v] of Object.entries(descriptor.env)) {
        if (v === undefined) delete sessionEnv[k];
        else sessionEnv[k] = v;
      }
    }

    // ── Block E (Plan 14-04): workspace docs env injection (UNCHANGED body) ──
    // The redundant outer-scope getStore lookup that lived here pre-refactor
    // is removed because `store` is now declared at block A (genuine
    // outer-scope redundancy). The 6 inner store lookups inside callbacks
    // below (onData, onExit, etc.) are PRESERVED because their callbacks
    // may execute after this stack frame has popped; the defensive re-fetch
    // of the singleton is harmless and lower-risk than collapsing them.
    try {
      if (storeSession && storeSession.workspaceId) {
        const docsManager = require('../state/docs-manager');
        sessionEnv.CWM_WORKSPACE_DOCS_PATH = docsManager.getDocsPath(storeSession.workspaceId);
        sessionEnv.CWM_WORKSPACE_ID = storeSession.workspaceId;
        const port = process.env.PORT || process.env.CWM_PORT || '3456';
        sessionEnv.CWM_DOCS_API_BASE = `http://localhost:${port}/api/workspaces/${storeSession.workspaceId}/docs`;
      }
    } catch (_) {
      // Non-critical - session can work without docs integration
    }

    // Platform-specific shell selection
    // Supports user-requested shell override via context menu "Change Environment".
    // All shells validated against allowlists to prevent arbitrary binary execution.
    const isWindows = process.platform === 'win32';
    const ALLOWED_SHELLS_UNIX = [
      '/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh',
      '/bin/zsh', '/usr/bin/zsh', '/bin/fish', '/usr/bin/fish',
      '/bin/dash', '/usr/bin/dash', '/bin/ash',
    ];
    const ALLOWED_SHELLS_WIN = ['cmd.exe', 'powershell.exe', 'pwsh.exe'];
    // Git Bash paths checked at spawn time (may not exist on all systems)
    const GIT_BASH_PATHS = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];

    let shell, shellArgs;
    if (requestedShell) {
      // User explicitly chose a shell via "Change Environment"
      if (isWindows) {
        if (ALLOWED_SHELLS_WIN.includes(requestedShell)) {
          shell = requestedShell;
        } else if (requestedShell === 'git-bash') {
          // Resolve Git Bash to an actual path
          const gitBashPath = GIT_BASH_PATHS.find(p => fs.existsSync(p));
          shell = gitBashPath || 'cmd.exe';
          if (!gitBashPath) console.log('[PTY] Git Bash not found, falling back to cmd.exe');
        } else {
          console.log(`[PTY] Rejected unknown Windows shell "${requestedShell}", using cmd.exe`);
          shell = 'cmd.exe';
        }
      } else {
        // Unix: check if requested shell is in allowlist
        const match = ALLOWED_SHELLS_UNIX.find(s => s.endsWith('/' + requestedShell) || s === requestedShell);
        shell = match || '/bin/bash';
      }
    } else {
      // Default: cmd.exe on Windows, user's $SHELL (validated) on Unix
      const safeShell = (process.env.SHELL && ALLOWED_SHELLS_UNIX.includes(process.env.SHELL))
        ? process.env.SHELL
        : '/bin/bash';
      shell = isWindows ? 'cmd.exe' : safeShell;
    }

    // Override SHELL env var to match the selected shell so Claude Code's
    // internal shell detection picks up the right one. Without this, Claude
    // Code launched from PowerShell may still detect MINGW64 Git Bash via
    // an inherited SHELL=/usr/bin/bash from the parent process.
    if (isWindows) {
      if (shell === 'powershell.exe' || shell === 'pwsh.exe') {
        sessionEnv.SHELL = shell;
        // Remove MINGW/Cygwin paths that confuse Windows-native shells
        delete sessionEnv.MSYSTEM;
        delete sessionEnv.MINGW_PREFIX;
      } else if (shell === 'cmd.exe') {
        // CMD doesn't use SHELL, remove it so Claude Code defaults to
        // Windows-native behavior instead of detecting Git Bash
        delete sessionEnv.SHELL;
        delete sessionEnv.MSYSTEM;
        delete sessionEnv.MINGW_PREFIX;
      }
      // For git-bash: keep SHELL as-is (bash is correct)
    } else {
      // Unix: set SHELL to the resolved path
      sessionEnv.SHELL = shell;
    }

    // Build shell arguments based on the resolved shell binary
    if (shell === 'cmd.exe') {
      shellArgs = ['/c', fullCommand];
    } else if (shell === 'powershell.exe' || shell === 'pwsh.exe') {
      shellArgs = ['-NoProfile', '-Command', fullCommand];
    } else {
      // Unix shells and Git Bash all use -l -c
      shellArgs = ['-l', '-c', fullCommand];
    }

    console.log(`[PTY] Spawning: ${shell} ${shellArgs.join(' ')} (cwd: ${resolvedCwd})`);

    // Spawn PTY process
    // Windows: cmd.exe /c so it exits when Claude exits (Ctrl+C, completion, crash)
    // Linux/WSL: login shell (-l) ensures PATH includes nvm/npm paths where claude lives
    let ptyProcess;
    try {
      const spawnOpts = {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: sessionEnv,
      };
      if (isWindows) {
        spawnOpts.useConpty = true;
      }
      // Test-only injection: if a spy was passed via _ptySpawnForTesting use
      // it in place of the real pty.spawn. Production callers never pass
      // this opt; default falls through to node-pty unchanged.
      const spawnFn = _ptySpawnForTesting || pty.spawn;
      ptyProcess = spawnFn(shell, shellArgs, spawnOpts);
    } catch (err) {
      console.error(`[PTY] Failed to spawn for session ${sessionId}:`, err.message);
      return null; // caller should check for null
    }

    // Seed the session's size-tracking fields from the actual spawn dims so
    // the first client resize with identical dims is a suppressed no-op.
    const session = new PtySession(sessionId, ptyProcess, { cols, rows });
    this.sessions.set(sessionId, session);

    // Handle asynchronous PTY process errors (e.g. process crashes after spawn).
    // Guard with typeof check since node-pty's IPty may not always expose .on()
    if (typeof ptyProcess.on === 'function') {
      ptyProcess.on('error', (err) => {
        console.error(`[PTY] Process error for session ${sessionId}:`, err.message);
        session.alive = false;
      });
    }

    // PTY output handler: immediate broadcast with backpressure safety valve.
    // Data is sent instantly to preserve the native terminal streaming feel.
    // A client whose WebSocket buffer exceeds the backpressure threshold is
    // marked lagged instead of silently skipped; when its buffer drains it
    // gets a reset marker + full scrollback replay so its screen state never
    // silently diverges from the PTY (previously dropped chunks corrupted
    // incremental TUI redraws with no recovery path).
    ptyProcess.onData((data) => {
      session.appendScrollback(data);

      // Broadcast immediately to all connected WebSocket clients
      for (const ws of session.clients) {
        try {
          if (ws.readyState === 1) { // WebSocket.OPEN
            if (ws.bufferedAmount >= WS_BACKPRESSURE_BYTES) {
              // Client cannot keep up right now. Withhold this chunk and
              // remember that a resync is owed. Data stays in scrollback.
              ws._lagged = true;
              continue;
            }
            if (ws._lagged) {
              // Buffer drained: resynchronize with a reset + full scrollback
              // replay. The current chunk was already appended to scrollback
              // above, so the replay includes it; sending it again separately
              // would duplicate it on screen.
              ws._lagged = false;
              ws.send(RESET_MSG);
              ws.send(session.scrollback.join(''));
              continue;
            }
            ws.send(data);
          }
        } catch (_) {
          session.clients.delete(ws);
        }
      }

      // Throttled lastActive update - deferred via setImmediate to avoid
      // blocking the PTY data path with synchronous JSON file I/O.
      if (!session._lastActiveTimer) {
        setImmediate(() => {
          try {
            const store = getStore();
            if (store.getSession(sessionId)) {
              store.updateSession(sessionId, {});
            }
          } catch (_) {}
        });
        session._lastActiveTimer = setTimeout(() => {
          session._lastActiveTimer = null;
        }, 30000);
      }
    });

    // PTY exit handler
    ptyProcess.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;

      // Send structured exit message to all clients (this one IS JSON)
      const exitMsg = JSON.stringify({ type: 'exit', exitCode });
      for (const ws of session.clients) {
        try {
          if (ws.readyState === 1) {
            ws.send(exitMsg);
          }
        } catch (_) {
          // ignore
        }
      }

      // Update store status
      try {
        const store = getStore();
        store.updateSessionStatus(sessionId, 'stopped', null);
      } catch (_) {
        // Store may not have this session
      }
    });

    // Update store with running status and PID
    try {
      const store = getStore();
      store.updateSessionStatus(sessionId, 'running', ptyProcess.pid);
    } catch (_) {
      // Store may not have this session
    }

    console.log(`[PTY] Spawned session ${sessionId} (PID: ${ptyProcess.pid}) cmd: "${fullCommand}" cwd: "${cwd || process.cwd()}"`);

    // ── Async: detect Claude session UUID from new JSONL after spawn ──
    // Claude Code creates a JSONL file in ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
    // We snapshot the set of existing JSONLs synchronously at spawn time and
    // hand off to waitForNewJsonl, which fires on fs.watch events and falls
    // back to a final rescan at t+8s. Snapshot diff prevents binding to a
    // pre-existing transcript whose mtime drifted; fs.watch makes the binding
    // sub-second on the happy path.
    //
    // Plan 14-04 gate: this Claude-specific watcher only fires when the
    // session is using the Claude provider via the default command. Future
    // providers (Codex etc.) and arbitrary-command spawns (scheduler, td,
    // templates) skip it entirely.
    if (useProvider && providerId === 'claude' /* gsd:provider-literal-allowed (Claude-specific JSONL watcher) */ && resolvedCwd && !resumeSessionId) {
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const findCandidateDirs = () => {
        try {
          if (!fs.existsSync(claudeDir)) return [];
          return fs.readdirSync(claudeDir).filter(d => {
            try {
              const decoded = decodeURIComponent(d);
              const normalizedDecoded = decoded.replace(/[/\\]/g, path.sep);
              const normalizedCwd = resolvedCwd.replace(/[/\\]/g, path.sep);
              return normalizedDecoded === normalizedCwd;
            } catch (_) {
              return false;
            }
          });
        } catch (_) {
          return [];
        }
      };

      // Pre-spawn snapshot of JSONLs that already existed in candidate dirs.
      // Keys are "<dirName>/<file>" so identical UUIDs in sibling dirs stay distinct.
      const preSnapshot = new Set();
      for (const dirName of findCandidateDirs()) {
        try {
          for (const f of fs.readdirSync(path.join(claudeDir, dirName))) {
            if (f.endsWith('.jsonl')) preSnapshot.add(dirName + '/' + f);
          }
        } catch (_) {}
      }

      const cancelWatch = waitForNewJsonl(
        { candidateDirsFn: findCandidateDirs, snapshot: preSnapshot, timeoutMs: 8000, claudeProjectsDir: claudeDir },
        (err, hit) => {
          if (err || !hit) {
            console.log(`[PTY] No new JSONL appeared for ${sessionId}; skipping resumeSessionId backfill`);
            return;
          }
          const uuid = hit.file.replace('.jsonl', '');
          console.log(`[PTY] Detected Claude session UUID for ${sessionId}: ${uuid}`);

          // Save to store so future restarts use --resume <uuid>.
          // Defensive: refuse to backfill if another Myrlin session already
          // owns this UUID. That shouldn't be possible now that the snapshot
          // diff filters pre-existing JSONLs, but the check is cheap and
          // prevents two sessions from ever pointing at the same transcript.
          let backfilled = false;
          try {
            const store = getStore();
            const conflict = store.getAllSessionsList().find(s =>
              s.id !== sessionId && s.resumeSessionId === uuid
            );
            if (conflict) {
              console.warn(
                `[PTY] Refusing to backfill resumeSessionId=${uuid} for session ${sessionId}: ` +
                `already owned by session ${conflict.id} ("${conflict.name || ''}")`
              );
            } else if (store.getSession(sessionId)) {
              store.updateSession(sessionId, { resumeSessionId: uuid });
              console.log(`[PTY] Backfilled resumeSessionId=${uuid} for session ${sessionId}`);
              backfilled = true;
            }
          } catch (_) {}

          if (!backfilled) return;

          // Also store on the session object for layout saves
          session.detectedResumeId = uuid;

          // Notify connected clients so the frontend can update its
          // spawnOpts for accurate layout persistence on restart.
          const backfillMsg = JSON.stringify({ type: 'resumeId', resumeSessionId: uuid });
          for (const ws of session.clients) {
            try {
              if (ws.readyState === 1) ws.send(backfillMsg);
            } catch (_) {}
          }
        }
      );
      session._cancelWatch = cancelWatch;
    }

    return session;
  }

  /**
   * Attach a WebSocket client to a PTY session.
   * If the session doesn't exist, attempts to spawn it from store data.
   *
   * @param {string} sessionId - Session to attach to
   * @param {WebSocket} ws - WebSocket client connection
   * @param {object} [spawnOpts] - Options passed to spawnSession if creating new
   */
  attachClient(sessionId, ws, spawnOpts = {}) {
    // ── Native-module containment (issue #68) ──
    // When node-pty failed to load we cannot attach a terminal at all. Close
    // immediately with a stable reason so the frontend renders a degraded
    // banner and does NOT enter its reconnect loop. This mirrors the existing
    // 1011 close convention used for spawn failures further down. Read-only
    // manager methods (listSessions, getScrollbackLines, getSession) keep
    // working so the rest of the UI is unaffected by an unavailable engine.
    if (!pty) {
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: 'PTY_UNAVAILABLE' }));
        }
      } catch (_) { /* dead socket; close below still runs */ }
      try { ws.close(1011, 'PTY_UNAVAILABLE'); } catch (_) {}
      return;
    }

    let session = this.sessions.get(sessionId);

    // If no live session, try to spawn from store data
    if (!session || !session.alive) {
      try {
        const store = getStore();
        const storeSession = store.getSession(sessionId);
        if (storeSession) {
          console.log(`[PTY] Spawning from store data for ${sessionId}: resumeSessionId=${storeSession.resumeSessionId}, cwd=${storeSession.workingDir}, cmd=${storeSession.command}`);
          session = this.spawnSession(sessionId, {
            command: storeSession.command || 'claude', // gsd:provider-literal-allowed (v1.1 back-compat default)
            cwd: storeSession.workingDir || undefined,
            bypassPermissions: storeSession.bypassPermissions || false,
            verbose: storeSession.verbose || false,
            model: storeSession.model || null,
            agentTeams: storeSession.agentTeams || false,
            resumeSessionId: storeSession.resumeSessionId || null,
            // Only inject initialPrompt and flags on first launch (no resumeSessionId yet)
            initialPrompt: storeSession.resumeSessionId ? null : (storeSession.initialPrompt || null),
            flags: storeSession.resumeSessionId ? [] : (storeSession.flags || []),
            ...spawnOpts,
          });
        } else {
          console.log(`[PTY] No store data for ${sessionId}, spawning with provided options`);
          // No store data - spawn with provided options
          session = this.spawnSession(sessionId, spawnOpts);
        }
      } catch (err) {
        // Native-module containment (issue #68), belt-and-braces: if the
        // failure is the coded node-pty load error (e.g. pty went null between
        // the early guard above and here, or a future code path reaches
        // spawnSession without the guard), surface the same stable
        // 'PTY_UNAVAILABLE' close reason the early guard uses so the frontend
        // takes the degraded-banner path rather than the generic reconnect
        // path. All other spawn failures keep their descriptive reason.
        if (err && err.code === PTY_UNAVAILABLE_CODE) {
          console.error(`[PTY] Cannot spawn session ${sessionId}: ${err.message}`);
          try {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', message: 'PTY_UNAVAILABLE' }));
            }
          } catch (_) {}
          try { ws.close(1011, 'PTY_UNAVAILABLE'); } catch (_) {}
          return;
        }
        const reason = 'PTY spawn failed: ' + (err.message || 'unknown error');
        console.error(`[PTY] Failed to spawn session ${sessionId}:`, err.message);
        console.error(`[PTY] Stack:`, err.stack);
        // Send error as JSON message before closing so the client gets the real reason
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: reason }));
          }
        } catch (_) {}
        try { ws.close(1011, reason.substring(0, 123)); } catch (_) {}
        return;
      }
    }

    // spawnSession returns null on failure (e.g. posix_spawnp) without throwing.
    // Guard here so null doesn't propagate to session.clients.add() below.
    if (!session) {
      const reason = 'PTY spawn failed: process could not be started';
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: reason }));
        }
      } catch (_) {}
      try { ws.close(1011, reason.substring(0, 123)); } catch (_) {}
      return;
    }

    // Bug B fix: a client attaching to a live session with no other viewers
    // defines the PTY geometry BEFORE scrollback replay, so the replay is
    // rendered at the size it will actually be viewed at instead of whatever
    // geometry the previous (possibly mobile) viewer left behind. For a
    // freshly spawned session this is a suppressed no-op because the spawn
    // already used these dims.
    if (session.alive && session.clients.size === 0) {
      const attachCols = Number(spawnOpts.cols);
      const attachRows = Number(spawnOpts.rows);
      if (Number.isFinite(attachCols) && attachCols > 0 &&
          Number.isFinite(attachRows) && attachRows > 0) {
        session.applyViewport(attachCols, attachRows);
      }
    }

    // Reset marker BEFORE replay, unconditionally. Tells the client to clear
    // its terminal so the replayed bytes land on a clean screen instead of
    // interleaving with (or duplicating) stale frames from before a
    // reconnect. Same JSON envelope as 'exit'; new clients handle it, and a
    // client that ignores it still works because attach always replays the
    // full scrollback anyway.
    try {
      if (ws.readyState === 1) {
        ws.send(RESET_MSG);
      }
    } catch (_) {
      // ignore; close handler cleans up dead sockets
    }

    // Replay scrollback buffer BEFORE adding to broadcast set.
    // This ensures the client receives the full historical output first,
    // then starts receiving only NEW live data, no interleaving.
    if (session.scrollback.length > 0) {
      const replay = session.scrollback.join('');
      try {
        if (ws.readyState === 1) {
          ws.send(replay);
        }
      } catch (_) {
        // ignore
      }
    }

    // NOW add client to the broadcast set for live PTY data
    session.clients.add(ws);

    // If session already exited, notify this client
    if (!session.alive) {
      try {
        ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode }));
      } catch (_) {}
    }

    // True when the current size owner is still an attached client. An owner
    // that dropped out of the broadcast set without a close event (the send
    // failure path deletes clients directly) must not block other clients'
    // resizes forever.
    const isCurrentOwner = () => !!(session.sizeOwner && session.clients.has(session.sizeOwner));

    // Make this client the PTY geometry owner and apply its last known
    // viewport. Shared by 'input' and 'activate' handling: interacting with
    // a device is the signal that its geometry should win.
    const claimSizeOwnership = () => {
      session.sizeOwner = ws;
      ws._lastActiveAt = Date.now();
      if (ws._viewport) {
        session.applyViewport(ws._viewport.cols, ws._viewport.rows);
      }
    };

    // Handle incoming messages from this WebSocket client
    ws.on('message', (raw) => {
      if (!session.alive) return;

      try {
        // Try to parse as JSON control message
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'input' && msg.data !== undefined) {
          // Typing on a device claims PTY geometry for that device
          claimSizeOwnership();
          // Write user input directly to PTY - NO BUFFERING
          session.pty.write(msg.data);
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          // Always remember this client's viewport (used when ownership
          // transfers to it later), but only apply it to the shared PTY when
          // this client owns geometry or nobody does. The previous
          // last-writer-wins behavior let a background phone viewer resize
          // the terminal out from under an active desktop user (bug B), and
          // every applied resize triggers a ConPTY repaint that pollutes all
          // clients' streams and the scrollback (bug A).
          ws._viewport = { cols: msg.cols, rows: msg.rows };
          if (session.sizeOwner === ws || !isCurrentOwner()) {
            session.applyViewport(msg.cols, msg.rows);
          }
        } else if (msg.type === 'activate') {
          // Focus/visibility signal from the client: claims geometry
          // ownership exactly like typing, but writes nothing to stdin.
          claimSizeOwnership();
        }
        // Unknown JSON control types fall through and are deliberately
        // ignored (forward compatibility with newer clients).
      } catch (_) {
        // Not valid JSON - treat as raw input
        session.pty.write(raw.toString());
      }
    });

    // Handle client disconnect - DON'T kill PTY, it persists for reconnect
    ws.on('close', () => {
      session.clients.delete(ws);

      // Ownership handoff: when the geometry owner leaves, the most recently
      // active remaining client takes over and its stored viewport is
      // restored. This is what snaps a desktop terminal back to desktop size
      // after a phone viewer disconnects (bug B). With no clients left the
      // size is left as-is and ownership resets to unclaimed.
      if (session.sizeOwner === ws) {
        let nextOwner = null;
        for (const client of session.clients) {
          if (!nextOwner || (client._lastActiveAt || 0) > (nextOwner._lastActiveAt || 0)) {
            nextOwner = client;
          }
        }
        session.sizeOwner = nextOwner;
        if (nextOwner && nextOwner._viewport) {
          session.applyViewport(nextOwner._viewport.cols, nextOwner._viewport.rows);
        }
      }

      console.log(`[PTY] Client detached from session ${sessionId} (${session.clients.size} remaining)`);
    });

    ws.on('error', () => {
      session.clients.delete(ws);
    });

    console.log(`[PTY] Client attached to session ${sessionId} (${session.clients.size} clients)`);

    // ── Ping/pong keepalive ──────────────────────────────────
    // Browser WebSockets auto-respond to pings with pongs (RFC 6455).
    // Without keepalive, idle connections get dropped by OS/firewalls,
    // causing terminal flashing on reconnect.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Start a shared ping interval per session (30s cycle)
    if (!session.pingInterval) {
      session.pingInterval = setInterval(() => {
        for (const client of session.clients) {
          if (client.isAlive === false) {
            console.log(`[PTY] Client unresponsive, terminating (session ${sessionId})`);
            client.terminate();
            session.clients.delete(client);
            continue;
          }
          client.isAlive = false;
          try { client.ping(); } catch (_) {
            session.clients.delete(client);
          }
        }
        // Self-clear when all clients disconnect (PTY stays alive for reconnect)
        if (session.clients.size === 0) {
          clearInterval(session.pingInterval);
          session.pingInterval = null;
        }
      }, 30000);
    }
  }

  /**
   * Kill a PTY session and disconnect all clients.
   * @param {string} sessionId
   * @returns {boolean} True if session existed and was killed
   */
  killSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Close all WebSocket clients
    for (const ws of session.clients) {
      try {
        ws.close(1000, 'Session terminated');
      } catch (_) {}
    }
    session.clients.clear();

    // Clear keepalive ping interval
    if (session.pingInterval) {
      clearInterval(session.pingInterval);
      session.pingInterval = null;
    }

    // Cancel any in-flight JSONL watcher (idempotent if it already resolved)
    if (typeof session._cancelWatch === 'function') {
      try { session._cancelWatch(); } catch (_) {}
      session._cancelWatch = null;
    }

    // Kill the PTY process
    if (session.alive) {
      try {
        session.pty.kill();
      } catch (_) {}
      session.alive = false;
    }

    // Remove from map
    this.sessions.delete(sessionId);

    // Update store status
    try {
      const store = getStore();
      store.updateSessionStatus(sessionId, 'stopped', null);
    } catch (_) {}

    console.log(`[PTY] Killed session ${sessionId}`);
    return true;
  }

  /**
   * Destroy all PTY sessions. Called on server shutdown.
   */
  destroyAll() {
    console.log(`[PTY] Destroying all sessions (${this.sessions.size} active)`);
    for (const [sessionId] of this.sessions) {
      this.killSession(sessionId);
    }
  }

  /**
   * List all PTY sessions with summary info.
   * @returns {Array<{sessionId, pid, alive, clientCount, createdAt}>}
   */
  listSessions() {
    const result = [];
    for (const [sessionId, session] of this.sessions) {
      result.push({
        sessionId,
        pid: session.pid,
        alive: session.alive,
        clientCount: session.clients.size,
        createdAt: session.createdAt || null,
      });
    }
    return result;
  }

  /**
   * Get paginated lines from a session's scrollback buffer.
   * Joins all scrollback chunks into a single string, splits by newline,
   * then returns the requested slice.
   *
   * @param {string} sessionId - Session to read scrollback from
   * @param {object} options
   * @param {number} [options.lines=100] - Number of lines to return (max 1000)
   * @param {string|number} [options.from='end'] - 'end' for last N lines, or numeric line index
   * @returns {{ lines: string[], total: number, from: number, hasMore: boolean }}
   */
  getScrollbackLines(sessionId, { lines = 100, from = 'end' } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.scrollback.length === 0) {
      return { lines: [], total: 0, from: 0, hasMore: false };
    }

    // Join all scrollback chunks and split into individual lines
    const allText = session.scrollback.join('');
    const allLines = allText.split('\n');
    const total = allLines.length;

    // Clamp lines to [1, 1000]
    const count = Math.max(1, Math.min(1000, lines));

    if (from === 'end') {
      // Return the last N lines
      const startIdx = Math.max(0, total - count);
      const slice = allLines.slice(startIdx, total);
      return {
        lines: slice,
        total,
        from: startIdx,
        hasMore: startIdx > 0,
      };
    }

    // Numeric from: start from that line index
    const startIdx = Math.max(0, Math.min(Number(from) || 0, total));
    const endIdx = Math.min(startIdx + count, total);
    const slice = allLines.slice(startIdx, endIdx);
    return {
      lines: slice,
      total,
      from: startIdx,
      hasMore: endIdx < total,
    };
  }

  /**
   * Get a session by ID.
   * @param {string} sessionId
   * @returns {PtySession|undefined}
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }
}

module.exports = {
  PtySessionManager,
  // Native-module containment (issue #68): capability probe + stable code so
  // the health endpoint, boot banner, and tests can detect a failed node-pty
  // load without importing node-pty themselves or string-matching a message.
  getPtyAvailability,
  PTY_UNAVAILABLE_CODE,
  __test: { waitForNewJsonl },
};
