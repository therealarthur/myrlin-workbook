#!/usr/bin/env node
/**
 * VT sidecar tests: golden byte streams, snapshot replay fidelity, the mode
 * signal, the containment guard, the bounds, and the viewport-ownership
 * contention control.
 *
 * Notion-restyle phase P6. Gates BUILD-CONTRACT P6.1 through P6.4 and the
 * P6 row of the per-phase gate table:
 *
 *   "A forced require failure leaves the server up. A prefix-pruned byte
 *    stream still snapshots correctly. One resize per settle window with two
 *    clients attached."
 *
 * TEST STRATEGY. The load-bearing assertion for the sidecar is not "the
 * snapshot string looks right", it is "a fresh terminal fed the snapshot ends
 * up in the SAME STATE as the sidecar". So the golden-stream tests build a
 * second, independent headless terminal, write the snapshot into it, and
 * compare the two grids cell by cell including foreground, background and
 * every rendition flag, plus the scrollback, the cursor position and the
 * buffer type. A serializer bug cannot pass that by accident.
 *
 * The byte streams are synthesised from the escape-sequence census in
 * TERMINAL-ARCHITECTURE section 2 (alternate buffer, mouse tracking 1000 plus
 * 1002 plus 1003 with SGR 1006, bracketed paste 2004, focus 1004, ConPTY
 * win32 input 9001, absolute cursor addressing, erase line) rather than
 * copied from a capture, so the fixtures are hermetic: no file reads, no
 * corpus scan, no dependency on a live session.
 *
 * Everything is hermetic and in-process: no server is started, no port is
 * bound, no real PTY is spawned (pty.spawn is stubbed through the existing
 * `_ptySpawnForTesting` seam), and CWM_DATA_DIR is sandboxed to a tmpdir.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

const assert = require('assert');

// The ownership settle window is read once at pty-manager load time, so a
// short window has to be in the environment before the first require. 60ms
// keeps the contention test fast while staying far above timer jitter.
const TEST_DEBOUNCE_MS = 60;
const TEST_CONTENTION_CLEAR_MS = 400;
process.env.CWM_PTY_OWNERSHIP_DEBOUNCE_MS = String(TEST_DEBOUNCE_MS);
process.env.CWM_PTY_OWNERSHIP_CONTENTION_CLEAR_MS = String(TEST_CONTENTION_CLEAR_MS);

const {
  VtSidecar,
  VtSidecarRegistry,
  getVtSidecarAvailability,
  isSidecarEnabled,
  isSnapshotReplayEnabled,
  serializePrivateModes,
  VT_SNAPSHOT_PREAMBLE,
  VT_SIDECAR_MAX_SESSIONS,
  VT_SIDECAR_SCROLLBACK,
  VT_LINE_LOG_MAX_LINES,
} = require('../src/web/vt-sidecar');

let passed = 0;
let failed = 0;
const only = process.env.VT_TEST_ONLY || null;

/**
 * Run one async assertion block, reporting pass or fail without aborting the
 * rest of the file. Mirrors the check() helper in pty-resize-ownership.test.js
 * with await support, because the headless terminal parses asynchronously.
 *
 * @param {string} name
 * @param {Function} fn - Sync or async body.
 */
async function check(name, fn) {
  if (only && name.indexOf(only) === -1) return;
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    const detail = err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n        ') : String(err);
    console.log('        ' + detail);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

/**
 * The measured agent-CLI startup handshake (TERMINAL-ARCHITECTURE 2.4),
 * verbatim in shape: ConPTY win32 input mode, focus reporting, a normal
 * buffer wipe, the window title, bracketed paste, the colour-scheme query,
 * ENTER ALTERNATE BUFFER, the alt clear, then all three mouse tracking modes
 * with SGR 1006 encoding.
 */
const AGENT_STARTUP =
  '\x1b[?9001h' +
  '\x1b[?1004h' +
  '\x1b[?25l' +
  '\x1b[2J\x1b[m\x1b[H' +
  '\x1b]0;agent\x07' +
  '\x1b[?25h' +
  '\x1b[?2004h' +
  '\x1b[?2031h' +
  '\x1b[?1049h' +
  '\x1b[2J' +
  '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

/**
 * The measured repaint idiom: absolute cursor addressing, erase-line, a
 * cursor-hide/show wrapper, and an in-place token counter. This is what an
 * alternate-screen agent pane actually emits thousands of times, and it is
 * exactly the stream whose PREFIX gets pruned out of the 100KB byte ring.
 *
 * @param {number} n - Token count to paint.
 * @returns {string} One repaint frame.
 */
function agentRepaint(n) {
  return '\x1b[?25l' +
    '\x1b[3;1H\x1b[K\x1b[36m> summarise the build contract\x1b[0m' +
    '\x1b[5;1H\x1b[K\x1b[1mthinking\x1b[0m ' + n + ' tokens' +
    '\x1b[7;1H\x1b[K\x1b[2m  esc to interrupt\x1b[0m' +
    '\x1b[9;3H' +
    '\x1b[?25h';
}

/** A plain, line-oriented shell stream: no alternate buffer, real scroll-off. */
function shellStream(lines) {
  let out = '';
  for (let i = 0; i < lines; i++) out += 'shell-line-' + i + '\r\n';
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Grid comparison helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render one buffer row as a comparable string carrying content AND full
 * rendition, so a colour or attribute regression fails the test rather than
 * slipping through a text-only comparison.
 *
 * @param {object} buffer - IBuffer.
 * @param {number} y - Absolute line index.
 * @param {number} cols - Terminal width.
 * @param {object} cellRef - Reusable IBufferCell.
 * @returns {string}
 */
function renderRow(buffer, y, cols, cellRef) {
  const line = buffer.getLine(y);
  if (!line) return '<missing>';
  let s = '';
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cellRef);
    if (!c) break;
    if (c.getWidth() === 0) continue;
    const ch = c.getChars() || ' ';
    const fg = c.isFgDefault() ? 'D' : (c.isFgRGB() ? 'R' + c.getFgColor() : 'P' + c.getFgColor());
    const bg = c.isBgDefault() ? 'D' : (c.isBgRGB() ? 'R' + c.getBgColor() : 'P' + c.getBgColor());
    const flags =
      (c.isBold() ? 'b' : '') + (c.isItalic() ? 'i' : '') + (c.isUnderline() ? 'u' : '') +
      (c.isInverse() ? 'v' : '') + (c.isDim() ? 'd' : '') + (c.isStrikethrough() ? 's' : '');
    s += ch + '|' + fg + '/' + bg + (flags ? '/' + flags : '') + ' ';
  }
  return s.trimEnd();
}

/**
 * Plain viewport text, no rendition. Used where a test asks "is this glyph
 * sequence on screen"; renderRow interleaves attribute tokens between every
 * character, so a substring search against it would never match.
 *
 * @param {object} term - A headless Terminal.
 * @returns {string} Viewport rows joined by newlines.
 */
