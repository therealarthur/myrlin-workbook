#!/usr/bin/env node
/**
 * Tests for src/web/scheduler.js: engine with injected clock + fake ptyManager.
 * Usage: node test/scheduler.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failed++; console.log(`  \x1b[31m✗ ${name}\n    ${err.message}\x1b[0m`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failed++; console.log(`  \x1b[31m✗ ${name}\n    ${err.message}\x1b[0m`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertDeepEqual(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Test fixtures ─────────────────────────────────────────────
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    set: (t) => { now = t; },
  };
}

function makePtyManager() {
  const writes = [];
  const sessions = new Map();
  return {
    writes,
    setSession(id, alive) {
      sessions.set(id, { alive, pty: { write: (data) => writes.push({ id, data }) } });
    },
    removeSession(id) { sessions.delete(id); },
    getSession(id) { return sessions.get(id); },
  };
}

function makeStore() {
  const ee = new EventEmitter();
  return ee;
}

function makeScheduler({ clock = makeClock(), ptyManager = makePtyManager(), store = makeStore(), dataFile } = {}) {
  if (!dataFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
    dataFile = path.join(dir, 'schedules.json');
  }
  // Lazy-require so each test gets a fresh module (caches no state, but be safe).
  delete require.cache[require.resolve('../src/web/scheduler')];
  const { Scheduler } = require('../src/web/scheduler');
  // schedule(fn, ms) is the timer abstraction, tests pass a stub that records calls.
  const armed = [];
  const schedule = (fn, ms) => {
    const handle = { fn, ms, cancelled: false };
    armed.push(handle);
    return handle;
  };
  schedule.cancel = (handle) => { handle.cancelled = true; };
  return {
    sched: new Scheduler({ dataFile, ptyManager, store, clock, schedule }),
    clock, ptyManager, store, dataFile, armed,
  };
}

console.log('\n  Scheduler, surface + persistence');

test('create() returns full schedule with id, persists', () => {
  const { sched, clock, dataFile } = makeScheduler();
  const def = { command: 'npm test', kind: 'once', delayMs: 60_000 };
  const s = sched.create('sess-A', def);
  assert(s.id && s.id.length > 0, 'id present');
  assertEqual(s.sessionId, 'sess-A');
  assertEqual(s.command, 'npm test');
  assertEqual(s.kind, 'once');
  assertEqual(s.delayMs, 60_000);
  assertEqual(s.nextFireAt, clock.now() + 60_000);
  assertEqual(s.createdAt, clock.now());
  sched.flushSync();
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assertEqual(Object.keys(raw.schedules).length, 1);
});

test('listActive() returns only that session, oldest first', () => {
  const { sched, clock } = makeScheduler();
  const a = sched.create('sess-A', { command: 'one', kind: 'once', delayMs: 1000 });
  clock.advance(10);
  const b = sched.create('sess-A', { command: 'two', kind: 'once', delayMs: 1000 });
  clock.advance(10);
  sched.create('sess-B', { command: 'other', kind: 'once', delayMs: 1000 });
  const list = sched.listActive('sess-A');
  assertEqual(list.length, 2);
  assertEqual(list[0].id, a.id);
  assertEqual(list[1].id, b.id);
});

test('delete() removes and persists', () => {
  const { sched, dataFile } = makeScheduler();
  const s = sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 1000 });
  sched.delete(s.id);
  sched.flushSync();
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assertEqual(Object.keys(raw.schedules).length, 0);
});

test('create() validates kind', () => {
  const { sched } = makeScheduler();
  let threw = false;
  try { sched.create('s', { command: 'x', kind: 'forever', delayMs: 1000 }); }
  catch (_) { threw = true; }
  assert(threw, 'should reject invalid kind');
});

test('create() validates command non-empty and ≤2KB', () => {
  const { sched } = makeScheduler();
  let threw = 0;
  try { sched.create('s', { command: '', kind: 'once', delayMs: 1000 }); } catch (_) { threw++; }
  try { sched.create('s', { command: 'x'.repeat(2049), kind: 'once', delayMs: 1000 }); } catch (_) { threw++; }
  assertEqual(threw, 2);
});

test('create() validates delayMs range', () => {
  const { sched } = makeScheduler();
  let threw = 0;
  try { sched.create('s', { command: 'x', kind: 'once', delayMs: 999 }); } catch (_) { threw++; }
  try { sched.create('s', { command: 'x', kind: 'once', delayMs: 31 * 86400000 }); } catch (_) { threw++; }
  assertEqual(threw, 2);
});

test('create() with absolute fireAt computes nextFireAt = fireAt', () => {
  const { sched, clock } = makeScheduler();
  const at = clock.now() + 5_000;
  const s = sched.create('sess-A', { command: 'x', kind: 'once', fireAt: at });
  assertEqual(s.fireAt, at);
  assertEqual(s.nextFireAt, at);
});

test('round-trip: persisted schedules survive reload', () => {
  const fixture = makeScheduler();
  fixture.sched.create('sess-A', { command: 'persist me', kind: 'recurring', delayMs: 60_000 });
  fixture.sched.flushSync();
  // Reload from same dataFile in a fresh instance
  delete require.cache[require.resolve('../src/web/scheduler')];
  const { Scheduler } = require('../src/web/scheduler');
  const fresh = new Scheduler({
    dataFile: fixture.dataFile,
    ptyManager: fixture.ptyManager,
    store: fixture.store,
    clock: fixture.clock,
    schedule: () => ({ cancelled: false }),
  });
  assertEqual(fresh.listActive('sess-A').length, 1);
  assertEqual(fresh.listActive('sess-A')[0].command, 'persist me');
});

console.log('\n  Scheduler, fire flow (success path)');

test('start() arms a timer for every active schedule', () => {
  const f = makeScheduler();
  f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 5000 });
  f.sched.create('sess-A', { command: 'y', kind: 'recurring', delayMs: 10000 });
  f.sched.start();
  // Two timers armed (excluding the save-debounce timer which uses same `schedule` stub)
  const fireTimers = f.armed.filter(h => h.ms === 5000 || h.ms === 10000);
  assertEqual(fireTimers.length, 2);
});

test('fire() writes message then \\r as separate writes (paste-mode safe)', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', /*alive*/ true);
  const s = f.sched.create('sess-A', { command: 'npm test', kind: 'once', delayMs: 1000 });
  f.sched.start();
  const handle = f.armed.find(h => h.ms === 1000);
  f.clock.advance(1000);
  handle.fn();
  // First write: just the message text, no carriage return.
  assertEqual(f.ptyManager.writes.length, 1);
  assertEqual(f.ptyManager.writes[0].id, 'sess-A');
  assertEqual(f.ptyManager.writes[0].data, 'npm test');
  // The Enter is scheduled separately. Find and fire the submit timer.
  const submit = f.armed.find(h => h.ms === 80 && !h.cancelled);
  assert(submit, 'expected submit timer scheduled');
  submit.fn();
  assertEqual(f.ptyManager.writes.length, 2);
  assertEqual(f.ptyManager.writes[1].data, '\r');
});

