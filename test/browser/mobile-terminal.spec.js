#!/usr/bin/env node
/**
 * mobile-terminal.spec.js - the shared-PTY phone rendering harness.
 * Created: 2026-08-19.
 *
 * WHAT IT PROVES
 *
 * One PTY, two clients, one geometry. A desktop at 1440x900 and a phone at
 * 390x844 attach to the SAME live pane. The PTY holds exactly one column
 * count and one row count, and until this harness existed nothing measured
 * what the phone did with geometry it did not choose. The answer, measured
 * rather than guessed, is in docs/design/notion-restyle/MOBILE-TERMINAL.md.
 *
 * Six situations are driven and photographed, and each one records numbers
 * rather than an impression:
 *
 *   1 desktop-owns    phone attaches to a pane whose width the desktop owns
 *   2 phone-claims    phone taps into the pane and takes the width over
 *   3 phone-only      phone owns the geometry from the first attach
 *   4 history-scroll  phone scrolls back through the unified scrollback
 *   5 keyboard        the soft keyboard shrinks the visual viewport
 *   6 sidecar-replay  a fresh phone attach replays the sidecar snapshot
 *
 * THE FIXTURE IS DELIBERATELY TALLER THAN A PHONE. `fake-agent-cli.js` is
 * driven with enough turns that its frame is taller than the phone's row
 * count and wider than the phone's column count at the shipped font size.
 * That is not an exaggeration of the problem, it is the problem: an agent
 * CLI paints by ABSOLUTE cursor addressing, so a frame row addressed at row
 * 34 of a 28-row terminal is clamped onto the last row instead of appearing,
 * and the status and prompt rows are exactly the rows that live at the
 * bottom of the frame.
 *
 * THE MEASUREMENTS, and why each one is the right question
 *
 *   xtermCols / serverCols  The defect in one comparison. A non-owning
 *                           client that renders at its own fit cannot show
 *                           the owner's frame; one that renders at the PTY's
 *                           real geometry can.
 *   intactRows              Fixture frame rows whose FULL text lands on a
 *                           single buffer line. Content-based, so a lucky
 *                           column count cannot satisfy it.
 *   visibleRows             Fixture frame rows present in any form. The gap
 *                           between this and intactRows is wrapping; the gap
 *                           between this and the frame's row count is loss.
 *   statusRowVisible        The frame's bottom. An agent CLI keeps its
 *                           status line and its input row there, so this is
 *                           the single most user-visible casualty of a row
 *                           count the client did not agree to.
 *   fidelityPct             Rows shared with the desktop's render of the
 *                           same PTY. The ground truth for a shared pane:
 *                           two clients looking at one terminal should see
 *                           one screen.
 *   wrappedRows             xterm's own `isWrapped` across the viewport.
 *   duplicateRows           Repeated non-blank rows, which is what a torn
 *                           replay and a double-rendered seam look like.
 *   resizeFrames            Resize control frames this client sent. Every
 *                           applied resize is a full ConPTY repaint into
 *                           every attached client, so this is a cost, not a
 *                           statistic.
 *   cellWidthPx             The rendered glyph advance in CSS pixels, so
 *                           "is this legible at 390px" is answered with a
 *                           number instead of taste.
 *
 * SAFETY, the same contract every other harness in this directory signs:
 *
 *   - Never binds port 3456. The child asks the OS for an ephemeral port.
 *   - USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and every CWM_* path point
 *     inside a disposable sandbox that is validated before it is deleted.
 *   - CWM_CRED_EXTERNAL_BRIDGE_OWNER=1 and proactiveRefreshMinutes 0, so no
 *     credential refresh, rotation or Mac bridge call can happen mid-run.
 *   - Every non-loopback request is blocked at the browser.
 *   - Every owned child is stopped by its own pid in a finally block. No
 *     blanket process kill anywhere.
 *   - Every captured PNG is asserted at most 2000px on both axes before it
 *     can reach a model context.
 *
 * Usage:
 *   npm run test:mobile-terminal                                assert + capture
 *   node test/browser/mobile-terminal.spec.js --label before --no-assert
 *   node test/browser/mobile-terminal.spec.js --out <dir>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(__dirname, 'workbook-shell-server.js');
const TEMP_PREFIX = 'myrlin-mobile-term-';

// Forward slashes: the spawn path is validated by isSafeCommand in
// pty-server.js, whose rejection set includes the backslash.
const FAKE_CLI = path.join(__dirname, 'fake-agent-cli.js').replace(/\\/g, '/');

/**
 * Conversation rows the fixture paints. Chosen so the frame is 34 rows tall,
 * which is taller than a 390x844 phone holds at the shipped font size and
 * shorter than a 1440x900 desktop holds, so one PTY geometry cannot satisfy
 * both by accident.
 */
const FIXTURE_TURNS = 30;

// The fixture's own marker rows, verbatim. Painted by absolute addressing, so
// each occupies exactly one terminal row at any width wide enough to hold it.
const FRAME_ROW_COUNT = FIXTURE_TURNS;
const frameRowText = (n) => 'LIVE-SCREEN-ROW-' + n + ': the frame the CLI is painting right now';
const FRAME_ROW_CHARS = frameRowText(1).length;

// Below this column count the fixture's own rows wrap legitimately, so a
// desktop narrower than this would make the comparison meaningless.
const FRAME_MIN_COLS = FRAME_ROW_CHARS + 4;

// No captured PNG may exceed this on either axis. The API rejects larger
// images and passing one mid-turn poisons the whole session.
const ABSOLUTE_MAX_DIM = 2000;

// A screenshot smaller than this is a blank or failed capture, not a picture.
const MIN_PNG_BYTES = 1024;

/**
 * The two devices. deviceScaleFactor 2 rather than 3 on the phone is a
 * deliberate, documented choice: 390x844 at 3x is a 1170x2532 PNG, and 2532
 * is over the 2000px guard, so a 3x capture could never be looked at. 2x is
 * 780x1688, inside the guard, and still resolves sub-pixel text well enough
 * to judge legibility.
 */
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const PHONE_SCALE = 2;

// How long a claim may take to reach the server, be applied, and come back.
// Generous for a loopback socket on purpose: the question is "does it
// converge", not "how fast is localhost".
const CLAIM_SETTLE_MS = 5000;

// Poll interval while waiting for a converged state.
const POLL_MS = 100;

// Font sizes the phone ladder probe measures. The question the probe answers
// is "what does a column count actually cost in glyph width", which cannot be
// answered from a table because the face, the device pixel ratio and xterm's
// own rounding all take part.
const FONT_LADDER = [8, 9, 10, 11, 12, 13, 14];

// Real UUID shapes: findJsonlFile matches on the file name and the pane
// validates the id before it ever reaches the mirror API.
const SHARED_SESSION_ID = '5a1d0c72-1e44-4b90-9c31-2f7b6d80a101';
const PHONE_SESSION_ID = '5a1d0c72-1e44-4b90-9c31-2f7b6d80a102';

/* ═══════════════════════════════════════════════════════════════
   SANDBOX AND SERVER
   ═══════════════════════════════════════════════════════════════ */

/**
 * Remove startup-token values before an error reaches logs.
 *
 * @param {string} value - Potentially sensitive diagnostic text.
 * @returns {string} Redacted diagnostic.
 */
