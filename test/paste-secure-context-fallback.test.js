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
 * The first fix feature-detected the async Clipboard API, but that left a
 * second dead end: embedded browsers can expose navigator.clipboard.readText
 * while rejecting every read. The secure arm canceled native paste before
 * discovering the rejection, then told the user to retry the same broken
 * shortcut. Keyboard paste now always uses the trusted native paste event;
 * the capture-phase beforeinput/paste handlers bracket and send it exactly
 * once on every origin. Programmatic reads remain limited to the explicit
 * context-menu Paste command, with truthful fallback guidance.
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
 * `mod && shortcutKey === 'v'` anchor through that branch's `return false;`. Bounding
 * on the branch's own return keeps the Shift+Enter block (which has its own
 * preventDefault) out of the window so the preventDefault-count assertion is
 * exact.
 * @returns {string} The Ctrl+V branch source text.
 */
function extractCtrlVBranch() {
  const anchor = "mod && shortcutKey === 'v'";
  const start = termSrc.indexOf(anchor);
  assert.ok(start !== -1, "could not locate the Ctrl+V branch anchor (mod && shortcutKey === 'v')");
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

/**
 * Compile the real capture-phase beforeinput handler so orphan-event behavior
 * is exercised rather than inferred from source text.
 * @returns {Function} The extracted handler, accepting event/WebSocket.
 */
function compileBeforeInputHandler() {
  const anchor = "xtermTextarea.addEventListener('beforeinput', (e) => {";
  const start = termSrc.indexOf(anchor);
  assert.ok(start !== -1, 'could not locate the beforeinput listener');
  const bodyStart = start + anchor.length;
  const end = termSrc.indexOf("}, { capture: true });", bodyStart);
  assert.ok(end !== -1, 'could not locate the beforeinput listener terminator');
  return new Function('e', 'WebSocket', termSrc.slice(bodyStart, end));
}

console.log('\n  Issue #64: paste secure-context fallback gate');
console.log('  ' + '-'.repeat(58));

// ---------------------------------------------------------------------------
// (1) Keyboard paste never depends on the permission-gated Clipboard API
// ---------------------------------------------------------------------------

check('Ctrl+V branch stays on the trusted native paste path', () => {
  const branch = extractCtrlVBranch();
  assert.ok(!/navigator\.clipboard/.test(branch), 'keyboard paste must not read navigator.clipboard');
  assert.ok(!/pasteFromClipboard/.test(branch), 'keyboard paste must not call the programmatic menu path');
  assert.ok(/return false/.test(branch), 'xterm must skip its own key handling while native paste proceeds');
});

check('Ctrl+V compares a normalized key so uppercase/Caps Lock cannot bypass the branch', () => {
  assert.ok(
    /const shortcutKey = typeof e\.key === 'string' \? e\.key\.toLowerCase\(\) : ''/.test(termSrc),
    'KeyboardEvent.key must be normalized before the copy/paste branches'
  );
  assert.ok(
    /shortcutKey === 'v'/.test(extractCtrlVBranch()),
    'the keyboard paste branch must compare the normalized shortcut key'
  );
});

// ---------------------------------------------------------------------------
// (2) Native paste must not be canceled before the trusted event fires
// ---------------------------------------------------------------------------

check('Ctrl+V branch never cancels the browser default', () => {
  const branch = extractCtrlVBranch();
  const pdMatches = branch.match(/preventDefault/g) || [];
  assert.strictEqual(
    pdMatches.length,
    0,
    'Ctrl+V must leave the trusted native paste event available; found ' + pdMatches.length +
      ' preventDefault reference(s)'
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
  // The beforeinput listener delivers keyboard paste on every origin now that
  // Ctrl+V never cancels the browser's trusted event.
  assert.ok(
    /addEventListener\(\s*['"]beforeinput['"]/.test(termSrc),
    'beforeinput handler must still be registered'
  );
  assert.ok(
    /insertFromPaste/.test(termSrc),
    'beforeinput handler must still special-case insertFromPaste (the native paste path)'
  );
});

check('beforeinput exact-once latch arms only after non-empty text is sent and expires per gesture', () => {
  const anchor = "xtermTextarea.addEventListener('beforeinput', (e) => {";
  const start = termSrc.indexOf(anchor);
  const end = termSrc.indexOf("}, { capture: true });", start + anchor.length);
  const body = termSrc.slice(start, end);
  const textIdx = body.indexOf('const text =');
  const nonEmptyIdx = body.indexOf('if (text && this.ws');
  const latchIdx = body.indexOf('this._pasteHandled = true');
  const sendIdx = body.indexOf('this.ws.send');
  assert.ok(textIdx !== -1 && nonEmptyIdx !== -1 && latchIdx !== -1 && sendIdx !== -1,
    'beforeinput paste path must extract, validate, latch, and send text');
  assert.ok(textIdx < nonEmptyIdx && nonEmptyIdx < latchIdx && latchIdx < sendIdx,
    'an empty/orphan beforeinput must not arm the latch that suppresses the next paste');
  assert.ok(/this\._pasteHandledResetTimer = setTimeout\(\(\) => \{[\s\S]*this\._pasteHandled = false[\s\S]*\}, 0\)/.test(body),
    'a sent beforeinput paste must expire its companion-event latch at the end of the gesture');
});

// ---------------------------------------------------------------------------
// (5) Native paste suppresses xterm's listener on the same textarea
// ---------------------------------------------------------------------------

check('empty orphan beforeinput cannot suppress the next real native paste', () => {
  const sent = [];
  const pane = {
    _pasteHandled: false,
    _pasteHandledResetTimer: null,
    // Select mode v2: both compiled handlers leave Select mode before they
    // send, because a paste is input and input resumes live output. The fake
    // models a pane that is not frozen, so the call is a no-op here.
    _exitSelectModeForInput() { return false; },
    ws: {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload).data);
      },
    },
  };
  compileBeforeInputHandler().call(pane, {
    inputType: 'insertFromPaste',
    data: '',
    dataTransfer: null,
    preventDefault() {},
  }, { OPEN: 1 });
  assert.strictEqual(pane._pasteHandled, false, 'empty beforeinput must leave the latch disarmed');

  const event = {
    preventDefault() {},
    stopImmediatePropagation() {},
    clipboardData: { getData: () => 'paste after empty orphan' },
  };
  compileNativePasteHandler().call(pane, event, { OPEN: 1 }, {});
  assert.deepStrictEqual(
    sent,
    ['\x1b[200~paste after empty orphan\x1b[201~'],
    'the next native paste must not be dropped'
  );
});

check('native paste sends exactly once when xterm also listens on the textarea', () => {
  const sent = [];
  const pane = {
    _pasteHandled: false,
    // Select mode v2: the compiled paste handler unfreezes before sending.
    _exitSelectModeForInput() { return false; },
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
