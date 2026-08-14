#!/usr/bin/env node
/**
 * Tests for src/providers/codex/state-db.js
 * (BUILD-CONTRACT P8.2 / CODEX-PARITY P0-2, gaps B1 and B24).
 *
 * Coverage:
 *   1. Read-only discipline and the two independent guards that keep
 *      `logs_2.sqlite` (2.1 GB on the measured machine) out.
 *   2. Graceful degradation. Absence, a corrupt image, a missing table, a
 *      missing required column: every one returns null so the caller falls back
 *      to the filesystem walk. Nothing throws, ever.
 *   3. PRAGMA table_info per-column probing, so a column the Codex app removes
 *      costs one field rather than the whole discovery path.
 *   4. The visible-set predicate, including the specific trap that filtering on
 *      thread_source instead of the spawn edge deletes real user threads.
 *   5. The title cascade, as a pure function, in full precedence order.
 *   6. Rollout path resolution, including a path outside CODEX_HOME, which is
 *      the case the filesystem walk can never reach.
 *   7. The WAL overlay: frame walking, the commit boundary, torn-frame
 *      rejection, and every bail-out. Plus an end-to-end oracle check against
 *      node:sqlite when this runtime has it.
 *
 * HERMETIC. Every database in this file is synthesised in a temp directory from
 * invented data. No real user path, title, session id or transcript is read or
 * committed. The real ~/.codex is never touched: the suite must not depend on
 * the machine it runs on, and a real-corpus scan hangs npm test.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 green / 1 red.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Assertion helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

async function runAll() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('    \x1b[31m' + (err && err.stack ? err.stack.split('\n')[0] : err) + '\x1b[0m');
    }
  }
}

function section(name) {
  test('\x1b[0m\x1b[1m-- ' + name + '\x1b[0m', () => {});
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)
    );
  }
}

// ─── Module require ────────────────────────────────────────────────────────

let stateDb;
try {
  stateDb = require('../src/providers/codex/state-db');
} catch (err) {
  console.error('FATAL: could not require src/providers/codex/state-db.js: ' + err.message);
  process.exit(1);
}

const {
  isAvailable,
  invalidate,
  listThreads,
  resolveRolloutPath,
  resolveRolloutPathSync,
  listSpawnEdges,
  resolveTitle,
  truncatePreview,
  getDiagnostics,
  TITLE_SOURCES,
  PERMITTED_DATABASE_FILENAMES,
  MAX_DATABASE_BYTES,
  UNTITLED_LABEL,
  STATE_DB_FILENAME,
  _internal,
} = stateDb;

const { applyWalOverlay, assertPermittedDatabase, buildThreadQuery, readDbPageSize } = _internal;

// ─── Fixture construction (fully synthetic, fully sanitised) ───────────────

const TEMP_DIRS = [];

/** Create a throwaway directory that is cleaned up at the end of the run. */
function makeTempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-codex-statedb-test-' + tag + '-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Remove every temp directory this run created. */
function cleanupTempDirs() {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
}

/**
 * The invented thread rows. Every path, id and piece of text here is made up.
 * The SHAPE mirrors the real `threads` table; the CONTENT does not mirror
 * anything on the user's disk.
 */
const FIXTURE_THREADS = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'plain visible thread',
    cwd: 'C:\\work\\alpha',
    preview: 'Add a retry to the uploader',
    title: 'Add a retry to the uploader and then explain the tradeoffs at length',
    archived: 0,
    thread_source: 'user',
    recency_at_ms: 5000,
    spawnChild: false,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    label: 'same folder, extended-length spelling',
    cwd: '\\\\?\\C:\\work\\alpha',
    preview: 'Rename the config loader',
    title: 'Rename the config loader',
    archived: 0,
    thread_source: 'user',
    recency_at_ms: 4000,
    spawnChild: false,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    label: 'archived thread',
    cwd: 'C:\\work\\beta',
    preview: 'Old investigation',
    title: 'Old investigation',
    archived: 1,
    thread_source: 'user',
    recency_at_ms: 3000,
    spawnChild: false,
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    label: 'empty preview, treated as not visible',
    cwd: 'C:\\work\\beta',
    preview: '',
    title: 'Never surfaced',
    archived: 0,
    thread_source: 'user',
    recency_at_ms: 2000,
    spawnChild: false,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    label: 'spawn child, excluded by the edge',
    cwd: 'C:\\work\\alpha',
    preview: 'Explore the parser',
    title: 'Explore the parser',
    archived: 0,
    thread_source: 'subagent',
    recency_at_ms: 6000,
    spawnChild: true,
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    label: 'thread_source=subagent but NOT a spawn child: must be INCLUDED',
    cwd: 'C:\\work\\gamma',
    preview: 'Guardian sweep of the release branch',
    title: 'Guardian sweep of the release branch',
    archived: 0,
    thread_source: 'subagent',
    recency_at_ms: 7000,
    spawnChild: false,
  },
];

/** Column definitions for the synthetic `threads` table, in real-schema order. */
const FIXTURE_THREAD_COLUMNS = [
  ['id', 'TEXT'],
  ['rollout_path', 'TEXT'],
  ['cwd', 'TEXT'],
  ['title', 'TEXT'],
  ['preview', 'TEXT'],
  ['name', 'TEXT'],
  ['archived', 'INTEGER'],
  ['is_pinned', 'INTEGER'],
  ['thread_section_id', 'TEXT'],
  ['recency_at_ms', 'INTEGER'],
  ['created_at_ms', 'INTEGER'],
  ['updated_at_ms', 'INTEGER'],
  ['tokens_used', 'INTEGER'],
  ['model', 'TEXT'],
  ['reasoning_effort', 'TEXT'],
  ['cli_version', 'TEXT'],
  ['git_branch', 'TEXT'],
  ['thread_source', 'TEXT'],
  ['agent_nickname', 'TEXT'],
  ['agent_role', 'TEXT'],
];

