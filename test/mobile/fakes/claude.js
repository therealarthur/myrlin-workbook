#!/usr/bin/env node
/**
 * Fake Claude Code CLI for the B2 tests and the Mac sandbox (BUILD-CONTRACT 3.6.3).
 *
 * What: a scriptable stand in for `claude` that draws a TUI with the anchors
 * of Claude Code 2.1.283 (the heavy angle glyph input row between rules, a
 * spinner busy line, the permission, AskUserQuestion and plan dialogs of the
 * golden screens), honours bracketed paste, Enter, a single ESC and arrow
 * keys, and writes a realistically shaped transcript to
 * <projects>/<encoded cwd>/<sessionId>.jsonl. Scenarios are chosen by the
 * first word of the submitted text: tool:, ask:, askmulti:, approve:, plan:,
 * long:, emdash:, error:, the takeover kickoff, and plain echo. It also
 * answers `agents` with the JSON flag, `attach <shortId>` and `stop <id>`
 * from the state folder named by FAKE_CLI_STATE.
 *
 * Why: tests must drive the real Workbook paths without a model or network.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Tui, termSize, homeDir, appendRecord, sleep, NBSP, DIM, BOLD, RESET } = require('./fake-tui');

const VERSION = '2.1.283';
const SELECTOR = String.fromCharCode(0x276f);
const RULE = String.fromCharCode(0x2500);
const ELLIPSIS = String.fromCharCode(0x2026);
const EM_DASH = String.fromCharCode(0x2014);
const BOX_EMPTY = String.fromCharCode(0x2610);
const BOX_DONE = String.fromCharCode(0x2612);
const CHECK = String.fromCharCode(0x2714);
const SPIN = String.fromCharCode(0x273b);
const DOT = String.fromCharCode(0xb7);
const THINK_MS = Number(process.env.FAKE_CLAUDE_THINK_MS || 1000);
const LONG_TOTAL_MS = 20000;
const LONG_STEP_MS = 2000;
const TAKEOVER_KICKOFF = 'Begin the takeover described in your instructions.';
const STATE_DIR = process.env.FAKE_CLI_STATE || null;

// ── Arguments ──────────────────────────────────────────────────────────────

/**
 * Parse argv the way the CLI does for the flags the fake understands.
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const o = { sub: null, subArgs: [] };
  const valued = new Set(['resume', 'session-id', 'resume-session-at', 'model', 'effort', 'permission-mode', 'append-system-prompt-file', 'add-dir', 'n', 'name']);
  for (let i = 0; i < argv.length; i++) {
    let a = String(argv[i]).replace(/^'(.*)'$/, '$1');
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const k = a.replace(/^-+/, '');
      if (valued.has(k)) { o[k] = String(argv[++i] || '').replace(/^'(.*)'$/, '$1'); continue; }
      o[k] = true;
      continue;
    }
    if (!o.sub && ['agents', 'attach', 'stop'].includes(a)) { o.sub = a; continue; }
    if (o.sub) o.subArgs.push(a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));

/** Claude's project folder name: every character outside [A-Za-z0-9] becomes "-". */
function encodeCwd(cwd) { return String(cwd).replace(/[^A-Za-z0-9]/g, '-'); }

function projectsDir() { return process.env.CWM_CLAUDE_PROJECTS_DIR || path.join(homeDir(), '.claude', 'projects'); }

// ── Subcommands ────────────────────────────────────────────────────────────

function stateEntries() {
  if (!STATE_DIR) return [];
  let files = [];
  try { files = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('claude-') && f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
      let alive = true;
      try { process.kill(e.pid, 0); } catch (_) { alive = false; }
      if (alive) out.push(e);
      else if (e.kind === 'background') {
        // Rule 6 as measured on Claude Code 2.1.283 (claude-2.1.283-live-evidence.json,
        // rule6): a background session whose process is gone stays listed
        // without pid, status and waitingFor, keeping its id, name and state.
        const asleep = Object.assign({}, e);
        delete asleep.pid;
        delete asleep.status;
        delete asleep.waitingFor;
        out.push(asleep);
      }
    } catch (_) { /* skip */ }
  }
  return out;
}

