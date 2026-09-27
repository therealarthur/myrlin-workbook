#!/usr/bin/env node
/**
 * Live-session attach gate (2026-09-26).
 *
 * Symptom: opening a Workbook pane for a Claude session that is running
 * right now as a `claude --bg` background session spawned
 * `claude --resume <transcript>`, which FORKS the live session (a second
 * process writing to the same conversation) instead of joining it. The same
 * happened for a session open in an interactive terminal on the PC.
 *
 * Fix, covered here:
 *   - src/providers/claude/spawn.js: `attachShortId` builds `claude attach <id>`.
 *   - src/providers/claude/live-sessions.js: cached `claude agents --json`
 *     lookup (5 s timeout, 10 s cache, in-flight coalescing), robust binary
 *     resolution for the S4U scheduled task, the classify truth table, the
 *     persisted seen-live markers behind the fail-safe, and custom-command
 *     resume parsing.
 *   - src/web/pty-manager.js: the gate in attachClient (attach / notice with
 *     no spawn / resume), early-frame buffering, per-session coalescing, the
 *     held-socket notice with typed confirmation, the own-exit recheck, the
 *     defense-in-depth refusal in spawnSession.
 *   - src/web/server.js: the legacy start/restart guard.
 *
 * No test here runs the real Claude CLI. The lookup runs a fake execFile, or
 * (section K, Windows only) a fake claude.cmd written to a temp dir.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');
// And the Claude projects tree the --continue resolver reads, so no test ever
// looks at the real ~/.claude/projects.
process.env.CWM_CLAUDE_PROJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-live-projects-'));

/**
 * Lay out <projects>/<encoded cwd>/<id>.jsonl the way Claude Code does, with
 * the LAST id in `ids` the newest (what `claude --continue` would pick).
 */
function seedProjectsDir(cwd, ids) {
  const { encodeClaudeProjectDir } = require('../src/providers/claude/path-decode');
  const dir = path.join(process.env.CWM_CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now() / 1000 - ids.length * 10;
  ids.forEach((id, i) => {
    const f = path.join(dir, id + '.jsonl');
    fs.writeFileSync(f, '{}\n');
    fs.utimesSync(f, base + i * 10, base + i * 10);
  });
  return dir;
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n        ') : String(err)));
  }
}

const CLAUDE = 'claude'; // gsd:provider-literal-allowed (test fixture for the Claude provider)
const EM_DASH = String.fromCharCode(0x2014);

// Synthetic ids, shaped like the real `claude agents --json` output.
const BG_SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const BG_SHORT = 'a1b2c3d4';
const IT_SID = 'b2c3d4e5-0000-4000-8000-000000000002';
const CONT_SID = 'c3d4e5f6-0000-4000-8000-000000000003';
const NONE_SID = 'd4e5f6a7-0000-4000-8000-000000000004';
const BG_ENTRY = { pid: 111, id: BG_SHORT, cwd: 'C:\\work', kind: 'background', startedAt: 1, sessionId: BG_SID, name: 'bg-one', status: 'idle', state: 'working' };
const IT_ENTRY = { pid: 222, cwd: 'C:\\work', kind: 'interactive', startedAt: 2, sessionId: IT_SID, name: 'term-one', status: 'busy' };
const CONT_ENTRY = { pid: 333, id: 'c3d4e5f6', cwd: 'C:\\work', kind: 'background', startedAt: 3, sessionId: CONT_SID, name: 'bg-cont', status: 'busy', state: 'working' };
const LISTING = JSON.stringify([BG_ENTRY, IT_ENTRY, CONT_ENTRY]);

const live = require('../src/providers/claude/live-sessions');

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Poll until cond() is truthy or the deadline passes. */
async function until(cond, timeoutMs = 3000, label = 'condition') {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + label);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let pending promise callbacks and setImmediate work run. */
function tick(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Fake child_process.execFile. `script(n, file, args)` returns what run n
 * does: {stdout}, {error}, or 'hang'. taskkill calls are recorded apart.
 */
function makeFakeExec(script) {
  const calls = [];
  const kills = [];
  const execFileImpl = (file, args, opts, cb) => {
    const child = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => { child.killed = true; };
    if (file === 'taskkill') {
      kills.push(args);
      setImmediate(() => { if (cb) cb(null, '', ''); });
      return child;
    }
    calls.push({ file, args, opts });
    child.pid = 5000 + calls.length;
    const step = typeof script === 'function' ? script(calls.length, file, args) : script;
    if (step === 'hang') return child;
    if (step === 'defer') {
      execFileImpl.pending.push((stdout) => cb(null, stdout, ''));
      return child;
    }
    setImmediate(() => {
      if (step && step.error) cb(step.error, '', '');
      else cb(null, step ? step.stdout : '', '');
    });
    return child;
  };
  execFileImpl.calls = calls;
  execFileImpl.kills = kills;
  // 'defer' runs wait here until the test releases them with a listing.
  execFileImpl.pending = [];
  execFileImpl.release = (stdout) => { const p = execFileImpl.pending.splice(0); for (const r of p) r(stdout); return p.length; };
  return execFileImpl;
}

const ONE_EXE = () => [{ path: 'C:\\fake\\claude.exe', viaCmd: false, source: 'test' }];

/** A real lookup driven by a fake exec. */
function makeLookup({ exec, now, seenFile = null, timeoutMs = 300, candidates = ONE_EXE, platform = 'win32', freshReuseMs } = {}) {
  return live.createLiveSessionLookup({
    execFileImpl: exec,
    ...(freshReuseMs !== undefined ? { freshReuseMs } : {}),
    resolveCandidates: candidates,
    now: now || Date.now,
    timeoutMs,
    env: { PATH: '', CLAUDECODE: '1', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    platform,
    seenStore: live.createSeenLiveStore({ filePath: seenFile }),
  });
}

/** Fake existence probe over a set of paths (case-insensitive, Windows style). */
function existsIn(paths) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
}

/** Fake WebSocket with the surface pty-manager uses. */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.pings = 0;
    this.bufferedAmount = 0;
  }
  send(p) { this.sent.push(String(p)); }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', code, reason);
  }
  ping() { this.pings++; }
  terminate() { this.readyState = 3; }
  text() { return this.sent.filter((s) => s.charAt(0) !== '{').join(''); }
  frames() {
    return this.sent.filter((s) => s.charAt(0) === '{').map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  }
  type(data) { this.emit('message', Buffer.from(JSON.stringify({ type: 'input', data })), false); }
}

/** Stub pty with a triggerable exit. */
function makeStubPty() {
  const p = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: 0,
    _exit: null,
    onData() {},
    onExit(cb) { p._exit = cb; },
    on() {},
    write(d) { p.writes.push(d); },
    resize(c, r) { p.resizes.push([c, r]); },
    kill() { p.killed++; },
  };
  return p;
}

/** pty.spawn spy. calls[i] = {shell, args, fullCommand, pty}. */
function makeSpawnSpy() {
  const calls = [];
  const fn = (shell, args, opts) => {
    const p = makeStubPty();
    calls.push({ shell, args, opts, fullCommand: args[args.length - 1], pty: p });
    return p;
  };
  fn.calls = calls;
  return fn;
}

function makeFakeProvider(id, overrides) {
  const base = {
    id,
    displayName: 'Fake ' + id,
    accentToken: 'mauve',
    cliBinary: id,
    discover: async () => [],
    parseTranscript: async () => [],
    spawnCommand: () => ({ cmd: id, args: [], cwd: null, env: {} }),
    search: async () => [],
    init: async () => {},
    dispose: async () => {},
    supportsCost: () => false,
    isIdleSignal: () => false,
    getKeyBindings: () => ({}),
  };
  return Object.assign(base, overrides || {});
}

/**
 * Fresh registry and pty-manager per fixture. The store module is NOT reset:
 * one store instance for the whole file, because several instances with
 * pending debounced saves race on the same workspaces.json rename on Windows
 * (EPERM, surfaced as an unhandled 'error' event).
 */
function resetModules() {
  for (const rel of ['../src/providers', '../src/providers/claude/spawn', '../src/providers/claude/path-decode', '../src/web/pty-manager']) {
    delete require.cache[require.resolve(rel)];
  }
}

/** Fresh registry + manager + store with a fake Claude provider using `lookup`. */
function buildPtyFixture(lookup) {
  resetModules();
  const registry = require('../src/providers');
  const { spawnCommand } = require('../src/providers/claude/spawn');
  registry.register(makeFakeProvider(CLAUDE, {
    cliBinary: CLAUDE,
    spawnCommand,
    findArtifactPath: () => path.join(os.tmpdir(), 'fake-transcript.jsonl'),
    findArtifactByWorkingDir: () => ({ jsonlPath: 'x', claudeSessionId: CONT_SID }),
    liveSessionLookup: () => lookup,
  }));
  registry.setEnabled(CLAUDE, true);
  const pm = require('../src/web/pty-manager');
  const { getStore } = require('../src/state/store');
  return { pm, mgr: new pm.PtySessionManager(), store: getStore() };
}

