#!/usr/bin/env node
/**
 * Session identity regression gate (2026-09-22).
 *
 * Symptom: opening a Workbook session produced "No conversation found with
 * session ID: <id>" inside the pane. Three causes, all covered here:
 *
 *   1. The post-spawn JSONL watcher matched project directories with
 *      decodeURIComponent, which never equals a real ~/.claude/projects name
 *      (C--Users-Arthur), so a fresh session never learned its transcript
 *      UUID. Fix: mint the UUID in pty-manager and pass `--session-id`.
 *   2. With (1) silently failing, the id was guessed from "the newest
 *      transcript in the cwd" at startup and in the cost route, binding
 *      sessions to other sessions' conversations. Fix: the guess is behind
 *      CWM_LEGACY_CWD_BACKFILL=1 and off by default.
 *   3. Transcripts age out (Claude Code cleanupPeriodDays, default 30 days)
 *      and the store kept resuming them forever. Fix: validate the resume
 *      id before spawning; if the transcript is gone, start fresh in the
 *      same cwd, keep an audit trail on the record, and tell the pane.
 *
 * Pattern mirrors test/pty-codex-spawn.test.js: plain assert + stubbed
 * pty.spawn via _ptySpawnForTesting. No third-party framework.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : String(err)));
  }
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAUDE = 'claude'; // gsd:provider-literal-allowed (test fixture for the Claude provider)

/**
 * Build a fully-populated fake provider that satisfies the registry's
 * validation gate. Caller overrides the parts each test needs.
 *
 * @param {string} id  Provider id.
 * @param {Object} overrides  Patch fields onto the base.
 */
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