function redactToken(value) {
  return String(value || '').replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * Wait until an owned child has actually exited.
 *
 * @param {import('child_process').ChildProcess} child - Owned child process.
 * @param {number} timeoutMs - Maximum wait.
 * @returns {Promise<boolean>} Whether exit was observed.
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/**
 * Read a PNG's pixel dimensions straight out of its IHDR chunk.
 *
 * Dependency-free on purpose: the guard has to work even when an image
 * toolchain is missing, because the consequence of not checking is a dead
 * session.
 *
 * @param {string} filePath - PNG on disk.
 * @returns {{width: number, height: number, bytes: number}} Image dimensions.
 */
function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.ok(buffer.length >= 24, 'file is too small to be a PNG: ' + filePath);
  assert.ok(
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'file is not a PNG: ' + filePath
  );
  assert.strictEqual(buffer.toString('ascii', 12, 16), 'IHDR',
    'PNG has no leading IHDR chunk: ' + filePath);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

/**
 * A minimal deterministic store fixture. Nothing is running and no pid is
 * recorded, so nothing is probed, resumed or spawned by the roster alone; the
 * two PTYs in this run are opened explicitly by the harness.
 *
 * @returns {object} A v2 state document.
 */
function buildFixture() {
  const WS = '33333333-3333-4333-8333-333333333333';
  const session = (id, name) => ({
    id,
    name,
    workspaceId: WS,
    workingDir: 'C:/Users/example/projects/mobile-terminal',
    topic: '',
    command: 'claude', /* gsd:provider-literal-allowed */
    provider: 'claude', /* gsd:provider-literal-allowed */
    resumeSessionId: null,
    status: 'stopped',
    pid: null,
    tags: [],
    initialPrompt: null,
    flags: [],
    createdAt: '2026-08-19T09:00:00.000Z',
    lastActive: '2026-08-19T09:00:00.000Z',
    logs: [],
  });
  const sessions = {
    [SHARED_SESSION_ID]: session(SHARED_SESSION_ID, 'Shared pane'),
    [PHONE_SESSION_ID]: session(PHONE_SESSION_ID, 'Phone pane'),
  };
  return {
    version: 2,
    activeWorkspace: WS,
    workspaces: {
      [WS]: {
        id: WS,
        name: 'Mobile terminal',
        description: 'Shared PTY geometry proofs',
        color: 'mauve',
        icon: null,
        sessions: Object.keys(sessions),
        createdAt: '2026-08-19T09:00:00.000Z',
        lastActive: '2026-08-19T09:00:00.000Z',
        autoSummary: true,
      },
    },
    sessions,
    recentSessions: Object.keys(sessions),
    settings: {
      providers: { claude: true, codex: false }, /* gsd:provider-literal-allowed */
      credentialSwitcher: { proactiveRefreshMinutes: 0, externalBridgeOwner: true },
    },
  };
}

/**
 * Start the isolated application and capture its one-use startup URL.
 *
 * @param {string} sandbox - Validated temporary sandbox root.
 * @returns {Promise<{child: import('child_process').ChildProcess, url: string,
 *   origin: string, profile: string}>} Owned child and its addresses.
 */
function startWorkbook(sandbox) {
  return new Promise((resolve, reject) => {
    const profile = path.join(sandbox, 'profile');
    const dataDir = path.join(sandbox, 'data');
    const claudeDir = path.join(profile, '.claude');
    const emptySeed = path.join(sandbox, 'empty-seed');
    const tempDir = path.join(sandbox, 'temp');
    const appData = path.join(profile, 'AppData', 'Roaming');
    const localAppData = path.join(profile, 'AppData', 'Local');
    for (const dir of [claudeDir, emptySeed, dataDir, tempDir, appData, localAppData]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}\n', 'utf8');
    fs.writeFileSync(
      path.join(dataDir, 'workspaces.json'),
      JSON.stringify(buildFixture(), null, 2) + '\n',
      'utf8'
    );

    const childEnv = {
      CWM_DATA_DIR: dataDir,
      CWM_CLAUDE_DIR: claudeDir,
      CWM_CLAUDE_JSON: path.join(profile, '.claude.json'),
      CWM_CRED_SEED_DIR: emptySeed,
      CWM_CRED_EXTERNAL_BRIDGE_OWNER: '1',
      CWM_CRED_DISABLE_MAC: '1',
      CWM_TEST_HERMETIC_UI: '1',
      CWM_NO_OPEN: '1',
      // Production runs with the sidecar on, and situation 6 is entirely
      // about what the snapshot replay hands a phone, so the harness matches
      // production rather than the default-off release setting.
      CWM_VT_SIDECAR: '1',
      CWM_PASSWORD: crypto.randomUUID(),
      USERPROFILE: profile,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: tempDir,
      TMP: tempDir,
      NODE_ENV: 'test',
    };
    for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT']) {
      if (typeof process.env[name] === 'string') childEnv[name] = process.env[name];
    }

    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopWorkbook(child).then(
        () => reject(error),
        (cleanupError) => reject(new AggregateError([error, cleanupError], 'startup and cleanup failed'))
      );
    };
    const timeout = setTimeout(() => {
      fail(new Error('mobile terminal harness server did not report readiness: ' +
        redactToken((stdout + '\n' + stderr).trim())));
    }, 30000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('message', (message) => {
      if (!message || message.type !== 'ready' || typeof message.url !== 'string' || settled) return;
      const parsed = new URL(message.url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.searchParams.has('token')) {
        fail(new Error('harness server reported an invalid startup URL'));
        return;
      }
      if (parsed.port === '3456') {
        fail(new Error('refusing to drive port 3456: it serves the live checkout'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: message.url, origin: parsed.origin, profile });
    });
    child.once('error', (error) => fail(error));
    child.on('exit', (code) => {
      if (settled) return;
      fail(new Error('harness server exited ' + code + ': ' + redactToken((stdout + '\n' + stderr).trim())));
    });
  });
}

/**
 * Stop the exact child this harness launched. Never a blanket kill: the
 * child's own pid, escalating only if it refuses to leave.
 *
 * @param {import('child_process').ChildProcess} child - Owned server child.
 * @returns {Promise<void>} Resolves once the child is gone.
 */
async function stopWorkbook(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForExit(child, 5000);
  try {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
  } catch (_) { /* the child may already be gone */ }
  if (await gracefulExit) return;
  const forcedExit = waitForExit(child, 5000);
  try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
  if (!(await forcedExit)) {
    throw new Error('owned harness server did not exit after forced termination');
  }
}

/**
 * Delete only the validated temporary directory this harness created.
 *
 * @param {string} sandbox - Candidate sandbox root.
 * @returns {void}
 */
function removeSandbox(sandbox) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(sandbox);
  assert.strictEqual(path.dirname(resolved), tempRoot, 'sandbox escaped the OS temp directory');
  assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX), 'sandbox prefix validation failed');
  fs.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Write a Claude transcript into the sandbox profile so the history surface
 * has an archive above the live screen (situation 4).
 *
 * @param {string} profileDir - Sandbox profile root.
 * @param {string} sessionId - Session the transcript belongs to.
 * @param {number} turns - Conversation turns to write.
 * @returns {string} The transcript path.
 */