function makeRecord(store, { resumeSessionId = null, command = CLAUDE } = {}) {
  const ws = store.createWorkspace({ name: 'live-ws-' + Math.random().toString(36).slice(2, 8) });
  const sess = store.createSession({
    name: 'live-' + Math.random().toString(36).slice(2, 8),
    workspaceId: ws.id,
    workingDir: os.tmpdir(),
    command,
    resumeSessionId,
  });
  store.updateSession(sess.id, { provider: CLAUDE });
  return sess.id;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Gate fixtures keep real persistence and its errors, but serialize writes.
  // A debounced async save shares its temp file with the next sync save and
  // can still hold that file open on Windows, even with one Store instance.
  const fixtureStore = require('../src/state/store').getStore();
  /** Persist fixture changes before the next guard test can create records. */
  fixtureStore._debouncedSave = function saveFixtureImmediately() {
    this._dirty = true;
    this.save();
  };

  // ── A. spawn.js attach descriptor ──
  const { spawnCommand } = require('../src/providers/claude/spawn');

  await check('A1 attachShortId builds `claude attach <id>` and ignores every resume/model/permission flag', () => {
    const d = spawnCommand({ sessionId: 's', attachShortId: BG_SHORT, providerSessionId: 'x-y', newSessionId: 'z', model: 'opus', bypassPermissions: true, verbose: true, flags: ['foo'], initialPrompt: 'hi' });
    assert.strictEqual(d.cmd, CLAUDE);
    assert.deepStrictEqual(d.args, ['attach', BG_SHORT]);
    assert.ok(Object.prototype.hasOwnProperty.call(d.env, 'CLAUDECODE') && d.env.CLAUDECODE === undefined, 'CLAUDECODE scrub kept');
  });

  await check('A2 unsafe short ids throw before reaching the shell command line', () => {
    for (const bad of ['a1b2;calc', 'a b c d', '"x1234"', '%PATH%', '../x1', 'abc', 'x'.repeat(33), 'a1b2&whoami', 42, {}]) {
      assert.throws(() => spawnCommand({ attachShortId: bad }), /unsafe attachShortId/, 'accepted ' + JSON.stringify(bad));
    }
  });

  await check('A3 without attachShortId the resume descriptor is unchanged', () => {
    const d = spawnCommand({ sessionId: 's', providerSessionId: BG_SID });
    assert.deepStrictEqual(d.args, ['--resume', BG_SID]);
    const e = spawnCommand({ sessionId: 's', attachShortId: '', providerSessionId: BG_SID });
    assert.deepStrictEqual(e.args, ['--resume', BG_SID], 'empty string is "not set"');
  });

  // ── B. parseAgentsJson ──
  await check('B1 parses the real output shape (background short id, interactive pid)', () => {
    const entries = live.parseAgentsJson(LISTING);
    assert.strictEqual(entries.length, 3);
    const bg = entries.find((e) => e.sessionId === BG_SID);
    assert.strictEqual(bg.kind, 'background');
    assert.strictEqual(bg.shortId, BG_SHORT);
    const it = entries.find((e) => e.sessionId === IT_SID);
    assert.strictEqual(it.kind, 'interactive');
    assert.strictEqual(it.shortId, null);
    assert.strictEqual(it.pid, 222);
  });

  await check('B2 tolerates a banner line around the JSON array', () => {
    const entries = live.parseAgentsJson('Update available: 9.9.9\n' + LISTING + '\n');
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(live.parseAgentsJson('[warn] new version [9.9.9]\n' + LISTING + '\n[docs] https://x').length, 3, 'brackets in a banner');
    assert.strictEqual(live.parseAgentsJson('[info] nothing running\n[]').length, 0);
  });

  await check('B3 non-JSON and non-array output throw (mapped to bad-json by the runner)', () => {
    assert.throws(() => live.parseAgentsJson('error: unknown command agents'));
    assert.throws(() => live.parseAgentsJson('{"sessions": []}'));
    assert.throws(() => live.parseAgentsJson(''));
    assert.throws(() => live.parseAgentsJson('[ not json ]'));
  });

  await check('B4 entries without a sessionId are skipped; an interactive `id` never becomes a short id', () => {
    const entries = live.parseAgentsJson(JSON.stringify([{ kind: 'background', id: 'zzzz1111' }, { kind: 'interactive', id: 'yyyy2222', sessionId: IT_SID }]));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].shortId, null);
  });

  // ── C. classifyResume truth table ──
  const ok = { ok: true, entries: live.parseAgentsJson(LISTING) };
  const fail = { ok: false, error: 'timeout' };
  const NOW = 1_000_000_000;

  await check('C1 background match -> attach with its short id', () => {
    const d = live.classifyResume({ resumeSessionId: BG_SID, lookup: ok, now: NOW });
    assert.strictEqual(d.action, 'attach');
    assert.strictEqual(d.shortId, BG_SHORT);
  });

  await check('C2 interactive match -> notice, no spawn', () => {
    const d = live.classifyResume({ resumeSessionId: IT_SID, lookup: ok, now: NOW });
    assert.strictEqual(d.action, 'notice');
    assert.strictEqual(d.reason, 'interactive');
  });

  await check('C3 no match -> resume', () => {
    assert.strictEqual(live.classifyResume({ resumeSessionId: NONE_SID, lookup: ok, now: NOW }).action, 'resume');
  });

  await check('C4 ids match case-insensitively', () => {
    assert.strictEqual(live.classifyResume({ resumeSessionId: BG_SID.toUpperCase(), lookup: ok, now: NOW }).action, 'attach');
  });

  await check('C5 a listed background entry without a usable short id -> notice (unattachable), never resume', () => {
    const lk = { ok: true, entries: live.parseAgentsJson(JSON.stringify([{ kind: 'background', id: 'a;b', sessionId: BG_SID }])) };
    const d = live.classifyResume({ resumeSessionId: BG_SID, lookup: lk, now: NOW });
    assert.strictEqual(d.action, 'notice');
    assert.strictEqual(d.reason, 'unattachable');
  });

  await check('C6 background wins when a transcript is listed as both background and interactive', () => {
    const lk = { ok: true, entries: live.parseAgentsJson(JSON.stringify([{ ...IT_ENTRY, sessionId: BG_SID }, BG_ENTRY])) };
    assert.strictEqual(live.classifyResume({ resumeSessionId: BG_SID, lookup: lk, now: NOW }).action, 'attach');
  });

  await check('C7 lookup failed + fresh seen-live marker -> notice (fail safe)', () => {
    const d = live.classifyResume({ resumeSessionId: BG_SID, lookup: fail, marker: { kind: 'background', at: NOW - 60_000 }, now: NOW });
    assert.strictEqual(d.action, 'notice');
    assert.strictEqual(d.reason, 'lookup-failed');
  });

  await check('C8 lookup failed + record status live-bg or live-terminal -> notice', () => {
    for (const status of ['live-bg', 'live-terminal']) {
      const d = live.classifyResume({ resumeSessionId: NONE_SID, lookup: fail, record: { status }, now: NOW });
      assert.strictEqual(d.action, 'notice', status);
    }
  });

  await check('C9 lookup failed on an unmarked record -> resume (degraded), as today', () => {
    const d = live.classifyResume({ resumeSessionId: NONE_SID, lookup: fail, record: { status: 'running' }, now: NOW });
    assert.strictEqual(d.action, 'resume');
    assert.strictEqual(d.degraded, true);
  });

  await check('C10 lookup failed + marker older than the window -> resume', () => {
    const d = live.classifyResume({ resumeSessionId: BG_SID, lookup: fail, marker: { kind: 'background', at: NOW - live.SEEN_LIVE_WINDOW_MS - 1 }, now: NOW });
    assert.strictEqual(d.action, 'resume');
  });

  // ── D. binary resolution ──
  const HOME = 'C:\\Users\\Arthur';
  const NPM = HOME + '\\AppData\\Roaming\\npm';
  const NPM_EXE = NPM + '\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

  await check('D1 S4U-style PATH without npm still finds the npm package exe via APPDATA', () => {
    const c = live.resolveClaudeCandidates({ env: { PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs', APPDATA: HOME + '\\AppData\\Roaming' }, platform: 'win32', homedir: HOME, exists: existsIn([NPM_EXE, NPM + '\\claude.cmd']) });
    assert.ok(c.length >= 1);
    assert.strictEqual(c[0].path.toLowerCase(), NPM_EXE.toLowerCase());
    assert.strictEqual(c[0].viaCmd, false);
  });

  await check('D2 APPDATA and USERPROFILE unset: falls back to the home directory', () => {
    const c = live.resolveClaudeCandidates({ env: { PATH: 'C:\\Windows\\system32' }, platform: 'win32', homedir: HOME, exists: existsIn([NPM_EXE]) });
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].path.toLowerCase(), NPM_EXE.toLowerCase());
  });

  await check('D3 an npm shim found on PATH is mapped to the claude.exe it wraps (no cmd.exe layer)', () => {
    const c = live.resolveClaudeCandidates({ env: { PATH: NPM }, platform: 'win32', homedir: HOME, exists: existsIn([NPM + '\\claude.cmd', NPM_EXE]) });
    assert.strictEqual(c[0].path.toLowerCase(), NPM_EXE.toLowerCase());
    assert.strictEqual(c[0].viaCmd, false);
    assert.ok(/shim-target/.test(c[0].source));
    assert.strictEqual(c.filter((x) => x.path.toLowerCase() === NPM_EXE.toLowerCase()).length, 1, 'de-duplicated');
  });

  await check('D4 a shim with no resolvable target runs through cmd.exe; metacharacter paths are skipped', () => {
    const shim = 'D:\\tools bin\\claude.cmd';
    const c = live.resolveClaudeCandidates({ env: { PATH: 'D:\\tools bin;D:\\odd%dir;D:\\q"t' }, platform: 'win32', homedir: 'Z:\\nohome', exists: existsIn([shim, 'D:\\odd%dir\\claude.cmd', 'D:\\q"t\\claude.cmd']) });
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].path, shim);
    assert.strictEqual(c[0].viaCmd, true);
  });

  await check('D5 CWM_CLAUDE_BIN wins; native ~/.local/bin/claude.exe is found; `Path` casing is honoured', () => {
    const native = HOME + '\\.local\\bin\\claude.exe';
    const override = 'E:\\pinned\\claude.exe';
    const c = live.resolveClaudeCandidates({ env: { Path: NPM, CWM_CLAUDE_BIN: override, USERPROFILE: HOME }, platform: 'win32', homedir: HOME, exists: existsIn([override, native, NPM_EXE, NPM + '\\claude.cmd']) });
    assert.strictEqual(c[0].path, override);
    assert.strictEqual(c[1].path.toLowerCase(), NPM_EXE.toLowerCase(), 'PATH (via `Path`) before well-known');
    assert.ok(c.some((x) => x.path === native), 'native install listed');
  });

  await check('D6 POSIX: PATH order, then ~/.local/bin/claude; nothing found -> empty list', () => {
    const c = live.resolveClaudeCandidates({ env: { PATH: '/usr/bin:/opt/cc', HOME: '/home/a' }, platform: 'linux', homedir: '/home/a', exists: existsIn(['/opt/cc/claude', '/home/a/.local/bin/claude']) });
    assert.deepStrictEqual(c.map((x) => x.path), ['/opt/cc/claude', '/home/a/.local/bin/claude']);
    const none = live.resolveClaudeCandidates({ env: { PATH: '' }, platform: 'win32', homedir: 'Z:\\none', exists: () => false });
    assert.deepStrictEqual(none, []);
  });

  // ── E. runner, cache, fail-safe markers ──
  await check('E1 direct exe: argv form, windowsHide, CLAUDECODE scrubbed from the lookup env', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const lk = makeLookup({ exec });
    const r = await lk.list();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(exec.calls[0].file, 'C:\\fake\\claude.exe');
    assert.deepStrictEqual(exec.calls[0].args, ['agents', '--json']);
    assert.strictEqual(exec.calls[0].opts.windowsHide, true);
    assert.ok(!('CLAUDECODE' in exec.calls[0].opts.env));
  });

  await check('E2 cmd.exe shim: /d /s /c with the path quoted inside the outer quotes, verbatim args', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const shim = 'C:\\Program Files\\n pm\\claude.cmd';
    const lk = makeLookup({ exec, candidates: () => [{ path: shim, viaCmd: true, source: 'test' }] });
    const r = await lk.list();
    assert.strictEqual(r.ok, true);
    const call = exec.calls[0];
    assert.strictEqual(call.file, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepStrictEqual(call.args, ['/d', '/s', '/c', '""' + shim + '" agents --json"']);
    assert.strictEqual(call.opts.windowsVerbatimArguments, true);
    assert.strictEqual(call.opts.windowsHide, true);
  });

  await check('E3 non-JSON output -> ok:false bad-json', async () => {
    const r = await makeLookup({ exec: makeFakeExec({ stdout: 'Usage: claude [options]' }) }).list();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'bad-json');
  });

  await check('E4 ENOENT on the first candidate falls through to the next one', async () => {
    const exec = makeFakeExec((n) => (n === 1 ? { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) } : { stdout: LISTING }));
    const lk = makeLookup({ exec, candidates: () => [{ path: 'C:\\gone\\claude.exe', viaCmd: false }, { path: 'C:\\real\\claude.exe', viaCmd: false }] });
    const r = await lk.list();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(exec.calls.length, 2);
    assert.strictEqual(r.bin, 'C:\\real\\claude.exe');
  });

  await check('E5 a hanging CLI resolves as timeout on time and its process tree is killed by PID', async () => {
    const exec = makeFakeExec('hang');
    const lk = makeLookup({ exec, timeoutMs: 120, candidates: () => [{ path: 'C:\\a\\claude.exe', viaCmd: false }, { path: 'C:\\b\\claude.exe', viaCmd: false }] });
    const t0 = Date.now();
    const r = await lk.list();
    const took = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'timeout');
    assert.ok(took < 1000, 'took ' + took + ' ms');
    assert.strictEqual(exec.calls.length, 1, 'a hang is not retried with another candidate');
    await tick(10);
    assert.deepStrictEqual(exec.kills[0], ['/PID', String(exec.calls.length + 5000), '/T', '/F']);
  });

  await check('E6 a non-zero exit -> ok:false exit-code', async () => {
    const r = await makeLookup({ exec: makeFakeExec({ error: Object.assign(new Error('Command failed'), { code: 1 }) }) }).list();
    assert.strictEqual(r.error, 'exit-code');
  });

  await check('E7 cache: one CLI run inside the TTL, a new run after it; failures expire sooner', async () => {
    let now = 1000;
    const exec = makeFakeExec({ stdout: LISTING });
    const lk = makeLookup({ exec, now: () => now });
    await lk.list();
    now += live.CACHE_TTL_MS - 1;
    const second = await lk.list();
    assert.strictEqual(exec.calls.length, 1);
    assert.strictEqual(second.cached, true);
    now += 2;
    await lk.list();
    assert.strictEqual(exec.calls.length, 2);

    let t = 1000;
    const failing = makeFakeExec({ stdout: 'nope' });
    const lf = makeLookup({ exec: failing, now: () => t });
    await lf.list();
    t += live.FAILURE_TTL_MS + 1;
    await lf.list();
    assert.strictEqual(failing.calls.length, 2, 'failure cached only FAILURE_TTL_MS');
    assert.ok(live.FAILURE_TTL_MS < live.CACHE_TTL_MS);
    assert.strictEqual(live.CACHE_TTL_MS, 10000);
    assert.strictEqual(live.LOOKUP_TIMEOUT_MS, 5000);
  });

  await check('E8 concurrent callers share one CLI run; invalidate() forces a fresh one', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const lk = makeLookup({ exec });
    const rs = await Promise.all([lk.list(), lk.list(), lk.resolveResumeAction({ resumeSessionId: BG_SID }), lk.resolveResumeAction({ resumeSessionId: IT_SID })]);
    assert.strictEqual(exec.calls.length, 1);
    assert.strictEqual(rs[2].action, 'attach');
    assert.strictEqual(rs[3].action, 'notice');
    lk.invalidate();
    await lk.list();
    assert.strictEqual(exec.calls.length, 2);
    await lk.list({ fresh: true });
    assert.strictEqual(exec.calls.length, 2, 'a fresh re-ask inside the 1 s floor reuses the listing');
    const lk2 = makeLookup({ exec, freshReuseMs: 0 });
    await lk2.list();
    await lk2.list({ fresh: true });
    assert.strictEqual(exec.calls.length, 4, 'outside the floor a fresh re-ask runs the CLI');
  });

  await check('E9 seen-live markers: set by a listing, used when the next lookup fails, cleared when a listing drops the id', async () => {
    let now = 5_000_000;
    let mode = 'with';
    const exec = makeFakeExec(() => {
      if (mode === 'fail') return { stdout: 'garbage' };
      if (mode === 'without') return { stdout: JSON.stringify([IT_ENTRY]) };
      return { stdout: LISTING };
    });
    const lk = makeLookup({ exec, now: () => now });
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: BG_SID })).action, 'attach');
    assert.strictEqual(lk.seenStore.get(BG_SID).liveState, 'live-bg');
    assert.strictEqual(lk.seenStore.get(IT_SID).liveState, 'live-terminal');
    mode = 'fail'; lk.invalidate(); now += 60_000;
    const failSafe = await lk.resolveResumeAction({ resumeSessionId: BG_SID });
    assert.strictEqual(failSafe.action, 'notice');
    assert.strictEqual(failSafe.reason, 'lookup-failed');
    assert.strictEqual(failSafe.lookup.ok, false);
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: NONE_SID })).action, 'resume', 'unmarked still resumes');
    mode = 'without'; lk.invalidate();
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: BG_SID })).action, 'resume');
    assert.strictEqual(lk.seenStore.get(BG_SID), null, 'marker dropped by an authoritative listing');
    mode = 'fail'; lk.invalidate();
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: BG_SID })).action, 'resume');
  });

  await check('E10 markers persist to disk and survive a restart (new store instance)', async () => {
    const file = path.join(process.env.CWM_DATA_DIR, 'seen-test-' + Date.now() + '.json');
    const exec = makeFakeExec({ stdout: LISTING });
    await makeLookup({ exec, seenFile: file }).list();
    assert.ok(fs.existsSync(file));
    const reloaded = live.createSeenLiveStore({ filePath: file });
    assert.strictEqual(reloaded.get(BG_SID).shortId, BG_SHORT);
    const afterRestart = makeLookup({ exec: makeFakeExec({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), seenFile: file });
    const d = await afterRestart.resolveResumeAction({ resumeSessionId: IT_SID });
    assert.strictEqual(d.action, 'notice', 'pane restore after a Workbook restart fails safe from the persisted marker');
  });

  await check('E11 unsafe or empty transcript ids never run the CLI; isKnownLive reads cache then markers, never execs', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const lk = makeLookup({ exec });
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: 'a;b' })).action, 'resume');
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: '' })).action, 'resume');
    assert.strictEqual(exec.calls.length, 0);
    assert.strictEqual(lk.isKnownLive(BG_SID), false);
    await lk.list();
    assert.strictEqual(lk.isKnownLive(BG_SID), true);
    assert.strictEqual(lk.isKnownLive(NONE_SID), false);
    assert.strictEqual(exec.calls.length, 1);
  });

  await check('E12 a stripped environment gets the profile variables back, and the CLI runs from the account home', async () => {
    const filled = live.withProfileEnv({ PATH: 'C:\\Windows\\system32' }, { platform: 'win32', homedir: 'C:\\Users\\Arthur' });
    assert.strictEqual(filled.USERPROFILE, 'C:\\Users\\Arthur');
    assert.strictEqual(filled.HOMEDRIVE, 'C:');
    assert.strictEqual(filled.HOMEPATH, '\\Users\\Arthur');
    assert.strictEqual(filled.APPDATA, 'C:\\Users\\Arthur\\AppData\\Roaming');
    assert.strictEqual(filled.LOCALAPPDATA, 'C:\\Users\\Arthur\\AppData\\Local');
    const kept = live.withProfileEnv({ UserProfile: 'D:\\Other', APPDATA: 'D:\\Roam' }, { platform: 'win32', homedir: 'C:\\Users\\Arthur' });
    assert.strictEqual(kept.UserProfile, 'D:\\Other');
    assert.ok(!('USERPROFILE' in kept), 'case-insensitive presence check');
    assert.strictEqual(kept.APPDATA, 'D:\\Roam');
    assert.strictEqual(live.withProfileEnv({}, { platform: 'linux', homedir: '/home/a' }).HOME, '/home/a');

    const exec = makeFakeExec({ stdout: LISTING });
    const home = os.homedir();
    const lk = live.createLiveSessionLookup({ execFileImpl: exec, resolveCandidates: ONE_EXE, env: { PATH: 'C:\\Windows\\system32' }, platform: 'win32', homedir: home, seenStore: live.createSeenLiveStore() });
    await lk.list();
    assert.strictEqual(exec.calls[0].opts.env.USERPROFILE, home);
    assert.strictEqual(exec.calls[0].opts.cwd, home);
  });

  // ── F. custom-command resume parsing ──
  await check('F1 parseResumeCommand reads --resume/-r/--resume=/--continue/-c and respects --fork-session', () => {
    const p = live.parseResumeCommand;
    assert.strictEqual(p(CLAUDE + ' --resume ' + BG_SID).resumeId, BG_SID);
    assert.strictEqual(p(CLAUDE + ' -r ' + BG_SID + ' --verbose').resumeId, BG_SID);
    assert.strictEqual(p(CLAUDE + ' --resume=' + BG_SID).resumeId, BG_SID);
    assert.strictEqual(p('C:/tools/claude.cmd --resume ' + BG_SID).resumeId, BG_SID);
    assert.deepStrictEqual(p(CLAUDE + ' --continue'), { resumeId: null, continueInCwd: true, unknownResume: false, fork: false });
    assert.strictEqual(p(CLAUDE + ' -c').continueInCwd, true);
    assert.strictEqual(p(CLAUDE + ' --resume ' + BG_SID + ' --fork-session').fork, true);
    assert.deepStrictEqual(p(CLAUDE + ' --resume'), { resumeId: null, continueInCwd: false, unknownResume: true, fork: false }, 'bare --resume is the picker: target unknown');
    assert.deepStrictEqual(p(CLAUDE + ' --dangerously-skip-permissions'), { resumeId: null, continueInCwd: false, unknownResume: false, fork: false });
    assert.strictEqual(p('codex --resume ' + BG_SID), null); // gsd:provider-literal-allowed
    assert.strictEqual(p('td start'), null);
    assert.strictEqual(p(CLAUDE + ' -r' + BG_SID).resumeId, BG_SID, 'attached short value');
    assert.strictEqual(p(CLAUDE + ' -r=' + BG_SID).resumeId, BG_SID);
  });

  // ── G. pty-manager gate, end to end with a fake exec ──
  await check('G1 background match: one spawn of `claude attach <id>`, no --resume, marked as an attach pane', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const { mgr, store } = buildPtyFixture(makeLookup({ exec }));
    const id = makeRecord(store, { resumeSessionId: BG_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { cols: 100, rows: 30, _ptySpawnForTesting: spy });
    assert.strictEqual(spy.calls.length, 0, 'nothing spawned before the lookup answers');
    await until(() => spy.calls.length === 1, 3000, 'attach spawn');
    const cmd = spy.calls[0].fullCommand;
    assert.ok(/(^|\s)claude attach a1b2c3d4$/.test(cmd), cmd);
    assert.ok(!/--resume/.test(cmd), cmd);
    const s = mgr.getSession(id);
    assert.strictEqual(s.attachShortId, BG_SHORT);
    assert.ok(s.clients.has(ws));
    assert.ok(s.scrollback.join('').includes('Attached to live background session ' + BG_SHORT));
    assert.strictEqual(mgr.listSessions()[0].attached, true);
    assert.strictEqual(store.getSession(id).resumeSessionId, BG_SID, 'record keeps its transcript id');
    await tick();
    assert.strictEqual(spy.calls.length, 1);
  });

  await check('G2 interactive match: notice in the pane + toast frame, socket kept open, nothing spawned; `copy` opens a copy', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const { mgr, store } = buildPtyFixture(makeLookup({ exec }));
    const id = makeRecord(store, { resumeSessionId: IT_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'notice');
    await tick(30);
    assert.strictEqual(spy.calls.length, 0);
    assert.strictEqual(ws.closed, null, 'no close, so the client never enters its reconnect ladder');
    assert.ok(ws.text().includes('live in a terminal on the PC ("term-one", pid 222)'));
    const notice = ws.frames().find((f) => f.type === 'notice');
    assert.strictEqual(notice.code, 'LIVE_ELSEWHERE');
    assert.ok(!ws.frames().some((f) => !['notice'].includes(f.type)), 'no other JSON frame types (unknown ones would print as text)');
    ws.type('cpo');
    ws.type('\x7f\x7f');
    ws.type('opy');
    await tick();
    assert.strictEqual(spy.calls.length, 0, 'no spawn before Enter');
    ws.type('\r');
    await until(() => spy.calls.length === 1, 1000, 'confirmed copy');
    assert.ok(spy.calls[0].fullCommand.includes('--resume ' + IT_SID));
    assert.ok(mgr.getSession(id).clients.has(ws));
  });

  await check('G3 held notice: Enter re-checks with a fresh listing; a session that has ended then resumes', async () => {
    let listing = LISTING;
    const exec = makeFakeExec(() => ({ stdout: listing }));
    const { mgr, store } = buildPtyFixture(makeLookup({ exec, freshReuseMs: 0 }));
    const id = makeRecord(store, { resumeSessionId: IT_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'notice');
    const runsBefore = exec.calls.length;
    listing = JSON.stringify([BG_ENTRY]);
    ws.type('\r');
    await until(() => spy.calls.length === 1, 3000, 'resume after recheck');
    assert.ok(exec.calls.length > runsBefore, 'the recheck bypassed the 10 s cache');
    assert.ok(spy.calls[0].fullCommand.includes('--resume ' + IT_SID));
  });

  await check('G4 held notice: any other word re-prompts and spawns nothing', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { resumeSessionId: IT_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'notice');
    ws.type('yes\r');
    ws.type('\x1b[A\x1b[O');
    await tick(50);
    assert.strictEqual(spy.calls.length, 0);
    assert.ok(ws.text().split('Type copy').length >= 3, 're-prompted');
    ws.close(1000, 'bye');
    await tick();
    assert.strictEqual(mgr._liveHolds.size, 0, 'hold released on close');
  });

  await check('G5 no match -> the usual `--resume <id>`', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    const spy = makeSpawnSpy();
    mgr.attachClient(id, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'resume spawn');
    assert.ok(spy.calls[0].fullCommand.includes('--resume ' + NONE_SID));
    assert.strictEqual(mgr.getSession(id).attachShortId, null);
  });

  await check('G6 lookup failure on an unmarked record -> resume (degraded, as before the fix)', async () => {
    const exec = makeFakeExec({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
    const { mgr, store } = buildPtyFixture(makeLookup({ exec }));
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    const spy = makeSpawnSpy();
    mgr.attachClient(id, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'resume spawn');
    assert.ok(spy.calls[0].fullCommand.includes('--resume ' + NONE_SID));
  });

  await check('G7 lookup failure on a record seen live (or marked live-bg) -> notice, never a --resume copy', async () => {
    let mode = 'ok';
    const exec = makeFakeExec(() => (mode === 'ok' ? { stdout: LISTING } : 'hang'));
    const lookup = makeLookup({ exec, timeoutMs: 80 });
    await lookup.list();
    lookup.invalidate();
    mode = 'hang';
    const { mgr, store } = buildPtyFixture(lookup);
    const id = makeRecord(store, { resumeSessionId: BG_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'fail-safe notice');
    assert.strictEqual(spy.calls.length, 0);
    assert.ok(ws.text().includes('Could not check whether this session is running (claude agents: timeout)'));
    assert.ok(ws.text().includes('seen live as a background session'));

    const id2 = makeRecord(store, { resumeSessionId: NONE_SID });
    store.updateSession(id2, { status: 'live-bg' });
    const ws2 = new FakeWs();
    mgr.attachClient(id2, ws2, { _ptySpawnForTesting: spy });
    await until(() => ws2.text().includes('Type copy'), 3000, 'record-status notice');
    assert.strictEqual(spy.calls.length, 0);
  });

  await check('G8 a socket that closes during the lookup spawns nothing', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const lookup = makeLookup({ exec });
    const { mgr, store } = buildPtyFixture(lookup);
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    ws.close(1001, 'navigated away');
    await tick(60);
    assert.strictEqual(spy.calls.length, 0);
    assert.strictEqual(mgr.getSession(id), undefined);
  });

  await check('G9 two sockets opening one session during a lookup: one CLI run, one spawn, both attached', async () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const { mgr, store } = buildPtyFixture(makeLookup({ exec }));
    const id = makeRecord(store, { resumeSessionId: BG_SID });
    const spy = makeSpawnSpy();
    const a = new FakeWs();
    const b = new FakeWs();
    mgr.attachClient(id, a, { _ptySpawnForTesting: spy });
    mgr.attachClient(id, b, { _ptySpawnForTesting: spy });
    await until(() => mgr.getSession(id) && mgr.getSession(id).clients.size === 2, 3000, 'both attached');
    assert.strictEqual(spy.calls.length, 1);
    assert.strictEqual(exec.calls.length, 1);
  });

  await check('G10 frames sent during the lookup are replayed to the real handlers (resize reaches the PTY)', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { cols: 80, rows: 24, _ptySpawnForTesting: spy });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 133, rows: 41 })), false);
    await until(() => spy.calls.length === 1, 3000, 'spawn');
    await tick();
    assert.ok(spy.calls[0].pty.resizes.some(([c, r]) => c === 133 && r === 41), JSON.stringify(spy.calls[0].pty.resizes));
    assert.strictEqual(ws.listenerCount('message'), 1, 'early buffer listener removed');
  });

  await check('G11 spawnSession refuses a resume that skipped the gate when the transcript is known live', async () => {
    const lookup = makeLookup({ exec: makeFakeExec({ stdout: LISTING }) });
    await lookup.list();
    const { mgr, pm } = buildPtyFixture(lookup);
    const spy = makeSpawnSpy();
    assert.throws(() => mgr.spawnSession('direct-1', { command: CLAUDE, resumeSessionId: IT_SID, _ptySpawnForTesting: spy }), (e) => e.code === pm.CLAUDE_SESSION_LIVE_CODE);
    assert.strictEqual(spy.calls.length, 0);
    mgr.spawnSession('direct-2', { command: CLAUDE, resumeSessionId: IT_SID, _liveChecked: true, _ptySpawnForTesting: spy });
    assert.strictEqual(spy.calls.length, 1, 'the gate-approved path still spawns');
    mgr.spawnSession('direct-3', { command: CLAUDE, resumeSessionId: NONE_SID, _ptySpawnForTesting: spy });
    assert.strictEqual(spy.calls.length, 2, 'unknown transcripts are unaffected');
  });

  await check('G12 the same transcript already resumed in another Workbook pane -> notice, no second resume', async () => {
    const exec = makeFakeExec({ stdout: '[]' });
    const { mgr, store } = buildPtyFixture(makeLookup({ exec }));
    const a = makeRecord(store, { resumeSessionId: NONE_SID });
    const b = makeRecord(store, { resumeSessionId: NONE_SID });
    const spy = makeSpawnSpy();
    mgr.attachClient(a, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'first pane');
    const wsB = new FakeWs();
    mgr.attachClient(b, wsB, { _ptySpawnForTesting: spy });
    await until(() => wsB.text().includes('already open in another Workbook pane'), 3000, 'notice');
    assert.strictEqual(spy.calls.length, 1);
  });

  await check('G13 a Workbook pane that just exited is re-checked, not reported as "live elsewhere"', async () => {
    let runs = 0;
    const exec = makeFakeExec(() => {
      runs++;
      return { stdout: runs <= 2 ? JSON.stringify([{ ...IT_ENTRY, sessionId: NONE_SID }]) : '[]' };
    });
    const lookup = makeLookup({ exec });
    const { mgr, store } = buildPtyFixture(lookup);
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    const spy = makeSpawnSpy();
    mgr.spawnSession(id, { command: CLAUDE, resumeSessionId: NONE_SID, _liveChecked: true, _ptySpawnForTesting: spy });
    spy.calls[0].pty._exit({ exitCode: 0 });
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 2, 5000, 'respawn after recheck');
    assert.ok(spy.calls[1].fullCommand.includes('--resume ' + NONE_SID));
    assert.ok(!ws.text().includes('Type copy'));
    assert.ok(exec.calls.length >= 2);
  });

  await check('G14 custom command "claude --resume <live bg>" attaches through the provider descriptor', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { command: CLAUDE + ' --resume ' + BG_SID });
    const spy = makeSpawnSpy();
    mgr.attachClient(id, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'spawn');
    assert.ok(/claude attach a1b2c3d4$/.test(spy.calls[0].fullCommand), spy.calls[0].fullCommand);
  });

  await check('G15 custom command "claude --continue" is gated on the newest transcript in the cwd', async () => {
    seedProjectsDir(os.tmpdir(), [NONE_SID, CONT_SID]);
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { command: CLAUDE + ' --continue' });
    const spy = makeSpawnSpy();
    mgr.attachClient(id, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'spawn');
    assert.ok(/claude attach c3d4e5f6$/.test(spy.calls[0].fullCommand), spy.calls[0].fullCommand);
  });

  await check('G16 non-Claude and fresh sessions stay synchronous and never run the lookup', () => {
    const exec = makeFakeExec({ stdout: LISTING });
    const { mgr, store } = buildPtyFixture(makeLookup({ exec }));
    const spy = makeSpawnSpy();
    mgr.attachClient('td-pane', new FakeWs(), { command: 'td', _ptySpawnForTesting: spy });
    assert.strictEqual(spy.calls.length, 1, 'td spawned synchronously');
    const fresh = makeRecord(store, { resumeSessionId: null });
    mgr.attachClient(fresh, new FakeWs(), { _ptySpawnForTesting: spy });
    assert.strictEqual(spy.calls.length, 2, 'fresh Claude session spawned synchronously');
    assert.ok(spy.calls[1].fullCommand.includes('--session-id'));
    assert.strictEqual(exec.calls.length, 0);
  });

  await check('G17 an attach pane that exits says it detached; killSession kills only the client PTY', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { resumeSessionId: BG_SID });
    const spy = makeSpawnSpy();
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'attach');
    spy.calls[0].pty._exit({ exitCode: 0 });
    assert.ok(ws.text().includes('Detached from background session ' + BG_SHORT + '; it keeps running'));
    assert.ok(ws.frames().some((f) => f.type === 'exit'));

    const id2 = makeRecord(store, { resumeSessionId: BG_SID });
    mgr.attachClient(id2, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 2, 3000, 'second attach');
    assert.ok(mgr.killSession(id2));
    assert.strictEqual(spy.calls[1].pty.killed, 1);
  });

  await check('G18 a confirmed copy moves the other sockets held on the same notice onto it', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const id = makeRecord(store, { resumeSessionId: IT_SID });
    const spy = makeSpawnSpy();
    const desk = new FakeWs();
    const phone = new FakeWs();
    mgr.attachClient(id, desk, { _ptySpawnForTesting: spy });
    await until(() => desk.text().includes('Type copy'), 3000, 'desk notice');
    mgr.attachClient(id, phone, { _ptySpawnForTesting: spy });
    await until(() => phone.text().includes('Type copy'), 3000, 'phone notice');
    desk.type('copy\r');
    await until(() => mgr.getSession(id) && mgr.getSession(id).clients.size === 2, 3000, 'both on the copy');
    assert.strictEqual(spy.calls.length, 1);
  });

  // ── R. regressions from the adversarial review (2026-09-26) ──
  await check('R1 (review F1, critical) a cached "not live" listing never decides a spawn: a session that went live since is attached', async () => {
    let t = 1_000_000;
    let listing = '[]';
    const exec = makeFakeExec(() => ({ stdout: listing }));
    const { mgr, store } = buildPtyFixture(makeLookup({ exec, now: () => t }));
    const spy = makeSpawnSpy();
    const a = makeRecord(store, { resumeSessionId: NONE_SID });
    mgr.attachClient(a, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'first open');
    listing = JSON.stringify([BG_ENTRY]);   // X becomes a background session...
    t += 1500;                              // ...1.5 s later, well inside the 10 s cache
    const b = makeRecord(store, { resumeSessionId: BG_SID });
    mgr.attachClient(b, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 2, 3000, 'second open');
    assert.ok(/claude attach a1b2c3d4$/.test(spy.calls[1].fullCommand), spy.calls[1].fullCommand);
    assert.strictEqual(exec.calls.length, 2, 'the negative answer was re-asked');
    listing = JSON.stringify([IT_ENTRY]);
    t += 1500;
    const c = makeRecord(store, { resumeSessionId: IT_SID });
    const wsC = new FakeWs();
    mgr.attachClient(c, wsC, { _ptySpawnForTesting: spy });
    await until(() => wsC.text().includes('Type copy'), 3000, 'interactive notice from a re-asked listing');
    assert.strictEqual(spy.calls.length, 2);
  });

  await check('R2 (review F3/M1, high) two pane ids opening one transcript together: one resume, the other gets the notice', async () => {
    const exec = makeFakeExec('defer');
    const { mgr, store } = buildPtyFixture(makeLookup({ exec, timeoutMs: 3000 }));
    const spy = makeSpawnSpy();
    const a = makeRecord(store, { resumeSessionId: NONE_SID });
    const b = makeRecord(store, { resumeSessionId: NONE_SID });
    const wsA = new FakeWs();
    const wsB = new FakeWs();
    mgr.attachClient(a, wsA, { _ptySpawnForTesting: spy });
    mgr.attachClient(b, wsB, { _ptySpawnForTesting: spy });
    await until(() => exec.pending.length >= 1, 2000, 'lookup started');
    exec.release('[]');
    await until(() => spy.calls.length >= 1 && (wsA.text().includes('Type copy') || wsB.text().includes('Type copy')), 3000, 'one spawn and one notice');
    await tick(50);
    assert.strictEqual(spy.calls.length, 1, 'exactly one resume: ' + spy.calls.map((c) => c.fullCommand).join(' | '));
    assert.ok((wsA.text() + wsB.text()).includes('already open in another Workbook pane'));
  });

  await check('R3 (review F2, high) --continue: target read from the pane folder\'s project dir; unknown target + live session in that folder -> notice', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-continue-'));
    const liveInFolder = { ...BG_ENTRY, sessionId: 'f0f0f0f0-0000-4000-8000-00000000000f', id: 'f0f0f0f0', cwd: folder.toUpperCase() + '\\' };
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: JSON.stringify([liveInFolder]) }) }));
    const spy = makeSpawnSpy();
    const id = makeRecord(store, { command: CLAUDE + ' --continue' });
    store.updateSession(id, { workingDir: folder });
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'continue notice');
    assert.ok(ws.text().includes('picks its conversation when it starts'));
    assert.strictEqual(spy.calls.length, 0);

    seedProjectsDir(folder, ['f0f0f0f0-0000-4000-8000-00000000000f']);
    live._resetNewestMemoForTesting(); // the 2 s memo still holds the answer from before the seed
    const id2 = makeRecord(store, { command: CLAUDE + ' --continue' });
    store.updateSession(id2, { workingDir: folder });
    mgr.attachClient(id2, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'attach');
    assert.ok(/claude attach f0f0f0f0$/.test(spy.calls[0].fullCommand), spy.calls[0].fullCommand);
    assert.strictEqual(live.newestTranscriptForCwd(folder), 'f0f0f0f0-0000-4000-8000-00000000000f');
  });

  await check('R4 an empty listing while this Workbook runs Claude panes is treated as blind: markers kept, fail-safe applies', async () => {
    let listing = LISTING;
    const exec = makeFakeExec(() => ({ stdout: listing }));
    const lookup = makeLookup({ exec, freshReuseMs: 0 });
    await lookup.list();
    const { mgr, store } = buildPtyFixture(lookup);
    const spy = makeSpawnSpy();
    const own = makeRecord(store, { resumeSessionId: NONE_SID });
    mgr.attachClient(own, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'own pane');
    mgr.getSession(own).createdAt = Date.now() - 60_000;
    listing = '[]';
    lookup.invalidate();
    const rec = makeRecord(store, { resumeSessionId: BG_SID });
    const ws = new FakeWs();
    mgr.attachClient(rec, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'fail-safe notice');
    assert.ok(ws.text().includes('claude agents: blind'), ws.text());
    assert.strictEqual(spy.calls.length, 1);
    assert.ok(lookup.seenStore.get(BG_SID), 'markers not wiped by the blind listing');
  });

  await check('R5 (review F4) a kill while the lookup runs cancels the spawn', async () => {
    const exec = makeFakeExec('defer');
    const { mgr, store } = buildPtyFixture(makeLookup({ exec, timeoutMs: 3000 }));
    const spy = makeSpawnSpy();
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => exec.pending.length >= 1, 2000, 'lookup started');
    assert.strictEqual(mgr.hasPendingLiveCheck(id), true, 'the kill route can see the pending check');
    mgr.killSession(id);
    exec.release('[]');
    await tick(50);
    assert.strictEqual(spy.calls.length, 0);
    assert.deepStrictEqual(ws.closed, { code: 1000, reason: 'Session terminated' });
  });

  await check('R6 (review F3 low) a record re-pointed during the lookup is checked again for its new transcript', async () => {
    const exec = makeFakeExec('defer');
    const { mgr, store } = buildPtyFixture(makeLookup({ exec, timeoutMs: 3000 }));
    const spy = makeSpawnSpy();
    const id = makeRecord(store, { resumeSessionId: NONE_SID });
    mgr.attachClient(id, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => exec.pending.length >= 1, 2000, 'lookup started');
    store.updateSession(id, { resumeSessionId: BG_SID });
    exec.release(LISTING);
    await until(() => spy.calls.length === 1, 3000, 'spawn');
    assert.ok(/claude attach a1b2c3d4$/.test(spy.calls[0].fullCommand), 'attached to the new target, not resumed: ' + spy.calls[0].fullCommand);
  });

  await check('R7 (review async F2) a custom-command pane is tracked: a second pane on its transcript gets the notice', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: '[]' }) }));
    const spy = makeSpawnSpy();
    const a = makeRecord(store, { command: CLAUDE + ' --resume ' + NONE_SID });
    mgr.attachClient(a, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'custom pane');
    assert.strictEqual(mgr.getSession(a).claudeTranscriptId, NONE_SID);
    const b = makeRecord(store, { resumeSessionId: NONE_SID });
    const wsB = new FakeWs();
    mgr.attachClient(b, wsB, { _ptySpawnForTesting: spy });
    await until(() => wsB.text().includes('already open in another Workbook pane'), 3000, 'notice');
    assert.strictEqual(spy.calls.length, 1);
  });

  await check('R8 (review F4) a record tagged for another provider whose command is Claude\'s is still gated', async () => {
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: LISTING }) }));
    const spy = makeSpawnSpy();
    const id = makeRecord(store, { command: CLAUDE + ' -r' + BG_SID });
    store.updateSession(id, { provider: 'not-registered' });
    mgr.attachClient(id, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'spawn');
    assert.ok(/claude attach a1b2c3d4$/.test(spy.calls[0].fullCommand), spy.calls[0].fullCommand);
    assert.strictEqual(mgr.getSession(id).claudeTranscriptId, BG_SID, 'attach pane keeps the transcript');
  });

  await check('R9 decisions reach the durable log in the data dir; names are stripped of control characters', async () => {
    const file = path.join(process.env.CWM_DATA_DIR, live.DECISION_LOG_FILE);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(/live-check session=\S+ transcript=\S+ action=attach reason=|action=attach/.test(text));
    assert.ok(text.includes('action=notice reason=interactive'));
    const { describeLiveNotice } = require('../src/web/pty-manager').__test;
    const out = describeLiveNotice({ reason: 'interactive', entry: { name: 'evil\x1b]0;pwned\x07\x1b[31mname', pid: 5 } });
    assert.ok(!/[\x00-\x1f]/.test(out.lines.join('')), JSON.stringify(out.lines[0]));
  });

  // ── S. round-2 review regressions ──
  await check('S1 picker, --from-pr and short clusters are recognised; unknown targets are flagged', () => {
    const p = live.parseResumeCommand;
    assert.strictEqual(p(CLAUDE + ' --from-pr 12').unknownResume, true);
    assert.strictEqual(p(CLAUDE + ' --from-pr=12').unknownResume, true);
    assert.strictEqual(p(CLAUDE + ' --resume').unknownResume, true, 'bare --resume opens the picker');
    assert.strictEqual(p(CLAUDE + ' -r --verbose').unknownResume, true);
    assert.strictEqual(p(CLAUDE + ' -cr' + BG_SID).resumeId, BG_SID, 'cluster: -c then -r with the rest');
    assert.strictEqual(p(CLAUDE + ' -cr').unknownResume, true);
    assert.strictEqual(p(CLAUDE + ' -p hi').unknownResume, false);
    assert.strictEqual(p(CLAUDE + ' --resume hytale-goku').resumeId, 'hytale-goku');
  });

  await check('S2 a resume named by session name or short id is matched too', () => {
    const lk = { ok: true, entries: live.parseAgentsJson(LISTING) };
    assert.strictEqual(live.classifyResume({ resumeSessionId: 'bg-one', lookup: lk, now: 1 }).action, 'attach');
    assert.strictEqual(live.classifyResume({ resumeSessionId: BG_SHORT, lookup: lk, now: 1 }).shortId, BG_SHORT);
    assert.strictEqual(live.classifyResume({ resumeSessionId: 'term-one', lookup: lk, now: 1 }).reason, 'interactive');
  });

  await check('S3 (round-2 R2-1, critical) --continue: a live session in the folder blocks it even when the newest transcript is not live', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-flip-'));
    const A = 'a0a0a0a0-0000-4000-8000-0000000000a0';
    const B = 'b0b0b0b0-0000-4000-8000-0000000000b0';
    seedProjectsDir(folder, [B, A]); // A newest, not live; B live in the same folder
    const liveB = { ...IT_ENTRY, sessionId: B, cwd: folder };
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec({ stdout: JSON.stringify([liveB]) }) }));
    const spy = makeSpawnSpy();
    const id = makeRecord(store, { command: CLAUDE + ' --continue' });
    store.updateSession(id, { workingDir: folder });
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'notice');
    assert.strictEqual(spy.calls.length, 0);
    assert.ok(ws.text().includes('picks its conversation when it starts'));
  });

  await check('S4 --from-pr and the picker follow the folder rule', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-picker-'));
    let listing = JSON.stringify([{ ...BG_ENTRY, cwd: folder }]);
    const { mgr, store } = buildPtyFixture(makeLookup({ exec: makeFakeExec(() => ({ stdout: listing })), freshReuseMs: 0 }));
    const spy = makeSpawnSpy();
    const id = makeRecord(store, { command: CLAUDE + ' --from-pr 7' });
    store.updateSession(id, { workingDir: folder });
    const ws = new FakeWs();
    mgr.attachClient(id, ws, { _ptySpawnForTesting: spy });
    await until(() => ws.text().includes('Type copy'), 3000, 'notice');
    assert.strictEqual(spy.calls.length, 0);
    listing = '[]';
    const id2 = makeRecord(store, { command: CLAUDE + ' --resume' });
    store.updateSession(id2, { workingDir: folder });
    mgr.attachClient(id2, new FakeWs(), { _ptySpawnForTesting: spy });
    await until(() => spy.calls.length === 1, 3000, 'picker runs when nothing is live');
    assert.ok(/claude --resume$/.test(spy.calls[0].fullCommand), spy.calls[0].fullCommand);
  });

  await check('S5 (round-2 R2-2) folders past 200 characters resolve by the CLI\'s cut-plus-hash name; markers carry the folder for a failed lookup', async () => {
    const longCwd = 'C:\\' + 'deep-folder-name\\'.repeat(14) + 'leaf';
    const { encodeClaudeProjectDir } = require('../src/providers/claude/path-decode');
    const enc = encodeClaudeProjectDir(longCwd);
    assert.ok(enc.length > live.PROJECT_DIR_NAME_MAX);
    const dir = path.join(process.env.CWM_CLAUDE_PROJECTS_DIR, enc.slice(0, live.PROJECT_DIR_NAME_MAX) + '-1a2b3c');
    fs.mkdirSync(dir, { recursive: true });
    const LONG_SID = 'e0e0e0e0-0000-4000-8000-0000000000e0';
    fs.writeFileSync(path.join(dir, LONG_SID + '.jsonl'), '{}\n');
    assert.strictEqual(live.newestTranscriptForCwd(longCwd), LONG_SID);

    let mode = 'ok';
    const exec = makeFakeExec(() => (mode === 'ok' ? { stdout: JSON.stringify([{ ...IT_ENTRY, sessionId: 'f9f9f9f9-0000-4000-8000-0000000000f9', cwd: longCwd }]) } : { stdout: 'garbage' }));
    const lk = makeLookup({ exec, freshReuseMs: 0 });
    await lk.list();
    mode = 'fail';
    lk.invalidate();
    const d = await lk.resolveContinueAction({ cwd: longCwd, transcriptId: null });
    assert.strictEqual(d.action, 'notice', 'a failed lookup still sees the folder marker');
    assert.strictEqual(d.reason, 'lookup-failed');
  });

  await check('S6 (round-2 R2-3) exact folder names win; case folding only where the file system folds case', () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      // Only a case-sensitive file system can hold both names at once.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-case-'));
      fs.mkdirSync(path.join(root, '-home-u-Proj'));
      fs.mkdirSync(path.join(root, '-home-u-proj'));
      assert.deepStrictEqual(live.projectDirsForCwd(root, '/home/u/proj', 'linux'), ['-home-u-proj']);
    }
    const onlyUpper = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-case2-'));
    fs.mkdirSync(path.join(onlyUpper, '-home-u-Proj'));
    assert.deepStrictEqual(live.projectDirsForCwd(onlyUpper, '/home/u/proj', 'linux'), []);
    assert.deepStrictEqual(live.projectDirsForCwd(onlyUpper, '/home/u/proj', 'win32'), ['-home-u-Proj']);
  });

  await check('S7 (round-2 R2-7) a cached failure does not decide a degraded resume: it is asked again', async () => {
    let t = 50_000_000;
    let mode = 'fail';
    const exec = makeFakeExec(() => (mode === 'fail' ? { error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : { stdout: LISTING }));
    const lk = makeLookup({ exec, now: () => t });
    assert.strictEqual((await lk.resolveResumeAction({ resumeSessionId: BG_SID })).action, 'resume');
    mode = 'ok';
    t += 1500; // inside the 2 s failure cache, outside the 1 s floor
    const d = await lk.resolveResumeAction({ resumeSessionId: BG_SID });
    assert.strictEqual(d.action, 'attach');
  });

  await check('S8 (round-2 R2-5) a run where no cached binary works re-resolves the binaries next time', async () => {
    let resolves = 0;
    let t = 70_000_000;
    const exec = makeFakeExec((n) => (n === 1 ? { error: Object.assign(new Error('Command failed'), { code: 1 }) } : { stdout: LISTING }));
    const lk = live.createLiveSessionLookup({
      execFileImpl: exec,
      resolveCandidates: () => { resolves++; return [{ path: 'C:\\x\\claude.exe', viaCmd: false }]; },
      now: () => t,
      env: {},
      platform: 'win32',
      seenStore: live.createSeenLiveStore(),
    });
    await lk.list();
    t += 5000;
    const r = await lk.list({ fresh: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(resolves, 2);
  });

  await check('S9 the kill route cancels a pending live check instead of answering 404', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
    const at = src.indexOf("app.post('/api/pty/:sessionId/kill'");
    const body = src.slice(at, at + 1600);
    assert.ok(body.indexOf('hasPendingLiveCheck(sessionId)') > 0 && body.indexOf('hasPendingLiveCheck(sessionId)') < body.indexOf("status(404)"));
  });

  // ── H. notice wording ──
  await check('H1 describeLiveNotice: one wording per reason, no em dash, confirm word stated', () => {
    const { describeLiveNotice } = require('../src/web/pty-manager').__test;
    const now = 10_000_000;
    const cases = [
      [{ reason: 'interactive', entry: { name: 'x', pid: 1 } }, 'live in a terminal on the PC'],
      [{ reason: 'open-in-workbook', otherSessionId: 'abc' }, 'already open in another Workbook pane'],
      [{ reason: 'unattachable', entry: { kind: 'background' } }, 'cannot attach'],
      [{ reason: 'lookup-failed', error: 'timeout', marker: { kind: 'interactive', at: now - 5 * 60000 } }, 'seen live in a terminal'],
      [{ reason: 'lookup-failed', error: 'bad-json' }, 'record says it is live'],
      [{ reason: 'known-live' }, 'just seen running'],
    ];
    for (const [d, needle] of cases) {
      const out = describeLiveNotice(d, now);
      const all = out.headline + out.lines.join(' ');
      assert.ok(all.includes(needle), needle + ' in ' + all);
      assert.ok(!all.includes(EM_DASH));
      assert.ok(out.lines[out.lines.length - 1].includes('Type copy and press Enter'));
    }
  });

  // ── I. source gates ──
  await check('I1 attachClient keeps the node-pty guard first, then the live gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'pty-manager.js'), 'utf8');
    const start = src.indexOf('  attachClient(sessionId, ws, spawnOpts = {}) {');
    assert.ok(start > 0);
    const body = src.slice(start, start + 6000);
    const ptyGuard = body.indexOf('if (!pty) {');
    const gate = body.indexOf('this._liveGateFor(sessionId, spawnOpts)');
    assert.ok(ptyGuard > 0 && gate > ptyGuard, 'order: pty guard, then live gate');
  });

  await check('I2 no em dash or spaced double hyphen in the files this fix touches', () => {
    const files = ['src/providers/claude/live-sessions.js', 'src/providers/claude/spawn.js', 'src/web/pty-manager.js', 'test/claude-live-attach.test.js'];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(!text.includes(EM_DASH), rel + ' has an em dash');
      assert.ok(!text.includes(String.fromCharCode(0x2015)), rel + ' has a horizontal bar');
      // Built at runtime so this line does not itself contain the banned pattern.
      const spacedDoubleHyphen = new RegExp('(?<=\\S) ' + '-'.repeat(2) + ' (?=\\S)');
      assert.ok(!spacedDoubleHyphen.test(text), rel + ' has a spaced double hyphen');
    }
  });

  await check('I3 the legacy start/restart routes await the live guard before launching', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
    for (const route of ["'/api/sessions/:id/start'", "'/api/sessions/:id/restart'"]) {
      const at = src.indexOf('app.post(' + route);
      assert.ok(at > 0, route);
      const body = src.slice(at, at + 1400);
      const guard = body.indexOf('await legacyLaunchLiveGuard(req.params.id)');
      const launch = Math.max(body.indexOf('launchSession(req.params.id)'), body.indexOf('restartSession(req.params.id)'));
      assert.ok(guard > 0 && launch > guard, route + ': guard before launch');
    }
    const g = src.indexOf('async function legacyLaunchLiveGuard(');
    assert.ok(/pane\.attachShortId/.test(src.slice(g, g + 2500)), 'attach panes are refused');
  });

  // ── J. legacy route guard, through the real Express app ──
  await (async () => {
    delete require.cache[require.resolve('../src/providers')];
    delete require.cache[require.resolve('../src/providers/claude')];
    delete require.cache[require.resolve('../src/web/server')];
    delete require.cache[require.resolve('../src/web/auth')];
    const exec = makeFakeExec({ stdout: LISTING });
    const liveMod = require('../src/providers/claude/live-sessions');
    liveMod._setDefaultLookupForTesting(makeLookup({ exec }));
    let server;
    try {
      const registry = require('../src/providers');
      const { getStore } = require('../src/state/store');
      const store = getStore();
      await registry.initRegistry(store);
      const { app } = require('../src/web/server');
      const auth = require('../src/web/auth');
      const token = 'live-attach-' + Math.random().toString(36).slice(2);
      auth.addToken(token);
      server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      const port = server.address().port;
      const post = (p) => new Promise((resolve, reject) => {
        const r = http.request({ hostname: '127.0.0.1', port, path: p, method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => { let body; try { body = JSON.parse(data); } catch (_) { body = data; } resolve({ status: res.statusCode, body }); });
        });
        r.on('error', reject);
        r.end('{}');
      });

      await check('J1 /start of a command that resumes a live background session -> 409 LIVE_ELSEWHERE, nothing launched', async () => {
        const id = makeRecord(store, { command: CLAUDE + ' --resume ' + BG_SID });
        const r = await post('/api/sessions/' + id + '/start');
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.strictEqual(r.body.code, 'LIVE_ELSEWHERE');
        assert.strictEqual(store.getSession(id).status, 'stopped', 'launchSession never ran');
      });

      await check('J2 /restart (Restart-all, credential switcher) of a live resume command -> 409 and no kill', async () => {
        const id = makeRecord(store, { command: CLAUDE + ' -r ' + IT_SID });
        store.updateSession(id, { status: 'running', pid: 999999 });
        const r = await post('/api/sessions/' + id + '/restart');
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.code, 'LIVE_ELSEWHERE');
        assert.strictEqual(store.getSession(id).pid, 999999, 'stopSession never ran');
      });

      await check('J3 a plain `claude` record passes the guard without running the lookup', async () => {
        const before = exec.calls.length;
        const id = makeRecord(store, { resumeSessionId: BG_SID });
        store.updateSession(id, { status: 'running', pid: 999998 });
        const r = await post('/api/sessions/' + id + '/start');
        assert.strictEqual(r.status, 200);
        assert.ok(/already running/.test(r.body.error), 'reached launchSession, which refused on its own');
        assert.strictEqual(exec.calls.length, before);
      });
    } finally {
      liveMod._setDefaultLookupForTesting(null);
      if (server) await new Promise((r) => server.close(r));
    }
  })();

  // ── K. real processes: a fake claude.cmd behind cmd.exe (Windows only) ──
  if (process.platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm live attach '));
    const writeFake = (name, js) => {
      const jsPath = path.join(dir, name + '.js');
      fs.writeFileSync(jsPath, js);
      const cmdPath = path.join(dir, name, 'claude.cmd');
      fs.mkdirSync(path.dirname(cmdPath));
      fs.writeFileSync(cmdPath, '@"' + process.execPath + '" "' + jsPath + '" %*\r\n');
      return cmdPath;
    };
    const realLookup = (cmdPath, timeoutMs = 4000) => live.createLiveSessionLookup({
      resolveCandidates: () => [{ path: cmdPath, viaCmd: true, source: 'test' }],
      timeoutMs,
      seenStore: live.createSeenLiveStore(),
    });
    const pidFile = path.join(dir, 'hang.pid');
    const good = writeFake('good', 'if (process.argv[2] !== "agents" || process.argv[3] !== "--json") { process.exit(3); } process.stdout.write(' + JSON.stringify(LISTING) + ');');
    const noisy = writeFake('noisy', 'process.stdout.write("Welcome to Claude Code\\nPlease log in");');
    const hang = writeFake('hang', 'require("fs").writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid)); setInterval(() => {}, 1000);');

    await check('K1 real cmd.exe shim in a path with spaces: argv arrives intact and the listing parses', async () => {
      const r = await realLookup(good).list();
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.entries.length, 3);
    });

    await check('K2 a real CLI printing non-JSON -> bad-json', async () => {
      const r = await realLookup(noisy).list();
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'bad-json');
    });

    await check('K3 a real hanging CLI: timeout on schedule and the node grandchild is killed with the tree', async () => {
      const t0 = Date.now();
      const r = await realLookup(hang, 2500).list();
      const took = Date.now() - t0;
      assert.strictEqual(r.error, 'timeout');
      assert.ok(took < 4000, 'took ' + took);
      await until(() => fs.existsSync(pidFile), 3000, 'pid file');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }, 5000, 'grandchild gone');
    });

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  } else {
    console.log('  SKIP  K1-K3 (Windows cmd.exe shim tests)');
  }

  const total = passed + failed;
  console.log('\n  [claude-live-attach] ' + passed + '/' + total + ' tests passed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
