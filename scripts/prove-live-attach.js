#!/usr/bin/env node
/**
 * Proof harness for the live-session attach gate (2026-09-26).
 *
 * Shows, against the REAL `claude agents --json` listing, what opening a
 * Workbook pane would do for given transcript ids, without the served app:
 *
 *   node scripts/prove-live-attach.js --session <transcriptId> [--session <id> ...] [--random]
 *
 * For every id it prints the lookup decision, the spawn descriptor the pane
 * would run (`claude attach <shortId>` or `claude --resume <id>`), and for a
 * notice the text the pane would show. It then drives the real
 * PtySessionManager.attachClient gate with a pty.spawn SPY, so nothing is
 * ever spawned: the spy records the command line and refuses to start it.
 * Read-only towards Claude: the only CLI call is `claude agents --json`.
 *
 * Optional, for a scratch session only:
 *
 *   node scripts/prove-live-attach.js --live-attach <transcriptId>
 *
 * really attaches a node-pty pane to that background session through the
 * gate, prints what the pane shows, kills the pane, and re-lists to prove the
 * background session is still running. Refused unless the session's name
 * starts with "wb-attach-test", so it can never touch a real session.
 *
 * Data dir: a fresh temp dir (CWM_DATA_DIR), never ~/.myrlin.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

process.env.CWM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-prove-live-attach-'));

const SCRATCH_NAME_PREFIX = 'wb-attach-test';

/** Parse argv into { sessions: [], random: bool, liveAttach: string|null }. */
function parseArgs(argv) {
  const out = { sessions: [], random: false, liveAttach: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--session' && argv[i + 1]) out.sessions.push(argv[++i]);
    else if (argv[i] === '--random') out.random = true;
    else if (argv[i] === '--live-attach' && argv[i + 1]) out.liveAttach = argv[++i];
  }
  return out;
}

/** Minimal WebSocket stand-in with the surface pty-manager uses. */
class ProofWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.bufferedAmount = 0; }
  send(p) { this.sent.push(String(p)); }
  close(code, reason) { if (this.readyState !== 3) { this.readyState = 3; this.emit('close', code, reason); } }
  ping() {}
  terminate() { this.readyState = 3; }
  text() { return this.sent.filter((s) => s.charAt(0) !== '{').join(''); }
  frames() { return this.sent.filter((s) => s.charAt(0) === '{').map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean); }
}

/** Strip ANSI for printing. */
function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b./g, '');
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function until(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for ' + label);
    await wait(20);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const live = require('../src/providers/claude/live-sessions');
  const { spawnCommand } = require('../src/providers/claude/spawn');
  const registry = require('../src/providers');
  const { getStore } = require('../src/state/store');
  const store = getStore();
  await registry.initRegistry(store);
  const pm = require('../src/web/pty-manager');

  const lookup = live.getDefaultLookup();
  const listing = await lookup.list({ fresh: true });
  console.log('== claude agents --json ==');
  console.log('ok=' + listing.ok + (listing.ok ? ' entries=' + listing.entries.length : ' error=' + listing.error + ' ' + (listing.detail || '')) + ' bin=' + (listing.bin || '?'));
  if (!listing.ok) process.exitCode = 2;

  const ids = args.sessions.slice();
  if (args.random) ids.push(crypto.randomUUID());

  for (const id of ids) {
    console.log('\n== transcript ' + id + ' ==');
    const decision = await lookup.resolveResumeAction({ resumeSessionId: id });
    const entry = decision.entry ? { kind: decision.entry.kind, name: decision.entry.name, shortId: decision.entry.shortId, pid: decision.entry.pid } : null;
    console.log('decision: ' + JSON.stringify({ action: decision.action, reason: decision.reason || null, shortId: decision.shortId || null, entry, lookup: decision.lookup }));
    if (decision.action === 'attach') {
      const d = spawnCommand({ sessionId: 'proof', attachShortId: decision.shortId, providerSessionId: id });
      console.log('pane would run: ' + [d.cmd, ...d.args].join(' '));
    } else if (decision.action === 'resume') {
      const d = spawnCommand({ sessionId: 'proof', providerSessionId: id });
      console.log('pane would run: ' + [d.cmd, ...d.args].join(' '));
    } else {
      const n = pm.__test.describeLiveNotice(decision);
      console.log('pane would show (nothing spawned):');
      for (const l of n.lines) console.log('  [Myrlin] ' + l);
    }

    // Same decision through the real attachClient gate, with a spawn spy.
    const mgr = new pm.PtySessionManager();
    const ws = new ProofWs();
    const spawned = [];
    const spy = (shell, shellArgs) => {
      spawned.push(shell + ' ' + shellArgs.join(' '));
      throw new Error('proof spy: spawn refused on purpose');
    };
    mgr.attachClient('proof-' + id, ws, { command: 'claude', resumeSessionId: id, _ptySpawnForTesting: spy }); // gsd:provider-literal-allowed (proof harness drives the Claude provider)
    await until(() => spawned.length > 0 || ws.text().includes('Type copy') || ws.readyState === 3, 8000, 'gate outcome');
    if (spawned.length) console.log('attachClient gate -> spawn requested: ' + spawned[0] + '   (spy, not started)');
    else if (ws.text().includes('Type copy')) console.log('attachClient gate -> held on notice, spawn requested: none; toast frame: ' + JSON.stringify(ws.frames().find((f) => f.type === 'notice') || null));
    else console.log('attachClient gate -> closed: ' + plain(ws.text()));
    ws.close(1000, 'proof done');
  }

  if (args.liveAttach) await liveAttach(args.liveAttach, lookup, pm);
  // Give ws close handlers a beat, then exit (the store keeps timers alive).
  await wait(200);
  process.exit(process.exitCode || 0);
}