let SQL = null;

/**
 * Build a synthetic state_5-shaped database and return its bytes.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.omitColumns] - Columns to leave out, to simulate the
 *   schema drift the real table already shows scars of.
 * @param {boolean} [opts.omitThreadsTable] - Build a database with no `threads`.
 * @param {boolean} [opts.omitSpawnTable] - Build without `thread_spawn_edges`.
 * @param {string} [opts.rolloutRoot] - Directory the rollout paths point into.
 * @returns {Buffer}
 */
function buildFixtureDatabase(opts) {
  const options = opts || {};
  const omit = new Set(options.omitColumns || []);
  const db = new SQL.Database();

  if (!options.omitThreadsTable) {
    const cols = FIXTURE_THREAD_COLUMNS.filter(([name]) => !omit.has(name));
    db.run('CREATE TABLE threads (' + cols.map(([n, t]) => n + ' ' + t).join(', ') + ')');
    for (const row of FIXTURE_THREADS) {
      const values = cols.map(([name]) => {
        switch (name) {
          case 'id':
            return row.id;
          case 'rollout_path':
            return options.rolloutRoot
              ? path.join(options.rolloutRoot, 'rollout-' + row.id + '.jsonl')
              : null;
          case 'cwd':
            return row.cwd;
          case 'title':
            return row.title;
          case 'preview':
            return row.preview;
          case 'name':
            return null;
          case 'archived':
            return row.archived;
          case 'is_pinned':
            return 0;
          case 'thread_section_id':
            return null;
          case 'recency_at_ms':
            return row.recency_at_ms;
          case 'created_at_ms':
            return row.recency_at_ms - 100;
          case 'updated_at_ms':
            return row.recency_at_ms;
          case 'tokens_used':
            return 1234;
          case 'model':
            return 'synthetic-model-1';
          case 'reasoning_effort':
            return 'ultra';
          case 'cli_version':
            return '0.0.0-fixture';
          case 'git_branch':
            return 'fixture-branch';
          case 'thread_source':
            return row.thread_source;
          case 'agent_nickname':
            return null;
          case 'agent_role':
            return null;
          default:
            return null;
        }
      });
      db.run(
        'INSERT INTO threads (' + cols.map(([n]) => n).join(', ') + ') VALUES (' +
          cols.map(() => '?').join(', ') + ')',
        values
      );
    }
  }

  if (!options.omitSpawnTable) {
    db.run(
      'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)'
    );
    for (const row of FIXTURE_THREADS) {
      if (!row.spawnChild) continue;
      db.run('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)', [
        FIXTURE_THREADS[0].id,
        row.id,
        'done',
      ]);
    }
  }

  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
}

/**
 * Stage a CODEX_HOME containing a synthetic database, plus the rollout files
 * the paths point at.
 *
 * @param {Object} [opts] - Forwarded to buildFixtureDatabase.
 * @returns {{home: string, dbPath: string, rolloutRoot: string}}
 */
function stageCodexHome(opts) {
  const home = makeTempDir('home');
  const rolloutRoot = path.join(home, 'sessions');
  fs.mkdirSync(rolloutRoot, { recursive: true });
  const bytes = buildFixtureDatabase(Object.assign({ rolloutRoot: rolloutRoot }, opts || {}));
  const dbPath = path.join(home, STATE_DB_FILENAME);
  fs.writeFileSync(dbPath, bytes);
  for (const row of FIXTURE_THREADS) {
    fs.writeFileSync(path.join(rolloutRoot, 'rollout-' + row.id + '.jsonl'), '{}\n');
  }
  return { home: home, dbPath: dbPath, rolloutRoot: rolloutRoot };
}

/** Point CODEX_HOME at a directory, run a function, restore it afterwards. */
async function withCodexHome(home, fn) {
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  invalidate();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    invalidate();
  }
}

// ─── 1. Read-only discipline and the forbidden database ────────────────────

section('read-only discipline: the 2.1 GB log database can never be opened');

test('logs_2.sqlite is not on the allow-list', () => {
  assert(!PERMITTED_DATABASE_FILENAMES.has('logs_2.sqlite'), 'logs_2.sqlite must never be permitted');
  assert(PERMITTED_DATABASE_FILENAMES.has(STATE_DB_FILENAME), 'the thread store must be permitted');
  assert(PERMITTED_DATABASE_FILENAMES.has('codex-dev.db'), 'the catalog must be permitted');
});

test('assertPermittedDatabase refuses a forbidden name even when the file exists', () => {
  const dir = makeTempDir('forbidden');
  const forbidden = path.join(dir, 'logs_2.sqlite');
  fs.writeFileSync(forbidden, Buffer.alloc(4096, 1));
  assertEqual(assertPermittedDatabase(forbidden), false, 'name guard must reject');
});

test('assertPermittedDatabase refuses an unknown name, a directory and a missing path', () => {
  const dir = makeTempDir('shapes');
  const unknown = path.join(dir, 'something_else.sqlite');
  fs.writeFileSync(unknown, Buffer.alloc(4096, 1));
  assertEqual(assertPermittedDatabase(unknown), false);
  assertEqual(assertPermittedDatabase(dir), false, 'a directory is not a database');
  assertEqual(assertPermittedDatabase(path.join(dir, STATE_DB_FILENAME)), false, 'missing file');
  assertEqual(assertPermittedDatabase(null), false);
  assertEqual(assertPermittedDatabase(''), false);
  assertEqual(assertPermittedDatabase(42), false);
});

test('assertPermittedDatabase refuses a file too small to carry a SQLite header', () => {
  const dir = makeTempDir('tiny');
  const tiny = path.join(dir, STATE_DB_FILENAME);
  fs.writeFileSync(tiny, 'not a database');
  assertEqual(assertPermittedDatabase(tiny), false);
});