/** Stub pty object with the methods pty-manager touches after spawn. */
function makeStubPty() {
  return {
    pid: 99999,
    onData: () => {},
    onExit: () => {},
    on: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}

/** Reset module caches so each test gets a fresh registry + pty-manager + store. */
function resetModules() {
  delete require.cache[require.resolve('../src/providers')];
  delete require.cache[require.resolve('../src/providers/claude/spawn')];
  delete require.cache[require.resolve('../src/providers/claude/path-decode')];
  delete require.cache[require.resolve('../src/web/pty-manager')];
  delete require.cache[require.resolve('../src/state/store')];
}

/**
 * Fresh fixture with a Claude provider whose findArtifactPath is supplied
 * by the test, so "transcript present" and "transcript gone" are both
 * deterministic and never touch the real ~/.claude/projects tree.
 *
 * @param {Object} [claudeOverrides] Extra fields for the fake Claude provider.
 */
function buildFixture(claudeOverrides) {
  resetModules();
  const registry = require('../src/providers');
  const { spawnCommand } = require('../src/providers/claude/spawn');
  const claudeProvider = makeFakeProvider(CLAUDE, Object.assign({
    cliBinary: CLAUDE,
    spawnCommand,
    findArtifactPath: () => null,
  }, claudeOverrides || {}));
  registry.register(claudeProvider);
  registry.setEnabled(CLAUDE, true);
  const { PtySessionManager } = require('../src/web/pty-manager');
  const { getStore } = require('../src/state/store');
  return { registry, ptyMgr: new PtySessionManager(), store: getStore() };
}

/** Create a Claude-tagged store session and return its id. */
function makeSession(store, opts) {
  const ws = store.createWorkspace({ name: 'identity-ws-' + Math.random().toString(36).slice(2, 8) });
  const sess = store.createSession({
    name: 'identity-' + Math.random().toString(36).slice(2, 8),
    workspaceId: ws.id,
    workingDir: (opts && opts.workingDir) || os.tmpdir(),
    command: CLAUDE,
    resumeSessionId: (opts && opts.resumeSessionId) || null,
  });
  store.updateSession(sess.id, { provider: CLAUDE });
  return sess.id;
}

/** Spawn through a spy and return what reached pty.spawn plus the session. */
function spawnCapture(ptyMgr, sessionId, opts) {
  let captured = null;
  const spy = (shell, shellArgs, spawnOpts) => {
    captured = { shell, shellArgs, spawnOpts };
    return makeStubPty();
  };
  const session = ptyMgr.spawnSession(sessionId, Object.assign({
    command: CLAUDE,
    cwd: os.tmpdir(),
    _ptySpawnForTesting: spy,
  }, opts || {}));
  const fullCommand = captured ? captured.shellArgs[captured.shellArgs.length - 1] : '';
  return { captured, session, fullCommand };
}

console.log('\n  Session identity: --session-id minting, expired resume, cwd guess off');
console.log('  ' + '-'.repeat(70));

// ── spawn.js: the flag itself ─────────────────────────────────────────────

check('spawn.js: newSessionId becomes --session-id <uuid> and no --resume', () => {
  resetModules();
  const { spawnCommand } = require('../src/providers/claude/spawn');
  const d = spawnCommand({ sessionId: 'x', newSessionId: 'aaaa1111-bbbb-4222-8ccc-333344445555' });
  const i = d.args.indexOf('--session-id');
  assert.ok(i !== -1, 'expected --session-id in args: ' + JSON.stringify(d.args));
  assert.strictEqual(d.args[i + 1], 'aaaa1111-bbbb-4222-8ccc-333344445555');
  assert.ok(!d.args.includes('--resume'), 'a fresh session must not carry --resume');
});

check('spawn.js: providerSessionId wins over newSessionId (never both flags)', () => {
  resetModules();
  const { spawnCommand } = require('../src/providers/claude/spawn');
  const d = spawnCommand({ sessionId: 'x', providerSessionId: 'resume-me', newSessionId: 'fresh-id' });
  assert.ok(d.args.includes('--resume'), 'expected --resume');
  assert.ok(!d.args.includes('--session-id'), 'must not also pass --session-id');
});

check('spawn.js: an unsafe newSessionId throws instead of reaching the shell', () => {
  resetModules();
  const { spawnCommand } = require('../src/providers/claude/spawn');
  assert.throws(() => spawnCommand({ sessionId: 'x', newSessionId: 'bad;rm -rf' }), /unsafe newSessionId/);
});

// ── path-decode.js: forward encoder ───────────────────────────────────────

check('encodeClaudeProjectDir matches how Claude Code names project dirs', () => {
  resetModules();
  const { encodeClaudeProjectDir } = require('../src/providers/claude/path-decode');
  assert.strictEqual(encodeClaudeProjectDir('C:\\Users\\Arthur'), 'C--Users-Arthur');
  assert.strictEqual(encodeClaudeProjectDir('C:\\Users\\Arthur\\.claude'), 'C--Users-Arthur--claude');
  assert.strictEqual(encodeClaudeProjectDir('C:\\Users\\Arthur\\Documents\\test workday'),
    'C--Users-Arthur-Documents-test-workday');
  assert.strictEqual(encodeClaudeProjectDir('C:\\Users\\Arthur\\Desktop\\fablin 2\\output\\FrostLynx_Engine'),
    'C--Users-Arthur-Desktop-fablin-2-output-FrostLynx-Engine');
  assert.strictEqual(encodeClaudeProjectDir('/Users/jane/.claude'), '-Users-jane--claude');
  assert.strictEqual(encodeClaudeProjectDir(''), '');
});

check('pty-manager: the watcher candidate matcher uses the encoder (source gate)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'pty-manager.js'), 'utf8');
  assert.ok(/encodeClaudeProjectDir\(resolvedCwd\)/.test(src),
    'findCandidateDirs must compare against encodeClaudeProjectDir(resolvedCwd)');
});

// ── pty-manager: fresh spawn mints the id ─────────────────────────────────

check('fresh Claude session: spawn carries --session-id <v4 uuid>, store and session learn it at once', () => {
  const { ptyMgr, store } = buildFixture();
  const sessionId = makeSession(store);
  const { captured, session, fullCommand } = spawnCapture(ptyMgr, sessionId);
  assert.ok(captured, 'pty.spawn must have been invoked');
  const m = /--session-id ([0-9a-f-]{36})/.exec(fullCommand);
  assert.ok(m, 'expected --session-id <uuid> in: ' + fullCommand);
  assert.ok(UUID_V4_RE.test(m[1]), 'minted id must be a v4 uuid, got ' + m[1]);
  assert.ok(!/--resume/.test(fullCommand), 'a fresh session must not carry --resume');
  assert.strictEqual(store.getSession(sessionId).resumeSessionId, m[1], 'store must hold the minted id immediately');
  assert.strictEqual(session.detectedResumeId, m[1], 'session must expose the id for attach-time resend');
  assert.ok(!session._cancelWatch, 'the JSONL watcher must not run when the id was minted');
});

