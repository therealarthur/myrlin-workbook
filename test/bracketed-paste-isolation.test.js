#!/usr/bin/env node
/**
 * Plan 19-02 (PTY-06): per-pane bracketed paste isolation gate.
 *
 * TerminalPane handles paste in three paths (beforeinput insertFromPaste,
 * native paste event, Ctrl+V via pasteFromClipboard). Each path wraps the
 * pasted text in bracketed-paste escape sequences (\\x1b[200~ ... \\x1b[201~)
 * and sends through THIS pane's WebSocket. The isolation guarantee is that
 * all listeners are registered on the pane's own .xterm-helper-textarea
 * element (per-instance scope), NOT on document/window (cross-pane scope).
 *
 * jsdom + xterm.js wiring would be heavy and brittle; instead this gate
 * uses the source-harvesting approach pioneered by data-provider-attr.test.js
 * and idle-signal-dispatch.test.js: read terminal.js as text and string-
 * match the listener-registration surface. A future refactor that moves
 * any of these listeners to document/window will fail this gate.
 *
 * Plan 19-02 (PTY-06).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const src = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');

let passed = 0;
let failed = 0;

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

console.log('\n  Plan 19-02 (PTY-06): bracketed paste isolation gate');
console.log('  ' + '-'.repeat(58));

// ---------------------------------------------------------------------------
// (1) The hidden textarea must be looked up per-instance via container.querySelector
// ---------------------------------------------------------------------------

check('TerminalPane resolves xterm-helper-textarea via container.querySelector (per-instance scope)', () => {
  // The exact pattern in mount(): const xtermTextarea = container.querySelector('.xterm-helper-textarea');
  // This is the load-bearing line for paste isolation: container is the pane's
  // own host element, NOT document. If a future refactor swaps this for
  // document.querySelector or window.<...> the isolation breaks.
  const re = /const\s+xtermTextarea\s*=\s*container\.querySelector\(\s*['"]\.xterm-helper-textarea['"]\s*\)/;
  assert.ok(
    re.test(src),
    'mount() must scope xtermTextarea lookup to `container` (pane-local), not document/window'
  );
});

// ---------------------------------------------------------------------------
// (2) beforeinput listener is on xtermTextarea (per-instance)
// ---------------------------------------------------------------------------

check('beforeinput listener is registered on xtermTextarea (NOT on document)', () => {
  // The production form: xtermTextarea.addEventListener('beforeinput', (e) => { ... }, { capture: true });
  const re = /xtermTextarea\.addEventListener\(\s*['"]beforeinput['"]/;
  assert.ok(
    re.test(src),
    'beforeinput must be registered on xtermTextarea so a paste in pane A does not fire on pane B'
  );

  // Negative: there must NOT be a document-level beforeinput registration.
  // We allow `document.` references in unrelated code, but a beforeinput
  // listener on document would be a cross-pane leak.
  const documentBeforeInput =
    /document\.addEventListener\(\s*['"]beforeinput['"]/.test(src) ||
    /document\.body\.addEventListener\(\s*['"]beforeinput['"]/.test(src);
  assert.strictEqual(
    documentBeforeInput,
    false,
    'No document-level beforeinput listener allowed (would break per-pane isolation)'
  );
});

// ---------------------------------------------------------------------------
// (3) paste listener is on xtermTextarea (per-instance)
// ---------------------------------------------------------------------------

check('paste listener is registered on xtermTextarea (NOT on document)', () => {
  const re = /xtermTextarea\.addEventListener\(\s*['"]paste['"]/;
  assert.ok(
    re.test(src),
    'paste must be registered on xtermTextarea, not document/window'
  );

  // Negative: no document- or window-level paste listener.
  const documentPaste =
    /document\.addEventListener\(\s*['"]paste['"]/.test(src) ||
    /document\.body\.addEventListener\(\s*['"]paste['"]/.test(src) ||
    /window\.addEventListener\(\s*['"]paste['"]/.test(src);
  assert.strictEqual(
    documentPaste,
    false,
    'No document/window-level paste listener allowed (would break per-pane isolation)'
  );
});

// ---------------------------------------------------------------------------
// (4) Bracketed-paste escape sequence is used (sanity: paste wrapping intact)
// ---------------------------------------------------------------------------

check('Bracketed-paste escape sequence \\x1b[200~ ... \\x1b[201~ is intact', () => {
  // The two halves of the bracketed-paste wrapper. Asserting both prevents a
  // refactor that strips them (which would let pasted control sequences run
  // through the shell as commands rather than literal text).
  assert.ok(
    /\\x1b\[200~/.test(src),
    'bracketed-paste opener \\x1b[200~ missing'
  );
  assert.ok(
    /\\x1b\[201~/.test(src),
    'bracketed-paste closer \\x1b[201~ missing'
  );
});

// ---------------------------------------------------------------------------
// (4b) The bracket is now GATED on DEC 2004 (Notion restyle P5.1)
//
// ADDITIVE, not a retarget: check (4) above still asserts both markers survive,
// and they do. What this adds is the other half of the guarantee, because
// "the wrapper is intact" and "the wrapper is applied unconditionally" were
// both true at once until P5.1. TERMINAL-ARCHITECTURE.md defect D1 measured the
// consequence: against an application that never enabled bracketed paste (a
// bare cmd.exe, powershell.exe, or any simple REPL) the markers are delivered
// as literal garbage.
//
// TERMINAL-ARCHITECTURE.md stage 1 asks for exactly this assertion by name:
// "Extend test/bracketed-paste-isolation.test.js to assert the mode gate
// exists." The behavioural truth table lives in
// test/paste-input-preparation.test.js, which CALLS the function; this file
// keeps doing what it is good at, which is pinning the wiring.
// ---------------------------------------------------------------------------

check('the bracket is gated on the live DEC 2004 mode, not applied unconditionally', () => {
  assert.ok(
    /function prepareInputForPty\(text, opts\)/.test(src),
    'the shared paste preparation must be a module-level function so every entry point can reach it'
  );
  assert.ok(
    /term\.modes\.bracketedPasteMode/.test(src),
    "the gate must read xterm's own public IModes reader for the live mode"
  );
  assert.ok(
    /bracketedPasteMode === true/.test(src),
    'the gate must be strict: anything other than an explicit true must not bracket'
  );
});

check('every paste entry point routes through the one preparation function', () => {
  const routed = (src.match(/this\._sendPastePayload\(text\)/g) || []).length;
  assert.strictEqual(
    routed,
    2,
    'the two NATIVE entry points (beforeinput and the paste event) must both route through the shared preparation; found ' + routed
  );
  assert.ok(
    /pasteFromClipboard[\s\S]{0,600}?prepareInputForPty\(/.test(src),
    'the explicit Paste menu action must route through it too'
  );
});

// ---------------------------------------------------------------------------
// (5) Listener count: exactly two listeners on xtermTextarea (beforeinput + paste)
// ---------------------------------------------------------------------------

check('Exactly 2 xtermTextarea.addEventListener calls (beforeinput + paste)', () => {
  const matches = src.match(/xtermTextarea\.addEventListener\(/g) || [];
  assert.strictEqual(
    matches.length,
    2,
    'Expected exactly 2 xtermTextarea listener registrations (beforeinput + paste); found ' + matches.length
  );
});

// ---------------------------------------------------------------------------
// (6) pasteFromClipboard uses this.ws (per-instance WebSocket), not a shared one
// ---------------------------------------------------------------------------

check('pasteFromClipboard sends via this.ws (per-instance WebSocket)', () => {
  // Production form: this.ws.send(JSON.stringify({ type: 'input', data: bracketedText }));
  // The this.ws scoping is what keeps Ctrl+V paste from leaking to another pane.
  const re = /pasteFromClipboard[\s\S]{0,400}?this\.ws\.send\(/;
  assert.ok(
    re.test(src),
    'pasteFromClipboard must call this.ws.send (per-instance), not a shared WebSocket'
  );
});

// ---------------------------------------------------------------------------
// (7) Per-instance _pasteHandled flag
// ---------------------------------------------------------------------------

check('_pasteHandled flag is initialized per-instance in constructor', () => {
  // The constructor sets this._pasteHandled = false. This is the per-instance
  // dedup flag that prevents beforeinput + paste from double-sending. A
  // static or shared flag would cause cross-pane misbehavior.
  assert.ok(
    /this\._pasteHandled\s*=\s*false/.test(src),
    'constructor must initialize this._pasteHandled = false (per-instance state)'
  );
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('  ' + '-'.repeat(58));
console.log('  [bracketed-paste-isolation] ' + passed + '/' + (passed + failed) + ' tests passed');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
