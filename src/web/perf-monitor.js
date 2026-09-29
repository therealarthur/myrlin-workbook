/**
 * Workbook performance monitor: measures what makes the desktop lag, live.
 *
 * What: one process-wide monitor that records
 *   - event loop delay (a perf_hooks histogram per one minute window),
 *   - stalls: moments the main thread was blocked 150 ms or more, each with
 *     the timed operations that ran inside it (attribution),
 *   - the synchronous cost of every child process spawn (on Windows the
 *     spawn call itself blocks the main thread) by executable,
 *   - named operations (discovery walks, git reads, file map builds),
 *   - HTTP route timings and SSE broadcast counts,
 *   - the browser's own report (long animation frames with the scripts that
 *     caused them, input delay, heap, DOM size), posted by perf-hud.js,
 *   - on-demand and automatic CPU profiles of the main thread through an
 *     in-process inspector session (no debug port), summarised as the
 *     functions behind each long block.
 * Stalls of 300 ms or more, minute summaries with problems, and profile
 * summaries are appended to <data dir>/perf.log (JSON lines, rotated at 5 MB).
 *
 * Why: the desktop lagged "horribly" after the mobile v2 upgrade and every
 * cause so far was found by attaching a profiler by hand. This keeps the
 * numbers in the app: GET /api/perf, the Ctrl+Alt+P overlay and perf.log.
 *
 * Cost: a 100 ms interval timer, a 20 ms resolution histogram, two
 * performance.now() calls per spawn and per timed operation. CWM_PERF=0
 * turns all of it off; CWM_PERF_AUTOPROFILE=0 turns off only the automatic
 * profile.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

const WINDOW_MS = 60000;
const HISTORY_WINDOWS = 30;
const TICK_MS = 100;
const STALL_MS = 150;
const LOG_STALL_MS = 300;
const RECENT_STALLS = 60;
const RECENT_OPS = 400;
const SLOW_SYNC_MS = 20;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const AUTO_PROFILE_STALLS = 3;          // stalls of LOG_STALL_MS in one window
const AUTO_PROFILE_SECONDS = 10;
const AUTO_PROFILE_MIN_GAP_MS = 10 * 60 * 1000;
const BLOCK_MIN_MS = 30;

let singleton = null;

/** @returns {{n: number, ms: number, max: number}} */
function bump(map, key, ms) {
  let e = map.get(key);
  if (!e) { e = { n: 0, ms: 0, max: 0 }; map.set(key, e); }
  e.n += 1;
  e.ms += ms;
  if (ms > e.max) e.max = ms;
  return e;
}

