#!/usr/bin/env node
/**
 * fake-agent-cli.js - a deterministic stand-in for an agent CLI's terminal
 * behaviour, for the P7 history-surface browser proofs.
 * Created: 2026-08-13, Notion restyle phase P7.
 *
 * WHY THIS EXISTS RATHER THAN SPAWNING THE REAL CLI
 *
 * The Unified Scrollback Surface routes on BUFFER MODE, and the case it exists
 * for is the alternate-screen agent pane: TERMINAL-ARCHITECTURE.md section 2
 * measured ten live sessions and found the CLI enters the alternate buffer,
 * enables mouse tracking 1000/1002/1003 with SGR 1006, turns bracketed paste
 * on, and then repaints by ABSOLUTE CURSOR ADDRESSING only, emitting zero
 * scroll sequences ever. That is the exact set of properties the surface has
 * to be proved against.
 *
 * Spawning the real CLI in a test would need credentials, a network, a model
 * and a cold start measured in tens of seconds, and would still not be
 * deterministic. This reproduces the measured behaviour byte for byte in a few
 * milliseconds, and it reproduces the DECISIVE property: the viewport never
 * scrolls, so the terminal layer holds no history and the surface must get it
 * from the transcript instead.
 *
 * WHAT IT DOES NOT DO. It never reads stdin as commands, never touches the
 * network, never writes a file. It paints, it ticks, and it exits when its
 * parent goes away.
 *
 * Usage: node fake-agent-cli.js [turns]
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// The frame's rows are addressed absolutely, exactly as the measured CLI does.
const ESC = '\x1b';
const CSI = ESC + '[';

// How many "conversation" rows the frame shows. Deliberately small: a real
// agent CLI shows only the tail of the conversation in its frame, which is the
// whole reason the rest of it has to come from the transcript.
const VISIBLE_TURNS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 6;

// Repaint interval for the ticking row. Long enough not to flood a PTY,
// short enough that a test can observe the mirror keeping up.
const TICK_MS = 450;

/**
 * Write a chunk to the PTY.
 *
 * @param {string} s - Bytes to write.
 * @returns {void}
 */
function out(s) {
  try { process.stdout.write(s); } catch (_) { /* a closed PTY ends the run */ }
}

/**
 * The terminal's current width, defaulting to the classic 80 when the PTY
 * does not report one.
 *
 * WHY THIS FIXTURE IS WIDTH AWARE. TERMINAL-ARCHITECTURE section 2 measured
 * the real CLI doing a full width-locked repaint on resize: it clears and
 * repaints every row by absolute addressing, and every row it paints fits the
 * width it was told about. A fixture that painted a fixed 57-character row
 * into a 49-column terminal would manufacture wrapping the real application
 * never produces, and a harness measuring wrapping would then be measuring
 * its own fixture. Added 2026-08-19 for the mobile terminal work; at any
 * width of 57 columns or more the emitted bytes are byte for byte what they
 * were before, which is every existing caller.
 *
 * @returns {number} Column count.
 */
function columns() {
  const c = process.stdout && process.stdout.columns;
  return Number.isFinite(c) && c > 0 ? c : 80;
}

/**
 * Move the cursor to an absolute cell, 1-based, and write text there,
 * clipped to the terminal's current width so the row can never wrap.
 *
 * @param {number} row - 1-based row.
 * @param {number} col - 1-based column.
 * @param {string} text - Text to paint.
 * @returns {void}
 */
function at(row, col, text) {
  const room = Math.max(0, columns() - (col - 1));
  out(CSI + row + ';' + col + 'H' + CSI + 'K' + text.slice(0, room));
}

