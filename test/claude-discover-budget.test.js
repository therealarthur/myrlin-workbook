#!/usr/bin/env node
/**
 * Task #36: the Claude discovery walk stops owning the event loop.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The walk used to be one uninterrupted synchronous block. Measured in a
 * sandbox server against the real corpus (40 project directories, 182
 * transcripts), a single GET /api/discover held the main thread for 130ms
 * warm and 289ms cold, and a 10ms heartbeat inside the server process ticked
 * exactly ONCE for the whole request: every other request, socket frame and
 * timer queued behind discovery. The fix is three things, and this file pins
 * all three plus the thing that must NOT change:
 *
 *   1. the response shape, field for field, including the Date-typed
 *      lastActive and the readdir ordering (the whole route contract);
 *   2. the incremental (mtimeMs, size) title cache, including invalidation
 *      on rewrite and pruning on delete;
 *   3. the asynchronous, budgeted walk: the loop turns many times during a
 *      pass, and the walk yields explicitly when it holds a slice too long.
 *
 * HERMETIC BY CONSTRUCTION
 * ------------------------
 * Per the project's standing rule that provider tests never scan the real
 * corpus (a 4GB real-corpus scan hangs npm test), this file builds its own
 * ~/.claude/projects tree in a tmpdir and points os.homedir() at it through
 * USERPROFILE/HOME. Nothing here reads or writes the user's actual sessions.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 green /
 * 1 on any failure with an offender list.
 */

'use strict';

require('./_test-data-dir');

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Fake home MUST be installed before anything calls os.homedir() ───────
// Node resolves os.homedir() from USERPROFILE on win32 and HOME elsewhere,
// at call time, so this redirects the walk without patching any module.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-claude-disc-'));
const REAL_USERPROFILE = process.env.USERPROFILE;
const REAL_HOME = process.env.HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

// A 1ms slice makes the budget provably due during a real walk, so the
// explicit-yield assertion is deterministic rather than timing-lucky.
process.env.CWM_DISCOVER_SLICE_MS = '1';

const PROJECTS_DIR = path.join(FAKE_HOME, '.claude', 'projects');

// Required AFTER the env is in place: the tunables are read at module load.
const discover = require('../src/providers/claude/discover');
const parseMod = require('../src/providers/claude/parse');

// ─── Assertion helpers ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Run one named check, recording pass/fail rather than throwing.
 * @param {string} name - Human-readable assertion name.
 * @param {Function} fn - Body; may be async.
 * @returns {Promise<void>}
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.message ? err.message : err));
  }
}

// ─── Fixture corpus ───────────────────────────────────────────────────────

const DIR_COUNT = 8;
const FILES_PER_DIR = 16;
const TOTAL_FILES = DIR_COUNT * FILES_PER_DIR;
/** Filler so each transcript is large enough that the walk does real IO. */
const FILLER_LINE_COUNT = 60;

/**
 * Compose one synthetic transcript.
 *
 * Line 1 always carries a cwd so resolveProjectPath resolves deterministically
 * through the jsonl branch rather than guessing at hyphens. The optional
 * custom-title line is appended LAST, which is where a rename really lands.
 *
 * @param {object} spec - {cwd, firstText, customTitle}
 * @returns {string} Transcript body.
 */
function buildTranscript(spec) {
  const lines = [];
  lines.push(JSON.stringify({ type: 'session-start', cwd: spec.cwd }));
  if (spec.firstText !== null) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: spec.firstText } }));
  }
  // Filler is a NON-message envelope on purpose. If it were a user or
  // assistant turn it would itself satisfy the first-message arm of the
  // cascade, and the "no qualifying message" fixture below could never
  // produce a null title.
  for (let i = 0; i < FILLER_LINE_COUNT; i++) {
    lines.push(JSON.stringify({
      type: 'file-history-snapshot',
      snapshot: 'x'.repeat(300),
    }));
  }
  if (spec.customTitle) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: spec.customTitle, sessionId: 'x' }));
  }
  return lines.join('\n');
}

/**
 * Materialise the fixture corpus under the fake home.
 * @returns {{dirs: string[], files: string[]}} Encoded dir names, absolute paths.
 */