function seedTranscript(profileDir, sessionId, turns) {
  const projectDir = path.join(profileDir, '.claude', 'projects', 'C--mobile-terminal-probe');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [];
  for (let i = 1; i <= turns; i++) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date(Date.UTC(2026, 7, 19, 9, i, 0)).toISOString(),
      message: { role: 'user', content: 'ARCHIVE-TURN-' + i + ' asked about the shared width contract' },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 7, 19, 9, i, 30)).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ARCHIVE-REPLY-' + i + ' the PTY holds exactly one column count' }],
      },
    }));
  }
  const file = path.join(projectDir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/* ═══════════════════════════════════════════════════════════════
   IN-PAGE INSTRUMENTATION AND MEASUREMENT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Count the control frames a client sends, without touching application code.
 *
 * Installed as an init script so it is in place before the first socket is
 * created. It wraps WebSocket.prototype.send, records the frame types the
 * geometry contract cares about, and forwards every call untouched, so the
 * application cannot tell the difference.
 *
 * @returns {void} Runs in the page.
 */
function installFrameCounter() {
  const counts = { resize: 0, activate: 0, input: 0 };
  // Input payloads are kept as escaped text because WHICH bytes claimed the
  // width is the whole question: a keystroke is a user asking for the width,
  // and a DEC 1004 focus report is not.
  const inputs = [];
  const escape = (s) => String(s).replace(/[\x00-\x1f\x7f]/g,
    (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  const original = window.WebSocket.prototype.send;
  window.WebSocket.prototype.send = function countedSend(payload) {
    try {
      if (typeof payload === 'string' && payload.charAt(0) === '{') {
        const msg = JSON.parse(payload);
        if (msg && typeof msg.type === 'string' && msg.type in counts) counts[msg.type]++;
        if (msg && msg.type === 'input' && inputs.length < 12) inputs.push(escape(msg.data));
      }
    } catch (_) { /* a frame we cannot parse is a frame we do not count */ }
    return original.apply(this, arguments);
  };
  window.__mwFrames = {
    read: () => Object.assign({}, counts, { inputs: inputs.slice() }),
    reset: () => { counts.resize = 0; counts.activate = 0; counts.input = 0; inputs.length = 0; },
  };
}

/**
 * Sample the pane's rendered geometry continuously.
 *
 * The reported symptom is intermittent, so a single reading at the end of a
 * situation can miss it entirely. A pane that is briefly resized to a tiny
 * grid while its tab is hidden, or that lags the PTY for half a second after
 * a keyboard animation, is a pane whose next repaint arrives at the wrong
 * width; the frayed screen the user sees is that moment, not the settled
 * state. This records every moment so the harness can report how long the
 * client and the PTY disagreed rather than whether they happen to agree now.
 *
 * @returns {void} Runs in the page.
 */
function installGeometrySampler() {
  const samples = [];
  const SAMPLE_MS = 80;
  const MAX_SAMPLES = 6000;
  const tick = () => {
    try {
      const pane = window.cwm && window.cwm.terminalPanes && window.cwm.terminalPanes[0];
      const term = pane && pane.term;
      if (term && samples.length < MAX_SAMPLES) {
        const last = samples[samples.length - 1];
        const cols = term.cols;
        const rows = term.rows;
        // Only record transitions plus a heartbeat, so a long run does not
        // allocate tens of thousands of identical records.
        if (!last || last.cols !== cols || last.rows !== rows || (Date.now() - last.t) > 1000) {
          samples.push({ t: Date.now(), cols, rows });
        }
      }
    } catch (_) { /* a sampler must never be able to break the page */ }
  };
  setInterval(tick, SAMPLE_MS);
  window.__mwGeometry = {
    read: () => samples.slice(),
    clear: () => { samples.length = 0; },
  };
}

/**
 * Read everything measurable about a pane's rendered state.
 *
 * Runs entirely in the page against the live xterm instance, so every number
 * is what the device actually has rather than what the harness asked for.
 * Written defensively: a pane that has not mounted returns `mounted: false`
 * rather than throwing, because a harness that dies on the interesting case
 * measures nothing.
 *
 * @param {object} args - `{ slot, frameRowCount }`.
 * @returns {object} The measurement record.
 */
function measurePaneInPage(args) {
  const slot = args.slot;
  const out = { mounted: false, slot };
  const pane = window.cwm && window.cwm.terminalPanes && window.cwm.terminalPanes[slot];
  const term = pane && pane.term;
  if (!term || !term.buffer || !term.buffer.active) return out;
  out.mounted = true;
  out.xtermCols = term.cols;
  out.xtermRows = term.rows;

  const buf = term.buffer.active;
  const top = buf.viewportY;
  const rows = [];
  let wrappedRows = 0;
  for (let y = top; y < top + term.rows; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    if (line.isWrapped) wrappedRows++;
    rows.push(line.translateToString(true));
  }
  out.wrappedRows = wrappedRows;
  out.rows = rows;

  // Content-based fidelity. Each fixture row is painted by absolute
  // addressing, so it lands on exactly one terminal row whenever the render
  // geometry matches the PTY. Split across lines is wrapping; absent is loss.
  //
  // POSITION matters as much as presence, and it is the half that produces
  // the reported symptom. The fixture paints marker n at 1-based terminal row
  // n + 2, so its 0-based viewport index is n + 1. When the render is
  // narrower than the PTY every wrapped row pushes the next absolute cursor
  // move onto a row it was not aimed at, which is what "scattered" looks like
  // from the outside.
  //
  // The fixture clips every row it paints to the PTY's width, exactly as the
  // real CLI does, so the text to look for is the fixture's row clipped the
  // same way. Without this the harness would score a correct narrow render as
  // broken and measure its own fixture instead of the product.
  const clip = (s) => (args.ptyCols > 0 ? s.slice(0, args.ptyCols) : s).replace(/\s+$/, '');
  let intactRows = 0;
  let visibleRows = 0;
  let rowPositionErrors = 0;
  const missing = [];
  const frameTexts = [];
  for (let n = 1; n <= args.frameRowCount; n++) {
    const needle = clip('LIVE-SCREEN-ROW-' + n + ': the frame the CLI is painting right now');
    frameTexts.push(needle);
    const head = clip('LIVE-SCREEN-ROW-' + n + ':');
    if (rows.some((r) => r.indexOf(needle) !== -1)) intactRows++;
    const at = rows.findIndex((r) => r.indexOf(head) !== -1);
    if (at !== -1) {
      visibleRows++;
      if (at !== n + 1) rowPositionErrors++;
    } else {
      missing.push(n);
    }
  }
  out.intactRows = intactRows;
  out.visibleRows = visibleRows;
  out.rowPositionErrors = rowPositionErrors;
  out.missingRows = missing.slice(0, 12);

  // FRAYING. A row that carries only part of a frame row is the reported
  // symptom in its most literal form. Three shapes, counted apart because
  // they have different causes:
  //   truncated  the head survived and the tail was overwritten by the next
  //              absolute paint. The row reads as a sentence cut off.
  //   orphanTail the tail landed on its own row, stranded under an unrelated
  //              line. This is the "frayed" leftover.
  //   interior   neither end matches, so the row is a middle fragment.
  let truncatedRows = 0;
  let orphanTailRows = 0;
  let interiorFragmentRows = 0;
  const fragmentSample = [];
  for (const raw of rows) {
    const r = raw.trim();
    if (r.length < 8) continue;
    if (frameTexts.some((f) => f === r)) continue;
    const head = frameTexts.find((f) => f.startsWith(r));
    if (head) { truncatedRows++; if (fragmentSample.length < 8) fragmentSample.push(r); continue; }
    const tail = frameTexts.find((f) => f.endsWith(r));
    if (tail) { orphanTailRows++; if (fragmentSample.length < 8) fragmentSample.push(r); continue; }
    if (frameTexts.some((f) => f.indexOf(r) !== -1)) {
      interiorFragmentRows++;
      if (fragmentSample.length < 8) fragmentSample.push(r);
    }
  }
  out.truncatedRows = truncatedRows;
  out.orphanTailRows = orphanTailRows;
  out.interiorFragmentRows = interiorFragmentRows;
  out.fragmentRows = truncatedRows + orphanTailRows + interiorFragmentRows;
  out.fragmentSample = fragmentSample;

  // The frame's bottom. An agent CLI keeps its status line and its input row
  // there, which is why a row count the client did not agree to is not a
  // cosmetic problem.
  out.statusRowVisible = rows.some((r) => r.indexOf('status: working, tick') !== -1);
  out.promptVisible = rows.some((r) => r.trim() === '>' || r.trim().indexOf('> ') === 0);

  const nonBlank = rows.filter((r) => r.trim().length > 0);
  const seen = new Set();
  let duplicateRows = 0;
  for (const r of nonBlank) {
    const key = r.trim();
    if (seen.has(key)) duplicateRows++;
    else seen.add(key);
  }
  out.duplicateRows = duplicateRows;

  out.fontSizePx = term.options && term.options.fontSize;
  try {
    const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
    if (dims && dims.css && dims.css.cell) {
      out.cellWidthPx = Math.round(dims.css.cell.width * 100) / 100;
      out.cellHeightPx = Math.round(dims.css.cell.height * 100) / 100;
    }
  } catch (_) { /* a moved private field must not end the measurement */ }

  const paneEl = document.getElementById('term-pane-' + slot);
  const containerEl = document.getElementById('term-container-' + slot);
  if (containerEl) {
    out.containerWidth = Math.round(containerEl.clientWidth);
    out.containerHeight = Math.round(containerEl.clientHeight);
    out.containerScrollWidth = Math.round(containerEl.scrollWidth);
    out.paneScrollablePx = Math.max(0,
      Math.round(containerEl.scrollWidth - containerEl.clientWidth));
  }
  if (paneEl) {
    out.widthNoticeShowing = !!paneEl.querySelector('.mw-width-notice');
    out.followMode = paneEl.dataset ? (paneEl.dataset.mwFollow || null) : null;
  }
  out.documentOverflowPx = Math.max(0,
    Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth));

  // What this client believes the server holds. Null before the size control
  // frame ships, which is itself a finding.
  out.remoteSize = (pane && pane._remoteSizeFrame)
    ? {
      cols: pane._remoteSizeFrame.cols,
      rows: pane._remoteSizeFrame.rows,
      owned: pane._remoteSizeFrame.owned,
    }
    : null;

  out.frames = window.__mwFrames ? window.__mwFrames.read() : null;
  return out;
}

/**
 * Measure the column count each candidate font size buys on this device.
 *
 * Applies each size to the live terminal, lets xterm re-measure its cell, and
 * reads the proposed column count from the fit addon. The original size is
 * restored before returning, so the probe leaves no trace. This is the
 * measurement behind the phone's default size: a table would be a guess,
 * because the face, the device pixel ratio and xterm's own rounding all vote.
 *
 * @param {object} args - `{ slot, ladder }`.
 * @returns {Array<object>} One record per candidate size.
 */
function probeFontLadderInPage(args) {
  const pane = window.cwm && window.cwm.terminalPanes && window.cwm.terminalPanes[args.slot];
  const term = pane && pane.term;
  if (!term || !pane.fitAddon) return [];
  const original = term.options.fontSize;
  const results = [];
  for (const size of args.ladder) {
    try {
      term.options.fontSize = size;
      const proposed = pane.fitAddon.proposeDimensions();
      let cellWidth = null;
      try {
        const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
        if (dims && dims.css && dims.css.cell) cellWidth = Math.round(dims.css.cell.width * 100) / 100;
      } catch (_) { /* reported as null */ }
      results.push({
        fontSizePx: size,
        cols: proposed ? proposed.cols : null,
        rows: proposed ? proposed.rows : null,
        cellWidthPx: cellWidth,
      });
    } catch (_) {
      results.push({ fontSizePx: size, cols: null, rows: null, cellWidthPx: null });
    }
  }
  try { term.options.fontSize = original; } catch (_) { /* restored below anyway */ }
  return results;
}

/**
 * Ask the running server what geometry the PTY actually holds.
 *
 * Read through the application's own authenticated API client, so the harness
 * does not reproduce the auth header and a change to that path is caught here
 * too.
 *
 * @param {import('@playwright/test').Page} page - Any authenticated page.
 * @param {string} sessionId - Session to look up.
 * @returns {Promise<object|null>} The server's session record.
 */
async function readServerSession(page, sessionId) {
  return page.evaluate(async (id) => {
    try {
      const data = await window.cwm.api('GET', '/api/pty');
      const list = (data && data.sessions) || [];
      return list.find((s) => s.sessionId === id) || null;
    } catch (_) {
      return null;
    }
  }, sessionId);
}

/**
 * Poll the server's PTY geometry on a timer, so the client's timeline has
 * something to be compared against moment by moment.
 *
 * The poller owns exactly one interval and is stopped in the caller's finally
 * block. A failed read is skipped rather than recorded, because an absent
 * sample is honest and a zero would be a lie.
 *
 * @param {import('@playwright/test').Page} page - Any authenticated page.
 * @param {Function} sessionIdFn - Returns the session id to watch right now.
 * @returns {{stop: Function, samples: object[]}} Handle and the timeline.
 */
function startServerGeometryPoller(page, sessionIdFn) {
  const samples = [];
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const id = sessionIdFn();
      if (!id) return;
      const record = await readServerSession(page, id);
      if (record) {
        const last = samples[samples.length - 1];
        if (!last || last.cols !== record.cols || last.rows !== record.rows ||
            (Date.now() - last.t) > 1000) {
          samples.push({ t: Date.now(), cols: record.cols, rows: record.rows, sessionId: id });
        }
      }
    } catch (_) { /* a skipped sample is better than a fabricated one */ } finally {
      busy = false;
    }
  }, 120);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer), samples };
}

