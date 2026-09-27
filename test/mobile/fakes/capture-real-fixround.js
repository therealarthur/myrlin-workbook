/**
 * The fix round scenes of the real CLI capture (BUILD-CONTRACT 3.6.4, A24).
 *
 * What: the captures and evidence the B2 verifier found missing, driven by
 * capture-real-screens.js (which passes its driver and savers in `h`):
 * - ask: a clean AskUserQuestion single question dialog with F1 measured on
 *   the OPEN dialog (a paste of "1 hello", then a lone CR), and the multi
 *   question dialog (both questions and the review step);
 * - plancr: F1's lone CR on the ExitPlanMode dialog;
 * - trust: the Claude folder trust dialog, in a folder under B2_TRUST_DIR
 *   (outside the user profile: a trusted home trusts every folder below it),
 *   left without trusting;
 * - rule6: how background sessions appear in the agents listing after the
 *   stop subcommand and after their process is killed by PID;
 * - codextrust: the Codex folder trust dialog, captured and never answered;
 * - codex: codex-cli 0.153.4 in node-pty at 120 by 30 with its own login on
 *   the cheapest model: the idle composer with and without a draft,
 *   Workbook's paste then CR timing, the busy status, a command approval
 *   with F1, F31 (10 turns timing the rollout markers against the screen),
 *   the record an interrupt writes (X3), and the slash command list. It
 *   types only into a composer that is up with no dialog; a foreign dialog is
 *   closed with Esc, never Enter (the first attempt of this round pressed
 *   Enter into the update dialog, whose default option ran a global npm
 *   install of a newer Codex).
 *
 * Why: detectors must match the real TUIs, and the X3 rule, the F1 gate and
 * the pinned command lists must rest on measurements, not guesses.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { screenText } = require('../../../src/web/mobile/chat/screen-reader');
const { classify } = require('../../../src/web/mobile/chat/prompt-detect');
const { encodeClaudeProjectDir } = require('../../../src/providers/claude/path-decode');

const DAY_MS = 24 * 60 * 60 * 1000;
const CLI_TIMEOUT_MS = 60000;
const ROLLOUT_HEAD_BYTES = 65536;
const REVIEW_TRIES = 4;
const KILL_SAMPLES = 4;
const KILL_SAMPLE_MS = 4000;
const SLASH_PAGES = 12;
const SLASH_STEP = 5;
/** MCP servers of the user's Codex config, switched off for the scratch run (they would start with the CLI). */
const CODEX_MCP_OFF = ['node_repl', 'openaiDeveloperDocs', 'mobbin', 'myrlin-glass'];
/** The header while Codex still loads its model: typing then is lost or lands in a dialog drawn next. */
const CODEX_LOADING_RE = /model:\s+loading/i;
/** Dialogs that are not the composer: never type into them, close them with Esc. */
const CODEX_FOREIGN_DIALOG_RE = /Update available|Press enter to continue|Skip until next version|Do you trust the contents/i;
/** Words of the Codex command approval dialog. */
const CODEX_APPROVAL_WORDS_RE = /Would you like to (run|make|allow)|Allow command|wants to run/i;
const FOREIGN_DIALOG_MAX = 5;
const ROLLOUT_WAIT_MS = 20000;
const ROLLOUT_CLOCK_SLACK_MS = 5000;
const DRAFT_BACKSPACES = 30;
const MARKER_SETTLE_MS = 5000;
const APPROVAL_TRIES = 2;
/** How long a pasted line may take to show in the Codex composer. */
const PASTE_RENDER_MAX_MS = 3000;
const WORKBOOK_TIMING_WAIT_MS = 20000;
const APPROVAL_WAIT_MS = 120000;
const APPROVAL_TURN_WAIT_MS = 90000;
const INTERRUPT_WAIT_MS = 15000;
/** Asks that need a command outside the read only sandbox, so Codex must ask for approval. */
const APPROVAL_PROMPTS = [
  'Run this exact shell command and nothing else: echo myrlin-check > probe.txt . The sandbox is read only, so request escalated permissions for it.',
  'Use the shell tool to run exactly: mkdir probe-dir . The sandbox is read only, so you must request escalated permissions for that command.',
];

/**
 * Classify a snapshot with the shipped detector.
 * @param {object} snap
 * @param {string} provider
 * @returns {object}
 */
function kindOf(snap, provider) { return snap ? classify(snap, provider) : { kind: 'none' }; }

/**
 * Print a screen to the run log, blank runs collapsed.
 * @param {string} label
 * @param {object} snap
 */
function show(label, snap) {
  if (!snap) { console.log('  [' + label + '] no screen'); return; }
  const rows = screenText(snap).split('\n').filter((l, i, a) => l.trim() || (a[i + 1] || '').trim());
  console.log('  [' + label + ']\n' + rows.map((l) => '    | ' + l).join('\n'));
}

/**
 * Run a CLI subcommand once (short lived) and return its stdout, or null.
 * @param {string} bin
 * @param {string} argLine
 * @param {object} env
 * @param {string} cwd
 * @returns {string|null}
 */