function buildCorpus() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const dirs = [];
  const files = [];
  for (let d = 0; d < DIR_COUNT; d++) {
    const encoded = 'C--fixture-project-' + d;
    const dirPath = path.join(PROJECTS_DIR, encoded);
    fs.mkdirSync(dirPath, { recursive: true });
    dirs.push(encoded);
    const cwd = 'C:\\fixture\\project-' + d;
    for (let f = 0; f < FILES_PER_DIR; f++) {
      const uuid = 'fixture-' + d + '-' + f + '-' + crypto.randomBytes(4).toString('hex');
      const spec = { cwd: cwd, firstText: null, customTitle: null };
      if (f % 3 === 0) {
        spec.customTitle = 'renamed-' + d + '-' + f;
        spec.firstText = 'a first message that should lose to the rename';
      } else if (f % 3 === 1) {
        spec.firstText = 'derive the title from this first user message please';
      } else {
        // No qualifying message at all: the cascade must land on null, not
        // on the uuid. This is the arm most easily broken by a refactor.
        spec.firstText = null;
      }
      const p = path.join(dirPath, uuid + '.jsonl');
      fs.writeFileSync(p, buildTranscript(spec), 'utf8');
      files.push(p);
    }
    // A non-transcript file and a directory that ends in .jsonl: both must be
    // ignored, and the directory specifically must not become a session.
    fs.writeFileSync(path.join(dirPath, 'sessions-index-notjson.txt'), 'ignore me', 'utf8');
    fs.mkdirSync(path.join(dirPath, 'not-a-transcript.jsonl'), { recursive: true });
  }
  return { dirs, files };
}

// ─── The oracle: the pre-task-#36 synchronous walk, verbatim ──────────────

const { resolveProjectPath } = require('../src/providers/claude/path-decode');

/**
 * The walk exactly as it stood before task #36, kept here as the parity
 * oracle. If the new walk ever returns a different array for the same tree,
 * this is what catches it, rather than a hand-written expectation that could
 * drift toward whatever the new code happens to do.
 *
 * @returns {Array} ProviderSession[]
 */
function originalWalk() {
  const claudeDir = PROJECTS_DIR;
  if (!fs.existsSync(claudeDir)) return [];
  let topEntries;
  try { topEntries = fs.readdirSync(claudeDir, { withFileTypes: true }); } catch (_) { return []; }
  const sessions = [];
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(claudeDir, entry.name);
    let projectPath;
    try { projectPath = resolveProjectPath(projectDir, entry.name) || entry.name; } catch (_) { projectPath = entry.name; }
    let files;
    try { files = fs.readdirSync(projectDir); } catch (_) { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectDir, file);
      let stat;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      const providerSessionId = file.replace(/\.jsonl$/, '');
      let title = null;
      try {
        title = parseMod.extractCustomTitle(fullPath);
        if (!title) {
          const fromBody = parseMod.extractSessionName(fullPath, providerSessionId);
          if (fromBody && fromBody !== providerSessionId) title = fromBody;
        }
      } catch (_) { /* title extraction must never break discovery */ }
      sessions.push({
        provider: 'claude',
        providerSessionId: providerSessionId,
        projectPath: projectPath,
        encodedName: entry.name,
        title: title,
        lastActive: stat.mtime,
        sizeBytes: stat.size,
      });
    }
  }
  return sessions;
}

/**
 * Canonical string form of a session, with the Date normalised to epoch ms.
 * @param {object} s - ProviderSession.
 * @returns {string} Comparable form.
 */
