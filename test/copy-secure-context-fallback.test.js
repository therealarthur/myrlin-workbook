#!/usr/bin/env node
/**
 * Ctrl+C copy SIGINT regression gate (user report, 2026-07-24).
 * Modified: 2026-07-25
 *
 * The original bug was an exception-prone async Clipboard API call inside the
 * terminal key handler. A later fallback still canceled Chromium's trusted
 * copy event with preventDefault(), so embedded browsers that denied
 * navigator.clipboard.writeText could not use xterm's synchronous native copy
 * handler even though that handler remained permitted.
 *
 * The fix under test has two deliberately separate paths:
 *   1. Keyboard Ctrl+C/Cmd+C asks getCopySelection(). When selected, it
 *      returns false to xterm's key pipeline so ETX/SIGINT cannot reach the
 *      PTY, but does not preventDefault, invoke an async helper, or clear the
 *      selection. Chromium therefore dispatches the trusted `copy` event and
 *      xterm synchronously fills ClipboardEvent.clipboardData.
 *   2. Explicit menu/button copy actions still use
 *      TerminalPane.copyTextToClipboard. That helper feature-detects
 *      navigator.clipboard.writeText and falls back to an offscreen textarea
 *      plus document.execCommand('copy') on insecure origins or permission
 *      denial. It never throws or rejects.
 *   3. Every writeText call site in app.js routes through that explicit-action
 *      helper (or _copyWithToast); zero bare calls remain.
 *
 * Two layers of checks:
 *   - Source gates in the style of paste-secure-context-fallback.test.js
 *     (read the sources as text, string-match the load-bearing surface).
 *   - EXECUTED proofs: terminal.js is evaluated in a vm sandbox and the real
 *     extracted Ctrl+C branch is run with xterm and DOM selections, proving it
 *     consumes selected keys without touching the permission-gated helper or
 *     canceling the browser default. Real clipboard contents are verified in
 *     terminal-interaction.test.js using Chromium's trusted event.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const TERMINAL_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js');
const APP_JS_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'index.html');
const termSrc = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
const indexSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

let passed = 0;
let failed = 0;

/**
 * Run a single named check (sync or async), tracking pass/fail counts and
 * printing a line. Async-aware variant of the tiny runner used by
 * paste-secure-context-fallback.test.js: the executed vm proofs below await
 * the helper's returned promise, so the body may be an async function.
 * @param {string} name - Human-readable assertion name.
 * @param {Function} fn - Body that throws (or rejects) on failure.
 */
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : String(err)));
  }
}

/**
 * Slice out the Ctrl+C/Cmd+C branch from terminal.js source: from the
 * `if (mod && shortcutKey === 'c'` anchor through that branch's `return false;`.
 * The leading WHY comment block sits ABOVE the anchor on purpose, so this
 * window contains only executable branch code (plus its inline comments),
 * which keeps the no-navigator.clipboard assertion exact.
 * @returns {string} The Ctrl+C branch source text (if-header through the
 *   branch's return false, without the closing brace of the if).
 */
function extractCtrlCBranch() {
  const anchor = "if (mod && shortcutKey === 'c'";
  const start = termSrc.indexOf(anchor);
  assert.ok(start !== -1, "could not locate the Ctrl+C branch anchor (if (mod && shortcutKey === 'c')");
  const after = termSrc.slice(start);
  const endToken = 'return false;';
  const endIdx = after.indexOf(endToken);
  assert.ok(endIdx !== -1, 'Ctrl+C branch has no return false; terminator');
  return after.slice(0, endIdx + endToken.length);
}

/**
 * Evaluate terminal.js inside a fresh vm context and hand back both the
 * contextified sandbox (mutate it to stub navigator/document per scenario)
 * and the real TerminalPane class compiled in that context. Global lookups
 * inside TerminalPane methods resolve against this sandbox at CALL time, so
 * deleting sandbox.navigator faithfully reproduces an insecure origin.
 * @returns {{sandbox: Object, context: Object, TerminalPane: Function}}
 */