test('the size ceiling sits decisively between the state store and the log store', () => {
  const observedStateDbBytes = 24 * 1024 * 1024; // ~23.3 MB measured
  const observedLogDbBytes = 2.1 * 1024 * 1024 * 1024; // 2.1 GB measured
  assert(MAX_DATABASE_BYTES > observedStateDbBytes * 2, 'ceiling must allow natural growth');
  assert(MAX_DATABASE_BYTES < observedLogDbBytes, 'ceiling must exclude the log database');
});

// ─── 2. Graceful degradation ───────────────────────────────────────────────

section('graceful degradation: every failure returns null, nothing throws');

test('a CODEX_HOME that does not exist yields null, not an exception', async () => {
  const missing = path.join(makeTempDir('gone'), 'no-such-dir');
  await withCodexHome(missing, async () => {
    assertEqual(isAvailable(), false);
    assertEqual(await listThreads(), null);
    assertEqual(await resolveRolloutPath('00000000-0000-4000-8000-000000000001'), null);
    assertEqual(await listSpawnEdges(), null);
  });
});

test('a CODEX_HOME with no database yields null', async () => {
  const home = makeTempDir('empty-home');
  await withCodexHome(home, async () => {
    assertEqual(isAvailable(), false);
    assertEqual(await listThreads(), null);
  });
});

test('a corrupt image yields null rather than throwing', async () => {
  const home = makeTempDir('corrupt');
  // Large enough to pass the size floor, but not a SQLite file.
  fs.writeFileSync(path.join(home, STATE_DB_FILENAME), Buffer.alloc(8192, 0x5a));
  await withCodexHome(home, async () => {
    assertEqual(isAvailable(), true, 'the guard passes: it checks size and name, not content');
    assertEqual(await listThreads(), null, 'the read must degrade');
  });
});

test('a truncated database yields null rather than throwing', async () => {
  const home = makeTempDir('truncated');
  const staged = stageCodexHome();
  const full = fs.readFileSync(staged.dbPath);
  fs.writeFileSync(path.join(home, STATE_DB_FILENAME), full.subarray(0, 3000));
  await withCodexHome(home, async () => {
    const result = await listThreads();
    assert(result === null || Array.isArray(result), 'must be null or a list, never a throw');
  });
});

test('a database with no threads table yields null', async () => {
  const staged = stageCodexHome({ omitThreadsTable: true });
  await withCodexHome(staged.home, async () => {
    assertEqual(await listThreads(), null);
  });
});

test('a threads table missing the id column yields null, because it is unrecognisable', async () => {
  const staged = stageCodexHome({ omitColumns: ['id'] });
  await withCodexHome(staged.home, async () => {
    assertEqual(await listThreads(), null);
  });
});

// ─── 3. PRAGMA table_info per-column probing ───────────────────────────────

section('schema drift: a missing column costs one field, not the whole path');

test('a threads table without is_pinned still lists threads', async () => {
  const staged = stageCodexHome({ omitColumns: ['is_pinned'] });
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    assert(Array.isArray(rows), 'must still return rows');
    assert(rows.length > 0);
    assertEqual(rows[0].isPinned, false, 'the field degrades to false');
    const diag = getDiagnostics();
    assert(
      diag.capabilities.missingColumns.indexOf('is_pinned') !== -1,
      'the missing column is reported'
    );
  });
});

test('a threads table without preview drops the visibility filter but keeps the rows', async () => {
  const staged = stageCodexHome({ omitColumns: ['preview'] });
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    assert(Array.isArray(rows));
    const diag = getDiagnostics();
    assertEqual(diag.capabilities.previewFilter, false, 'the filter must be reported as inactive');
    assertEqual(diag.capabilities.archivedFilter, true, 'the other filters keep working');
  });
});

test('a database without thread_spawn_edges keeps discovery working', async () => {
  const staged = stageCodexHome({ omitSpawnTable: true });
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    assert(Array.isArray(rows));
    const diag = getDiagnostics();
    assertEqual(diag.capabilities.spawnFilter, false);
    // With no edge table, the spawn child is no longer excluded.
    assert(
      rows.some((r) => r.id === '00000000-0000-4000-8000-000000000005'),
      'without the edge table the child cannot be identified, so it is included'
    );
  });
});

test('buildThreadQuery selects only present columns and never emits SELECT *', () => {
  const columns = new Set(['id', 'cwd', 'preview', 'archived', 'recency_at_ms']);
  const query = buildThreadQuery(columns, new Set(['threads']), new Set(), {
    includeArchived: false,
    includeSpawnChildren: false,
    includeHidden: false,
  });
  assert(query, 'query must build');
  assert(query.sql.indexOf('SELECT *') === -1, 'named columns only');
  assert(query.sql.indexOf('rollout_path') === -1, 'absent columns must not be selected');
  assert(query.sql.indexOf('ORDER BY recency_at_ms DESC') !== -1);
  assertEqual(query.capabilities.spawnFilter, false, 'no edge table means no spawn filter');
});

test('buildThreadQuery returns null when the required id column is absent', () => {
  const query = buildThreadQuery(new Set(['cwd']), new Set(['threads']), new Set(), {
    includeArchived: false,
    includeSpawnChildren: false,
    includeHidden: false,
  });
  assertEqual(query, null);
});

test('buildThreadQuery falls back through the recency column preference', () => {
  const columns = new Set(['id', 'updated_at_ms']);
  const query = buildThreadQuery(columns, new Set(['threads']), new Set(), {
    includeArchived: true,
    includeSpawnChildren: true,
    includeHidden: true,
  });
  assertEqual(query.capabilities.orderColumn, 'updated_at_ms');
  const noOrder = buildThreadQuery(new Set(['id']), new Set(['threads']), new Set(), {
    includeArchived: true,
    includeSpawnChildren: true,
    includeHidden: true,
  });
  assertEqual(noOrder.capabilities.orderColumn, null);
  assert(noOrder.sql.indexOf('ORDER BY') === -1, 'no order column means no ORDER BY clause');
});