function runOnce(bin, argLine, env, cwd) {
  const isWin = process.platform === 'win32';
  try {
    // cmd /s strips the first and last quote of the line, so the whole line is
    // wrapped in one more pair and passed verbatim; a quoted prompt stays one argument.
    return childProcess.execFileSync(isWin ? 'cmd.exe' : '/bin/bash', isWin ? ['/d', '/s', '/c', '"' + bin + ' ' + argLine + '"'] : ['-lc', bin + ' ' + argLine], { env, cwd, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return err && typeof err.stdout === 'string' ? err.stdout : null;
  }
}

/**
 * The agents JSON listing (with completed sessions when `all`).
 * @param {object} env
 * @param {string} cwd
 * @param {boolean} all
 * @returns {object[]|null}
 */
function agentsListing(env, cwd, all) {
  const out = runOnce('claude', 'agents --json' + (all ? ' --all' : ''), env, cwd);
  if (out === null) return null;
  try { return JSON.parse(out.trim()); } catch (_) {
    const i = out.indexOf('[');
    const j = out.lastIndexOf(']');
    try { return i !== -1 && j > i ? JSON.parse(out.slice(i, j + 1)) : null; } catch (_) { return null; }
  }
}

/**
 * Whether two folder paths name the same folder (case and separators ignored).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameDir(a, b) {
  if (!a || !b) return false;
  const n = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
}

/**
 * The shape of one agents entry: its keys and the fields the phone states read.
 * @param {object|null} e
 * @returns {object|null}
 */
function agentShape(e) {
  if (!e) return null;
  return { keys: Object.keys(e).sort(), kind: e.kind, status: e.status, state: e.state === undefined ? '(absent)' : e.state, waitingFor: e.waitingFor === undefined ? '(absent)' : e.waitingFor };
}

/**
 * Merge results into an evidence file, keeping what earlier runs recorded.
 * @param {object} h - helpers
 * @param {string} name
 * @param {object} head
 * @param {object} results
 */
function mergeEvidence(h, name, head, results) {
  const file = path.join(h.SCRATCH_DIR, name);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { prev = {}; }
  h.save(h.SCRATCH_DIR, name, Object.assign({}, prev, head, { results: Object.assign({}, prev.results || {}, results) }));
}

/**
 * Run the requested fix round scenes.
 * @param {string} scratch
 * @param {object} env
 * @param {Set<string>} scenes
 * @param {object} h - the capture script's driver, savers and constants
 */
async function fixRoundScenes(scratch, env, scenes, h) {
  const claudeResults = {};
  const stamp = Date.now();
  if (scenes.has('ask')) await sceneAsk(h, path.join(scratch, 'claude-ask-' + stamp), env, claudeResults);
  if (scenes.has('plancr')) await scenePlanCr(h, path.join(scratch, 'claude-plan-' + stamp), env, claudeResults);
  if (scenes.has('trust')) await sceneTrust(h, env, claudeResults);
  if (scenes.has('rule6')) await sceneRule6(h, path.join(scratch, 'claude-bg-' + stamp), env, claudeResults);
  if (Object.keys(claudeResults).length) {
    mergeEvidence(h, 'claude-' + h.CLI_VERSION + '-live-evidence.json', { fixRoundAt: new Date().toISOString() }, claudeResults);
    console.log(JSON.stringify(claudeResults, null, 1).slice(0, 8000));
  }
  if (scenes.has('codex') || scenes.has('codextrust')) {
    const codexResults = {};
    if (scenes.has('codextrust')) await sceneCodexTrust(h, path.join(scratch, 'codex-trust-' + stamp), env, codexResults);
    if (scenes.has('codex')) await sceneCodex(h, path.join(scratch, 'codex-live-' + stamp), env, codexResults);
    mergeEvidence(h, 'codex-' + h.CODEX_VERSION + '-live-evidence.json', { cli: 'codex', version: h.CODEX_VERSION, model: h.CODEX_MODEL, reasoningEffort: 'low', sandbox: 'read-only', approvalPolicy: 'on-request', capturedAt: new Date().toISOString() }, codexResults);
    console.log(JSON.stringify(codexResults, null, 1).slice(0, 12000));
  }
}

/**
 * A fresh Claude session in a scratch folder, waited to its idle input.
 * @param {object} h
 * @param {string} dir
 * @param {object} env
 * @param {string[]} extra
 * @returns {Promise<{d: object, transcript: string}>}
 */
async function startClaude(h, dir, env, extra) {
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const transcript = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(dir), id + '.jsonl');
  const d = new h.Driven(['--model', 'haiku', '--session-id', id].concat(extra || []), dir, env);
  const s = await d.waitFor((t, snap) => kindOf(snap, 'claude').kind === 'idlePrompt', 45000, 'claude idle');
  show('claude start', s);
  return { d, transcript };
}

/**
 * AskUserQuestion: the single question dialog with F1 on the open dialog,
 * then the two question dialog and its review step.
 */
async function sceneAsk(h, dir, env, results) {
  const { d, transcript } = await startClaude(h, dir, env, ['--permission-mode', 'default']);
  try {
    let off = h.fileSize(transcript);
    await d.send('Use the AskUserQuestion tool to ask me exactly one question: "Pick a color" with the options Red and Blue. After I answer, reply with only the color I chose.');
    const ask = await d.waitFor((t) => h.isQuestionDialog(t, 'Pick a color'), 90000, 'single question dialog');
    show('ask-single', ask);
    h.saveScreen('ask-single', ask);
    if (ask) {
      await d.paste('1 hello');
      await h.sleep(1500);
      const afterPaste = await d.snap();
      show('ask-single-after-paste', afterPaste);
      h.saveScreen('ask-single-after-paste', afterPaste);
      const openAfterPaste = h.isQuestionDialog(screenText(afterPaste), 'Pick a color');
      const answeredByPaste = h.recordsAfter(transcript, off).some((r) => r.type === 'user' && JSON.stringify(r.message || {}).includes('tool_result'));
      let openAfterCr = null;
      let afterCrKind = null;
      if (openAfterPaste) {
        d.write('\r');
        await h.sleep(2500);
        const afterCr = await d.snap();
        show('ask-single-after-cr', afterCr);
        h.saveScreen('ask-single-after-cr', afterCr);
        openAfterCr = h.isQuestionDialog(screenText(afterCr), 'Pick a color');
        afterCrKind = kindOf(afterCr, 'claude').kind;
      }
      const recs = await h.waitTurnEnd(transcript, off, 90000);
      const answer = recs ? recs.filter((r) => r.type === 'user').map((r) => JSON.stringify(r.message || {})).find((x) => x.includes('tool_result')) : null;
      results.F1_question = {
        measuredOnOpenDialog: true,
        dialogOpenAfterPaste1Hello: openAfterPaste,
        answeredByPaste,
        dialogOpenAfterLoneCr: openAfterCr,
        screenKindAfterLoneCr: afterCrKind,
        toolResultSample: answer ? answer.slice(0, 300) : null,
        turnEnded: !!recs,
        note: 'Replaces the first run, whose wait matched the typed prompt and pasted while Claude was still busy.',
      };
      if (!recs) { d.write(h.KEYS.esc); await h.sleep(1500); }
    }
    await d.waitFor((t, snap) => kindOf(snap, 'claude').kind === 'idlePrompt', 30000, 'idle after single');

    off = h.fileSize(transcript);
    await d.send('Use the AskUserQuestion tool ONCE with TWO questions in the same call: question one "Pick a color" (header "Color") with options Red and Blue; question two "Pick sizes" (header "Sizes") with options Small and Large and multiSelect true. Then reply with my answers.');
    const q1 = await d.waitFor((t) => h.isQuestionDialog(t, 'Pick a color'), 90000, 'multi q1');
    show('ask-multi-q1', q1);
    h.saveScreen('ask-multi-q1', q1);
    const multi = { q1: !!q1 };
    if (q1) {
      d.write(h.KEYS.enter);
      // The second question is on screen only when its check box rows are: the
      // words "Pick sizes" also stand in the typed prompt above the dialog.
      const q2 = await d.waitFor((t) => /\[ \] Small/.test(t) && /\[ \] Large/.test(t), 15000, 'multi q2');
      show('ask-multi-q2', q2);
      h.saveScreen('ask-multi-q2', q2);
      multi.q2 = !!q2;
      if (q2) {
        // PROTOCOL.md 8.5 ticks a multi select box with Space: check that on the real dialog.
        d.write(h.KEYS.space);
        await h.sleep(900);
        let checked = await d.snap();
        multi.spaceTicksBox = /\[[✔✓xX]\] Small/.test(screenText(checked));
        if (!multi.spaceTicksBox) {
          show('ask-multi-q2-after-space', checked);
          h.saveScreen('ask-multi-q2-after-space', checked);
          d.write(h.KEYS.enter);
          await h.sleep(900);
          checked = await d.snap();
          multi.enterTicksBox = /\[[✔✓xX]\] Small/.test(screenText(checked));
        }
        show('ask-multi-q2-checked', checked);
        h.saveScreen('ask-multi-q2-checked', checked);
        let review = /Submit|Review your answers/i.test(screenText(checked)) && !/Pick sizes/.test(screenText(checked)) ? checked : null;
        for (let k = 0; k < REVIEW_TRIES && !review; k++) {
          d.write(h.KEYS.right);
          await h.sleep(900);
          const snap = await d.snap();
          if (/Submit|Review your answers/i.test(screenText(snap))) review = snap;
        }
        show('ask-multi-review', review);
        h.saveScreen('ask-multi-review', review);
        multi.review = !!review;
        if (review) {
          const c = kindOf(review, 'claude');
          multi.reviewClassifiedAs = c.kind + (c.dialog ? ' ' + c.dialog.kind : '');
          d.write(h.KEYS.enter);
          await h.sleep(2000);
          const after = await d.snap();
          show('ask-multi-after-submit', after);
          h.saveScreen('ask-multi-after-submit', after);
        }
      }
    }
    const recs = await h.waitTurnEnd(transcript, off, 90000);
    multi.turnEnded = !!recs;
    multi.records = recs ? recs.map(h.shape) : null;
    const use = recs ? recs.map((r) => (r.message && Array.isArray(r.message.content) ? r.message.content.find((b) => b && b.type === 'tool_use' && b.name === 'AskUserQuestion') : null)).find(Boolean) : null;
    multi.toolInput = use ? use.input : null;
    results.askMulti = multi;
    if (!recs) { d.write(h.KEYS.esc); await h.sleep(1500); }
  } catch (err) {
    results.askError = String(err && err.message);
  } finally {
    d.kill();
  }
}

/** F1 on the ExitPlanMode dialog: a paste, then a lone CR. */
async function scenePlanCr(h, dir, env, results) {
  const { d, transcript } = await startClaude(h, dir, env, ['--permission-mode', 'plan']);
  try {
    const off = h.fileSize(transcript);
    await d.send('Make a plan to create a file named plan-probe.txt containing the word hi. Keep the plan to one short line, then present it for approval.');
    const plan = await d.waitFor((t) => /Would you like to proceed/i.test(t), 120000, 'plan dialog');
    show('plan dialog', plan);
    const out = { captured: !!plan };
    if (plan) {
      await d.paste('1 hello');
      await h.sleep(1500);
      const afterPaste = await d.snap();
      out.dialogOpenAfterPaste1Hello = /Would you like to proceed/i.test(screenText(afterPaste));
      if (out.dialogOpenAfterPaste1Hello) {
        d.write('\r');
        await h.sleep(2500);
        const afterCr = await d.snap();
        show('plan-after-cr', afterCr);
        h.saveScreen('plan-after-cr', afterCr);
        out.dialogOpenAfterLoneCr = /Would you like to proceed/i.test(screenText(afterCr));
        out.screenKindAfterLoneCr = kindOf(afterCr, 'claude').kind;
      }
      const recs = await h.waitTurnEnd(transcript, off, 120000);
      out.turnEnded = !!recs;
      out.records = recs ? recs.map(h.shape) : null;
      if (!recs) { d.write(h.KEYS.esc); await h.sleep(1500); }
    }
    results.F1_planLoneCr = out;
  } catch (err) {
    results.planCrError = String(err && err.message);
  } finally {
    d.kill();
  }
}

/** The folder trust dialog, outside the user profile; left without trusting. */
async function sceneTrust(h, env, results) {
  const base = process.env.B2_TRUST_DIR;
  if (!base) { results.trustDialog = { captured: false, reason: 'B2_TRUST_DIR not set' }; return; }
  const dir = path.join(base, 'trust-probe-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const d = new h.Driven(['--model', 'haiku'], dir, env);
  try {
    // 2.1.283 draws the options without numbers ("No, exit" highlighted, then
    // "Yes, I trust this folder") above an "Enter to confirm" footer.
    const s = await d.waitFor((t) => /trust/i.test(t) && (/\d\.\s/.test(t) || /Enter to confirm/i.test(t)), 45000, 'trust dialog');
    show('trust-dialog', s);
    h.saveScreen('trust-dialog', s);
    const c = kindOf(s, 'claude');
    results.trustDialog = { captured: !!s, classifiedAs: s ? c.kind : null, title: c.dialog ? c.dialog.title : null, trusted: false };
    d.write(h.KEYS.esc);
    await h.sleep(1500);
  } catch (err) {
    results.trustError = String(err && err.message);
  } finally {
    d.kill();
    await h.sleep(1000);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

/**
 * Rule 6 of PROTOCOL.md 6.2: two background sessions on haiku, one stopped
 * with the stop subcommand and one killed by PID (the closest stand in for a
 * reap); the listing is read before and after, with and without completed
 * sessions. Both are stopped and removed at the end.
 */
async function sceneRule6(h, dir, env, results) {
  fs.mkdirSync(dir, { recursive: true });
  const r6 = { method: 'two background sessions on haiku: one stopped with the stop subcommand, one killed by PID', steps: {} };
  const started = [];
  const findEntry = (list, shortId) => (Array.isArray(list) ? list.find((e) => e && e.id === shortId) || null : null);
  try {
    for (const label of ['stopped', 'killed']) {
      const before = new Set((agentsListing(env, dir, true) || []).map((e) => e.id));
      const out = runOnce('claude', '--bg --model haiku "Reply with the single word ok."', env, dir) || '';
      await h.sleep(3000);
      const after = agentsListing(env, dir, true) || [];
      // Only a session started in this scratch folder: other background sessions on the
      // machine (the user's own) must never be stopped, killed or removed here.
      const fresh = after.find((e) => e && e.id && !before.has(e.id) && e.kind === 'background' && sameDir(e.cwd, dir));
      r6.steps[label] = { startOutput: out.split('\n').filter(Boolean).slice(0, 3).map((l) => l.slice(0, 160)), shortId: fresh ? fresh.id : null };
      if (fresh) started.push(fresh.id);
    }
    const t0 = Date.now();
    let listing = null;
    while (Date.now() - t0 < CLI_TIMEOUT_MS) {
      listing = agentsListing(env, dir, false);
      const mine = started.map((id) => findEntry(listing, id));
      if (mine.length && mine.every((e) => e && e.status === 'idle')) break;
      await h.sleep(2000);
    }
    ['stopped', 'killed'].forEach((label, i) => { if (r6.steps[label]) r6.steps[label].whileRunning = agentShape(findEntry(listing, started[i])); });
    if (started[0]) {
      runOnce('claude', 'stop ' + started[0], env, dir);
      await h.sleep(KILL_SAMPLE_MS);
      r6.steps.stopped.afterStop = { listed: !!findEntry(agentsListing(env, dir, false), started[0]), withAll: agentShape(findEntry(agentsListing(env, dir, true), started[0])) };
    }
    const e2 = started[1] ? findEntry(agentsListing(env, dir, false), started[1]) : null;
    if (e2 && Number.isInteger(e2.pid)) {
      try { childProcess.execFileSync('taskkill', ['/PID', String(e2.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* gone */ }
      r6.steps.killed.killedByPid = true;
      const samples = [];
      for (let k = 1; k <= KILL_SAMPLES; k++) {
        await h.sleep(KILL_SAMPLE_MS);
        const l = agentsListing(env, dir, false);
        samples.push({ afterMs: k * KILL_SAMPLE_MS, listed: !!findEntry(l, started[1]), entry: agentShape(findEntry(l, started[1])) });
      }
      r6.steps.killed.afterKill = samples;
      r6.steps.killed.withAll = agentShape(findEntry(agentsListing(env, dir, true), started[1]));
    }
  } catch (err) {
    r6.error = String(err && err.message);
  } finally {
    for (const id of started) { runOnce('claude', 'stop ' + id, env, dir); runOnce('claude', 'rm ' + id, env, dir); }
    const left = agentsListing(env, dir, true);
    r6.cleanup = { stillListedWithAll: started.filter((id) => !!findEntry(left, id)) };
  }
  results.rule6 = r6;
}

// ── Codex ─────────────────────────────────────────────────────────────────

/**
 * The newest rollout whose session_meta names this working directory (read only).
 * @param {string} cwd
 * @param {number} sinceMs
 * @returns {string|null}
 */
function findRollout(cwd, sinceMs) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const want = path.resolve(cwd).toLowerCase();
  let best = null;
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * DAY_MS);
    const day = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names = [];
    try { names = fs.readdirSync(day); } catch (_) { continue; }
    for (const n of names) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      const file = path.join(day, n);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }
      if (st.mtimeMs < sinceMs) continue;
      let first = '';
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(ROLLOUT_HEAD_BYTES);
        const k = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        first = buf.toString('utf8', 0, k).split('\n')[0];
      } catch (_) { continue; }
      let meta = null;
      try { meta = JSON.parse(first); } catch (_) { meta = null; }
      const c = meta && meta.payload && meta.payload.cwd ? path.resolve(meta.payload.cwd).toLowerCase() : null;
      if (c === want && (!best || st.mtimeMs > best.m)) best = { file, m: st.mtimeMs };
    }
  }
  return best ? best.file : null;
}

/**
 * Rollout record names after an offset (no text).
 * @param {object} h
 * @param {string} file
 * @param {number} from
 * @returns {object[]}
 */
function codexShapes(h, file, from) {
  return h.recordsAfter(file, from).map((r) => {
    const p = r.payload || {};
    const o = { type: r.type };
    if (p.type) o.payloadType = p.type;
    if (p.role) o.role = p.role;
    if (p.name) o.name = p.name;
    if (p.reason) o.reason = p.reason;
    return o;
  });
}

/**
 * Codex command line for the scratch run: the cheapest model at low effort,
 * the read only sandbox with approval on request, no update check (the first
 * fix round pressed Enter into the update dialog, whose default option runs a
 * global npm install), and the user's MCP servers switched off so the run
 * starts nothing but the CLI itself. B2_CODEX_MCP_OFF overrides the server
 * list (comma separated names from the config, which must exist there).
 * The scratch folder is marked trusted for this process only (a config
 * override on the command line, never written to the config file), so the
 * trust dialog does not ask and nothing is recorded; the dialog itself is
 * captured by the codextrust scene, which never answers it.
 * @param {object} h
 * @param {string|null} trustedDir
 * @returns {string[]}
 */
function codexArgs(h, trustedDir) {
  const args = ['-m', h.CODEX_MODEL, '-c', 'model_reasoning_effort=low', '-c', 'check_for_update_on_startup=false', '-a', 'on-request', '-s', 'read-only'];
  const off = process.env.B2_CODEX_MCP_OFF !== undefined ? process.env.B2_CODEX_MCP_OFF : CODEX_MCP_OFF.join(',');
  for (const name of off.split(',').map((x) => x.trim()).filter(Boolean)) args.push('-c', 'mcp_servers.' + name + '.enabled=false');
  // The override key is the folder as Codex stores it (lower case on Windows); a
  // dot would split the key, so a folder with one is left to the dialog.
  if (trustedDir && !/[.\s"]/.test(path.resolve(trustedDir))) args.push('-c', 'projects.' + path.resolve(trustedDir).toLowerCase() + '.trust_level=trusted');
  return args;
}

/**
 * Where Codex stands on a screen: the classifier's kind, and whether it is
 * safe to type (the composer is up, the model has loaded, and no dialog of
 * any kind is drawn).
 * @param {object} snap
 * @returns {{text: string, kind: string, ready: boolean, foreignDialog: boolean}}
 */
function codexStanding(snap) {
  const text = snap ? screenText(snap) : '';
  const c = kindOf(snap, 'codex');
  const dialogWords = CODEX_FOREIGN_DIALOG_RE.test(text);
  const ready = c.kind === 'idlePrompt' && !CODEX_LOADING_RE.test(text) && !dialogWords;
  return { text, kind: c.kind, ready, foreignDialog: dialogWords || c.kind === 'unknownModal' };
}

/**
 * Wait until Codex is safe to type into. A foreign dialog (an update offer,
 * a trust question, anything unknown) is saved once and closed with Esc,
 * never Enter, so no default option can run.
 * @param {object} h
 * @param {object} d
 * @param {number} timeoutMs
 * @param {string} label
 * @param {object} results
 * @returns {Promise<object|null>}
 */
async function codexReady(h, d, timeoutMs, label, results) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const snap = await d.snap();
    const st = codexStanding(snap);
    if (st.ready) return snap;
    if (st.foreignDialog) {
      results.foreignDialogs = results.foreignDialogs || [];
      if (results.foreignDialogs.length < FOREIGN_DIALOG_MAX) {
        results.foreignDialogs.push({ at: label, classifiedAs: st.kind, firstLines: st.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4) });
        show('codex foreign dialog at ' + label, snap);
      }
      d.write(h.KEYS.esc);
      await h.sleep(800);
      continue;
    }
    if (d.exited) break;
    await h.sleep(300);
  }
  console.log('  timeout waiting for ' + label);
  return null;
}

