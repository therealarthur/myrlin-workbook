#!/usr/bin/env node
/**
 * Issue #64: paste broken for all non-localhost users.
 * Modified: 2026-07-25
 *
 * PR #45 (commit cee137a) added an unconditional e.preventDefault() to the
 * Ctrl+V/Cmd+V branch in TerminalPane.attachCustomKeyEventHandler to stop a
 * double-paste on localhost. That cancels the browser's native paste, leaving
 * pasteFromClipboard() (navigator.clipboard.readText) as the only paste path.
 * On insecure origins (http over LAN, the documented remote-access mode)
 * navigator.clipboard is undefined, the rejection was caught and logged to
 * console only, and paste silently did nothing on every browser and device.
 *
 * The fix feature-detects the async Clipboard API:
 *   - secure context: keep preventDefault + pasteFromClipboard (no #45 regression)
 *   - insecure context: skip preventDefault so the native paste + the existing
 *     beforeinput/paste handlers bracket and send the text once
 * plus a guard in pasteFromClipboard and a user-visible message, and a
 * context-menu fallback that points the user at Ctrl+V.
 *
 * This gate follows the source-harvesting approach of
 * bracketed-paste-isolation.test.js: read the sources as text and string-match
 * the load-bearing surface, so a future refactor that reverts to an
 * unconditional preventDefault (which reintroduces #64) fails here.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run a single named check, tracking pass/fail counts and printing a line.
 * Mirrors the tiny runner used by bracketed-paste-isolation.test.js so this
 * file is standalone and reportable through test/run.js's spawn loop.
 * @param {string} name - Human-readable assertion name.
 * @param {Function} fn - Body that throws on failure.
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : String(err)));
  }
}

/**
 * Slice out the Ctrl+V/Cmd+V branch from terminal.js source: from the
 * `mod && e.key === 'v'` anchor through that branch's `return false;`. Bounding
 * on the branch's own return keeps the Shift+Enter block (which has its own
 * preventDefault) out of the window so the preventDefault-count assertion is
 * exact.
 * @returns {string} The Ctrl+V branch source text.
 */
function extractCtrlVBranch() {
  const anchor = "mod && e.key === 'v'";
  const start = termSrc.indexOf(anchor);
  assert.ok(start !== -1, "could not locate the Ctrl+V branch anchor (mod && e.key === 'v')");
  const after = termSrc.slice(start);
  const endToken = 'return false;';
  const endIdx = after.indexOf(endToken);
  assert.ok(endIdx !== -1, 'Ctrl+V branch has no return false; terminator');
  return after.slice(0, endIdx + endToken.length);
}

/**
 * Compile the real capture-phase native-paste handler from terminal.js.
 * The executed test below then models xterm's listener on the same textarea:
 * stopPropagation() is insufficient at the target, while
 * stopImmediatePropagation() prevents the second send.
 * @returns {Function} The extracted handler, accepting event/WebSocket/window.
 */
function compileNativePasteHandler() {
  const anchor = "xtermTextarea.addEventListener('paste', (e) => {";
  const start = termSrc.indexOf(anchor);
  assert.ok(start !== -1, 'could not locate the native paste listener');
  const bodyStart = start + anchor.length;
  const end = termSrc.indexOf("}, { capture: true });", bodyStart);
  assert.ok(end !== -1, 'could not locate the native paste listener terminator');
  return new Function('e', 'WebSocket', 'window', termSrc.slice(bodyStart, end));
}

console.log('\n  Issue #64: paste secure-context fallback gate');
console.log('  ' + '-'.repeat(58));

// ---------------------------------------------------------------------------
// (1) The Ctrl+V branch contains a navigator.clipboard feature check
// ---------------------------------------------------------------------------

check('Ctrl+V branch feature-detects navigator.clipboard.readText', () => {
  const branch = extractCtrlVBranch();
  assert.ok(
    /navigator\.clipboard/.test(branch),
    'Ctrl+V branch must reference navigator.clipboard (secure-context detection)'
  );
  assert.ok(
    /readText/.test(branch),
    'Ctrl+V branch must check navigator.clipboard.readText specifically'
  );
});

// ---------------------------------------------------------------------------
// (2) preventDefault appears only in the clipboard-available arm
// ---------------------------------------------------------------------------