// ─── 4. The visible-set predicate ──────────────────────────────────────────

section('the visible set: archived = 0, preview non-empty, and NOT a spawn child');

test('the default projection excludes archived, empty-preview and spawn-child rows', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    const ids = rows.map((r) => r.id);
    assert(ids.indexOf('00000000-0000-4000-8000-000000000001') !== -1, 'plain visible thread');
    assert(ids.indexOf('00000000-0000-4000-8000-000000000002') !== -1, 'prefixed-cwd thread');
    assert(ids.indexOf('00000000-0000-4000-8000-000000000003') === -1, 'archived must be excluded');
    assert(ids.indexOf('00000000-0000-4000-8000-000000000004') === -1, 'empty preview excluded');
    assert(ids.indexOf('00000000-0000-4000-8000-000000000005') === -1, 'spawn child excluded');
  });
});

test('a thread_source=subagent row that is NOT a spawn child is INCLUDED', async () => {
  // This is the trap: 55 of the 125 real top-level threads carry
  // thread_source = 'subagent' yet are not spawn children. Filtering on the
  // column instead of the edge would delete them from the sidebar.
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    const guardian = rows.find((r) => r.id === '00000000-0000-4000-8000-000000000006');
    assert(guardian, 'the non-spawned subagent thread must survive the filter');
    assertEqual(guardian.threadSource, 'subagent');
  });
});

test('includeArchived widens the set without disturbing the default', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const base = await listThreads();
    const widened = await listThreads({ includeArchived: true });
    assert(widened.length > base.length, 'archived rows must appear');
    assert(
      widened.some((r) => r.id === '00000000-0000-4000-8000-000000000003' && r.archived === true),
      'and be flagged archived'
    );
    const again = await listThreads();
    assertEqual(again.length, base.length, 'the default projection is not polluted by the widened one');
  });
});

test('includeSpawnChildren and includeHidden each widen exactly one dimension', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const children = await listThreads({ includeSpawnChildren: true });
    assert(children.some((r) => r.id === '00000000-0000-4000-8000-000000000005'));
    assert(!children.some((r) => r.id === '00000000-0000-4000-8000-000000000004'), 'hidden stays out');

    const hidden = await listThreads({ includeHidden: true });
    assert(hidden.some((r) => r.id === '00000000-0000-4000-8000-000000000004'));
    assert(!hidden.some((r) => r.id === '00000000-0000-4000-8000-000000000005'), 'children stay out');
  });
});

test('results are ordered by recency descending', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    for (let i = 1; i < rows.length; i++) {
      assert(
        rows[i - 1].recencyAtMs >= rows[i].recencyAtMs,
        'row ' + i + ' broke the recency ordering'
      );
    }
  });
});

// ─── 5. Normalization integration ──────────────────────────────────────────

section('normalization: two spellings of one directory become one folder');

test('the extended-length spelling normalizes and shares a grouping key', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    const plain = rows.find((r) => r.id === '00000000-0000-4000-8000-000000000001');
    const prefixed = rows.find((r) => r.id === '00000000-0000-4000-8000-000000000002');
    assertEqual(prefixed.cwdRaw, '\\\\?\\C:\\work\\alpha', 'the raw value is preserved for debugging');
    assertEqual(prefixed.cwd, 'C:\\work\\alpha', 'the display value is normalized');
    assertEqual(plain.projectKey, prefixed.projectKey, 'one directory, one grouping key');
    assertEqual(plain.projectId, prefixed.projectId, 'and one project id');
    assertEqual(prefixed.projectDisplayName, 'alpha');
  });
});

test('every row carries the full project descriptor the frontend needs', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    for (const row of rows) {
      assert(typeof row.id === 'string' && row.id.length > 0, 'id');
      assert(typeof row.projectKey === 'string', 'projectKey');
      assert(typeof row.projectId === 'string' && row.projectId.indexOf('codex:') === 0, 'projectId');
      assert(typeof row.projectDisplayName === 'string', 'projectDisplayName');
      assert(row.titleParts && typeof row.titleParts === 'object', 'titleParts');
      assertEqual(row.id, row.id.toLowerCase(), 'ids are lowercased for map keys');
    }
  });
});

// ─── 6. The title cascade ──────────────────────────────────────────────────

section('the title cascade, in precedence order');

test('the catalog title wins over everything', () => {
  const r = resolveTitle({
    catalogTitle: 'Catalog wins',
    name: 'User rename',
    indexTitle: 'Index title',
    rolloutTitle: 'Rollout title',
    preview: 'Preview text',
    title: 'Raw first message',
  });
  assertEqual(r.title, 'Catalog wins');
  assertEqual(r.source, TITLE_SOURCES.CATALOG);
});

test('each step yields to the next when empty, in the documented order', () => {
  const parts = {
    catalogTitle: null,
    name: 'User rename',
    indexTitle: 'Index title',
    rolloutTitle: 'Rollout title',
    preview: 'Preview text',
    title: 'Raw first message',
  };
  assertEqual(resolveTitle(parts).source, TITLE_SOURCES.NAME);
  parts.name = null;
  assertEqual(resolveTitle(parts).source, TITLE_SOURCES.SESSION_INDEX);
  parts.indexTitle = null;
  assertEqual(resolveTitle(parts).source, TITLE_SOURCES.ROLLOUT_EVENT);
  parts.rolloutTitle = null;
  assertEqual(resolveTitle(parts).source, TITLE_SOURCES.PREVIEW);
  parts.preview = null;
  assertEqual(resolveTitle(parts).source, TITLE_SOURCES.TITLE_FALLBACK);
  parts.title = null;
  assertEqual(resolveTitle(parts).source, TITLE_SOURCES.NONE);
  assertEqual(resolveTitle(parts).title, UNTITLED_LABEL);
});