/**
 * Summarise how long the client and the PTY disagreed inside one window.
 *
 * Walks the two step-function timelines together. For each interval where
 * both sides have a known value, the interval counts as agreeing or
 * disagreeing and its duration is added to the right total. This is the
 * number the fix has to drive to zero for the live screen: a client rendering
 * at a width the PTY does not hold is a client whose next repaint lands in
 * the wrong place.
 *
 * @param {object[]} clientSamples - `{t, cols, rows}` from the page.
 * @param {object[]} serverSamples - `{t, cols, rows}` from /api/pty.
 * @param {number} fromT - Window start.
 * @param {number} toT - Window end.
 * @returns {object} Divergence summary for the window.
 */
function summariseDivergence(clientSamples, serverSamples, fromT, toT) {
  const out = {
    windowMs: Math.max(0, toT - fromT),
    divergentMs: 0,
    agreedMs: 0,
    unknownMs: 0,
    transitions: [],
  };
  /**
   * Value of a step-function timeline at a moment.
   *
   * @param {object[]} list - Ascending samples.
   * @param {number} t - Moment.
   * @returns {object|null} The sample in force, or null before the first.
   */
  const valueAt = (list, t) => {
    let found = null;
    for (const s of list) {
      if (s.t <= t) found = s;
      else break;
    }
    return found;
  };
  const marks = new Set([fromT, toT]);
  for (const s of clientSamples) if (s.t >= fromT && s.t <= toT) marks.add(s.t);
  for (const s of serverSamples) if (s.t >= fromT && s.t <= toT) marks.add(s.t);
  const ordered = [...marks].sort((a, b) => a - b);
  for (let i = 0; i < ordered.length - 1; i++) {
    const start = ordered[i];
    const span = ordered[i + 1] - start;
    if (span <= 0) continue;
    const c = valueAt(clientSamples, start);
    const s = valueAt(serverSamples, start);
    if (!c || !s) { out.unknownMs += span; continue; }
    if (c.cols === s.cols && c.rows === s.rows) {
      out.agreedMs += span;
    } else {
      out.divergentMs += span;
      if (out.transitions.length < 10) {
        out.transitions.push({
          atMsIntoWindow: start - fromT,
          forMs: span,
          client: c.cols + 'x' + c.rows,
          pty: s.cols + 'x' + s.rows,
        });
      }
    }
  }
  const measured = out.divergentMs + out.agreedMs;
  out.divergentPct = measured > 0 ? Math.round((out.divergentMs / measured) * 1000) / 10 : null;
  return out;
}

/**
 * Read the server's geometry, then measure the pane against it.
 *
 * The order matters. The fixture clips its rows to the PTY's width, so the
 * text a correct render shows depends on that width; measuring first and
 * looking the width up afterwards would compare against the wrong strings on
 * every situation where the geometry is not the phone's own.
 *
 * @param {import('@playwright/test').Page} page - Client page.
 * @param {string} sessionId - Session the pane is attached to.
 * @param {number} frameRowCount - Fixture rows to look for.
 * @returns {Promise<object>} Measurement with `server` attached.
 */
async function measureAgainstServer(page, sessionId, frameRowCount) {
  const server = await readServerSession(page, sessionId);
  const record = await page.evaluate(measurePaneInPage, {
    slot: 0,
    frameRowCount,
    ptyCols: server ? server.cols : 0,
  });
  record.server = server;
  return record;
}

/**
 * Share of the desktop's non-blank rows that also appear on the phone.
 *
 * The ground truth for a shared pane: two clients looking at one terminal
 * should be looking at one screen. Compared as trimmed text, so a difference
 * in trailing blanks is not counted as a difference in content.
 *
 * @param {string[]} desktopRows - Desktop's rendered rows.
 * @param {string[]} phoneRows - Phone's rendered rows.
 * @returns {number|null} Percentage, or null when either side is missing.
 */
function fidelityPct(desktopRows, phoneRows) {
  if (!Array.isArray(desktopRows) || !Array.isArray(phoneRows)) return null;
  const wanted = desktopRows.map((r) => r.trim()).filter((r) => r.length > 0);
  if (wanted.length === 0) return null;
  const have = new Set(phoneRows.map((r) => r.trim()));
  let hits = 0;
  for (const row of wanted) if (have.has(row)) hits++;
  return Math.round((hits / wanted.length) * 1000) / 10;
}

/**
 * Poll a page predicate until it holds or the deadline passes.
 *
 * Returns the elapsed milliseconds rather than throwing, because "how long
 * did the broken state last" is one of the numbers this harness exists to
 * report, and a timeout is a legitimate answer to it.
 *
 * @param {Function} probe - Async function returning a truthy verdict.
 * @param {number} timeoutMs - Deadline.
 * @returns {Promise<{ok: boolean, elapsedMs: number}>} Convergence result.
 */
async function waitUntil(probe, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await probe()); } catch (_) { ok = false; }
    const elapsedMs = Date.now() - started;
    if (ok) return { ok: true, elapsedMs };
    if (elapsedMs >= timeoutMs) return { ok: false, elapsedMs };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Open a terminal pane on a page and wait for the fixture's first frame.
 *
 * @param {import('@playwright/test').Page} page - Authenticated page.
 * @param {string} sessionId - Session to attach to or spawn.
 * @param {string} label - Pane title.
 * @returns {Promise<boolean>} Whether the frame was observed painting.
 */
async function openPane(page, sessionId, label) {
  await page.evaluate(({ id, name, command }) => {
    window.cwm.setViewMode('terminal');
    window.cwm.openTerminalInPane(0, id, name, { command, resumeSessionId: id });
  }, { id: sessionId, name: label, command: 'node ' + FAKE_CLI + ' ' + FIXTURE_TURNS });

  const painted = await page.waitForFunction(
    () => {
      const screen = document.querySelector('#term-pane-0 .xterm-screen');
      return !!screen && screen.textContent.indexOf('LIVE-SCREEN-ROW-') !== -1;
    },
    { timeout: 45000 }
  ).then(() => true).catch(() => false);
  // One tick past the first paint so the shutter never catches a half frame.
  await page.waitForTimeout(900);
  return painted;
}

/**
 * Put a page into the phone shell: Terminal tab, slot 0 active.
 *
 * @param {import('@playwright/test').Page} page - Phone page.
 * @returns {Promise<void>} Resolves once applied.
 */
async function focusPhonePane(page) {
  await page.evaluate(() => {
    window.cwm.setViewMode('terminal');
    if (typeof window.cwm.updateTerminalTabs === 'function') window.cwm.updateTerminalTabs();
    if (typeof window.cwm.switchTerminalTab === 'function') window.cwm.switchTerminalTab(0);
  });
  await page.waitForTimeout(500);
}

/**
 * Set the per-session "Follow this device" escape hatch to a known value.
 *
 * Situations 1 and 6 need the DESKTOP to hold the geometry while the phone
 * looks at it. With follow on, the phone's own visibility triggers claim the
 * width within a second, which is a different situation (2) and would make
 * the non-owner case unobservable. Driving the shipped escape hatch is the
 * honest way to pin ownership; nothing in the harness reaches around it.
 *
 * @param {import('@playwright/test').Page} page - Phone page.
 * @param {string} sessionId - Session to pin.
 * @param {boolean} follow - Desired state.
 * @returns {Promise<boolean>} The state after the call.
 */
async function setFollow(page, sessionId, follow) {
  return page.evaluate(({ id, want }) => {
    if (typeof window.cwm.followsThisDevice !== 'function') return null;
    if (window.cwm.followsThisDevice(id) !== want) {
      window.cwm.toggleFollowThisDevice(id);
    }
    return window.cwm.followsThisDevice(id);
  }, { id: sessionId, want: follow });
}