if (args.sub === 'agents') {
  process.stdout.write(JSON.stringify(stateEntries()) + '\n');
  process.exit(0);
}
if (args.sub === 'stop') {
  const id = args.subArgs[0];
  for (const e of stateEntries()) {
    if (e.id === id || e.sessionId === id) {
      try { process.kill(e.pid); } catch (_) {}
      try { fs.unlinkSync(path.join(STATE_DIR, 'claude-' + e.sessionId + '.json')); } catch (_) {}
    }
  }
  process.exit(0);
}

// ── Session identity and transcript ───────────────────────────────────────

const cwd = process.cwd();
let attachEntry = null;
if (args.sub === 'attach') attachEntry = stateEntries().find((e) => e.id === args.subArgs[0]) || null;
const sessionId = attachEntry ? attachEntry.sessionId
  : (args['session-id'] || (args.resume && !args['fork-session'] ? args.resume : crypto.randomUUID()));
const transcript = path.join(projectsDir(), encodeCwd(cwd), sessionId + '.jsonl');
const model = args.model || 'claude-fake-1';
let permissionMode = args['dangerously-skip-permissions'] ? 'bypassPermissions' : (args['permission-mode'] || 'default');
let lastUuid = null;
let messageCount = 0;

/** Copy the source transcript into the fork (fork-session, resume-session-at). */
function forkCopy() {
  if (!args.resume || !args['fork-session']) return;
  let src = null;
  const root = projectsDir();
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, args.resume + '.jsonl');
      if (fs.existsSync(p)) { src = p; break; }
    }
  } catch (_) { src = null; }
  if (!src) return;
  const stopAt = args['resume-session-at'] || null;
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const l of lines) {
    let r;
    try { r = JSON.parse(l); } catch (_) { continue; }
    r.sessionId = sessionId;
    out.push(JSON.stringify(r));
    if (r.uuid) lastUuid = r.uuid;
    if (stopAt && r.uuid === stopAt) break;
  }
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, out.join('\n') + (out.length ? '\n' : ''));
}
forkCopy();
if (!args['fork-session'] && fs.existsSync(transcript)) {
  try {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) { const r = JSON.parse(lines[i]); if (r.uuid) { lastUuid = r.uuid; break; } }
  } catch (_) { /* fresh */ }
}

function nowIso() { return new Date().toISOString(); }

/** Write a transcript record with the common envelope. */
function record(type, extra) {
  const uuid = crypto.randomUUID();
  const rec = Object.assign({ parentUuid: lastUuid, isSidechain: false, userType: 'external', cwd, sessionId, version: VERSION, gitBranch: '', type, uuid, timestamp: nowIso() }, extra);
  appendRecord(transcript, rec);
  lastUuid = uuid;
  messageCount += 1;
  return rec;
}

function userPrompt(text) { return record('user', { message: { role: 'user', content: text }, permissionMode }); }

/** One assistant line per block, sharing a message id. */
function assistant(blocks, msgId, extra) {
  const id = msgId || 'msg_' + crypto.randomBytes(12).toString('hex');
  const requestId = 'req_' + crypto.randomBytes(12).toString('hex');
  let last = null;
  for (const b of blocks) {
    last = record('assistant', Object.assign({ message: { id, type: 'message', role: 'assistant', model, content: [b], stop_reason: b.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, requestId }, extra || {}));
  }
  return last;
}

function toolResult(id, content, isError) {
  return record('user', { message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: !!isError }] }, toolUseResult: { stdout: isError ? '' : content, stderr: '', interrupted: false } });
}

function system(subtype, extra) { return record('system', Object.assign({ subtype, isMeta: false, level: 'info' }, extra || {})); }

// ── Agents state ───────────────────────────────────────────────────────────

const shortId = attachEntry ? attachEntry.id : crypto.randomBytes(4).toString('hex');
function writeState(status, waitingFor) {
  if (!STATE_DIR) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'claude-' + sessionId + '.json'), JSON.stringify({ id: shortId, sessionId, pid: process.pid, kind: attachEntry ? 'background' : 'interactive', status, waitingFor: waitingFor || null, cwd, name: args.n || args.name || null, startedAt: Date.now(), state: attachEntry ? 'working' : null }));
  } catch (_) { /* best effort */ }
}
function clearState() { if (STATE_DIR && !attachEntry) { try { fs.unlinkSync(path.join(STATE_DIR, 'claude-' + sessionId + '.json')); } catch (_) {} } }

