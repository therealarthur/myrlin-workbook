/**
 * Shared terminal plumbing for the fake Claude and Codex CLIs (BUILD-CONTRACT 3.6.3).
 *
 * What: a tiny full screen TUI host: alternate screen, bracketed paste on
 * while the input is idle, full redraws, an input parser that understands
 * bracketed pastes, Enter, a lone ESC, arrows, Space and typed characters,
 * and helpers for writing JSONL records and fake CLI state.
 *
 * Why: tests and the Mac sandbox must exercise the real Workbook paths (PTY
 * spawn, the VT sidecar, the send guard, prompt detection) without a model.
 * The screens use the same anchors as Claude Code 2.1.283 and codex-cli
 * 0.153.4 so the detectors work on fakes and real captures alike.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ESC = '\x1b';
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';
const NBSP = String.fromCharCode(0xa0);
const DIM = ESC + '[2m';
const BOLD = ESC + '[1m';
const RESET = ESC + '[0m';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * Screen size of the controlling terminal.
 * @returns {{cols: number, rows: number}}
 */
function termSize() {
  return { cols: process.stdout.columns || DEFAULT_COLS, rows: process.stdout.rows || DEFAULT_ROWS };
}

/**
 * The home directory the fakes use (HOME wins, like a POSIX CLI).
 * @returns {string}
 */
function homeDir() {
  return process.env.HOME || os.homedir();
}

/**
 * Append one JSON record to a JSONL file.
 * @param {string} file
 * @param {object} rec
 */
function appendRecord(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

/**
 * Sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * A full screen TUI host.
 */
class Tui {
  /**
   * @param {object} handlers - {onPaste(text), onEnter(), onEsc(), onKey(name), onChar(ch)}
   */
  constructor(handlers) {
    this.h = handlers;
    this.pasteMode = false;
    this.buf = '';
    this.inPaste = false;
    this.pasteBuf = '';
    this.escTimer = null;
    this.lastFrame = '';
    process.stdout.write(ESC + '[?1049h' + ESC + '[H' + ESC + '[2J');
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => this.feed(d));
    process.stdin.resume();
  }

  /**
   * Turn bracketed paste mode on or off (ESC [?2004h / l).
   * @param {boolean} on
   */
  setPasteMode(on) {
    if (on === this.pasteMode) return;
    this.pasteMode = on;
    process.stdout.write(ESC + '[?2004' + (on ? 'h' : 'l'));
  }

  /**
   * Draw a whole screen of lines (strings may carry SGR codes).
   * @param {string[]} lines
   */
  draw(lines) {
    const { rows } = termSize();
    const out = lines.slice(0, rows);
    const frame = out.join('\r\n');
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    process.stdout.write(ESC + '[H' + ESC + '[2J' + frame);
  }

  /**
   * Parse input bytes.
   * @param {string} data
   */
  feed(data) {
    if (process.env.FAKE_TUI_DEBUG) { try { fs.appendFileSync(process.env.FAKE_TUI_DEBUG, JSON.stringify(data) + String.fromCharCode(10)); } catch (_) {} }
    this.buf += data;
    for (;;) {
      if (this.inPaste) {
        const end = this.buf.indexOf(PASTE_END);
        if (end === -1) { this.pasteBuf += this.buf; this.buf = ''; return; }
        this.pasteBuf += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + PASTE_END.length);
        this.inPaste = false;
        const text = this.pasteBuf;
        this.pasteBuf = '';
        this.h.onPaste(text);
        continue;
      }
      if (!this.buf.length) return;
      if (this.buf.startsWith(PASTE_START)) { this.inPaste = true; this.buf = this.buf.slice(PASTE_START.length); continue; }
      const c = this.buf[0];
      if (c === ESC) {
        if (this.buf.length === 1) {
          // A lone ESC: wait briefly for a sequence to follow in the next chunk.
          if (this.escTimer) return;
          this.escTimer = setTimeout(() => { this.escTimer = null; if (this.buf === ESC) { this.buf = ''; this.h.onEsc(); } }, 30);
          return;
        }
        if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
        const m = /^\x1b\[([ABCD])/.exec(this.buf);
        if (m) { this.buf = this.buf.slice(3); this.h.onKey({ A: 'up', B: 'down', C: 'right', D: 'left' }[m[1]]); continue; }
        const other = /^\x1b\[[0-9;?]*[ -\/]*[@-~]/.exec(this.buf);
        if (other) { this.buf = this.buf.slice(other[0].length); continue; }
        this.buf = this.buf.slice(1);
        this.h.onEsc();
        continue;
      }
      this.buf = this.buf.slice(1);
      if (c === '\r' || c === '\n') this.h.onEnter();
      else if (c === ' ') this.h.onKey('space');
      else if (c === '\x15') this.h.onKey('clear');
      else if (c === '\x7f' || c === '\b') this.h.onKey('backspace');
      else if (c === '\x03') this.h.onKey('ctrlc');
      else if (c >= ' ') this.h.onChar(c);
    }
  }

  /** Leave the alternate screen and exit. */
  exit(code) {
    try { process.stdout.write(ESC + '[?2004l' + ESC + '[?1049l'); } catch (_) {}
    process.exit(code || 0);
  }
}

module.exports = { Tui, termSize, homeDir, appendRecord, sleep, ESC, NBSP, DIM, BOLD, RESET, PASTE_START, PASTE_END };
