#!/usr/bin/env node
/**
 * One shot capture of real Claude Code screens for the B2 golden fixtures
 * (BUILD-CONTRACT 3.6.4, DECISIONS A24).
 *
 * What: spawns the REAL claude CLI with the cheapest model in node-pty at
 * 120 by 30 inside a scratch folder (never a project), drives it with the
 * same bytes Workbook writes (bracketed paste, a separate submit, single
 * keys), replays the output through @xterm/headless and saves ScreenSnapshot
 * JSON files under test/mobile/fixtures/screens/ plus evidence JSON under
 * test/mobile/fixtures/scratch/.
 *
 * Why: the prompt detectors must match the real TUI, not only the fakes, and
 * critic F1 and F6 need evidence from the real CLI (what a paste does inside
 * an open dialog, how a blocked Stop hook ends a turn).
 *
 * Usage (never inside a Workbook, never in a real project):
 *   node test/mobile/fakes/capture-real-screens.js <scratchDir>
 *
 * Every non ASCII character is written as a \u escape so no fixture can carry
 * a literal em dash (gate G12a).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { snapshotFromTerminal, screenText } = require('../../../src/web/mobile/chat/screen-reader');
const { encodeClaudeProjectDir } = require('../../../src/providers/claude/path-decode');

const COLS = 120;
const ROWS = 30;
const SUBMIT_DELAY_MS = 80;
const CLI_VERSION = '2.1.283';
const ROOT = path.join(__dirname, '..');
const SCREENS_DIR = path.join(ROOT, 'fixtures', 'screens');
const SCRATCH_DIR = path.join(ROOT, 'fixtures', 'scratch');
const ESC = '\x1b';
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';
const KEYS = { up: ESC + '[A', down: ESC + '[B', right: ESC + '[C', left: ESC + '[D', enter: '\r', esc: ESC, space: ' ', tab: '\t' };
const OVERALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * JSON with every non ASCII character escaped.
 * @param {*} value
 * @returns {string}
 */
function asciiJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {*} value
 */
function save(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), asciiJson(value) + '\n');
}

/** @param {number} ms */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * A driven CLI in a PTY with a headless screen.
 */
class Driven {
  constructor(args, cwd, env) {
    this.term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
    this.pending = 0;
    this.raw = [];
    this.exited = false;
    const isWin = process.platform === 'win32';
    this.p = pty.spawn(isWin ? 'cmd.exe' : '/bin/bash', isWin ? ['/c', 'claude ' + args.join(' ')] : ['-lc', 'claude ' + args.join(' ')], {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env, useConpty: isWin ? true : undefined,
    });
    this.p.onData((d) => {
      this.raw.push({ t: Date.now(), d });
      this.pending += 1;
      this.term.write(d, () => { this.pending -= 1; });
    });
    this.p.onExit(() => { this.exited = true; });
  }

  async snap() {
    const start = Date.now();
    while (this.pending > 0 && Date.now() - start < 2000) await sleep(10);
    return snapshotFromTerminal(this.term);
  }

  async text() { return screenText(await this.snap()); }

  write(s) { this.p.write(s); }

  async paste(text) { this.write(PASTE_START + text + PASTE_END); }

  async send(text) {
    await this.paste(text);
    await sleep(SUBMIT_DELAY_MS);
    this.write('\r');
  }

  async waitFor(pred, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await this.snap();
      if (s && pred(screenText(s), s)) return s;
      if (this.exited) break;
      await sleep(250);
    }
    console.log('  timeout waiting for ' + label);
    return null;
  }

  kill() { try { this.p.kill(); } catch (_) {} }
}

/**
 * Save a named screen for the CLI.
 * @param {string} name
 * @param {object} snap
 * @param {object} [meta]
 */
function saveScreen(name, snap, meta) {
  if (!snap) return;
  save(SCREENS_DIR, 'claude-' + CLI_VERSION + '-' + name + '.json', Object.assign({ cli: 'claude', version: CLI_VERSION, name, capturedAt: new Date().toISOString() }, meta || {}, snap));
  console.log('  saved screen ' + name);
}

/**
 * Records of a transcript after a byte offset.
 * @param {string} file
 * @param {number} from
 * @returns {Array<object>}
 */
function recordsAfter(file, from) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(from).toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/**
 * Wait for a turn_duration record after an offset.
 * @param {string} file
 * @param {number} from
 * @param {number} timeoutMs
 * @returns {Promise<Array<object>|null>} records up to and including it
 */
async function waitTurnEnd(file, from, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const recs = recordsAfter(file, from);
    const i = recs.findIndex((r) => r.type === 'system' && r.subtype === 'turn_duration');
    if (i !== -1) return recs.slice(0, i + 1);
    await sleep(500);
  }
  return null;
}

