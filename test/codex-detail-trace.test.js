#!/usr/bin/env node
/**
 * Round 2 gate: Codex session details trace end to end, and are true.
 *
 * THE REPORT. "make sure the codex details actually trace properly and show
 * accurate values to change AND accurately does so and reflects everything
 * properly."
 *
 * WHAT THE TRACE FOUND, measured against the 128 real threads on the machine
 * that filed the report (read-only, through the provider's own reader):
 *
 *   LAYER 1  src/providers/codex/state-db.js reads the truth per thread:
 *            model, modelProvider, reasoningEffort, approvalMode,
 *            sandboxPolicy, tokensUsed, gitBranch, gitSha, cliVersion.
 *   LAYER 2  provider.discover() carries all nine. Verified live: every one
 *            of the nine keys is present on the returned ProviderSession.
 *   LAYER 3  server.js groupProviderSessionsForUI DROPPED all nine. The
 *            payload the sidebar and the pane strip consume carried eight
 *            fields, none of them configuration.
 *   LAYER 4  With nothing to render, the status strip invented four values:
 *            'gpt-5-codex', 'workspace-write', 'on-request', 'medium'. Not
 *            one of those four strings occurs in ANY of the 128 threads. The
 *            app was stating a configuration no session was running.
 *   EDIT     The menu's option catalogs claimed in a comment to "mirror
 *            backend allow-lists" and did not. Models offered: gpt-5-codex,
 *            gpt-5, o3, which occur zero times between them; models in use:
 *            gpt-5.6-sol 66, gpt-5.5 43, codex-auto-review 17, gpt-5.6-terra
 *            1, gpt-5.4 1. Efforts offered stopped at 'high'; 81 of 128
 *            threads run ultra, xhigh or max, so their effort could not be
 *            named by the UI at all, let alone restored.
 *   SHAPE    sandbox_policy is a JSON STRUCT, not a scalar:
 *            {"type":"disabled"} 58, {"type":"managed",...} 34,
 *            {"type":"danger-full-access"} 33, {"type":"workspace-write",
 *            "writable_roots":[...]} 3. Rendering it raw prints JSON, and
 *            absolute writable roots, into a status chip.
 *
 * This file locks the whole chain: the payload carries the fields, the
 * normaliser reduces the struct, the UI resolves override > observed > unset
 * and never invents, the option catalogs equal the spawn-time allow-lists,
 * and an edited setting assembles into the argv the next spawn runs.
 *
 * Hermetic: no ~/.codex read, no server boot. The distributions above are
 * evidence recorded in prose; the assertions run against fixtures.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
const spawnMod = require(path.join(ROOT, 'src', 'providers', 'codex', 'spawn.js'));

let passed = 0;
let failed = 0;
const queue = [];

/**
 * Register a named assertion.
 *
 * @param {string} name Human-readable test name.
 * @param {() => void} fn Function that throws on failure.
 */
function check(name, fn) {
  queue.push({ name, fn });
}

function runQueue() {
  for (const { name, fn } of queue) {
    try {
      fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + err.message + '\x1b[0m');
    }
  }
}

/**
 * Evaluate a named helper out of server.js on a bare object.
 *
 * server.js builds an Express app at require time, so it cannot be required
 * from a unit test. The two helpers under test are pure, so they are extracted
 * by brace matching and evaluated standalone, the same technique the provider
 * tab gates use on app.js.
 *
 * @param {string} declaration Exact function declaration line prefix.
 * @returns {Function} The extracted function.
 */
function extractServerFn(declaration) {
  // Sliced between two stable textual boundaries rather than by counting
  // braces. Brace counting is wrong here for a concrete reason: the normaliser
  // tests `trimmed[0] !== '{'`, and a naive counter reads that quoted brace as
  // a nesting level it never closes. The block between these two markers holds
  // exactly the constant and the two pure helpers.
  const start = serverSrc.indexOf('const PROVIDER_DETAIL_FIELDS');
  const end = serverSrc.indexOf('function groupProviderSessionsForUI(sessions, provider) {');
  assert.ok(start > -1 && end > start, 'the provider detail helpers were not found in server.js');
  const block = serverSrc.slice(start, end);
  const name = declaration.replace(/^function\s+/, '').split('(')[0];
  assert.ok(block.includes(declaration), declaration + ' not found in the helper block');
  // eslint-disable-next-line no-new-func
  return new Function(block + '\nreturn ' + name + ';')();
}

