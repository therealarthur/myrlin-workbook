#!/usr/bin/env node
/**
 * Live check of the B2 send path, turn state and prompt detection against the
 * REAL claude CLI (DECISIONS A24, BUILD-CONTRACT 3.6.4). Not a unit test:
 * run by hand in a scratch folder, never in a project, never inside a
 * running Workbook.
 *
 * What: mounts the chat track in this process (no listener) with a sandbox
 * CWM_DATA_DIR, starts `claude --model haiku --permission-mode default` in a
 * Workbook PTY with the VT sidecar through launchDetached, and then: sends a
 * two line message through the send queue (bracketed paste, a separate CR)
 * and checks it arrives as one prompt and that turn_duration closes the turn;
 * opens a real permission prompt and a real AskUserQuestion dialog, checks
 * the detector reads them, that a phone send is held while they are open, and
 * answers them with the dialog's keys; and interrupts a turn with one ESC.
 * Screens and results are written to test/mobile/fixtures/screens and
 * test/mobile/fixtures/scratch.
 *
 * The Workbook reads transcripts from CWM_CLAUDE_PROJECTS_DIR, a scratch
 * folder holding one junction to the scratch conversation's own folder under
 * ~/.claude/projects, so it never sees any other conversation.
 *
 * Usage: node test/mobile/fakes/live-check-workbook.js <scratchDir>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const scratch = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'b2-live'));
const dataDir = path.join(scratch, 'data-' + Date.now());
const workDir = path.join(scratch, 'claude-live-wb-' + Date.now());
const projectsFixture = path.join(scratch, 'projects-' + Date.now());
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(projectsFixture, { recursive: true });
process.env.CWM_DATA_DIR = dataDir;
process.env.CWM_VT_SIDECAR = '1';
process.env.CWM_CRED_EXTERNAL_BRIDGE_OWNER = '1';
process.env.CODEX_HOME = path.join(scratch, 'codex-empty');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
for (const k of Object.keys(process.env)) if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$|^ANTHROPIC_/.test(k)) delete process.env[k];

const { encodeClaudeProjectDir } = require('../../../src/providers/claude/path-decode');
const encoded = encodeClaudeProjectDir(workDir);
const realProjectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
fs.mkdirSync(realProjectDir, { recursive: true });
fs.symlinkSync(realProjectDir, path.join(projectsFixture, encoded), 'junction');
process.env.CWM_CLAUDE_PROJECTS_DIR = projectsFixture;

const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'fixtures', 'screens');
const SCRATCH_OUT = path.join(ROOT, 'fixtures', 'scratch');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { startedAt: new Date().toISOString(), cli: 'claude 2.1.283', model: 'haiku', steps: {} };

/** JSON with non ASCII escaped (gate G12a). */
function asciiJson(v) {
  const BS = String.fromCharCode(92);
  return JSON.stringify(v, null, 2).replace(/[^\x00-\x7e]/g, (c) => BS + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function save(dir, name, v) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), asciiJson(v) + '\n'); }

async function until(pred, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await pred()) return true; await sleep(250); }
  console.log('  timeout: ' + label);
  return false;
}