/**
 * Really attach a pane to a scratch background session, then kill the pane
 * and prove the background session survived. Scratch sessions only.
 */
async function liveAttach(transcriptId, lookup, pm) {
  console.log('\n== live attach proof for ' + transcriptId + ' ==');
  const before = await lookup.list({ fresh: true });
  const entry = before.ok && before.entries.find((e) => e.sessionId === transcriptId);
  if (!entry || entry.kind !== 'background' || !String(entry.name || '').startsWith(SCRATCH_NAME_PREFIX)) {
    console.log('REFUSED: ' + transcriptId + ' is not a live background session named ' + SCRATCH_NAME_PREFIX + '*');
    process.exitCode = 3;
    return;
  }
  const mgr = new pm.PtySessionManager();
  const ws = new ProofWs();
  const realSpawn = require('node-pty').spawn;
  const commands = [];
  // Wrapper: only a `claude attach <scratch short id>` command may start.
  const guardedSpawn = (shell, shellArgs, opts) => {
    const line = shellArgs[shellArgs.length - 1];
    commands.push(shell + ' ' + shellArgs.join(' '));
    if (line !== 'claude attach ' + entry.shortId) throw new Error('proof guard: refusing to start "' + line + '"'); // gsd:provider-literal-allowed (proof guard compares the exact attach line)
    return realSpawn(shell, shellArgs, opts);
  };
  const sessionId = 'proof-live-' + entry.shortId;
  mgr.attachClient(sessionId, ws, { command: 'claude', resumeSessionId: transcriptId, cols: 120, rows: 30, _ptySpawnForTesting: guardedSpawn }); // gsd:provider-literal-allowed (proof harness drives the Claude provider)
  await until(() => commands.length > 0 || ws.readyState === 3, 8000, 'attach spawn');
  console.log('spawned: ' + commands[0]);
  await wait(6000);
  const pane = mgr.getSession(sessionId);
  console.log('pane alive after 6 s: ' + !!(pane && pane.alive) + ', attachShortId=' + (pane && pane.attachShortId));
  const shown = plain(ws.text()).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, 25);
  console.log('pane output (first lines, ANSI stripped):');
  for (const l of shown) console.log('  | ' + l.slice(0, 160));
  console.log('killing the pane (closes only the attach client)...');
  mgr.killSession(sessionId);
  await wait(3000);
  const after = await lookup.list({ fresh: true });
  const still = after.ok && after.entries.find((e) => e.sessionId === transcriptId);
  console.log('background session still listed after pane kill: ' + !!still + (still ? ' (id ' + still.shortId + ', state ' + still.state + ', status ' + still.status + ')' : ''));
  if (!still) process.exitCode = 4;
}

main().catch((err) => {
  console.error('FATAL ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