// ── UI state ───────────────────────────────────────────────────────────────

const ui = {
  history: [],
  input: '',
  busy: null,
  dialog: null,
  queued: [],
  turnStart: 0,
  turnId: 0,
};

function hist(line) { ui.history.push(line); if (ui.history.length > 400) ui.history.shift(); }

/** Render the whole screen. */
function render() {
  const { cols, rows } = termSize();
  const rule = RULE.repeat(cols);
  const top = [
    ' ' + '▐▛███▛█   Claude Code v' + VERSION + ' (fake)',
    '▝▜██████▀  ' + model + ' ' + DOT + ' Fake',
    ' ▝▝   ▝▝   ' + cwd.slice(-(cols - 12)),
    '',
  ];
  let bottom;
  if (ui.dialog) {
    bottom = dialogLines(cols);
  } else {
    bottom = [];
    if (ui.busy) bottom.push(SPIN + ' ' + ui.busy + ELLIPSIS + ' (esc to interrupt)', '');
    const text = ui.input;
    const inputLines = text ? text.split('\n') : [''];
    bottom.push(rule);
    if (!text) bottom.push(SELECTOR + NBSP + DIM + 'Try "write a test for the parser"' + RESET);
    else inputLines.forEach((l, i) => bottom.push((i === 0 ? SELECTOR + NBSP : '  ') + l.slice(0, cols - 3)));
    bottom.push(rule);
    bottom.push('  ' + (permissionMode === 'bypassPermissions' ? '⏵⏵ bypass permissions on' : '⏸ manual mode on'));
  }
  const room = Math.max(0, rows - top.length - bottom.length);
  const middle = ui.history.slice(-room);
  while (middle.length < room) middle.push('');
  tui.draw(top.concat(middle, bottom));
}

function dialogLines(cols) {
  const d = ui.dialog;
  const rule = RULE.repeat(cols);
  const opts = (list, indent) => {
    const out = [];
    list.forEach((o, i) => {
      const sel = i === d.hl;
      out.push(indent + (sel ? SELECTOR + ' ' : '  ') + (i + 1) + '. ' + o.label);
      if (o.description) out.push(indent + '     ' + o.description);
    });
    return out;
  };
  if (d.kind === 'permission') {
    return [rule, ' Bash command', '', '   ' + d.command, '   Run the project tests', '', ' Do you want to proceed?']
      .concat(opts(d.options, ' '), ['', ' Esc to cancel ' + DOT + ' Tab to amend']);
  }
  if (d.kind === 'plan') {
    const lines = ['  ' + '╌'.repeat(cols - 4)];
    for (const l of d.plan.split('\n')) lines.push('   ' + l.slice(0, cols - 4));
    lines.push('  ' + '╌'.repeat(cols - 4), '', '  ' + RULE.repeat(cols - 2), '   Claude has written up a plan and is ready to execute. Would you like to proceed?', '');
    return lines.concat(opts(d.options, '   '), ['', '   ctrl+g to edit in Notepad']);
  }
  // question
  const q = d.questions[d.qi];
  const tabs = d.questions.length > 1
    ? ' ' + d.questions.map((x, i) => (d.answers[i] !== undefined ? BOX_DONE : BOX_EMPTY) + ' ' + (i === d.qi && !d.review ? BOLD + x.header + RESET : x.header)).join('  ') + '  ' + CHECK + ' ' + (d.review ? BOLD + 'Submit' + RESET : 'Submit')
    : ' ' + BOX_EMPTY + ' ' + q.header;
  if (d.review) {
    const lines = [rule, tabs, '', 'Review your answers', ''];
    d.questions.forEach((x, i) => lines.push('  ' + String.fromCharCode(0x25cf) + ' ' + x.question + ' ' + String.fromCharCode(0x2192) + ' ' + describeAnswer(x, d.answers[i])));
    lines.push('');
    return lines.concat(opts([{ label: 'Submit answers' }, { label: 'Cancel' }], ''), ['', 'Enter to select ' + DOT + ' Esc to cancel']);
  }
  const list = q.options.map((o, i) => ({ label: (q.multiSelect ? '[' + (d.checked[i] ? 'x' : ' ') + '] ' : '') + o.label, description: o.description }));
  list.push({ label: d.otherMode ? (d.otherText || '') : 'Type something.' });
  const lines = [rule, tabs, '', BOLD + q.question + RESET, ''].concat(opts(list, ''));
  lines.push(rule, '  ' + (list.length + 1) + '. Chat about this', '', 'Enter to select ' + DOT + ' ' + String.fromCharCode(0x2191) + '/' + String.fromCharCode(0x2193) + ' to navigate ' + DOT + ' Esc to cancel');
  return lines;
}