function canonical(s) {
  return JSON.stringify([
    s.provider, s.providerSessionId, s.projectPath, s.encodedName, s.title,
    s.lastActive instanceof Date ? s.lastActive.getTime() : s.lastActive,
    s.sizeBytes,
  ]);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Task #36: the budgeted, cached, non-blocking Claude discovery walk');
  console.log('  ' + '-'.repeat(74));

  buildCorpus();

  // ── 1. Shape parity against the original walk ───────────────────────────
  await test('the response is byte-identical to the pre-fix synchronous walk', async () => {
    discover._resetCaches();
    const expected = originalWalk();
    const actual = await discover({ forceRefresh: true });
    assert.strictEqual(actual.length, TOTAL_FILES, 'expected ' + TOTAL_FILES + ' sessions, got ' + actual.length);
    assert.strictEqual(actual.length, expected.length, 'length differs from the oracle');
    for (let i = 0; i < expected.length; i++) {
      assert.strictEqual(canonical(actual[i]), canonical(expected[i]),
        'session ' + i + ' differs\n  exp ' + canonical(expected[i]) + '\n  got ' + canonical(actual[i]));
    }
  });

  await test('every record carries exactly the seven contract fields, lastActive a Date', async () => {
    const sessions = await discover({});
    for (const s of sessions) {
      const keys = Object.keys(s).sort().join(',');
      assert.strictEqual(keys,
        'encodedName,lastActive,projectPath,provider,providerSessionId,sizeBytes,title',
        'unexpected field set: ' + keys);
      assert.ok(s.lastActive instanceof Date, 'lastActive must stay a Date, got ' + typeof s.lastActive);
      assert.strictEqual(typeof s.sizeBytes, 'number', 'sizeBytes must be a number');
      assert.strictEqual(s.provider, 'claude', 'provider tag must be claude');
    }
  });

  await test('a directory whose name ends in .jsonl never becomes a session', async () => {
    const sessions = await discover({});
    const bogus = sessions.filter((s) => s.providerSessionId === 'not-a-transcript');
    assert.strictEqual(bogus.length, 0, 'a directory was discovered as a transcript');
  });

  // ── 2. The title cascade survives the rewrite ───────────────────────────
  await test('the cascade is rename first, then first message, then null (never the uuid)', async () => {
    const sessions = await discover({});
    const renamed = sessions.filter((s) => s.title && String(s.title).startsWith('renamed-'));
    const derived = sessions.filter((s) => s.title && String(s.title).startsWith('derive the title'));
    const none = sessions.filter((s) => s.title === null);
    assert.ok(renamed.length > 0, 'no renamed titles surfaced');
    assert.ok(derived.length > 0, 'no first-message titles surfaced');
    assert.ok(none.length > 0, 'no null titles surfaced');
    assert.strictEqual(renamed.length + derived.length + none.length, TOTAL_FILES,
      'the three cascade arms do not partition the corpus');
    for (const s of sessions) {
      assert.notStrictEqual(s.title, s.providerSessionId,
        'the uuid fallback leaked into the title for ' + s.providerSessionId);
    }
  });

  // ── 3. The incremental cache ────────────────────────────────────────────
  await test('a cold pass reads every transcript, a warm pass reads none', async () => {
    discover._resetCaches();
    const cold = await discover({ forceRefresh: true });
    const afterCold = discover._stats();
    assert.strictEqual(afterCold.titleMisses, TOTAL_FILES,
      'cold pass should miss on every file, missed ' + afterCold.titleMisses);
    assert.strictEqual(afterCold.titleHits, 0, 'cold pass should not hit');

    const warm = await discover({});
    const afterWarm = discover._stats();
    assert.strictEqual(afterWarm.titleMisses, TOTAL_FILES,
      'warm pass must add NO misses (still ' + TOTAL_FILES + '), saw ' + afterWarm.titleMisses);
    assert.strictEqual(afterWarm.titleHits, TOTAL_FILES,
      'warm pass should hit on every file, hit ' + afterWarm.titleHits);
    assert.strictEqual(cold.map(canonical).join('|'), warm.map(canonical).join('|'),
      'the cached pass returned different data from the uncached one');
  });

  await test('rewriting one transcript invalidates exactly that one entry', async () => {
    const before = await discover({});
    const baseline = discover._stats().titleMisses;
    const victim = before.find((s) => s.title === null);
    assert.ok(victim, 'fixture must contain a null-title transcript to rewrite');
    const victimPath = path.join(PROJECTS_DIR, victim.encodedName, victim.providerSessionId + '.jsonl');
    fs.appendFileSync(victimPath,
      '\n' + JSON.stringify({ type: 'custom-title', customTitle: 'late-rename', sessionId: 'x' }), 'utf8');

    const after = await discover({});
    const misses = discover._stats().titleMisses - baseline;
    assert.strictEqual(misses, 1, 'exactly one re-read expected, saw ' + misses);
    const updated = after.find((s) => s.providerSessionId === victim.providerSessionId);
    assert.strictEqual(updated.title, 'late-rename', 'the rewritten title did not surface');
  });

  await test('deleting a transcript prunes its cache entry', async () => {
    const before = await discover({});
    const sizeBefore = discover._stats().titleCacheSize;
    assert.strictEqual(sizeBefore, before.length, 'cache should hold one entry per transcript');
    const victim = before[before.length - 1];
    fs.unlinkSync(path.join(PROJECTS_DIR, victim.encodedName, victim.providerSessionId + '.jsonl'));

    const after = await discover({});
    assert.strictEqual(after.length, before.length - 1, 'the deleted transcript still appears');
    assert.strictEqual(discover._stats().titleCacheSize, sizeBefore - 1,
      'the cache kept a dead entry: ' + discover._stats().titleCacheSize);
  });

  await test('forceRefresh drops the resolution memo and keeps the self-invalidating one', async () => {
    await discover({});
    const beforeMisses = discover._stats().titleMisses;
    await discover({ forceRefresh: true });
    const s = discover._stats();
    assert.strictEqual(s.titleMisses, beforeMisses,
      'forceRefresh must not re-read unchanged transcripts, added ' + (s.titleMisses - beforeMisses));
    assert.ok(s.pathMisses > 0, 'forceRefresh must re-resolve project paths');
  });

  // ── 4. The budget: the loop keeps turning ───────────────────────────────
  await test('the loop turns many times during a cold pass, and the walk yields explicitly', async () => {
    discover._resetCaches();
    let ticks = 0;
    let longestBlockMs = 0;
    let last = Date.now();
    const beat = setInterval(() => {
      const now = Date.now();
      const over = now - last - 1;
      if (over > longestBlockMs) longestBlockMs = over;
      last = now;
      ticks++;
    }, 1);
    try {
      await discover({ forceRefresh: true });
    } finally {
      clearInterval(beat);
    }
    assert.ok(ticks >= 3, 'the event loop turned only ' + ticks + ' time(s) during the walk');
    assert.ok(discover._stats().yields >= 1,
      'the walk never yielded on its slice budget (yields=' + discover._stats().yields + ')');
    assert.ok(longestBlockMs < 150,
      'a single main-thread block of ' + longestBlockMs + 'ms exceeds the 150ms contract bar');
  });

  await test('a timer scheduled before the call runs before the walk resolves', async () => {
    discover._resetCaches();
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    await discover({ forceRefresh: true });
    assert.ok(fired, 'a zero-delay timer was still starved by the walk');
  });

  // ── 5. Coalescing ───────────────────────────────────────────────────────
  await test('concurrent callers share one walk', async () => {
    discover._resetCaches();
    const before = discover._stats().walks;
    const [a, b, c] = await Promise.all([discover({}), discover({}), discover({})]);
    const s = discover._stats();
    assert.strictEqual(s.walks - before, 1, 'expected one walk, ran ' + (s.walks - before));
    assert.ok(s.coalesced >= 2, 'expected two coalesced callers, saw ' + s.coalesced);
    assert.strictEqual(a, b, 'coalesced callers must share the result');
    assert.strictEqual(b, c, 'coalesced callers must share the result');
  });

  await test('a forceRefresh arriving mid-walk queues behind it instead of folding into it', async () => {
    discover._resetCaches();
    const before = discover._stats().walks;
    const soft = discover({});
    const forced = discover({ forceRefresh: true });
    const [softResult, forcedResult] = await Promise.all([soft, forced]);
    assert.strictEqual(discover._stats().walks - before, 2,
      'expected two walks, ran ' + (discover._stats().walks - before));
    assert.notStrictEqual(softResult, forcedResult,
      'the forced caller was folded into the soft walk it started after');
  });

  // ── 6. The two readers share one parse ──────────────────────────────────
  await test('the async readers agree with the synchronous ones on every fixture', async () => {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    let checked = 0;
    for (const d of dirs) {
      const dirPath = path.join(PROJECTS_DIR, d.name);
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dirPath, f);
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (!st.isFile()) continue;
        const id = f.replace(/\.jsonl$/, '');
        assert.strictEqual(await parseMod.extractCustomTitleAsync(p), parseMod.extractCustomTitle(p),
          'custom-title readers disagree on ' + f);
        assert.strictEqual(await parseMod.extractSessionNameAsync(p, id), parseMod.extractSessionName(p, id),
          'session-name readers disagree on ' + f);
        checked++;
      }
    }
    assert.ok(checked > 0, 'no fixtures were compared');
  });

  await test('both readers survive an empty file and a missing file', async () => {
    const emptyPath = path.join(FAKE_HOME, 'empty.jsonl');
    fs.writeFileSync(emptyPath, '', 'utf8');
    const missing = path.join(FAKE_HOME, 'does-not-exist.jsonl');
    assert.strictEqual(parseMod.extractCustomTitle(emptyPath), null);
    assert.strictEqual(await parseMod.extractCustomTitleAsync(emptyPath), null);
    assert.strictEqual(parseMod.extractCustomTitle(missing), null);
    assert.strictEqual(await parseMod.extractCustomTitleAsync(missing), null);
    assert.strictEqual(parseMod.extractSessionName(emptyPath, 'uuid-1'), 'uuid-1');
    assert.strictEqual(await parseMod.extractSessionNameAsync(emptyPath, 'uuid-1'), 'uuid-1');
    assert.strictEqual(parseMod.extractSessionName(missing, 'uuid-2'), 'uuid-2');
    assert.strictEqual(await parseMod.extractSessionNameAsync(missing, 'uuid-2'), 'uuid-2');
  });

  await test('the byte pre-filter never hides a marker the decoded window would show', async () => {
    const withMarker = Buffer.from('{"type":"custom-title","customTitle":"t"}', 'utf8');
    const withoutMarker = Buffer.from('{"type":"user","message":{"role":"user"}}', 'utf8');
    const multibyte = Buffer.from('{"text":"\u4e2d\u6587\u30c6\u30b9\u30c8"}\n{"type":"custom-title","customTitle":"t"}', 'utf8');
    assert.strictEqual(parseMod.windowMayContainCustomTitle(withMarker), true);
    assert.strictEqual(parseMod.windowMayContainCustomTitle(withoutMarker), false);
    assert.strictEqual(parseMod.windowMayContainCustomTitle(multibyte), true,
      'a multibyte prefix must not hide an ASCII marker later in the window');
    // Honour the explicit length: the marker sits beyond it, so it is invisible.
    assert.strictEqual(parseMod.windowMayContainCustomTitle(withMarker, 5), false,
      'the pre-filter read past the valid byte count');
    assert.strictEqual(parseMod.windowMayContainCustomTitle(Buffer.alloc(0)), false);
  });

  await test('the synchronous readers are still exported for their existing callers', () => {
    assert.strictEqual(typeof parseMod.extractCustomTitle, 'function');
    assert.strictEqual(typeof parseMod.extractSessionName, 'function');
    assert.strictEqual(typeof parseMod.parseTranscript, 'function');
    const searchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'claude', 'search.js'), 'utf8');
    assert.ok(searchSrc.includes('extractSessionName'),
      'search.js lost its synchronous reader');
  });

  // ── 7. Degradation. Runs LAST: it prunes the cache to empty on purpose ──
  await test('an absent projects tree yields an empty array and never throws', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-claude-nohome-'));
    process.env.USERPROFILE = emptyHome;
    process.env.HOME = emptyHome;
    try {
      const out = await discover({ forceRefresh: true });
      assert.ok(Array.isArray(out), 'must return an array');
      assert.strictEqual(out.length, 0, 'must be empty');
    } finally {
      process.env.USERPROFILE = FAKE_HOME;
      process.env.HOME = FAKE_HOME;
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ─── Results ───────────────────────────────────────────────────────────
  console.log('  ' + '-'.repeat(74));
  console.log('  [claude-discover-budget] ' + passed + '/' + (passed + failed) + ' tests passed');
  if (failed > 0) {
    console.log('\n  Offenders:');
    for (const f of failures) console.log('   - ' + f.name + ': ' + (f.err && f.err.message));
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    cleanup();
    process.exit(1);
  });

/**
 * Restore the real home environment and remove the fixture tree.
 * @returns {void}
 */
function cleanup() {
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = REAL_USERPROFILE;
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (_) {}
}
