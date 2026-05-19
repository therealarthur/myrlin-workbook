#!/usr/bin/env node
/**
 * Tests for src/providers/codex/search.js (Phase 17 Plan 17-02).
 *
 * Coverage:
 *   1. search finds matches in response_item.message lines (CDX-06)
 *   2. search results carry 1-based lineNumber (CDX-06)
 *   3. search results carry provider:'codex' (gsd:provider-literal-allowed)
 *   4. search skips compacted lines (CDX-05 search half)
 *   5. search skips session_meta, turn_context, event_msg envelope types
 *   6. search snippet shape: ±100 char, whitespace-normalized, ellipsis
 *   7. search self-checks time budget (timedOut flag flips, loop exits)
 *   8. search handles missing $CODEX_HOME gracefully (returns empty)
 *   9. search respects limit
 *  10. search file-list cache invalidates when $CODEX_HOME changes
 *  11. search returns empty for empty/short query (defensive validation)
 *  12. search returns empty for invalid timeBudgetMs (defensive validation)
 *  13. search results carry sessionName resolved from thread_name_updated
 *
 * Standalone-test convention: this file owns its own assertion helpers and
 * exits 0 on green / 1 on any failure. Mirrors test/codex-spawn.test.js
 * scaffolding.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Assertion helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  // Allow async tests by awaiting if fn returns a promise.
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    })
    .catch((err) => {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + err.message + '\x1b[0m');
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
  }
}

// ─── Module under test ─────────────────────────────────────────────────────

let codexSearch;
try {
  codexSearch = require('../src/providers/codex/search');
} catch (err) {
  console.error('FATAL: could not require src/providers/codex/search.js: ' + err.message);
  process.exit(1);
}
const { search, _internal } = codexSearch;

// ─── Fixture paths ─────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, '..');
const MODERN_FIXTURE = path.join(PROJECT_ROOT, 'test', 'fixtures', 'codex-rollouts', 'modern.jsonl');

// ─── Staging helpers ───────────────────────────────────────────────────────

/**
 * Build a fresh CODEX_HOME tempdir.
 * @returns {string} absolute path to the new tempdir
 */
function makeCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-codex-search-'));
}

/**
 * Copy a fixture into $home/sessions/<dateDir>/rollout-<...>-<id>.jsonl.
 * Returns the staged path.
 *
 * @param {string} home  - CODEX_HOME tempdir
 * @param {string} fixturePath - source fixture
 * @param {string} dateDir - 'YYYY/MM/DD'
 * @param {string} id - UUID for the filename suffix
 * @returns {string} the staged absolute path
 */
