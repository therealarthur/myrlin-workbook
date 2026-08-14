#!/usr/bin/env node
/**
 * Unit tests for src/providers/index.js (Provider registry).
 *
 * Covers:
 *   ABST-01  contract surface (registry exports the 7 public functions)
 *   ABST-02  stub provider acceptance + validation rejection
 *   ABST-05  enable/disable toggle, write-through to store
 *   ABST-06  register-but-mark-disabled (getProvider works for disabled providers)
 *   ABST-07  parseTranscript still callable on disabled providers
 *   COST-01  supportsCost capability method is present and callable
 *
 * Test pattern mirrors test/instance-colors.test.js: Node assert, no third-party
 * framework, prints "All passed." and process.exit(0) on success.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;

/**
 * Run a single test case. Catches throws and tallies pass/fail.
 * @param {string} name  Human label printed for the test row
 * @param {Function} fn  Sync test body. Throw on failure.
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Build a minimal fake store object with the shape the registry expects:
 * store.state.settings.providers is a plain object map of id -> boolean.
 * @param {Object<string,boolean>} initialProviders  initial provider toggle map
 * @returns {{state: {settings: {providers: Object<string,boolean>}}}}
 */
function makeFakeStore(initialProviders) {
  const seed = initialProviders || {};
  return { state: { settings: { providers: Object.assign({}, seed) } } };
}

/**
 * Build a fully-populated fake provider with no-op implementations for every
 * required field and method. Overrides let individual tests patch behavior.
 * @param {string} id  Provider id (must be a non-empty string).
 * @param {Object} [overrides]  Optional field overrides applied on top.
 * @returns {Object} Fake Provider object that satisfies register() validation.
 */
function makeFakeProvider(id, overrides) {
  const base = {
    id: id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    accentToken: 'mauve',
    cliBinary: id,
    discover: async function () { return []; },
    parseTranscript: async function () { return []; },
    spawnCommand: function () { return { cmd: id, args: [], cwd: process.cwd(), env: {} }; },
    search: async function () { return []; },
    init: async function () { /* no-op */ },
    dispose: async function () { /* no-op */ },
    supportsCost: function () { return false; },
    isIdleSignal: function () { return false; },
    getKeyBindings: function () { return {}; },
  };
  return Object.assign(base, overrides || {});
}

/**
 * Reload the registry module fresh so each test starts from an empty registry.
 * Returns the freshly-required module so subsequent calls are direct.
 * @returns {Object} The src/providers/index.js module exports.
 */
