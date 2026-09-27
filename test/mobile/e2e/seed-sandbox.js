#!/usr/bin/env node
/**
 * Seeds the Mac sandbox Workbook for the end to end run (BUILD-CONTRACT 6.1).
 *
 * What: writes the transcript fixtures (Claude: six sessions, one with 2,000
 * messages, one with an AskUserQuestion history, one whose assistant text
 * contains the phrase "bracketed paste"; Codex: three rollouts, one with
 * originator "Codex Desktop"), empties the fake CLI state folder, writes a
 * manifest of the fixture ids to <data>/e2e-fixtures.json for B3's
 * seed-workspace.js, then runs that script when it exists.
 *
 * Why: the E2E flows need realistic history, a searchable phrase and
 * sessions B3 can bind to tracked "E2E Claude", "E2E Codex" and "E2E Migrate"
 * sessions, all without a model.
 *
 * Usage: node test/mobile/e2e/seed-sandbox.js <home> <data> <codexHome> <state>
 *   (or the flags home, data, codex-home, state with two leading dashes)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const LONG_MESSAGES = 2000;
const BASE_TS = Date.parse('2026-09-20T09:00:00Z');

/**
 * Arguments as positional or named values.
 * @returns {{home: string, data: string, codexHome: string, state: string}}
 */
function args() {
  const a = process.argv.slice(2);
  const named = {};
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) named[a[i].slice(2)] = a[++i];
    else pos.push(a[i]);
  }
  const out = { home: named.home || pos[0], data: named.data || pos[1], codexHome: named['codex-home'] || pos[2], state: named.state || pos[3] };
  for (const [k, v] of Object.entries(out)) if (!v) { console.error('seed-sandbox: missing ' + k); process.exit(2); }
  return out;
}

let tick = BASE_TS;
const ts = () => new Date(tick += 2000).toISOString();

/**
 * Claude records for a prompt and a reply.
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} prompt
 * @param {string} reply
 * @returns {object[]}
 */
function exchange(sessionId, cwd, prompt, reply) {
  const u = crypto.randomUUID();
  const mid = 'msg_' + crypto.randomBytes(8).toString('hex');
  return [
    { type: 'user', uuid: u, timestamp: ts(), sessionId, cwd, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: crypto.randomUUID(), timestamp: ts(), sessionId, cwd, requestId: 'r', message: { id: mid, role: 'assistant', model: 'claude-fake-1', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'system', subtype: 'turn_duration', durationMs: 2100, uuid: crypto.randomUUID(), timestamp: ts(), sessionId, cwd },
  ];
}

function writeClaude(home, cwd, sessionId, records) {
  const dir = path.join(home, '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeCodex(codexHome, threadId, cwd, originator, prompts) {
  const dir = path.join(codexHome, 'sessions', '2026', '09', '20');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const lines = [{ timestamp: ts(), type: 'session_meta', payload: { id: threadId, timestamp: ts(), cwd, originator, cli_version: '0.153.4' } }];
  lines.push({ timestamp: ts(), type: 'turn_context', payload: { cwd, model: 'gpt-fake-1', approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' } } });
  for (const p of prompts) {
    const turn = crypto.randomUUID();
    lines.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
    lines.push({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: p }] } });
    lines.push({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: ' + p }] } });
    lines.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, duration_ms: 1800 } });
  }
  const file = path.join(dir, 'rollout-2026-09-20T09-00-00-' + threadId + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function main() {
  const a = args();
  const work = path.join(a.home, 'work');
  const manifest = { claude: [], codex: [], work };
  const claudeSessions = [
    { key: 'e2eClaude', name: 'E2E Claude', dir: 'myrlin-ios', build: (id, cwd) => exchange(id, cwd, 'hello', 'Hello from the sandbox.') },
    { key: 'e2eMigrate', name: 'E2E Migrate', dir: 'myrlin-ios', build: (id, cwd) => exchange(id, cwd, 'plan the widget', 'The widget plan is ready.').concat(exchange(id, cwd, 'ship it', 'Shipped.')) },
    { key: 'long', name: 'Long history', dir: 'workbook', build: (id, cwd) => { const out = []; for (let i = 0; i < LONG_MESSAGES / 2; i++) out.push(...exchange(id, cwd, 'message ' + i, 'reply ' + i).slice(0, 2)); return out; } },
    { key: 'ask', name: 'Question history', dir: 'workbook', build: (id, cwd) => {
      const tid = 'toolu_' + crypto.randomBytes(6).toString('hex');
      return [
        { type: 'user', uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd, message: { role: 'user', content: 'ask me' } },
        { type: 'assistant', uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd, requestId: 'r', message: { id: 'm_ask', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'tool_use', id: tid, name: 'AskUserQuestion', input: { questions: [{ question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red (Recommended)', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }] }] } }] } },
        { type: 'user', uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'User has answered your questions: "Pick a color"="Blue".' }] } },
        { type: 'assistant', uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd, requestId: 'r2', message: { id: 'm_ask2', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'text', text: 'You chose Blue' }] } },
        { type: 'system', subtype: 'turn_duration', durationMs: 3000, uuid: crypto.randomUUID(), timestamp: ts(), sessionId: id, cwd },
      ];
    } },
    { key: 'search', name: 'Search phrase', dir: 'workbook', build: (id, cwd) => exchange(id, cwd, 'how does send work', 'Workbook writes the text as a bracketed paste and the submit as a separate write.') },
    { key: 'plain', name: 'Plain', dir: 'myrlin-ios', build: (id, cwd) => exchange(id, cwd, 'plain', 'plain reply') },
  ];
  for (const s of claudeSessions) {
    const id = crypto.randomUUID();
    const cwd = path.join(work, s.dir);
    writeClaude(a.home, cwd, id, s.build(id, cwd));
    manifest.claude.push({ key: s.key, name: s.name, sessionId: id, cwd });
  }
  const codex = [
    { key: 'e2eCodex', name: 'E2E Codex', originator: 'codex_cli_rs', dir: 'workbook' },
    { key: 'codexTwo', name: 'Codex two', originator: 'codex_cli_rs', dir: 'myrlin-ios' },
    { key: 'desktop', name: 'Codex Desktop thread', originator: 'Codex Desktop', dir: 'workbook' },
  ];
  for (const c of codex) {
    const id = crypto.randomUUID();
    const cwd = path.join(work, c.dir);
    const file = writeCodex(a.codexHome, id, cwd, c.originator, ['list the files', 'run the tests']);
    manifest.codex.push({ key: c.key, name: c.name, threadId: id, cwd, rolloutPath: file, originator: c.originator });
  }
  fs.rmSync(a.state, { recursive: true, force: true });
  fs.mkdirSync(a.state, { recursive: true });
  fs.mkdirSync(a.data, { recursive: true });
  fs.writeFileSync(path.join(a.data, 'e2e-fixtures.json'), JSON.stringify(manifest, null, 2));
  console.log('seed-sandbox: ' + manifest.claude.length + ' Claude and ' + manifest.codex.length + ' Codex fixtures');
  const ws = path.join(__dirname, 'seed-workspace.js');
  if (fs.existsSync(ws)) {
    const r = childProcess.spawnSync(process.execPath, [ws].concat(process.argv.slice(2)), { stdio: 'inherit' });
    process.exit(r.status || 0);
  }
}

main();
