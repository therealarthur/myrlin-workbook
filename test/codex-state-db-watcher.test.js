#!/usr/bin/env node
/**
 * BUILD-CONTRACT P9.5 (CODEX-PARITY B23): the watcher covers the state store
 * and the archive, and does not storm.
 *
 * What was wrong
 * ==============
 *
 * The watcher watched `$CODEX_HOME/sessions` and nothing else. After P8 made
 * `state_5.sqlite` the primary source of discovery, that left three blind spots:
 *
 *   - A thread CREATED, RENAMED, ARCHIVED or MOVED in the desktop app changes
 *     the database, not the sessions tree, so nothing fired until the 5-minute
 *     fallback poll happened to come round.
 *   - Archiving MOVES a rollout into `archived_sessions/`, which was not
 *     watched at all.
 *   - Firing without dropping the store's warm cache tells a consumer to look
 *     again and then shows it the same snapshot.
 *
 * Why a poll and not an fs.watch
 * ==============================
 *
 * CODEX-PARITY D.6 measured that CODEX_HOME churns constantly from WAL
 * activity. The P9 read-only proof harness confirmed it independently: two
 * files under ~/.codex changed within a six-second window while the workbook
 * was completely idle. An fs.watch there fires continuously. Two stat calls on
 * an interval do not, and the fire itself is rate limited on the way out
 * because each one clears a cache and broadcasts SSE to every client.
 *
 * Coverage:
 *   1. A change to the database's content key fires the callback.
 *   2. No change, no fire.
 *   3. The FIRST observation establishes a baseline instead of firing, so a
 *      server start does not refresh every client for nothing.
 *   4. Repeated changes inside the cooldown coalesce into one fire, and the
 *      change is delivered on the trailing edge rather than dropped.
 *   5. Every fire invalidates the store's warm cache first.
 *   6. A rollout appearing in archived_sessions/ fires.
 *   7. Stopping the watcher leaves no timer and no handle behind.
 *
 * Hermetic: a temp CODEX_HOME with a fake state_5.sqlite. Nothing reads the
 * real store.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 / 1.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, tallying rather than aborting.
 *
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 * @returns {Promise<void>}
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + (err && err.message ? err.message : err) + '\x1b[0m');
  }
}

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Hermetic CODEX_HOME ───────────────────────────────────────────────────

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dbwatch-'));
fs.mkdirSync(path.join(tmpHome, 'sessions', '2026', '08', '01'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'archived_sessions'), { recursive: true });
const dbPath = path.join(tmpHome, 'state_5.sqlite');
fs.writeFileSync(dbPath, 'not-a-real-database-just-bytes');

process.env.CODEX_HOME = tmpHome;
// A short cooldown so the coalescing assertion does not take half a minute.
process.env.CWM_CODEX_STATE_DB_MIN_FIRE_MS = '400';
process.env.CWM_CODEX_STATE_DB_POLL_MS = '50';

delete require.cache[require.resolve('../src/providers/codex')];
delete require.cache[require.resolve('../src/providers/codex/state-db')];
const codex = require('../src/providers/codex');
const stateDb = require('../src/providers/codex/state-db');

/**
 * Change the database file so its content key moves. Size AND mtime both
 * change, which is what the real store does on every checkpoint.
 *
 * @param {string} suffix
 * @returns {void}
 */
function touchDb(suffix) {
  fs.appendFileSync(dbPath, suffix);
}