/**
 * Pull a `const NAME = [ ... ];` option catalog out of app.js and return its
 * ids, so the drift gate compares data rather than source text.
 *
 * @param {string} name Catalog constant name.
 * @returns {string[]} The option ids in declaration order.
 */
function extractOptionIds(name) {
  const start = appSrc.indexOf('const ' + name + ' = [');
  assert.ok(start > -1, name + ' not found in app.js');
  const end = appSrc.indexOf('];', start);
  assert.ok(end > -1, name + ' is not terminated');
  const body = appSrc.slice(start, end);
  return [...body.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
}

console.log('\n  \x1b[1mRound 2: codex detail trace\x1b[0m');
console.log('  ' + '─'.repeat(42));

// ───────────────────────────────────────────────────────────────────────
// (a) DISPLAY: the payload carries the truth, and the shape is reduced
// ───────────────────────────────────────────────────────────────────────

check('EXECUTED: the discovery payload carries the observed configuration', () => {
  const pick = extractServerFn('function pickProviderDetailFields(session)');
  const out = pick({
    providerSessionId: 'abc',
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    reasoningEffort: 'ultra',
    approvalMode: 'never',
    sandboxPolicy: '{"type":"disabled"}',
    tokensUsed: 6374453522,
    gitBranch: 'master',
    cliVersion: '0.146.0-alpha.9.2',
  });
  assert.strictEqual(out.model, 'gpt-5.6-sol');
  assert.strictEqual(out.reasoningEffort, 'ultra');
  assert.strictEqual(out.approvalMode, 'never');
  assert.strictEqual(out.tokensUsed, 6374453522);
  assert.strictEqual(out.gitBranch, 'master');
  assert.strictEqual(out.cliVersion, '0.146.0-alpha.9.2');
  assert.strictEqual(out.sandboxPolicyType, 'disabled', 'the struct must be reduced for display');
  assert.strictEqual(out.sandboxPolicy, '{"type":"disabled"}', 'the raw policy must survive');
});

check('EXECUTED: absent fields are omitted, so a provider never grows a fake key', () => {
  const pick = extractServerFn('function pickProviderDetailFields(session)');
  // A Claude ProviderSession: none of the codex concepts exist on it.
  const out = pick({ providerSessionId: 'uuid', lastActive: '2026-08-13T00:00:00Z' });
  assert.deepStrictEqual(Object.keys(out), [], 'a Claude record must gain nothing');
  const partial = pick({ model: 'gpt-5.5', gitSha: null, gitBranch: undefined });
  assert.deepStrictEqual(Object.keys(partial), ['model'],
    'null and undefined must be omitted, not carried as empty values');
});

check('EXECUTED: every real sandbox_policy shape reduces to its type', () => {
  const norm = extractServerFn('function normalizeSandboxPolicyType(value)');
  // The four shapes measured across the 128 real threads, plus the edges.
  assert.strictEqual(norm('{"type":"disabled"}'), 'disabled');
  assert.strictEqual(norm('{"type":"danger-full-access"}'), 'danger-full-access');
  assert.strictEqual(
    norm('{"type":"managed","file_system":{"type":"restricted","entries":[]},"network":"restricted"}'),
    'managed',
    'a nested policy must reduce to its OUTER type, not an inner one'
  );
  assert.strictEqual(
    norm('{"type":"workspace-write","writable_roots":["C:\\\\Users\\\\x"],"network_access":false}'),
    'workspace-write',
    'writable roots must never reach the display path'
  );
  assert.strictEqual(norm('workspace-write'), 'workspace-write', 'a bare word is already the type');
  assert.strictEqual(norm({ type: 'managed' }), 'managed', 'an already-parsed object works too');
  assert.strictEqual(norm(null), null);
  assert.strictEqual(norm('{not json'), null, 'malformed input must not throw');
  assert.strictEqual(norm(''), null);
});

check('the strip resolves override, then observed, then unset, and invents nothing', () => {
  const idx = appSrc.indexOf('const observed = this._codexObservedDetail(sessionId, sess);');
  assert.ok(idx > -1, 'the strip must resolve observed detail');
  const body = appSrc.slice(idx, idx + 1800);
  assert.ok(/if \(overrideValue\) return \{ value: overrideValue, source: 'override' \}/.test(body),
    'a user override must win');
  assert.ok(/if \(observedValue\) return \{ value: observedValue, source: 'observed' \}/.test(body),
    'the recorded value must be second');
  assert.ok(/return \{ value: 'unset', source: 'unknown' \}/.test(body),
    'an unknown value must be named as unknown');
  for (const invented of ["'gpt-5-codex'", "settings.sandbox || 'workspace-write'",
    "settings.approvalPolicy || 'on-request'", "settings.reasoningEffort || 'medium'"]) {
    assert.ok(!appSrc.includes('chip(\'model\', \'model\', settings.model || ' + invented),
      'the invented default ' + invented + ' must be gone');
  }
  assert.ok(!/settings\.reasoningEffort \|\| 'medium'/.test(appSrc),
    "the fabricated 'medium' effort default must be gone");
  assert.ok(!/settings\.sandbox \|\| 'workspace-write'/.test(appSrc),
    "the fabricated 'workspace-write' sandbox default must be gone");
});

check('_codexObservedDetail matches a pane by every id a pane can carry', () => {
  const idx = appSrc.indexOf('_codexObservedDetail(sessionId, sess) {');
  assert.ok(idx > -1, '_codexObservedDetail must be declared');
  const body = appSrc.slice(idx, idx + 1800);
  assert.ok(/wanted\.add\(String\(sessionId\)\)/.test(body), 'the pane id must be matched');
  assert.ok(/sess\.resumeSessionId/.test(body), 'a tracked session resumes an upstream id');
  assert.ok(/projectsByProvider/.test(body), 'the raw discovery map is the preferred source');
  assert.ok(/this\.state\.projects/.test(body), 'the flattened list is the fallback');
});

// ───────────────────────────────────────────────────────────────────────
// (b) EDIT: the UI offers exactly what the next spawn will accept
// ───────────────────────────────────────────────────────────────────────

check('EXECUTED: the sandbox menu equals the spawn-time allow-list', () => {
  const ui = extractOptionIds('SANDBOX_OPTIONS').sort();
  const backend = [...spawnMod.SANDBOX_VALUES].sort();
  assert.deepStrictEqual(ui, backend,
    'menu and spawn allow-list disagree; this is exactly how disabled and managed went missing');
});

check('EXECUTED: the effort menu equals the spawn-time allow-list', () => {
  const ui = extractOptionIds('EFFORT_OPTIONS').sort();
  const backend = [...spawnMod.EFFORT_VALUES].sort();
  assert.deepStrictEqual(ui, backend,
    'the menu must be able to name every effort the backend accepts, ultra and max included');
});

check('EXECUTED: the approval menu equals the spawn-time allow-list', () => {
  const ui = extractOptionIds('APPROVAL_OPTIONS').sort();
  const backend = [...spawnMod.APPROVAL_VALUES].sort();
  assert.deepStrictEqual(ui, backend);
});

check('EXECUTED: the model suggestions are the observed ids, not invented ones', () => {
  const ui = extractOptionIds('MODEL_OPTIONS').sort();
  const observed = [...spawnMod.OBSERVED_MODEL_IDS].sort();
  assert.deepStrictEqual(ui, observed,
    'the picker must offer models that exist in real threads');
  for (const dead of ['gpt-5-codex', 'o3']) {
    assert.ok(!ui.includes(dead), 'the never-observed model ' + dead + ' must be gone');
  }
  // And the backend must still accept anything well-shaped, so a new model
  // works before anyone edits a list.
  assert.deepStrictEqual(
    spawnMod.buildFlagsFromSettings({ model: 'gpt-6-future' }),
    ['-m', 'gpt-6-future'],
    'model validation must stay shape-based, never an allow-list'
  );
});

// ───────────────────────────────────────────────────────────────────────
// (c) APPLY: an edited setting becomes the argv the next spawn runs
// ───────────────────────────────────────────────────────────────────────

check('EXECUTED: an edit of all four fields assembles into the spawn argv', () => {
  const flags = spawnMod.buildFlagsFromSettings({
    model: 'gpt-5.6-sol',
    sandbox: 'disabled',
    approvalPolicy: 'never',
    reasoningEffort: 'ultra',
  });
  assert.deepStrictEqual(flags, [
    '-m', 'gpt-5.6-sol',
    '-s', 'disabled',
    '-a', 'never',
    '-c', 'model_reasoning_effort="ultra"',
  ], 'the four edited values must all reach argv, in the documented order');
});

check('EXECUTED: every menu value round-trips into argv, none is silently dropped', () => {
  for (const sandbox of spawnMod.SANDBOX_VALUES) {
    const flags = spawnMod.buildFlagsFromSettings({ sandbox });
    assert.deepStrictEqual(flags, ['-s', sandbox], 'sandbox ' + sandbox + ' was dropped');
  }
  for (const effort of spawnMod.EFFORT_VALUES) {
    const flags = spawnMod.buildFlagsFromSettings({ reasoningEffort: effort });
    assert.deepStrictEqual(flags, ['-c', 'model_reasoning_effort="' + effort + '"'],
      'effort ' + effort + ' was dropped');
  }
  for (const approval of spawnMod.APPROVAL_VALUES) {
    const flags = spawnMod.buildFlagsFromSettings({ approvalPolicy: approval });
    assert.deepStrictEqual(flags, ['-a', approval], 'approval ' + approval + ' was dropped');
  }
  for (const model of spawnMod.OBSERVED_MODEL_IDS) {
    const flags = spawnMod.buildFlagsFromSettings({ model });
    assert.deepStrictEqual(flags, ['-m', model], 'model ' + model + ' was dropped');
  }
});

check('EXECUTED: a value outside the allow-list is dropped, never passed through', () => {
  const warns = [];
  const original = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const flags = spawnMod.buildFlagsFromSettings({
      sandbox: 'wide-open',
      reasoningEffort: 'infinite',
      approvalPolicy: 'always',
    });
    assert.deepStrictEqual(flags, [], 'nothing unknown may reach argv');
  } finally {
    console.warn = original;
  }
  assert.strictEqual(warns.length, 3, 'each dropped field must say so once');
});

