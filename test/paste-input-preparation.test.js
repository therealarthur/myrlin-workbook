#!/usr/bin/env node
/**
 * paste-input-preparation.test.js
 * Notion restyle phase P5, work packages P5.1 and P5.2.
 * BUILD-CONTRACT.md P5.1, TERMINAL-ARCHITECTURE.md defects D1 and D2 and
 * sections 9.2 to 9.4.
 *
 * WHAT IS UNDER TEST, AND WHY IT IS EXECUTED RATHER THAN READ
 *
 * Most terminal.js suites in this repository assert against the file's SOURCE
 * TEXT, because a live xterm plus a WebSocket plus a DOM is heavy and brittle.
 * That is the right trade for wiring, and the wrong one for a pure function:
 * a regex that finds `replace(/\r?\n/g, '\r')` proves the characters are
 * present, not that a CRLF paste produces one Enter.
 *
 * prepareInputForPty was deliberately written at MODULE level with no instance
 * state so it can be evaluated in a vm sandbox and CALLED. Every assertion
 * below runs the real production function over a real input and reads the real
 * bytes it would put on the wire.
 *
 * THE TRUTH TABLE
 *
 *   {single, multi} x {bracketed on, off} x {CRLF, LF, CR}
 *
 * plus the embedded end-marker case, plus the three settings values, plus the
 * degenerate inputs (empty, null, a lone trailing newline).
 *
 * The two defects this closes were measured against live PTY sessions, not
 * inferred:
 *
 *   D1  brackets were applied with no check of DEC 2004, so a bare cmd.exe or
 *       powershell.exe received `[200~` and `[201~` as literal text.
 *   D2  newlines were sent verbatim, so a Windows CRLF two-line paste arrived
 *       as CR LF CR LF and a PTY line discipline read TWO Enters plus two
 *       stray line feeds.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run one named check, tracking counts and printing a line.
 *
 * @param {string} name - Human-readable assertion name.
 * @param {Function} fn - Body that throws on failure.
 * @returns {void}
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
 * Evaluate terminal.js in a fresh vm context and hand back the real
 * module-level function plus the class and the sandbox.
 *
 * The sandbox is deliberately minimal: no DOM, no xterm, no WebSocket. If
 * prepareInputForPty ever grew a dependency on any of them, this loader would
 * be the first thing to fail, which is the property the work package wants.
 *
 * @param {Object} [extra] - Extra globals to place in the sandbox.
 * @returns {{prepareInputForPty: Function, TerminalPane: Function, sandbox: Object}} Runtime.
 */
function loadRuntime(extra) {
  const sandbox = Object.assign({ window: {}, console }, extra || {});
  const context = vm.createContext(sandbox);
  vm.runInContext(termSrc, context, { filename: 'terminal.js' });
  const fn = vm.runInContext('prepareInputForPty', context);
  assert.strictEqual(typeof fn, 'function',
    'prepareInputForPty must be a MODULE-level function (contract P5.1); it was not reachable in the sandbox');
  return { prepareInputForPty: fn, TerminalPane: vm.runInContext('TerminalPane', context), sandbox: sandbox };
}

const rt = loadRuntime();
const prepare = rt.prepareInputForPty;

// The two markers, written as escapes so this file never contains a raw
// control character that an editor could normalise away.
const START = '[200~';
const END = '[201~';

console.log('\n  P5.1/P5.2: paste input preparation truth table');
console.log('  ' + '-'.repeat(58));

/* ============================================================
   1. D2, newline normalisation, all three flavours
   ============================================================ */

check('CRLF becomes ONE carriage return per line, never CR LF', () => {
  const out = prepare('one\r\ntwo', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'one\rtwo',
    'a Windows two-line paste must deliver exactly one Enter between the lines');
  assert.strictEqual(out.data.indexOf('\n'), -1, 'no line feed may survive normalisation');
  assert.strictEqual(out.lineCount, 2);
});

check('LF becomes CR', () => {
  const out = prepare('one\ntwo', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'one\rtwo');
  assert.strictEqual(out.lineCount, 2);
});

check('a LONE CR is already correct and is left exactly as it is', () => {
  const out = prepare('one\rtwo', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'one\rtwo');
  assert.strictEqual(out.lineCount, 2);
});

check('mixed flavours in one payload all collapse to CR', () => {
  const out = prepare('a\r\nb\nc\rd', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'a\rb\rc\rd');
  assert.strictEqual(out.lineCount, 4);
});