// ── Startup, in the measured order (section 2.4) ───────────────────────────
//
// Raw mode, because a TUI reads keys rather than lines. It is here for
// fidelity, not for the mouse: see the measured note below.
//
// MEASURED WHILE BUILDING THIS FIXTURE, and worth recording because it changes
// which routing case this pane exercises. Under ConPTY on this machine,
// conhost CONSUMES the mouse-tracking DECSETs (1000/1002/1003/1006) and does
// not forward them to the terminal, with or without raw mode and with or
// without win32 input mode. It forwards 1049, 2004, 1004 and 9001 unchanged.
// So the pane this fixture produces is an ALTERNATE-buffer pane with mouse
// tracking OFF, which is TERMINAL-ARCHITECTURE 8.1's third row: plain wheel up
// opens the history surface immediately, because nothing else wants the wheel.
// The tracking-ON row is covered by the unit suite against both signal sources.
try { if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true); } catch (_) {}
out(CSI + '?9001h');            // win32 input mode (ConPTY), exactly as measured
out(CSI + '?1004h');            // focus reporting
out(CSI + '?2004h');            // bracketed paste ON, which is the DEC 2004 gate
out(CSI + '?1049h');            // ENTER ALTERNATE BUFFER
out(CSI + '2J');                // clear it
out(CSI + '?1000h' + CSI + '?1002h' + CSI + '?1003h' + CSI + '?1006h'); // mouse tracking, any event, SGR
out(ESC + ']0;fake-agent\x07'); // window title

/**
 * Paint the whole frame once, by absolute addressing only.
 *
 * @param {number} tick - Monotonic tick, shown in the status row.
 * @returns {void}
 */
function paint(tick) {
  out(CSI + '?25l');            // hide the cursor during the patch
  at(1, 1, 'FAKE AGENT CLI  (alternate buffer, mouse tracking on)');
  at(2, 1, '-'.repeat(Math.min(58, columns())));
  for (let i = 0; i < VISIBLE_TURNS; i++) {
    // LIVE-SCREEN-ROW is the marker the browser proof looks for on the live
    // side of the seam. It appears ONLY here, never in the transcript fixture,
    // so a selection containing it provably reached the current screen.
    at(3 + i, 1, 'LIVE-SCREEN-ROW-' + (i + 1) + ': the frame the CLI is painting right now');
  }
  at(3 + VISIBLE_TURNS + 1, 1, 'status: working, tick ' + tick);
  at(3 + VISIBLE_TURNS + 3, 1, '> ');
  out(CSI + (3 + VISIBLE_TURNS + 3) + ';3H'); // park the cursor, as the CLI does
  out(CSI + '?25h');
}

let tick = 0;
paint(tick);

// ── The resize repaint, exactly as measured on the real CLI ───────────────
//
// Section 2 of TERMINAL-ARCHITECTURE records a full 2J plus a width-locked
// repaint by absolute addressing on every SIGWINCH. That is the behaviour the
// mobile work has to be tested against: a client whose grid does not match
// the PTY receives a frame built for a width it does not have, and no repaint
// ever arrives to correct it, because the application was never told anything
// changed. Reproducing the repaint is what makes the difference between the
// two cases observable.
try {
  process.stdout.on('resize', () => {
    out(CSI + '2J');
    paint(tick);
  });
} catch (_) { /* a PTY that reports no size simply never repaints */ }

const timer = setInterval(() => {
  tick++;
  // Only the status row is repainted, in place, which is precisely the pattern
  // that makes frame diffing useless for history recovery (section 2.3 C2).
  at(3 + VISIBLE_TURNS + 1, 1, 'status: working, tick ' + tick);
  out(CSI + (3 + VISIBLE_TURNS + 3) + ';3H');
}, TICK_MS);

/**
 * Leave the alternate buffer and stop, so a killed pane does not leave a
 * terminal in an odd mode for whatever runs next in the same PTY.
 *
 * @returns {void}
 */
function shutdown() {
  clearInterval(timer);
  out(CSI + '?1000l' + CSI + '?1002l' + CSI + '?1003l' + CSI + '?1006l');
  out(CSI + '?2004l');
  out(CSI + '?1049l');          // restore the normal buffer
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// stdin closing means the PTY went away.
try {
  process.stdin.resume();
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
} catch (_) { /* a PTY without a readable stdin still paints */ }
