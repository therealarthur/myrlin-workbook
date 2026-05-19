#!/usr/bin/env node
/**
 * Tests for getProviderForSession helper and claudeProvider.findArtifactPath.
 * Plan 15-01 (DISC-03).
 *
 * Coverage:
 *   1. getProviderForSession (tagged 'claude') -> claudeProvider
 *   2. getProviderForSession (untagged) -> claudeProvider (defensive default)
 *   3. getProviderForSession (null session) -> null
 *   4. getProviderForSession (unregistered provider id) -> null
 *   5. claudeProvider.findArtifactPath (non-existent UUID) -> null
 *   6. claudeProvider.findArtifactPath (known fixture UUID) -> path ending '.jsonl'
 *
 * The helper is exported from src/web/server.js (Plan 15-01 added it to
 * module.exports). Requiring the module does NOT start the HTTP listener
 * because server.listen() is wrapped in startServer() (called only on demand).
 *
 * Standalone-test convention: this file owns its own assertion helpers and
 * exits 0 on green / 1 on any failure with offender list.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
// See test/_test-data-dir.js. Prior version pointed at the production ./state/.
require('./_test-data-dir');

// Reset module cache so each test gets a fresh registry. The registry has
// in-process state (the _enabled Set, the _providers Map) that prior test
// suites might have mutated; clearing the cache forces a clean boot below.
delete require.cache[require.resolve('../src/providers')];
delete require.cache[require.resolve('../src/providers/claude')];
delete require.cache[require.resolve('../src/state/store')];
delete require.cache[require.resolve('../src/web/server')];

// ─── Assertion helpers (inlined per standalone-test convention) ────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + err.message + '\x1b[0m');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
  }
}

// ─── Fixture setup ────────────────────────────────────────────────────────

// Self-contained fixture: write a temp JSONL under ~/.claude/projects/<dir>/
// so claudeProvider.findArtifactPath can find it. The leading '-' on the
// directory name keeps decodeClaudePath from misinterpreting it as a path
// segment that needs filesystem-walking. Cleanup happens in finally.
const fixtureDirName = '-find-jsonl-refactor-test-fixture-';
const fixtureUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
const fixtureDir = path.join(claudeProjectsDir, fixtureDirName);
const fixtureFile = path.join(fixtureDir, fixtureUuid + '.jsonl');

let fixtureCreated = false;
let fixtureDirCreated = false;
let claudeProjectsDirCreated = false;

try {
  // Ensure ~/.claude/projects/ exists (rare on a fresh dev box).
  if (!fs.existsSync(claudeProjectsDir)) {
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    claudeProjectsDirCreated = true;
  }
  if (!fs.existsSync(fixtureDir)) {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fixtureDirCreated = true;
  }
  fs.writeFileSync(fixtureFile, '{"role":"system","content":"fixture"}\n', 'utf-8');
  fixtureCreated = true;

  // ─── Boot the registry once for all tests ─────────────────────────────
  const registry = require('../src/providers');
  const claudeProvider = require('../src/providers/claude');

  // Synchronous initRegistry returns a Promise; await it via .then chain
  // to keep this file simple (no top-level await in CommonJS).
  const fakeStore = { state: { settings: { providers: { claude: true } } } };

  registry.initRegistry(fakeStore).then(() => {
    const server = require('../src/web/server');
    const { getProviderForSession } = server;

    console.log('\n  Plan 15-01: getProviderForSession helper + claudeProvider.findArtifactPath');
    console.log('  ' + '-'.repeat(70));

    // ─── Test 1: tagged 'claude' session resolves to claudeProvider ────
    test('getProviderForSession resolves tagged session to claudeProvider', () => {
      const session = { id: 'x', provider: 'claude' };
      const provider = getProviderForSession(session);
      assert(provider !== null, 'expected non-null provider');
      assert(provider === claudeProvider, 'expected reference equality with claudeProvider');
      assertEqual(provider.id, 'claude', 'provider id should be claude');
    });

    // ─── Test 2: untagged session falls back to claudeProvider ─────────
    test('getProviderForSession defaults untagged session to claudeProvider', () => {
      const session = { id: 'x' }; // no provider key
      const provider = getProviderForSession(session);
      assert(provider !== null, 'expected non-null provider for defensive default');
      assert(provider === claudeProvider, 'expected fallback to claudeProvider');
    });

    // ─── Test 3: null session returns null ─────────────────────────────
    test('getProviderForSession returns null for null session', () => {
      const provider = getProviderForSession(null);
      assertEqual(provider, null, 'null session must return null');
    });

    // ─── Test 4: unregistered provider id returns null ─────────────────
    test('getProviderForSession returns null for unregistered provider id', () => {
      const session = { id: 'x', provider: 'nonexistent-provider-12345' };
      const provider = getProviderForSession(session);
      assertEqual(provider, null, 'unregistered provider id must return null');
    });

    // ─── Test 5: findArtifactPath returns null for unknown UUID ────────
    test('claudeProvider.findArtifactPath returns null for non-existent UUID', () => {
      const result = claudeProvider.findArtifactPath('00000000-0000-0000-0000-000000000000');
      assertEqual(result, null, 'unknown UUID must return null');
    });

    // ─── Test 6: findArtifactPath returns path for known fixture ───────
    test('claudeProvider.findArtifactPath returns full path for known fixture UUID', () => {
      const result = claudeProvider.findArtifactPath(fixtureUuid);
      assert(result !== null, 'fixture UUID must resolve to a path');
      assert(result.endsWith('.jsonl'), 'path must end with .jsonl, got: ' + result);
      assert(result.includes(fixtureUuid), 'path must include the fixture UUID, got: ' + result);
      assert(fs.existsSync(result), 'path must point to an actually-existing file');
    });

    // ─── Summary + exit ────────────────────────────────────────────────
    console.log('  ' + '-'.repeat(70));
    console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
    cleanupAndExit(failed > 0 ? 1 : 0);
  }).catch((err) => {
    console.error('Registry init failed:', err);
    cleanupAndExit(1);
  });
} catch (err) {
  console.error('Test setup failed:', err);
  cleanupAndExit(1);
}

/**
 * Best-effort cleanup of every fixture artifact this test created. Deletes
 * the fixture file, then the fixture directory (only if THIS test created
 * it), then ~/.claude/projects/ (only if THIS test created it). Each step
 * is wrapped in try/catch so a partial failure does not mask earlier
 * cleanup errors.
 *
 * @param {number} code - Exit code to pass to process.exit.
 */
function cleanupAndExit(code) {
  try {
    if (fixtureCreated && fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile);
  } catch (_) { /* ignore */ }
  try {
    if (fixtureDirCreated && fs.existsSync(fixtureDir)) fs.rmdirSync(fixtureDir);
  } catch (_) { /* ignore */ }
  try {
    if (claudeProjectsDirCreated && fs.existsSync(claudeProjectsDir)) {
      // Only remove if empty (we don't want to nuke real user data).
      const remaining = fs.readdirSync(claudeProjectsDir);
      if (remaining.length === 0) fs.rmdirSync(claudeProjectsDir);
    }
  } catch (_) { /* ignore */ }
  process.exit(code);
}
