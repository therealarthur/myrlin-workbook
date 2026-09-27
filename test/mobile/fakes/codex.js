#!/usr/bin/env node
/**
 * Fake codex CLI for the B2 tests and the Mac sandbox (BUILD-CONTRACT 3.6.3).
 *
 * What: a scriptable stand in for `codex` with a composer row, a
 * "Working (... esc to interrupt)" status line and the command approval
 * dialog with letter keys (y, a, esc). It writes rollouts under
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
 * (session_meta, turn_context, task_started, task_complete, messages,
 * encrypted reasoning, function calls and outputs, turn_aborted on ESC) and a
 * row in $CODEX_HOME/state_5.sqlite threads for the Codex thread linker.
 * Understands `resume <id>`, `fork <id>`, `-m <model>` and `-i <image>`.
 *
 * Why: tests and the sandbox need Codex sessions without a model.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Tui, termSize, homeDir, appendRecord, sleep, DIM, RESET } = require('./fake-tui');

const VERSION = '0.153.4';
const COMPOSER = String.fromCharCode(0x203a);
const BULLET = String.fromCharCode(0x2022);
const THINK_MS = Number(process.env.FAKE_CODEX_THINK_MS || 1000);
const LONG_TOTAL_MS = 20000;
const LONG_STEP_MS = 2000;
const ORIGINATOR = /desktop/i.test(process.env.FAKE_CODEX_ORIGINATOR || '') ? 'Codex Desktop' : 'codex_cli_rs';

const argv = process.argv.slice(2);
const o = { sub: null, id: null, model: 'gpt-fake-1', images: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'resume' || a === 'fork') { o.sub = a; o.id = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : null; continue; }
  if (a === '-m' || a === '--model') { o.model = argv[++i]; continue; }
  if (a === '-i' || a === '--image') { o.images.push(argv[++i]); continue; }
}

const codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
const cwd = process.cwd();

/** Find an existing rollout of a thread. */
function findRollout(id) {
  const root = path.join(codexHome, 'sessions');
  let hit = null;
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (hit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('-' + id + '.jsonl')) hit = full;
    }
  };
  walk(root, 0);
  return hit;
}

const resumed = o.sub === 'resume' && o.id ? findRollout(o.id) : null;
const threadId = resumed ? o.id : crypto.randomUUID();
const now0 = new Date();
const pad = (n) => String(n).padStart(2, '0');
const rollout = resumed || path.join(codexHome, 'sessions', String(now0.getFullYear()), pad(now0.getMonth() + 1), pad(now0.getDate()),
  'rollout-' + now0.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + threadId + '.jsonl');

function rec(type, payload) { appendRecord(rollout, { timestamp: new Date().toISOString(), type, payload }); }

let firstUserText = null;
if (!resumed) {
  if (o.sub === 'fork' && o.id) {
    const src = findRollout(o.id);
    if (src) {
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).filter((l) => { try { return JSON.parse(l).type !== 'session_meta'; } catch (_) { return false; } });
      rec('session_meta', { id: threadId, timestamp: new Date().toISOString(), cwd, originator: ORIGINATOR, cli_version: VERSION, forked_from_id: o.id });
      fs.appendFileSync(rollout, lines.join('\n') + (lines.length ? '\n' : ''));
    }
  }
  if (!fs.existsSync(rollout)) rec('session_meta', { id: threadId, timestamp: new Date().toISOString(), cwd, originator: ORIGINATOR, cli_version: VERSION });
  rec('turn_context', { cwd, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: o.model });
}

/** Write or update this thread's row in state_5.sqlite (the columns state-db.js reads). */
function writeThreadRow(preview) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(codexHome, { recursive: true });
    const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, preview TEXT, name TEXT, archived INTEGER DEFAULT 0, archived_at INTEGER, is_pinned INTEGER DEFAULT 0, thread_section_id TEXT, recency_at_ms INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, created_at TEXT, updated_at TEXT, tokens_used INTEGER, model TEXT, model_provider TEXT, reasoning_effort TEXT, approval_mode TEXT, sandbox_policy TEXT, cli_version TEXT, git_branch TEXT, git_sha TEXT, git_origin_url TEXT, thread_source TEXT, source TEXT, agent_nickname TEXT, agent_role TEXT, first_user_message TEXT)');
    const t = Date.now();
    const exists = db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId);
    if (exists) {
      db.prepare('UPDATE threads SET preview = COALESCE(?, preview), first_user_message = COALESCE(first_user_message, ?), updated_at_ms = ?, recency_at_ms = ? WHERE id = ?').run(preview, preview, t, t, threadId);
    } else {
      db.prepare('INSERT INTO threads (id, rollout_path, cwd, title, preview, archived, is_pinned, recency_at_ms, created_at_ms, updated_at_ms, created_at, updated_at, model, approval_mode, sandbox_policy, cli_version, source, first_user_message) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(threadId, rollout, cwd, preview, preview, t, t, t, new Date(t).toISOString(), new Date(t).toISOString(), o.model, 'on-request', 'workspace-write', VERSION, 'cli', preview);
    }
    db.close();
  } catch (_) { /* node:sqlite missing: the linker walks rollouts instead */ }
}
writeThreadRow(null);

const ui = { history: [], input: '', attachments: o.images.slice(), busy: null, dialog: null, turnStart: 0 };
let abort = null;