check('preventDefault lives only inside the clipboard-available arm', () => {
  const branch = extractCtrlVBranch();
  const pdMatches = branch.match(/preventDefault/g) || [];
  assert.strictEqual(
    pdMatches.length,
    1,
    'Ctrl+V branch must call preventDefault exactly once (only when the clipboard API exists); found ' + pdMatches.length
  );
  const checkIdx = branch.indexOf('navigator.clipboard');
  const pdIdx = branch.indexOf('preventDefault');
  assert.ok(
    checkIdx !== -1 && pdIdx !== -1 && checkIdx < pdIdx,
    'preventDefault must come AFTER the navigator.clipboard feature check (inside the available arm), never unconditionally. An unconditional preventDefault reintroduces issue #64.'
  );
});

// ---------------------------------------------------------------------------
// (3) pasteFromClipboard guards availability before reading the clipboard
// ---------------------------------------------------------------------------

check('pasteFromClipboard guards navigator.clipboard before readText()', () => {
  const pfcIdx = termSrc.indexOf('async pasteFromClipboard');
  assert.ok(pfcIdx !== -1, 'pasteFromClipboard method not found');
  const body = termSrc.slice(pfcIdx, pfcIdx + 900);
  const guardIdx = body.search(/if\s*\(\s*!\s*navigator\.clipboard/);
  const awaitReadIdx = body.indexOf('await navigator.clipboard.readText');
  assert.ok(guardIdx !== -1, 'pasteFromClipboard must guard availability with if (!navigator.clipboard ...)');
  assert.ok(awaitReadIdx !== -1, 'pasteFromClipboard must still await navigator.clipboard.readText');
  assert.ok(
    guardIdx < awaitReadIdx,
    'the availability guard must run BEFORE the clipboard is read'
  );
  const guardRegion = body.slice(guardIdx, awaitReadIdx);
  assert.ok(
    /return false/.test(guardRegion),
    'the guard must return false when the clipboard API is unavailable (do not throw into the catch)'
  );
});

// ---------------------------------------------------------------------------
// (4) The native fallback handlers are still intact
// ---------------------------------------------------------------------------

check('native paste + beforeinput fallback handlers remain intact', () => {
  // The paste listener reads the pasted text from the ClipboardEvent.
  assert.ok(
    /e\.clipboardData/.test(termSrc),
    'native paste handler must still read e.clipboardData'
  );
  // The beforeinput listener is what actually delivers the native paste on
  // insecure origins now that Ctrl+V no longer preventDefaults there.
  assert.ok(
    /addEventListener\(\s*['"]beforeinput['"]/.test(termSrc),
    'beforeinput handler must still be registered'
  );
  assert.ok(
    /insertFromPaste/.test(termSrc),
    'beforeinput handler must still special-case insertFromPaste (the native paste path)'
  );
});

// ---------------------------------------------------------------------------
// (5) Native paste suppresses xterm's listener on the same textarea
// ---------------------------------------------------------------------------

check('native paste sends exactly once when xterm also listens on the textarea', () => {
  const sent = [];
  const pane = {
    _pasteHandled: false,
    ws: {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload).data);
      },
    },
  };
  const event = {
    immediateStopped: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {
      this.immediateStopped = true;
    },
    clipboardData: {
      getData() {
        return 'native paste';
      },
    },
  };

  compileNativePasteHandler().call(pane, event, { OPEN: 1 }, {});

  // xterm registers its own non-capture paste listener on this exact
  // textarea. A capture listener must stop it immediately, not merely stop
  // propagation to ancestors.
  if (!event.immediateStopped) {
    sent.push('native paste');
  }

  assert.deepStrictEqual(
    sent,
    ['\x1b[200~native paste\x1b[201~'],
    'native paste must produce one bracketed WebSocket input frame'
  );
});

// ---------------------------------------------------------------------------
// (6) The app.js context-menu Paste action checks availability
// ---------------------------------------------------------------------------

check('context-menu Paste action feature-detects the clipboard API', () => {
  const callIdx = appSrc.indexOf('tp.pasteFromClipboard()');
  assert.ok(callIdx !== -1, 'context-menu Paste action (tp.pasteFromClipboard()) not found');
  // Window around the Paste item: the availability check sits above the call,
  // the Ctrl+V fallback toast sits below it.
  const region = appSrc.slice(Math.max(0, callIdx - 800), callIdx + 700);
  assert.ok(
    /navigator\.clipboard/.test(region) && /readText/.test(region),
    'context-menu Paste must feature-detect navigator.clipboard.readText before pasting'
  );
  assert.ok(
    /showToast/.test(region) && /Ctrl\+V/.test(region),
    'context-menu Paste must fall back to a showToast telling the user to press Ctrl+V'
  );
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('  ' + '-'.repeat(58));
console.log('  [paste-secure-context-fallback] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