/** Top entries of a {n, ms, max} map, heaviest total first. */
function top(map, limit = 12) {
  return [...map.entries()]
    .sort((a, b) => b[1].ms - a[1].ms || b[1].n - a[1].n)
    .slice(0, limit)
    .map(([key, e]) => ({ key, n: e.n, ms: Math.round(e.ms), max: Math.round(e.max), avg: e.n ? Math.round(e.ms / e.n) : 0 }));
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Summarise a V8 CPU profile as the app functions behind each long block.
 * @param {object} profile - Profiler.stop().profile
 * @param {string} appRoot - Absolute path whose files count as app frames.
 * @returns {{busyPct: number, blocks: number, blockedMs: number, causes: Array<object>, selfTop: Array<object>}}
 */
function summariseProfile(profile, appRoot) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const norm = (u) => String(u || '').replace(/^file:\/\/\/?/, '').replace(/\\/g, '/');
  const root = norm(appRoot).toLowerCase();
  const rel = (u) => { const s = norm(u); const i = s.toLowerCase().indexOf(root); return i === -1 ? s : s.slice(i + root.length).replace(/^\//, ''); };
  const isApp = (u) => norm(u).toLowerCase().includes(root) && !/node_modules/.test(u);
  const idle = (nid) => { const f = byId.get(nid).callFrame.functionName; return f === '(idle)' || f === '(program)'; };
  const label = (n) => `${n.callFrame.functionName || '(anon)'} ${rel(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
  /** The nearest app frames above a sample, leaf first. */
  const appChain = (nid) => {
    const out = [];
    let cur = nid;
    let leaf = null;
    while (cur && out.length < 3) {
      const n = byId.get(cur);
      if (!leaf && n.callFrame.functionName && !/^\(/.test(n.callFrame.functionName)) leaf = n.callFrame.functionName;
      if (isApp(n.callFrame.url)) out.push(label(n));
      cur = parent.get(cur);
    }
    if (!out.length) return leaf ? '(no app frame) ' + leaf : byId.get(nid).callFrame.functionName;
    return out.join(' < ');
  };
  const blocks = [];
  const self = new Map();
  let cur = null;
  let t = 0;
  let total = 0;
  let idleUs = 0;
  profile.samples.forEach((s, i) => {
    const dt = profile.timeDeltas[i] || 0;
    t += dt;
    total += dt;
    if (idle(s)) {
      idleUs += dt;
      if (cur) { blocks.push(cur); cur = null; }
      return;
    }
    const n = byId.get(s);
    bump(self, n.callFrame.url ? `${n.callFrame.functionName || '(anon)'} ${rel(n.callFrame.url)}` : n.callFrame.functionName, dt / 1000);
    if (!cur) cur = { start: t, end: t, frames: new Map() };
    cur.end = t;
    const k = appChain(s);
    cur.frames.set(k, (cur.frames.get(k) || 0) + dt);
  });
  if (cur) blocks.push(cur);
  const long = blocks
    .map((b) => ({ ms: (b.end - b.start) / 1000, top: [...b.frames.entries()].sort((a, b2) => b2[1] - a[1])[0] }))
    .filter((b) => b.ms >= BLOCK_MIN_MS);
  const causes = new Map();
  for (const b of long) bump(causes, b.top ? b.top[0] : '?', b.ms);
  return {
    busyPct: total ? r1((1 - idleUs / total) * 100) : 0,
    blocks: long.length,
    blockedMs: Math.round(long.reduce((a, b) => a + b.ms, 0)),
    causes: top(causes, 12),
    selfTop: top(self, 12),
  };
}

/**
 * Create the monitor. Use install() in the app; this is exported for tests.
 * @param {object} [opts]
 * @param {string|null} [opts.logFile]
 * @param {boolean} [opts.autoProfile]
 * @param {string} [opts.appRoot]
 * @param {boolean} [opts.timers] - false in tests: no interval, no histogram.
 */
function createPerfMonitor(opts = {}) {
  const logFile = opts.logFile || null;
  const appRoot = opts.appRoot || path.join(__dirname, '..');
  const autoProfile = opts.autoProfile !== false;
  const withTimers = opts.timers !== false;
  const eld = withTimers ? monitorEventLoopDelay({ resolution: 20 }) : null;
  if (eld) eld.enable();

  const startedAt = Date.now();
  const history = [];
  const stalls = [];
  const recentOps = [];
  const clients = new Map();
  let lastProfile = null;
  let profiling = null;
  let lastAutoProfileAt = 0;
  let win = newWindow();

  function newWindow() {
    return {
      start: Date.now(),
      cpu: process.cpuUsage(),
      spawns: new Map(),
      ops: new Map(),
      routes: new Map(),
      sse: new Map(),
      stalls: 0,
      stallMs: 0,
      bigStalls: 0,
      maxStall: 0,
    };
  }

  /** Remember an operation that ended now and took ms, for stall attribution. */
  function remember(label, ms, sync) {
    recentOps.push({ label, end: performance.now(), ms, sync });
    if (recentOps.length > RECENT_OPS) recentOps.splice(0, recentOps.length - RECENT_OPS);
  }

  function writeLog(obj) {
    if (!logFile) return;
    try {
      try {
        const st = fs.statSync(logFile);
        if (st.size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
      } catch (_) { /* no log yet */ }
      fs.appendFileSync(logFile, JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n');
    } catch (_) { /* logging must never hurt the app */ }
  }

  /** The operations that overlapped [endMs - ms, endMs] (performance.now clock). */
  function opsDuring(endMs, ms) {
    const from = endMs - ms - TICK_MS;
    const sums = new Map();
    for (const o of recentOps) {
      if (o.end < from) continue;
      const overlap = Math.min(o.end, endMs) - Math.max(o.end - o.ms, from);
      if (overlap <= 0 && !(o.sync && o.end >= from)) continue;
      bump(sums, o.label, Math.max(0, overlap));
    }
    return top(sums, 6).map((e) => ({ op: e.key, n: e.n, ms: e.ms }));
  }

  function recordStall(lateMs) {
    const endMs = performance.now();
    const stall = { at: new Date().toISOString(), ms: Math.round(lateMs), during: opsDuring(endMs, lateMs) };
    stalls.push(stall);
    if (stalls.length > RECENT_STALLS) stalls.splice(0, stalls.length - RECENT_STALLS);
    win.stalls += 1;
    win.stallMs += lateMs;
    if (lateMs > win.maxStall) win.maxStall = lateMs;
    if (lateMs >= LOG_STALL_MS) {
      win.bigStalls += 1;
      writeLog(Object.assign({ kind: 'stall' }, stall));
      if (autoProfile && win.bigStalls >= AUTO_PROFILE_STALLS && !profiling && Date.now() - lastAutoProfileAt > AUTO_PROFILE_MIN_GAP_MS) {
        lastAutoProfileAt = Date.now();
        profile(AUTO_PROFILE_SECONDS, 'auto').catch(() => {});
      }
    }
  }

  function eventLoop() {
    if (!eld) return null;
    const ms = (ns) => r1(ns / 1e6);
    return { mean: ms(eld.mean), p50: ms(eld.percentile(50)), p99: ms(eld.percentile(99)), max: ms(eld.max) };
  }

  function summary(w, now) {
    const span = Math.max(1, now - w.start);
    const cpu = process.cpuUsage(w.cpu);
    return {
      start: new Date(w.start).toISOString(),
      seconds: Math.round(span / 1000),
      cpuPct: r1(((cpu.user + cpu.system) / 1000 / span) * 100),
      eventLoop: eventLoop(),
      stalls: w.stalls,
      stallMs: Math.round(w.stallMs),
      maxStall: Math.round(w.maxStall),
      spawns: top(w.spawns, 8),
      ops: top(w.ops, 8),
      routes: top(w.routes, 8),
      sse: top(w.sse, 8).map((e) => ({ key: e.key, n: e.n })),
    };
  }

  function roll() {
    const now = Date.now();
    const s = summary(win, now);
    history.push(s);
    if (history.length > HISTORY_WINDOWS) history.splice(0, history.length - HISTORY_WINDOWS);
    const clientBad = [...clients.values()].some((c) => c.at > now - WINDOW_MS && c.report && c.report.longFrames && c.report.longFrames.n > 0);
    if (s.stalls > 0 || (s.eventLoop && s.eventLoop.p99 > 100) || clientBad) {
      writeLog({ kind: 'minute', summary: s, client: clientSnapshot(now) });
    }
    win = newWindow();
    if (eld) eld.reset();
  }

  let timer = null;
  if (withTimers) {
    let expected = performance.now() + TICK_MS;
    timer = setInterval(() => {
      const t = performance.now();
      const late = t - expected;
      expected = t + TICK_MS;
      if (late >= STALL_MS) recordStall(late);
      if (Date.now() - win.start >= WINDOW_MS) roll();
    }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function clientSnapshot(now = Date.now()) {
    const out = [];
    for (const [id, c] of clients) {
      if (now - c.at > 5 * WINDOW_MS) { clients.delete(id); continue; }
      out.push(Object.assign({ id, ageS: Math.round((now - c.at) / 1000) }, c.report));
    }
    return out;
  }

  /**
   * Profile the main thread for a few seconds with an in-process inspector
   * session and keep the summary. One profile at a time.
   * @param {number} seconds
   * @param {string} [why]
   * @returns {Promise<object>}
   */
  function profile(seconds = 10, why = 'manual') {
    if (profiling) return profiling;
    const secs = Math.max(2, Math.min(60, Number(seconds) || 10));
    profiling = new Promise((resolve, reject) => {
      let inspector;
      try { inspector = require('inspector'); } catch (err) { reject(err); return; }
      const session = new inspector.Session();
      try { session.connect(); } catch (err) { reject(err); return; }
      const post = (m, p) => new Promise((res, rej) => session.post(m, p || {}, (err, r) => (err ? rej(err) : res(r))));
      post('Profiler.enable')
        .then(() => post('Profiler.setSamplingInterval', { interval: 1000 }))
        .then(() => post('Profiler.start'))
        .then(() => new Promise((r) => { const t = setTimeout(r, secs * 1000); if (t.unref) t.unref(); }))
        .then(() => post('Profiler.stop'))
        .then(({ profile: p }) => {
          const s = Object.assign({ at: new Date().toISOString(), seconds: secs, why }, summariseProfile(p, appRoot));
          lastProfile = s;
          writeLog(Object.assign({ kind: 'profile' }, s));
          if (logFile) {
            try { fs.writeFileSync(path.join(path.dirname(logFile), 'perf-last.cpuprofile'), JSON.stringify(p)); } catch (_) {}
          }
          resolve(s);
        })
        .catch(reject)
        .finally(() => { try { session.disconnect(); } catch (_) {} });
    }).finally(() => { profiling = null; });
    return profiling;
  }

  const mon = {
    /** A synchronous cost (it blocked the main thread for ms). */
    sync(label, ms) {
      bump(label.startsWith('spawn:') ? win.spawns : win.ops, label, ms);
      if (ms >= 1) remember(label, ms, true);
    },
    /** An asynchronous operation that took ms end to end. */
    op(label, ms) {
      bump(win.ops, label, ms);
      remember(label, ms, false);
    },
    /** Time a synchronous function. */
    timeSync(label, fn) {
      const t0 = performance.now();
      try { return fn(); } finally { mon.sync(label, performance.now() - t0); }
    },
    /** Time a promise returning function (end to end). */
    timeAsync(label, fn) {
      const t0 = performance.now();
      let p;
      try { p = Promise.resolve(fn()); } catch (err) { mon.op(label, performance.now() - t0); throw err; }
      return p.finally(() => mon.op(label, performance.now() - t0));
    },
    count(label) { bump(win.sse, label, 0); },
    route(key, ms) { bump(win.routes, key, ms); },
    /** Store a browser page's report (perf-hud.js). */
    client(id, report) {
      if (!id || !report || typeof report !== 'object') return;
      clients.set(String(id).slice(0, 80), { at: Date.now(), report });
      const lf = report.longFrames;
      if (lf && lf.max >= 500) writeLog({ kind: 'client', id: String(id).slice(0, 80), report });
    },
    profile,
    /** Everything, for GET /api/perf. */
    snapshot() {
      const now = Date.now();
      const mem = process.memoryUsage();
      return {
        pid: process.pid,
        uptimeS: Math.round((now - startedAt) / 1000),
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        current: summary(win, now),
        recentStalls: stalls.slice(-20).reverse(),
        history: history.slice(-10).reverse(),
        client: clientSnapshot(now),
        profiling: !!profiling,
        lastProfile,
        logFile,
      };
    },
    stop() { if (timer) clearInterval(timer); if (eld) eld.disable(); },
    _recordStall: recordStall,
    _roll: roll,
  };
  return mon;
}

/** A monitor that records nothing (CWM_PERF=0). */
function nullMonitor() {
  const noop = () => {};
  return {
    sync: noop, op: noop, count: noop, route: noop, client: noop,
    timeSync: (l, fn) => fn(),
    timeAsync: (l, fn) => fn(),
    profile: () => Promise.reject(new Error('perf monitor is off (CWM_PERF=0)')),
    snapshot: () => ({ off: true }),
    stop: noop,
  };
}

/**
 * Wrap child_process so every spawn's synchronous cost is recorded by
 * executable. ChildProcess.prototype.spawn covers spawn, exec and execFile;
 * the *Sync exports are wrapped for callers that read them after install.
 */
function wrapChildProcess(mon) {
  const cp = require('child_process');
  if (cp.__perfWrapped) return;
  cp.__perfWrapped = true;
  const base = (f) => { try { return path.basename(String(f || '?')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase(); } catch (_) { return '?'; } };
  const proto = cp.ChildProcess && cp.ChildProcess.prototype;
  if (proto && typeof proto.spawn === 'function') {
    const orig = proto.spawn;
    proto.spawn = function perfSpawn(options) {
      const t0 = performance.now();
      try { return orig.call(this, options); } finally { mon.sync('spawn:' + base(options && options.file), performance.now() - t0); }
    };
  }
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function perfSyncSpawn(file, ...rest) {
      const t0 = performance.now();
      const exe = name === 'execSync' ? String(file || '').trim().split(/\s+/)[0] : file;
      try { return orig.call(this, file, ...rest); } finally { mon.sync('spawn:' + base(exe) + ' (sync)', performance.now() - t0); }
    };
  }
}

/**
 * The process wide monitor (created on first call).
 * @param {object} [opts]
 * @param {string} [opts.dataDir] - where perf.log goes.
 * @returns {object}
 */
function install(opts = {}) {
  if (singleton) return singleton;
  if (process.env.CWM_PERF === '0') { singleton = nullMonitor(); return singleton; }
  let logFile = null;
  if (opts.dataDir) {
    try { fs.mkdirSync(opts.dataDir, { recursive: true }); logFile = path.join(opts.dataDir, 'perf.log'); } catch (_) { logFile = null; }
  }
  singleton = createPerfMonitor({ logFile, autoProfile: process.env.CWM_PERF_AUTOPROFILE !== '0' });
  try { wrapChildProcess(singleton); } catch (_) { /* spawn costs are optional */ }
  return singleton;
}

/** The installed monitor, or a no-op one before install (for optional callers). */
function get() { return singleton || nullMonitor(); }

module.exports = { install, get, createPerfMonitor, summariseProfile, SLOW_SYNC_MS };