check('fresh ad-hoc pane (no store record): id is minted, nothing is written to the store', () => {
  const { ptyMgr, store } = buildFixture();
  const before = store.getAllSessionsList().length;
  const { session, fullCommand } = spawnCapture(ptyMgr, 'adhoc-' + Math.random().toString(36).slice(2, 8));
  assert.ok(/--session-id [0-9a-f-]{36}/.test(fullCommand), 'expected --session-id in: ' + fullCommand);
  assert.ok(session.detectedResumeId, 'pane still learns its id through detectedResumeId');
  assert.strictEqual(store.getAllSessionsList().length, before, 'no store record must be created');
});

check('CWM_CLAUDE_MINT_SESSION_ID=0: no --session-id, the watcher fallback runs as before', () => {
  const prev = process.env.CWM_CLAUDE_MINT_SESSION_ID;
  process.env.CWM_CLAUDE_MINT_SESSION_ID = '0';
  try {
    const { ptyMgr, store } = buildFixture();
    const sessionId = makeSession(store);
    const { session, fullCommand } = spawnCapture(ptyMgr, sessionId);
    assert.ok(!/--session-id/.test(fullCommand), 'minting must be off: ' + fullCommand);
    assert.strictEqual(store.getSession(sessionId).resumeSessionId, null, 'nothing minted into the store');
    assert.strictEqual(typeof session._cancelWatch, 'function', 'watcher fallback must be armed');
    session._cancelWatch();
  } finally {
    if (prev === undefined) delete process.env.CWM_CLAUDE_MINT_SESSION_ID;
    else process.env.CWM_CLAUDE_MINT_SESSION_ID = prev;
  }
});

// ── pty-manager: resume validation ────────────────────────────────────────

check('resume with transcript on disk: --resume <id> is passed, nothing is minted or rewritten', () => {
  const rid = 'cccc3333-dddd-4444-8eee-555566667777';
  const { ptyMgr, store } = buildFixture({
    findArtifactPath: (id) => (id === rid ? path.join(os.tmpdir(), rid + '.jsonl') : null),
  });
  const sessionId = makeSession(store, { resumeSessionId: rid });
  const { session, fullCommand } = spawnCapture(ptyMgr, sessionId, { resumeSessionId: rid });
  assert.ok(fullCommand.includes('--resume ' + rid), 'expected --resume ' + rid + ' in: ' + fullCommand);
  assert.ok(!/--session-id/.test(fullCommand), 'a real resume must not mint');
  assert.strictEqual(store.getSession(sessionId).resumeSessionId, rid, 'store id must be untouched');
  assert.ok(!session.identityNotice, 'no notice for a healthy resume');
});

check('resume whose transcript is gone: fresh --session-id in the same cwd, audit trail, pane notice', () => {
  const gone = 'dddd4444-eeee-4555-8fff-666677778888';
  const { ptyMgr, store } = buildFixture({ findArtifactPath: () => null });
  const sessionId = makeSession(store, { resumeSessionId: gone });
  const { captured, session, fullCommand } = spawnCapture(ptyMgr, sessionId, { resumeSessionId: gone });
  assert.ok(captured, 'the pane must still get a process (no dead pane)');
  assert.ok(!/--resume/.test(fullCommand), 'must not resume a transcript that is not on disk: ' + fullCommand);
  const m = /--session-id ([0-9a-f-]{36})/.exec(fullCommand);
  assert.ok(m, 'expected a minted --session-id in: ' + fullCommand);
  assert.strictEqual(captured.spawnOpts.cwd, os.tmpdir(), 'fresh session must start in the same cwd');
  const rec = store.getSession(sessionId);
  assert.strictEqual(rec.resumeSessionId, m[1], 'store must now point at the minted id');
  assert.strictEqual(rec.previousResumeSessionId, gone, 'the expired id must be kept for audit');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.resumeExpiredAt || ''), 'resumeExpiredAt must be an ISO timestamp');
  assert.ok(session.identityNotice && session.identityNotice.code === 'RESUME_EXPIRED', 'session must carry the notice');
  assert.ok(session.identityNotice.message.includes(gone), 'notice must name the expired id');
  assert.ok(session.scrollback.join('').includes(gone), 'the notice must be in the scrollback replay');
});