/** Record summary without message text beyond short samples. */
function shape(r) {
  const o = { type: r.type };
  if (r.subtype) o.subtype = r.subtype;
  if (r.message && Array.isArray(r.message.content)) o.blocks = r.message.content.map((b) => b && b.type);
  if (r.message && r.message.id) o.messageId = r.message.id;
  if (r.durationMs !== undefined) o.durationMs = r.durationMs;
  if (r.isApiErrorMessage) o.isApiErrorMessage = true;
  return o;
}

function fileSize(f) { try { return fs.statSync(f).size; } catch (_) { return 0; } }

const isBusy = (t) => /esc to interrupt/i.test(t);
/** Idle input: a row starting with the prompt glyph between two horizontal rules. */
const PROMPT_GLYPH = String.fromCharCode(0x276f);
const RULE_RE = new RegExp("^" + String.fromCharCode(0x2500) + "{10,}");
const isIdleText = (t) => {
  const L = t.split("\n");
  for (let i = 1; i < L.length - 1; i++) {
    const row = L[i];
    const isPrompt = row.startsWith(PROMPT_GLYPH + " ") || row.trimEnd() === PROMPT_GLYPH || row.startsWith("> ");
    if (isPrompt && RULE_RE.test(L[i - 1]) && L.slice(i + 1).some((x) => RULE_RE.test(x))) return !isBusy(t);
  }
  return false;
};
const hasDialog = (t) => /Do you want to|Would you like to proceed|Enter to select|❯\s*\d+\./.test(t);

