/**
 * B2: the fake Claude and Codex CLIs produce the transcript records and the
 * screens BUILD-CONTRACT 3.6.3 lists, driven through a real Workbook PTY with
 * the VT sidecar on, and classified by the same detectors as live screens.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
process.env.CWM_VT_SIDECAR = '1';
const fs = require('fs');
const path = require('path');
const kit = require('./fakes/b2-kit');
const { classify } = require('../../src/web/mobile/chat/prompt-detect');
const { snapshotFromTerminal } = require('../../src/web/mobile/chat/screen-reader');

const sb = kit.sandbox();
const { PtySessionManager } = require('../../src/web/pty-manager');
const pm = new PtySessionManager();
const PASTE = (t) => '\x1b[200~' + t + '\x1b[201~';

/** Spawn a fake CLI in a PTY with a sidecar. */
function spawn(id, command, cwd) {
  const s = pm.spawnSession(id, { command, cwd, cols: 120, rows: 30, _liveChecked: true, provider: command === 'codex' ? 'codex' : 'claude' });
  if (!s) throw new Error('spawn failed');
  return s;
}

async function screen(s, provider) {
  const start = Date.now();
  while (s.vt && s.vt._pendingBytes > 0 && Date.now() - start < 1000) await kit.sleep(10);
  return classify(snapshotFromTerminal(s.vt.term), provider);
}

async function waitScreen(s, provider, pred, label, ms) {
  let last = null;
  await kit.until(async () => { last = await screen(s, provider); return pred(last); }, ms || 15000, label);
  return last;
}

async function send(s, text) {
  s.pty.write(PASTE(text));
  await kit.sleep(80);
  s.pty.write('\r');
}

function records(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
}