test('whitespace-only candidates are treated as empty, not as a title', () => {
  const r = resolveTitle({ catalogTitle: '   ', name: '\n\t', indexTitle: 'Real title' });
  assertEqual(r.source, TITLE_SOURCES.SESSION_INDEX);
});

test('resolveTitle never throws and always returns a non-empty string', () => {
  const inputs = [undefined, null, {}, { preview: 12345 }, { title: {} }, { preview: [] }];
  for (const input of inputs) {
    const r = resolveTitle(input);
    assert(typeof r.title === 'string' && r.title.length > 0, 'input ' + JSON.stringify(input));
    assert(typeof r.source === 'string' && r.source.length > 0);
  }
});

test('truncatePreview collapses whitespace, breaks on a word boundary and ellipsises', () => {
  assertEqual(truncatePreview('short one'), 'short one', 'under the limit passes through');
  assertEqual(truncatePreview('  a\n\n  b   c  '), 'a b c', 'whitespace collapses');
  const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';
  const cut = truncatePreview(long);
  assert(cut.length <= 61, 'result stays near the limit, got ' + cut.length);
  assert(cut.endsWith('\u2026'), 'result is ellipsised');
  assert(cut.indexOf('  ') === -1, 'no doubled spaces survive');
  assertEqual(truncatePreview(''), null);
  assertEqual(truncatePreview(null), null);
  assertEqual(truncatePreview('   '), null);
});

test('a very long raw first message is never returned whole', () => {
  // threads.title is the raw first user message. One real row is 12 KB.
  const huge = 'x'.repeat(12000);
  const r = resolveTitle({ title: huge });
  assert(r.title.length < 100, 'a 12 KB label must never reach the UI, got ' + r.title.length);
  assertEqual(r.source, TITLE_SOURCES.TITLE_FALLBACK);
});

test('the fixture rows resolve through the cascade to a preview-derived title', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const rows = await listThreads();
    const row = rows.find((r) => r.id === '00000000-0000-4000-8000-000000000001');
    const resolved = resolveTitle(row.titleParts);
    assertEqual(resolved.source, TITLE_SOURCES.PREVIEW);
    assertEqual(resolved.title, 'Add a retry to the uploader');
  });
});

// ─── 7. Rollout path resolution ────────────────────────────────────────────

section('rollout path resolution replaces the O(n) walk');

test('resolveRolloutPath returns the recorded path when the file exists', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const found = await resolveRolloutPath('00000000-0000-4000-8000-000000000001');
    assert(found, 'must resolve');
    assert(fs.existsSync(found), 'must point at a real file');
    assertEqual(path.basename(found), 'rollout-00000000-0000-4000-8000-000000000001.jsonl');
  });
});

test('resolveRolloutPath is case-insensitive on the thread id', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const upper = await resolveRolloutPath('00000000-0000-4000-8000-000000000001'.toUpperCase());
    assert(upper, 'an uppercased id must still resolve');
  });
});

test('resolveRolloutPath returns null for an unknown id and for junk input', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    assertEqual(await resolveRolloutPath('not-a-real-id'), null);
    assertEqual(await resolveRolloutPath(''), null);
    assertEqual(await resolveRolloutPath(null), null);
    assertEqual(await resolveRolloutPath({}), null);
  });
});

test('a recorded path whose file is gone resolves to null, never to a dead path', async () => {
  const staged = stageCodexHome();
  fs.unlinkSync(path.join(staged.rolloutRoot, 'rollout-' + FIXTURE_THREADS[0].id + '.jsonl'));
  await withCodexHome(staged.home, async () => {
    assertEqual(await resolveRolloutPath(FIXTURE_THREADS[0].id), null);
  });
});

test('a rollout stored OUTSIDE CODEX_HOME still resolves', async () => {
  // The case the filesystem walk can never reach: two real threads live under
  // a different drive entirely. Trusting the recorded path fixes it for free.
  const outside = makeTempDir('archive-elsewhere');
  const home = makeTempDir('home-with-external-rollouts');
  const bytes = buildFixtureDatabase({ rolloutRoot: outside });
  fs.writeFileSync(path.join(home, STATE_DB_FILENAME), bytes);
  for (const row of FIXTURE_THREADS) {
    fs.writeFileSync(path.join(outside, 'rollout-' + row.id + '.jsonl'), '{}\n');
  }
  await withCodexHome(home, async () => {
    const found = await resolveRolloutPath(FIXTURE_THREADS[0].id);
    assert(found, 'must resolve a path outside CODEX_HOME');
    assert(
      found.toLowerCase().indexOf(home.toLowerCase()) === -1,
      'the resolved path must genuinely be outside CODEX_HOME'
    );
    assert(fs.existsSync(found));
  });
});

test('the synchronous lookup answers from cache only, and never before a read', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    invalidate();
    assertEqual(
      resolveRolloutPathSync(FIXTURE_THREADS[0].id),
      null,
      'a cold cache must answer null so the caller falls back to the walk'
    );
    await listThreads();
    const warm = resolveRolloutPathSync(FIXTURE_THREADS[0].id);
    assert(warm, 'after a read the sync lookup answers');
    assert(fs.existsSync(warm));
  });
});