check('a run of blank lines keeps its own count and adds no line feeds', () => {
  const out = prepare('a\r\n\r\n\r\nb', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'a\r\r\rb');
  assert.strictEqual(out.lineCount, 4);
});

check('a single line is passed through byte for byte', () => {
  const out = prepare('npm test', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'npm test');
  assert.strictEqual(out.lineCount, 1);
  assert.strictEqual(out.needsConfirm, false);
});

/* ============================================================
   2. D1, the bracket gate
   ============================================================ */

check('bracketedPasteMode OFF sends NO markers (defect D1, the bare shell case)', () => {
  for (const text of ['ls -la', 'one\r\ntwo', 'one\ntwo', 'one\rtwo']) {
    const out = prepare(text, { bracketedPasteMode: false });
    assert.strictEqual(out.bracketed, false);
    assert.strictEqual(out.data.indexOf(START), -1, 'no bracketed-paste opener for ' + JSON.stringify(text));
    assert.strictEqual(out.data.indexOf(END), -1, 'no bracketed-paste closer for ' + JSON.stringify(text));
  }
});

check('bracketedPasteMode ON wraps the NORMALISED text, in that order', () => {
  const out = prepare('one\r\ntwo', { bracketedPasteMode: true });
  assert.strictEqual(out.data, START + 'one\rtwo' + END,
    'the markers must frame the normalised payload, not the raw clipboard text');
  assert.strictEqual(out.bracketed, true);
});

check('the gate is strict: only an explicit true brackets', () => {
  for (const value of [undefined, null, false, 0, '', 'true', 1]) {
    const out = prepare('x', { bracketedPasteMode: value });
    assert.strictEqual(out.bracketed, false,
      'a non-boolean-true mode value must not bracket: ' + JSON.stringify(value));
  }
  assert.strictEqual(prepare('x', {}).bracketed, false);
  assert.strictEqual(prepare('x').bracketed, false, 'a missing options object must not bracket');
});

/* ============================================================
   3. The embedded end marker, the one untrusted-content case
   ============================================================ */

check('an embedded END MARKER is stripped when bracketing, so the payload cannot break out', () => {
  const hostile = 'safe text' + END + 'rm -rf /';
  const out = prepare(hostile, { bracketedPasteMode: true });
  const body = out.data.slice(START.length, out.data.length - END.length);
  assert.strictEqual(body.indexOf(END), -1,
    'an end marker inside the payload would close the bracket early and let the rest be read as TYPED input');
  assert.strictEqual(out.data, START + 'safe textrm -rf /' + END);
  assert.strictEqual(out.data.split(END).length - 1, 1, 'exactly one end marker may survive: the one we add');
});

check('several embedded end markers are all stripped', () => {
  const out = prepare(END + 'a' + END + 'b' + END, { bracketedPasteMode: true });
  assert.strictEqual(out.data, START + 'ab' + END);
});

check('an embedded end marker is NOT stripped when the application is not bracketing', () => {
  // Nothing is framing the payload, so there is nothing to break out of, and
  // silently editing a user's clipboard content would be the larger surprise.
  const out = prepare('a' + END + 'b', { bracketedPasteMode: false });
  assert.strictEqual(out.data, 'a' + END + 'b');
});

check('an embedded OPENER is harmless and is left alone', () => {
  const out = prepare('a' + START + 'b', { bracketedPasteMode: true });
  assert.strictEqual(out.data, START + 'a' + START + 'b' + END,
    'a nested opener cannot terminate the bracket, so removing it would only corrupt content');
});

/* ============================================================
   4. Section 9.4, the multi-line confirm truth table
   ============================================================ */

check('9.4 row 1: a single line never confirms, in any mode or setting', () => {
  for (const bracketed of [true, false]) {
    for (const setting of ['auto', 'always', 'never', undefined]) {
      const out = prepare('one line', { bracketedPasteMode: bracketed, confirmMultiline: setting });
      assert.strictEqual(out.needsConfirm, false,
        'single line must not confirm (bracketed=' + bracketed + ' setting=' + setting + ')');
    }
  }
});

check('9.4 row 2: multi-line with bracketing ON never nags', () => {
  const out = prepare('one\ntwo\nthree', { bracketedPasteMode: true, confirmMultiline: 'auto' });
  assert.strictEqual(out.needsConfirm, false,
    'an application that enabled DEC 2004 has said it will handle a multi-line payload itself');
  assert.strictEqual(out.lineCount, 3);
});

