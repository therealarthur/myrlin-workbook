#!/usr/bin/env node
/**
 * Tests for the waitForNewJsonl hybrid watcher in src/web/pty-manager.js.
 *
 * Run standalone: node test/pty-watcher.test.js
 *
 * The helper is exported via the pty-manager module's __test exports. The
 * tests use a temp directory and short timeouts (200-500 ms) instead of the
 * production 8 s budget so the suite finishes in a few seconds.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Skip node-pty's runtime helper checks, we don't spawn anything here.
process.env.PTY_SKIP_HELPER_FIX = '1';

const { __test } = require('../src/web/pty-manager');
const { waitForNewJsonl } = __test;

let passed = 0;
let failed = 0;

function log(ok, name, err) {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (err) console.log(`    \x1b[31m${err.message || err}\x1b[0m`);
  }
}

async function run(name, fn) {
  try {
    await fn();
    log(true, name);
  } catch (err) {
    log(false, name, err);
  }
}

function makeTmpProjects() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-watch-'));
  const dirName = 'projA';
  fs.mkdirSync(path.join(tmp, dirName));
  return { tmp, dirName };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function waitFor({ candidateDirsFn, snapshot, timeoutMs, claudeProjectsDir }) {
  return new Promise(resolve => {
    waitForNewJsonl(
      { candidateDirsFn, snapshot, timeoutMs, claudeProjectsDir },
      (err, hit) => resolve({ err, hit })
    );
  });
}

(async () => {
  console.log('\n  \x1b[1mwaitForNewJsonl\x1b[0m');

  await run('matches a new .jsonl file written during the wait', async () => {
    const { tmp, dirName } = makeTmpProjects();
    try {
      const pending = waitFor({
        candidateDirsFn: () => [dirName],
        snapshot: new Set(),
        timeoutMs: 1500,
        claudeProjectsDir: tmp,
      });
      // Give fs.watch a moment to register before we write
      setTimeout(() => fs.writeFileSync(path.join(tmp, dirName, 'aaa.jsonl'), ''), 80);
      const start = Date.now();
      const { err, hit } = await pending;
      const elapsed = Date.now() - start;
      if (err) throw err;
      if (!hit) throw new Error('expected a hit, got null');
      if (hit.file !== 'aaa.jsonl') throw new Error('wrong file: ' + hit.file);
      if (hit.dirName !== dirName) throw new Error('wrong dirName: ' + hit.dirName);
      if (elapsed > 1000) throw new Error('took too long: ' + elapsed + 'ms (fs.watch should fire fast)');
    } finally {
      rmrf(tmp);
    }
  });

  await run('returns null on timeout when nothing appears', async () => {
    const { tmp, dirName } = makeTmpProjects();
    try {
      const start = Date.now();
      const { err, hit } = await waitFor({
        candidateDirsFn: () => [dirName],
        snapshot: new Set(),
        timeoutMs: 250,
        claudeProjectsDir: tmp,
      });
      const elapsed = Date.now() - start;
      if (err) throw err;
      if (hit !== null) throw new Error('expected null, got ' + JSON.stringify(hit));
      if (elapsed < 200) throw new Error('returned too early: ' + elapsed + 'ms');
      if (elapsed > 600) throw new Error('returned too late: ' + elapsed + 'ms');
    } finally {
      rmrf(tmp);
    }
  });

  await run('ignores files already in the snapshot', async () => {
    const { tmp, dirName } = makeTmpProjects();
    try {
      // Pre-create a file and add it to the snapshot
      fs.writeFileSync(path.join(tmp, dirName, 'old.jsonl'), '');
      const snapshot = new Set([dirName + '/old.jsonl']);
      const pending = waitFor({
        candidateDirsFn: () => [dirName],
        snapshot,
        timeoutMs: 350,
        claudeProjectsDir: tmp,
      });
      // Touching the existing file (re-writing it) must NOT trigger a match.
      // fs.watch fires 'change' for content rewrites; on some platforms it
      // also fires 'rename' for file replacement. Either way the snapshot
      // filter must reject it.
      setTimeout(() => fs.writeFileSync(path.join(tmp, dirName, 'old.jsonl'), 'updated'), 50);
      const { err, hit } = await pending;
      if (err) throw err;
      if (hit !== null) throw new Error('expected null but got hit: ' + JSON.stringify(hit));
    } finally {
      rmrf(tmp);
    }
  });

  await run('cold-start: candidate dir does not exist at call time, gets created during wait', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-watch-cold-'));
    const dirName = 'projLate';
    try {
      const pending = waitFor({
        candidateDirsFn: () => {
          // Only return the dir name once it actually exists on disk
          try { fs.statSync(path.join(tmp, dirName)); return [dirName]; }
          catch (_) { return []; }
        },
        snapshot: new Set(),
        timeoutMs: 800,
        claudeProjectsDir: tmp,
      });
      // Create the dir + file after the helper has already started
      setTimeout(() => {
        fs.mkdirSync(path.join(tmp, dirName));
        fs.writeFileSync(path.join(tmp, dirName, 'late.jsonl'), '');
      }, 100);
      const { err, hit } = await pending;
      if (err) throw err;
      if (!hit) throw new Error('expected a hit (rescan should catch it), got null');
      if (hit.file !== 'late.jsonl') throw new Error('wrong file: ' + hit.file);
    } finally {
      rmrf(tmp);
    }
  });

  await run('cancel() before the wait finishes: callback is not invoked', async () => {
    const { tmp, dirName } = makeTmpProjects();
    try {
      let resolvedWith = 'never';
      const cancel = waitForNewJsonl(
        {
          candidateDirsFn: () => [dirName],
          snapshot: new Set(),
          timeoutMs: 500,
          claudeProjectsDir: tmp,
        },
        (err, hit) => { resolvedWith = { err, hit }; }
      );
      cancel();
      // Give it well past the timeout to make sure no callback fires
      await new Promise(r => setTimeout(r, 700));
      // Even if a file appears late, callback must not run
      fs.writeFileSync(path.join(tmp, dirName, 'late.jsonl'), '');
      await new Promise(r => setTimeout(r, 100));
      if (resolvedWith !== 'never') throw new Error('callback fired after cancel: ' + JSON.stringify(resolvedWith));
    } finally {
      rmrf(tmp);
    }
  });

  await run('rescan picks freshest by birthtime when watcher missed events', async () => {
    const { tmp, dirName } = makeTmpProjects();
    try {
      // Pre-create two files that didn't exist at "spawn" but pretend the
      // watcher missed both. We achieve this by passing a snapshot that
      // doesn't include them, AND not using fs.watch (call helper after
      // files exist so the watcher registers but no events fire).
      fs.writeFileSync(path.join(tmp, dirName, 'one.jsonl'), '');
      // Brief delay so birthtimes differ
      await new Promise(r => setTimeout(r, 30));
      fs.writeFileSync(path.join(tmp, dirName, 'two.jsonl'), '');

      const { err, hit } = await waitFor({
        candidateDirsFn: () => [dirName],
        snapshot: new Set(),
        timeoutMs: 200,
        claudeProjectsDir: tmp,
      });
      if (err) throw err;
      if (!hit) throw new Error('expected a hit, got null');
      if (hit.file !== 'two.jsonl') throw new Error('expected freshest "two.jsonl", got ' + hit.file);
    } finally {
      rmrf(tmp);
    }
  });

  console.log('\n  ' + '─'.repeat(42));
  console.log(`  \x1b[1mResults:\x1b[0m ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('  ' + '─'.repeat(42) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