test('the cwd index finds every thread in a directory, in either spelling', async () => {
  // This is the index behind findArtifactByWorkingDir, whose original
  // implementation opened and read 256 KB of every rollout on disk to recover
  // the cwd: 2923 file opens per call on the measured machine.
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    assertEqual(
      stateDb.resolveThreadsByCwdSync('C:\\work\\alpha').length,
      0,
      'a cold cache must answer empty so the caller keeps its own fallback'
    );
    await listThreads({ includeArchived: true });

    const plain = stateDb.resolveThreadsByCwdSync('C:\\work\\alpha');
    const ids = plain.map((m) => m.id).sort();
    assert(ids.indexOf('00000000-0000-4000-8000-000000000001') !== -1, 'plain-spelling thread');
    assert(ids.indexOf('00000000-0000-4000-8000-000000000002') !== -1, 'prefixed-spelling thread');
    assert(
      ids.indexOf('00000000-0000-4000-8000-000000000005') !== -1,
      'the census covers spawn children too, because "where is this transcript" ' +
        'is independent of whether the thread belongs in the sidebar'
    );
    for (const match of plain) assert(match.rolloutPath, 'each match carries its rollout path');

    // Every spelling of the same directory must find the same threads.
    for (const spelling of ['\\\\?\\C:\\work\\alpha', 'C:\\work\\alpha\\', 'c:/work/ALPHA']) {
      assertEqual(
        stateDb.resolveThreadsByCwdSync(spelling).length,
        plain.length,
        'spelling ' + JSON.stringify(spelling) + ' must match the same threads'
      );
    }
    assertEqual(stateDb.resolveThreadsByCwdSync('C:\\work\\nowhere').length, 0);
    assertEqual(stateDb.resolveThreadsByCwdSync(null).length, 0);
    assertEqual(stateDb.resolveThreadsByCwdSync('').length, 0);
  });
});

test('the census indexes ALL threads, not just the visible projection', async () => {
  // Restricting the rollout index to the visible set silently pushed archived
  // threads and spawn children back onto the 330ms-per-lookup walk.
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    await listThreads(); // default projection only
    for (const row of FIXTURE_THREADS) {
      assert(
        resolveRolloutPathSync(row.id),
        'the rollout index must answer for ' + row.label + ', which the default projection excludes'
      );
    }
    assertEqual(getDiagnostics().knownThreadCount, FIXTURE_THREADS.length);
  });
});

test('spawn edges are listed, and filtered by parent', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const all = await listSpawnEdges();
    assert(Array.isArray(all) && all.length === 1, 'one synthetic edge');
    assertEqual(all[0].childThreadId, '00000000-0000-4000-8000-000000000005');
    const filtered = await listSpawnEdges(FIXTURE_THREADS[0].id);
    assertEqual(filtered.length, 1);
    const none = await listSpawnEdges('00000000-0000-4000-8000-00000000ffff');
    assertEqual(none.length, 0);
  });
});

// ─── 8. Caching ────────────────────────────────────────────────────────────

section('caching bounds the cost without going stale');

test('a warm read returns the same rows and invalidate clears them', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const first = await listThreads();
    const second = await listThreads();
    assertEqual(first, second, 'the warm read returns the cached array itself');
    assert(getDiagnostics().cachedThreadCount > 0);
    invalidate();
    assertEqual(getDiagnostics().cachedThreadCount, 0);
    const third = await listThreads();
    assert(third !== second, 'after invalidation a fresh array is produced');
    assertEqual(third.length, second.length);
  });
});

test('force bypasses the cache', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    const first = await listThreads();
    const forced = await listThreads({ force: true });
    assert(forced !== first, 'force must re-read');
    assertEqual(forced.length, first.length);
  });
});

test('diagnostics report state without leaking any user content', async () => {
  const staged = stageCodexHome();
  await withCodexHome(staged.home, async () => {
    await listThreads();
    const diag = getDiagnostics();
    const serialised = JSON.stringify(diag);
    // The fixture's own invented content must not appear in diagnostics.
    for (const needle of ['Add a retry', 'Guardian sweep', 'work\\\\alpha', 'Old investigation']) {
      assert(serialised.indexOf(needle) === -1, 'diagnostics leaked: ' + needle);
    }
    assert(typeof diag.available === 'boolean');
    assert(typeof diag.cachedThreadCount === 'number');
    assert(diag.capabilities && typeof diag.capabilities === 'object');
  });
});

// ─── 9. The WAL overlay ────────────────────────────────────────────────────

section('the WAL overlay: committed frames are seen, torn frames are not');

const OVERLAY_PAGE_SIZE = 4096;

/** Build a minimal but structurally valid main-database image. */
function makeDbImage(pageCount) {
  const image = Buffer.alloc(pageCount * OVERLAY_PAGE_SIZE, 0x11);
  image.write('SQLite format 3\0', 0, 'latin1');
  image.writeUInt16BE(OVERLAY_PAGE_SIZE, 16);
  return image;
}

/**
 * Build a syntactically valid WAL over a set of frames, using the same
 * checksum routine the module uses. This exercises frame walking, salt
 * matching, the commit boundary and page application; the checksum function
 * itself is validated externally by the node:sqlite oracle test below.
 *
 * @param {Array<{page:number, fill:number, commitSize:number}>} frames
 * @param {Object} [opts]
 * @param {number} [opts.magic]
 * @param {number} [opts.salt1]
 * @param {number} [opts.salt2]
 * @returns {Buffer}
 */