async function main() {
  const scratch = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'b2-claude-scratch'));
  const dirA = path.join(scratch, 'claude-live-a-' + Date.now());
  fs.mkdirSync(dirA, { recursive: true });
  const env = Object.assign({}, process.env);
  // A child of a Claude Code session inherits markers that switch transcript
  // saving off; scrub every Claude marker so the CLI runs like a Workbook pane.
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$|^ANTHROPIC_/.test(k)) delete env[k];
  delete env.CWM_VT_SIDECAR;
  const projects = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(dirA));
  const evidence = { cli: 'claude', version: CLI_VERSION, scratchDir: dirA, startedAt: new Date().toISOString(), results: {} };
  const guard = setTimeout(() => { console.log('overall timeout'); process.exit(3); }, OVERALL_TIMEOUT_MS);

  // Scene A: default permission mode.
  const u1 = crypto.randomUUID();
  const t1 = path.join(projects, u1 + '.jsonl');
  const a = new Driven(['--model', 'haiku', '--permission-mode', 'default', '--session-id', u1], dirA, env);
  try {
    let s = await a.waitFor((t) => /trust/i.test(t) || isIdleText(t), 30000, 'trust or idle');
    if (s && /trust/i.test(screenText(s))) {
      saveScreen('trust-dialog', s);
      a.write('\r');
      s = await a.waitFor((t) => isIdleText(t), 30000, 'idle after trust');
    }
    saveScreen('idle-empty', s);
    await a.paste('draft from the desktop');
    await sleep(1200);
    saveScreen('idle-draft', await a.snap());
    a.write('\x15');
    await sleep(800);
    evidence.results.clearDraftWithCtrlU = !/draft from the desktop/.test(await a.text());

    let off = fileSize(t1);
    const sentAt = Date.now();
    await a.send('Run this shell command with the Bash tool: echo myrlin-check > probe.txt');
    await sleep(1000);
    saveScreen('after-submit-1s', await a.snap());
    const busy = await a.waitFor((t) => isBusy(t), 20000, 'busy line');
    evidence.results.pasteThenSubmitStartsTurn = !!busy;
    evidence.results.busyAfterMs = busy ? Date.now() - sentAt : null;
    saveScreen('busy', busy);
    const perm = await a.waitFor((t) => /Do you want to/.test(t), 60000, 'permission dialog');
    saveScreen('permission', perm);
    if (perm) {
      await a.paste('1 hello');
      await sleep(1500);
      const afterPaste = await a.snap();
      saveScreen('permission-after-paste', afterPaste);
      const openAfterPaste = /Do you want to/.test(screenText(afterPaste));
      let openAfterCr = null;
      if (openAfterPaste) {
        a.write('\r');
        await sleep(2000);
        const afterCr = await a.snap();
        saveScreen('permission-after-cr', afterCr);
        openAfterCr = /Do you want to/.test(screenText(afterCr));
      }
      evidence.results.F1_permission = { dialogOpenAfterPaste1Hello: openAfterPaste, dialogOpenAfterLoneCr: openAfterCr };
    }
    let recs = await waitTurnEnd(t1, off, 90000);
    evidence.results.turnDurationClosesTurn = !!recs;
    evidence.results.permissionTurnRecords = recs ? recs.map(shape) : null;
    await a.waitFor((t) => isIdleText(t), 20000, 'idle after permission turn');

    off = fileSize(t1);
    await a.send('Use the AskUserQuestion tool to ask me exactly one question: "Pick a color" with the options Red and Blue. After I answer, reply with only the color I chose.');
    const ask = await a.waitFor((t) => /Pick a color/.test(t) && /Red/.test(t) && /Blue/.test(t) && !isBusy(t), 60000, 'ask dialog');
    saveScreen('ask-single', ask);
    if (ask) {
      await a.paste('1 hello');
      await sleep(1500);
      const afterPaste = await a.snap();
      saveScreen('ask-single-after-paste', afterPaste);
      const openAfterPaste = /Pick a color/.test(screenText(afterPaste)) && /Blue/.test(screenText(afterPaste));
      let openAfterCr = null;
      if (openAfterPaste) {
        a.write('\r');
        await sleep(2000);
        const afterCr = await a.snap();
        saveScreen('ask-single-after-cr', afterCr);
        openAfterCr = /Pick a color/.test(screenText(afterCr)) && /Blue/.test(screenText(afterCr)) && /Enter to select|❯/.test(screenText(afterCr));
      }
      evidence.results.F1_question = { dialogOpenAfterPaste1Hello: openAfterPaste, dialogOpenAfterLoneCr: openAfterCr };
    }
    recs = await waitTurnEnd(t1, off, 90000);
    evidence.results.askTurnRecords = recs ? recs.map(shape) : null;
    evidence.results.askToolInput = recs ? (recs.map((r) => r.message && Array.isArray(r.message.content) ? r.message.content.find((b) => b && b.type === 'tool_use' && b.name === 'AskUserQuestion') : null).find(Boolean) || null) : null;
    await a.waitFor((t) => isIdleText(t), 20000, 'idle after ask turn');

    off = fileSize(t1);
    await a.send('Use the AskUserQuestion tool once with two questions at the same time: the first "Pick a color" with options Red and Blue; the second "Pick sizes" with options Small and Large and multiSelect true. Then reply with my answers.');
    const m1 = await a.waitFor((t) => /Pick a color/.test(t) && /Red/.test(t) && !isBusy(t), 60000, 'multi dialog');
    saveScreen('ask-multi-q1', m1);
    if (m1) {
      a.write(KEYS.enter);
      const m2 = await a.waitFor((t) => /Small/.test(t) && /Large/.test(t), 10000, 'second question');
      saveScreen('ask-multi-q2', m2);
      if (m2) {
        a.write(KEYS.space);
        await sleep(800);
        saveScreen('ask-multi-q2-checked', await a.snap());
        a.write(KEYS.right);
        await sleep(1200);
        const review = await a.snap();
        saveScreen('ask-multi-review', review);
        evidence.results.multiReviewText = /Submit/i.test(screenText(review));
        a.write(KEYS.enter);
        await sleep(1500);
        saveScreen('ask-multi-after-submit', await a.snap());
      }
    }
    recs = await waitTurnEnd(t1, off, 90000);
    evidence.results.askMultiTurnRecords = recs ? recs.map(shape) : null;
    if (!recs) { a.write(KEYS.esc); await sleep(1500); }
    await a.waitFor((t) => isIdleText(t), 20000, 'idle after multi');

    off = fileSize(t1);
    await a.send('Reply with exactly this text and nothing else: alpha' + String.fromCharCode(0x2014) + 'beta');
    recs = await waitTurnEnd(t1, off, 120000);
    evidence.results.F6_emdash = recs ? {
      turnDurationCount: recs.filter((r) => r.type === 'system' && r.subtype === 'turn_duration').length,
      stopHookSummaries: recs.filter((r) => r.type === 'system' && r.subtype === 'stop_hook_summary').length,
      records: recs.map(shape),
    } : null;
    if (recs) save(path.join(ROOT, 'fixtures', 'claude'), 'f6-emdash-real-records.json', recs.map((r) => {
      const o = shape(r);
      if (r.message && Array.isArray(r.message.content)) o.text = r.message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').slice(0, 200);
      return o;
    }));
    await a.waitFor((t) => isIdleText(t), 20000, 'idle after emdash');

    a.write('/');
    await sleep(1500);
    const seen = new Map();
    for (let page = 0; page < 30; page++) {
      const t = await a.text();
      for (const line of t.split('\n')) {
        const mm = /^\s*[❯>]?\s*\/([a-z][a-z0-9:-]*)\s{2,}(.+?)\s*$/.exec(line);
        if (mm && !seen.has(mm[1])) seen.set(mm[1], mm[2]);
      }
      if (page === 0) saveScreen('slash-menu', await a.snap());
      for (let k = 0; k < 5; k++) a.write(KEYS.down);
      await sleep(400);
    }
    evidence.results.slashCommands = Array.from(seen.entries()).map(([name, description]) => ({ name, description }));
    a.write(KEYS.esc);
    await sleep(600);
    a.write('\x15');
    await sleep(600);

    // Interrupt with one ESC while busy.
    off = fileSize(t1);
    await a.send('Count slowly from 1 to 400, one number per line.');
    const busy2 = await a.waitFor((t) => isBusy(t), 20000, 'busy for interrupt');
    if (busy2) {
      await sleep(1500);
      a.write(KEYS.esc);
      await sleep(3000);
      const recs2 = recordsAfter(t1, off);
      evidence.results.singleEscInterrupts = recs2.some((r) => r.type === 'user' && JSON.stringify(r.message || {}).includes('[Request interrupted by user'));
      evidence.results.interruptRecords = recs2.map(shape);
      saveScreen('after-interrupt', await a.snap());
    }
  } catch (err) {
    evidence.results.sceneAError = String(err && err.message);
  } finally {
    a.kill();
  }

  // Scene B: plan mode dialog.
  const u2 = crypto.randomUUID();
  const b = new Driven(['--model', 'haiku', '--permission-mode', 'plan', '--session-id', u2], dirA, env);
  try {
    await b.waitFor((t) => isIdleText(t), 30000, 'plan idle');
    await b.send('Make a plan to create a file named plan-probe.txt containing the word hi. Keep the plan to one short line, then present it for approval.');
    const plan = await b.waitFor((t) => /Would you like to proceed/i.test(t), 120000, 'plan dialog');
    saveScreen('plan-dialog', plan);
    if (plan) {
      await b.paste('1 hello');
      await sleep(1500);
      const afterPaste = await b.snap();
      saveScreen('plan-after-paste', afterPaste);
      evidence.results.F1_plan = { dialogOpenAfterPaste1Hello: /Would you like to proceed/i.test(screenText(afterPaste)) };
      b.write(KEYS.esc);
      await sleep(1500);
      saveScreen('plan-after-esc', await b.snap());
    }
  } catch (err) {
    evidence.results.sceneBError = String(err && err.message);
  } finally {
    b.kill();
  }

  // Scene C: fork with a chosen session id.
  const u3 = crypto.randomUUID();
  const t3 = path.join(projects, u3 + '.jsonl');
  const c = new Driven(['--model', 'haiku', '--resume', u1, '--fork-session', '--session-id', u3], dirA, env);
  try {
    const s = await c.waitFor((t) => (isIdleText(t) || /error|cannot|invalid/i.test(t)), 30000, 'fork start');
    saveScreen('fork-start', s);
    evidence.results.forkStartText = s ? screenText(s).split('\n').filter((l) => /error|cannot|invalid|session/i.test(l)).slice(0, 6) : null;
    if (s && isIdleText(screenText(s))) {
      await c.send('Say ok.');
      const recs = await waitTurnEnd(t3, 0, 60000);
      const all = recordsAfter(t3, 0);
      evidence.results.forkWithSessionId = {
        newTranscriptExists: fs.existsSync(t3),
        turnEnded: !!recs,
        copiedRecordsFromSource: all.filter((r) => r.sessionId === u1).length,
        recordsTotal: all.length,
      };
    }
  } catch (err) {
    evidence.results.sceneCError = String(err && err.message);
  } finally {
    c.kill();
  }

  // Help text: flags the branch path depends on.
  try {
    const help = require('child_process').execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'claude', process.platform === 'win32' ? ['/c', 'claude --help'] : ['--help'], { env, encoding: 'utf8', timeout: 30000 });
    evidence.results.helpHasForkSession = /fork-session/.test(help);
    evidence.results.helpHasResumeSessionAt = /resume-session-at/.test(help);
    evidence.results.helpHasSessionId = /session-id/.test(help);
  } catch (err) {
    evidence.results.helpError = String(err && err.message);
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.transcripts = { sessionA: u1, planSession: u2, forkSession: u3 };
  save(SCRATCH_DIR, 'claude-' + CLI_VERSION + '-live-evidence.json', evidence);
  clearTimeout(guard);
  console.log(JSON.stringify(evidence.results, null, 1).slice(0, 4000));
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