test('one-off schedule deletes after successful fire', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 1000 });
  f.sched.start();
  const handle = f.armed.find(h => h.ms === 1000);
  f.clock.advance(1000);
  handle.fn();
  assertEqual(f.sched.listActive('sess-A').length, 0);
});

test('recurring schedule re-arms with delayMs after fire', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  const handle1 = f.armed.find(h => h.ms === 5000);
  f.clock.advance(5000);
  handle1.fn();
  // Schedule still active, nextFireAt advanced
  const active = f.sched.listActive('sess-A');
  assertEqual(active.length, 1);
  assertEqual(active[0].nextFireAt, f.clock.now() + 5000);
  // A new timer armed for next fire
  const next = f.armed.filter(h => h.ms === 5000);
  assertEqual(next.length, 2);
});

test('create() after start() arms a timer immediately', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  f.sched.start();
  const s = f.sched.create('sess-A', { command: 'live', kind: 'once', delayMs: 7000 });
  // A 7s timer must be armed (in addition to any save-debounce 200ms timers)
  assert(f.armed.some(h => h.ms === 7000), 'expected 7s timer armed for runtime-created schedule');
  // And firing it should reach the pty (text first, then \r via submit timer)
  f.clock.advance(7000);
  f.armed.find(h => h.ms === 7000).fn();
  assertEqual(f.ptyManager.writes.length, 1);
  assertEqual(f.ptyManager.writes[0].data, 'live');
  f.armed.find(h => h.ms === 80 && !h.cancelled).fn();
  assertEqual(f.ptyManager.writes.length, 2);
  assertEqual(f.ptyManager.writes[1].data, '\r');
});

test('successful fire appends a success history row', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', true);
  const s = f.sched.create('sess-A', { command: 'echo hi', kind: 'once', delayMs: 1000 });
  f.sched.start();
  const handle = f.armed.find(h => h.ms === 1000);
  f.clock.advance(1000);
  handle.fn();
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].status, 'success');
  assertEqual(hist[0].command, 'echo hi');
  assertEqual(hist[0].firedAt, f.clock.now());
  assertEqual(hist[0].scheduledAt, s.nextFireAt);
});

console.log('\n  Scheduler, skip handling');

test('stopped pty fires skipped row, recurring re-arms', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', /*alive*/ false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  f.armed.find(h => h.ms === 5000).fn();
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].status, 'skipped');
  assertEqual(hist[0].skipReason, 'session-not-running');
  // Recurring re-armed
  const active = f.sched.listActive('sess-A');
  assertEqual(active.length, 1);
});

test('stopped pty + once kind deletes the schedule', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 1000 });
  f.sched.start();
  f.armed.find(h => h.ms === 1000).fn();
  assertEqual(f.sched.listActive('sess-A').length, 0);
  assertEqual(f.sched.listHistory('sess-A').length, 1);
});