/**
 * Emulate an iOS soft keyboard: the layout viewport keeps its height and the
 * VISUAL viewport shrinks. Chromium's automation cannot raise a real keyboard
 * and Playwright cannot shrink `visualViewport`, so the property is shadowed
 * on the live object and the driver's own event is dispatched.
 *
 * This is the honest emulation of the harder engine. Chrome for Android
 * shrinks the layout viewport instead, which the CSS path already handles;
 * iOS Safari is the case the driver carries, so it is the case measured here.
 *
 * @param {import('@playwright/test').Page} page - Phone page.
 * @param {number} insetPx - Keyboard height in CSS pixels. 0 restores.
 * @returns {Promise<void>} Resolves after the driver's settle window.
 */
async function emulateKeyboard(page, insetPx) {
  await page.evaluate((inset) => {
    const vv = window.visualViewport;
    if (!vv) return;
    if (!window.__mwRealVvHeight) window.__mwRealVvHeight = vv.height;
    const target = inset > 0 ? window.__mwRealVvHeight - inset : window.__mwRealVvHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => target });
    vv.dispatchEvent(new Event('resize'));
  }, insetPx);
  // The driver coalesces on a 150ms settle. Wait past two of them plus the
  // claim-suppression window it opens, so the measurement is of the settled
  // state rather than of the animation.
  await page.waitForTimeout(1000);
}

/**
 * Close the pane in slot 0 and kill its PTY, by session id, on one page only.
 *
 * @param {import('@playwright/test').Page} page - Page owning the pane.
 * @returns {Promise<void>} Resolves once the pane is gone.
 */
async function killPane(page) {
  await page.evaluate(async () => {
    const pane = window.cwm.terminalPanes && window.cwm.terminalPanes[0];
    const sessionId = pane && pane.sessionId;
    if (sessionId) {
      try {
        await window.cwm.api('POST', '/api/pty/' + encodeURIComponent(sessionId) + '/kill');
      } catch (_) { /* an already-dead session is the outcome we wanted */ }
    }
    if (pane && typeof pane.dispose === 'function') pane.dispose();
    if (window.cwm.terminalPanes) window.cwm.terminalPanes[0] = null;
  });
}

/**
 * Type one harmless byte on a page's pane, which is what a person at a
 * laptop does and what the server reads as an unambiguous geometry claim.
 *
 * An ESC byte is chosen deliberately: the fixture ignores stdin entirely, and
 * ESC is the one byte that cannot be mistaken for a command by anything that
 * might later be attached to this harness.
 *
 * @param {import('@playwright/test').Page} page - Page owning the pane.
 * @returns {Promise<boolean>} Whether the frame went out.
 */
async function typeOnDesktop(page) {
  return page.evaluate(() => {
    const pane = window.cwm.terminalPanes && window.cwm.terminalPanes[0];
    if (!pane || !pane.ws || pane.ws.readyState !== 1) return false;
    pane.ws.send(JSON.stringify({ type: 'input', data: '' }));
    return true;
  });
}

/**
 * Detach the pane in slot 0 WITHOUT killing the PTY, so the other client
 * keeps its session. Used between situations that reuse the shared pane.
 *
 * @param {import('@playwright/test').Page} page - Page owning the pane.
 * @returns {Promise<void>} Resolves once the pane is gone.
 */
async function detachPane(page) {
  await page.evaluate(() => {
    const pane = window.cwm.terminalPanes && window.cwm.terminalPanes[0];
    if (pane && typeof pane.dispose === 'function') pane.dispose();
    if (window.cwm.terminalPanes) window.cwm.terminalPanes[0] = null;
  });
}

/* ═══════════════════════════════════════════════════════════════
   CAPTURE
   ═══════════════════════════════════════════════════════════════ */

/**
 * Resolve the output directory from --out, --label, or the default.
 *
 * @param {string[]} argv - Process arguments.
 * @returns {string} Absolute output directory.
 */
function resolveOutputDir(argv) {
  const outIndex = argv.indexOf('--out');
  if (outIndex !== -1 && argv[outIndex + 1]) return path.resolve(argv[outIndex + 1]);
  const labelIndex = argv.indexOf('--label');
  const label = labelIndex !== -1 && argv[labelIndex + 1] ? argv[labelIndex + 1] : 'after';
  assert.match(label, /^[a-z0-9][a-z0-9._-]*$/i, 'screenshot label must be a simple file-safe name');
  return path.join(PROJECT_ROOT, 'screenshots', 'mobile-terminal', label);
}

/**
 * Photograph a page and assert the result is a real, safely sized PNG.
 *
 * @param {import('@playwright/test').Page} page - Page to capture.
 * @param {string} outputDir - Destination directory.
 * @param {string} name - File stem.
 * @returns {Promise<object>} Shot record for the manifest.
 */