check('9.4 row 3: multi-line with bracketing OFF asks', () => {
  const out = prepare('one\ntwo', { bracketedPasteMode: false, confirmMultiline: 'auto' });
  assert.strictEqual(out.needsConfirm, true,
    'this is the case where every line becomes its own command');
  assert.strictEqual(out.lineCount, 2);
});

check('9.4 row 4: the setting overrides the table in both directions', () => {
  const always = prepare('one\ntwo', { bracketedPasteMode: true, confirmMultiline: 'always' });
  assert.strictEqual(always.needsConfirm, true, '`always` must ask even for a bracketed session');
  const never = prepare('one\ntwo', { bracketedPasteMode: false, confirmMultiline: 'never' });
  assert.strictEqual(never.needsConfirm, false, '`never` must not ask even for a bare shell');
  const unknown = prepare('one\ntwo', { bracketedPasteMode: false, confirmMultiline: 'nonsense' });
  assert.strictEqual(unknown.needsConfirm, true, 'an unrecognised setting falls back to the auto table');
});

check('a TRAILING newline counts as a second line, because it is what executes the command', () => {
  const out = prepare('rm -rf node_modules\n', { bracketedPasteMode: false });
  assert.strictEqual(out.lineCount, 2);
  assert.strictEqual(out.needsConfirm, true);
  assert.strictEqual(out.data, 'rm -rf node_modules\r');
});

check('the confirm carries the line count and a bounded first-line preview', () => {
  const long = 'x'.repeat(400);
  const out = prepare(long + '\nsecond', { bracketedPasteMode: false });
  assert.strictEqual(out.lineCount, 2);
  assert.ok(out.firstLine.length <= 120, 'the preview must be bounded so the dialog cannot grow a scrollbar');
  assert.ok(long.startsWith(out.firstLine), 'the preview must be a prefix of the real first line');
});

/* ============================================================
   5. Degenerate input: it must never throw into a paste handler
   ============================================================ */

check('empty, null and undefined text produce an empty payload rather than a throw', () => {
  for (const value of ['', null, undefined]) {
    const out = prepare(value, { bracketedPasteMode: false });
    assert.strictEqual(out.data, '');
    assert.strictEqual(out.lineCount, 1);
    assert.strictEqual(out.needsConfirm, false);
  }
});

check('a non-string is coerced rather than throwing', () => {
  const out = prepare(42, { bracketedPasteMode: false });
  assert.strictEqual(out.data, '42');
});

check('an empty bracketed paste still frames correctly', () => {
  const out = prepare('', { bracketedPasteMode: true });
  assert.strictEqual(out.data, START + END);
});

check('the returned object always carries the whole documented shape', () => {
  const out = prepare('a\nb', { bracketedPasteMode: true });
  for (const key of ['data', 'needsConfirm', 'lineCount', 'bracketed', 'firstLine']) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, key), 'missing key: ' + key);
  }
  assert.strictEqual(typeof out.data, 'string');
  assert.strictEqual(typeof out.needsConfirm, 'boolean');
  assert.strictEqual(typeof out.lineCount, 'number');
  assert.strictEqual(typeof out.bracketed, 'boolean');
  assert.strictEqual(typeof out.firstLine, 'string');
});

check('the function is pure: the same input twice gives the same bytes', () => {
  const opts = { bracketedPasteMode: true, confirmMultiline: 'auto' };
  const first = prepare('a\r\nb' + END, opts);
  const second = prepare('a\r\nb' + END, opts);
  assert.deepStrictEqual(first, second,
    'a module-level regex with the g flag that leaked lastIndex between calls would fail exactly here');
});

/* ============================================================
   6. The live mode reader, executed against the real method
   ============================================================ */

check('isBracketedPasteMode prefers the server mode frame, then xterm, then false', () => {
  const TP = rt.TerminalPane;
  const read = TP.prototype.isBracketedPasteMode;

  assert.strictEqual(read.call({}), false,
    'a pane with no terminal and no frame must default to NOT bracketing');
  assert.strictEqual(read.call({ term: { modes: { bracketedPasteMode: true } } }), true,
    "xterm's own IModes reader is the second source");
  assert.strictEqual(read.call({ term: { modes: { bracketedPasteMode: false } } }), false);
  assert.strictEqual(read.call({ term: {} }), false,
    'an xterm build with no modes property must not throw');
  assert.strictEqual(
    read.call({ _remoteBracketedPaste: true, term: { modes: { bracketedPasteMode: false } } }),
    true,
    'the server VT sees bytes this client was not attached for, so its frame outranks the local reader'
  );
  assert.strictEqual(
    read.call({ _remoteBracketedPaste: false, term: { modes: { bracketedPasteMode: true } } }),
    false
  );
  const throwing = { get term() { throw new Error('disposed'); } };
  assert.strictEqual(read.call(throwing), false, 'a disposed terminal must degrade, never throw into a paste');
});