test('three consecutive same-id skip rows collapse to one with skipCount=3', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  // Fire three times in a row
  for (let i = 0; i < 3; i++) {
    f.clock.advance(5000);
    const handle = f.armed.filter(h => h.ms === 5000).pop();
    handle.fn();
  }
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].skipCount, 3);
  assertEqual(hist[0].status, 'skipped');
});

test('success between skips breaks collapse, 3 distinct rows', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s = f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  // skip
  f.clock.advance(5000); f.armed.filter(h => h.ms === 5000).pop().fn();
  // bring pty up, success
  f.ptyManager.setSession('sess-A', true);
  f.clock.advance(5000); f.armed.filter(h => h.ms === 5000).pop().fn();
  // pty down again, skip
  f.ptyManager.setSession('sess-A', false);
  f.clock.advance(5000); f.armed.filter(h => h.ms === 5000).pop().fn();
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 3);
  // Newest first
  assertEqual(hist[0].status, 'skipped');
  assertEqual(hist[1].status, 'success');
  assertEqual(hist[2].status, 'skipped');
});

test('different schedule ids do not collapse together', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  const s1 = f.sched.create('sess-A', { command: 'a', kind: 'recurring', delayMs: 5000 });
  const s2 = f.sched.create('sess-A', { command: 'b', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  f.armed.filter(h => h.ms === 5000).forEach(h => h.fn()); // both fire once
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 2);
  assertEqual(hist[0].skipCount, 1);
  assertEqual(hist[1].skipCount, 1);
});

test('history cap: 51 appends → 50 newest retained', () => {
  const f = makeScheduler();
  // Bypass through internal API for speed
  for (let i = 0; i < 51; i++) {
    f.sched._appendHistory('sess-A', {
      id: 'id-' + i, command: 'c-' + i, firedAt: 1000 + i, scheduledAt: 1000 + i,
      status: 'success', skipReason: null, skipCount: 1,
    });
  }
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 50);
  // Newest first → command "c-50"
  assertEqual(hist[0].command, 'c-50');
  // Oldest retained is c-1 (c-0 was pruned)
  assertEqual(hist[hist.length - 1].command, 'c-1');
});

console.log('\n  Scheduler, boot recovery');

test('start(): missed once → skipped+deleted, no timer armed', () => {
  // Build a state file directly so the next instance boots with stale state
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
  const dataFile = path.join(dir, 'schedules.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    schedules: {
      'sched-1': {
        id: 'sched-1', sessionId: 'sess-A', command: 'late',
        kind: 'once', delayMs: 60000,
        nextFireAt: 1000,            // way in the past (vs clock 1.7e12)
        createdAt: 500,
      },
    },
    history: {},
  }));
  const f = makeScheduler({ dataFile });
  f.sched.start();
  assertEqual(f.sched.listActive('sess-A').length, 0);
  const hist = f.sched.listHistory('sess-A');
  assertEqual(hist.length, 1);
  assertEqual(hist[0].status, 'skipped');
  assertEqual(hist[0].skipReason, 'missed-while-down');
});

test('start(): missed recurring → advanced, armed, no history row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
  const dataFile = path.join(dir, 'schedules.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    schedules: {
      'sched-2': {
        id: 'sched-2', sessionId: 'sess-A', command: 'tick',
        kind: 'recurring', delayMs: 5000,
        nextFireAt: 1000,
        createdAt: 500,
      },
    },
    history: {},
  }));
  const f = makeScheduler({ dataFile });
  f.sched.start();
  const active = f.sched.listActive('sess-A');
  assertEqual(active.length, 1);
  assertEqual(active[0].nextFireAt, f.clock.now() + 5000);
  // Timer armed
  assert(f.armed.some(h => h.ms === 5000), 'timer armed for recurring');
  // No history row
  assertEqual(f.sched.listHistory('sess-A').length, 0);
});

test('start(): future once → timer armed for the remaining delay', () => {
  const f = makeScheduler();
  const s = f.sched.create('sess-A', { command: 'x', kind: 'once', delayMs: 30_000 });
  f.sched.start();
  assert(f.armed.some(h => h.ms === 30_000), 'expected 30s timer armed');
});

console.log('\n  Scheduler, store cleanup');

test('session:deleted clears that session\'s schedules and history', () => {
  const f = makeScheduler();
  f.ptyManager.setSession('sess-A', false);
  f.sched.create('sess-A', { command: 'x', kind: 'recurring', delayMs: 5000 });
  f.sched.create('sess-B', { command: 'y', kind: 'recurring', delayMs: 5000 });
  f.sched.start();
  // Drop a history row for sess-A
  f.armed.filter(h => h.ms === 5000)[0].fn();
  assert(f.sched.listActive('sess-A').length > 0);
  assert(f.sched.listHistory('sess-A').length > 0);
  // Emit deletion
  f.store.emit('session:deleted', { id: 'sess-A' });
  assertEqual(f.sched.listActive('sess-A').length, 0);
  assertEqual(f.sched.listHistory('sess-A').length, 0);
  // sess-B untouched
  assertEqual(f.sched.listActive('sess-B').length, 1);
});

console.log(`\n  Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