function claudeFile(cwd, id) { return path.join(sb.projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl'); }

const cwdA = path.join(sb.work, 'fake-a');
fs.mkdirSync(cwdA, { recursive: true });
let claude;
let claudeId;

kit.test('providers register', async () => { await kit.initProviders(); });

kit.test('fake claude starts idle with the input row between rules and paste mode on', async () => {
  claude = spawn('fake-claude-1', 'claude', cwdA);
  const cls = await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt', 'idle');
  kit.ok(cls.input.placeholder === true && cls.input.inputText === '', 'dim placeholder is not a draft');
  kit.ok(claude.vt.getMode().bracketedPaste === true, 'bracketed paste on');
  claudeId = claude.detectedResumeId;
  kit.ok(claudeId, 'minted session id');
});

kit.test('echo: a paste plus a separate submit writes user, assistant and turn_duration', async () => {
  await send(claude, 'hello there');
  const f = claudeFile(cwdA, claudeId);
  await kit.until(() => records(f).some((r) => r.type === 'system' && r.subtype === 'turn_duration'), 8000, 'turn_duration');
  const recs = records(f);
  const u = recs.find((r) => r.type === 'user');
  kit.ok(u && u.uuid && u.timestamp && u.message.content === 'hello there', 'user record shape');
  const a = recs.find((r) => r.type === 'assistant');
  kit.ok(a.message.id && a.requestId && a.message.model && a.message.content[0].text === 'Echo: hello there', 'assistant record');
});

kit.test('a desktop draft shows as input text, not placeholder', async () => {
  claude.pty.write('draft');
  const cls = await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt' && c.input.inputText === 'draft', 'draft');
  kit.ok(!cls.input.placeholder, 'not placeholder');
  claude.pty.write('\x15');
  await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt' && c.input.inputText === '', 'cleared');
});

kit.test('tool: writes a Bash tool_use, its tool_result and a busy line while running', async () => {
  const f = claudeFile(cwdA, claudeId);
  const before = records(f).length;
  await send(claude, 'tool: run it');
  await waitScreen(claude, 'claude', (c) => c.busy, 'busy line');
  await kit.until(() => records(f).slice(before).some((r) => r.type === 'system' && r.subtype === 'turn_duration'), 8000, 'turn end');
  const recs = records(f).slice(before);
  const use = recs.find((r) => r.type === 'assistant' && r.message.content[0].type === 'tool_use');
  kit.ok(use && use.message.content[0].name === 'Bash' && use.message.content[0].input.command === 'npm test', 'tool_use');
  kit.ok(recs.some((r) => r.type === 'user' && Array.isArray(r.message.content) && r.message.content[0].type === 'tool_result'), 'tool_result');
});

kit.test('ask: draws the question dialog the detector reads, Enter answers with the highlighted option', async () => {
  const f = claudeFile(cwdA, claudeId);
  const before = records(f).length;
  await send(claude, 'ask: pick one');
  const cls = await waitScreen(claude, 'claude', (c) => c.kind === 'prompt' && c.dialog.kind === 'question', 'question');
  kit.eq(cls.dialog.modelOptions.map((o) => o.label), ['Red (Recommended)', 'Blue']);
  kit.eq(cls.dialog.otherIndex, 2);
  claude.pty.write('\x1b[B');
  await waitScreen(claude, 'claude', (c) => c.dialog && c.dialog.highlighted === 1, 'highlight moved');
  claude.pty.write('\r');
  await kit.until(() => records(f).slice(before).some((r) => r.type === 'assistant' && JSON.stringify(r.message.content).includes('You chose Blue')), 8000, 'answer');
});

kit.test('askmulti: tab row, check boxes and the review screen', async () => {
  await send(claude, 'askmulti: two');
  let cls = await waitScreen(claude, 'claude', (c) => c.kind === 'prompt' && c.dialog.kind === 'question', 'q1');
  kit.ok(cls.dialog.tabs && cls.dialog.tabs.labels.join(',') === 'Color,Sizes', 'tabs ' + JSON.stringify(cls.dialog.tabs));
  claude.pty.write('\r');
  cls = await waitScreen(claude, 'claude', (c) => c.dialog && c.dialog.multiSelect, 'q2 multi');
  claude.pty.write(' ');
  await waitScreen(claude, 'claude', (c) => c.dialog && c.dialog.options[0].checked === true, 'checked');
  claude.pty.write('\x1b[C');
  cls = await waitScreen(claude, 'claude', (c) => c.dialog && c.dialog.review, 'review');
  claude.pty.write('\r');
  await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt' || c.kind === 'busy', 'closed');
});

kit.test('approve: permission dialog with numbered options and roles; option 1 runs the tool', async () => {
  const f = claudeFile(cwdA, claudeId);
  await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt', 'idle before approve', 15000);
  const before = records(f).length;
  await send(claude, 'approve: run the tests');
  const cls = await waitScreen(claude, 'claude', (c) => c.kind === 'prompt' && c.dialog.kind === 'approval', 'approval');
  kit.eq(cls.dialog.title, 'Bash command');
  kit.eq(cls.dialog.options.map((o) => o.key), ['1', '2', '3']);
  claude.pty.write('\r');
  await kit.until(() => records(f).slice(before).some((r) => r.type === 'system' && r.subtype === 'turn_duration'), 8000, 'approved turn end');
});

kit.test('plan: the plan dialog reads as plan with keepPlanning as option 3', async () => {
  await send(claude, 'plan: something');
  const cls = await waitScreen(claude, 'claude', (c) => c.kind === 'prompt' && c.dialog.kind === 'plan', 'plan');
  const { roleOf } = require('../../src/web/mobile/chat/prompt-detect');
  kit.eq(cls.dialog.options.map((o) => roleOf(o.label)), ['allow', 'allow', 'keepPlanning']);
  claude.pty.write('\x1b');
  await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt', 'back to input');
});

kit.test('emdash: stop_hook_summary, more tool use, then exactly one turn_duration', async () => {
  const f = claudeFile(cwdA, claudeId);
  const before = records(f).length;
  await send(claude, 'emdash: go');
  await kit.until(() => records(f).slice(before).some((r) => r.type === 'system' && r.subtype === 'turn_duration'), 8000, 'turn end');
  const recs = records(f).slice(before);
  const iStop = recs.findIndex((r) => r.subtype === 'stop_hook_summary');
  const iTool = recs.findIndex((r, i) => i > iStop && r.type === 'assistant' && r.message.content[0].type === 'tool_use');
  kit.ok(iStop !== -1 && iTool > iStop, 'tool use after the stop hook summary');
  kit.eq(recs.filter((r) => r.subtype === 'turn_duration').length, 1);
  kit.ok(JSON.stringify(recs).includes('\\u2014') || recs.some((r) => JSON.stringify(r).indexOf(String.fromCharCode(0x2014)) !== -1), 'em dash in the reply');
});

kit.test('error: an isApiErrorMessage assistant record then turn_duration', async () => {
  const f = claudeFile(cwdA, claudeId);
  const before = records(f).length;
  await send(claude, 'error: boom');
  await kit.until(() => records(f).slice(before).some((r) => r.subtype === 'turn_duration'), 8000, 'turn end');
  kit.ok(records(f).slice(before).some((r) => r.isApiErrorMessage === true), 'api error record');
});

kit.test('long: a single ESC while busy writes the interrupt marker and returns to input', async () => {
  const f = claudeFile(cwdA, claudeId);
  const before = records(f).length;
  await send(claude, 'long: work');
  await waitScreen(claude, 'claude', (c) => c.busy, 'busy');
  await kit.sleep(300);
  claude.pty.write('\x1b');
  await kit.until(() => records(f).slice(before).some((r) => r.type === 'user' && JSON.stringify(r.message).includes('[Request interrupted by user')), 5000, 'marker');
  await waitScreen(claude, 'claude', (c) => c.kind === 'idlePrompt', 'idle');
});

kit.test('an image path on its own line is echoed back', async () => {
  const img = path.join(sb.work, 'pic.jpg');
  fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const f = claudeFile(cwdA, claudeId);
  const before = records(f).length;
  await send(claude, 'look\n\n' + img);
  await kit.until(() => records(f).slice(before).some((r) => r.type === 'assistant' && JSON.stringify(r.message.content).includes('Saw image')), 8000, 'saw image');
});

kit.test('agents lists the live fake session with status and waitingFor', async () => {
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'fakes', 'claude.js'), 'agents', '--json'], { env: process.env, encoding: 'utf8' });
  const list = JSON.parse(out);
  const e = list.find((x) => x.sessionId === claudeId);
  kit.ok(e && e.kind === 'interactive' && e.status && 'waitingFor' in e && e.pid, 'entry ' + out.slice(0, 200));
});

