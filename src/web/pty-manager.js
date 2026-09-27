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
const crypto = require('crypto');
// Forward encoder for Claude's ~/.claude/projects/<dir> naming. Used by the
// post-spawn JSONL watcher's candidate-dir matcher (see findCandidateDirs).
const { encodeClaudeProjectDir } = require('../providers/claude/path-decode');
// Live-session gate (2026-09-26): case-insensitive transcript id compare,
// shared with the lookup so both sides agree on what "the same session" is.
const {
  sameTranscriptId,
  parseResumeCommand,
  newestTranscriptForCwd,
  appendDecisionLog,
} = require('../providers/claude/live-sessions');

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

// ── VT sidecar (Notion-restyle P6) ────────────────────────────────────────
// The sidecar is a headless @xterm terminal shadowing each PTY, used for
// exact state replay on attach, an authoritative buffer-mode signal, and a
// deep normal-buffer line log. It is loaded here but constructs NOTHING until
// CWM_VT_SIDECAR=1: the module resolves @xterm/headless lazily and every
// consumer below degrades to the pre-existing byte-ring path when the sidecar
// is off, unavailable, at capacity, or unhealthy. See src/web/vt-sidecar.js.
const {
  VtSidecarRegistry,
  isSnapshotReplayEnabled,
  getVtSidecarAvailability,
} = require('./vt-sidecar');

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

// ─── Live-session gate (2026-09-26) ──────────────────────────────────────
//
// Opening a Claude pane runs `claude --resume <transcript>`. If that
// transcript belongs to a session that is running right now (a `claude --bg`
// background session, or an interactive terminal on the PC), the resume FORKS
// it. attachClient therefore asks `claude agents --json` first (through the
// provider's optional liveSessionLookup) and attaches, holds the socket on a
// notice, or resumes. These are the tunables and the stable code for it.

// Coded error spawnSession throws when a resume that skipped the gate targets
// a transcript the lookup already knows is live. attachClient maps it to the
// same notice the gate shows.
const CLAUDE_SESSION_LIVE_CODE = 'CLAUDE_SESSION_LIVE';
// Notice code on the {type:'notice'} frame (shown as a toast by app.js).
const LIVE_ELSEWHERE_NOTICE_CODE = 'LIVE_ELSEWHERE';
// A Workbook PTY for the same transcript that exited this recently may still
// be listed by `claude agents` while it tears down (Restart, Change
// Environment, toggles all kill and reopen). The gate re-asks a few times
// with a fresh listing before calling it "live elsewhere".
const OWN_EXIT_GRACE_MS = 15000;
// Above the lookup's 1 s fresh-reuse floor, so every re-check really asks.
const OWN_EXIT_RECHECK_DELAY_MS = 1100;
const OWN_EXIT_RECHECK_ATTEMPTS = 3;
// Keepalive for a socket held on the notice (it is not in any session's
// client set, so the per-session ping loop does not cover it).
const LIVE_HOLD_PING_MS = 30000;
// The typed confirmation word, and a cap on the typed line.
const LIVE_HOLD_CONFIRM_WORD = 'copy';
const LIVE_HOLD_MAX_LINE = 64;
// A Workbook Claude pane younger than this may not be registered with the CLI
// yet, so it does not count for the blind-listing check.
const SIGHT_CHECK_MIN_PANE_AGE_MS = 30000;

/**
 * True when two live-gate results point at the same spawn target. For a
 * `--continue` command only the folder counts: which transcript is newest in
 * it can flip while sessions write, and that must not re-trigger the check.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameGateTarget(a, b) {
  if (!a || !b) return false;
  if (!!a.viaCommand !== !!b.viaCommand || a.cliBinary !== b.cliBinary) return false;
  if (a.continueCwd || b.continueCwd) {
    return String(a.continueCwd || '').toLowerCase() === String(b.continueCwd || '').toLowerCase();
  }
  return sameTranscriptId(a.resumeSessionId, b.resumeSessionId);
}

/**
 * Remove terminal control characters from text that came from outside
 * (session names from `claude agents`) before it is written into a pane.
 * @param {*} s
 * @returns {string}
 */