function stageRollout(home, fixturePath, dateDir, id) {
  const dayDir = path.join(home, 'sessions', ...dateDir.split('/'));
  fs.mkdirSync(dayDir, { recursive: true });
  const staged = path.join(
    dayDir,
    'rollout-' + dateDir.replace(/\//g, '-') + 'T00-00-00-' + id + '.jsonl'
  );
  fs.copyFileSync(fixturePath, staged);
  return staged;
}

/**
 * Snapshot + restore CODEX_HOME so each test is hermetic.
 */
function snapshotCodexHome() {
  const wasSet = Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME');
  const prev = wasSet ? process.env.CODEX_HOME : undefined;
  return function restore() {
    if (wasSet) {
      process.env.CODEX_HOME = prev;
    } else {
      delete process.env.CODEX_HOME;
    }
  };
}

/**
 * Run a body with CODEX_HOME pointed at a fresh tempdir; cleanup after.
 * Resets the search cache before and after so tests do not leak state.
 *
 * @param {(home: string) => Promise<void>|void} fn
 */
async function withFreshHome(fn) {
  const restore = snapshotCodexHome();
  const home = makeCodexHome();
  process.env.CODEX_HOME = home;
  _internal._resetCache();
  try {
    await fn(home);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    _internal._resetCache();
    restore();
  }
}

// ─── Run tests ─────────────────────────────────────────────────────────────

console.log('\n  Plan 17-02: codex/search.js');
console.log('  ' + '-'.repeat(70));

(async () => {
  // ─── Test 1: matches in response_item.message lines (CDX-06) ────────────
  await test('search finds matches in response_item.message lines', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const out = await search({ query: 'summarize', limit: 20, timeBudgetMs: 5000 });
      assert(Array.isArray(out.results), 'results must be an array');
      assert(out.results.length >= 1, 'expected at least 1 match for "summarize"');
      assert(out.searchedFiles >= 1, 'searchedFiles should be >= 1');
      // The first match comes from the user line in the fixture
      // (response_item.message: 'Hello from the test fixture, please summarize.').
      const first = out.results[0];
      assert(first.snippet.toLowerCase().includes('summarize'),
        'snippet should contain query; got: ' + first.snippet);
    });
  });

  // ─── Test 2: 1-based lineNumber ─────────────────────────────────────────
  await test('search results carry 1-based lineNumber', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const out = await search({ query: 'summarize', limit: 20, timeBudgetMs: 5000 });
      assert(out.results.length >= 1, 'expected at least 1 match');
      for (const r of out.results) {
        assert(Number.isInteger(r.lineNumber), 'lineNumber must be an integer');
        assert(r.lineNumber >= 1, 'lineNumber must be >= 1, got ' + r.lineNumber);
      }
    });
  });

  // ─── Test 3: provider:'codex' tag (gsd:provider-literal-allowed) ────────
  await test('search results carry provider:codex', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const out = await search({ query: 'summarize', limit: 20, timeBudgetMs: 5000 });
      assert(out.results.length >= 1, 'expected at least 1 match');
      for (const r of out.results) {
        assertEqual(r.provider, 'codex', 'each result must carry provider:codex'); // gsd:provider-literal-allowed
      }
    });
  });

  // ─── Test 4: compacted exclusion (CDX-05 search half) ───────────────────
  await test('search skips compacted lines (CDX-05 search half)', async () => {
    await withFreshHome(async (home) => {
      // The modern.jsonl fixture has a compacted line whose payload.summary
      // is 'Earlier turns about file listings have been compacted.' If the
      // search adapter incorrectly indexed compacted lines, querying for a
      // token that ONLY appears inside that summary would return results.
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const out = await search({ query: 'Earlier turns', limit: 20, timeBudgetMs: 5000 });
      assertEqual(out.results.length, 0, 'compacted summary text must not appear in results');
    });
  });

  // ─── Test 5: session_meta / turn_context / event_msg excluded ───────────
  await test('search skips session_meta, turn_context, event_msg envelopes', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');

      // session_meta.payload.originator is 'Codex Desktop' (only in the
      // session_meta line). If search incorrectly indexed it, this would
      // return results.
      const outMeta = await search({ query: 'Codex Desktop', limit: 20, timeBudgetMs: 5000 });
      assertEqual(outMeta.results.length, 0, 'session_meta content must not be indexed');

      // event_msg.payload.message contains 'This event_msg duplicate' in the
      // fixture; that line is type=event_msg/user_message and must be skipped
      // in favor of the response_item.message version (which the parser also
      // skips here; see plan).
      const outEvent = await search({ query: 'event_msg duplicate', limit: 20, timeBudgetMs: 5000 });
      assertEqual(outEvent.results.length, 0, 'event_msg payload.message must not be indexed');

      // turn_context.payload.summary is 'auto' (too short to query in 2-char
      // minimum). Use the longer 'gpt-5-codex' which only appears inside
      // turn_context.payload.model to validate the skip.
      const outCtx = await search({ query: 'gpt-5-codex', limit: 20, timeBudgetMs: 5000 });
      assertEqual(outCtx.results.length, 0, 'turn_context content must not be indexed');
    });
  });

  // ─── Test 6: snippet shape ──────────────────────────────────────────────
  await test('search snippet shape: ±100 chars, whitespace-normalized', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const out = await search({ query: 'summarize', limit: 20, timeBudgetMs: 5000 });
      assert(out.results.length >= 1, 'expected at least 1 match');
      for (const r of out.results) {
        // Total snippet length is bounded by the ±100 char radius plus query
        // length plus ellipsis padding (3 chars each side).
        assert(typeof r.snippet === 'string', 'snippet must be a string');
        assert(r.snippet.length <= 220, 'snippet length should be <= 220, got ' + r.snippet.length);
        assert(!/[\r\n]/.test(r.snippet), 'snippet must not contain CR/LF; got: ' + JSON.stringify(r.snippet));
        // Snippet must contain only the extracted text, never the JSONL line wrapper.
        assert(!r.snippet.includes('"payload"'), 'snippet must not include JSONL line wrapper');
        assert(!r.snippet.includes('"type":"response_item"'), 'snippet must not include envelope type');
      }
    });
  });

  // ─── Test 7: time budget self-check ─────────────────────────────────────
  await test('search self-checks time budget', async () => {
    await withFreshHome(async (home) => {
      // Stage 200 fixtures. On a fast Linux+Node20 runner the prior count of 12
      // could be searched in <1ms entirely, leaving timedOut=false AND
      // searchedFiles=12 — both early-termination signals false despite the
      // code working correctly. 200 forces I/O time > 1ms on any platform.
      const STAGED = 200;
      for (let i = 0; i < STAGED; i++) {
        const id = '019dc872-' + String(i).padStart(4, '0') + '-7111-ba78-068f9294120c';
        stageRollout(home, MODERN_FIXTURE, '2026/04/26', id);
      }
      // Tiny budget; loop should bail before searching every file.
      const out = await search({ query: 'summarize', limit: 200, timeBudgetMs: 1 });
      // The very first file may have already been scanned before the budget
      // check fired. We assert that searchedFiles is strictly less than the
      // total staged count to prove early termination occurred OR that
      // timedOut is true.
      assert(out.timedOut === true || out.searchedFiles < STAGED,
        'expected early termination signal; timedOut=' + out.timedOut + ' searchedFiles=' + out.searchedFiles);
    });
  });

  // ─── Test 8: missing CODEX_HOME ─────────────────────────────────────────
  await test('search returns empty when CODEX_HOME does not exist', async () => {
    const restore = snapshotCodexHome();
    try {
      // Point at a known-bad path; tempdir we generate-then-delete.
      const bogus = path.join(os.tmpdir(), 'cwm-codex-search-missing-' + Date.now());
      process.env.CODEX_HOME = bogus;
      _internal._resetCache();
      const out = await search({ query: 'whatever', limit: 20, timeBudgetMs: 1000 });
      assertEqual(out.results.length, 0, 'results must be empty');
      assertEqual(out.timedOut, false, 'timedOut must be false');
      assertEqual(out.searchedFiles, 0, 'searchedFiles must be 0');
    } finally {
      _internal._resetCache();
      restore();
    }
  });

  // ─── Test 9: limit respected ────────────────────────────────────────────
  await test('search respects limit', async () => {
    await withFreshHome(async (home) => {
      // Stage 5 fixture copies. The fixture has 2 messages that match
      // 'summarize' (the user message contains 'summarize' and the
      // assistant message contains 'summary'). With limit=2, results must
      // be exactly 2.
      for (let i = 0; i < 5; i++) {
        const id = '019dc872-' + String(i).padStart(4, '0') + '-7111-ba78-068f9294120c';
        stageRollout(home, MODERN_FIXTURE, '2026/04/26', id);
      }
      const out = await search({ query: 'summarize', limit: 2, timeBudgetMs: 5000 });
      assertEqual(out.results.length, 2, 'expected exactly 2 results with limit=2, got ' + out.results.length);
    });
  });

  // ─── Test 10: cache invalidates on $CODEX_HOME change ───────────────────
  await test('search file-list cache invalidates when CODEX_HOME changes', async () => {
    const restore = snapshotCodexHome();
    try {
      _internal._resetCache();

      const home1 = makeCodexHome();
      const home2 = makeCodexHome();
      try {
        // home1 has one rollout; home2 has none.
        stageRollout(home1, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');

        process.env.CODEX_HOME = home1;
        const files1 = _internal.getSearchableFiles();
        assertEqual(files1.length, 1, 'home1 should have 1 rollout file');

        // Swap env; cache must invalidate based on the resolved path key.
        process.env.CODEX_HOME = home2;
        const files2 = _internal.getSearchableFiles();
        assertEqual(files2.length, 0, 'home2 should have 0 rollout files (cache invalidated)');

        // Swap back; should now return the home1 list again.
        process.env.CODEX_HOME = home1;
        const files3 = _internal.getSearchableFiles();
        assertEqual(files3.length, 1, 'home1 should still have 1 rollout file after re-resolution');
      } finally {
        try { fs.rmSync(home1, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(home2, { recursive: true, force: true }); } catch (_) {}
      }
    } finally {
      _internal._resetCache();
      restore();
    }
  });

  // ─── Test 11: defensive validation - empty query ────────────────────────
  await test('search returns empty for empty/short query', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const empty = await search({ query: '', limit: 20, timeBudgetMs: 1000 });
      assertEqual(empty.results.length, 0, 'empty query should return empty');
      const oneChar = await search({ query: 'a', limit: 20, timeBudgetMs: 1000 });
      assertEqual(oneChar.results.length, 0, 'single-char query should return empty');
      const noQuery = await search({ limit: 20, timeBudgetMs: 1000 });
      assertEqual(noQuery.results.length, 0, 'missing query should return empty');
      const nullQuery = await search({ query: null, limit: 20, timeBudgetMs: 1000 });
      assertEqual(nullQuery.results.length, 0, 'null query should return empty');
    });
  });

  // ─── Test 12: defensive validation - invalid timeBudgetMs ───────────────
  await test('search returns empty for invalid timeBudgetMs', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const negative = await search({ query: 'summarize', limit: 20, timeBudgetMs: -1 });
      assertEqual(negative.results.length, 0, 'negative budget should return empty');
      const zero = await search({ query: 'summarize', limit: 20, timeBudgetMs: 0 });
      assertEqual(zero.results.length, 0, 'zero budget should return empty');
      const nan = await search({ query: 'summarize', limit: 20, timeBudgetMs: NaN });
      assertEqual(nan.results.length, 0, 'NaN budget should return empty');
      const missing = await search({ query: 'summarize', limit: 20 });
      assertEqual(missing.results.length, 0, 'missing budget should return empty');
    });
  });

  // ─── Test 13: sessionName lazy-resolved from thread_name_updated ────────
  await test('search resolves sessionName from event_msg.thread_name_updated', async () => {
    await withFreshHome(async (home) => {
      stageRollout(home, MODERN_FIXTURE, '2026/04/26', '019dc872-a308-7111-ba78-068f9294120c');
      const out = await search({ query: 'summarize', limit: 20, timeBudgetMs: 5000 });
      assert(out.results.length >= 1, 'expected at least 1 match');
      // The fixture has a thread_name_updated event with thread_name:
      // 'Test fixture session'. The search adapter should pick that up.
      const first = out.results[0];
      assertEqual(first.sessionName, 'Test fixture session',
        'sessionName should be resolved from thread_name_updated; got ' + first.sessionName);
      // projectPath comes from session_meta.payload.cwd = '/home/user/project'.
      assertEqual(first.projectPath, '/home/user/project',
        'projectPath should be resolved from session_meta.cwd');
      assertEqual(first.projectName, 'project',
        'projectName should be basename of projectPath');
    });
  });

  // ─── Summary + exit ─────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(70));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