check('the sidecar is an upgrade, not a dependency: an absent frame changes nothing', () => {
  const read = rt.TerminalPane.prototype.isBracketedPasteMode;
  // CWM_VT_SIDECAR defaults OFF, so this is the shipped configuration.
  const pane = { _remoteBracketedPaste: undefined, term: { modes: { bracketedPasteMode: true } } };
  assert.strictEqual(read.call(pane), true);
});

check('multilinePasteSetting reads the setting and survives a malformed one', () => {
  const cases = [
    [null, 'auto'],
    ['{}', 'auto'],
    ['{"terminalConfirmMultilinePaste":"always"}', 'always'],
    ['{"terminalConfirmMultilinePaste":"never"}', 'never'],
    ['{"terminalConfirmMultilinePaste":"auto"}', 'auto'],
    ['{"terminalConfirmMultilinePaste":"garbage"}', 'auto'],
    ['not json at all', 'auto'],
    ['{"terminalConfirmMultilinePaste":{"nested":true}}', 'auto'],
  ];
  for (const [stored, expected] of cases) {
    const runtime = loadRuntime({ localStorage: { getItem: () => stored, setItem: () => {} } });
    assert.strictEqual(runtime.TerminalPane.multilinePasteSetting(), expected,
      'stored ' + JSON.stringify(stored) + ' should resolve to ' + expected);
  }
});

check('pasteOptions composes the two live inputs the three entry points share', () => {
  const TP = rt.TerminalPane;
  const pane = {
    _remoteBracketedPaste: true,
    isBracketedPasteMode: TP.prototype.isBracketedPasteMode,
  };
  const opts = TP.prototype.pasteOptions.call(pane);
  assert.strictEqual(opts.bracketedPasteMode, true);
  assert.strictEqual(opts.confirmMultiline, 'auto');
});

/* ============================================================
   7. The three entry points, executed
   ============================================================ */

/**
 * Build a fake pane whose only observable behaviour is what it puts on the
 * socket, so a send can be asserted byte for byte.
 *
 * @param {Object} [overrides] - Fields to merge onto the fake.
 * @returns {Object} The fake pane plus a `sent` array.
 */
function makePane(overrides) {
  const TP = rt.TerminalPane;
  // terminal.js is a browser file and reads the WebSocket global for its
  // readyState constant, exactly as every other send site in it does. The
  // sandbox supplies the one constant rather than a socket implementation.
  rt.sandbox.WebSocket = { OPEN: 1 };
  const sent = [];
  return Object.assign({
    sent: sent,
    ws: { readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) },
    _remoteBracketedPaste: undefined,
    term: { modes: { bracketedPasteMode: false } },
    isBracketedPasteMode: TP.prototype.isBracketedPasteMode,
    pasteOptions: TP.prototype.pasteOptions,
    _sendPastePayload: TP.prototype._sendPastePayload,
    _confirmMultilinePaste: TP.prototype._confirmMultilinePaste,
    _dismissPasteConfirm: TP.prototype._dismissPasteConfirm,
    _pasteConfirmEl: null,
    paneEl: null,
    _getOwnedContainer: () => null,
    focus: () => {},
  }, overrides || {});
}

check('executed: a single-line paste to an unbracketed shell sends the plain text', () => {
  const pane = makePane();
  pane._sendPastePayload('echo hello');
  assert.strictEqual(pane.sent.length, 1);
  assert.deepStrictEqual(pane.sent[0], { type: 'input', data: 'echo hello' });
});

check('executed: a CRLF two-line paste to an AGENT pane sends one bracketed payload', () => {
  const pane = makePane({ term: { modes: { bracketedPasteMode: true } } });
  pane._sendPastePayload('first\r\nsecond');
  assert.strictEqual(pane.sent.length, 1, 'exactly one frame goes on the wire');
  assert.strictEqual(pane.sent[0].data, START + 'first\rsecond' + END);
  assert.strictEqual((pane.sent[0].data.match(/\r/g) || []).length, 1,
    'ONE Enter, which is the whole of defect D2');
});