async function capture(page, outputDir, name) {
  const file = path.join(outputDir, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  const dims = pngDimensions(file);
  assert.ok(dims.bytes >= MIN_PNG_BYTES, name + ' captured an empty image');
  assert.ok(dims.width <= ABSOLUTE_MAX_DIM && dims.height <= ABSOLUTE_MAX_DIM,
    name + ' exceeds the ' + ABSOLUTE_MAX_DIM + 'px image guard at ' + dims.width + 'x' + dims.height);
  return { name, file: file.replace(/\\/g, '/'), width: dims.width, height: dims.height, bytes: dims.bytes };
}

/**
 * Strip the bulky row arrays before a measurement is written to the manifest.
 * The rows are needed for the fidelity comparison and for nothing else; a
 * manifest with six full screen dumps in it is unreadable.
 *
 * @param {object} m - A measurement record.
 * @returns {object} The record without its row array, plus a short sample.
 */
function trimRows(m) {
  const copy = Object.assign({}, m);
  if (Array.isArray(copy.rows)) {
    copy.rowSample = copy.rows.filter((r) => r.trim().length > 0).slice(0, 12);
    delete copy.rows;
  }
  return copy;
}

/* ═══════════════════════════════════════════════════════════════
   THE RUN
   ═══════════════════════════════════════════════════════════════ */

/**
 * Drive the six situations, record every measurement, and write a manifest.
 *
 * @returns {Promise<void>} Resolves when the run and its cleanup are done.
 */
async function run() {
  assert.strictEqual(process.platform, 'win32',
    'the mobile terminal harness must run on Windows before creating state or starting services');

  const argv = process.argv.slice(2);
  const assertMode = !argv.includes('--no-assert');
  const outputDir = resolveOutputDir(argv);
  fs.mkdirSync(outputDir, { recursive: true });

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let child = null;
  let browser = null;
  // Hoisted so the finally block can stop the interval even when a situation
  // throws halfway through. A live interval holding a page reference is how a
  // harness hangs after its own failure.
  let serverPoller = null;
  const manifest = {
    capturedAt: new Date().toISOString(),
    label: path.basename(outputDir),
    outputDir: outputDir.replace(/\\/g, '/'),
    fixture: { turns: FIXTURE_TURNS, frameRowChars: FRAME_ROW_CHARS },
    desktop: DESKTOP_VIEWPORT,
    phone: Object.assign({ deviceScaleFactor: PHONE_SCALE }, PHONE_VIEWPORT),
    situations: {},
    shots: [],
  };
  const failures = [];

  /**
   * Record an expectation without aborting the run. The BEFORE pass is
   * expected to fail most of these, and capturing all six situations anyway
   * is the entire point of that pass.
   *
   * @param {string} id - Situation id.
   * @param {boolean} ok - Whether the expectation held.
   * @param {string} message - What was expected.
   * @returns {void}
   */
  const expect = (id, ok, message) => {
    if (!ok) failures.push(id + ': ' + message);
  };

  try {
    const started = await startWorkbook(sandbox);
    child = started.child;
    seedTranscript(started.profile, PHONE_SESSION_ID, 12);

    browser = await chromium.launch({ headless: true });

    const blockExternal = async (context) => {
      await context.route(/^https?:\/\//, (route) => {
        const target = new URL(route.request().url());
        if (target.hostname === '127.0.0.1') return route.continue();
        return route.abort('blockedbyclient');
      });
    };

    // ── Desktop client ────────────────────────────────────────────
    const desktopContext = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    await blockExternal(desktopContext);
    await desktopContext.addInitScript(installFrameCounter);
    await desktopContext.addInitScript(() => {
      try { localStorage.setItem('cwm_copyhint_v1', '1'); } catch (_) { /* first-run storage */ }
    });
    const desktop = await desktopContext.newPage();
    await desktop.goto(started.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await desktop.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    await desktop.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token);

    // The startup token is single use. The phone reuses the SESSION token the
    // desktop exchanged it for, which is how a second device joins once it
    // has been paired.
    const sessionToken = await desktop.evaluate(() => window.cwm.state.token);
    assert.ok(sessionToken, 'the desktop client did not obtain a session token');

    // ── Phone client ──────────────────────────────────────────────
    const phoneContext = await browser.newContext({
      viewport: PHONE_VIEWPORT,
      deviceScaleFactor: PHONE_SCALE,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
    });
    await blockExternal(phoneContext);
    await phoneContext.addInitScript(installFrameCounter);
    await phoneContext.addInitScript(installGeometrySampler);
    await phoneContext.addInitScript((token) => {
      try {
        localStorage.setItem('cwm_token', token);
        // The one-time copy coach mark is onboarding, not terminal output. It
        // covers a third of the pane, so a screenshot taken with it up is a
        // photograph of a tooltip. Marking it seen is exactly what a returning
        // user's storage already says.
        localStorage.setItem('cwm_copyhint_v1', '1');
      } catch (_) { /* first-run storage */ }
    }, sessionToken);
    const phone = await phoneContext.newPage();
    await phone.goto(started.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await phone.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    await phone.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token);

    // The phone paths under test are gated on a real coarse primary pointer
    // AND real touch points (terminal.js `_isMobile`). If the emulation does
    // not satisfy both, every phone measurement below measures a desktop.
    const phoneEnv = await phone.evaluate(() => ({
      coarse: window.matchMedia('(pointer: coarse)').matches,
      touchPoints: navigator.maxTouchPoints,
      isPhone: !!(window.cwm && window.cwm.isPhone),
      dpr: window.devicePixelRatio,
    }));
    manifest.phoneEnv = phoneEnv;
    assert.ok(phoneEnv.coarse && phoneEnv.touchPoints > 0,
      'the phone context does not present as a touch device: ' + JSON.stringify(phoneEnv));
    assert.ok(phoneEnv.isPhone, 'the application did not enter its phone layout at 390px');

    // ── The continuous geometry record ────────────────────────────
    // Both timelines run for the whole session. Each situation closes a
    // window over them, so "did the phone ever render at a width the PTY did
    // not hold" is answered across the whole situation rather than at the one
    // instant the shutter happened to open.
    let watchedSessionId = SHARED_SESSION_ID;
    serverPoller = startServerGeometryPoller(desktop, () => watchedSessionId);
    let windowStartedAt = Date.now();

    /**
     * Close the geometry window and attach its summary to a measurement.
     *
     * @param {object} record - The situation's measurement record.
     * @returns {Promise<object>} The same record, with `geometry` attached.
     */
    const closeGeometryWindow = async (record) => {
      const endedAt = Date.now();
      const clientSamples = await phone.evaluate(() => (window.__mwGeometry
        ? window.__mwGeometry.read()
        : []));
      record.geometry = summariseDivergence(
        clientSamples, serverPoller.samples, windowStartedAt, endedAt);
      windowStartedAt = endedAt;
      return record;
    };

    /* ── Situation 1: the desktop owns the geometry ───────────────
       This is the reported scenario, driven exactly as it happens.
       The desktop opens the pane and owns it. The phone attaches with
       every default in place, which is the honest starting point: the
       escape hatch is off by default and nobody turns it on before
       looking at their phone. Then the desktop is TYPED ON, which is
       what a person at a laptop does, and the width comes back to it.
       From that moment the phone is a non-owner watching a frame built
       for a width it does not have, and that is the screen the user
       described. */
    await openPane(desktop, SHARED_SESSION_ID, 'Shared pane');
    await desktop.evaluate(() => {
      const pane = window.cwm.terminalPanes[0];
      if (pane) pane.activate();
    });
    await desktop.waitForTimeout(700);

    const serverAfterDesktop = await readServerSession(desktop, SHARED_SESSION_ID);
    const desktopBaseline = await desktop.evaluate(measurePaneInPage,
      { slot: 0, frameRowCount: FRAME_ROW_COUNT, ptyCols: serverAfterDesktop ? serverAfterDesktop.cols : 0 });
    assert.ok(serverAfterDesktop, 'the shared PTY session did not appear in /api/pty');
    assert.ok(serverAfterDesktop.cols >= FRAME_MIN_COLS,
      'the desktop did not open the PTY wide enough for the fixture frame: ' + serverAfterDesktop.cols);
    manifest.desktopBaseline = trimRows(desktopBaseline);
    manifest.desktopBaseline.server = serverAfterDesktop;

    await openPane(phone, SHARED_SESSION_ID, 'Shared pane');
    await focusPhonePane(phone);
    await phone.waitForTimeout(1500);

    // What merely LOOKING at the session on a phone did to the desktop's
    // terminal. No key was pressed on the phone and no affordance was
    // tapped, so any change here is a claim the user did not make.
    const afterPhoneAttach = await readServerSession(desktop, SHARED_SESSION_ID);
    manifest.passiveAttach = {
      desktopOwned: serverAfterDesktop.cols + 'x' + serverAfterDesktop.rows,
      afterPhoneAttached: afterPhoneAttach
        ? afterPhoneAttach.cols + 'x' + afterPhoneAttach.rows
        : null,
      phoneInputFrames: await phone.evaluate(() => (window.__mwFrames
        ? window.__mwFrames.read().inputs
        : [])),
    };
    expect('1-desktop-owns',
      !!afterPhoneAttach && afterPhoneAttach.cols === serverAfterDesktop.cols &&
      afterPhoneAttach.rows === serverAfterDesktop.rows,
      'opening the session on a phone must not take the geometry from the ' +
      'desktop without a gesture (' + manifest.passiveAttach.desktopOwned + ' became ' +
      manifest.passiveAttach.afterPhoneAttached + ')');

    // The desktop is typed on, which is an unambiguous claim, and the width
    // returns to it. Everything after this line is the phone as a non-owner.
    await typeOnDesktop(desktop);
    const ownerRestored = await waitUntil(async () => {
      const record = await readServerSession(desktop, SHARED_SESSION_ID);
      return record && record.cols === serverAfterDesktop.cols;
    }, CLAIM_SETTLE_MS);
    assert.ok(ownerRestored.ok,
      'the desktop could not take its own geometry back, so the non-owner case is untestable');
    await phone.waitForTimeout(1500);

    const s1 = await measureAgainstServer(phone, SHARED_SESSION_ID, FRAME_ROW_COUNT);
    s1.fidelityPct = fidelityPct(desktopBaseline.rows, s1.rows);
    s1.ownerRestoredMs = ownerRestored.elapsedMs;
    await closeGeometryWindow(s1);
    manifest.situations['1-desktop-owns'] = trimRows(s1);
    manifest.shots.push(await capture(phone, outputDir, '1-desktop-owns'));

    expect('1-desktop-owns', s1.server && s1.xtermCols === s1.server.cols,
      'a non-owning phone must render at the PTY column count (' +
      s1.xtermCols + ' vs ' + (s1.server && s1.server.cols) + ')');
    expect('1-desktop-owns', s1.server && s1.xtermRows === s1.server.rows,
      'a non-owning phone must render at the PTY row count (' +
      s1.xtermRows + ' vs ' + (s1.server && s1.server.rows) + ')');
    expect('1-desktop-owns', s1.intactRows === FRAME_ROW_COUNT,
      'every frame row must survive on one line, got ' + s1.intactRows + '/' + FRAME_ROW_COUNT);
    expect('1-desktop-owns', s1.statusRowVisible,
      'the frame status row must be reachable on the phone');
    expect('1-desktop-owns', s1.fidelityPct === 100,
      'both clients look at one terminal, fidelity was ' + s1.fidelityPct + '%');
    expect('1-desktop-owns', s1.widthNoticeShowing,
      'a phone that is not driving the width must say so');
    expect('1-desktop-owns', s1.fragmentRows === 0,
      'no frame row may be left as a fragment, got ' + s1.fragmentRows);
    expect('1-desktop-owns', s1.rowPositionErrors === 0,
      'every frame row must land on the row the CLI addressed, ' +
      s1.rowPositionErrors + ' were scattered');

    /* ── Situation 2: the phone takes the geometry over ───────────
       Follow goes back on and the pane is tapped, which is the
       gesture a user actually makes. Ownership must flip and the
       frame must be intact afterwards. */
    await setFollow(phone, SHARED_SESSION_ID, true);
    await phone.evaluate(() => { if (window.__mwFrames) window.__mwFrames.reset(); });
    const claimStartedAt = Date.now();
    await phone.evaluate(() => {
      const paneEl = document.getElementById('term-pane-0');
      const notice = paneEl && paneEl.querySelector('.mw-width-notice');
      // The affordance first, because that is the designed route. Falling back
      // to the pane's own claim keeps the situation measurable on a build with
      // no affordance yet, which is precisely the BEFORE case.
      if (notice) { notice.click(); return; }
      const pane = window.cwm.terminalPanes[0];
      if (pane && typeof pane.activate === 'function') pane.activate();
    });
    const claimConverged = await waitUntil(async () => {
      const server = await readServerSession(phone, SHARED_SESSION_ID);
      const m = await phone.evaluate(measurePaneInPage,
        { slot: 0, frameRowCount: FRAME_ROW_COUNT, ptyCols: server ? server.cols : 0 });
      return server && m.mounted && m.xtermCols === server.cols && m.statusRowVisible;
    }, CLAIM_SETTLE_MS);

    await phone.waitForTimeout(700);
    const s2 = await measureAgainstServer(phone, SHARED_SESSION_ID, FRAME_ROW_COUNT);
    s2.claimConvergedMs = claimConverged.ok ? claimConverged.elapsedMs : null;
    s2.claimWallMs = Date.now() - claimStartedAt;
    s2.claimConverged = claimConverged.ok;
    await closeGeometryWindow(s2);
    manifest.situations['2-phone-claims'] = trimRows(s2);
    manifest.shots.push(await capture(phone, outputDir, '2-phone-claims'));

    expect('2-phone-claims', claimConverged.ok,
      'a tap must hand the geometry to the phone within ' + CLAIM_SETTLE_MS + 'ms');
    expect('2-phone-claims', s2.server && s2.server.cols === s2.xtermCols,
      'after the claim the PTY and the phone must agree on the column count');
    expect('2-phone-claims', !s2.widthNoticeShowing,
      'the take-over affordance must clear once this device is driving');
    expect('2-phone-claims', s2.fragmentRows === 0,
      'the repaint after a claim must leave no fragments, got ' + s2.fragmentRows);
    expect('2-phone-claims', s2.geometry && s2.geometry.divergentMs <= CLAIM_SETTLE_MS,
      'the phone must not render at a width the PTY does not hold for longer ' +
      'than the claim takes, diverged for ' + (s2.geometry && s2.geometry.divergentMs) + 'ms');

    manifest.situations['2-phone-claims'].sharedResizeStats =
      (await readServerSession(desktop, SHARED_SESSION_ID) || {}).resizeStats || null;

    await detachPane(phone);
    await phone.waitForTimeout(300);
    await killPane(desktop);
    await desktop.waitForTimeout(400);

    /* ── Situation 3: the phone owns the geometry from the start ── */
    watchedSessionId = PHONE_SESSION_ID;
    windowStartedAt = Date.now();
    await openPane(phone, PHONE_SESSION_ID, 'Phone pane');
    await focusPhonePane(phone);
    await phone.evaluate(() => {
      const pane = window.cwm.terminalPanes[0];
      if (pane && typeof pane.activate === 'function') pane.activate();
    });
    await phone.waitForTimeout(1100);

    const s3 = await measureAgainstServer(phone, PHONE_SESSION_ID, FRAME_ROW_COUNT);
    s3.fontLadder = await phone.evaluate(probeFontLadderInPage, { slot: 0, ladder: FONT_LADDER });
    await closeGeometryWindow(s3);
    manifest.situations['3-phone-only'] = trimRows(s3);
    manifest.shots.push(await capture(phone, outputDir, '3-phone-only'));

    expect('3-phone-only', s3.documentOverflowPx === 0,
      'the phone shell must not scroll horizontally, got ' + s3.documentOverflowPx + 'px');
    expect('3-phone-only', s3.server && s3.xtermCols === s3.server.cols,
      'a phone that owns the geometry must be rendering at it');
    expect('3-phone-only', s3.xtermCols >= 60,
      'a phone-owned pane must fit at least 60 columns, got ' + s3.xtermCols);
    expect('3-phone-only', s3.statusRowVisible,
      'the frame status row must be visible on a phone-owned pane');
    expect('3-phone-only', s3.fragmentRows === 0,
      'a phone-owned pane must hold whole rows, got ' + s3.fragmentRows + ' fragments');

    /* ── Situation 3b: the Terminal tab is hidden and shown again ──
       A phone tab switch hides the pane. A hidden pane measures zero,
       and a fit against a zero rect proposes a 1x1 grid; if that ever
       reaches the PTY the next repaint is aimed at a terminal one cell
       wide. safeFit is supposed to refuse, so this measures whether it
       does, and how long the client and the PTY disagree across the
       round trip. */
    windowStartedAt = Date.now();
    await phone.evaluate(() => window.cwm.setViewMode('workspace'));
    await phone.waitForTimeout(1200);
    const hiddenGeometry = await phone.evaluate(() => {
      const pane = window.cwm.terminalPanes[0];
      const el = document.getElementById('term-container-0');
      return {
        cols: pane && pane.term ? pane.term.cols : null,
        rows: pane && pane.term ? pane.term.rows : null,
        containerWidth: el ? Math.round(el.getBoundingClientRect().width) : null,
        containerHeight: el ? Math.round(el.getBoundingClientRect().height) : null,
      };
    });
    await focusPhonePane(phone);
    await phone.waitForTimeout(1200);
    const s3b = await measureAgainstServer(phone, PHONE_SESSION_ID, FRAME_ROW_COUNT);
    s3b.hiddenGeometry = hiddenGeometry;
    await closeGeometryWindow(s3b);
    manifest.situations['3b-tab-switch'] = trimRows(s3b);
    manifest.shots.push(await capture(phone, outputDir, '3b-tab-switch'));

    expect('3b-tab-switch', hiddenGeometry.cols === null || hiddenGeometry.cols > 1,
      'a hidden pane must never be fitted to a degenerate grid, saw ' +
      hiddenGeometry.cols + ' columns');
    expect('3b-tab-switch', s3b.server && s3b.xtermCols === s3b.server.cols,
      'returning to the Terminal tab must leave the client and the PTY agreeing');
    expect('3b-tab-switch', s3b.fragmentRows === 0,
      'the repaint after a tab switch must leave no fragments, got ' + s3b.fragmentRows);
    expect('3b-tab-switch', s3b.statusRowVisible,
      'the frame must be whole again after a tab switch');

    /* ── Situation 4: scrolling back and returning to live ──────── */
    await phone.evaluate(() => {
      const pane = window.cwm.terminalPanes[0];
      if (pane && typeof pane.openHistory === 'function') pane.openHistory('harness');
    });
    await phone.waitForFunction(
      () => {
        const seg = document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="transcript"]');
        return !!seg && seg.textContent.length > 0;
      },
      { timeout: 20000 }
    ).catch(() => { /* an empty archive is still a measurable state */ });
    await phone.waitForTimeout(600);

    const historyState = await phone.evaluate(() => {
      const doc = document.querySelector('#term-pane-0 .terminal-history-doc');
      const live = document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="live"]');
      const archive = document.querySelector('#term-pane-0 .terminal-history-seg[data-seg="transcript"]');
      const measure = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          whiteSpace: cs.whiteSpace,
        };
      };
      // The seam's own fraying question: a segment whose longest line is far
      // wider than the surface either wraps (soft fray) or clips (hard fray),
      // and either way it was width-locked somewhere else.
      const longest = (el) => {
        if (!el) return 0;
        let max = 0;
        for (const line of el.textContent.split('\n')) max = Math.max(max, line.length);
        return max;
      };
      const screenEl = document.querySelector('#term-pane-0 .xterm-screen');
      const out = {
        open: !!doc,
        docMetrics: measure(doc),
        screenMetrics: measure(screenEl),
        liveMetrics: measure(live),
        archiveMetrics: measure(archive),
        archiveChars: archive ? archive.textContent.length : 0,
        archiveLongestLine: longest(archive),
        liveLongestLine: longest(live),
      };
      if (doc) {
        const rule = doc.querySelector('.terminal-history-rule');
        if (rule) doc.scrollTop = Math.max(0, rule.offsetTop - Math.round(doc.clientHeight / 2));
        out.scrollTop = doc.scrollTop;
        out.scrollHeight = doc.scrollHeight;
        out.horizontalOverflowPx = Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth));
      }
      return out;
    });
    await phone.waitForTimeout(500);
    manifest.shots.push(await capture(phone, outputDir, '4-history-seam'));

    await phone.evaluate(() => {
      const pane = window.cwm.terminalPanes[0];
      if (pane && typeof pane.closeHistory === 'function') pane.closeHistory('harness');
    });
    await phone.waitForTimeout(800);
    const s4 = await measureAgainstServer(phone, PHONE_SESSION_ID, FRAME_ROW_COUNT);
    s4.history = historyState;
    await closeGeometryWindow(s4);
    manifest.situations['4-history-scroll'] = trimRows(s4);
    manifest.shots.push(await capture(phone, outputDir, '4-history-return'));

    expect('4-history-scroll', historyState.open,
      'the unified scrollback surface must open on a phone');
    expect('4-history-scroll', s4.duplicateRows === 0,
      'returning from history must not duplicate live rows, got ' + s4.duplicateRows);
    expect('4-history-scroll', s4.statusRowVisible,
      'the live frame must still be whole after a history round trip');
    expect('4-history-scroll', historyState.liveMetrics && historyState.archiveMetrics &&
      historyState.liveMetrics.fontSize === historyState.archiveMetrics.fontSize,
      'the history layer and the live screen must share one font metric');
    expect('4-history-scroll', s4.fragmentRows === 0,
      'the live screen must hold whole rows after a history round trip, got ' +
      s4.fragmentRows + ' fragments');
    expect('4-history-scroll', s4.server && s4.xtermCols === s4.server.cols,
      'closing the history layer must leave the client and the PTY agreeing');

    /* ── Situation 5: the soft keyboard ─────────────────────────── */
    await phone.evaluate(() => { if (window.__mwFrames) window.__mwFrames.reset(); });
    await emulateKeyboard(phone, 336);
    const s5 = await measureAgainstServer(phone, PHONE_SESSION_ID, FRAME_ROW_COUNT);
    s5.keyboardGeometry = await phone.evaluate(() => (window.MyrlinMobileViewport
      ? window.MyrlinMobileViewport.last
      : null));
    await closeGeometryWindow(s5);
    manifest.situations['5-keyboard'] = trimRows(s5);
    manifest.shots.push(await capture(phone, outputDir, '5-keyboard'));

    expect('5-keyboard', s5.statusRowVisible,
      'the bottom of the frame must stay reachable when the keyboard is up');
    expect('5-keyboard', s5.frames && s5.frames.resize <= 2,
      'one keyboard animation must not produce a resize storm, got ' +
      (s5.frames ? s5.frames.resize : 'unknown'));
    expect('5-keyboard', s5.server && s5.xtermCols === s5.server.cols &&
      s5.xtermRows === s5.server.rows,
      'the keyboard must not leave the client and the PTY at different sizes (' +
      s5.xtermCols + 'x' + s5.xtermRows + ' vs ' +
      (s5.server && s5.server.cols + 'x' + s5.server.rows) + ')');
    expect('5-keyboard', s5.fragmentRows === 0,
      'the repaint after a keyboard animation must leave no fragments, got ' + s5.fragmentRows);

    await emulateKeyboard(phone, 0);
    await phone.waitForTimeout(600);
    await killPane(phone);
    await phone.waitForTimeout(300);

    /* ── Situation 6: the sidecar snapshot on a fresh attach ──────
       The desktop takes the shared pane and owns its geometry, then
       the phone attaches to it cold after a reload. Everything the
       phone sees comes from the server's replay rather than from live
       output, which is the state a phone wakes up into. */
    watchedSessionId = SHARED_SESSION_ID;
    windowStartedAt = Date.now();
    await openPane(desktop, SHARED_SESSION_ID, 'Shared pane');
    await desktop.evaluate(() => {
      const pane = window.cwm.terminalPanes[0];
      if (pane) pane.activate();
    });
    await desktop.waitForTimeout(1000);
    const desktopBaseline6 = await measureAgainstServer(desktop, SHARED_SESSION_ID, FRAME_ROW_COUNT);

    await phone.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await phone.locator('#app').waitFor({ state: 'visible', timeout: 30000 });
    await phone.waitForFunction(() => window.cwm && window.cwm.state && window.cwm.state.token);
    await openPane(phone, SHARED_SESSION_ID, 'Shared pane');
    await focusPhonePane(phone);
    await phone.waitForTimeout(1200);
    // The laptop is typed on again, so the replayed screen the phone is
    // holding belongs to a geometry the phone does not have. This is the
    // state a phone wakes up into after the desktop has been used.
    await typeOnDesktop(desktop);
    await waitUntil(async () => {
      const record = await readServerSession(desktop, SHARED_SESSION_ID);
      return record && record.cols === (desktopBaseline6.server ? desktopBaseline6.server.cols : 0);
    }, CLAIM_SETTLE_MS);
    await phone.waitForTimeout(1500);

    const s6 = await measureAgainstServer(phone, SHARED_SESSION_ID, FRAME_ROW_COUNT);
    s6.fidelityPct = fidelityPct(desktopBaseline6.rows, s6.rows);
    await closeGeometryWindow(s6);
    manifest.situations['6-sidecar-replay'] = trimRows(s6);
    manifest.shots.push(await capture(phone, outputDir, '6-sidecar-replay'));

    expect('6-sidecar-replay', s6.server && s6.xtermCols === s6.server.cols,
      'the replayed snapshot must be rendered at the PTY width (' +
      s6.xtermCols + ' vs ' + (s6.server && s6.server.cols) + ')');
    expect('6-sidecar-replay', s6.intactRows === FRAME_ROW_COUNT,
      'a replayed snapshot must not arrive shattered, got ' + s6.intactRows + '/' + FRAME_ROW_COUNT);
    expect('6-sidecar-replay', s6.fidelityPct === 100,
      'a replayed snapshot must match the owner screen, fidelity was ' + s6.fidelityPct + '%');
    expect('6-sidecar-replay', s6.fragmentRows === 0,
      'a replayed snapshot must not arrive frayed, got ' + s6.fragmentRows + ' fragments');
    expect('6-sidecar-replay', s6.rowPositionErrors === 0,
      'a replayed snapshot must put every row where the CLI addressed it, ' +
      s6.rowPositionErrors + ' were scattered');

    await killPane(phone);
    await killPane(desktop);
    serverPoller.stop();

    manifest.failures = failures;
    fs.writeFileSync(path.join(outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    printSummary(manifest, failures, assertMode);
    if (assertMode && failures.length) {
      throw new Error(failures.length + ' mobile terminal expectation(s) failed:\n  ' +
        failures.join('\n  '));
    }
  } finally {
    if (serverPoller) {
      try { serverPoller.stop(); } catch (_) { /* an already-stopped timer */ }
    }
    if (browser) {
      try { await browser.close(); } catch (_) { /* the run is over either way */ }
    }
    try { await stopWorkbook(child); } finally { removeSandbox(sandbox); }
  }
}