function makeWal(frames, opts) {
  const options = opts || {};
  const magic = options.magic != null ? options.magic : 0x377f0682;
  const salt1 = options.salt1 != null ? options.salt1 : 0xaabbccdd;
  const salt2 = options.salt2 != null ? options.salt2 : 0x11223344;
  const bigEndian = (magic & 1) === 1;

  const header = Buffer.alloc(32);
  header.writeUInt32BE(magic >>> 0, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(options.pageSize != null ? options.pageSize : OVERLAY_PAGE_SIZE, 8);
  header.writeUInt32BE(1, 12);
  header.writeUInt32BE(salt1 >>> 0, 16);
  header.writeUInt32BE(salt2 >>> 0, 20);
  const [h0, h1] = _internal.walChecksum(header.subarray(0, 24), bigEndian, 0, 0);
  header.writeUInt32BE(h0, 24);
  header.writeUInt32BE(h1, 28);

  const parts = [header];
  let running0 = h0;
  let running1 = h1;
  for (const frame of frames) {
    const fh = Buffer.alloc(24);
    fh.writeUInt32BE(frame.page, 0);
    fh.writeUInt32BE(frame.commitSize || 0, 4);
    fh.writeUInt32BE(frame.salt1 != null ? frame.salt1 >>> 0 : salt1 >>> 0, 8);
    fh.writeUInt32BE(frame.salt2 != null ? frame.salt2 >>> 0 : salt2 >>> 0, 12);
    const data = Buffer.alloc(OVERLAY_PAGE_SIZE, frame.fill);
    let [c0, c1] = _internal.walChecksum(fh.subarray(0, 8), bigEndian, running0, running1);
    [c0, c1] = _internal.walChecksum(data, bigEndian, c0, c1);
    if (frame.corruptChecksum) c0 = (c0 ^ 0xffffffff) >>> 0;
    fh.writeUInt32BE(c0, 16);
    fh.writeUInt32BE(c1, 20);
    running0 = c0;
    running1 = c1;
    parts.push(fh, data);
  }
  return Buffer.concat(parts);
}

test('readDbPageSize decodes the header, including the 65536 encoding', () => {
  assertEqual(readDbPageSize(makeDbImage(2)), OVERLAY_PAGE_SIZE);
  const big = makeDbImage(1);
  big.writeUInt16BE(1, 16);
  assertEqual(readDbPageSize(big), 65536);
  const bad = makeDbImage(1);
  bad.writeUInt16BE(300, 16); // not a power of two, below the floor
  assertEqual(readDbPageSize(bad), null);
  assertEqual(readDbPageSize(Buffer.alloc(10)), null);
  assertEqual(readDbPageSize(null), null);
});

test('a committed frame is applied at the correct byte offset', () => {
  const db = makeDbImage(3);
  const wal = makeWal([{ page: 2, fill: 0xaa, commitSize: 3 }]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.reason, 'ok');
  assertEqual(result.applied, 1);
  assertEqual(result.image[OVERLAY_PAGE_SIZE], 0xaa, 'page 2 must carry the new bytes');
  // Offset 200 is inside page 1 but past the 100-byte SQLite file header that
  // makeDbImage writes, so it is a fill byte and a valid untouched-ness probe.
  assertEqual(result.image[200], 0x11, 'page 1 must be untouched');
  assertEqual(result.image[OVERLAY_PAGE_SIZE * 2], 0x11, 'page 3 must be untouched');
  assertEqual(db[OVERLAY_PAGE_SIZE], 0x11, 'the input image must not be mutated');
});

test('the last write to a page wins', () => {
  const db = makeDbImage(2);
  const wal = makeWal([
    { page: 2, fill: 0xaa, commitSize: 0 },
    { page: 2, fill: 0xbb, commitSize: 2 },
  ]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.reason, 'ok');
  assertEqual(result.image[OVERLAY_PAGE_SIZE], 0xbb);
});

test('frames after the last commit are NOT applied', () => {
  const db = makeDbImage(3);
  const wal = makeWal([
    { page: 2, fill: 0xaa, commitSize: 3 },
    { page: 3, fill: 0xcc, commitSize: 0 }, // an in-flight transaction
  ]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.applied, 1, 'only the committed frame is durable');
  assertEqual(result.image[OVERLAY_PAGE_SIZE], 0xaa);
  assertEqual(result.image[OVERLAY_PAGE_SIZE * 2], 0x11, 'the uncommitted page must not appear');
});

test('a torn frame ends the replay rather than corrupting the image', () => {
  const db = makeDbImage(3);
  const wal = makeWal([
    { page: 2, fill: 0xaa, commitSize: 3 },
    { page: 3, fill: 0xcc, commitSize: 3, corruptChecksum: true },
  ]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.applied, 1, 'replay stops at the torn frame');
  assertEqual(result.image[OVERLAY_PAGE_SIZE * 2], 0x11);
});

test('a frame from the next checkpoint generation ends the replay', () => {
  const db = makeDbImage(3);
  const wal = makeWal([
    { page: 2, fill: 0xaa, commitSize: 3 },
    { page: 3, fill: 0xcc, commitSize: 3, salt1: 0xdeadbeef },
  ]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.applied, 1, 'a salt change means a new generation');
});

test('the commit page count truncates the image', () => {
  const db = makeDbImage(4);
  const wal = makeWal([{ page: 1, fill: 0xaa, commitSize: 2 }]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.reason, 'ok');
  assertEqual(result.image.length, 2 * OVERLAY_PAGE_SIZE, 'a shrinking commit must shrink the image');
});

test('every bail-out returns the untouched image with a diagnostic reason', () => {
  const db = makeDbImage(2);
  const cases = [
    [Buffer.alloc(0), 'wal-absent-or-too-small'],
    [Buffer.alloc(10), 'wal-absent-or-too-small'],
    [makeWal([{ page: 1, fill: 0xaa, commitSize: 2 }], { magic: 0x12345678 }), 'bad-magic'],
    [makeWal([{ page: 1, fill: 0xaa, commitSize: 2 }], { pageSize: 1024 }), 'page-size-mismatch'],
    [makeWal([]), 'no-committed-frames'],
  ];
  for (const [wal, expectedReason] of cases) {
    const result = applyWalOverlay(db, wal);
    assertEqual(result.reason, expectedReason);
    assertEqual(result.applied, 0);
    assertEqual(result.image, db, 'the untouched image must be returned by identity');
  }
});

test('a corrupted WAL header checksum bails', () => {
  const db = makeDbImage(2);
  const wal = makeWal([{ page: 1, fill: 0xaa, commitSize: 2 }]);
  wal.writeUInt32BE(0xdeadbeef, 24); // clobber checksum-1
  const result = applyWalOverlay(db, wal);
  assertEqual(result.reason, 'header-checksum-mismatch');
  assertEqual(result.applied, 0);
});

test('a frame pointing past the end of the image bails rather than growing wildly', () => {
  const db = makeDbImage(2);
  const wal = makeWal([{ page: 9999, fill: 0xaa, commitSize: 2 }]);
  const result = applyWalOverlay(db, wal);
  assertEqual(result.reason, 'page-out-of-range');
  assertEqual(result.image, db);
});

test('the big-endian checksum variant is handled', () => {
  const db = makeDbImage(2);
  const wal = makeWal([{ page: 2, fill: 0xaa, commitSize: 2 }], { magic: 0x377f0683 });
  const result = applyWalOverlay(db, wal);
  assertEqual(result.reason, 'ok');
  assertEqual(result.image[OVERLAY_PAGE_SIZE], 0xaa);
});

test('applyWalOverlay never throws, whatever it is handed', () => {
  const inputs = [null, undefined, 'string', 42, {}, Buffer.alloc(0)];
  for (const a of inputs) {
    for (const b of inputs) {
      let result;
      try {
        result = applyWalOverlay(a, b);
      } catch (err) {
        throw new Error('threw on (' + String(a) + ', ' + String(b) + '): ' + err.message);
      }
      assert(result && typeof result.reason === 'string');
    }
  }
});

// ─── 10. The node:sqlite oracle, when this runtime has it ──────────────────

section('oracle: a real WAL written by SQLite itself is replayed correctly');

/**
 * Load node:sqlite without letting its ExperimentalWarning escape into the test
 * output. Returns null when the runtime does not have it, which is the case on
 * every Node before 22.5 and is a supported runtime for this project.
 */
function tryLoadNodeSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (/SQLite is an experimental feature/i.test(String(text))) return undefined;
    return original.apply(process, [warning, ...rest]);
  };
  try {
    // eslint-disable-next-line global-require
    return require('node:sqlite');
  } catch (_) {
    return null;
  } finally {
    process.emitWarning = original;
  }
}