/**
 * The Codex folder trust dialog in a fresh scratch folder, captured and then
 * left unanswered: the CLI is killed by PID, so no trust is recorded in the
 * config and no prompt is ever sent.
 * @param {object} h
 * @param {string} dir
 * @param {object} env
 * @param {object} results
 */
async function sceneCodexTrust(h, dir, env, results) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new h.Driven(codexArgs(h, null), dir, env, process.env.B2_CODEX_BIN || 'codex');
  try {
    const s = await d.waitFor((t) => /Do you trust the contents of this directory/i.test(t), CLI_TIMEOUT_MS, 'codex trust dialog');
    show('codex trust-dialog', s);
    h.saveScreen('trust-dialog', s, null, 'codex', h.CODEX_VERSION);
    const c = kindOf(s, 'codex');
    results.trustDialog = { captured: !!s, classifiedAs: s ? c.kind : null, title: c.dialog ? c.dialog.title : null, options: c.dialog ? c.dialog.options.map((o) => o.label) : null, answered: false };
  } catch (err) {
    results.trustError = String(err && err.message);
  } finally {
    d.kill();
  }
}

/**
 * Codex: every screen and measurement 3.6.4 asks for, typed only into a
 * composer that is up and empty of dialogs.
 * @param {object} h
 * @param {string} dir
 * @param {object} env
 * @param {object} results
 */