/**
 * Print the measurement table this harness exists to produce.
 *
 * @param {object} manifest - The recorded run.
 * @param {string[]} failures - Expectations that did not hold.
 * @param {boolean} assertMode - Whether failures will fail the process.
 * @returns {void}
 */
function printSummary(manifest, failures, assertMode) {
  const pad = (v, n) => String(v === undefined || v === null ? '-' : v).padEnd(n);
  console.log('');
  console.log('  mobile terminal harness: ' + manifest.label);
  if (manifest.desktopBaseline && manifest.desktopBaseline.server) {
    console.log('  desktop baseline: xterm ' + manifest.desktopBaseline.xtermCols + 'x' +
      manifest.desktopBaseline.xtermRows + ', PTY ' + manifest.desktopBaseline.server.cols + 'x' +
      manifest.desktopBaseline.server.rows + ', intact ' + manifest.desktopBaseline.intactRows +
      '/' + FRAME_ROW_COUNT);
  }
  console.log('  ' + '-'.repeat(104));
  console.log('  situation           xterm     PTY       intact  seen    scatter  frag  bottom  fidelity  diverged');
  for (const [id, m] of Object.entries(manifest.situations)) {
    console.log(
      '  ' + pad(id, 20) +
      pad(m.mounted ? m.xtermCols + 'x' + m.xtermRows : 'unmounted', 10) +
      pad(m.server ? m.server.cols + 'x' + m.server.rows : 'n/a', 10) +
      pad(m.intactRows === undefined ? null : m.intactRows + '/' + FRAME_ROW_COUNT, 8) +
      pad(m.visibleRows === undefined ? null : m.visibleRows + '/' + FRAME_ROW_COUNT, 8) +
      pad(m.rowPositionErrors, 9) +
      pad(m.fragmentRows, 6) +
      pad(m.statusRowVisible === undefined ? null : (m.statusRowVisible ? 'yes' : 'NO'), 8) +
      pad(m.fidelityPct === undefined || m.fidelityPct === null ? null : m.fidelityPct + '%', 10) +
      pad(m.geometry ? m.geometry.divergentMs + 'ms' : null, 10)
    );
  }
  console.log('  ' + '-'.repeat(104));
  console.log('  scatter = frame rows painted onto a row the CLI did not address');
  console.log('  frag    = rows carrying only part of a frame row (truncated, orphan tail, interior)');
  console.log('  diverged= wall time the phone rendered at geometry the PTY did not hold');
  console.log('  ' + '-'.repeat(104));
  const ladder = manifest.situations['3-phone-only'] && manifest.situations['3-phone-only'].fontLadder;
  if (Array.isArray(ladder) && ladder.length) {
    console.log('  phone font ladder (390px viewport):');
    for (const entry of ladder) {
      console.log('    ' + pad(entry.fontSizePx + 'px', 7) + pad(entry.cols + ' cols', 11) +
        pad(entry.rows + ' rows', 11) + 'cell ' + entry.cellWidthPx + 'px');
    }
    console.log('  ' + '-'.repeat(88));
  }
  if (failures.length === 0) {
    console.log('  all expectations hold');
  } else {
    console.log('  ' + failures.length + ' expectation(s) not met' +
      (assertMode ? '' : ' (recorded, not enforced in this pass)') + ':');
    for (const f of failures) console.log('    - ' + f);
  }
  console.log('');
}

run().catch((error) => {
  console.error('mobile terminal harness failed:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