function freshRegistry() {
  const modPath = path.join(__dirname, '..', 'src', 'providers', 'index.js');
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

// ---------------------------------------------------------------------------
// Test 1 (ABST-01): contract surface, required exports are functions
// ---------------------------------------------------------------------------
check('ABST-01: registry exports register/getProvider/listEnabled/listAll/setEnabled/isEnabled/initRegistry as functions', () => {
  const reg = freshRegistry();
  const expected = ['register', 'getProvider', 'listEnabled', 'listAll', 'setEnabled', 'isEnabled', 'initRegistry'];
  for (const name of expected) {
    assert.strictEqual(typeof reg[name], 'function', 'expected reg.' + name + ' to be a function');
  }
  // Sorted set equality so a missing or extra export shows up clearly.
  const actualSorted = Object.keys(reg).sort();
  const expectedSorted = expected.slice().sort();
  for (const k of expectedSorted) {
    assert.ok(actualSorted.indexOf(k) !== -1, 'missing export: ' + k);
  }
});

// ---------------------------------------------------------------------------
// Test 2 (ABST-02): stub provider acceptance + validation
// ---------------------------------------------------------------------------
check('ABST-02: a fully-populated stub provider registers without throwing', () => {
  const reg = freshRegistry();
  const stub = makeFakeProvider('stubok');
  assert.doesNotThrow(function () { reg.register(stub); });
  assert.strictEqual(reg.getProvider('stubok'), stub, 'getProvider should return the registered stub');
});

check('ABST-02: register() throws when required string field id is missing', () => {
  const reg = freshRegistry();
  const broken = makeFakeProvider('x');
  delete broken.id;
  assert.throws(function () { reg.register(broken); }, /Provider validation failed/);
});

check('ABST-02: register() throws when discover/parseTranscript/spawnCommand methods are missing', () => {
  // Each missing method individually triggers a validation throw.
  const fields = ['discover', 'parseTranscript', 'spawnCommand'];
  for (const f of fields) {
    const reg = freshRegistry();
    const broken = makeFakeProvider('m_' + f);
    delete broken[f];
    assert.throws(function () { reg.register(broken); }, /Provider validation failed/, 'expected throw for missing ' + f);
  }
});

check('ABST-02: register() throws when capability methods (supportsCost/isIdleSignal/getKeyBindings) are missing', () => {
  const fields = ['supportsCost', 'isIdleSignal', 'getKeyBindings'];
  for (const f of fields) {
    const reg = freshRegistry();
    const broken = makeFakeProvider('cap_' + f);
    delete broken[f];
    assert.throws(function () { reg.register(broken); }, /Provider validation failed/, 'expected throw for missing ' + f);
  }
});

// ---------------------------------------------------------------------------
// Test 3 (ABST-05): toggle and write-through to store
// ---------------------------------------------------------------------------
check('ABST-05: initRegistry honors store.state.settings.providers; setEnabled writes through', async () => {
  const reg = freshRegistry();
  const claudeStub = makeFakeProvider('claude'); // gsd:provider-literal-allowed
  const fakeStub = makeFakeProvider('fake');
  reg.register(claudeStub);
  reg.register(fakeStub);

  // Note: claude:true, fake:false. After init, only claude is enabled.
  // Tokens noted: the literal 'claude' here is allowed because tests live in
  // test/, NOT in src/, and the grep gate (Plan 14-05) scans only src/.
  const fakeStore = makeFakeStore({ claude: true, fake: false }); // gsd:provider-literal-allowed
  await reg.initRegistry(fakeStore);

  const enabledIds = reg.listEnabled().map(function (p) { return p.id; }).sort();
  assert.deepStrictEqual(enabledIds, ['claude'], 'only claude should be enabled after init'); // gsd:provider-literal-allowed

  // Toggle 'fake' on: registry membership AND store object should both update.
  reg.setEnabled('fake', true);
  const after = reg.listEnabled().map(function (p) { return p.id; }).sort();
  assert.deepStrictEqual(after, ['claude', 'fake'], 'fake should be enabled after setEnabled(true)'); // gsd:provider-literal-allowed
  assert.strictEqual(fakeStore.state.settings.providers.fake, true, 'setEnabled must write through to store');
});

// ---------------------------------------------------------------------------
// Test 4 (ABST-06): register-but-mark-disabled
// ---------------------------------------------------------------------------
check('ABST-06: setEnabled(claude, false) removes from listEnabled but getProvider still returns it', async () => {
  const reg = freshRegistry();
  const claudeStub = makeFakeProvider('claude'); // gsd:provider-literal-allowed
  reg.register(claudeStub);
  await reg.initRegistry(makeFakeStore({ claude: true })); // gsd:provider-literal-allowed

  reg.setEnabled('claude', false); // gsd:provider-literal-allowed
  const enabledIds = reg.listEnabled().map(function (p) { return p.id; });
  assert.strictEqual(enabledIds.indexOf('claude'), -1, 'listEnabled must NOT include disabled claude'); // gsd:provider-literal-allowed
  assert.strictEqual(reg.isEnabled('claude'), false, 'isEnabled(claude) must be false'); // gsd:provider-literal-allowed
  assert.strictEqual(reg.getProvider('claude'), claudeStub, 'getProvider must still resolve disabled provider'); // gsd:provider-literal-allowed
});

// ---------------------------------------------------------------------------
// Test 5 (ABST-07): parseTranscript still callable on disabled provider
// ---------------------------------------------------------------------------
check('ABST-07: disabled providers parseTranscript stays callable so existing tagged sessions can still be read', async () => {
  const reg = freshRegistry();
  let parseInvoked = false;
  const claudeStub = makeFakeProvider('claude', { // gsd:provider-literal-allowed
    parseTranscript: async function (sid) { parseInvoked = true; return [{ role: 'user', text: 'sid=' + sid, timestamp: null, model: null }]; },
  });
  reg.register(claudeStub);
  await reg.initRegistry(makeFakeStore({ claude: true })); // gsd:provider-literal-allowed

  reg.setEnabled('claude', false); // gsd:provider-literal-allowed
  const provider = reg.getProvider('claude'); // gsd:provider-literal-allowed
  assert.ok(provider, 'getProvider should return the disabled provider object');
  const messages = await provider.parseTranscript('sess-123');
  assert.strictEqual(parseInvoked, true, 'parseTranscript was not invoked');
  assert.strictEqual(Array.isArray(messages), true, 'parseTranscript must return an array');
  assert.strictEqual(messages.length, 1, 'parseTranscript returned the stubbed payload');
});

// ---------------------------------------------------------------------------
// Test 6 (initRegistry idempotency): second call does not duplicate or re-init
// ---------------------------------------------------------------------------
check('initRegistry is idempotent: second call with same store does not re-invoke provider.init()', async () => {
  const reg = freshRegistry();
  let initCount = 0;
  const claudeStub = makeFakeProvider('claude', { // gsd:provider-literal-allowed
    init: async function () { initCount++; },
  });
  reg.register(claudeStub);
  const store = makeFakeStore({ claude: true }); // gsd:provider-literal-allowed
  await reg.initRegistry(store);
  await reg.initRegistry(store); // second call, same store ref

  assert.strictEqual(initCount, 1, 'provider.init() must only be called once across two initRegistry calls');
  // _enabled membership stays a Set (no duplicates) so listEnabled returns the same ids.
  const enabled = reg.listEnabled().map(function (p) { return p.id; });
  assert.deepStrictEqual(enabled, ['claude'], 'enabled membership must not duplicate'); // gsd:provider-literal-allowed
});

// ---------------------------------------------------------------------------
// Test 7 (force-on for claude): even if state.settings.providers.claude=false,
// after initRegistry the claude provider is forced into _enabled.
// ---------------------------------------------------------------------------
check('initRegistry force-adds claude to _enabled even when settings explicitly say false', async () => {
  const reg = freshRegistry();
  const claudeStub = makeFakeProvider('claude'); // gsd:provider-literal-allowed
  reg.register(claudeStub);
  // Deliberately wrong: settings says claude=false, registry must still force it on.
  const store = makeFakeStore({ claude: false }); // gsd:provider-literal-allowed
  await reg.initRegistry(store);

  assert.strictEqual(reg.isEnabled('claude'), true, 'claude must be force-enabled at init time'); // gsd:provider-literal-allowed
  const enabledIds = reg.listEnabled().map(function (p) { return p.id; });
  assert.ok(enabledIds.indexOf('claude') !== -1, 'listEnabled must include force-on claude'); // gsd:provider-literal-allowed
});

// ---------------------------------------------------------------------------
// Test 8 (COST-01): supportsCost capability is present and returns a boolean
// ---------------------------------------------------------------------------
check('COST-01: registered provider supportsCost() is callable and returns a boolean', () => {
  const reg = freshRegistry();
  const stub = makeFakeProvider('costcheck', { supportsCost: function () { return false; } });
  reg.register(stub);
  const got = reg.getProvider('costcheck');
  assert.ok(got, 'provider should be retrievable after register');
  const result = got.supportsCost();
  assert.strictEqual(typeof result, 'boolean', 'supportsCost must return a boolean');
  // The registry MUST NOT require the value to be true; Codex returns false in v1.2.
  assert.strictEqual(result, false, 'stub returned false; registry accepted that without complaint');
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('');
console.log('  ' + '-'.repeat(42));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
console.log('  ' + '-'.repeat(42));

if (failed === 0) {
  console.log('All passed.');
  process.exit(0);
}
process.exit(1);
