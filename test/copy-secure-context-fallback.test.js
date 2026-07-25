#!/usr/bin/env node
/**
 * Ctrl+C copy SIGINT regression gate (user report, 2026-07-24).
 * Modified: 2026-07-25
 *
 * The bug: the Ctrl+C branch of TerminalPane.attachCustomKeyEventHandler
 * called navigator.clipboard.writeText(...).catch(() => {}) directly. On an
 * insecure origin (plain http to a LAN IP or hostname, the documented
 * remote-access mode) navigator.clipboard is undefined, so the property
 * access threw a SYNCHRONOUS TypeError that .catch() could never intercept
 * (.catch only sees promise rejections, not a throw during property lookup).
 * The exception escaped the handler BEFORE clearSelection() and
 * `return false` executed, xterm treated the key as unhandled, and the
 * "copy" keystroke sent \x03 (SIGINT) that interrupted the user's running
 * CLI session. The copy itself also failed. Same secure-context trap as
 * paste issue #64, whose fix guarded the Ctrl+V branch but was never
 * applied to Ctrl+C.
 *
 * The fix under test:
 *   1. TerminalPane.copyTextToClipboard: feature-detects the writeText
 *      FUNCTION (not just the object) and otherwise copies through a
 *      temporary offscreen textarea + document.execCommand('copy'), which
 *      unlike programmatic paste is still permitted from script during a
 *      user gesture on every origin. Cleanup always runs in a finally.
 *      The helper never throws and its promise never rejects.
 *   2. The Ctrl+C branch routes through the helper inside a try/catch
 *      bracket so it ALWAYS reaches `return false` once a selection exists;
 *      the SIGINT fall-through is structurally impossible. It clears only
 *      after a successful copy; failure retains the selection and dispatches
 *      cwm:copy-unavailable for truthful user feedback.
 *   3. Every writeText call site in app.js routes through the helper (or
 *      the _copyWithToast wrapper); zero bare calls remain.
 *
 * Two layers of checks:
 *   - Source gates in the style of paste-secure-context-fallback.test.js
 *     (read the sources as text, string-match the load-bearing surface).
 *   - EXECUTED proofs: terminal.js is evaluated in a vm sandbox and the real
 *     extracted Ctrl+C branch is run with navigator.clipboard undefined,
 *     proving the branch still returns false (consumes the key, no SIGINT)
 *     and the text still lands on the stub clipboard via the execCommand
 *     fallback. This is what makes the gate non-vacuous.
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
 * `if (mod && e.key === 'c'` anchor through that branch's `return false;`.
 * The leading WHY comment block sits ABOVE the anchor on purpose, so this
 * window contains only executable branch code (plus its inline comments),
 * which keeps the no-navigator.clipboard assertion exact.
 * @returns {string} The Ctrl+C branch source text (if-header through the
 *   branch's return false, without the closing brace of the if).
 */