(async () => {
  console.log('\n  BUILD-CONTRACT P9.5: Codex state-store poll, archive watch, cache invalidation');
  console.log('  ' + '-'.repeat(72));

  let fires = 0;
  codex._startWatcherForTesting(() => { fires++; });

  await test('the first observation sets a baseline and does NOT fire', () => {
    // _startWatcher already took one sample. A second tick with nothing changed
    // must also be silent.
    const before = fires;
    codex._pollStateDbForTesting();
    assert.strictEqual(fires, before, 'a server start must not refresh every client for nothing');
  });

  await test('no change, no fire', () => {
    const before = fires;
    codex._pollStateDbForTesting();
    codex._pollStateDbForTesting();
    codex._pollStateDbForTesting();
    assert.strictEqual(fires, before, 'polling an unchanged database is silent');
  });

  await test('a change to the database content key fires', async () => {
    const before = fires;
    await sleep(1200); // clear the cooldown from any earlier fire
    touchDb('a');
    codex._pollStateDbForTesting();
    assert.strictEqual(fires, before + 1, 'a thread created in the desktop app must reach the sidebar');
  });

  await test('changes inside the cooldown coalesce into ONE fire', async () => {
    const before = fires;
    touchDb('b');
    codex._pollStateDbForTesting();
    touchDb('c');
    codex._pollStateDbForTesting();
    touchDb('d');
    codex._pollStateDbForTesting();
    // Immediately: still inside the cooldown from the previous test's fire.
    assert.strictEqual(fires, before, 'the cooldown must hold the burst');
    // The change is not dropped; it arrives on the trailing edge.
    await sleep(700);
    assert.strictEqual(fires, before + 1, 'exactly one trailing fire, not three and not zero');
  });

  await test('every fire drops the store warm cache first', async () => {
    // A fire that leaves a warm cache in place tells the consumer to look again
    // and then hands it the pre-change snapshot.
    let invalidated = 0;
    const realInvalidate = stateDb.invalidate;
    stateDb.invalidate = function () { invalidated++; return realInvalidate.apply(this, arguments); };
    try {
      await sleep(700); // clear the cooldown
      touchDb('e');
      codex._pollStateDbForTesting();
      await sleep(50);
      assert(invalidated >= 1, 'the warm cache must be dropped before the callback runs');
    } finally {
      stateDb.invalidate = realInvalidate;
    }
  });

  await test('a rollout appearing in archived_sessions/ fires', async () => {
    await sleep(700);
    const before = fires;
    fs.writeFileSync(
      path.join(tmpHome, 'archived_sessions', 'rollout-2026-08-01T10-00-00-aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa.jsonl'),
      '{}'
    );
    // fs.watch is asynchronous and the handler debounces at 500ms.
    await sleep(1500);
    assert(fires > before, 'archiving a thread moves its rollout here and must be seen');
  });

  await test('a REAL Codex rollout filename passes the watcher filter', async () => {
    // The filter used to be /rollout-[a-f0-9-]+\.jsonl$/i, which requires every
    // character after `rollout-` to be a hex digit or a hyphen. The `T` in the
    // ISO timestamp of a real filename is neither, so the pattern matched
    // NOTHING the desktop app has ever written: every rollout event was
    // discarded and only the 5-minute fallback poll ever refreshed anything.
    await sleep(700);
    const before = fires;
    codex._startWatcherForTesting(() => { fires++; });
    fs.writeFileSync(
      path.join(tmpHome, 'sessions', '2026', '08', '01',
        // Synthetic id, real filename SHAPE. The `T` in the timestamp is the
        // character the old filter could not match, so it is the whole point.
        'rollout-2026-08-01T13-16-17-019f0000-0000-7000-8000-00000000000d.jsonl'),
      '{}'
    );
    await sleep(1500);
    assert(fires > before, 'a real Codex filename must reach the debounce');
  });

  await test('the poll and the fire floor are separately configurable', () => {
    const c = codex._watcherConstants;
    assert.strictEqual(c.STATE_DB_POLL_MS, 50, 'CWM_CODEX_STATE_DB_POLL_MS must be honoured');
    assert.strictEqual(c.STATE_DB_MIN_FIRE_MS, 400, 'CWM_CODEX_STATE_DB_MIN_FIRE_MS must be honoured');
    assert.strictEqual(c.POLL_MS, 5 * 60 * 1000, 'the 5-minute fallback poll must be retained');
    assert.strictEqual(c.DEBOUNCE_MS, 500, 'the rollout debounce is unchanged');
  });

  await test('stopping the watcher leaves nothing running', async () => {
    codex._stopWatcherForTesting();
    const before = fires;
    touchDb('f');
    codex._pollStateDbForTesting();
    fs.writeFileSync(
      path.join(tmpHome, 'archived_sessions', 'rollout-2026-08-01T11-00-00-bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb.jsonl'),
      '{}'
    );
    await sleep(900);
    assert.strictEqual(fires, before, 'a disposed watcher must be silent');
  });

  console.log('  ' + '-'.repeat(72));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