async function sceneCodex(h, dir, env, results) {
  fs.mkdirSync(dir, { recursive: true });
  const launchAt = Date.now();
  const bin = process.env.B2_CODEX_BIN || 'codex';
  const save = (name, snap) => h.saveScreen(name, snap, null, 'codex', h.CODEX_VERSION);
  const d = new h.Driven(codexArgs(h, dir), dir, env, bin);
  const busy = (snap) => kindOf(snap, 'codex').kind === 'busy';
  const idle = (snap) => codexStanding(snap).ready;
  let rollout = null;
  const ensureRollout = async () => {
    const t0 = Date.now();
    while (!rollout && Date.now() - t0 < ROLLOUT_WAIT_MS) { rollout = findRollout(dir, launchAt - ROLLOUT_CLOCK_SLACK_MS); if (!rollout) await h.sleep(250); }
    return rollout;
  };
  /**
   * Paste a line into a ready composer, then submit it on its own write.
   * @param {string} text
   * @param {string} label
   * @returns {Promise<number|null>} the submit time, or null when Codex was not ready
   */
  const submit = async (text, label) => {
    const ready = await codexReady(h, d, CLI_TIMEOUT_MS, label, results);
    if (!ready) return null;
    const pasteAt = Date.now();
    await d.paste(text);
    // Codex draws a paste only after its paste burst settles, so wait until
    // the composer shows the words (the render delay is recorded), then
    // submit on a separate write after the usual 80 ms.
    let after = null;
    let shown = false;
    while (Date.now() - pasteAt < PASTE_RENDER_MAX_MS) {
      after = await d.snap();
      const c = kindOf(after, 'codex');
      if (c.kind === 'idlePrompt' && c.input && String(c.input.inputText).includes(text.slice(0, 12))) { shown = true; break; }
      await h.sleep(h.POLL_MS);
    }
    if (!shown) {
      results.submitRefused = (results.submitRefused || 0) + 1;
      show('codex not safe to submit at ' + label, after);
      return null;
    }
    results.pasteRenderMs = results.pasteRenderMs || [];
    results.pasteRenderMs.push(Date.now() - pasteAt);
    await h.sleep(h.SUBMIT_DELAY_MS);
    const at = Date.now();
    d.write('\r');
    return at;
  };
  /**
   * The exact Workbook delivery timing (PROTOCOL.md 7.3): paste, 80 ms, then a
   * lone CR without waiting for the paste to show. Records whether the turn
   * started, or where the text went.
   * @returns {Promise<object>}
   */
  const workbookTiming = async () => {
    const out = {};
    const ready = await codexReady(h, d, CLI_TIMEOUT_MS, 'workbook timing', results);
    if (!ready) { out.skipped = 'not ready'; return out; }
    await ensureRollout();
    const off = rollout ? h.fileSize(rollout) : 0;
    await d.paste('Reply with only the word zero.');
    await h.sleep(h.SUBMIT_DELAY_MS);
    const cr = Date.now();
    d.write('\r');
    const t0 = Date.now();
    while (Date.now() - t0 < WORKBOOK_TIMING_WAIT_MS) {
      const snap = await d.snap();
      if (!out.busyAfterMs && busy(snap)) out.busyAfterMs = Date.now() - cr;
      if (!rollout) await ensureRollout();
      const recs = rollout ? h.recordsAfter(rollout, off) : [];
      if (!out.taskStartedAfterMs && recs.some((r) => r.type === 'event_msg' && r.payload && r.payload.type === 'task_started')) out.taskStartedAfterMs = Date.now() - cr;
      if (recs.some((r) => r.type === 'event_msg' && r.payload && r.payload.type === 'task_complete')) { out.completed = true; break; }
      await h.sleep(h.POLL_MS);
    }
    const end = await d.snap();
    const c = kindOf(end, 'codex');
    out.submitted = !!(out.busyAfterMs || out.taskStartedAfterMs);
    out.composerAfter = c.input ? { inputText: c.input.inputText.slice(0, 80), placeholder: c.input.placeholder } : null;
    show('codex after workbook timing', end);
    if (!out.submitted) {
      save('paste-then-cr-80ms', end);
      d.write('\x15');
      await h.sleep(600);
      for (let k = 0; k < DRAFT_BACKSPACES * 2; k++) d.write('\x7f');
      await h.sleep(800);
    }
    return out;
  };
  try {
    const idleSnap = await codexReady(h, d, CLI_TIMEOUT_MS, 'idle composer', results);
    show('codex idle-empty', idleSnap);
    save('idle-empty', idleSnap);
    results.idleComposer = { captured: !!idleSnap, classifiedAs: idleSnap ? kindOf(idleSnap, 'codex').kind : null };
    if (!idleSnap) return;
    await d.paste('draft from the desktop');
    await h.sleep(1200);
    const draft = await d.snap();
    show('codex idle-draft', draft);
    save('idle-draft', draft);
    const dc = kindOf(draft, 'codex');
    results.idleDraft = { classifiedAs: dc.kind, inputText: dc.input ? dc.input.inputText : null, placeholder: dc.input ? dc.input.placeholder : null };
    d.write('\x15');
    await h.sleep(600);
    if (/draft from the desktop/.test(await d.text())) { for (let k = 0; k < DRAFT_BACKSPACES; k++) d.write('\x7f'); await h.sleep(600); }
    results.draftCleared = !/draft from the desktop/.test(await d.text());
    if (!results.draftCleared) return;

    // F1 for Codex delivery: does Workbook's paste, 80 ms, lone CR submit?
    results.workbookDeliveryTiming = await workbookTiming();

    // F31: 10 short turns; when each marker appears in the rollout against what the screen shows.
    const samples = [];
    for (let i = 1; i <= h.F31_SAMPLES; i++) {
      await ensureRollout();
      const off = rollout ? h.fileSize(rollout) : 0;
      const word = 'ok' + i;
      const submitAt = await submit('Reply with only the word ' + word + '.', 'F31 sample ' + i);
      if (submitAt === null) break;
      if (!rollout) await ensureRollout();
      const sm = { i };
      let sawBusy = false;
      const t1 = Date.now();
      while (Date.now() - t1 < CLI_TIMEOUT_MS) {
        const snap = await d.snap();
        const at = Date.now() - submitAt;
        if (!sm.screenBusyMs && busy(snap)) { sm.screenBusyMs = at; sawBusy = true; if (i === 1) { show('codex busy', snap); save('busy', snap); } }
        if (sawBusy && !sm.screenIdleMs && idle(snap)) sm.screenIdleMs = at;
        const replyRows = screenText(snap).split('\n').filter((l) => !l.includes('Reply with only'));
        if (!sm.screenReplyMs && replyRows.some((l) => new RegExp('\\b' + word + '\\b', 'i').test(l))) sm.screenReplyMs = at;
        const recs = rollout ? h.recordsAfter(rollout, off) : [];
        const has = (pred) => recs.some(pred);
        if (!sm.taskStartedSeenMs && has((r) => r.type === 'event_msg' && r.payload && r.payload.type === 'task_started')) sm.taskStartedSeenMs = at;
        if (!sm.assistantMessageSeenMs && has((r) => r.type === 'response_item' && r.payload && r.payload.type === 'message' && r.payload.role === 'assistant')) sm.assistantMessageSeenMs = at;
        if (!sm.taskCompleteSeenMs && has((r) => r.type === 'event_msg' && r.payload && r.payload.type === 'task_complete')) sm.taskCompleteSeenMs = at;
        if (sm.taskCompleteSeenMs && sm.screenIdleMs && sm.screenReplyMs) break;
        if (sm.taskCompleteSeenMs && at - sm.taskCompleteSeenMs > MARKER_SETTLE_MS) break;
        await h.sleep(h.POLL_MS);
      }
      sm.recordNames = rollout ? codexShapes(h, rollout, off).map((x) => x.payloadType || x.type) : null;
      if (sm.taskStartedSeenMs && sm.screenBusyMs) sm.startedMinusBusyOnScreenMs = sm.taskStartedSeenMs - sm.screenBusyMs;
      if (sm.taskCompleteSeenMs && sm.screenReplyMs) sm.completeMinusReplyOnScreenMs = sm.taskCompleteSeenMs - sm.screenReplyMs;
      if (sm.taskCompleteSeenMs && sm.screenIdleMs) sm.completeMinusIdleOnScreenMs = sm.taskCompleteSeenMs - sm.screenIdleMs;
      if (sm.taskCompleteSeenMs && sm.assistantMessageSeenMs) sm.completeMinusMessageRecordMs = sm.taskCompleteSeenMs - sm.assistantMessageSeenMs;
      samples.push(sm);
      console.log('  F31 sample ' + i + ': ' + JSON.stringify(sm));
    }
    results.F31 = { pollMs: h.POLL_MS, samples };

    // A command approval, with F1 measured on the open dialog.
    await ensureRollout();
    let off = rollout ? h.fileSize(rollout) : 0;
    let appr = null;
    for (let attempt = 0; attempt < APPROVAL_TRIES && !appr; attempt++) {
      const at = await submit(APPROVAL_PROMPTS[attempt], 'approval ask ' + (attempt + 1));
      if (at === null) break;
      appr = await d.waitFor((t, snap) => kindOf(snap, 'codex').kind === 'prompt' || (CODEX_APPROVAL_WORDS_RE.test(t) && /\b1\.\s/.test(t) && !busy(snap) && !codexStanding(snap).ready), APPROVAL_WAIT_MS, 'codex approval');
      if (!appr) results['approvalAttempt' + (attempt + 1)] = 'no dialog; records ' + JSON.stringify(rollout ? codexShapes(h, rollout, off).map((x) => x.payloadType || x.type) : null);
    }
    show('codex approval', appr);
    save('approval', appr);
    const f1 = { captured: !!appr, classifiedAs: appr ? kindOf(appr, 'codex').kind : null };
    if (appr) {
      const c = kindOf(appr, 'codex');
      if (c.dialog) { f1.title = c.dialog.title; f1.options = c.dialog.options.map((o) => ({ key: o.key, label: o.label, role: o.role })); f1.highlighted = c.dialog.highlighted; }
      const anchor = screenText(appr).split('\n').map((l) => l.trim()).find((l) => CODEX_APPROVAL_WORDS_RE.test(l)) || null;
      f1.anchorLine = anchor;
      const stillOpen = (snap) => kindOf(snap, 'codex').kind === 'prompt' || (anchor !== null && screenText(snap).includes(anchor) && /\b1\.\s/.test(screenText(snap)));
      await d.paste('1 hello');
      await h.sleep(1500);
      const afterPaste = await d.snap();
      show('codex approval-after-paste', afterPaste);
      save('approval-after-paste', afterPaste);
      f1.dialogOpenAfterPaste1Hello = stillOpen(afterPaste);
      f1.recordsAfterPaste = rollout ? codexShapes(h, rollout, off) : null;
      if (f1.dialogOpenAfterPaste1Hello) {
        d.write('\r');
        await h.sleep(2500);
        const afterCr = await d.snap();
        show('codex approval-after-cr', afterCr);
        save('approval-after-cr', afterCr);
        f1.dialogOpenAfterLoneCr = stillOpen(afterCr);
        f1.screenKindAfterLoneCr = kindOf(afterCr, 'codex').kind;
      }
      const t2 = Date.now();
      while (Date.now() - t2 < APPROVAL_TURN_WAIT_MS) {
        const recs = rollout ? h.recordsAfter(rollout, off) : [];
        if (recs.some((r) => r.type === 'event_msg' && r.payload && (r.payload.type === 'task_complete' || r.payload.type === 'turn_aborted'))) break;
        if (stillOpen(await d.snap())) d.write(h.KEYS.esc);
        await h.sleep(500);
      }
      f1.turnRecords = rollout ? codexShapes(h, rollout, off) : null;
    }
    results.F1_codexApproval = f1;

    // X3: one ESC while busy, and the record that ends the turn.
    off = rollout ? h.fileSize(rollout) : 0;
    const x3 = {};
    const at3 = await submit('Count from 1 to 300, one number per line, and explain each number in a full sentence.', 'interrupt turn');
    const b2 = at3 === null ? null : await d.waitFor((t, snap) => busy(snap), 30000, 'busy for interrupt');
    x3.sawBusy = !!b2;
    if (b2) {
      await h.sleep(1500);
      const escAt = Date.now();
      d.write(h.KEYS.esc);
      const t3 = Date.now();
      while (Date.now() - t3 < INTERRUPT_WAIT_MS) {
        const recs = rollout ? h.recordsAfter(rollout, off) : [];
        const endRec = recs.find((r) => r.type === 'event_msg' && r.payload && ['turn_aborted', 'task_complete'].includes(r.payload.type));
        const snap = await d.snap();
        if (!x3.screenIdleAfterEscMs && idle(snap)) x3.screenIdleAfterEscMs = Date.now() - escAt;
        if (endRec && !x3.endRecord) { x3.endRecord = { payloadType: endRec.payload.type, reason: endRec.payload.reason || null, keys: Object.keys(endRec.payload).sort() }; x3.endRecordSeenAfterEscMs = Date.now() - escAt; }
        if (x3.endRecord && x3.screenIdleAfterEscMs) break;
        await h.sleep(h.POLL_MS);
      }
      const after = await d.snap();
      show('codex after-interrupt', after);
      save('after-interrupt', after);
      x3.records = rollout ? codexShapes(h, rollout, off) : null;
    }
    results.X3 = x3;

    // The slash command list.
    const readyForSlash = await codexReady(h, d, CLI_TIMEOUT_MS, 'slash menu', results);
    if (readyForSlash) {
      d.write('/');
      await h.sleep(1500);
      const menu = await d.snap();
      show('codex slash-menu', menu);
      save('slash-menu', menu);
      const cmds = new Map();
      for (let page = 0; page < SLASH_PAGES; page++) {
        for (const line of (await d.text()).split('\n')) {
          const mm = /^\s*[›>]?\s*\/([a-z][a-z0-9:_-]*)\s{2,}(.+?)\s*$/.exec(line);
          if (mm && !cmds.has(mm[1])) cmds.set(mm[1], mm[2]);
        }
        for (let k = 0; k < SLASH_STEP; k++) d.write(h.KEYS.down);
        await h.sleep(400);
      }
      results.slashCommands = Array.from(cmds.entries()).map(([name, description]) => ({ name, description }));
      d.write(h.KEYS.esc);
      await h.sleep(500);
    }
    results.rollout = rollout ? path.basename(rollout) : null;
  } catch (err) {
    results.codexError = String((err && err.stack) || err);
  } finally {
    d.kill();
  }
}

module.exports = { fixRoundScenes, findRollout, agentShape };