check('executed: a multi-line paste to a bare shell does NOT reach the socket unanswered', () => {
  // No pane element and no document in this sandbox, so the dialog cannot be
  // built. The documented degradation is to SEND rather than to swallow the
  // user's clipboard silently, and this pins that choice.
  const pane = makePane();
  pane._sendPastePayload('one\ntwo');
  assert.strictEqual(pane.sent.length, 1, 'with no surface to ask on, the paste is delivered rather than lost');
  assert.strictEqual(pane.sent[0].data, 'one\rtwo');
});

check('executed: a closed socket drops the paste instead of throwing', () => {
  const pane = makePane({ ws: { readyState: 3, send: () => { throw new Error('socket is closed'); } } });
  pane._sendPastePayload('echo hello');
  assert.strictEqual(pane.sent.length, 0);
});

check('executed: a missing socket drops the paste instead of throwing', () => {
  const pane = makePane({ ws: null });
  pane._sendPastePayload('echo hello');
  assert.strictEqual(pane.sent.length, 0);
});

/* ============================================================
   8. Source-level wiring: all three entry points really route here
   ============================================================ */

/**
 * Extract a balanced-brace block starting at an anchor, the same idiom
 * terminal-select-v2.test.js uses.
 *
 * @param {string} src - Source text.
 * @param {string} anchor - Literal that starts the block.
 * @returns {string} The block including both braces.
 */
function extractBlock(src, anchor) {
  const idx = src.indexOf(anchor);
  assert.notStrictEqual(idx, -1, 'anchor not found: ' + anchor);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  throw new Error('unbalanced block for anchor: ' + anchor);
}

check('all THREE paste entry points route through prepareInputForPty', () => {
  const beforeInput = extractBlock(termSrc, "if (e.inputType === 'insertFromPaste') {");
  assert.ok(/_sendPastePayload\(/.test(beforeInput),
    'the beforeinput paste path must route through the shared preparation');
  const pasteEvent = extractBlock(termSrc, "xtermTextarea.addEventListener('paste'");
  assert.ok(/_sendPastePayload\(/.test(pasteEvent),
    'the native paste event must route through the shared preparation');
  const menuPaste = extractBlock(termSrc, 'async pasteFromClipboard() {');
  assert.ok(/prepareInputForPty\(/.test(menuPaste),
    'the explicit Paste action must route through the shared preparation');
});

check('NO paste path builds its own bracketed string any more', () => {
  // Scoped rather than a whole-file grep: the header comment above
  // prepareInputForPty QUOTES the two lines it replaced, which is the record of
  // what the defect looked like and must survive. What must not survive is a
  // live call site that still frames its own payload.
  for (const anchor of [
    "if (e.inputType === 'insertFromPaste') {",
    "xtermTextarea.addEventListener('paste'",
    'async pasteFromClipboard() {',
  ]) {
    const block = extractBlock(termSrc, anchor);
    assert.strictEqual(/const bracketedText\s*=/.test(block), false,
      'the hand-rolled bracket builder is what D1 and D2 lived in; one function owns the framing now: ' + anchor);
    assert.strictEqual(/\\x1b\[200~/.test(block), false,
      'no paste entry point may name the marker directly any more: ' + anchor);
  }
});

check('the explicit Paste action still sends on THIS pane socket', () => {
  const menuPaste = extractBlock(termSrc, 'async pasteFromClipboard() {');
  assert.ok(/this\.ws\.send\(/.test(menuPaste),
    'the per-instance socket send must stay inside the method body, not move behind a helper');
  // The property bracketed-paste-isolation.test.js actually gates, asserted
  // here in its own words so a refactor that satisfied one and broke the other
  // is impossible.
  assert.ok(/pasteFromClipboard[\s\S]{0,400}?this\.ws\.send\(/.test(termSrc),
    'the isolation gate reads a 400 character window; keep the body compact');
});

check('the bracket gate reads a LIVE mode rather than a constant', () => {
  const reader = extractBlock(termSrc, 'isBracketedPasteMode() {');
  assert.ok(/term\.modes/.test(reader), "xterm's public IModes reader must be consulted");
  assert.ok(/_remoteBracketedPaste/.test(reader), "the server's mode frame must be consulted");
  assert.ok(/return false/.test(reader), 'the safe default must be NOT bracketing');
});

console.log('  ' + '-'.repeat(58));
console.log('  [paste-input-preparation] ' + passed + '/' + (passed + failed) + ' tests passed');
process.exit(failed > 0 ? 1 : 0);
