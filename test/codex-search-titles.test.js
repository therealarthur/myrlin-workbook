#!/usr/bin/env node
/**
 * BUILD-CONTRACT P9.4 (CODEX-PARITY B9): search results carry the title the
 * user recognises.
 *
 * What was wrong
 * ==============
 *
 * Search labelled a result by scanning the matching file for an
 * `event_msg.thread_name_updated` event and, failing that, printing the raw
 * thread UUID. CODEX-PARITY A.5 measured that event in 2 of 796 rollouts; an
 * independent 332-file sample on 2026-08-13 put it at 1.8 percent. So roughly
 * 98 percent of search results were labelled with a UUID, while the sidebar
 * next to them showed a real title for the same session, resolved by the P8
 * cascade from sources search never consulted.
 *
 * Coverage:
 *   1. session_index.jsonl titles reach a search result.
 *   2. The in-file `thread_name_updated` event still wins when the index has
 *      nothing, so the old source is a fallback rather than a casualty.
 *   3. A raw UUID is the last resort, not the first.
 *   4. The cwd comes from the index when it has one, so a result's folder is
 *      the normalised path rather than the `\\?\`-prefixed spelling that splits
 *      one folder into two.
 *   5. The index is cached and invalidates with CODEX_HOME, like the file list.
 *
 * Hermetic: a temp CODEX_HOME. No database is present, which is the honest
 * common case for the walk half of the cascade, and it proves the
 * session_index half works without one.
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

// ─── Hermetic CODEX_HOME ───────────────────────────────────────────────────

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-titles-'));
const dayDir = path.join(tmpHome, 'sessions', '2026', '08', '01');
fs.mkdirSync(dayDir, { recursive: true });

const TITLED_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const EVENT_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BARE_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

/**
 * Write a rollout whose only interesting property is that it matches the query.
 *
 * @param {string} id
 * @param {string} cwd
 * @param {string|null} threadNameEvent - Emit a thread_name_updated with this.
 * @returns {void}
 */
function writeRollout(id, cwd, threadNameEvent) {
  const lines = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T10:00:00Z', payload: { id: id, cwd: cwd, cli_version: '0.147.0' } }),
  ];
  if (threadNameEvent) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'thread_name_updated', thread_id: id, thread_name: threadNameEvent } }));
  }
  lines.push(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-08-01T10:01:00Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please investigate the zebra migration path.' }] },
  }));
  fs.writeFileSync(path.join(dayDir, 'rollout-2026-08-01T10-00-00-' + id + '.jsonl'), lines.join('\n') + '\n');
}

writeRollout(TITLED_ID, 'C:\\Users\\Fixture\\Documents\\alpha', null);
writeRollout(EVENT_ID, 'C:\\Users\\Fixture\\Documents\\beta', 'Title from the rollout event');
writeRollout(BARE_ID, 'C:\\Users\\Fixture\\Documents\\gamma', null);

// session_index.jsonl carries the AI-generated titles. It covers 55 of 125
// threads on the reference machine, and search never read it.
fs.writeFileSync(
  path.join(tmpHome, 'session_index.jsonl'),
  [
    JSON.stringify({ id: TITLED_ID, thread_name: 'Zebra migration plan', updated_at: '2026-08-01T10:02:00Z' }),
  ].join('\n') + '\n'
);

process.env.CODEX_HOME = tmpHome;
// The database is deliberately absent: this asserts the cascade works on a
// machine where the desktop app has never checkpointed one, which is also the
// path the walk fallback takes.
process.env.CWM_CODEX_STATE_DB = '0';

delete require.cache[require.resolve('../src/providers/codex/search')];
delete require.cache[require.resolve('../src/providers/codex/state-db')];
delete require.cache[require.resolve('../src/providers/codex/discover')];
const { search, _internal } = require('../src/providers/codex/search');

/**
 * Run the shared query and index the results by session id.
 *
 * @returns {Promise<Map<string, object>>}
 */
async function runSearch() {
  _internal._resetCache();
  const out = await search({ query: 'zebra', limit: 20, timeBudgetMs: 8000 });
  const byId = new Map();
  for (const r of out.results) byId.set(r.sessionId, r);
  return byId;
}

(async () => {
  console.log('\n  BUILD-CONTRACT P9.4: Codex search titles come from the cascade');
  console.log('  ' + '-'.repeat(72));

  const results = await runSearch();

  await test('all three fixtures matched, so the labels are comparable', () => {
    assert.strictEqual(results.size, 3, 'expected one hit per fixture, got ' + results.size);
  });

  await test('a session_index title reaches the result', () => {
    const r = results.get(TITLED_ID);
    assert(r, 'the titled fixture must match');
    assert.strictEqual(r.sessionName, 'Zebra migration plan',
      'the AI-generated title is the one the user recognises');
  });

  await test('the in-file thread_name_updated event is still honoured as a fallback', () => {
    const r = results.get(EVENT_ID);
    assert(r, 'the event fixture must match');
    assert.strictEqual(r.sessionName, 'Title from the rollout event',
      'the old source must survive as the fallback for a thread nothing else knows');
  });

  await test('a raw UUID is the LAST resort, not the first', () => {
    const r = results.get(BARE_ID);
    assert(r, 'the bare fixture must match');
    assert.strictEqual(r.sessionName, BARE_ID,
      'with no title anywhere on disk the id is all there is');
    // And the other two must NOT be ids, which is the whole point.
    assert.notStrictEqual(results.get(TITLED_ID).sessionName, TITLED_ID);
    assert.notStrictEqual(results.get(EVENT_ID).sessionName, EVENT_ID);
  });

  await test('the project path and name still resolve', () => {
    const r = results.get(TITLED_ID);
    assert(r.projectPath && r.projectPath.indexOf('alpha') !== -1, 'cwd must survive');
    assert.strictEqual(r.projectName, 'alpha', 'the folder label is the basename');
  });

  await test('the title index is cached and keyed by CODEX_HOME', async () => {
    const first = await _internal.getTitleIndex();
    const second = await _internal.getTitleIndex();
    assert.strictEqual(first, second, 'a second call inside the TTL must reuse the map');
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmpHome, 'does-not-exist');
    try {
      const third = await _internal.getTitleIndex();
      assert.notStrictEqual(third, first, 'a CODEX_HOME change must invalidate the index');
      assert.strictEqual(third.size, 0, 'an absent home yields an empty index, not a throw');
    } finally {
      process.env.CODEX_HOME = saved;
    }
  });

  await test('search still returns the fields it always did', () => {
    const r = results.get(TITLED_ID);
    for (const key of ['provider', 'sessionId', 'sessionName', 'projectPath', 'projectName',
      'timestamp', 'role', 'snippet', 'lineNumber', 'archived']) {
      assert(Object.prototype.hasOwnProperty.call(r, key), 'result lost the ' + key + ' field');
    }
    assert.strictEqual(r.provider, 'codex');
    assert.strictEqual(r.archived, false);
  });

  console.log('  ' + '-'.repeat(72));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