function viewportText(term) {
  const b = term.buffer.active;
  const out = [];
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
}

/**
 * Full comparable state of a terminal: viewport grid with rendition, the
 * scrollback text above it, the cursor position and the buffer type.
 *
 * @param {object} term - A headless Terminal.
 * @returns {{viewport: string[], scrollback: string[], cursor: string, type: string}}
 */
function terminalState(term) {
  const b = term.buffer.active;
  const cellRef = b.getNullCell();
  const viewport = [];
  for (let y = b.baseY; y < b.baseY + term.rows; y++) viewport.push(renderRow(b, y, term.cols, cellRef));
  const scrollback = [];
  for (let y = 0; y < b.baseY; y++) {
    const line = b.getLine(y);
    scrollback.push(line ? line.translateToString(true) : '<missing>');
  }
  return {
    viewport,
    scrollback,
    cursor: b.cursorX + ',' + b.cursorY,
    type: b.type,
  };
}

/**
 * Assert that a fresh terminal fed `snapshot` reaches exactly the state of
 * `sidecar`'s shadow. This is the golden-stream assertion: it is what proves
 * the snapshot IS the state rather than merely resembling it.
 *
 * @param {VtSidecar} sidecar
 * @param {string} snapshot
 * @param {string} label
 * @returns {Promise<void>}
 */
function assertRendersIdentically(sidecar, snapshot, label) {
  return new Promise((resolve, reject) => {
    const { Terminal } = require('@xterm/headless');
    const fresh = new Terminal({
      cols: sidecar.term.cols,
      rows: sidecar.term.rows,
      scrollback: VT_SIDECAR_SCROLLBACK,
      allowProposedApi: true,
    });
    fresh.write(snapshot, () => {
      try {
        const want = terminalState(sidecar.term);
        const got = terminalState(fresh);
        assert.strictEqual(got.type, want.type, label + ': buffer type');
        assert.deepStrictEqual(got.viewport, want.viewport, label + ': viewport grid');
        assert.deepStrictEqual(got.scrollback, want.scrollback, label + ': scrollback');
        assert.strictEqual(got.cursor, want.cursor, label + ': cursor position');
        assert.strictEqual(
          fresh.modes.bracketedPasteMode, sidecar.term.modes.bracketedPasteMode,
          label + ': bracketed paste mode'
        );
        assert.strictEqual(
          fresh.modes.mouseTrackingMode, sidecar.term.modes.mouseTrackingMode,
          label + ': mouse tracking mode'
        );
        fresh.dispose();
        resolve();
      } catch (err) {
        try { fresh.dispose(); } catch (_) {}
        reject(err);
      }
    });
  });
}

/**
 * Write a chunk into a sidecar and resolve once the shadow has parsed it and
 * updated its derived state.
 *
 * @param {VtSidecar} sidecar
 * @param {string} data
 * @returns {Promise<void>}
 */
function feed(sidecar, data) {
  return new Promise((resolve) => {
    if (!sidecar.write(data, resolve)) resolve();
  });
}

/** Build a sidecar directly, bypassing the feature flag (unit scope). */
function makeSidecar(opts = {}) {
  const { Terminal } = require('@xterm/headless');
  return new VtSidecar(Object.assign({
    sessionId: 'vt-test',
    cols: 60,
    rows: 12,
    TerminalClass: Terminal,
  }, opts));
}

/** Sleep helper for the timer-driven contention assertions. */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────────────────────
// PTY manager harness (mirrors test/pty-resize-ownership.test.js)
// ──────────────────────────────────────────────────────────────────────────

/** Fake WebSocket recording every frame and exposing its handlers. */
function makeFakeWs() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    _handlers: {},
    on(event, cb) { this._handlers[event] = cb; },
    send(d) { this.sent.push(d); },
    close() {},
    ping() {},
    terminate() {},
    emit(event, ...args) { if (this._handlers[event]) this._handlers[event](...args); },
  };
}

/** Stub PTY capturing resize/write and letting the test drive onData. */
function makeCapturingPty() {
  const handle = { calls: { resize: [], write: [] }, _dataCb: null, _exitCb: null };
  handle.pty = {
    pid: 4243,
    onData: (cb) => { handle._dataCb = cb; },
    onExit: (cb) => { handle._exitCb = cb; },
    on: () => {},
    write: (d) => handle.calls.write.push(d),
    resize: (c, r) => handle.calls.resize.push([c, r]),
    kill: () => {},
  };
  handle.emitData = (d) => { if (handle._dataCb) handle._dataCb(d); };
  handle.emitExit = (code) => { if (handle._exitCb) handle._exitCb({ exitCode: code }); };
  return handle;
}

/** Fresh manager plus one attached client, through the non-provider path. */
function attachFixture(extraOpts) {
  delete require.cache[require.resolve('../src/web/pty-manager')];
  delete require.cache[require.resolve('../src/state/store')];
  delete require.cache[require.resolve('../src/providers')];
  const mod = require('../src/web/pty-manager');
  const mgr = new mod.PtySessionManager();
  const ptyHandle = makeCapturingPty();
  const ws = makeFakeWs();
  const sessionId = 'vt-mgr-' + Math.random().toString(36).slice(2, 10);
  mgr.attachClient(sessionId, ws, Object.assign({
    command: 'td',
    cols: 80,
    rows: 24,
    _ptySpawnForTesting: () => ptyHandle.pty,
  }, extraOpts || {}));
  return { mod, mgr, ptyHandle, ws, sessionId, session: mgr.getSession(sessionId) };
}

/** Parse a sent frame as a JSON control message, or null for raw data. */
function asControl(frame) {
  if (typeof frame !== 'string' || frame.charAt(0) !== '{') return null;
  try { return JSON.parse(frame); } catch (_) { return null; }
}

/** Shorthand for a client-to-server JSON message string. */
function msg(obj) { return JSON.stringify(obj); }

/** Wait until a session's sidecar has drained its write queue. */
async function drain(session, deadlineMs = 3000) {
  const until = Date.now() + deadlineMs;
  while (session.vt && session.vt._pendingBytes > 0 && Date.now() < until) {
    await sleep(2);
  }
}