function extractCtrlCBranch() {
  const anchor = "if (mod && e.key === 'c'";
  const start = termSrc.indexOf(anchor);
  assert.ok(start !== -1, "could not locate the Ctrl+C branch anchor (if (mod && e.key === 'c')");
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
  const harnessSrc = '(function (e, mod) {\n' + branch + '\n}\n  return "fell-through-to-SIGINT";\n})';
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

  await check('Ctrl+C branch routes through TerminalPane.copyTextToClipboard', () => {
    const branch = extractCtrlCBranch();
    assert.ok(
      /copyTextToClipboard/.test(branch),
      'the Ctrl+C branch must copy through the shared universal helper'
    );
  });

  await check('Ctrl+C branch is structurally exception-proof (try before copy, catch before return false)', () => {
    const branch = extractCtrlCBranch();
    const tryIdx = branch.search(/try\s*\{/);
    const selectionIdx = branch.indexOf('const selectedText = this.term.getSelection()');
    const copyIdx = branch.indexOf('copyTextToClipboard');
    const catchIdx = branch.search(/catch\s*\(/);
    const retIdx = branch.lastIndexOf('return false;');
    const preventIdx = branch.indexOf('e.preventDefault()');
    assert.ok(tryIdx !== -1, 'branch must open a try block');
    assert.ok(catchIdx !== -1, 'branch must have a catch clause');
    assert.ok(preventIdx !== -1, 'selected Ctrl+C must cancel the browser native copy action');
    assert.ok(tryIdx < preventIdx && preventIdx < copyIdx,
      'preventDefault must run inside the selected branch before the custom clipboard helper');
    assert.ok(tryIdx < selectionIdx, 'selection extraction must sit INSIDE the try block');
    assert.ok(selectionIdx < copyIdx, 'the exact selection must be captured before the async copy');
    assert.ok(tryIdx < copyIdx, 'the copy call must sit INSIDE the try block');
    assert.ok(copyIdx < catchIdx, 'catch must close over the copy call');
    assert.ok(catchIdx < retIdx, 'return false must come AFTER the catch, outside the bracket, so it always executes');
    const protectedRegion = branch.slice(tryIdx, catchIdx);
    assert.ok(/clearSelection/.test(protectedRegion),
      'successful copy must still clear the selection inside the exception bracket');
    assert.ok(/if\s*\(\s*copied\s*\)/.test(protectedRegion),
      'clearSelection must be gated on the helper reporting success');
    assert.ok(/_emitCopyUnavailable\('failed'\)/.test(branch),
      'clipboard failure must dispatch a truthful user-visible notification');
    assert.ok(/_selectionPositionKey/.test(branch),
      'async success must compare the exact xterm selection range, not text alone');
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

  await check('app.js surfaces cwm:copy-unavailable and says the selection was kept', () => {
    const idx = appSrc.indexOf("document.addEventListener('cwm:copy-unavailable'");
    assert.ok(idx !== -1, 'app.js must listen for Ctrl+C clipboard failures');
    const body = appSrc.slice(idx, idx + 650);
    assert.ok(/Selection kept/.test(body), 'the failure toast must tell the user the selection remains available');
    assert.ok(/showToast\([^;]+,\s*'error'\)/s.test(body), 'clipboard failure must use an error toast');
  });

  await check('index.html cache-busts the changed app.js copy-failure listener', () => {
    assert.ok(
      /app\.js\?v=20260725-copytruth/.test(indexSrc),
      'the changed app.js must not reuse a stale unversioned browser cache entry'
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

  await check('helper: secure context uses writeText and resolves true without touching execCommand', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    const written = [];
    sandbox.navigator = { clipboard: { writeText(v) { written.push(v); return Promise.resolve(); } } };
    const { doc, record } = makeStubDocument();
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('secure path');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(written, ['secure path'], 'writeText must receive the text on secure origins (behavior unchanged)');
    assert.strictEqual(record.execCalls.length, 0, 'fallback must not run when writeText succeeded');
  });

  await check('helper: writeText REJECTION falls back to execCommand instead of failing', async () => {
    const { sandbox, TerminalPane } = loadTerminalPane();
    sandbox.navigator = { clipboard: { writeText() { return Promise.reject(new Error('NotAllowedError')); } } };
    const { doc, record } = makeStubDocument();
    sandbox.document = doc;
    const ok = await TerminalPane.copyTextToClipboard('denied then rescued');
    assert.strictEqual(ok, true, 'a permission denial should still copy via the gesture fallback');
    assert.deepStrictEqual(record.copiedValues, ['denied then rescued']);
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
  // (5) Executed proofs: the REAL Ctrl+C branch, insecure origin
  // -------------------------------------------------------------------------

  await check('REAL branch: navigator.clipboard undefined still returns false (key consumed, no SIGINT) and copies the selection', async () => {
    const { sandbox, context } = loadTerminalPane();
    delete sandbox.navigator; // the user-reported environment: plain http over LAN
    const { doc, record } = makeStubDocument();
    sandbox.document = doc;
    const harness = compileCtrlCHarness(context);
    let cleared = 0;
    let prevented = 0;
    const thisStub = {
      term: {
        hasSelection: () => true,
        getSelection: () => 'SELECTED TEXT',
        clearSelection: () => { cleared++; },
      },
    };
    // With the OLD code this call THREW (TypeError on the property access)
    // before return false, which is exactly how Ctrl+C reached the PTY as
    // SIGINT. The assertion set below is therefore the whole bug in one run.
    const result = harness.call(thisStub, {
      type: 'keydown',
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => { prevented++; },
    }, true);
    assert.strictEqual(result, false, 'branch must consume the key (return false); anything else falls through to SIGINT');
    assert.strictEqual(prevented, 1, 'selected Ctrl+C must suppress the browser native copy path exactly once');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(cleared, 1, 'clearSelection must still run');
    assert.deepStrictEqual(record.copiedValues, ['SELECTED TEXT'], 'the selection must actually land on the (stub) clipboard via the fallback');
  });

  await check('REAL branch: failed copy keeps selection, reports failure, and still consumes Ctrl+C', async () => {
    const { sandbox, context } = loadTerminalPane();
    delete sandbox.navigator;
    delete sandbox.document; // scorched earth: every copy path unavailable
    const harness = compileCtrlCHarness(context);
    let cleared = 0;
    let prevented = 0;
    const notifications = [];
    const thisStub = {
      term: {
        hasSelection: () => true,
        getSelection: () => 'RECOVERABLE SELECTION',
        clearSelection: () => { cleared++; },
      },
      _emitCopyUnavailable: (reason) => { notifications.push(reason); },
    };
    const result = harness.call(thisStub, {
      type: 'keydown',
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => { prevented++; },
    }, true);
    assert.strictEqual(result, false, 'the copy may fail, consuming the key may not');
    assert.strictEqual(prevented, 1, 'failed selected Ctrl+C must still cancel the native copy path');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(cleared, 0, 'a failed copy must keep the selection so the user can recover it');
    assert.deepStrictEqual(notifications, ['failed'], 'failed copy must emit exactly one notification');
  });

  await check('REAL branch: async success does not clear a newer equal-text selection at another range', async () => {
    const { sandbox, context, TerminalPane } = loadTerminalPane();
    let resolveCopy;
    TerminalPane.copyTextToClipboard = () => new Promise((resolve) => { resolveCopy = resolve; });
    sandbox.navigator = {};
    const harness = compileCtrlCHarness(context);
    let cleared = 0;
    let position = {
      start: { x: 1, y: 2 },
      end: { x: 5, y: 2 },
    };
    const thisStub = {
      term: {
        hasSelection: () => true,
        getSelection: () => 'SAME',
        getSelectionPosition: () => position,
        clearSelection: () => { cleared++; },
      },
      _emitCopyUnavailable: () => {},
    };
    const result = harness.call(thisStub, { type: 'keydown', key: 'c', ctrlKey: true, metaKey: false }, true);
    assert.strictEqual(result, false, 'selected Ctrl+C must be consumed while the copy is pending');
    position = {
      start: { x: 12, y: 8 },
      end: { x: 16, y: 8 },
    };
    resolveCopy(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(cleared, 0, 'equal text at a newer range must remain selected');
  });

  await check('REAL branch: no selection still falls through (plain Ctrl+C SIGINT preserved)', async () => {
    const { sandbox, context } = loadTerminalPane();
    delete sandbox.navigator;
    const harness = compileCtrlCHarness(context);
    let prevented = 0;
    const thisStub = {
      term: { hasSelection: () => false, getSelection: () => '', clearSelection: () => {} },
    };
    const result = harness.call(thisStub, {
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
