#!/usr/bin/env node
/**
 * Unit tests for the terminal sync fixes (branch fix/terminal-sync).
 *
 * Covers the shared-PTY viewport ownership model and the lag-resync
 * protocol added to src/web/pty-manager.js:
 *
 *   Test 1  Reset marker is sent BEFORE scrollback replay on attach
 *   Test 2  Sole client attaching to a live session applies URL dims
 *           BEFORE the replay is sent (replay renders at viewing size)
 *   Test 3  No-op resize suppression (identical dims never hit pty.resize)
 *   Test 4  Resize ownership: typing claims geometry; non-owner resizes
 *           are stored but not applied until that client types
 *   Test 5  'activate' claims ownership + applies viewport WITHOUT any
 *           stdin write; unknown JSON types stay safely ignored
 *   Test 6  Owner disconnect restores the most recently active remaining
 *           client's viewport
 *   Test 7  Lagged client (backpressure) gets reset + full scrollback
 *           resync once its buffer drains, with no duplicated chunk
 *
 * Test pattern mirrors test/pty-passthrough.test.js: no third-party
 * framework, stubbed pty.spawn via the test-only `_ptySpawnForTesting` opt.
 * Sessions are spawned through the non-provider bypass path (command 'td')
 * so no provider registry setup is needed. Fake ws objects capture sent
 * frames and expose registered event handlers for the tests to drive.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js.
require('./_test-data-dir');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : String(err)));
  }
}

/**
 * Build a fake WebSocket that records every frame sent to it and exposes
 * the event handlers pty-manager registers, so tests can drive incoming
 * messages and closes.
 * @returns {object} Fake ws with sent[], emit(), and mutable bufferedAmount.
 */
function makeFakeWs() {
  return {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    sent: [],
    _handlers: {},
    on(event, cb) { this._handlers[event] = cb; },
    send(d) { this.sent.push(d); },
    close() {},
    ping() {},
    terminate() {},
    /** Invoke a handler registered via on(), simulating a ws event. */
    emit(event, ...args) {
      if (this._handlers[event]) this._handlers[event](...args);
    },
  };
}

/**
 * Build a stub PTY that captures resize/write calls and lets the test
 * drive the onData handler to simulate process output.
 * @returns {{pty: object, calls: {resize: Array, write: Array}, emitData: Function}}
 */
function makeCapturingPty() {
  const handle = { calls: { resize: [], write: [] }, _dataCb: null };
  handle.pty = {
    pid: 4242,
    onData: (cb) => { handle._dataCb = cb; },
    onExit: () => {},
    on: () => {},
    write: (d) => handle.calls.write.push(d),
    resize: (c, r) => handle.calls.resize.push([c, r]),
    kill: () => {},
  };
  handle.emitData = (d) => { if (handle._dataCb) handle._dataCb(d); };
  return handle;
}

/**
 * Fresh PtySessionManager with one session attached through the
 * non-provider bypass path (command 'td'), spawned at 100x40.
 * @param {object} [extraOpts] Extra spawnOpts merged over the defaults.
 * @returns {{mgr, ptyHandle, ws, sessionId, session}}
 */
function attachFixture(extraOpts) {
  delete require.cache[require.resolve('../src/web/pty-manager')];
  delete require.cache[require.resolve('../src/state/store')];
  delete require.cache[require.resolve('../src/providers')];
  const { PtySessionManager } = require('../src/web/pty-manager');
  const mgr = new PtySessionManager();
  const ptyHandle = makeCapturingPty();
  const ws = makeFakeWs();
  const sessionId = 'resize-test-' + Math.random().toString(36).slice(2, 10);
  mgr.attachClient(sessionId, ws, Object.assign({
    command: 'td',
    cols: 100,
    rows: 40,
    _ptySpawnForTesting: () => ptyHandle.pty,
  }, extraOpts || {}));
  return { mgr, ptyHandle, ws, sessionId, session: mgr.getSession(sessionId) };
}

/** Parse a sent frame as JSON control message, or return null for raw data. */
function asControl(frame) {
  if (typeof frame !== 'string' || frame.charAt(0) !== '{') return null;
  try { return JSON.parse(frame); } catch (_) { return null; }
}

/** Shorthand for a client-to-server JSON message string. */
function msg(obj) { return JSON.stringify(obj); }