async function main() {
  const registry = require('../../../src/providers');
  const { getStore } = require('../../../src/state/store');
  const { PtySessionManager } = require('../../../src/web/pty-manager');
  const { mountChat } = require('../../../src/web/mobile/chat');
  const { createB1Stub } = require('./b1-stub');
  const { snapshotFromTerminal } = require('../../../src/web/mobile/chat/screen-reader');
  const store = getStore();
  await registry.initRegistry(store, {});
  const pm = new PtySessionManager();
  const b1 = createB1Stub();
  const events = [];
  const ctx = { store, getPtyManager: () => pm, registry, dataDir, mobile: Object.assign({}, b1.mobile) };
  const chat = mountChat(null, ctx, {});
  const hubPublish = chat.internals.hub.publish;
  chat.internals.hub.publish = (topic, type, data) => { events.push({ at: Date.now(), topic, type, data }); return hubPublish(topic, type, data); };
  const device = b1.addDevice();
  const ws = store.createWorkspace({ name: 'Live check' });
  const rec = store.createSession({ name: 'Live check', workspaceId: ws.id, workingDir: workDir, command: 'claude' });
  store.updateSession(rec.id, { provider: 'claude' });
  const sessionUuid = crypto.randomUUID();
  const { internals } = chat;
  let sid = null;
  const pty = () => pm.getSession(rec.id);
  const snap = async (name) => {
    const s = await internals.runtime.freshScreen(sid, 0);
    if (s) save(SCREENS, 'claude-2.1.283-live-' + name + '.json', Object.assign({ cli: 'claude', version: '2.1.283', name: 'live-' + name, via: 'Workbook PTY' }, s.snap));
    return s;
  };
  const cls = async () => { const s = await internals.runtime.freshScreen(sid, 0); return s ? s.cls : null; };
  const ev = (type, since) => events.filter((e) => e.topic === 'session:' + sid && e.type === type && e.at >= (since || 0));
  const transcript = path.join(realProjectDir, sessionUuid + '.jsonl');
  const records = () => { try { return fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
  const sendPhone = (text) => internals.sends.accept(sid, { clientMessageId: crypto.randomUUID(), text }, { deviceId: device.deviceId });
  const recOf = (r) => internals.sends._records.get(sid + '|' + r.send.clientMessageId);

  try {
    const launched = await pm.launchDetached(rec.id, { command: 'claude --model haiku --permission-mode default --session-id ' + sessionUuid, cols: 120, rows: 30 });
    results.steps.launch = launched;
    store.updateSession(rec.id, { resumeSessionId: sessionUuid });
    internals.index.invalidate();
    sid = 'cl_' + sessionUuid;
    internals.turns.watch(sid, 'subscriber');
    await until(async () => { const c = await cls(); return c && (c.kind === 'idlePrompt' || c.kind === 'unknownModal' || c.kind === 'prompt'); }, 40000, 'first screen');
    let c = await cls();
    if (c && c.kind !== 'idlePrompt') {
      await snap('startup-dialog');
      results.steps.startupDialog = { kind: c.kind, title: c.dialog && c.dialog.title };
      const p = internals.prompts.openFor(sid)[0];
      if (p) results.steps.startupDialog.answer = await internals.answers.answer(sid, p.promptId, { optionIndex: 0 }, { deviceId: device.deviceId }).catch((e) => ({ error: e.code }));
    }
    await until(async () => { const x = await cls(); return x && x.kind === 'idlePrompt'; }, 30000, 'idle');
    await snap('idle');

    // T2: a two line message as one bracketed paste plus a separate CR.
    let t0 = Date.now();
    const two = sendPhone('Reply with the single word ok.\nThis second line is part of the same message.');
    await until(() => recOf(two).state === 'confirmed' || recOf(two).state === 'failed', 30000, 'two line confirm');
    const users = records().filter((r) => r.type === 'user' && typeof r.message.content === 'string');
    await until(() => ev('turn.end', t0).length > 0, 60000, 'turn end 1');
    results.steps.twoLineSend = {
      sendState: recOf(two).state,
      reason: recOf(two).error,
      promptRecords: users.length,
      arrivedAsOnePrompt: users.length === 1 && users[0].message.content.includes('\n') && users[0].message.content.includes('second line'),
      turnEnd: ev('turn.end', t0).map((e) => ({ status: e.data.status, endSource: e.data.endSource })),
    };

    // Permission prompt from a harmless command in default mode.
    t0 = Date.now();
    await until(async () => { const x = await cls(); return x && x.kind === 'idlePrompt' && !internals.turns.isTurnOpen(sid); }, 30000, 'idle before permission');
    sendPhone('Use the Bash tool to run exactly this command and nothing else: echo myrlin-check > probe.txt');
    const gotPerm = await until(() => internals.prompts.openFor(sid).some((p) => p.kind === 'approval' && p.source === 'screenAndTranscript'), 90000, 'approval prompt');
    const perm = internals.prompts.openFor(sid)[0] || null;
    await snap('permission');
    let held = null;
    if (gotPerm) {
      const h = sendPhone('1 hello');
      await sleep(1200);
      held = { state: recOf(h).state, reason: recOf(h).reason };
      internals.sends.cancel(sid, h.send.clientMessageId, device.deviceId);
    }
    const permAnswer = perm ? await internals.answers.answer(sid, perm.promptId, { decision: 'allow' }, { deviceId: device.deviceId }).catch((e) => ({ error: e.code })) : null;
    // The model may ask again (another tool after a failed one): allow follow ups too.
    const followUps = [];
    for (let i = 0; i < 3 && !ev('turn.end', t0).length; i++) {
      const more = await until(() => ev('turn.end', t0).length > 0 || internals.prompts.openFor(sid).some((p) => p.kind === 'approval' && p.promptId !== (perm && perm.promptId)), 45000, 'follow up or end');
      const next = internals.prompts.openFor(sid).find((p) => p.kind === 'approval');
      if (!more || !next) break;
      await snap('permission-followup-' + i);
      followUps.push({ title: next.title, detail: next.detail, options: next.options.map((o) => o.label + ' [' + o.role + ']'), answer: await internals.answers.answer(sid, next.promptId, { decision: 'allow' }, { deviceId: device.deviceId }).catch((e) => ({ error: e.code })) });
    }
    await until(() => ev('turn.end', t0).length > 0, 90000, 'turn end after permission');
    results.steps.permission = {
      detected: !!perm,
      prompt: perm ? { kind: perm.kind, title: perm.title, detail: perm.detail, toolName: perm.toolName, source: perm.source, options: perm.options.map((o) => o.label + ' [' + o.role + ']') } : null,
      phoneSendWhileOpen: held,
      answer: permAnswer,
      followUps,
      resolved: ev('prompt.resolved', t0).map((e) => e.data.by),
      turnEnd: ev('turn.end', t0).map((e) => ({ status: e.data.status, endSource: e.data.endSource })),
      probeFileWritten: fs.existsSync(path.join(workDir, 'probe.txt')),
    };

    // AskUserQuestion dialog.
    t0 = Date.now();
    await until(async () => { const x = await cls(); return x && x.kind === 'idlePrompt' && !internals.turns.isTurnOpen(sid); }, 30000, 'idle before question');
    sendPhone('Use the AskUserQuestion tool to ask me exactly one question: "Pick a color" with the options Red and Blue. After I answer, reply with only the color I chose.');
    const gotQ = await until(() => internals.prompts.openFor(sid).some((p) => p.kind === 'question' && p.source === 'screenAndTranscript'), 90000, 'question prompt');
    const q = internals.prompts.openFor(sid).find((p) => p.kind === 'question') || null;
    await snap('question');
    let qHeld = null;
    if (gotQ) {
      const h = sendPhone('after the question');
      await sleep(1200);
      qHeld = { state: recOf(h).state, reason: recOf(h).reason };
      internals.sends.cancel(sid, h.send.clientMessageId, device.deviceId);
    }
    const blue = q ? q.questions[0].options.findIndex((o) => /blue/i.test(o.label)) : -1;
    const qAnswer = q ? await internals.answers.answer(sid, q.promptId, { answers: [{ questionIndex: 0, optionIndexes: [Math.max(0, blue)], otherText: null }] }, { deviceId: device.deviceId }).catch((e) => ({ error: e.code })) : null;
    await until(() => ev('turn.end', t0).length > 0, 90000, 'turn end after question');
    const lastText = records().filter((r) => r.type === 'assistant').map((r) => (r.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).filter(Boolean).pop() || null;
    results.steps.question = {
      detected: !!q,
      prompt: q ? { kind: q.kind, source: q.source, question: q.questions[0].question, options: q.questions[0].options.map((o) => o.label), allowOther: q.questions[0].allowOther } : null,
      phoneSendWhileOpen: qHeld,
      answer: qAnswer,
      finalText: lastText,
      turnEnd: ev('turn.end', t0).map((e) => ({ status: e.data.status, endSource: e.data.endSource })),
    };

    // Interrupt with one ESC.
    t0 = Date.now();
    await until(async () => { const x = await cls(); return x && x.kind === 'idlePrompt' && !internals.turns.isTurnOpen(sid); }, 30000, 'idle before interrupt');
    sendPhone('Count slowly from 1 to 400, one number per line, with no other text.');
    await until(() => internals.turns.isTurnOpen(sid), 30000, 'turn open for interrupt');
    await sleep(1500);
    const intr = await internals.interrupts.interrupt(sid, { clientRequestId: crypto.randomUUID() }, { deviceId: device.deviceId }).catch((e) => ({ error: e.code }));
    await until(() => ev('turn.end', t0).length > 0, 30000, 'interrupt turn end');
    await snap('after-interrupt');
    results.steps.interrupt = { result: intr, turnEnd: ev('turn.end', t0).map((e) => ({ status: e.data.status, endSource: e.data.endSource, stoppedBy: e.data.stoppedBy })) };
    results.steps.sizeClaims = { resizeStats: pty() ? pty().resizeStats : null };
  } catch (err) {
    results.error = String(err && err.stack || err);
  } finally {
    results.finishedAt = new Date().toISOString();
    save(SCRATCH_OUT, 'claude-2.1.283-workbook-live-check.json', results);
    console.log(JSON.stringify(results, null, 1).slice(0, 6000));
    try { chat.stop(); } catch (_) {}
    try { pm.destroyAll(); } catch (_) {}
    await sleep(1500);
    try { fs.rmSync(path.join(projectsFixture, encoded), { recursive: false }); } catch (_) { try { fs.unlinkSync(path.join(projectsFixture, encoded)); } catch (__) {} }
    process.exit(0);
  }
}

main();