function render() {
  const { cols, rows } = termSize();
  const top = ['>_ OpenAI Codex (v' + VERSION + ', fake)', '', 'model: ' + o.model + '   directory: ' + cwd.slice(-(cols - 40)), ''];
  const bottom = [];
  if (ui.dialog) {
    const d = ui.dialog;
    bottom.push('', 'Would you like to run the following command?', '', '  $ ' + d.command, '');
    d.options.forEach((opt, i) => bottom.push((i === d.hl ? COMPOSER + ' ' : '  ') + (i + 1) + '. ' + opt.label + ' (' + opt.key + ')'));
    bottom.push('', 'Press enter to confirm or esc to cancel');
  } else {
    if (ui.busy) bottom.push(BULLET + ' Working (' + Math.round((Date.now() - ui.turnStart) / 1000) + 's ' + BULLET + ' esc to interrupt)', '');
    for (const a of ui.attachments) bottom.push('[image: ' + path.basename(a) + ']');
    bottom.push(ui.input ? COMPOSER + ' ' + ui.input.split('\n')[0].slice(0, cols - 3) : COMPOSER + ' ' + DIM + 'Ask Codex to do anything' + RESET);
    bottom.push('', '  100% context left');
  }
  const room = Math.max(0, rows - top.length - bottom.length);
  const mid = ui.history.slice(-room);
  while (mid.length < room) mid.push('');
  tui.draw(top.concat(mid, bottom));
}

async function wait(ms) {
  for (let t = 0; t < ms; t += 50) { if (abort) throw abort; await sleep(50); }
  if (abort) throw abort;
}

function approval(command) {
  return new Promise((resolve) => {
    ui.dialog = { command, hl: 0, resolve, options: [{ label: 'Yes, proceed', key: 'y' }, { label: "Yes, and don't ask again for this command", key: 'a' }, { label: 'No, and tell Codex what to do differently', key: 'esc' }] };
    render();
  });
}

function closeDialog(choice) { const d = ui.dialog; ui.dialog = null; render(); d.resolve(choice); }

async function runTool(command) {
  const callId = 'call_' + crypto.randomBytes(8).toString('hex');
  rec('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }), call_id: callId });
  await wait(THINK_MS);
  rec('response_item', { type: 'function_call_output', call_id: callId, output: JSON.stringify({ output: 'All tests passed.', metadata: { exit_code: 0, duration_seconds: 1 } }) });
}

async function startTurn(text) {
  abort = null;
  const turnId = crypto.randomUUID();
  ui.turnStart = Date.now();
  rec('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(Date.now() / 1000), model_context_window: 200000 });
  const content = [{ type: 'input_text', text }];
  for (const a of ui.attachments) content.unshift({ type: 'input_image', image_url: 'file://' + a });
  const images = ui.attachments.slice();
  ui.attachments = [];
  rec('response_item', { type: 'message', role: 'user', content });
  if (!firstUserText) { firstUserText = text; writeThreadRow(text.slice(0, 200)); }
  ui.history.push(COMPOSER + ' ' + text.split('\n')[0]);
  ui.busy = 'Working';
  render();
  const first = text.trim().split(/\s+/)[0] || '';
  try {
    await wait(THINK_MS);
    rec('response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA' + crypto.randomBytes(24).toString('base64') });
    let reply;
    if (first === 'tool:') { await runTool('npm test'); reply = 'The tests pass.'; }
    else if (first === 'approve:') {
      const choice = await approval('npm test');
      if (choice === 'esc') {
        reply = 'Understood, I will not run it.';
      } else { await runTool('npm test'); reply = 'The tests pass.'; }
    } else if (first === 'long:') {
      for (let t = 0; t < LONG_TOTAL_MS; t += LONG_STEP_MS) await runTool('sleep 2');
      reply = 'Done with the long task.';
    } else if (first === 'error:') {
      rec('event_msg', { type: 'error', message: 'stream error: 503 Service Unavailable' });
      reply = null;
    } else {
      reply = 'Echo: ' + text.split('\n')[0].trim() + images.map((p) => '\nSaw image ' + p).join('');
    }
    if (reply) {
      rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] });
      ui.history.push(BULLET + ' ' + reply.split('\n')[0]);
    }
    rec('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: reply, duration_ms: Date.now() - ui.turnStart });
  } catch (e) {
    if (!e || !e.interrupt) throw e;
    rec('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
    ui.history.push('  Interrupted');
  }
  ui.busy = null;
  render();
}

const tui = new Tui({
  onPaste(text) {
    if (ui.dialog) return;
    const t = text.trim();
    if (/\.(png|jpe?g|gif|webp)$/i.test(t) && !/\n/.test(t) && fs.existsSync(t)) { ui.attachments.push(t); render(); return; }
    ui.input += text.replace(/\r\n?/g, '\n');
    render();
  },
  onEnter() {
    if (ui.dialog) { closeDialog(ui.dialog.options[ui.dialog.hl].key); return; }
    if (ui.busy) return;
    const text = ui.input;
    if (!text.trim() && !ui.attachments.length) return;
    ui.input = '';
    startTurn(text);
  },
  onEsc() {
    if (ui.dialog) { closeDialog('esc'); return; }
    if (ui.busy) abort = { interrupt: true };
  },
  onKey(name) {
    const d = ui.dialog;
    if (d) {
      if (name === 'up' && d.hl > 0) d.hl -= 1;
      if (name === 'down' && d.hl < d.options.length - 1) d.hl += 1;
      render();
      return;
    }
    if (name === 'space') ui.input += ' ';
    else if (name === 'clear') ui.input = '';
    else if (name === 'backspace') ui.input = ui.input.slice(0, -1);
    else if (name === 'ctrlc') tui.exit(0);
    render();
  },
  onChar(ch) {
    if (ui.dialog) {
      const opt = ui.dialog.options.find((x) => x.key === ch);
      if (opt) closeDialog(opt.key);
      return;
    }
    ui.input += ch;
    render();
  },
});

tui.setPasteMode(true);
render();
setInterval(render, 1000).unref();