function loadTerminalPane() {
  const sandbox = { window: {}, console };
  const context = vm.createContext(sandbox);
  vm.runInContext(termSrc, context, { filename: 'terminal.js' });
  const TP = vm.runInContext('TerminalPane', context);
  assert.ok(typeof TP === 'function', 'TerminalPane class did not evaluate in the vm sandbox');
  return { sandbox, context, TerminalPane: TP };
}

/**
 * Build a minimal stub document sufficient for _copyViaExecCommand: element
 * creation, body append/remove bookkeeping, selection stubs, and an
 * execCommand that records what text was selected in the scratch textarea
 * at copy time (the observable "clipboard").
 * @param {Object} [opts] - { execThrows, execFails } failure injection.
 * @returns {{doc: Object, record: Object}} The stub and its call record.
 */
function makeStubDocument(opts) {
  const record = { execCalls: [], copiedValues: [], appended: [], removed: [] };
  const body = {
    children: [],
    appendChild(el) { el.parentNode = body; body.children.push(el); record.appended.push(el); },
    removeChild(el) {
      const i = body.children.indexOf(el);
      if (i !== -1) body.children.splice(i, 1);
      el.parentNode = null;
      record.removed.push(el);
    },
    focus() {},
  };
  const doc = {
    body,
    activeElement: body,
    createElement(tag) {
      return {
        tagName: tag,
        value: '',
        style: {},
        parentNode: null,
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
      };
    },
    getSelection() { return { rangeCount: 0, removeAllRanges() {}, addRange() {} }; },
    execCommand(cmd) {
      record.execCalls.push(cmd);
      if (opts && opts.execThrows) throw new Error('execCommand blocked');
      const ta = body.children[body.children.length - 1];
      record.copiedValues.push(ta ? ta.value : null);
      if (opts && Array.isArray(opts.execResults) && opts.execResults.length > 0) {
        return opts.execResults.shift();
      }
      return !(opts && opts.execFails);
    },
  };
  return { doc, record };
}

/**
 * Compile the REAL extracted Ctrl+C branch into a callable harness function
 * inside the given vm context, so the branch's TerminalPane reference
 * resolves to the class compiled from the actual source. Returns a function
 * (e, mod) invoked with a stub `this.term`; it returns false when the branch
 * consumed the key or the sentinel string when execution fell through
 * (which in production means xterm sends \x03 SIGINT).
 * @param {Object} context - The vm context terminal.js was evaluated in.
 * @returns {Function} The compiled harness.
 */
function compileCtrlCHarness(context) {
  const branch = extractCtrlCBranch();
  const harnessSrc = '(function (e, mod) {\n' +
    "const shortcutKey = typeof e.key === 'string' ? e.key.toLowerCase() : '';\n" +
    branch + '\n}\n  return "fell-through-to-SIGINT";\n})';
  return vm.runInContext(harnessSrc, context, { filename: 'ctrl-c-branch-harness.js' });
}

console.log('\n  Ctrl+C copy SIGINT fix: secure-context copy gate');
console.log('  ' + '-'.repeat(58));

/**
 * Top-level async runner so the executed vm proofs can await the helper's
 * promise. Exits with the aggregate pass/fail status, matching the exit
 * discipline of the sibling standalone tests.
 */