test('sql.js plus the overlay matches SQLite on a database with an uncheckpointed WAL', async () => {
  const nodeSqlite = tryLoadNodeSqlite();
  if (!nodeSqlite || !nodeSqlite.DatabaseSync) {
    console.log('      (skipped: this runtime has no node:sqlite, which is expected before 22.5)');
    return;
  }

  const dir = makeTempDir('oracle');
  const dbPath = path.join(dir, 'oracle.sqlite');
  const oracle = new nodeSqlite.DatabaseSync(dbPath);
  oracle.exec('PRAGMA journal_mode = WAL');
  oracle.exec('PRAGMA wal_autocheckpoint = 0'); // keep everything in the WAL
  oracle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  oracle.exec("INSERT INTO t (id, v) VALUES (1, 'checkpointed')");
  oracle.exec('PRAGMA wal_checkpoint(FULL)'); // row 1 reaches the main file
  for (let i = 2; i <= 60; i++) {
    oracle.exec("INSERT INTO t (id, v) VALUES (" + i + ", 'wal-only-" + i + "')");
  }
  const expectedCount = oracle.prepare('SELECT count(*) AS n FROM t').get().n;

  // Snapshot the bytes while the writer connection is still OPEN. Closing the
  // last connection makes SQLite checkpoint and delete the WAL, which would
  // erase the very condition under test. Reading a live database from another
  // reader is also exactly the production scenario.
  assert(fs.existsSync(dbPath + '-wal'), 'the WAL must still exist for this test to mean anything');
  const dbBytes = fs.readFileSync(dbPath);
  const walBytes = fs.readFileSync(dbPath + '-wal');
  oracle.close();

  /** Count rows through sql.js over a given image. */
  const countThrough = (image) => {
    const db = new SQL.Database(image);
    try {
      const res = db.exec('SELECT count(*) AS n FROM t');
      return res.length && res[0].values.length ? Number(res[0].values[0][0]) : -1;
    } finally {
      db.close();
    }
  };

  const withoutOverlay = countThrough(dbBytes);
  const overlaid = applyWalOverlay(dbBytes, walBytes);
  assertEqual(overlaid.reason, 'ok', 'the overlay must accept a WAL SQLite itself wrote');
  assert(overlaid.applied > 0, 'frames must have been applied');
  const withOverlay = countThrough(overlaid.image);

  assertEqual(Number(expectedCount), 60, 'the fixture must really have 60 rows');
  assert(
    withoutOverlay < Number(expectedCount),
    'the main file alone must be stale, otherwise this test proves nothing (saw ' + withoutOverlay + ')'
  );
  assertEqual(withOverlay, Number(expectedCount), 'the overlay must recover every committed row');

  // And the overlaid image must be structurally sound, not merely queryable.
  const checkDb = new SQL.Database(overlaid.image);
  try {
    const check = checkDb.exec('PRAGMA quick_check');
    assertEqual(String(check[0].values[0][0]), 'ok', 'the overlaid image must pass quick_check');
  } finally {
    checkDb.close();
  }
});

// ─── Runner ────────────────────────────────────────────────────────────────

(async () => {
  // The engine is required to BUILD the fixtures, so a missing dependency is a
  // hard stop for this file rather than a silent pass.
  try {
    const initSqlJs = require('sql.js');
    const distDir = path.dirname(require.resolve('sql.js'));
    SQL = await initSqlJs({ locateFile: (f) => path.join(distDir, f) });
  } catch (err) {
    console.error('FATAL: sql.js is required to build the test fixtures: ' + err.message);
    process.exit(1);
  }

  console.log('\n  \x1b[1mcodex/state-db\x1b[0m');
  try {
    await runAll();
  } finally {
    cleanupTempDirs();
  }

  console.log('\n  ' + '='.repeat(58));
  console.log('  [codex-state-db] ' + passed + '/' + (passed + failed) + ' tests passed');
  process.exit(failed > 0 ? 1 : 0);
})();