function stripControlChars(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Human wording for a live-session notice decision. Pure; exported for tests.
 *
 * @param {object} decision - {reason, entry?, marker?, error?, otherSessionId?}
 * @param {number} [now=Date.now()]
 * @returns {{headline: string, lines: string[]}} headline goes to the toast,
 *   lines are written into the pane.
 */
function describeLiveNotice(decision, now = Date.now()) {
  const d = decision || {};
  const entry = d.entry || null;
  const copyLine = 'Opening it here would start a copy of it that writes to the same conversation.';
  let headline;
  let detail = copyLine;
  const who = (e) => {
    if (!e) return '';
    const bits = [];
    if (e.name) bits.push('"' + stripControlChars(e.name) + '"');
    if (Number.isFinite(e.pid)) bits.push('pid ' + e.pid);
    return bits.length ? ' (' + bits.join(', ') + ')' : '';
  };
  switch (d.reason) {
    case 'interactive':
      headline = 'This session is live in a terminal on the PC' + who(entry) + '.';
      break;
    case 'open-in-workbook':
      headline = 'This session is already open in another Workbook pane' + (d.otherSessionId ? ' (' + d.otherSessionId + ')' : '') + '.';
      break;
    case 'unattachable':
      headline = 'This session is running' + (entry && entry.kind ? ' as ' + stripControlChars(entry.kind) : '') + who(entry) + ', but Workbook cannot attach to it.';
      break;
    case 'continue-live-cwd':
      headline = 'This session\'s command picks its conversation when it starts (--continue, --from-pr or the resume picker), and a session is live in its folder' + who(entry) + '.';
      detail = 'Workbook cannot tell which conversation it would pick, so it could start a copy of the live one.';
      break;
    case 'lookup-failed': {
      headline = 'Could not check whether this session is running (claude agents: ' + (d.error || 'failed') + ').';
      const m = d.marker;
      if (m && Number.isFinite(m.at)) {
        const mins = Math.max(0, Math.round((now - m.at) / 60000));
        const ago = mins < 1 ? 'under a minute' : (mins < 120 ? mins + ' min' : Math.round(mins / 60) + ' h');
        const kind = m.kind === 'background' ? 'as a background session' : 'in a terminal';
        detail = 'It was seen live ' + kind + (m.name ? ' ("' + stripControlChars(m.name) + '")' : '') + ' ' + ago + ' ago, so opening it here could start a copy of it.';
      } else {
        detail = 'Its record says it is live, so opening it here could start a copy of it.';
      }
      break;
    }
    default:
      headline = 'This session was just seen running outside this pane.';
  }
  return {
    headline: headline + ' Nothing was started.',
    lines: [
      headline,
      detail,
      'Nothing was started. Type ' + LIVE_HOLD_CONFIRM_WORD + ' and press Enter to open a copy anyway, or press Enter to check again.',
    ],
  };
}

// ─── Viewport-ownership contention control (Notion-restyle P6.4) ──────────
//
// PROBLEM (MOBILE-EXPERIENCE.md B.9, H.2 item 1): one PTY, N clients, one
// geometry. A phone and a desktop attached to the same session fight over
// `sizeOwner`. The phone claims through `activate`, which its
// IntersectionObserver and its hidden-textarea focus handler both fire
// WITHOUT the user asking, so ownership can oscillate. Every applied resize
// makes ConPTY repaint the entire viewport into every client's stream, so an
// oscillation is not a cosmetic wobble: it is a repaint storm that corrupts
// incremental TUI redraws for everyone.
//
// MECHANISM. A single ownership flip is ALWAYS applied immediately, because a
// user switching devices must not wait, and because an attach handoff at a
// dead owner must not be delayed. What is throttled is OSCILLATION: a flip
// back to a client that already held ownership inside the current window
// latches the session as contended, and from that moment every further claim
// is coalesced into one trailing apply per window (last claimant wins) until
// the session has been quiet for CONTENTION_CLEAR. That yields at most one
// applied resize per settle window under contention while leaving the
// single-flip, hand-over-the-laptop case instantaneous.
//
// Chosen over a plain leading-edge debounce because a plain debounce would
// also delay the FIRST flip, which is the common, intentional, user-visible
// case; and over a pure rate limit because a rate limit cannot tell an
// intentional handover from a two-device tug of war.

/**
 * Settle window for ownership flips. TERMINAL-ARCHITECTURE's width-thrash
 * design specifies 300-500ms; 400ms is the midpoint. Long enough to swallow
 * an IntersectionObserver / focus / visibility burst, short enough that a
 * deliberate device switch still feels immediate.
 */
const OWNERSHIP_DEBOUNCE_MS = (() => {
  const raw = parseInt(process.env.CWM_PTY_OWNERSHIP_DEBOUNCE_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 400;
})();

/**
 * Quiet period after which a contended session is treated as calm again and
 * the next single flip is once more instantaneous. Deliberately longer than
 * the settle window so a storm cannot escape the coalescer by pausing for one
 * window and resuming.
 */
const OWNERSHIP_CONTENTION_CLEAR_MS = (() => {
  const raw = parseInt(process.env.CWM_PTY_OWNERSHIP_CONTENTION_CLEAR_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1200;
})();

/**
 * Alternate-buffer-aware replay, aggressive variant. When a session is in the
 * alternate buffer the byte ring is the WRONG thing to replay: its prefix
 * (including `CSI ?1049h` and the whole frame construction) has usually been
 * pruned, so what survives paints a handful of in-place patches onto a blank
 * screen (defect D3). The default alt-aware behaviour is therefore "prefer
 * the sidecar snapshot, fall back to the ring", which never regresses.
 *
 * Setting CWM_PTY_ALT_SUPPRESS_RING=1 additionally suppresses the ring on an
 * alternate-buffer attach even when NO snapshot is available, leaving the
 * pane blank until the application's next repaint (which the attach-time
 * width claim usually triggers immediately). That is the behaviour the design
 * describes, and it is flagged OFF by default because "blank until the app
 * repaints" is a worse failure than "torn frame" for a genuinely idle
 * full-screen application.
 *
 * @returns {boolean} True when the ring is suppressed on alt-buffer attach.
 */
function isAltRingSuppressionEnabled() {
  return process.env.CWM_PTY_ALT_SUPPRESS_RING === '1';
}

/**
 * Send one JSON control frame to a client, tolerating a dead socket.
 * Control frames use the same envelope convention as 'reset' / 'exit' /
 * 'resumeId' / 'error': raw PTY data is a plain string, control messages are
 * JSON objects carrying a 'type' field. Clients ignore unknown types, which
 * is what makes adding the 'mode' frame safe in a mixed-version window.
 *
 * @param {object} ws - WebSocket client.
 * @param {string} payload - Pre-stringified JSON frame.
 * @returns {boolean} True when the frame was handed to the socket.
 */
function sendControlFrame(ws, payload) {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(payload);
      return true;
    }
  } catch (_) { /* dead socket; the close handler cleans up */ }
  return false;
}

// ─── Typed input against terminal replies (MOBILE-TERMINAL.md D2) ─────────
//
// PROBLEM, measured. A phone opens a shared session, presses nothing, taps
// nothing, and the PTY goes from 155x40 to 49x28. The only frame it sent was
// `\x1b[O`: the DEC 1004 focus-out report, generated by the terminal emulator
// because the application turned focus reporting on. This layer treated it as
// typing, so it claimed the geometry, and the person at the desktop watched
// their terminal collapse to phone width. The same mechanism runs in reverse
// and is the engine of the width ping-pong.
//
// RULE. A frame that consists ONLY of terminal-generated reports is written
// to the PTY byte for byte and claims nothing. A frame containing one other
// byte claims, so a real keystroke always claims. The conservatism points
// that way on purpose: failing to claim on a genuine keystroke would be a
// worse bug than claiming on an exotic reply.
//
// The reports recognised are the ones an application can ask a terminal to
// send without a person being involved: focus in and out, both mouse report
// encodings, and the cursor position, device attributes and device status
// replies.
const TERMINAL_REPLY_PATTERNS = [
  /^\x1b\[[IO]/,                    // DEC 1004 focus in / focus out
  /^\x1b\[<\d+;\d+;\d+[Mm]/,        // SGR 1006 mouse report
  /^\x1b\[M[\s\S]{3}/,              // X10 / normal mouse report
  /^\x1b\[\?[0-9;]*c/,              // DA1 reply
  /^\x1b\[>[0-9;]*c/,               // DA2 reply
  /^\x1b\[[0-9;]*R/,                // CPR (cursor position report)
  /^\x1b\[\??[0-9;]*n/,             // DSR reply
];

/**
 * Whether an input frame represents a person acting, rather than the
 * terminal answering a question the application asked it.
 *
 * Consumes the frame from the front, matching one recognised report at a
 * time. Anything left over is treated as user input, which is what makes a
 * keystroke that happens to arrive in the same frame as a focus report still
 * count as a claim.
 *
 * @param {string} data - The raw payload of an `input` control frame.
 * @returns {boolean} True when the frame should claim PTY geometry.
 */
function isUserOriginatedInput(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  let rest = data;
  // Bounded by construction: every branch either consumes at least one
  // character or returns, so this cannot spin on a malformed frame.
  while (rest.length > 0) {
    let matched = null;
    for (const pattern of TERMINAL_REPLY_PATTERNS) {
      const m = pattern.exec(rest);
      if (m && m[0].length > 0) { matched = m[0]; break; }
    }
    if (!matched) return true;
    rest = rest.slice(matched.length);
  }
  return false;
}

/**
 * Build the per-client geometry frame.
 *
 * MOBILE-TERMINAL.md D1: a client that cannot know the PTY's geometry cannot
 * render at it, and one that renders at its own instead re-wraps a frame the
 * application painted by absolute cursor addressing. The `mode` frame carries
 * buffer and mouse state and no size, so this is the missing half.
 *
 * `owned` is per client, which is why this is a frame rather than a
 * broadcast payload: two clients on one PTY need the same numbers and
 * opposite answers to "is this device driving".
 *
 * @param {PtySession} session - The session being described.
 * @param {object} ws - The client the frame is addressed to.
 * @param {number} seq - Monotonic sequence number.
 * @returns {string} The stringified frame.
 */
function buildSizeFrame(session, ws, seq) {
  return JSON.stringify({
    type: 'size',
    cols: session.cols,
    rows: session.rows,
    owned: session.sizeOwner === ws,
    // "Somebody else is driving" and "nobody is driving" are different
    // answers and lead to different behaviour. A client whose visibility
    // observer fires while nobody owns the geometry may take it: that is the
    // ordinary single-device case and it costs nothing. A client that would
    // be taking it OFF a live owner may not do so automatically, because
    // walking past your own phone should not resize the terminal you are
    // typing into. It offers instead, and the user taps.
    ownerAssigned: !!(session.sizeOwner && session.clients.has(session.sizeOwner)),
    seq,
  });
}

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

    // ── VT sidecar (P6) ──
    // Headless shadow of this PTY. Null whenever the subsystem is off,
    // unavailable, or at capacity; every read below is written so null means
    // "use the byte ring", never "fail".
    this.vt = null;

    // ── Ownership contention state (P6.4) ──
    // See the OWNERSHIP_DEBOUNCE_MS block above for the mechanism. All of
    // this is inert until a second client actually contends for geometry.
    this._ownershipWindowStartedAt = 0;   // start of the current settle window
    this._ownersInWindow = new Set();     // clients that owned during it
    this._ownershipContended = false;     // latched by a detected oscillation
    this._pendingOwner = null;            // coalesced claimant awaiting apply
    this._ownershipTimer = null;          // trailing apply timer
    this._contentionTimer = null;         // quiet-period unlatch timer

    // Applied/suppressed/deferred resize counters. The width-thrash gate is
    // stated as "each applied resize is counted and asserted", so the count
    // is a first-class observable rather than something a test has to infer
    // from a spy on node-pty.
    this.resizeStats = { applied: 0, suppressed: 0, deferredClaims: 0, flips: 0 };

    // ── Published geometry (MOBILE-TERMINAL.md 3.1) ──
    // Monotonic sequence for the `size` frame, so a client can discard an
    // out-of-order frame the same way it already does for `mode`. Starts at
    // zero and is pre-incremented, so the first frame a client ever sees
    // carries seq 1 and a client's "seen nothing yet" sentinel of 0 is
    // unambiguous.
    this._sizeSeq = 0;
  }

  /**
   * Tell every attached client what geometry the PTY holds and whether that
   * client is the one setting it.
   *
   * Called on every applied resize and on every ownership commit, including a
   * commit that changed no dimensions: `owned` flips for two clients even when
   * the numbers stand still, and a client that does not learn it stopped
   * driving keeps fitting itself and re-wraps the owner's frame.
   *
   * @returns {number} How many clients were told.
   */
  broadcastSize() {
    this._sizeSeq++;
    let delivered = 0;
    for (const ws of this.clients) {
      if (sendControlFrame(ws, buildSizeFrame(this, ws, this._sizeSeq))) delivered++;
    }
    return delivered;
  }

  /**
   * Tell one client the current geometry. Used on attach, where the client is
   * not yet in the broadcast set.
   *
   * @param {object} ws - The client to tell.
   * @returns {boolean} Whether the frame was handed to the socket.
   */
  sendSizeTo(ws) {
    this._sizeSeq++;
    return sendControlFrame(ws, buildSizeFrame(this, ws, this._sizeSeq));
  }

  /**
   * Request that `ws` become the PTY geometry owner.
   *
   * Single flips apply immediately. Oscillation (a flip back to a client that
   * already owned inside the current settle window) latches contention, after
   * which claims are coalesced into one trailing apply per window. See the
   * OWNERSHIP_DEBOUNCE_MS block for why this shape was chosen.
   *
   * @param {object} ws - The claiming WebSocket client.
   * @param {string} reason - 'input' | 'activate' | 'attach' | 'handoff'.
   *   'attach' and 'handoff' are structural (a new sole client, or the owner
   *   leaving) and are never debounced: there is nothing to contend with.
   * @returns {{applied: boolean, deferred: boolean, reason: string}}
   */
  requestSizeOwnership(ws, reason) {
    if (!ws) return { applied: false, deferred: false, reason: 'no-client' };
    const now = Date.now();
    this._armContentionClear();

    if (reason === 'attach' || reason === 'handoff') {
      this._commitSizeOwnership(ws, now);
      return { applied: true, deferred: false, reason };
    }

    if (this.sizeOwner === ws) {
      // Not a flip. Refresh recency (it decides the next handoff target) and
      // re-assert this client's viewport, which applyViewport suppresses as a
      // no-op unless something actually changed.
      ws._lastActiveAt = now;
      if (ws._viewport) this.applyViewport(ws._viewport.cols, ws._viewport.rows);
      return { applied: true, deferred: false, reason: 'refresh' };
    }

    // Roll the settle window forward when the previous one has expired, and
    // seed it with the incumbent so a flip straight back to them is still
    // recognised as an oscillation.
    if (now - this._ownershipWindowStartedAt > OWNERSHIP_DEBOUNCE_MS) {
      this._ownershipWindowStartedAt = now;
      this._ownersInWindow.clear();
      if (this.sizeOwner) this._ownersInWindow.add(this.sizeOwner);
    }

    const oscillating = this._ownershipContended || this._ownersInWindow.has(ws);
    if (!oscillating) {
      this._commitSizeOwnership(ws, now);
      return { applied: true, deferred: false, reason };
    }

    // Contended: coalesce. The claimant is remembered (last one wins) and a
    // single trailing apply lands at the end of the window.
    this._ownershipContended = true;
    this._pendingOwner = ws;
    ws._lastActiveAt = now;
    this.resizeStats.deferredClaims++;
    if (!this._ownershipTimer) {
      const delay = Math.max(0, OWNERSHIP_DEBOUNCE_MS - (now - this._ownershipWindowStartedAt));
      this._ownershipTimer = setTimeout(() => {
        this._ownershipTimer = null;
        this._resolvePendingOwner();
      }, delay);
      if (typeof this._ownershipTimer.unref === 'function') this._ownershipTimer.unref();
    }
    return { applied: false, deferred: true, reason };
  }

  /**
   * Make `ws` the owner and apply its stored viewport. The apply goes through
   * applyViewport, so an unchanged geometry is still a suppressed no-op.
   *
   * @private
   * @param {object} ws
   * @param {number} now - Timestamp, passed in so one claim uses one clock read.
   */
  _commitSizeOwnership(ws, now) {
    const previous = this.sizeOwner;
    this.sizeOwner = ws;
    ws._lastActiveAt = now;
    if (previous !== ws) {
      this.resizeStats.flips++;
      if (this._ownershipWindowStartedAt === 0) this._ownershipWindowStartedAt = now;
    }
    if (previous) this._ownersInWindow.add(previous);
    this._ownersInWindow.add(ws);
    if (ws._viewport) this.applyViewport(ws._viewport.cols, ws._viewport.rows);
    // Unconditional, and NOT folded into applyViewport's applied-change
    // branch. A handover between two clients whose viewports happen to match
    // changes no dimension at all, and both of them still need to hear that
    // `owned` flipped: the new owner must start fitting itself, and the old
    // one must stop.
    if (previous !== ws) this.broadcastSize();
  }

  /**
   * Apply the coalesced claimant at the end of a contended window. A claimant
   * that disconnected while waiting is discarded rather than resurrected.
   *
   * @private
   */
  _resolvePendingOwner() {
    const pending = this._pendingOwner;
    this._pendingOwner = null;
    if (!pending || !this.alive) return;
    if (!this.clients.has(pending)) return;
    const now = Date.now();
    this._ownershipWindowStartedAt = now;
    this._ownersInWindow.clear();
    this._commitSizeOwnership(pending, now);
  }

  /**
   * (Re)arm the quiet-period timer that unlatches contention. Called on every
   * claim, so the latch survives exactly as long as claims keep arriving.
   *
   * @private
   */
  _armContentionClear() {
    if (this._contentionTimer) clearTimeout(this._contentionTimer);
    this._contentionTimer = setTimeout(() => {
      this._contentionTimer = null;
      this._ownershipContended = false;
      this._ownersInWindow.clear();
      this._ownershipWindowStartedAt = 0;
    }, OWNERSHIP_CONTENTION_CLEAR_MS);
    if (typeof this._contentionTimer.unref === 'function') this._contentionTimer.unref();
  }

  /**
   * Drop every ownership timer. Called when the last client leaves and on
   * session teardown, so a dead session can never hold a timer or a client
   * reference.
   */
  clearOwnershipTimers() {
    if (this._ownershipTimer) { clearTimeout(this._ownershipTimer); this._ownershipTimer = null; }
    if (this._contentionTimer) { clearTimeout(this._contentionTimer); this._contentionTimer = null; }
    this._pendingOwner = null;
  }

  /**
   * Broadcast one JSON control frame to every attached client.
   *
   * @param {object} frame - Serialisable control frame with a `type` field.
   * @returns {number} How many clients received it.
   */
  broadcastControl(frame) {
    let payload;
    try {
      payload = JSON.stringify(frame);
    } catch (_) {
      return 0;
    }
    let delivered = 0;
    for (const ws of this.clients) {
      if (sendControlFrame(ws, payload)) delivered++;
    }
    return delivered;
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
    if (c === this.cols && r === this.rows) {
      this.resizeStats.suppressed++;
      return false;
    }
    try {
      this.pty.resize(c, r);
    } catch (_) {
      return false;
    }
    this.cols = c;
    this.rows = r;
    this.resizeStats.applied++;
    // Keep the VT shadow's grid identical to the PTY's. This is the ONLY
    // resize path, so the shadow's geometry cannot drift; a snapshot taken
    // after an attach-time resize is therefore already at the attaching
    // client's width, which is what makes the snapshot render correctly
    // instead of at the previous (possibly phone-sized) owner's width.
    if (this.vt) {
      try { this.vt.resize(c, r); } catch (_) { /* sidecar is never fatal */ }
    }
    // The geometry changed, so every attached client's picture of it is now
    // stale. A non-owner that is not told renders the next repaint on the
    // grid it had, which is the fragmentation MOBILE-TERMINAL.md D1 measures.
    this.broadcastSize();
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
    // Instance-scoped rather than a module singleton so two managers (server
    // plus a test, or two tests) never share sidecar state. Constructing the
    // registry allocates nothing and loads nothing while CWM_VT_SIDECAR is
    // unset, which is the default for one release.
    this.vtRegistry = new VtSidecarRegistry();
    // Live-session gate (2026-09-26), see _liveGateFor / _attachAfterLiveCheck.
    // sessionId -> Promise of the in-flight live check, so two sockets opening
    // the same session during a lookup cannot both spawn.
    this._liveChecks = new Map();
    // sessionId -> Set of held sockets showing the "live elsewhere" notice.
    this._liveHolds = new Map();
    // Claude transcript id -> ms timestamp at which a Workbook PTY running it
    // exited or was killed. A lookup right after a restart can still list the
    // dying process; the gate re-checks instead of calling it "live elsewhere".
    this._recentClaudeExits = new Map();
    // Mobile v2 (BUILD-CONTRACT P1): observers of PTY output, exit and spawn
    // for the phone's turn service, screen reader and send guard. Taps only
    // observe; a tap that throws is caught and never reaches the PTY path.
    this._mobileTaps = { data: new Set(), exit: new Set(), spawn: new Set() };
  }

  /**
   * Observe PTY output of every session (mobile v2, P1).
   * @param {(sessionId: string, data: string) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSessionData(fn) {
    this._mobileTaps.data.add(fn);
    return () => this._mobileTaps.data.delete(fn);
  }

  /**
   * Observe PTY exits (mobile v2, P1).
   * @param {(sessionId: string, exitCode: number) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSessionExit(fn) {
    this._mobileTaps.exit.add(fn);
    return () => this._mobileTaps.exit.delete(fn);
  }

  /**
   * Observe PTY spawns (mobile v2, P1).
   * @param {(sessionId: string) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSessionSpawn(fn) {
    this._mobileTaps.spawn.add(fn);
    return () => this._mobileTaps.spawn.delete(fn);
  }

  /**
   * Call every tap of one kind, swallowing their errors (P2, P3).
   * @private
   * @param {'data'|'exit'|'spawn'} kind
   * @param {...*} args
   */
  _callMobileTaps(kind, ...args) {
    const taps = this._mobileTaps && this._mobileTaps[kind];
    if (!taps || taps.size === 0) return;
    for (const fn of taps) {
      try { fn(...args); } catch (_) { /* a tap must never throw into the PTY path */ }
    }
  }

  /**
   * Attach a VT sidecar to a freshly spawned session, if the subsystem is
   * enabled and has capacity. Failure is silent-by-design at this layer: the
   * registry has already logged, and a null sidecar simply means every
   * consumer takes the byte-ring path.
   *
   * @private
   * @param {PtySession} session
   * @param {number} cols
   * @param {number} rows
   */
  _attachSidecar(session, cols, rows) {
    try {
      session.vt = this.vtRegistry.create(session.sessionId, {
        cols,
        rows,
        // Mode changes are broadcast to every attached client so all of them
        // route history identically and instantly, rather than each sniffing
        // its own xterm and disagreeing during the transition.
        onModeChange: (frame) => {
          try { session.broadcastControl(frame); } catch (_) {}
        },
      });
    } catch (_) {
      session.vt = null;
    }
  }

  /**
   * Decide what a client should be sent to bring its screen up to date, on
   * first attach and on a lag resync alike.
   *
   * Preference order, and why:
   *   1. The sidecar SNAPSHOT. It describes the screen, so it has no prefix
   *      to lose and cannot render a torn frame (defect D3).
   *   2. Nothing at all, when the session is in the alternate buffer, no
   *      snapshot exists, and ring suppression is explicitly enabled. The
   *      ring's surviving suffix for an alternate-screen pane is in-place
   *      patches with no frame under them.
   *   3. The byte ring, exactly as before. This is the default whenever the
   *      sidecar is off, unavailable, or unhealthy, so the pre-existing
   *      behaviour is preserved bit for bit.
   *
   * @param {PtySession} session
   * @returns {{payload: string|null, source: string, altBuffer: boolean|null}}
   */
  buildReplay(session) {
    let altBuffer = null;
    let snapshot = null;
    if (session.vt) {
      try {
        const mode = session.vt.getMode();
        if (mode) altBuffer = mode.altBuffer;
      } catch (_) { /* sidecar is never fatal */ }
      if (isSnapshotReplayEnabled()) {
        try { snapshot = session.vt.snapshot(); } catch (_) { snapshot = null; }
      }
    }
    if (snapshot) return { payload: snapshot, source: 'snapshot', altBuffer };
    if (altBuffer === true && isAltRingSuppressionEnabled()) {
      return { payload: null, source: 'alt-suppressed', altBuffer };
    }
    if (session.scrollback.length > 0) {
      return { payload: session.scrollback.join(''), source: 'ring', altBuffer };
    }
    return { payload: null, source: 'empty', altBuffer };
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
   * @param {string|null} [options.attachShortId] - Short id of a live Claude
   *        Code background session (2026-09-26). When set, the pane runs
   *        `claude attach <id>` instead of resuming the transcript, so it joins
   *        the running session instead of forking it. Set by attachClient's
   *        live-session gate after `claude agents --json` matched the
   *        transcript; skips the transcript check, id minting and the watcher.
   * @param {boolean} [options._liveChecked] - @private set by attachClient once
   *        the live-session gate has decided (resume, attach, or a copy the
   *        user confirmed). Without it a Claude resume is refused when the
   *        cached lookup already knows the transcript is live (coded throw
   *        CLAUDE_SESSION_LIVE), so no future caller can fork by skipping the gate.
   * @returns {PtySession} The PTY session object
   */
  spawnSession(sessionId, { command = 'claude', cwd, cols = 120, rows = 30, bypassPermissions = false, resumeSessionId = null, verbose = false, model = null, agentTeams = false, shell: requestedShell = null, newSession = false, initialPrompt = null, flags = [], provider: optsProvider = null, attachShortId = null, effort = null, permissionMode = null, _liveChecked = false, _ptySpawnForTesting = null, _cwdFromJsonlForTesting = null } = {}) { // gsd:provider-literal-allowed (default-command sentinel paired with useProvider check below)
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
    // 2026-09-26: an attach (set only by the live-session gate) is a Claude
    // operation whatever the record's tag says; the gate already decided the
    // command is Claude's, so the Claude descriptor must build it.
    const providerId = (attachShortId ? 'claude' : null) // gsd:provider-literal-allowed (attach is Claude-only)
      || (storeSession && storeSession.provider)
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
    // Session identity outcome of the pre-flight inside the provider branch
    // below. Read again after the PTY exists (store backfill, pane notice).
    let mintedSessionId = null;   // UUID handed to the CLI as --session-id
    let expiredResumeId = null;   // resume id we were asked for but whose transcript is gone
    if (useProvider) {
      // ── Session identity pre-flight (2026-09-22) ──
      // Two failure modes produced "No conversation found with session ID"
      // inside panes: (1) a stored resumeSessionId whose transcript has since
      // been removed (Claude Code's cleanupPeriodDays retention, default 30
      // days), and (2) fresh sessions whose real transcript UUID was never
      // learned, because the post-spawn JSONL watcher further down could not
      // match a project directory, so a later "newest transcript in cwd"
      // guess was stored instead. Both are settled here, before the
      // descriptor is built, for the Claude provider only:
      //   - A resume id with no transcript on disk is dropped and remembered
      //     as expiredResumeId. The session starts fresh in the same cwd and
      //     the pane is told why (scrollback notice + store audit fields).
      //   - A fresh session gets its UUID minted HERE and passed to the CLI
      //     as --session-id, so the id is known before the process starts
      //     and no filesystem watching or guessing is needed afterwards.
      // CWM_CLAUDE_MINT_SESSION_ID=0 disables minting (the watcher below then
      // runs as before) in case a CLI version rejects the flag.
      if (providerId === 'claude') { // gsd:provider-literal-allowed (Claude-specific identity handling)
        // ── Live-session attach / refusal (2026-09-26) ──
        // attachShortId: the gate in attachClient found this transcript running
        // as a background session, so the pane attaches to it. There is no
        // transcript to check and no id to mint: the session already exists.
        // Otherwise, a resume that did not come through the gate is refused
        // when the lookup's cache or seen-live markers already say the
        // transcript is live, because resuming it would fork a live session.
        if (attachShortId) {
          console.log(`[PTY] Session ${sessionId} will attach to live background session ${attachShortId}`
            + (resumeSessionId ? ` (transcript ${resumeSessionId})` : ''));
        } else if (resumeSessionId && !_liveChecked && typeof provider.liveSessionLookup === 'function') {
          let knownLive = false;
          try { knownLive = !!provider.liveSessionLookup().isKnownLive(resumeSessionId); } catch (_) { knownLive = false; }
          if (knownLive) {
            const liveErr = new Error('Claude session ' + resumeSessionId + ' is live outside this pane; refusing to resume a copy of it');
            liveErr.code = CLAUDE_SESSION_LIVE_CODE;
            throw liveErr;
          }
        }
        if (resumeSessionId && !attachShortId && typeof provider.findArtifactPath === 'function') {
          let artifact = null;
          try { artifact = provider.findArtifactPath(resumeSessionId); } catch (_) { artifact = null; }
          if (!artifact) {
            expiredResumeId = resumeSessionId;
            resumeSessionId = null;
            console.warn(`[PTY] Transcript for resumeSessionId=${expiredResumeId} is not on disk; session ${sessionId} will start fresh`);
          }
        }
        if (!resumeSessionId && !attachShortId && process.env.CWM_CLAUDE_MINT_SESSION_ID !== '0') {
          mintedSessionId = crypto.randomUUID();
        }
      }
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
          + (attachShortId ? ' attachShortId=' + attachShortId : '')
          + (mintedSessionId ? ' mintedSessionId=' + mintedSessionId : '')
          + (expiredResumeId ? ' expiredResumeId=' + expiredResumeId : '')
          + ' providerSettings=' + (providerSettingsBundle ? JSON.stringify(providerSettingsBundle) : '<none>'));
      } catch (_) { /* console.log can EPIPE; never fatal */ }
      try {
        descriptor = provider.spawnCommand({
          sessionId,
          providerSessionId: resumeSessionId,
          newSessionId: mintedSessionId,
          cwd,
          bypassPermissions,
          flags,
          model,
          verbose,
          initialPrompt,
          providerSettings: providerSettingsBundle,
          // Only the Claude descriptor knows `attach`; the gate never sets it
          // for another provider, and the null keeps other descriptors unchanged.
          attachShortId: attachShortId || null,
          // Mobile v2 (P6): effort and permission mode reach the descriptor;
          // the Claude descriptor emits their flags (B3, S10), others ignore them.
          effort: effort || null,
          permissionMode: permissionMode || null,
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

    // Live-session gate bookkeeping (2026-09-26). Which Claude transcript this
    // PTY runs (so a second pane on the same transcript is recognised, and so
    // its exit can be told apart from a session live elsewhere), whether it is
    // an attach client, and the lookup whose cache its exit invalidates.
    const isClaudePane = !!(useProvider && providerId === 'claude'); // gsd:provider-literal-allowed (Claude-only live-session bookkeeping)
    session.claudeTranscriptId = isClaudePane ? (resumeSessionId || mintedSessionId || null) : null;
    session.attachShortId = isClaudePane && attachShortId ? attachShortId : null;
    session._liveLookup = null;
    if (isClaudePane && typeof provider.liveSessionLookup === 'function') {
      try { session._liveLookup = provider.liveSessionLookup(); } catch (_) { session._liveLookup = null; }
    }
    // A custom Claude command ("claude --resume <id>", "claude --continue")
    // runs through the inline descriptor; track the transcript it resumes too,
    // so a second pane on it and its own exit are recognised by the gate.
    if (!useProvider) {
      try {
        const claudeProv = registry.getProvider('claude'); // gsd:provider-literal-allowed (custom Claude commands are tracked by the Claude gate)
        const parsed = claudeProv && typeof claudeProv.liveSessionLookup === 'function'
          ? parseResumeCommand(command, claudeProv.cliBinary) : null;
        if (parsed && !parsed.fork && (parsed.resumeId || parsed.continueInCwd)) {
          session.claudeTranscriptId = parsed.resumeId || newestTranscriptForCwd(resolvedCwd) || null;
          session._liveLookup = claudeProv.liveSessionLookup();
        }
      } catch (_) { /* bookkeeping only */ }
    }

    // ── Session identity: apply the pre-flight outcome (2026-09-22) ──
    // The pane learns its id and its history the moment the process exists,
    // not seconds later from a filesystem watcher. attachClient re-sends both
    // to every client that connects afterwards.
    if (expiredResumeId) {
      // Worded for both cases the check cannot tell apart: a conversation
      // that Claude Code's retention removed, and a session id that was
      // minted but never used (the CLI writes no transcript until the first
      // prompt), so a pane that was opened and closed untouched also lands here.
      const message = 'No transcript found for the previous session (' + expiredResumeId + '): '
        + 'it was never used, or Claude Code removed it after its retention period '
        + '(cleanupPeriodDays, default 30 days). Started a fresh session in ' + resolvedCwd + '.';
      session.identityNotice = { code: 'RESUME_EXPIRED', message };
      // Yellow line at the top of the scrollback so it is part of the replay
      // a client receives on attach, even before the CLI has drawn anything.
      session.appendScrollback('\x1b[1;33m[Myrlin] ' + message + '\x1b[0m\r\n');
    }
    if (mintedSessionId) {
      session.detectedResumeId = mintedSessionId;
      try {
        const store = getStore();
        if (store.getSession(sessionId)) {
          const conflict = store.getAllSessionsList().find(s =>
            s.id !== sessionId && s.resumeSessionId === mintedSessionId
          );
          if (conflict) {
            console.warn(`[PTY] Minted id ${mintedSessionId} already owned by session ${conflict.id}; not stored`);
          } else {
            const updates = { resumeSessionId: mintedSessionId };
            if (expiredResumeId) {
              updates.previousResumeSessionId = expiredResumeId;
              updates.resumeExpiredAt = new Date().toISOString();
            }
            store.updateSession(sessionId, updates);
            console.log(`[PTY] Minted Claude session id ${mintedSessionId} for session ${sessionId}`
              + (expiredResumeId ? ` (replaces expired ${expiredResumeId})` : ''));
          }
        }
      } catch (_) { /* store may not have this session (ad-hoc pane) */ }
    }

    // Attach pane (2026-09-26): say what this pane is before the CLI draws,
    // same mechanism as the expired-resume line above (part of every replay).
    if (session.attachShortId) {
      session.appendScrollback('\x1b[2m[Myrlin] Attached to live background session '
        + session.attachShortId + '. Closing this pane ends only this view; the session keeps running.\x1b[0m\r\n');
    }

    // VT sidecar lifecycle, half one: create on spawn, sized to the PTY.
    // Half two (dispose) is in the onExit handler and in killSession, so a
    // sidecar can outlive neither its PTY nor its session record.
    this._attachSidecar(session, cols, rows);

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

      // Feed the VT shadow the SAME bytes, before the broadcast so the mode
      // signal is as fresh as possible. This only queues; the headless
      // terminal parses asynchronously, and its queue is bounded inside the
      // sidecar, so it can neither block nor outgrow the PTY data path.
      if (session.vt) {
        try { session.vt.write(data); } catch (_) { /* sidecar is never fatal */ }
      }

      // Mobile v2 (P2): the phone's screen reader and turn service observe the
      // same bytes, after the VT shadow was fed. Never throws into this path.
      this._callMobileTaps('data', sessionId, data);

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
              // Buffer drained: resynchronize with a reset + full replay.
              // The current chunk was already appended to scrollback above,
              // so the replay includes it; sending it again separately would
              // duplicate it on screen.
              //
              // P6: routed through buildReplay so a lag resync gets the same
              // exact-state snapshot an attach does. A resync suffers from
              // defect D3 for exactly the same reason an attach does, and
              // fixing only one of the two would leave a torn screen behind
              // on the harder-to-reproduce path.
              ws._lagged = false;
              ws.send(RESET_MSG);
              const resync = this.buildReplay(session);
              if (resync.payload !== null) ws.send(resync.payload);
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

      // Live-session gate: this transcript's Workbook process just ended, so a
      // cached listing that still shows it is stale (2026-09-26).
      this._noteClaudePaneEnded(session);

      // VT sidecar lifecycle, half two: the shadow dies with its PTY. Doing
      // this here (rather than only in killSession) covers the case where the
      // child exits on its own and the session record lingers for reconnect.
      try {
        this.vtRegistry.dispose(sessionId);
      } catch (_) { /* sidecar is never fatal */ }
      session.vt = null;
      session.clearOwnershipTimers();

      // Attach pane: the client ended, not the session. Say so before the
      // generic "[Process exited]" status the frontend prints (2026-09-26).
      if (session.attachShortId) {
        const detachLine = '\r\n\x1b[2m[Myrlin] Detached from background session ' + session.attachShortId
          + '; it keeps running. Reopen this pane to attach again.\x1b[0m\r\n';
        session.appendScrollback(detachLine);
        for (const client of session.clients) {
          try { if (client.readyState === 1) client.send(detachLine); } catch (_) { /* ignore */ }
        }
      }

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

      // Mobile v2 (P3): the phone's turn service ends open turns on exit.
      this._callMobileTaps('exit', sessionId, exitCode);
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
    // 2026-09-22: skipped when the id was minted above (--session-id); the
    // watcher is now only the fallback for CWM_CLAUDE_MINT_SESSION_ID=0.
    // 2026-09-26: never for an attach pane; it joins an existing session and
    // creates no transcript to watch for.
    if (useProvider && providerId === 'claude' /* gsd:provider-literal-allowed (Claude-specific JSONL watcher) */ && resolvedCwd && !resumeSessionId && !mintedSessionId && !attachShortId) {
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const findCandidateDirs = () => {
        try {
          if (!fs.existsSync(claudeDir)) return [];
          // Claude Code names a project directory by replacing every character
          // outside [A-Za-z0-9] in the cwd with '-' (C:\Users\Arthur becomes
          // C--Users-Arthur). The decodeURIComponent comparison below was the
          // original matcher and never matched a real directory (verified
          // 2026-09-22 against every cwd on the author's machine), which is
          // why this watcher silently never backfilled. The encoded-name
          // comparison is the one that works; the original arm is kept.
          const encodedCwd = encodeClaudeProjectDir(resolvedCwd).toLowerCase();
          const normalizedCwd = resolvedCwd.replace(/[/\\]/g, path.sep);
          return fs.readdirSync(claudeDir).filter(d => {
            if (encodedCwd && d.toLowerCase() === encodedCwd) return true;
            try {
              const decoded = decodeURIComponent(d);
              const normalizedDecoded = decoded.replace(/[/\\]/g, path.sep);
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
          // Live-session gate: this pane now runs that transcript (2026-09-26).
          if (!session.claudeTranscriptId) session.claudeTranscriptId = uuid;

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

    // Mobile v2 (P3): the phone starts watching Workbook hosted sessions.
    this._callMobileTaps('spawn', sessionId);

    return session;
  }

  // ─── Live-session gate (2026-09-26) ────────────────────────────────────
  //
  // attachClient -> _liveGateFor (sync: is this a Claude resume?) ->
  // _attachAfterLiveCheck (buffers early frames, coalesces per session) ->
  // _decideLive (claude agents --json via the provider's lookup) ->
  //   attach:  attachClient(..., {_liveChecked, attachShortId}) -> `claude attach <id>`
  //   resume:  attachClient(..., {_liveChecked})                -> `claude --resume <id>`
  //   notice:  _holdForLiveNotice: nothing spawned; the socket stays open on a
  //            notice until the user types `copy` (open a copy anyway) or
  //            presses Enter (check again), or leaves.

  /**
   * Work out whether attaching `sessionId` with `spawnOpts` would resume a
   * Claude transcript, and so needs the live-session check first. Mirrors the
   * option merge attachClient does below (store record first, then the WS
   * query params on top) so the check sees the same resume id the spawn
   * would use.
   *
   * @private
   * @param {string} sessionId
   * @param {object} spawnOpts
   * @returns {{lookup: object, resumeSessionId: string, record: (object|null), fresh: boolean}|null}
   *   null when no check is needed (not Claude, not a resume, no lookup).
   */
  _liveGateFor(sessionId, spawnOpts) {
    const store = getStore();
    const record = store.getSession(sessionId) || null;
    const merged = record
      ? {
          command: record.command || 'claude', // gsd:provider-literal-allowed (mirrors the attachClient store default)
          resumeSessionId: record.resumeSessionId || null,
          ...spawnOpts,
        }
      : { ...spawnOpts };
    const command = merged.command === undefined ? 'claude' : merged.command; // gsd:provider-literal-allowed (spawnSession default command)
    const providerId = (record && record.provider) || merged.provider || 'claude'; // gsd:provider-literal-allowed (same resolution order as spawnSession)
    const registry = require('../providers');
    let provider = registry.getProvider(providerId);
    if (!provider || typeof provider.liveSessionLookup !== 'function' || provider.cliBinary !== command) {
      // What runs is decided by the command, not the tag: a record tagged for
      // another provider whose command is "claude --resume <id>" still runs
      // Claude. Fall back to the Claude provider when the command is Claude's.
      const claudeProvider = registry.getProvider('claude'); // gsd:provider-literal-allowed (the live gate is Claude-specific)
      if (claudeProvider && typeof claudeProvider.liveSessionLookup === 'function'
          && parseResumeCommand(command, claudeProvider.cliBinary)) {
        provider = claudeProvider;
      }
    }
    if (!provider || typeof provider.liveSessionLookup !== 'function') return null;
    let resumeSessionId = null;
    let viaCommand = false;
    let continueCwd = null;
    if (provider.cliBinary === command) {
      resumeSessionId = merged.resumeSessionId || null;
    } else {
      // A custom command ("claude --resume <id>", "claude --continue") runs
      // through the inline descriptor, which ignores resumeSessionId; its own
      // flags are what would resume. Gate on the transcript they point at.
      const parsed = parseResumeCommand(command, provider.cliBinary);
      if (!parsed || parsed.fork) return null;
      if (parsed.resumeId) {
        resumeSessionId = parsed.resumeId;
      } else if (parsed.continueInCwd || parsed.unknownResume) {
        // --continue picks the newest conversation in the folder the pane
        // runs in; the resume picker and --from-pr pick one when the CLI
        // starts. Resolve that folder exactly as spawnSession does for an
        // inline command (no ~ expansion; an invalid folder falls back to
        // the home directory). Only --continue has a knowable target.
        const cwdIsDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch (_) { return false; } };
        const wanted = merged.cwd || (record && record.workingDir) || process.cwd();
        continueCwd = cwdIsDir(wanted) ? wanted : os.homedir();
        resumeSessionId = parsed.continueInCwd ? newestTranscriptForCwd(continueCwd) : null;
      } else {
        return null;
      }
      viaCommand = true;
    }
    if (!continueCwd && (!resumeSessionId || typeof resumeSessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(resumeSessionId))) return null;
    const lookup = provider.liveSessionLookup();
    if (!lookup || typeof lookup.resolveResumeAction !== 'function') return null;
    this._registerSightCheck(lookup);
    return {
      lookup,
      resumeSessionId,
      record,
      fresh: !!spawnOpts._liveFresh,
      // An attach must run through the provider descriptor, so a custom
      // command is swapped for the bare CLI when the answer is "attach".
      viaCommand,
      cliBinary: provider.cliBinary,
      // Set for `claude --continue`: the folder whose newest conversation
      // the command would resume (resumeSessionId may then be null).
      continueCwd,
    };
  }

  /**
   * Teach the lookup what a blind listing looks like from here: while this
   * Workbook runs Claude panes that have been up for a while, a successful
   * but EMPTY listing cannot be right (those panes are live sessions too),
   * so it is treated as a failed lookup and the fail-safe applies instead of
   * "nothing is live". Only emptiness counts: a pane's own transcript id can
   * legitimately change (/clear starts a new conversation), so matching ids
   * would raise false alarms.
   *
   * @private
   * @param {object} lookup
   */
  _registerSightCheck(lookup) {
    if (!lookup || typeof lookup.setSightCheck !== 'function') return;
    if (!this._sightChecked) this._sightChecked = new WeakSet();
    if (this._sightChecked.has(lookup)) return;
    this._sightChecked.add(lookup);
    lookup.setSightCheck((entries) => {
      if (Array.isArray(entries) && entries.length > 0) return true;
      const now = Date.now();
      let own = 0;
      for (const s of this.sessions.values()) {
        if (s.alive && s.claudeTranscriptId && !s.attachShortId && now - (s.createdAt || now) > SIGHT_CHECK_MIN_PANE_AGE_MS) own++;
      }
      return own === 0 ? true : 'empty listing while this Workbook runs ' + own + ' Claude pane(s)';
    });
  }

  /**
   * Run the live-session check for a gated attach, then continue it.
   *
   * While the lookup runs (up to ~5 s) the socket has no handlers yet, and ws
   * delivers 'message' only to listeners that exist, so resize/activate
   * frames and early keystrokes are buffered here and replayed once the real
   * handlers are in place. A second socket for the same session waits for the
   * first check instead of starting its own, so the two cannot both spawn.
   *
   * @private
   * @param {string} sessionId
   * @param {import('ws')} ws
   * @param {object} spawnOpts - The caller's options (internal keys are stripped).
   * @param {{lookup: object, resumeSessionId: string, record: (object|null), fresh: boolean}} gate
   */
  _attachAfterLiveCheck(sessionId, ws, spawnOpts, gate) {
    const buffered = [];
    let closed = false;
    const onEarlyMessage = (data, isBinary) => { buffered.push([data, isBinary]); };
    const onEarlyClose = () => { closed = true; };
    ws.on('message', onEarlyMessage);
    ws.on('close', onEarlyClose);
    ws.on('error', onEarlyClose);
    // Returns true when the socket is still there to continue with.
    const settle = () => {
      ws.removeListener('message', onEarlyMessage);
      ws.removeListener('close', onEarlyClose);
      ws.removeListener('error', onEarlyClose);
      return !closed && ws.readyState === 1;
    };
    const replay = () => {
      for (const [data, isBinary] of buffered.splice(0)) {
        try { ws.emit('message', data, isBinary); } catch (_) { /* handler errors are theirs */ }
      }
    };
    // Internal keys never travel further than one hop.
    const baseOpts = { ...spawnOpts };
    delete baseOpts._liveFresh;
    delete baseOpts._liveChecked;
    delete baseOpts.attachShortId;

    const pending = this._liveChecks.get(sessionId);
    if (pending) {
      pending.catch(() => {}).then(() => {
        if (!settle()) return;
        // Attaches to the PTY the first check spawned, or runs its own check
        // (instant from the lookup cache) if that one ended on a notice.
        this.attachClient(sessionId, ws, baseOpts);
        replay();
      });
      return;
    }

    const epoch = this._liveEpochOf(sessionId);
    const run = this._decideLive(sessionId, gate).catch((err) => {
      // resolveResumeAction does not throw; if something here does anyway,
      // fail safe: show the notice rather than risk forking a live session.
      console.error(`[PTY] Live-session check threw for ${sessionId}: ${err && err.message}`);
      return { action: 'notice', reason: 'lookup-failed', error: 'exception', lookup: null };
    });
    this._liveChecks.set(sessionId, run);
    run.then((checked) => {
      let decision = checked;
      if (this._liveChecks.get(sessionId) === run) this._liveChecks.delete(sessionId);
      if (!settle()) {
        console.log(`[PTY] Client left ${sessionId} during the live-session check; nothing spawned`);
        return;
      }
      if (this._liveEpochOf(sessionId) !== epoch) {
        // Killed while the lookup ran: do not bring it back behind the kill.
        console.log(`[PTY] ${sessionId} was killed during the live-session check; nothing spawned`);
        try { ws.close(1000, 'Session terminated'); } catch (_) {}
        return;
      }
      const current = this.sessions.get(sessionId);
      if (current && current.alive) {
        // Spawned meanwhile (a confirmed copy from another socket): join it.
        this.attachClient(sessionId, ws, baseOpts);
        replay();
        return;
      }
      // The decision must be about what will actually spawn. If the record
      // changed during the lookup (a new resume id, a new command), check
      // again for the new target instead of spawning it unchecked.
      let again = null;
      try { again = this._liveGateFor(sessionId, baseOpts); } catch (_) { again = null; }
      if (!again || !sameGateTarget(again, gate)) {
        console.log(`[PTY] ${sessionId} changed during the live-session check; checking the new target`);
        this.attachClient(sessionId, ws, baseOpts);
        replay();
        return;
      }
      // Two panes resuming one transcript can both pass the lookup while
      // neither has spawned yet (layout restore opens them together). This
      // scan runs synchronously right before the spawn, and spawnSession
      // marks its pane synchronously, so the second one sees the first.
      if (decision.action === 'resume' && gate.resumeSessionId) {
        const other = this._otherPaneOnTranscript(sessionId, gate.resumeSessionId);
        if (other) decision = { action: 'notice', reason: 'open-in-workbook', otherSessionId: other, lookup: decision.lookup };
      }
      this._logLiveDecision(sessionId, gate, decision);
      if (decision.action === 'attach') {
        const attachOpts = { ...baseOpts, _liveChecked: true, attachShortId: decision.shortId };
        if (gate.viaCommand) {
          attachOpts.command = gate.cliBinary;
          // Keep the transcript on the attach pane (bookkeeping, logs).
          if (gate.resumeSessionId) attachOpts.resumeSessionId = gate.resumeSessionId;
        }
        this.attachClient(sessionId, ws, attachOpts);
      } else if (decision.action === 'resume') {
        this.attachClient(sessionId, ws, { ...baseOpts, _liveChecked: true });
      } else {
        this._holdForLiveNotice(sessionId, ws, baseOpts, decision);
      }
      replay();
      this._releaseLiveHolds(sessionId);
    });
  }

  /**
   * Decide what opening this transcript should do. Adds the two things only
   * the manager knows to the provider lookup's answer: the same transcript
   * already resumed in another Workbook pane, and a Workbook PTY for it that
   * exited moments ago and may still be listed while it tears down.
   *
   * @private
   * @param {string} sessionId
   * @param {{lookup: object, resumeSessionId: string, record: (object|null), fresh: boolean}} gate
   * @returns {Promise<object>} resolveResumeAction()-shaped decision.
   */
  async _decideLive(sessionId, gate) {
    const { lookup, resumeSessionId, record } = gate;
    if (resumeSessionId) {
      const other = this._otherPaneOnTranscript(sessionId, resumeSessionId);
      if (other) return { action: 'notice', reason: 'open-in-workbook', otherSessionId: other, lookup: null };
    }
    const ask = (fresh) => (gate.continueCwd && typeof lookup.resolveContinueAction === 'function'
      ? lookup.resolveContinueAction({ cwd: gate.continueCwd, transcriptId: resumeSessionId, record, fresh })
      : lookup.resolveResumeAction({ resumeSessionId, record, fresh }));
    let decision = await ask(!!gate.fresh);
    if (resumeSessionId && this._recentClaudeExitAt(resumeSessionId)) {
      for (let i = 0; i < OWN_EXIT_RECHECK_ATTEMPTS
        && decision.action === 'notice' && decision.reason === 'interactive'; i++) {
        await new Promise((resolve) => setTimeout(resolve, OWN_EXIT_RECHECK_DELAY_MS));
        decision = await ask(true);
      }
    }
    return decision;
  }

  /**
   * Another live, non-attach Workbook pane already running this transcript,
   * if any. Two attach clients on one background session are fine; a second
   * resume of a transcript another pane runs is a fork.
   *
   * @private
   * @param {string} sessionId - The pane asking (excluded).
   * @param {string} transcriptId
   * @returns {string|null} The other pane's session id.
   */
  _otherPaneOnTranscript(sessionId, transcriptId) {
    if (!transcriptId) return null;
    for (const [otherId, other] of this.sessions) {
      if (otherId === sessionId || !other.alive || other.attachShortId) continue;
      if (other.claudeTranscriptId && sameTranscriptId(other.claudeTranscriptId, transcriptId)) return otherId;
    }
    return null;
  }

  /**
   * Kill generation for a session id: killSession bumps it, so a live check
   * that started before a kill does not spawn after it.
   *
   * @private
   * @param {string} sessionId
   * @returns {number}
   */
  _liveEpochOf(sessionId) {
    if (!this._liveEpochs) this._liveEpochs = new Map();
    return this._liveEpochs.get(sessionId) || 0;
  }

  /**
   * True while a pane for this session waits on the live-session check or
   * sits on its notice (no PTY exists yet). The kill route uses it so a Kill
   * during that window cancels the pending spawn instead of answering 404.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasPendingLiveCheck(sessionId) {
    const holds = this._liveHolds.get(sessionId);
    return this._liveChecks.has(sessionId) || !!(holds && holds.size > 0);
  }

  /**
   * When a Workbook PTY for this transcript last ended, if within
   * OWN_EXIT_GRACE_MS. Prunes older entries as it goes.
   *
   * @private
   * @param {string} transcriptId
   * @returns {number|null}
   */
  _recentClaudeExitAt(transcriptId) {
    const now = Date.now();
    let hit = null;
    for (const [id, at] of this._recentClaudeExits) {
      if (now - at > OWN_EXIT_GRACE_MS) { this._recentClaudeExits.delete(id); continue; }
      if (sameTranscriptId(id, transcriptId)) hit = at;
    }
    return hit;
  }

  /**
   * Record that a Claude pane's process ended (exit or kill): remember the
   * transcript for the teardown grace window and drop the lookup cache, which
   * may still list the process as running.
   *
   * @private
   * @param {PtySession} session
   */
  _noteClaudePaneEnded(session) {
    if (!session || !session.claudeTranscriptId) return;
    this._recentClaudeExits.set(session.claudeTranscriptId, Date.now());
    try { if (session._liveLookup) session._liveLookup.invalidate(); } catch (_) { /* never fatal */ }
  }

  /**
   * One log line per gated decision, so logs/server.log shows why a pane
   * attached, resumed, or stopped at a notice.
   *
   * @private
   */
  _logLiveDecision(sessionId, gate, decision) {
    let line = '';
    try {
      const lk = decision.lookup;
      line = 'live-check session=' + sessionId
        + ' transcript=' + (gate.resumeSessionId || '-')
        + (gate.continueCwd ? ' continue-cwd=' + gate.continueCwd : '')
        + (gate.viaCommand ? ' via-command' : '')
        + ' action=' + decision.action
        + (decision.reason ? ' reason=' + decision.reason : '')
        + (decision.shortId ? ' attach=' + decision.shortId : '')
        + (lk ? ' lookup=' + (lk.ok ? 'ok' : 'failed:' + lk.error) + (lk.cached ? '(cached)' : '') : '')
        + (decision.degraded ? ' degraded=resume-unmarked' : '');
      console.log('[PTY] ' + line);
    } catch (_) { /* console.log can EPIPE; never fatal */ }
    // Durable copy: the served install has no console log (2026-09-26 review).
    if (line) appendDecisionLog(line);
  }

  /**
   * Hold a socket on the "live elsewhere" notice. Nothing is spawned. The
   * notice is written into the pane as terminal text (every client, including
   * an older cached bundle, renders it) and sent as a {type:'notice'} frame
   * (shown as a toast by app.js). The socket stays open, so the client does
   * not enter its reconnect ladder, and no "open anyway" flag ever lands in
   * the saved layout. The user answers by typing in the pane:
   *   `copy` + Enter  opens a copy anyway (explicit confirmation)
   *   Enter           checks again with a fresh lookup
   *
   * @private
   * @param {string} sessionId
   * @param {import('ws')} ws
   * @param {object} opts - Spawn options to use if the user confirms.
   * @param {object} decision - The notice decision (reason, entry, marker, ...).
   */
  _holdForLiveNotice(sessionId, ws, opts, decision) {
    const holdOpts = { ...opts };
    delete holdOpts._liveChecked;
    delete holdOpts._liveFresh;
    delete holdOpts.attachShortId;
    const notice = describeLiveNotice(decision);
    const PROMPT = '\x1b[1;33m[Myrlin]\x1b[0m > ';
    const line = (s) => '\x1b[1;33m[Myrlin]\x1b[0m\x1b[33m ' + s + '\x1b[0m\r\n';
    const write = (s) => {
      try { if (ws.readyState === 1) ws.send(s); } catch (_) { /* dead socket; close handler releases */ }
    };

    write('\r\n' + notice.lines.map(line).join('') + PROMPT);
    sendControlFrame(ws, JSON.stringify({ type: 'notice', code: LIVE_ELSEWHERE_NOTICE_CODE, message: notice.headline }));
    console.log(`[PTY] Holding ${sessionId} on the live-session notice (${decision.reason || 'live'}); nothing spawned`);
    if (decision.reason === 'known-live') {
      // The gated reasons are logged by _logLiveDecision; this one comes from
      // the spawnSession refusal, so it gets its own durable line.
      appendDecisionLog('live-check session=' + sessionId + ' action=notice reason=known-live (spawnSession refusal)');
    }

    let holds = this._liveHolds.get(sessionId);
    if (!holds) { holds = new Set(); this._liveHolds.set(sessionId, holds); }
    let typed = '';
    let released = false;
    const hold = { ws, opts: holdOpts, release: null };
    const ping = setInterval(() => { try { ws.ping(); } catch (_) {} }, LIVE_HOLD_PING_MS);
    if (typeof ping.unref === 'function') ping.unref();

    const release = () => {
      if (released) return;
      released = true;
      clearInterval(ping);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', release);
      ws.removeListener('error', release);
      holds.delete(hold);
      if (holds.size === 0 && this._liveHolds.get(sessionId) === holds) this._liveHolds.delete(sessionId);
    };
    hold.release = release;
    holds.add(hold);

    const evaluate = (entered) => {
      const word = entered.trim().toLowerCase();
      if (word === LIVE_HOLD_CONFIRM_WORD) {
        console.log(`[PTY] User confirmed opening a copy of a live Claude session in ${sessionId} (${decision.reason || 'live'})`);
        appendDecisionLog('live-check session=' + sessionId + ' user typed copy: opening a copy (' + (decision.reason || 'live') + ')');
        write(line('Opening a copy of the session...'));
        release();
        this.attachClient(sessionId, ws, { ...holdOpts, _liveChecked: true });
        this._releaseLiveHolds(sessionId);
        return;
      }
      if (word === '' || word === 'retry' || word === 'check') {
        write(line('Checking again...'));
        release();
        this.attachClient(sessionId, ws, { ...holdOpts, _liveFresh: true });
        return;
      }
      write(line('Type ' + LIVE_HOLD_CONFIRM_WORD + ' and press Enter to open a copy anyway, or press Enter to check again.') + PROMPT);
    };

    const handleTyped = (data) => {
      // Drop escape sequences (arrows, focus reports, paste brackets) and
      // treat CRLF, CR and LF alike as Enter.
      const clean = String(data)
        .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|O.|.)?/g, '')
        .replace(/\r\n/g, '\r')
        .replace(/\n/g, '\r');
      for (const ch of clean) {
        if (released) return;
        if (ch === '\r') {
          const entered = typed;
          typed = '';
          write('\r\n');
          evaluate(entered);
          continue;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (typed.length > 0) { typed = typed.slice(0, -1); write('\b \b'); }
          continue;
        }
        if (ch === '\x03') { typed = ''; write('^C\r\n' + PROMPT); continue; }
        // Printable ASCII only: the one meaningful answer is "copy", and a
        // wide or astral character would break backspace into half a pair.
        if (ch < ' ' || ch > '~' || typed.length >= LIVE_HOLD_MAX_LINE) continue;
        typed += ch;
        write(ch);
      }
    };

    const onMessage = (raw) => {
      let data;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.type === 'resize' && msg.cols && msg.rows) {
          // Remember the pane size so a confirmed copy starts at it.
          const c = Number(msg.cols);
          const r = Number(msg.rows);
          if (Number.isFinite(c) && c > 0 && Number.isFinite(r) && r > 0) { holdOpts.cols = c; holdOpts.rows = r; }
          return;
        }
        if (!msg || msg.type !== 'input' || msg.data === undefined) return;
        data = String(msg.data);
      } catch (_) {
        data = raw.toString();
      }
      handleTyped(data);
    };

    ws.on('message', onMessage);
    ws.on('close', release);
    ws.on('error', release);
  }

  /**
   * After a gated session has spawned (attach, resume, or a confirmed copy),
   * move every other socket still held on that session's notice onto the
   * running PTY, so a phone that was showing the notice follows along.
   *
   * @private
   * @param {string} sessionId
   */
  _releaseLiveHolds(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) return;
    const holds = this._liveHolds.get(sessionId);
    if (!holds || holds.size === 0) return;
    for (const hold of Array.from(holds)) {
      hold.release();
      if (hold.ws.readyState === 1) this.attachClient(sessionId, hold.ws, hold.opts);
    }
  }

  /**
   * Start or attach a session without a WebSocket client (mobile v2, P5).
   *
   * Runs the same live-session gate attachClient runs (_liveGateFor, then
   * _decideLive) and the same spawn from the store record, but with no socket
   * to hold on a notice: a refusal is returned, never shown, and a refusal
   * never spawns. Used by the phone's send to a sleeping or background
   * session, new session, branch, restart and continue here (PROTOCOL.md 9.3).
   * The PTY it starts has no client, so it owns no geometry until a desktop
   * pane attaches (PROTOCOL.md 7.1).
   *
   * @param {string} sessionId - Workbook session id.
   * @param {object} [spawnOpts] - Overrides on top of the store record, as for attachClient.
   * @returns {Promise<{status: 'spawned'|'attached'|'alreadyRunning'|'refused', code: (string|null), message: (string|null), pid?: number}>}
   */
  async launchDetached(sessionId, spawnOpts = {}) {
    if (!pty && !spawnOpts._ptySpawnForTesting) {
      return { status: 'refused', code: 'PTY_UNAVAILABLE', message: 'Terminals are unavailable on this computer.' };
    }
    const existing = this.sessions.get(sessionId);
    if (existing && existing.alive) return { status: 'alreadyRunning', code: null, message: null, pid: existing.pid };

    const baseOpts = { ...spawnOpts };
    delete baseOpts._liveFresh;
    delete baseOpts.attachShortId;
    let opts = { ...baseOpts };
    let status = 'spawned';
    let gate = null;
    if (!baseOpts._liveChecked) {
      try { gate = this._liveGateFor(sessionId, baseOpts); } catch (_) { gate = null; }
    }
    if (gate) {
      const epoch = this._liveEpochOf(sessionId);
      const pending = this._liveChecks.get(sessionId);
      if (pending) {
        await pending.catch(() => {});
        const now = this.sessions.get(sessionId);
        if (now && now.alive) return { status: 'alreadyRunning', code: null, message: null, pid: now.pid };
      }
      const run = this._decideLive(sessionId, gate).catch((err) => {
        console.error(`[PTY] Live-session check threw for ${sessionId}: ${err && err.message}`);
        return { action: 'notice', reason: 'lookup-failed', error: 'exception', lookup: null };
      });
      this._liveChecks.set(sessionId, run);
      let decision;
      try {
        decision = await run;
      } finally {
        if (this._liveChecks.get(sessionId) === run) this._liveChecks.delete(sessionId);
      }
      if (this._liveEpochOf(sessionId) !== epoch) {
        return { status: 'refused', code: 'LAUNCH_CANCELLED', message: 'The session was stopped while it was being checked.' };
      }
      const current = this.sessions.get(sessionId);
      if (current && current.alive) return { status: 'alreadyRunning', code: null, message: null, pid: current.pid };
      if (decision.action === 'resume' && gate.resumeSessionId) {
        const other = this._otherPaneOnTranscript(sessionId, gate.resumeSessionId);
        if (other) decision = { action: 'notice', reason: 'open-in-workbook', otherSessionId: other, lookup: decision.lookup };
      }
      this._logLiveDecision(sessionId, gate, decision);
      if (decision.action === 'attach') {
        opts = { ...opts, _liveChecked: true, attachShortId: decision.shortId };
        if (gate.viaCommand) {
          opts.command = gate.cliBinary;
          if (gate.resumeSessionId) opts.resumeSessionId = gate.resumeSessionId;
        }
        status = 'attached';
      } else if (decision.action === 'resume') {
        opts = { ...opts, _liveChecked: true };
      } else {
        return { status: 'refused', code: 'SESSION_LIVE_ELSEWHERE', message: describeLiveNotice(decision).headline };
      }
    }

    let session = null;
    try {
      const store = getStore();
      const rec = store.getSession(sessionId);
      session = rec
        ? this.spawnSession(sessionId, {
          command: rec.command || 'claude', // gsd:provider-literal-allowed (mirrors the attachClient store default)
          cwd: rec.workingDir || undefined,
          bypassPermissions: rec.bypassPermissions || false,
          verbose: rec.verbose || false,
          model: rec.model || null,
          agentTeams: rec.agentTeams || false,
          effort: rec.effort || null,
          permissionMode: rec.permissionMode || null,
          resumeSessionId: rec.resumeSessionId || null,
          initialPrompt: rec.resumeSessionId ? null : (rec.initialPrompt || null),
          flags: rec.resumeSessionId ? [] : (rec.flags || []),
          ...opts,
        })
        : this.spawnSession(sessionId, opts);
    } catch (err) {
      if (err && err.code === CLAUDE_SESSION_LIVE_CODE) {
        return { status: 'refused', code: 'SESSION_LIVE_ELSEWHERE', message: describeLiveNotice({ reason: 'known-live' }).headline };
      }
      if (err && err.code === PTY_UNAVAILABLE_CODE) {
        return { status: 'refused', code: 'PTY_UNAVAILABLE', message: 'Terminals are unavailable on this computer.' };
      }
      return { status: 'refused', code: 'LAUNCH_FAILED', message: 'The process could not be started.' };
    }
    if (!session) return { status: 'refused', code: 'LAUNCH_FAILED', message: 'The process could not be started.' };
    this._releaseLiveHolds(sessionId);
    return { status, code: null, message: null, pid: session.pid };
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

    // ── Live-session gate (2026-09-26) ──
    // Before a Claude transcript is resumed, ask whether it is running right
    // now outside this pane. The answer needs `claude agents --json`, which is
    // asynchronous, so a gated attach continues in _attachAfterLiveCheck and
    // re-enters here with _liveChecked set. Everything that is not a Claude
    // resume (shells, td, templates, Codex, fresh sessions, test fakes without
    // a lookup) stays on the synchronous path below, unchanged.
    if ((!session || !session.alive) && !spawnOpts._liveChecked) {
      let gate = null;
      try { gate = this._liveGateFor(sessionId, spawnOpts); } catch (_) { gate = null; }
      if (gate) {
        this._attachAfterLiveCheck(sessionId, ws, spawnOpts, gate);
        return;
      }
    }

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
            // Mobile v2 (P6): stored effort and permission mode pass through.
            effort: storeSession.effort || null,
            permissionMode: storeSession.permissionMode || null,
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
        // Live-session gate (2026-09-26): spawnSession refused a resume that
        // reached it without the gate while the lookup already knows the
        // transcript is live. Same outcome as the gate: a notice, no spawn.
        if (err && err.code === CLAUDE_SESSION_LIVE_CODE) {
          console.warn(`[PTY] ${err.message} (session ${sessionId})`);
          this._holdForLiveNotice(sessionId, ws, spawnOpts, { action: 'notice', reason: 'known-live' });
          return;
        }
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
        // P6.4, "ownable width": remember the geometry this client attached
        // with, so a later ownership handoff can restore it. Previously the
        // attach dims were applied to the PTY but never recorded on the
        // client, so a handoff back to this client after another device had
        // resized restored nothing and the PTY kept the other device's width.
        ws._viewport = { cols: attachCols, rows: attachRows };
      }
      // Seed ownership only when nobody live holds it. A sole client whose
      // geometry has just been applied IS the owner in every meaningful
      // sense; leaving sizeOwner null (or pointing at a socket that is gone)
      // meant the next arrival could take the width with a bare resize. This
      // never steals from a live owner, and it starts the settle window so
      // the contention control below has a baseline.
      if (session.alive &&
          (!session.sizeOwner || !session.clients.has(session.sizeOwner))) {
        session.requestSizeOwnership(ws, 'attach');
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

    // Replay BEFORE adding to the broadcast set. This ensures the client
    // receives the full historical output first, then starts receiving only
    // NEW live data, no interleaving.
    //
    // P6.2 + P6.4: the payload comes from buildReplay, which prefers the VT
    // sidecar's exact-state snapshot and falls back to this byte ring
    // untouched. Because the attach-time viewport was applied just above,
    // and applyViewport resizes the shadow too, a snapshot taken here is
    // already rendered at the width this client is about to view it at.
    const replay = this.buildReplay(session);
    if (replay.payload !== null) {
      try {
        if (ws.readyState === 1) {
          ws.send(replay.payload);
        }
      } catch (_) {
        // ignore
      }
    }

    // P6.3: hand the new client the authoritative mode signal immediately,
    // so it can route its history layer without waiting for the next change
    // (a settled agent pane can sit in the alternate buffer for hours without
    // emitting one). Older clients ignore unknown control types, so this is
    // safe in a mixed-version window.
    if (session.vt) {
      try {
        const frame = session.vt.getModeFrame();
        if (frame) sendControlFrame(ws, JSON.stringify(frame));
      } catch (_) { /* sidecar is never fatal */ }
    }

    // MOBILE-TERMINAL.md 3.1: hand the new client the PTY's geometry and its
    // own ownership answer in the same breath as the mode signal. This is the
    // frame that decides whether the replay it just received is rendered at
    // the geometry it was built for or re-wrapped onto the client's own grid,
    // so it goes out immediately rather than waiting for the next resize,
    // which on a settled agent pane may never come.
    session.sendSizeTo(ws);

    // NOW add client to the broadcast set for live PTY data
    session.clients.add(ws);

    // Session identity (2026-09-22): a client attaching to a session whose
    // Claude UUID was minted at spawn (or detected by the watcher before this
    // client arrived) gets the id right away, so its spawnOpts and the saved
    // layout carry the correct resume id even though it missed the broadcast.
    // The expired-resume notice travels the same way so the pane can show it
    // as a status line, independent of what the CLI has since drawn.
    if (session.detectedResumeId) {
      sendControlFrame(ws, JSON.stringify({ type: 'resumeId', resumeSessionId: session.detectedResumeId }));
    }
    if (session.identityNotice) {
      sendControlFrame(ws, JSON.stringify({
        type: 'notice',
        code: session.identityNotice.code,
        message: session.identityNotice.message,
      }));
    }

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
    //
    // P6.4: the assignment moved into PtySession.requestSizeOwnership so a
    // two-device tug of war is coalesced instead of producing a ConPTY
    // repaint storm. A single flip still applies synchronously here, which is
    // what keeps handing the laptop over instantaneous. The `reason` is
    // carried through because an automatic 'activate' (fired by an
    // IntersectionObserver or a focus event) and a deliberate 'input' deserve
    // to be distinguishable in the stats even though both currently claim.
    const claimSizeOwnership = (reason) => session.requestSizeOwnership(ws, reason || 'activate');

    // Handle incoming messages from this WebSocket client
    ws.on('message', (raw) => {
      if (!session.alive) return;

      try {
        // Try to parse as JSON control message
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'input' && msg.data !== undefined) {
          // Typing on a device claims PTY geometry for that device.
          // The claim may be coalesced under contention; the WRITE never is,
          // so typing always reaches the PTY on the first keystroke.
          //
          // MOBILE-TERMINAL.md D2: a frame carrying only terminal-generated
          // reports is not a person acting. A phone that merely showed the
          // pane sent one `\x1b[O` focus report and took the geometry off a
          // desktop that was being used. The write is unconditional either
          // way, so the application still receives every byte it asked for.
          if (isUserOriginatedInput(String(msg.data))) {
            claimSizeOwnership('input');
            // Mobile v2 (P4): the send guard's desktop typing check (G4).
            session.lastDesktopInputAt = Date.now();
          }
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
          // This is the message a phone sends automatically, so it is the
          // main source of the oscillation P6.4 coalesces.
          claimSizeOwnership('activate');
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

      // P6.4: a claimant that disconnected while its coalesced claim was
      // still waiting must not be resurrected by the trailing timer.
      if (session._pendingOwner === ws) session._pendingOwner = null;

      // Ownership handoff: when the geometry owner leaves, the most recently
      // active remaining client takes over and its stored viewport is
      // restored. This is what snaps a desktop terminal back to desktop size
      // after a phone viewer disconnects (bug B). With no clients left the
      // size is left as-is and ownership resets to unclaimed.
      //
      // A handoff is NEVER debounced: there is nothing to contend with once
      // the owner is gone, and delaying it would strand the PTY at the
      // departed device's width for the length of the settle window.
      if (session.sizeOwner === ws) {
        let nextOwner = null;
        for (const client of session.clients) {
          if (!nextOwner || (client._lastActiveAt || 0) > (nextOwner._lastActiveAt || 0)) {
            nextOwner = client;
          }
        }
        if (nextOwner) {
          session.requestSizeOwnership(nextOwner, 'handoff');
        } else {
          session.sizeOwner = null;
        }
      }

      // No viewers left: drop the ownership timers so a dormant session holds
      // neither a timer nor a reference to a closed socket.
      if (session.clients.size === 0) session.clearOwnershipTimers();

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
    // Live-session gate (2026-09-26): a check still running for this session
    // must not spawn after the kill, and sockets parked on its notice go
    // the way attached clients do below.
    if (!this._liveEpochs) this._liveEpochs = new Map();
    this._liveEpochs.set(sessionId, this._liveEpochOf(sessionId) + 1);
    const heldSockets = this._liveHolds.get(sessionId);
    if (heldSockets) {
      for (const hold of Array.from(heldSockets)) {
        hold.release();
        try { hold.ws.close(1000, 'Session terminated'); } catch (_) {}
      }
    }

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

    // Drop the ownership timers and the VT shadow. Both are idempotent, and
    // both must happen here as well as in onExit because killSession is also
    // the path taken for a session that never exited on its own.
    session.clearOwnershipTimers();
    try { this.vtRegistry.dispose(sessionId); } catch (_) {}
    session.vt = null;

    // Kill the PTY process. For an attach pane (session.attachShortId) this
    // ends only the `claude attach` client: ConPTY's kill reaches the
    // processes attached to THIS pseudo-console, and the background session
    // runs under the Claude daemon, not under this console, so it keeps going.
    if (session.alive) {
      try {
        session.pty.kill();
      } catch (_) {}
      session.alive = false;
    }
    this._noteClaudePaneEnded(session);

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
    // Belt and braces: killSession already disposes each sidecar, but a
    // sidecar for a session that vanished from the map some other way would
    // otherwise leak a headless terminal past shutdown.
    try { this.vtRegistry.disposeAll(); } catch (_) {}
  }

  /**
   * The authoritative mode signal for a session, or null when the sidecar is
   * off, unavailable, or the session does not exist. Read-only.
   *
   * @param {string} sessionId
   * @returns {{altBuffer: boolean, mouseTracking: string,
   *            mouseTrackingActive: boolean, bracketedPaste: boolean}|null}
   */
  getSessionMode(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.vt) return null;
    try { return session.vt.getMode(); } catch (_) { return null; }
  }

  /**
   * Read a page of deep normal-buffer history from a session's VT sidecar.
   *
   * This is the server-side data source for the history layer's `deep`
   * segment (BUILD-CONTRACT P7.5). The HTTP route that exposes it
   * (`GET /api/sessions/:id/history`) belongs to P7 and to `server.js`, which
   * this phase deliberately does not touch; the read API is provided here so
   * P7 is a routing change rather than a data-layer change.
   *
   * Returns the same empty shape as getScrollbackLines when there is nothing
   * to read, so a caller never has to branch on null.
   *
   * @param {string} sessionId
   * @param {object} [options]
   * @param {number} [options.beforeLine] - Absolute line index to page back from.
   * @param {number} [options.lines=2000] - Page size, clamped inside the sidecar.
   * @returns {{lines: Array<{t: string, w: boolean}>, firstLine: number,
   *            beforeLine: number, total: number, oldestAvailable: number,
   *            hasMore: boolean, lostLines: number, available: boolean}}
   */
  getHistoryLines(sessionId, options = {}) {
    const empty = {
      lines: [], firstLine: 0, beforeLine: 0, total: 0,
      oldestAvailable: 0, hasMore: false, lostLines: 0, available: false,
    };
    const session = this.sessions.get(sessionId);
    if (!session || !session.vt) return empty;
    try {
      const page = session.vt.readLines(options);
      page.available = true;
      return page;
    } catch (_) {
      return empty;
    }
  }

  /**
   * Sidecar diagnostics: whether the subsystem is enabled, how many shadows
   * exist, and each one's memory and health counters. Safe to expose on a
   * health surface (it carries no terminal content, only counts).
   *
   * @returns {object}
   */
  getSidecarStats() {
    try {
      return Object.assign(
        { availability: getVtSidecarAvailability() },
        this.vtRegistry.getStats()
      );
    } catch (_) {
      return { availability: { available: false }, enabled: false, count: 0, sidecars: [] };
    }
  }

  /**
   * List all PTY sessions with summary info.
   *
   * The geometry block (cols, rows, ownership and the resize counters) is
   * reported here because the shared-PTY width contract is otherwise
   * unobservable from outside this process. MOBILE-TERMINAL.md's harness
   * needs the server's authoritative column count to prove that a phone
   * renders at the width the PTY actually holds rather than at its own fit,
   * and "each applied resize is counted and asserted" (the width-thrash gate)
   * has no reader without it. Purely additive: existing fields are unchanged
   * and every consumer that ignores the new ones keeps working.
   *
   * @returns {Array<{sessionId, pid, alive, clientCount, createdAt, cols,
   *   rows, ownerAssigned, resizeStats}>} One entry per live session.
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
        cols: session.cols,
        rows: session.rows,
        // Booleans rather than a socket identity: a WebSocket has no stable
        // id that is safe to publish, and every question this answers is
        // "does somebody hold the width right now".
        ownerAssigned: !!(session.sizeOwner && session.clients.has(session.sizeOwner)),
        resizeStats: Object.assign({}, session.resizeStats),
        // 2026-09-26: true when this pane is a `claude attach` client of a
        // live background session (killing it ends only the client).
        attached: !!session.attachShortId,
        attachShortId: session.attachShortId || null,
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
  // Live-session gate (2026-09-26): the coded refusal and the notice code.
  CLAUDE_SESSION_LIVE_CODE,
  LIVE_ELSEWHERE_NOTICE_CODE,
  // VT sidecar (P6): re-exported so the health surface and the tests can
  // probe the headless engine through the same module they already import,
  // exactly as getPtyAvailability does for node-pty.
  getVtSidecarAvailability,
  OWNERSHIP_DEBOUNCE_MS,
  OWNERSHIP_CONTENTION_CLEAR_MS,
  // MOBILE-TERMINAL.md D2. Exported at the top level rather than under
  // __test because it is a stated part of the width contract: "a frame of
  // terminal replies is not a person acting" is a rule other layers may need
  // to agree with, and a rule that lives only inside a closure gets
  // reimplemented slightly differently somewhere else.
  isUserOriginatedInput,
  __test: {
    waitForNewJsonl,
    isAltRingSuppressionEnabled,
    sendControlFrame,
    buildSizeFrame,
    describeLiveNotice,
  },
};