// ──────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  P6 VT sidecar: snapshot replay, mode signal, width-thrash control');
  console.log('  ' + '-'.repeat(68));

  // ── Capability and flags ───────────────────────────────────────────────

  await check('headless VT is available and reports its serialize-addon status honestly', () => {
    const probe = getVtSidecarAvailability();
    assert.strictEqual(probe.available, true, 'expected @xterm/headless to load: ' + probe.message);
    assert.strictEqual(probe.code, null);
    assert.strictEqual(typeof probe.serializeAddon, 'boolean',
      'the probe must state whether @xterm/addon-serialize is present, not assume it');
  });

  await check('the master flag defaults OFF and the snapshot sub-flag follows it', () => {
    const savedMaster = process.env.CWM_VT_SIDECAR;
    const savedSnap = process.env.CWM_VT_SIDECAR_SNAPSHOT;
    try {
      delete process.env.CWM_VT_SIDECAR;
      delete process.env.CWM_VT_SIDECAR_SNAPSHOT;
      assert.strictEqual(isSidecarEnabled(), false, 'CWM_VT_SIDECAR must default off for one release');
      assert.strictEqual(isSnapshotReplayEnabled(), false, 'snapshot replay must not run with the master off');
      process.env.CWM_VT_SIDECAR = '1';
      assert.strictEqual(isSnapshotReplayEnabled(), true, 'snapshot replay is on by default once the master is on');
      process.env.CWM_VT_SIDECAR_SNAPSHOT = '0';
      assert.strictEqual(isSidecarEnabled(), true, 'the sub-flag must not disable the whole sidecar');
      assert.strictEqual(isSnapshotReplayEnabled(), false, 'the sub-flag is the byte-ring fallback switch');
    } finally {
      if (savedMaster === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = savedMaster;
      if (savedSnap === undefined) delete process.env.CWM_VT_SIDECAR_SNAPSHOT; else process.env.CWM_VT_SIDECAR_SNAPSHOT = savedSnap;
    }
  });

  // ── Containment (BUILD-CONTRACT P6.1 done criterion) ───────────────────

  await check('a forced headless load failure leaves the manager usable and the byte ring in use', async () => {
    const saved = process.env.CWM_VT_SIDECAR;
    process.env.CWM_VT_SIDECAR = '1';
    process.env.CWM_SIMULATE_VT_LOAD_FAILURE = '1';
    // A fresh module instance so the lazy loader re-runs under the simulated
    // failure; without the cache drop the earlier successful load would be
    // memoised and the containment path would never be exercised.
    delete require.cache[require.resolve('../src/web/vt-sidecar')];
    try {
      const fresh = require('../src/web/vt-sidecar');
      const probe = fresh.getVtSidecarAvailability();
      assert.strictEqual(probe.available, false, 'simulated failure must report unavailable');
      assert.strictEqual(probe.code, 'VT_HEADLESS_LOAD_FAILED', 'the code must be stable and machine-readable');

      const registry = new fresh.VtSidecarRegistry();
      assert.strictEqual(registry.isEnabled(), false, 'an unavailable engine is not enabled even with the flag on');
      assert.strictEqual(registry.create('s1', {}), null, 'create must return null, never throw');

      // And the whole manager still spawns, attaches, streams and replays.
      delete require.cache[require.resolve('../src/web/pty-manager')];
      delete require.cache[require.resolve('../src/state/store')];
      delete require.cache[require.resolve('../src/providers')];
      const mod = require('../src/web/pty-manager');
      const mgr = new mod.PtySessionManager();
      const ptyHandle = makeCapturingPty();
      const ws = makeFakeWs();
      const sid = 'vt-contain-' + Math.random().toString(36).slice(2, 8);
      mgr.attachClient(sid, ws, { command: 'td', cols: 80, rows: 24, _ptySpawnForTesting: () => ptyHandle.pty });
      const session = mgr.getSession(sid);
      assert.ok(session, 'the session must exist despite the sidecar failing to load');
      assert.strictEqual(session.vt, null, 'no sidecar was attached');
      ptyHandle.emitData('still streaming');
      assert.strictEqual(ws.sent[ws.sent.length - 1], 'still streaming', 'live data must still reach the client');

      const ws2 = makeFakeWs();
      mgr.attachClient(sid, ws2, {});
      assert.strictEqual(asControl(ws2.sent[0]).type, 'reset');
      assert.strictEqual(ws2.sent[1], 'still streaming', 'the byte ring replay must be intact');
      assert.strictEqual(mgr.buildReplay(session).source, 'ring');
      mgr.killSession(sid);
    } finally {
      delete process.env.CWM_SIMULATE_VT_LOAD_FAILURE;
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
      // Restore the real module for every later test.
      delete require.cache[require.resolve('../src/web/vt-sidecar')];
      delete require.cache[require.resolve('../src/web/pty-manager')];
      require('../src/web/vt-sidecar');
    }
  });

  // ── Golden byte streams: state correctness ─────────────────────────────

  await check('golden stream: a shell session round-trips grid, scrollback, cursor and rendition', async () => {
    const sc = makeSidecar({ cols: 40, rows: 8 });
    try {
      await feed(sc, shellStream(30));
      await feed(sc, '\x1b[1;31mERROR\x1b[0m \x1b[4;38;5;208mwarn\x1b[0m plain\r\n');
      await feed(sc, '\x1b[48;2;20;30;40mtruecolor bg run\x1b[0m\r\n$ ');
      const snap = sc.snapshot();
      assert.ok(snap && snap.startsWith(VT_SNAPSHOT_PREAMBLE), 'snapshot must carry the normalising preamble');
      await assertRendersIdentically(sc, snap, 'shell');
    } finally { sc.dispose(); }
  });

  await check('golden stream: an alternate-screen agent pane round-trips exactly', async () => {
    const sc = makeSidecar({ cols: 60, rows: 12 });
    try {
      await feed(sc, 'pre-alt shell line\r\n');
      await feed(sc, AGENT_STARTUP);
      for (let i = 0; i < 20; i++) await feed(sc, agentRepaint(1000 + i * 37));
      assert.strictEqual(sc.getMode().altBuffer, true, 'the fixture must actually be in the alternate buffer');
      const snap = sc.snapshot();
      await assertRendersIdentically(sc, snap, 'agent alt buffer');
    } finally { sc.dispose(); }
  });

  await check('golden stream: wrapped lines and wide characters survive the round trip', async () => {
    const sc = makeSidecar({ cols: 20, rows: 6 });
    try {
      await feed(sc, 'x'.repeat(53) + '\r\n');
      await feed(sc, 'CJK 你好世界 end\r\n');
      const snap = sc.snapshot();
      await assertRendersIdentically(sc, snap, 'wrap and wide');
    } finally { sc.dispose(); }
  });

  await check('golden stream: leaving the alternate buffer restores the normal screen', async () => {
    const sc = makeSidecar({ cols: 40, rows: 6 });
    try {
      await feed(sc, 'normal one\r\nnormal two\r\n');
      await feed(sc, AGENT_STARTUP);
      await feed(sc, agentRepaint(42));
      assert.strictEqual(sc.getMode().altBuffer, true);
      await feed(sc, '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l');
      assert.strictEqual(sc.getMode().altBuffer, false, 'CSI ?1049l must return to the normal buffer');
      await assertRendersIdentically(sc, sc.snapshot(), 'post alt exit');
    } finally { sc.dispose(); }
  });

  // ── The prefix-pruned case (BUILD-CONTRACT P6.2 done criterion) ─────────

  await check('a byte stream whose prefix has been pruned still snapshots correctly', async () => {
    const sc = makeSidecar({ cols: 60, rows: 12 });
    try {
      // Build the full stream, then model what the 100KB byte ring keeps: a
      // suffix. The ring prunes from the FRONT, so the alternate-buffer entry
      // and the frame construction are gone and only in-place patches remain.
      let full = AGENT_STARTUP;
      for (let i = 0; i < 60; i++) full += agentRepaint(500 + i * 11);
      await feed(sc, full);

      const prunedRing = full.slice(full.length - 400);
      assert.strictEqual(prunedRing.indexOf('\x1b[?1049h'), -1,
        'the fixture must actually have pruned the alternate-buffer entry');

      const { Terminal } = require('@xterm/headless');
      const viaRing = new Terminal({ cols: 60, rows: 12, scrollback: VT_SIDECAR_SCROLLBACK, allowProposedApi: true });
      await new Promise((r) => viaRing.write(prunedRing, r));
      assert.strictEqual(viaRing.buffer.active.type, 'normal',
        'replaying the pruned ring cannot even reach the alternate buffer: this is defect D3');
      const ringState = terminalState(viaRing);
      const shadowState = terminalState(sc.term);
      assert.notDeepStrictEqual(ringState.viewport, shadowState.viewport,
        'the ring replay must actually be wrong, otherwise this test proves nothing');
      viaRing.dispose();

      // The snapshot, by contrast, is exact.
      await assertRendersIdentically(sc, sc.snapshot(), 'prefix-pruned');
    } finally { sc.dispose(); }
  });

  await check('an attach mid-TUI shows the current screen, not a blank or torn one', async () => {
    const sc = makeSidecar({ cols: 60, rows: 12 });
    try {
      await feed(sc, AGENT_STARTUP);
      await feed(sc, agentRepaint(31337));
      const snap = sc.snapshot();
      const { Terminal } = require('@xterm/headless');
      const attaching = new Terminal({ cols: 60, rows: 12, scrollback: VT_SIDECAR_SCROLLBACK, allowProposedApi: true });
      await new Promise((r) => attaching.write(snap, r));
      const text = viewportText(attaching);
      assert.ok(text.indexOf('31337') !== -1, 'the live token counter must be present after attach');
      assert.ok(text.indexOf('summarise the build contract') !== -1, 'the prompt line must be present after attach');
      assert.strictEqual(attaching.buffer.active.type, 'alternate', 'the attaching client must land in the alternate buffer');
      attaching.dispose();
    } finally { sc.dispose(); }
  });

  // ── Mode signal (BUILD-CONTRACT P6.3) ──────────────────────────────────

  await check('the mode signal fires on alt-enter and alt-exit and never on an unchanged state', async () => {
    const frames = [];
    const sc = makeSidecar({ cols: 40, rows: 8, onModeChange: (f) => frames.push(f) });
    try {
      assert.strictEqual(frames.length, 0,
        'construction primes the baseline silently: no client is attached yet, so an emission would reach nobody');
      await feed(sc, 'plain shell output\r\n');
      assert.strictEqual(frames.length, 0, 'ordinary output must not emit a mode frame');

      await feed(sc, AGENT_STARTUP);
      assert.strictEqual(frames.length, 1,
        'the whole startup handshake is ONE parsed chunk and must yield exactly one settled frame, got ' + frames.length);
      const entered = frames[frames.length - 1];
      assert.strictEqual(entered.type, 'mode');
      assert.strictEqual(entered.altBuffer, true);
      assert.strictEqual(entered.mouseTracking, 'any', 'CSI ?1003h is any-event tracking');
      assert.strictEqual(entered.mouseTrackingActive, true);
      assert.strictEqual(entered.bracketedPaste, true, 'CSI ?2004h was in the startup handshake');
      assert.ok(Number.isInteger(entered.seq) && entered.seq > 0, 'every frame carries a monotonic seq');

      const before = frames.length;
      for (let i = 0; i < 10; i++) await feed(sc, agentRepaint(i));
      assert.strictEqual(frames.length, before, 'repaints inside one mode must not re-emit the signal');

      await feed(sc, '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?2004l');
      const exited = frames[frames.length - 1];
      assert.strictEqual(exited.altBuffer, false, 'leaving the alternate buffer must emit');
      assert.strictEqual(exited.mouseTracking, 'none');
      assert.strictEqual(exited.mouseTrackingActive, false);
      assert.strictEqual(exited.bracketedPaste, false);
      assert.ok(exited.seq > entered.seq, 'seq must increase monotonically');
    } finally { sc.dispose(); }
  });

  await check('a shell pane reports a normal-buffer mode signal with tracking off', async () => {
    const sc = makeSidecar({ cols: 40, rows: 8 });
    try {
      await feed(sc, shellStream(3));
      const frame = sc.getModeFrame();
      assert.deepStrictEqual(
        { type: frame.type, altBuffer: frame.altBuffer, mouseTracking: frame.mouseTracking, bracketedPaste: frame.bracketedPaste },
        { type: 'mode', altBuffer: false, mouseTracking: 'none', bracketedPaste: false }
      );
    } finally { sc.dispose(); }
  });

  await check('private modes are restored exactly, including the mouse ENCODING that IModes hides', async () => {
    const sc = makeSidecar({ cols: 40, rows: 6 });
    try {
      await feed(sc, '\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l');
      const restore = serializePrivateModes(sc._modeState);
      assert.ok(restore.indexOf('\x1b[?1006h') !== -1,
        'SGR mouse encoding must be restored; xterm IModes does not expose it, which is why raw tracking exists');
      assert.ok(restore.indexOf('\x1b[?1002h') !== -1, 'tracking mode must be restored');
      assert.ok(restore.indexOf('\x1b[?2004h') !== -1, 'bracketed paste must be restored');
      assert.ok(restore.indexOf('\x1b[?25l') !== -1, 'a hidden cursor must be restored');
      assert.strictEqual(restore.indexOf('\x1b[?9001'), -1,
        'ConPTY win32 input mode is a host negotiation, not renderable state: tracked but never replayed');
      assert.strictEqual(restore.indexOf('\x1b[?2026'), -1,
        'synchronized output must never be restored: it would leave the client buffering a frame that never closes');
      assert.strictEqual(restore.indexOf('\x1b[?1049'), -1,
        'the buffer switch is expressed by the snapshot body, not by the mode restore');
    } finally { sc.dispose(); }
  });

  await check('CSI ?9001h (ConPTY win32 input mode) parses cleanly: verification gate VG-4', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...a) => warnings.push(a.join(' '));
    console.error = (...a) => warnings.push(a.join(' '));
    const sc = makeSidecar({ cols: 40, rows: 6 });
    try {
      await feed(sc, '\x1b[?9001h' + AGENT_STARTUP + agentRepaint(7));
      assert.deepStrictEqual(warnings, [], 'no warning may be produced by the ConPTY handshake');
      assert.strictEqual(sc.getMode().altBuffer, true, 'the handshake must still reach the alternate buffer');
      assert.strictEqual(sc.degraded, false, 'the shadow must remain healthy');
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      sc.dispose();
    }
  });

  // ── Bounds and health ──────────────────────────────────────────────────

  await check('the normal-buffer line log captures committed lines in order and bounds itself', async () => {
    // A deliberately SMALL shadow scrollback (20) against 200 lines arriving
    // in one chunk. Nothing may be lost: the capture batch is clamped to half
    // the scrollback, so the scroll handler drains committed lines into the
    // log long before the shadow's own buffer evicts them. This is the case
    // that makes the line log meaningful at all, since the shipped shadow
    // holds only 500 lines while the log holds 50000.
    const sc = makeSidecar({ cols: 40, rows: 6, scrollback: 20 });
    try {
      await feed(sc, shellStream(200));
      const page = sc.readLines({ lines: 500 });
      assert.ok(page.total >= 190, 'expected roughly 200 committed lines, got ' + page.total);
      assert.strictEqual(page.lostLines, 0,
        'the batch clamp must keep the capture ahead of eviction, lost=' + page.lostLines);
      assert.strictEqual(page.lines[0].t, 'shell-line-0', 'the log must start at the first committed line');
      assert.strictEqual(page.lines[page.lines.length - 1].t, 'shell-line-' + (page.total - 1),
        'the log must be contiguous and in order');
      const back = sc.readLines({ beforeLine: 50, lines: 10 });
      assert.strictEqual(back.lines.length, 10);
      assert.strictEqual(back.lines[0].t, 'shell-line-40', 'paging backwards by absolute index must be exact');
      assert.strictEqual(back.hasMore, true);
    } finally { sc.dispose(); }
  });

  await check('a resize reflow does not tear a hole in the deep line log', async () => {
    // Regression gate for a defect found by the end-to-end proof, not by
    // inspection: an xterm resize REFLOWS, moving rows between the viewport
    // and the scrollback with no scroll event, which silently invalidated the
    // absolute-index mapping. The visible symptom was a log that jumped from
    // line 30 to line 40 after a client reattached at a narrower width.
    const sc = makeSidecar({ cols: 60, rows: 30 });
    try {
      await feed(sc, shellStream(60));
      const before = sc.readLines({ lines: 1000 });
      assert.ok(before.total >= 29, 'the pre-resize log must already hold the scrolled-off lines');

      sc.resize(40, 20);          // a shrink: 10 viewport rows fall out
      await feed(sc, shellStream(5));

      const after = sc.readLines({ lines: 1000 });
      const texts = after.lines.map((l) => l.t).filter((t) => /^shell-line-\d+$/.test(t));
      const seen = new Set(texts.map((t) => Number(t.slice('shell-line-'.length))));
      for (let i = 0; i < before.total; i++) {
        assert.ok(seen.has(i), 'shell-line-' + i + ' vanished from the log across the reflow');
      }
      // The reflow itself must be observable, not silently absorbed.
      assert.strictEqual(sc.getStats().reflows, 1, 'the reflow must be counted');
      // And capture must resume correctly under the NEW geometry.
      assert.ok(after.total > before.total, 'lines committed after the resize must still be captured');
    } finally { sc.dispose(); }
  });

  await check('the line log trims from the front at its line bound and reports the new floor', async () => {
    const sc = makeSidecar({ cols: 40, rows: 6, scrollback: 50 });
    try {
      // A tiny bound, injected rather than waiting for 50000 real lines.
      const originalPush = sc._appendLogLine.bind(sc);
      let appended = 0;
      sc._appendLogLine = (t, w) => {
        originalPush(t, w);
        appended++;
        while (sc._lineLog.length > 25) {
          const removed = sc._lineLog.shift();
          sc._lineLogBytes -= removed.t.length * 2 + 64;
          sc._lineLogFirstIndex++;
          sc._lineLogEvicted++;
        }
      };
      await feed(sc, shellStream(100));
      assert.ok(appended > 25, 'the fixture must actually overflow the bound');
      assert.strictEqual(sc._lineLog.length, 25, 'the log must stay at its bound');
      const page = sc.readLines({ lines: 1000 });
      assert.strictEqual(page.oldestAvailable, sc._lineLogFirstIndex,
        'the read API must report the real floor, not pretend the oldest line is index 0');
      assert.strictEqual(page.hasMore, false, 'at the floor there is nothing older to fetch');
      assert.ok(VT_LINE_LOG_MAX_LINES >= 50000, 'the shipped bound is the architecture figure');
    } finally { sc.dispose(); }
  });

  await check('a saturated write queue drops bytes, marks the shadow degraded, and refuses a snapshot', async () => {
    const sc = makeSidecar({ cols: 40, rows: 6 });
    try {
      await feed(sc, 'known good\r\n');
      assert.ok(sc.snapshot(), 'a healthy shadow produces a snapshot');
      // Force the queue past its bound without waiting for real backpressure.
      sc._pendingBytes = 9 * 1024 * 1024;
      const accepted = sc.write('this must be dropped');
      assert.strictEqual(accepted, false, 'an oversized queue must drop rather than grow');
      assert.strictEqual(sc.degraded, true, 'dropping bytes must mark the shadow degraded');
      assert.strictEqual(sc.snapshot(), null,
        'a degraded shadow must refuse a snapshot so the caller falls back to the byte ring');
      assert.ok(sc.getStats().droppedBytes > 0, 'the drop must be counted, not silent');

      // A full screen clear re-establishes known state and clears the latch.
      sc._pendingBytes = 0;
      await feed(sc, '\x1b[2Jrepainted from scratch');
      assert.strictEqual(sc.degraded, false, 'CSI 2J means the app repaints from scratch: the shadow re-converges');
      assert.ok(sc.snapshot(), 'a re-converged shadow produces a snapshot again');
    } finally { sc.dispose(); }
  });

  await check('the registry enforces the concurrent-sidecar cap and never throws', () => {
    const saved = process.env.CWM_VT_SIDECAR;
    process.env.CWM_VT_SIDECAR = '1';
    const { Terminal } = require('@xterm/headless');
    const registry = new VtSidecarRegistry({ maxSessions: 3, TerminalClass: Terminal });
    try {
      assert.ok(registry.create('a'), 'first sidecar');
      assert.ok(registry.create('b'), 'second sidecar');
      assert.ok(registry.create('c'), 'third sidecar');
      assert.strictEqual(registry.create('d'), null, 'beyond the cap create returns null, not an error');
      assert.strictEqual(registry.getStats().count, 3);
      assert.ok(registry.dispose('a'), 'dispose frees a slot');
      assert.ok(registry.create('d'), 'the freed slot is reusable');
      registry.disposeAll();
      assert.strictEqual(registry.getStats().count, 0, 'disposeAll must leave nothing behind');
      assert.strictEqual(VT_SIDECAR_MAX_SESSIONS, 12, 'the shipped cap is the architecture figure');
    } finally {
      registry.disposeAll();
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
    }
  });

  await check('dispose is idempotent and leaves every method total', () => {
    const sc = makeSidecar();
    sc.dispose();
    sc.dispose();
    assert.strictEqual(sc.write('x'), false);
    assert.strictEqual(sc.resize(10, 10), false);
    assert.strictEqual(sc.snapshot(), null);
    assert.strictEqual(sc.getMode(), null);
    assert.strictEqual(sc.getStats().disposed, true);
  });

  // ── PTY manager integration ────────────────────────────────────────────

  await check('with the flag on, attach replays a snapshot and hands over the mode signal', async () => {
    const saved = process.env.CWM_VT_SIDECAR;
    process.env.CWM_VT_SIDECAR = '1';
    const fx = attachFixture();
    try {
      assert.ok(fx.session.vt, 'the sidecar must be attached on spawn');
      fx.ptyHandle.emitData(AGENT_STARTUP);
      fx.ptyHandle.emitData(agentRepaint(90210));
      await drain(fx.session);

      const ws2 = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, ws2, {});
      assert.strictEqual(asControl(ws2.sent[0]).type, 'reset', 'reset still precedes the replay');

      const replay = ws2.sent[1];
      assert.ok(typeof replay === 'string' && replay.indexOf('\x1b[?1049h') !== -1,
        'the snapshot must carry the alternate-buffer entry the pruned ring would have lost');
      assert.ok(replay.indexOf('90210') !== -1, 'the snapshot must carry the CURRENT screen contents');

      const modeFrame = asControl(ws2.sent[2]);
      assert.ok(modeFrame && modeFrame.type === 'mode', 'attach must hand over the mode signal, got: ' + ws2.sent[2]);
      assert.strictEqual(modeFrame.altBuffer, true);
      assert.strictEqual(modeFrame.mouseTracking, 'any');
      assert.strictEqual(modeFrame.bracketedPaste, true);

      assert.strictEqual(fx.mgr.buildReplay(fx.session).source, 'snapshot');
      assert.strictEqual(fx.mgr.getSessionMode(fx.sessionId).altBuffer, true);
    } finally {
      fx.mgr.killSession(fx.sessionId);
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
    }
  });

  await check('the fallback flag restores the byte-ring replay while keeping the mode signal', async () => {
    const savedMaster = process.env.CWM_VT_SIDECAR;
    const savedSnap = process.env.CWM_VT_SIDECAR_SNAPSHOT;
    process.env.CWM_VT_SIDECAR = '1';
    process.env.CWM_VT_SIDECAR_SNAPSHOT = '0';
    const fx = attachFixture();
    try {
      fx.ptyHandle.emitData(AGENT_STARTUP);
      await drain(fx.session);
      const ws2 = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, ws2, {});
      assert.strictEqual(fx.mgr.buildReplay(fx.session).source, 'ring',
        'the sub-flag must return the replay to the retained byte ring');
      assert.strictEqual(ws2.sent[1], AGENT_STARTUP, 'the ring replay must be byte-identical to what was streamed');
      const modeFrame = asControl(ws2.sent[2]);
      assert.ok(modeFrame && modeFrame.type === 'mode', 'the mode signal survives the snapshot fallback');
      assert.strictEqual(modeFrame.altBuffer, true);
    } finally {
      fx.mgr.killSession(fx.sessionId);
      if (savedMaster === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = savedMaster;
      if (savedSnap === undefined) delete process.env.CWM_VT_SIDECAR_SNAPSHOT; else process.env.CWM_VT_SIDECAR_SNAPSHOT = savedSnap;
    }
  });

  await check('a live mode change is broadcast to every attached client exactly once', async () => {
    const saved = process.env.CWM_VT_SIDECAR;
    process.env.CWM_VT_SIDECAR = '1';
    const fx = attachFixture();
    try {
      const ws2 = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, ws2, {});
      const before1 = fx.ws.sent.length;
      const before2 = ws2.sent.length;

      fx.ptyHandle.emitData(AGENT_STARTUP);
      await drain(fx.session);

      const modes1 = fx.ws.sent.slice(before1).map(asControl).filter((c) => c && c.type === 'mode');
      const modes2 = ws2.sent.slice(before2).map(asControl).filter((c) => c && c.type === 'mode');
      assert.strictEqual(modes1.length, 1, 'client 1 got exactly one mode frame, got ' + modes1.length);
      assert.strictEqual(modes2.length, 1, 'client 2 got exactly one mode frame, got ' + modes2.length);
      assert.deepStrictEqual(modes1[0], modes2[0], 'every client must receive the SAME authoritative signal');
      assert.strictEqual(modes1[0].altBuffer, true);
    } finally {
      fx.mgr.killSession(fx.sessionId);
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
    }
  });

  await check('the sidecar is disposed when the PTY exits and when the session is killed', async () => {
    const saved = process.env.CWM_VT_SIDECAR;
    process.env.CWM_VT_SIDECAR = '1';
    try {
      const fx = attachFixture();
      const sidecar = fx.session.vt;
      assert.ok(sidecar, 'sidecar attached');
      fx.ptyHandle.emitExit(0);
      assert.strictEqual(sidecar.disposed, true, 'a PTY exit must dispose its shadow');
      assert.strictEqual(fx.session.vt, null);
      assert.strictEqual(fx.mgr.vtRegistry.getStats().count, 0, 'the registry must not retain a dead sidecar');
      fx.mgr.killSession(fx.sessionId);

      const fx2 = attachFixture();
      const sidecar2 = fx2.session.vt;
      fx2.mgr.killSession(fx2.sessionId);
      assert.strictEqual(sidecar2.disposed, true, 'killSession must dispose the shadow too');
      assert.strictEqual(fx2.mgr.vtRegistry.getStats().count, 0);
    } finally {
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
    }
  });

  await check('a snapshot taken after the attaching client claims width is rendered AT that width', async () => {
    const saved = process.env.CWM_VT_SIDECAR;
    process.env.CWM_VT_SIDECAR = '1';
    const fx = attachFixture({ cols: 100, rows: 30 });
    try {
      fx.ptyHandle.emitData(AGENT_STARTUP + agentRepaint(11));
      await drain(fx.session);
      assert.strictEqual(fx.session.vt.term.cols, 100, 'the shadow tracks the PTY width');

      // Sole viewer leaves; a narrower device reconnects and claims the width.
      fx.ws.emit('close');
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, { cols: 44, rows: 20 });
      assert.deepStrictEqual(fx.ptyHandle.calls.resize[fx.ptyHandle.calls.resize.length - 1], [44, 20],
        'the sole attaching client applies its geometry before the replay, as before');
      assert.strictEqual(fx.session.vt.term.cols, 44,
        'the shadow must follow, otherwise the snapshot would be replayed at the DEPARTED width');
      assert.strictEqual(fx.session.sizeOwner, phone, 'a sole attacher with no live owner takes ownership');
      assert.deepStrictEqual(phone._viewport, { cols: 44, rows: 20 },
        'the attach geometry must be recorded so a later handoff can restore it');
    } finally {
      fx.mgr.killSession(fx.sessionId);
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
    }
  });

  await check('alternate-buffer ring suppression is opt-in and never blanks a pane by default', async () => {
    const saved = process.env.CWM_VT_SIDECAR;
    const savedSnap = process.env.CWM_VT_SIDECAR_SNAPSHOT;
    process.env.CWM_VT_SIDECAR = '1';
    process.env.CWM_VT_SIDECAR_SNAPSHOT = '0';   // force "no snapshot available"
    const fx = attachFixture();
    try {
      fx.ptyHandle.emitData(AGENT_STARTUP);
      await drain(fx.session);
      assert.strictEqual(fx.mgr.buildReplay(fx.session).source, 'ring',
        'by default an alternate-buffer attach still replays the ring rather than showing nothing');

      process.env.CWM_PTY_ALT_SUPPRESS_RING = '1';
      const suppressed = fx.mgr.buildReplay(fx.session);
      assert.strictEqual(suppressed.source, 'alt-suppressed');
      assert.strictEqual(suppressed.payload, null, 'the flagged path replays nothing and waits for the repaint');
      assert.strictEqual(suppressed.altBuffer, true);
    } finally {
      delete process.env.CWM_PTY_ALT_SUPPRESS_RING;
      fx.mgr.killSession(fx.sessionId);
      if (saved === undefined) delete process.env.CWM_VT_SIDECAR; else process.env.CWM_VT_SIDECAR = saved;
      if (savedSnap === undefined) delete process.env.CWM_VT_SIDECAR_SNAPSHOT; else process.env.CWM_VT_SIDECAR_SNAPSHOT = savedSnap;
    }
  });

  // ── Width-thrash ownership control (BUILD-CONTRACT P6.4) ───────────────

  await check('a single ownership flip is instantaneous: handing the laptop over never waits', () => {
    const fx = attachFixture();
    try {
      const ws2 = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, ws2, {});
      ws2.emit('message', msg({ type: 'resize', cols: 55, rows: 22 }));
      const before = fx.ptyHandle.calls.resize.length;
      ws2.emit('message', msg({ type: 'input', data: 'x' }));
      assert.strictEqual(fx.session.sizeOwner, ws2, 'the first flip applies synchronously');
      assert.strictEqual(fx.ptyHandle.calls.resize.length, before + 1, 'and applies the new owner viewport at once');
      assert.deepStrictEqual(fx.ptyHandle.calls.resize[before], [55, 22]);
      assert.strictEqual(fx.session.resizeStats.deferredClaims, 0, 'nothing was deferred');
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('two clients oscillating produce ONE applied resize per settle window', async () => {
    const fx = attachFixture();
    try {
      const desktop = fx.ws;
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, {});
      desktop.emit('message', msg({ type: 'resize', cols: 200, rows: 50 }));
      phone.emit('message', msg({ type: 'resize', cols: 40, rows: 20 }));
      const baseline = fx.ptyHandle.calls.resize.length;

      // The field failure: an IntersectionObserver and a focus handler on the
      // phone firing 'activate' while the desktop keeps claiming back. Twenty
      // alternating claims inside one settle window.
      for (let i = 0; i < 10; i++) {
        desktop.emit('message', msg({ type: 'activate' }));
        phone.emit('message', msg({ type: 'activate' }));
      }
      const duringStorm = fx.ptyHandle.calls.resize.length - baseline;
      assert.ok(duringStorm <= 2,
        'twenty alternating claims must not produce twenty ConPTY repaints, got ' + duringStorm);
      assert.ok(fx.session.resizeStats.deferredClaims >= 8,
        'the coalescer must actually be doing the work, deferred=' + fx.session.resizeStats.deferredClaims);
      assert.strictEqual(fx.session._ownershipContended, true, 'the contention latch must be set');
      assert.ok(fx.session._pendingOwner, 'a coalesced claimant must be waiting for the trailing apply');

      // One trailing apply lands at the end of the window, for the coalesced
      // claimant. Over a sustained storm this alternates ownership once per
      // window instead of twenty times, which is the whole point.
      const pending = fx.session._pendingOwner;
      await sleep(TEST_DEBOUNCE_MS * 3);
      const afterSettle = fx.ptyHandle.calls.resize.length - baseline;
      assert.ok(afterSettle <= 3,
        'at most one trailing apply per window may land, total applies since baseline = ' + afterSettle);
      assert.strictEqual(fx.session.sizeOwner, pending, 'the coalesced claimant takes ownership once, at the end');
      assert.deepStrictEqual(
        fx.ptyHandle.calls.resize[fx.ptyHandle.calls.resize.length - 1], pending === phone ? [40, 20] : [200, 50],
        'and its geometry is what actually gets applied'
      );
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('a sustained storm costs at most one applied resize per settle window', async () => {
    const fx = attachFixture();
    try {
      const desktop = fx.ws;
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, {});
      desktop.emit('message', msg({ type: 'resize', cols: 200, rows: 50 }));
      phone.emit('message', msg({ type: 'resize', cols: 40, rows: 20 }));

      const WINDOWS = 4;
      const baseline = fx.ptyHandle.calls.resize.length;
      for (let w = 0; w < WINDOWS; w++) {
        for (let i = 0; i < 25; i++) {
          desktop.emit('message', msg({ type: 'activate' }));
          phone.emit('message', msg({ type: 'activate' }));
        }
        await sleep(TEST_DEBOUNCE_MS + 15);
      }
      await sleep(TEST_DEBOUNCE_MS * 2);

      const applied = fx.ptyHandle.calls.resize.length - baseline;
      const claims = WINDOWS * 50;
      // The gate: "one resize per settle window with two clients attached".
      // WINDOWS + 1 allows for the very first uncontended flip plus one
      // trailing apply per window; it is still two orders of magnitude below
      // the 200 claims that produced them.
      assert.ok(applied <= WINDOWS + 1,
        claims + ' claims across ' + WINDOWS + ' windows applied ' + applied + ' resizes; budget is ' + (WINDOWS + 1));
      assert.ok(applied >= 1, 'the coalescer must still let ownership move, not freeze it');
      assert.ok(fx.session.resizeStats.deferredClaims > claims / 4,
        'most claims must be coalesced, deferred=' + fx.session.resizeStats.deferredClaims);
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('typing always reaches the PTY even while its ownership claim is coalesced', async () => {
    const fx = attachFixture();
    try {
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, {});
      // Drive the session into contention first.
      for (let i = 0; i < 6; i++) {
        fx.ws.emit('message', msg({ type: 'activate' }));
        phone.emit('message', msg({ type: 'activate' }));
      }
      assert.strictEqual(fx.session._ownershipContended, true);
      const writesBefore = fx.ptyHandle.calls.write.length;
      phone.emit('message', msg({ type: 'input', data: 'hello' }));
      assert.strictEqual(fx.ptyHandle.calls.write[writesBefore], 'hello',
        'input must never be delayed by the geometry coalescer');
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('the contention latch clears after a quiet period so the next single flip is instant again', async () => {
    const fx = attachFixture();
    try {
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, {});
      fx.ws.emit('message', msg({ type: 'resize', cols: 200, rows: 50 }));
      phone.emit('message', msg({ type: 'resize', cols: 40, rows: 20 }));
      for (let i = 0; i < 6; i++) {
        fx.ws.emit('message', msg({ type: 'activate' }));
        phone.emit('message', msg({ type: 'activate' }));
      }
      assert.strictEqual(fx.session._ownershipContended, true, 'contended after the storm');

      await sleep(TEST_CONTENTION_CLEAR_MS + 150);
      assert.strictEqual(fx.session._ownershipContended, false, 'a quiet period must unlatch contention');
      assert.strictEqual(fx.session._ownersInWindow.size, 0, 'and the window must be forgotten with it');

      // One flip from whichever client does NOT currently own must be
      // instantaneous again, exactly as it was before the storm.
      const owner = fx.session.sizeOwner;
      const other = owner === fx.ws ? phone : fx.ws;
      const before = fx.ptyHandle.calls.resize.length;
      const deferredBefore = fx.session.resizeStats.deferredClaims;
      other.emit('message', msg({ type: 'activate' }));
      assert.strictEqual(fx.session.sizeOwner, other, 'the post-quiet flip is instantaneous again');
      assert.strictEqual(fx.session.resizeStats.deferredClaims, deferredBefore, 'and nothing was coalesced');
      assert.strictEqual(fx.ptyHandle.calls.resize.length, before + 1, 'its viewport applied at once');
      assert.deepStrictEqual(fx.ptyHandle.calls.resize[before], other._viewport ? [other._viewport.cols, other._viewport.rows] : null);
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('a coalesced claimant that disconnects is discarded, not resurrected', async () => {
    const fx = attachFixture();
    try {
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, {});
      fx.ws.emit('message', msg({ type: 'resize', cols: 200, rows: 50 }));
      phone.emit('message', msg({ type: 'resize', cols: 40, rows: 20 }));
      for (let i = 0; i < 6; i++) {
        fx.ws.emit('message', msg({ type: 'activate' }));
        phone.emit('message', msg({ type: 'activate' }));
      }
      const pending = fx.session._pendingOwner;
      assert.ok(pending, 'a claim must be coalesced and waiting');
      assert.notStrictEqual(pending, fx.session.sizeOwner, 'the coalesced claimant is by definition not the owner');

      pending.emit('close');
      assert.strictEqual(fx.session._pendingOwner, null, 'a departed claimant is dropped immediately');
      const before = fx.ptyHandle.calls.resize.length;
      await sleep(TEST_DEBOUNCE_MS * 3);
      assert.strictEqual(fx.ptyHandle.calls.resize.length, before,
        'the trailing timer must not apply a geometry from a client that is gone');
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('an owner disconnect hands over immediately and is never debounced', async () => {
    const fx = attachFixture();
    try {
      const phone = makeFakeWs();
      fx.mgr.attachClient(fx.sessionId, phone, {});
      fx.ws.emit('message', msg({ type: 'resize', cols: 200, rows: 50 }));
      fx.ws.emit('message', msg({ type: 'input', data: 'a' }));
      phone.emit('message', msg({ type: 'input', data: 'b' }));
      phone.emit('message', msg({ type: 'resize', cols: 40, rows: 20 }));
      assert.strictEqual(fx.session.sizeOwner, phone);

      const before = fx.ptyHandle.calls.resize.length;
      phone.emit('close');
      assert.strictEqual(fx.session.sizeOwner, fx.ws, 'ownership falls back synchronously');
      assert.strictEqual(fx.ptyHandle.calls.resize.length, before + 1,
        'and the remaining viewport is restored in the same tick, not one settle window later');
      assert.deepStrictEqual(fx.ptyHandle.calls.resize[before], [200, 50]);
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('the shipped settle window sits in the specified 300 to 500ms band', () => {
    const savedDebounce = process.env.CWM_PTY_OWNERSHIP_DEBOUNCE_MS;
    const savedClear = process.env.CWM_PTY_OWNERSHIP_CONTENTION_CLEAR_MS;
    delete process.env.CWM_PTY_OWNERSHIP_DEBOUNCE_MS;
    delete process.env.CWM_PTY_OWNERSHIP_CONTENTION_CLEAR_MS;
    delete require.cache[require.resolve('../src/web/pty-manager')];
    try {
      const shipped = require('../src/web/pty-manager');
      assert.ok(shipped.OWNERSHIP_DEBOUNCE_MS >= 300 && shipped.OWNERSHIP_DEBOUNCE_MS <= 500,
        'the design specifies 300-500ms, shipped ' + shipped.OWNERSHIP_DEBOUNCE_MS);
      assert.ok(shipped.OWNERSHIP_CONTENTION_CLEAR_MS > shipped.OWNERSHIP_DEBOUNCE_MS,
        'the unlatch period must outlast the settle window or a storm escapes by pausing');
    } finally {
      if (savedDebounce !== undefined) process.env.CWM_PTY_OWNERSHIP_DEBOUNCE_MS = savedDebounce;
      if (savedClear !== undefined) process.env.CWM_PTY_OWNERSHIP_CONTENTION_CLEAR_MS = savedClear;
      delete require.cache[require.resolve('../src/web/pty-manager')];
    }
  });

  await check('resize accounting is observable: applied, suppressed and deferred are all counted', () => {
    const fx = attachFixture();
    try {
      const stats = fx.session.resizeStats;
      const applied0 = stats.applied;
      fx.ws.emit('message', msg({ type: 'resize', cols: 80, rows: 24 }));
      assert.strictEqual(stats.applied, applied0, 'identical dims are a suppressed no-op');
      assert.ok(stats.suppressed > 0, 'and the suppression is counted');
      fx.ws.emit('message', msg({ type: 'resize', cols: 90, rows: 26 }));
      assert.strictEqual(stats.applied, applied0 + 1, 'a real change is counted once');
      assert.ok(stats.flips >= 1, 'the attach seed counts as an ownership flip');
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  await check('getHistoryLines is total: it returns an empty page rather than throwing', () => {
    const fx = attachFixture();
    try {
      const page = fx.mgr.getHistoryLines(fx.sessionId, {});
      assert.strictEqual(page.available, false, 'no sidecar means available:false, not an exception');
      assert.deepStrictEqual(page.lines, []);
      const missing = fx.mgr.getHistoryLines('no-such-session', {});
      assert.strictEqual(missing.available, false);
      assert.strictEqual(fx.mgr.getSessionMode('no-such-session'), null);
      const stats = fx.mgr.getSidecarStats();
      assert.strictEqual(typeof stats.count, 'number');
      assert.ok(stats.availability, 'the sidecar stats must carry the capability probe');
    } finally { fx.mgr.killSession(fx.sessionId); }
  });

  // ──────────────────────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(68));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('  ' + '-'.repeat(68) + '\n');
  if (failed > 0) process.exit(1);
  console.log('All passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('  FATAL  ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