/**
 * The raw PTY data frames a client received, with every control frame
 * removed.
 *
 * MOBILE-TERMINAL.md 3.1 added a `size` control frame to the attach prelude,
 * so a test that indexes `ws.sent` by a hand-counted position now counts the
 * wrong thing every time the protocol gains a frame. Filtering by KIND says
 * what these assertions actually mean: "the data this client received", not
 * "whatever landed in slot 1".
 *
 * @param {object} ws - Fake WebSocket.
 * @returns {string[]} Raw data frames in order.
 */
function dataFrames(ws) {
  return ws.sent.filter((frame) => asControl(frame) === null);
}

/**
 * The control frame types a client received, in order.
 *
 * @param {object} ws - Fake WebSocket.
 * @returns {string[]} Control types in order.
 */
function controlTypes(ws) {
  return ws.sent.map(asControl).filter(Boolean).map((c) => c.type);
}

console.log('\n  fix/terminal-sync resize ownership + resync tests');
console.log('  ' + '-'.repeat(48));

// ──────────────────────────────────────────────────────────────────────
// Test 1: reset marker precedes scrollback replay on attach
// ──────────────────────────────────────────────────────────────────────
check('Test 1: reset marker is sent before scrollback replay on attach', () => {
  const { mgr, ptyHandle, ws, sessionId } = attachFixture();
  try {
    // First attach: reset marker sent even with empty scrollback
    assert.ok(ws.sent.length >= 1, 'attach must send at least the reset marker');
    const ctl = asControl(ws.sent[0]);
    assert.ok(ctl && ctl.type === 'reset', 'first frame must be the reset control message, got: ' + ws.sent[0]);

    // MOBILE-TERMINAL.md 3.1: the attach prelude also carries the PTY's
    // geometry and this client's ownership answer. Without it a client that
    // does not own the geometry cannot know what it is, so it fits itself and
    // re-wraps the owner's frame.
    assert.ok(controlTypes(ws).includes('size'),
      'attach must publish the PTY geometry, got: ' + JSON.stringify(controlTypes(ws)));

    // Produce output, then attach a second client while the first stays connected
    ptyHandle.emitData('hello');
    assert.deepStrictEqual(dataFrames(ws), ['hello'],
      'live data must stream to the first client');

    const ws2 = makeFakeWs();
    mgr.attachClient(sessionId, ws2, { cols: 60, rows: 20 });
    const ctl2 = asControl(ws2.sent[0]);
    assert.ok(ctl2 && ctl2.type === 'reset', 'second client frame 0 must be reset, got: ' + ws2.sent[0]);
    assert.deepStrictEqual(dataFrames(ws2), ['hello'],
      'second client must receive the scrollback replay');
    // A second client attaching alongside an existing viewer must NOT
    // reshape the PTY (only a sole attaching client may).
    assert.strictEqual(ptyHandle.calls.resize.length, 0,
      'no resize may fire when a second client attaches, got: ' + JSON.stringify(ptyHandle.calls.resize));
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Test 2: sole re-attaching client applies its URL dims BEFORE replay
// ──────────────────────────────────────────────────────────────────────
check('Test 2: sole client attach applies URL dims before scrollback replay', () => {
  const { mgr, ptyHandle, ws, sessionId } = attachFixture();
  try {
    ptyHandle.emitData('hi');
    // Disconnect the only viewer; the PTY stays alive for reconnect
    ws.emit('close');

    // Shared timeline across the pty stub and the new client's ws so the
    // resize-before-replay ordering can be asserted directly.
    const timeline = [];
    ptyHandle.pty.resize = (c, r) => {
      ptyHandle.calls.resize.push([c, r]);
      timeline.push('resize:' + c + 'x' + r);
    };
    const ws3 = makeFakeWs();
    ws3.send = (d) => {
      ws3.sent.push(d);
      const ctl = asControl(d);
      timeline.push(ctl ? 'ctl:' + ctl.type : 'data');
    };

    mgr.attachClient(sessionId, ws3, { cols: 60, rows: 20 });

    // The geometry frame lands AFTER the replay on purpose: the replay is
    // rendered at the geometry the resize above just applied, and a client
    // that learned the size first would have nothing to apply it to yet.
    assert.deepStrictEqual(timeline, ['resize:60x20', 'ctl:reset', 'data', 'ctl:size'],
      'expected resize, then reset, then replay, then the geometry frame; got: ' +
      JSON.stringify(timeline));
    assert.deepStrictEqual(dataFrames(ws3), ['hi'],
      'replay content must be the full scrollback');
    const session = mgr.getSession(sessionId);
    assert.strictEqual(session.cols, 60, 'session.cols must track the applied viewport');
    assert.strictEqual(session.rows, 20, 'session.rows must track the applied viewport');
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Test 3: no-op resize suppression
// ──────────────────────────────────────────────────────────────────────
check('Test 3: resizes matching current PTY dims never reach pty.resize', () => {
  const { mgr, ptyHandle, ws, sessionId, session } = attachFixture();
  try {
    // Spawn was 100x40; the first-client attach apply is a suppressed no-op
    assert.strictEqual(ptyHandle.calls.resize.length, 0, 'attach at spawn dims must not resize');

    // Client resends the same dims (the old ws-open behavior): suppressed
    ws.emit('message', msg({ type: 'resize', cols: 100, rows: 40 }));
    assert.strictEqual(ptyHandle.calls.resize.length, 0, 'identical dims must be suppressed');
    assert.deepStrictEqual(ws._viewport, { cols: 100, rows: 40 },
      'suppressed resize must still record the client viewport');

    // A real change applies once
    ws.emit('message', msg({ type: 'resize', cols: 80, rows: 24 }));
    assert.deepStrictEqual(ptyHandle.calls.resize, [[80, 24]], 'changed dims must apply exactly once');
    assert.strictEqual(session.cols, 80);
    assert.strictEqual(session.rows, 24);

    // Repeating the same change is suppressed again
    ws.emit('message', msg({ type: 'resize', cols: 80, rows: 24 }));
    assert.strictEqual(ptyHandle.calls.resize.length, 1, 'repeat of applied dims must be suppressed');
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Test 4: resize ownership transfers on input
// ──────────────────────────────────────────────────────────────────────
check('Test 4: typing claims geometry; non-owner resizes wait for input', () => {
  const { mgr, ptyHandle, ws, sessionId, session } = attachFixture();
  try {
    const ws2 = makeFakeWs();
    mgr.attachClient(sessionId, ws2, {});

    // First client types: becomes owner
    ws.emit('message', msg({ type: 'input', data: 'x' }));
    assert.strictEqual(session.sizeOwner, ws, 'input must claim size ownership');
    assert.deepStrictEqual(ptyHandle.calls.write, ['x'], 'input must still reach the PTY');

    // Second client resizes while not owner: stored, NOT applied
    ws2.emit('message', msg({ type: 'resize', cols: 55, rows: 22 }));
    assert.strictEqual(ptyHandle.calls.resize.length, 0,
      'non-owner resize must not touch the PTY, got: ' + JSON.stringify(ptyHandle.calls.resize));
    assert.deepStrictEqual(ws2._viewport, { cols: 55, rows: 22 }, 'non-owner viewport must be stored');

    // Second client types: ownership transfers AND its viewport applies
    ws2.emit('message', msg({ type: 'input', data: 'y' }));
    assert.strictEqual(session.sizeOwner, ws2, 'input must transfer ownership');
    assert.deepStrictEqual(ptyHandle.calls.resize, [[55, 22]],
      'new owner viewport must be applied on ownership transfer');
    assert.deepStrictEqual(ptyHandle.calls.write, ['x', 'y']);
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Test 5: 'activate' claims ownership with zero stdin writes
// ──────────────────────────────────────────────────────────────────────
check('Test 5: activate claims ownership without writing to PTY stdin', () => {
  const { mgr, ptyHandle, ws, sessionId, session } = attachFixture();
  try {
    const ws2 = makeFakeWs();
    mgr.attachClient(sessionId, ws2, {});

    ws.emit('message', msg({ type: 'input', data: 'x' }));
    ws2.emit('message', msg({ type: 'resize', cols: 70, rows: 30 }));
    const writesBefore = ptyHandle.calls.write.length;

    ws2.emit('message', msg({ type: 'activate' }));
    assert.strictEqual(session.sizeOwner, ws2, 'activate must claim size ownership');
    assert.deepStrictEqual(ptyHandle.calls.resize, [[70, 30]],
      'activate must apply the stored viewport when it differs');
    assert.strictEqual(ptyHandle.calls.write.length, writesBefore,
      'activate must NOT write anything to PTY stdin');

    // Unknown JSON control types remain safely ignored (old-server tolerance
    // contract this branch relies on for mixed-version deploys)
    ws2.emit('message', msg({ type: 'bogus-future-type', payload: 1 }));
    assert.strictEqual(ptyHandle.calls.write.length, writesBefore, 'unknown type must not write');
    assert.strictEqual(ptyHandle.calls.resize.length, 1, 'unknown type must not resize');

    // Non-JSON frames still pass through as raw input (legacy behavior)
    ws2.emit('message', 'plain');
    assert.strictEqual(ptyHandle.calls.write[ptyHandle.calls.write.length - 1], 'plain');
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Test 6: size restore when the owner disconnects
// ──────────────────────────────────────────────────────────────────────
check('Test 6: owner disconnect restores the remaining client viewport', () => {
  const { mgr, ptyHandle, ws, sessionId, session } = attachFixture();
  try {
    // Desktop client sets its size (owner unclaimed: applied) and types
    ws.emit('message', msg({ type: 'resize', cols: 200, rows: 50 }));
    ws.emit('message', msg({ type: 'input', data: 'a' }));
    assert.deepStrictEqual(ptyHandle.calls.resize, [[200, 50]]);

    // Phone client attaches, types (claims ownership), and shrinks the PTY
    const ws2 = makeFakeWs();
    mgr.attachClient(sessionId, ws2, {});
    ws2.emit('message', msg({ type: 'input', data: 'b' }));
    ws2.emit('message', msg({ type: 'resize', cols: 40, rows: 20 }));
    assert.strictEqual(session.sizeOwner, ws2);
    assert.deepStrictEqual(ptyHandle.calls.resize, [[200, 50], [40, 20]]);

    // Phone disconnects: desktop becomes owner and its viewport is restored
    ws2.emit('close');
    assert.strictEqual(session.sizeOwner, ws, 'ownership must fall back to the remaining client');
    assert.deepStrictEqual(ptyHandle.calls.resize, [[200, 50], [40, 20], [200, 50]],
      'remaining client viewport must be re-applied on owner disconnect');
    assert.strictEqual(session.cols, 200);
    assert.strictEqual(session.rows, 50);

    // Last client leaves: ownership resets, size stays untouched
    ws.emit('close');
    assert.strictEqual(session.sizeOwner, null, 'ownership must reset with no clients left');
    assert.strictEqual(ptyHandle.calls.resize.length, 3, 'no resize may fire when the last client leaves');
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Test 7: lagged client gets reset + full scrollback resync
// ──────────────────────────────────────────────────────────────────────
check('Test 7: backpressured client is resynced with reset + scrollback, no duplicates', () => {
  const { mgr, ptyHandle, ws, sessionId } = attachFixture();
  try {
    // Measured rather than hand-counted, so a protocol frame added to the
    // attach prelude cannot silently move every index below it.
    const prelude = ws.sent.length;
    ptyHandle.emitData('one');
    assert.strictEqual(ws.sent[prelude], 'one');

    // Simulate a saturated send buffer: chunks are withheld, not dropped-and-forgotten
    ws.bufferedAmount = 999999;
    ptyHandle.emitData('two');
    ptyHandle.emitData('twoB');
    assert.strictEqual(ws.sent.length, prelude + 1,
      'no frames may be sent while the buffer is saturated');
    assert.strictEqual(ws._lagged, true, 'client must be flagged as lagged');

    // Buffer drains: next broadcast delivers reset + FULL scrollback (which
    // already includes the current chunk), then normal streaming resumes
    ws.bufferedAmount = 0;
    ptyHandle.emitData('three');
    assert.strictEqual(ws.sent.length, prelude + 3,
      'resync must send exactly reset + scrollback, got: ' +
      JSON.stringify(ws.sent.slice(prelude + 1)));
    const ctl = asControl(ws.sent[prelude + 1]);
    assert.ok(ctl && ctl.type === 'reset',
      'resync frame 0 must be reset, got: ' + ws.sent[prelude + 1]);
    assert.strictEqual(ws.sent[prelude + 2], 'onetwotwoBthree',
      'resync frame 1 must be the full scrollback including the current chunk');
    assert.strictEqual(ws._lagged, false, 'lag flag must clear after resync');

    ptyHandle.emitData('four');
    assert.strictEqual(ws.sent[prelude + 3], 'four',
      'normal streaming must resume after resync');
  } finally {
    mgr.killSession(sessionId);
  }
});

// ──────────────────────────────────────────────────────────────────────
console.log('  ' + '-'.repeat(48));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('  ' + '-'.repeat(48) + '\n');

if (failed > 0) {
  process.exit(1);
}
console.log('All passed.');
process.exit(0);