async function main() {

  // -------------------------------------------------------------------------
  // (1) Source gates: the Ctrl+C branch shape
  // -------------------------------------------------------------------------

  await check('Ctrl+C branch no longer touches navigator.clipboard directly', () => {
    const branch = extractCtrlCBranch();
    assert.ok(
      !/navigator\.clipboard/.test(branch),
      'the Ctrl+C branch must not reference navigator.clipboard; a bare property access throws a synchronous TypeError on insecure origins and falls through to SIGINT'
    );
  });

  await check('Ctrl+C branch reads the pane-scoped copy selection', () => {
    const branch = extractCtrlCBranch();
    assert.ok(
      /const copySelection = this\.getCopySelection\(\)/.test(branch),
      'the Ctrl+C branch must read xterm/native DOM selection through getCopySelection'
    );
    assert.ok(/copySelection\.hasSelection\)\s*return false/.test(branch),
      'a selected shortcut must return false before xterm can send ETX');
  });

  await check('copy/paste shortcuts normalize KeyboardEvent.key before safety branches', () => {
    assert.ok(
      /const shortcutKey = typeof e\.key === 'string' \? e\.key\.toLowerCase\(\) : ''/.test(termSrc),
      'KeyboardEvent.key must be normalized so Caps Lock/Shift cannot bypass Ctrl+C or Ctrl+V handling'
    );
    assert.ok(
      /if \(mod && shortcutKey === 'c'/.test(extractCtrlCBranch()),
      'the selected-copy branch must compare the normalized shortcut key'
    );
  });

  await check('Ctrl+C leaves Chromium native copy enabled and selection intact', () => {
    const branch = extractCtrlCBranch();
    assert.ok(!/preventDefault/.test(branch),
      'preventDefault would disable Chromium/xterm trusted native copy');
    assert.ok(!/copyTextToClipboard/.test(branch),
      'keyboard copy must not depend on navigator.clipboard permission');
    assert.ok(!/clearSelection/.test(branch),
      'native copy keeps selection visible for retry and right-click');
    assert.ok(!/_emitCopyUnavailable/.test(branch),
      'native copy is synchronous browser behavior, not an async helper result');
  });

  // -------------------------------------------------------------------------
  // (2) Source gates: the helper
  // -------------------------------------------------------------------------

  await check('copyTextToClipboard feature-detects the writeText FUNCTION, not just the object', () => {
    const start = termSrc.indexOf('static copyTextToClipboard');
    const end = termSrc.indexOf('static _copyViaExecCommand');
    assert.ok(start !== -1, 'static copyTextToClipboard not found in terminal.js');
    assert.ok(end !== -1 && end > start, 'static _copyViaExecCommand must follow copyTextToClipboard');
    const body = termSrc.slice(start, end);
    assert.ok(
      /typeof navigator\.clipboard\.writeText === 'function'/.test(body),
      "helper must check typeof navigator.clipboard.writeText === 'function' (an object check alone reintroduces the throw)"
    );
    assert.ok(/_copyViaExecCommand/.test(body), 'helper must fall back to _copyViaExecCommand');
    assert.ok(
      body.indexOf('_copyViaExecCommand') < body.indexOf('navigator.clipboard.writeText'),
      'gesture-preserving execCommand copy must run before awaiting the Clipboard API'
    );
  });

  await check('_copyViaExecCommand uses execCommand(copy) with cleanup in a finally', () => {
    const start = termSrc.indexOf('static _copyViaExecCommand');
    assert.ok(start !== -1, 'static _copyViaExecCommand not found');
    const body = termSrc.slice(start, start + 3200);
    assert.ok(/execCommand\('copy'\)/.test(body), 'fallback must call document.execCommand(copy)');
    const finallyIdx = body.search(/finally\s*\{/);
    assert.ok(finallyIdx !== -1, 'fallback must have a finally block');
    const finallyRegion = body.slice(finallyIdx);
    assert.ok(
      /removeChild/.test(finallyRegion),
      'the scratch textarea must be removed inside the finally so failed copies never leak DOM nodes'
    );
  });

  // -------------------------------------------------------------------------
  // (3) Source gates: app.js sweep
  // -------------------------------------------------------------------------

  await check('app.js contains ZERO bare navigator.clipboard.writeText( call sites', () => {
    const matches = appSrc.match(/navigator\.clipboard\.writeText\(/g) || [];
    assert.strictEqual(
      matches.length,
      0,
      'found ' + matches.length + ' bare writeText call site(s) in app.js; every copy must route through TerminalPane.copyTextToClipboard (or _copyWithToast), which cannot throw into the caller on insecure origins'
    );
  });

  await check('app.js _copyWithToast wrapper exists and routes through the helper', () => {
    const idx = appSrc.indexOf('_copyWithToast(text, successMessage, failureMessage)');
    assert.ok(idx !== -1, '_copyWithToast method not found in app.js');
    const body = appSrc.slice(idx, idx + 700);
    assert.ok(/TerminalPane\.copyTextToClipboard/.test(body), '_copyWithToast must delegate to TerminalPane.copyTextToClipboard');
    assert.ok(/showToast\(successMessage, 'success'\)/.test(body), '_copyWithToast must keep the success toast');
    assert.ok(/'error'/.test(body), '_copyWithToast must toast failures');
  });

  await check('mobile Copy prefers pane-scoped DOM/xterm selection before the full buffer', () => {
    const start = appSrc.indexOf("if (key === 'copy') {");
    const end = appSrc.indexOf('// Full-screen reader overlay', start);
    const body = start >= 0 && end > start ? appSrc.slice(start, end) : '';
    assert.ok(body, 'mobile Copy branch not found');
    const selectionIdx = body.indexOf('activePane.getCopySelection');
    const bufferIdx = body.indexOf('activePane.term.buffer.active');
    assert.ok(selectionIdx >= 0, 'mobile Copy must use getCopySelection');
    assert.ok(bufferIdx > selectionIdx,
      'full-buffer copy may run only after pane-scoped selection reports none');
  });

  await check('index.html cache-busts the changed native-copy scripts', () => {
    assert.ok(
      /terminal\.js\?v=20260725-copy-native5/.test(indexSrc) &&
        /app\.js\?v=20260725-copy-native5/.test(indexSrc),
      'native-copy and pane-event fixes must not reuse stale browser cache entries'
    );
  });

  // -------------------------------------------------------------------------
  // (4) Executed proofs: the helper, in a vm sandbox
  // -------------------------------------------------------------------------

  await check('helper: insecure origin (no navigator) copies via execCommand fallback', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    delete sandbox.navigator; // insecure origin: navigator.clipboard path gone entirely
    const { doc, record } = makeStubDocument();
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('hello over plain http');
    assert.strictEqual(ok, true, 'copy must succeed through the fallback');
    assert.deepStrictEqual(record.execCalls, ['copy'], 'execCommand(copy) must run exactly once');
    assert.strictEqual(record.copiedValues[0], 'hello over plain http', 'the fallback textarea must hold the exact text at copy time');
    assert.strictEqual(doc.body.children.length, 0, 'the scratch textarea must be removed after the copy');
  });

  await check('helper: clipboard OBJECT without writeText still uses the fallback (function detect)', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    sandbox.navigator = { clipboard: {} }; // object exists, function does not
    const { doc, record } = makeStubDocument();
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('detect the function');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(record.execCalls, ['copy']);
  });

  await check('helper: trusted click prefers synchronous copy before the async API', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    const written = [];
    sandbox.navigator = { clipboard: { writeText(v) { written.push(v); return Promise.resolve(); } } };
    const { doc, record } = makeStubDocument();
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('secure path');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(record.copiedValues, ['secure path']);
    assert.deepStrictEqual(written, [], 'successful synchronous copy must preserve the gesture and skip writeText');
  });

  await check('helper: secure context uses writeText when synchronous copy is unavailable', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    const written = [];
    sandbox.navigator = { clipboard: { writeText(v) { written.push(v); return Promise.resolve(); } } };
    const { doc, record } = makeStubDocument({ execFails: true });
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('async fallback');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(record.execCalls, ['copy']);
    assert.deepStrictEqual(written, ['async fallback']);
  });

  await check('helper: writeText REJECTION falls back to execCommand instead of failing', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    sandbox.navigator = { clipboard: { writeText() { return Promise.reject(new Error('NotAllowedError')); } } };
    const { doc, record } = makeStubDocument({ execResults: [false, true] });
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('denied then rescued');
    assert.strictEqual(ok, true, 'a permission denial should still copy via the gesture fallback');
    assert.deepStrictEqual(record.copiedValues, ['denied then rescued', 'denied then rescued']);
  });

  await check('helper: execCommand THROW still cleans up the textarea (finally) and resolves false', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    delete sandbox.navigator;
    const { doc, record } = makeStubDocument({ execThrows: true });
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('will fail');
    assert.strictEqual(ok, false, 'a thrown execCommand must resolve false, never reject or throw');
    assert.strictEqual(record.removed.length, 1, 'the scratch textarea must STILL be removed when execCommand throws');
    assert.strictEqual(doc.body.children.length, 0, 'no leaked textarea in the DOM');
  });

  await check('helper: no navigator AND no document resolves false without throwing', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    delete sandbox.navigator;
    delete sandbox.document;
    const ok = await TerminalPane.copyTextToClipboard('nowhere to go');
    assert.strictEqual(ok, false);
  });

  // -------------------------------------------------------------------------
  // (5) Executed proofs: the REAL Ctrl+C native-copy branch
  // -------------------------------------------------------------------------

  await check('REAL branch: xterm selection consumes Ctrl+C without canceling native copy', () => {
    const { sandbox, context, TerminalPane } = loadTerminalPane();
    delete sandbox.navigator; // insecure origin: keyboard copy must not care
    let helperCalls = 0;
    let cleared = 0;
    let prevented = 0;
    let selectionReads = 0;
    TerminalPane.copyTextToClipboard = () => {
      helperCalls++;
      throw new Error('keyboard copy must never call the explicit-action helper');
    };
    const harness = compileCtrlCHarness(context);
    const result = harness.call({
      term: { clearSelection: () => { cleared++; } },
      getCopySelection: () => {
        selectionReads++;
        return { hasSelection: true, text: 'SELECTED TEXT', source: 'xterm' };
      },
    }, {
      type: 'keydown',
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => { prevented++; },
    }, true);
    assert.strictEqual(result, false, 'selected Ctrl+C must be withheld from ETX/SIGINT');
    assert.strictEqual(selectionReads, 1, 'selection state must be read once');
    assert.strictEqual(prevented, 0, 'Chromium native copy must remain enabled');
    assert.strictEqual(helperCalls, 0, 'keyboard copy must bypass the async helper');
    assert.strictEqual(cleared, 0, 'native copy must retain the selection');
  });

  await check('REAL branch: uppercase Ctrl+C and native DOM selection are consumed safely', () => {
    const { sandbox, context, TerminalPane } = loadTerminalPane();
    delete sandbox.navigator;
    let helperCalls = 0;
    let prevented = 0;
    TerminalPane.copyTextToClipboard = () => { helperCalls++; return Promise.resolve(false); };
    const harness = compileCtrlCHarness(context);
    const result = harness.call({
      getCopySelection: () => ({
        hasSelection: true,
        text: 'VISIBLE DOM SELECTION',
        source: 'dom',
      }),
    }, {
      type: 'keydown',
      key: 'C',
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      preventDefault: () => { prevented++; },
    }, true);
    assert.strictEqual(result, false, 'uppercase selected Ctrl+C must be consumed');
    assert.strictEqual(prevented, 0, 'uppercase copy must preserve the native default');
    assert.strictEqual(helperCalls, 0, 'DOM-selection keyboard copy must remain native');
  });

  await check('REAL branch: no selection still falls through (plain Ctrl+C SIGINT preserved)', () => {
    const { sandbox, context } = loadTerminalPane();
    delete sandbox.navigator;
    const harness = compileCtrlCHarness(context);
    let prevented = 0;
    const result = harness.call({
      getCopySelection: () => ({ hasSelection: false, text: '', source: null }),
    }, {
      type: 'keydown',
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => { prevented++; },
    }, true);
    assert.strictEqual(result, 'fell-through-to-SIGINT',
      'without a selection the branch must NOT consume the key; Ctrl+C must still interrupt the CLI');
    assert.strictEqual(prevented, 0, 'plain Ctrl+C must not cancel the terminal SIGINT path');
  });

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  console.log('  ' + '-'.repeat(58));
  console.log('  [copy-secure-context-fallback] ' + passed + '/' + (passed + failed) + ' tests passed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('  \x1b[31mFATAL\x1b[0m ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