check('attachClient re-sends resumeId and the notice to a late client', () => {
  const gone = 'eeee5555-ffff-4666-8000-777788889999';
  const { ptyMgr, store } = buildFixture({ findArtifactPath: () => null });
  const sessionId = makeSession(store, { resumeSessionId: gone });
  const { session } = spawnCapture(ptyMgr, sessionId, { resumeSessionId: gone });
  const sent = [];
  const ws = { readyState: 1, send: (p) => sent.push(String(p)), on: () => {}, close: () => {} };
  ptyMgr.attachClient(sessionId, ws, { cols: 100, rows: 30 });
  const frames = sent.map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  const resumeFrame = frames.find((f) => f.type === 'resumeId');
  assert.ok(resumeFrame && resumeFrame.resumeSessionId === session.detectedResumeId, 'late client must receive the minted id');
  const notice = frames.find((f) => f.type === 'notice');
  assert.ok(notice && notice.code === 'RESUME_EXPIRED', 'late client must receive the expiry notice');
});

// ── server.js + terminal.js: the guess is off, the notice is rendered ──────

check('server.js: cwd-based resume id guess is behind CWM_LEGACY_CWD_BACKFILL (startup + cost route)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
  const fnStart = src.indexOf('function backfillResumeSessionIds()');
  assert.ok(fnStart !== -1, 'backfillResumeSessionIds must exist');
  const body = src.slice(fnStart, fnStart + 2500);
  const guard = body.indexOf("CWM_LEGACY_CWD_BACKFILL !== '1'");
  const loop = body.indexOf('for (const session of sessions)');
  assert.ok(guard !== -1 && loop !== -1 && guard < loop, 'startup backfill must return before touching sessions unless the legacy switch is on');
  const costIdx = src.indexOf("app.get('/api/sessions/:id/cost'");
  assert.ok(costIdx !== -1, 'cost route must exist');
  const costBody = src.slice(costIdx, costIdx + 2500);
  assert.ok(/!session\.resumeSessionId && process\.env\.CWM_LEGACY_CWD_BACKFILL === '1'/.test(costBody),
    'cost route must not write resumeSessionId from a cwd guess by default');
});

check('terminal.js forwards the notice frame to the app shell, which shows a toast', () => {
  const term = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'terminal.js'), 'utf8');
  assert.ok(/msg\.type === 'notice'/.test(term), "terminal client must handle msg.type === 'notice'");
  assert.ok(/CustomEvent\('cwm:session-notice'/.test(term), 'terminal client must dispatch cwm:session-notice');
  // The notice must NOT be written into the live terminal: a client-side
  // write can land mid-frame in a TUI. The server's scrollback line and
  // the app toast are the two surfaces.
  const handler = term.slice(term.indexOf("msg.type === 'notice'"), term.indexOf("msg.type === 'notice'") + 900);
  assert.ok(!/_status\(/.test(handler), 'notice handler must not write a status line into the terminal');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8');
  const idx = app.indexOf("addEventListener('cwm:session-notice'");
  assert.ok(idx !== -1, 'app.js must listen for cwm:session-notice');
  assert.ok(/showToast\(/.test(app.slice(idx, idx + 600)), 'the listener must surface the message as a toast');
});

console.log('  ' + '-'.repeat(70));
console.log('  [claude-session-identity] ' + passed + '/' + (passed + failed) + ' tests passed');
if (failed > 0) process.exit(1);
process.exit(0);