// ───────────────────────────────────────────────────────────────────────
// (d) REFLECT: after an edit the surfaces re-render
// ───────────────────────────────────────────────────────────────────────

check('a saved edit updates local state and re-renders the strip', () => {
  const idx = appSrc.indexOf('sess.providerSettings.codex = next;');
  assert.ok(idx > -1, 'the PUT handler must write the new settings into the session record');
  const body = appSrc.slice(idx, idx + 900);
  assert.ok(/adHocProviderSettings/.test(body),
    'a discovered session with no store record must update the ad-hoc cache too');
  assert.ok(/this\._renderCodexStatusStrip\(slotIdx\)/.test(body),
    'the strip must re-render so the chip shows the new value immediately');
  assert.ok(/showToast/.test(body), 'the user must be told the change applies on restart');
});

check('the submenu hints show the value in use, never the word default', () => {
  assert.ok(/hint: hintFor\(codexSettings\.model, observedDetail\.model\)/.test(appSrc));
  assert.ok(/hint: hintFor\(codexSettings\.sandbox, observedDetail\.sandboxPolicyType\)/.test(appSrc));
  assert.ok(/hint: hintFor\(codexSettings\.approvalPolicy, observedDetail\.approvalMode\)/.test(appSrc));
  assert.ok(/hint: hintFor\(codexSettings\.reasoningEffort, observedDetail\.reasoningEffort\)/.test(appSrc));
  assert.ok(!/hint: codexSettings\.\w+ \|\| 'default'/.test(appSrc),
    "no hint may read 'default'; it is not a value the user can act on");
});

runQueue();
console.log('\n  ' + '─'.repeat(42));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('  ' + '─'.repeat(42) + '\n');
process.exit(failed > 0 ? 1 : 0);