kit.test('fork-session with session-id copies the history under the new id', async () => {
  const newId = require('crypto').randomUUID();
  const s = spawn('fake-claude-fork', 'claude --resume ' + claudeId + ' --fork-session --session-id ' + newId, cwdA);
  await waitScreen(s, 'claude', (c) => c.kind === 'idlePrompt', 'fork idle');
  const recs = records(claudeFile(cwdA, newId));
  kit.ok(recs.length > 5 && recs.every((r) => r.sessionId === newId), 'copied ' + recs.length);
  pm.killSession('fake-claude-fork');
});

let codex;
kit.test('fake codex: composer, rollout markers, state row and letter key approval', async () => {
  const cwdC = path.join(sb.work, 'fake-c');
  fs.mkdirSync(cwdC, { recursive: true });
  codex = spawn('fake-codex-1', 'codex', cwdC);
  await waitScreen(codex, 'codex', (c) => c.kind === 'idlePrompt', 'codex idle');
  await send(codex, 'approve: tests');
  const cls = await waitScreen(codex, 'codex', (c) => c.kind === 'prompt', 'codex approval');
  kit.eq(cls.dialog.options.map((o) => o.key), ['y', 'p', 'esc']);
  codex.pty.write('y');
  let file = null;
  await kit.until(() => {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('rollout-')) file = p; } };
    walk(path.join(sb.codexHome, 'sessions'));
    return file && records(file).some((r) => r.type === 'event_msg' && r.payload.type === 'task_complete');
  }, 8000, 'task_complete');
  const recs = records(file);
  kit.ok(recs[0].type === 'session_meta' && recs[0].payload.originator === 'codex_cli_rs', 'session_meta');
  kit.ok(recs.some((r) => r.type === 'event_msg' && r.payload.type === 'task_started'), 'task_started');
  kit.ok(recs.some((r) => r.payload && r.payload.type === 'function_call'), 'function_call');
  kit.ok(fs.existsSync(path.join(sb.codexHome, 'state_5.sqlite')), 'state db written');
});

kit.test('fake codex: ESC while busy writes turn_aborted', async () => {
  await waitScreen(codex, 'codex', (c) => c.kind === 'idlePrompt', 'idle');
  await send(codex, 'long: x');
  await waitScreen(codex, 'codex', (c) => c.busy, 'busy');
  codex.pty.write('\x1b');
  await kit.sleep(800);
  let found = false;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (records(p).some((r) => r.payload && r.payload.type === 'turn_aborted')) found = true; } };
  walk(path.join(sb.codexHome, 'sessions'));
  kit.ok(found, 'turn_aborted');
});

kit.test('the fixture scrubber swaps user, host and scratch ids for same length placeholders', async () => {
  const { personalPairs, scrubText } = require('./fakes/scrub-fixture');
  const pairs = personalPairs({ users: ['Jordan'], hosts: ['WORKSTATION7'], ids: ['1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'] });
  const src = 'C:\\Users\\Jordan\\AppData\\Local\\Temp\\claude\\C--Users-Jordan\\1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d\\x on WORKSTATION7 jordan';
  const out = scrubText(src, pairs);
  kit.eq(out.length, src.length, 'same length keeps screen columns aligned');
  kit.ok(!/Jordan|jordan|WORKSTATION7|1a2b3c4d/.test(out), out);
});

kit.test('no committed fixture carries this machine\'s user name, host name or profile path (the repository is public)', async () => {
  const os = require('os');
  const words = new Set();
  try { words.add(os.userInfo().username); } catch (_) { /* no user info */ }
  words.add(path.basename(os.homedir()));
  words.add(os.hostname());
  const needles = Array.from(words).filter((w) => w && w.length >= 3).map((w) => w.toLowerCase());
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(json|jsonl|txt|md)$/i.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8').toLowerCase();
      for (const n of needles) if (text.includes(n)) hits.push(path.relative(__dirname, p) + ' has ' + n.length + ' letter name');
    }
  };
  walk(path.join(__dirname, 'fixtures'));
  kit.eq(hits, []);
});

kit.run(async () => { pm.destroyAll(); });