function describeAnswer(q, a) {
  if (!a) return '(none)';
  if (a.other) return a.other;
  return a.idxs.map((i) => q.options[i].label).join(', ');
}

// ── Turns ──────────────────────────────────────────────────────────────────

let abort = null;

/** Wait that an ESC can cut short. */
async function wait(ms) {
  const step = 50;
  for (let t = 0; t < ms; t += step) {
    if (abort) throw abort;
    await sleep(step);
  }
  if (abort) throw abort;
}

function endTurn() {
  system('turn_duration', { durationMs: Date.now() - ui.turnStart, messageCount });
  ui.busy = null;
  writeState('idle', null);
  render();
  const next = ui.queued.shift();
  if (next) setTimeout(() => startTurn(next, true), 50);
}

/** Wait for the open dialog to be answered. */
function dialog(d) {
  return new Promise((resolve) => {
    ui.dialog = Object.assign({ hl: 0, resolve }, d);
    ui.busy = null;
    writeState('waiting', d.kind === 'question' ? 'input needed' : 'permission prompt');
    render();
  });
}

function closeDialog(value) {
  const d = ui.dialog;
  ui.dialog = null;
  ui.busy = 'Thinking';
  writeState('busy', null);
  render();
  d.resolve(value);
}

async function scenarioTool(command) {
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  const mid = 'msg_' + crypto.randomBytes(12).toString('hex');
  assistant([{ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run the project tests' } }], mid);
  ui.busy = 'Running ' + command;
  render();
  await wait(THINK_MS);
  toolResult(id, 'All tests passed.', false);
  hist('  ' + String.fromCharCode(0x23bf) + '  $ ' + command);
  return id;
}

async function startTurn(text, fromQueue) {
  abort = null;
  ui.turnStart = Date.now();
  ui.turnId += 1;
  if (!fs.existsSync(transcript)) record('permission-mode', { permissionMode });
  userPrompt(text);
  hist(SELECTOR + ' ' + text.split('\n')[0]);
  ui.busy = 'Thinking';
  writeState('busy', null);
  render();
  const first = text.trim().split(/\s+/)[0] || '';
  const imagePaths = text.split('\n').map((l) => l.trim()).filter((l) => /\.(jpg|jpeg|png|gif|webp)$/i.test(l) && (path.isAbsolute(l) || /^[A-Za-z]:\\/.test(l)));
  try {
    await wait(THINK_MS);
    if (text.trim() === TAKEOVER_KICKOFF) {
      assistant([{ type: 'text', text: 'MIGRATE: reading 1/2' }]);
      await wait(300);
      assistant([{ type: 'text', text: 'MIGRATE: reading 2/2' }]);
      await wait(300);
      const header = { schema: 'myrlin.takeover.v1', coverage_percent: 100, claims_checked: 3, claims_failed: 0, decisions_revisited: 1, open_items: 1, solved_verified: 1, learned: 1, tier: 'S' };
      const plan = '```json\n' + JSON.stringify(header) + '\n```\n\n# Takeover report\n\n## Solved and verified\n- The fake session works.\n\n## Learned\n- Nothing surprising (turn 1).';
      await planScenario(plan);
    } else if (first === 'tool:') {
      await scenarioTool('npm test');
      assistant([{ type: 'text', text: 'The tests pass.' }]);
    } else if (first === 'ask:' || first === 'askmulti:') {
      await askScenario(first === 'askmulti:');
    } else if (first === 'approve:') {
      await approveScenario();
    } else if (first === 'plan:') {
      await planScenario('Create plan-probe.txt containing the word hi.');
    } else if (first === 'long:') {
      for (let t = 0; t < LONG_TOTAL_MS; t += LONG_STEP_MS) {
        const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
        assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 2' } }]);
        ui.busy = 'Working';
        render();
        await wait(LONG_STEP_MS);
        toolResult(id, '', false);
      }
      assistant([{ type: 'text', text: 'Done with the long task.' }]);
    } else if (first === 'emdash:') {
      assistant([{ type: 'text', text: 'First part' + EM_DASH + 'with an em dash.' }]);
      system('stop_hook_summary', { hookCount: 1, hookInfos: [{ command: 'block-em-dashes.js' }], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: true });
      await wait(200);
      await scenarioTool('npm run lint');
      assistant([{ type: 'text', text: 'Rewritten without the dash.' }]);
    } else if (first === 'error:') {
      assistant([{ type: 'text', text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }], null, { isApiErrorMessage: true });
    } else {
      let reply = 'Echo: ' + text.split('\n')[0].trim();
      if (imagePaths.length) reply += '\n' + imagePaths.map((p) => 'Saw image ' + p).join('\n');
      assistant([{ type: 'text', text: reply }]);
      hist('● ' + reply.split('\n')[0]);
    }
    endTurn();
  } catch (e) {
    if (e && e.interrupt) {
      if (!e.recorded) record('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      ui.busy = null;
      ui.dialog = null;
      abort = null;
      writeState('idle', null);
      hist('  ' + String.fromCharCode(0x23bf) + '  Interrupted');
      render();
      const next = ui.queued.shift();
      if (next) setTimeout(() => startTurn(next, true), 50);
      return;
    }
    throw e;
  }
  void fromQueue;
}

async function askScenario(multi) {
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  const questions = [{ question: 'Pick a color', header: 'Color', options: [{ label: 'Red (Recommended)', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }], multiSelect: false }];
  if (multi) questions.push({ question: 'Pick sizes', header: 'Sizes', options: [{ label: 'Small', description: null }, { label: 'Large', description: null }], multiSelect: true });
  assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }]);
  const answer = await dialog({ kind: 'question', questions, qi: 0, answers: [], checked: [], review: false, otherMode: false, otherText: '' });
  if (answer === null) {
    toolResult(id, 'The user declined to answer.', true);
    throw { interrupt: true };
  }
  const words = questions.map((q, i) => '"' + q.question + '"="' + describeAnswer(q, answer[i]) + '"').join(', ');
  toolResult(id, 'User has answered your questions: ' + words + '.', false);
  await wait(200);
  assistant([{ type: 'text', text: 'You chose ' + describeAnswer(questions[0], answer[0]) + (multi ? ' and ' + describeAnswer(questions[1], answer[1]) : '') }]);
}

async function approveScenario() {
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', description: 'Run the project tests' } }]);
  const choice = await dialog({ kind: 'permission', command: 'npm test', options: [{ label: 'Yes' }, { label: "Yes, and don't ask again for npm test commands in this project" }, { label: 'No' }] });
  if (choice === 0 || choice === 1) {
    await wait(300);
    toolResult(id, 'All tests passed.', false);
    assistant([{ type: 'text', text: 'The tests pass.' }]);
    return;
  }
  toolResult(id, "The user doesn't want to proceed with this tool use. The tool use was rejected.", true);
  record('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  throw { interrupt: true, recorded: true };
}

async function planScenario(plan) {
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  assistant([{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan } }]);
  const choice = await dialog({ kind: 'plan', plan, options: [{ label: 'Yes, auto-accept edits' }, { label: 'Yes, manually approve edits' }, { label: 'Tell Claude what to change', description: 'shift+tab to approve with this feedback' }] });
  if (choice === 0 || choice === 1) {
    permissionMode = choice === 0 ? 'acceptEdits' : 'default';
    record('permission-mode', { permissionMode });
    toolResult(id, 'User has approved your plan. You can now start coding.', false);
    await wait(200);
    assistant([{ type: 'text', text: 'Plan approved. Starting.' }]);
    return;
  }
  toolResult(id, "The user doesn't want to proceed with this tool use. The tool use was rejected.", true);
  record('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  throw { interrupt: true, recorded: true };
}

// ── Input ──────────────────────────────────────────────────────────────────

function onEnterDialog() {
  const d = ui.dialog;
  if (d.kind === 'permission' || d.kind === 'plan') { closeDialog(d.hl); return; }
  if (d.review) {
    if (d.hl === 0) closeDialog(d.answers);
    else closeDialog(null);
    return;
  }
  const q = d.questions[d.qi];
  const otherRow = q.options.length;
  if (d.otherMode) {
    d.answers[d.qi] = { idxs: [], other: d.otherText };
    return advanceQuestion();
  }
  if (d.hl === otherRow) { d.otherMode = true; d.otherText = ''; render(); return; }
  if (q.multiSelect) {
    d.answers[d.qi] = { idxs: d.checked.map((c, i) => (c ? i : -1)).filter((i) => i >= 0), other: null };
    return advanceQuestion();
  }
  d.answers[d.qi] = { idxs: [d.hl], other: null };
  advanceQuestion();
}

function advanceQuestion() {
  const d = ui.dialog;
  d.otherMode = false;
  d.otherText = '';
  d.checked = [];
  if (d.qi + 1 < d.questions.length) { d.qi += 1; d.hl = 0; render(); return; }
  if (d.questions.length > 1) { d.review = true; d.hl = 0; render(); return; }
  closeDialog(d.answers);
}

const tui = new Tui({
  onPaste(text) {
    if (ui.dialog) {
      if (ui.dialog.otherMode) { ui.dialog.otherText += text; render(); }
      return;
    }
    ui.input += text.replace(/\r\n?/g, '\n');
    render();
  },
  onEnter() {
    if (ui.dialog) { onEnterDialog(); return; }
    const text = ui.input;
    if (!text.trim()) return;
    ui.input = '';
    if (ui.busy) {
      ui.queued.push(text);
      record('queue-operation', { operation: 'enqueue', content: text });
      render();
      return;
    }
    startTurn(text, false);
  },
  onEsc() {
    if (ui.dialog) {
      const d = ui.dialog;
      if (d.kind === 'question') closeDialog(null);
      else closeDialog(d.options.length - 1);
      return;
    }
    if (ui.busy) { abort = { interrupt: true }; return; }
  },
  onKey(name) {
    const d = ui.dialog;
    if (d) {
      const count = d.kind === 'question' ? (d.review ? 2 : d.questions[d.qi].options.length + 1) : d.options.length;
      if (name === 'up' && d.hl > 0) d.hl -= 1;
      else if (name === 'down' && d.hl < count - 1) d.hl += 1;
      else if (name === 'space' && d.otherMode) d.otherText += ' ';
      else if (name === 'space' && d.kind === 'question' && !d.review && d.questions[d.qi].multiSelect && d.hl < d.questions[d.qi].options.length) d.checked[d.hl] = !d.checked[d.hl];
      else if (name === 'right' && d.kind === 'question' && !d.review && d.questions[d.qi].multiSelect) {
        d.answers[d.qi] = { idxs: d.checked.map((c, i) => (c ? i : -1)).filter((i) => i >= 0), other: null };
        advanceQuestion();
        return;
      }
      render();
      return;
    }
    if (name === 'space') ui.input += ' ';
    else if (name === 'clear') ui.input = '';
    else if (name === 'backspace') ui.input = ui.input.slice(0, -1);
    else if (name === 'ctrlc') { clearState(); tui.exit(0); }
    render();
  },
  onChar(ch) {
    // On Windows ConPTY delivers a paste as plain characters, so the inline
    // Other field takes typed characters as well as bracketed pastes.
    if (ui.dialog) { if (ui.dialog.otherMode) { ui.dialog.otherText += ch; render(); } return; }
    ui.input += ch;
    render();
  },
});

tui.setPasteMode(true);
writeState('idle', null);
process.on('exit', clearState);
process.on('SIGTERM', () => { clearState(); process.exit(0); });
render();
setInterval(render, 1000).unref();
