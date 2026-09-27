/**
 * Prompt detection from the VT screen and completion from the transcript
 * (PROTOCOL.md 8.1 to 8.4), plus the per session prompt service.
 *
 * What: classify() is a pure function over a ScreenSnapshot that answers
 * prompt (approval, plan, question, with options, roles, the highlighted
 * option and the current question), unknownModal, busy, idlePrompt (with the
 * input line's text and whether it is only dim placeholder) or none. The
 * anchors are pinned by golden screens captured from Claude Code 2.1.283 in a
 * scratch session (test/mobile/fixtures/screens/): the idle input is the row
 * starting with the heavy angle glyph between two full width rules, the busy
 * line is a spinner glyph plus a capitalised gerund and an ellipsis, and
 * dialogs follow a rule with numbered options. The prompt service keeps the
 * open Prompt of each session, completes it from the transcript's open
 * tool_use, gives it a stable id and fingerprint, and publishes prompt.open
 * and prompt.resolved.
 *
 * Why: questions and approvals are answered from the phone as the dialog's
 * own keys while the desktop dialog stays live (A6); the send guard must know
 * when a dialog or a desktop draft is on screen (A7, critic F1).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const path = require('path');
const { sha256b64url, warn } = require('./common');
const { isRangeDim } = require('./screen-reader');

const SELECTOR = '❯';
const CODEX_SELECTOR = '›';
const RULE_CHARS_RE = /^[─━╌╍┄┅]{10,}$/;
/** A rule carrying a label: ten or more rule glyphs, a label, then rule glyphs to the edge. */
const LABELLED_RULE_RE = /^[─━]{10,} \S.{0,80}? [─━]+$/;
const OPTION_RE = /^(\s*)(?:([❯›>])\s*)?(\d{1,2})\.\s+(.*?)\s*$/;
const KEY_HINT_RE = /\s*\(([a-z]|esc|enter|tab)\)\s*$/i;
// Claude Code 2.1.283 draws a multi select box as "[ ]" and a ticked one as
// "[✔]" (golden screen ask-multi-q2-checked); the bare glyphs cover other layouts.
const CHECKBOX_RE = /^(\[[ xX✔✓]\]|[☐☑☒◻◼□■✔✓])\s*/;
/** Check box marks a fingerprint ignores, so ticking a box never changes a prompt's identity (PROTOCOL.md 8.4). */
const CHECKBOX_MARKS_RE = /\[[ xX✔✓]\]|[☐☑☒◻◼✔✓]/g;
/**
 * Trust dialogs, which are unknown modals (PROTOCOL.md 8.2): Claude Code
 * 2.1.283 asks "Is this a project you created or one you trust?" under
 * "Quick safety check" with unnumbered options, codex-cli 0.153.4 asks "Do you
 * trust the contents of this directory?" with numbered ones (golden screens
 * claude-2.1.283-trust-dialog and codex-0.153.4-trust-dialog); the older
 * wording stays for earlier builds.
 */
const TRUST_ANCHOR_RE = /Do you trust the files in this folder|trust this folder|Quick safety check|Is this a project you created or one you trust|Do you trust the contents of this directory/i;
const BUSY_CLAUDE_RE = /^\s*\S?\s*[A-Z][a-zA-Z'-]{2,}(?:…|\.\.\.)(?:\s|$|\()/;
const BUSY_HINT_RE = /esc to interrupt/i;
const RESOLVE_READS = 2;
const RESOLVE_MIN_GAP_MS = 150;
const RAW_ROWS_MAX = 40;
const RAW_COLS_MAX = 200;
const PLAN_DETAIL_MAX = 16384;
const PHONE_KEYS_WINDOW_MS = 5000;

/**
 * Whether a row is a horizontal rule.
 * @param {string} text
 * @returns {boolean}
 */
function isRule(text) {
  return RULE_CHARS_RE.test(String(text || '').trim());
}

/**
 * Whether a row is a rule of the input box. Claude Code 2.1.283 writes the
 * session name into the upper rule once the conversation is named (golden
 * screen plan-after-cr: a rule, the name, one more rule glyph), so a rule
 * with a label counts too.
 * @param {string} text
 * @returns {boolean}
 */
function isInputRule(text) {
  const t = String(text || '').trim();
  return RULE_CHARS_RE.test(t) || LABELLED_RULE_RE.test(t);
}

/**
 * Role of an option by its label (PROTOCOL.md 8.2, with the 2.1.283 labels).
 * @param {string} label
 * @returns {string}
 */
function roleOf(label) {
  const l = String(label || '').trim();
  if (/^No, keep planning/i.test(l) || /^Tell Claude what to change/i.test(l)) return 'keepPlanning';
  if (/^Yes/i.test(l) && /don'?t ask again|for this session|always allow|and always/i.test(l)) return 'allowAlways';
  if (/^Yes/i.test(l)) return 'allow';
  if (/^No\b/i.test(l)) return 'deny';
  if (/^(Other|Type something)/i.test(l)) return 'other';
  return 'neutral';
}

/**
 * The idle input row of the screen: Claude's glyph row between two rules, or
 * Codex's composer row.
 * @param {object} snap
 * @param {string} provider
 * @returns {{row: number, inputText: string, placeholder: boolean}|null}
 */
function detectInput(snap, provider) {
  const L = snap.lines;
  for (let i = L.length - 1; i >= 1; i--) {
    const text = L[i].text;
    if (provider === 'codex') { // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
      const m = /^\s*›\s?(.*)$/.exec(text);
      if (m && !OPTION_RE.test(text)) {
        const start = text.indexOf(CODEX_SELECTOR) + 2;
        const input = text.slice(start);
        const placeholder = input.trim().length > 0 && isRangeDim(L[i], start + (input.length - input.trimStart().length), start + input.trimEnd().length);
        return { row: i, inputText: placeholder ? '' : input.trim(), placeholder };
      }
      continue;
    }
    // Claude Code 2.1.283 writes a no-break space after the glyph (golden screens).
    const isPromptRow = /^[❯>][  ]/.test(text) || text.trimEnd() === SELECTOR || text.trimEnd() === '>';
    if (!isPromptRow || OPTION_RE.test(text)) continue;
    if (!isInputRule(L[i - 1].text)) continue;
    let j = i + 1;
    const parts = [text.slice(2)];
    while (j < L.length && !isInputRule(L[j].text)) { parts.push(L[j].text.replace(/^ {2}/, '')); j++; }
    if (j >= L.length) continue;
    const firstStart = 2;
    const raw = parts.join('\n');
    const trimmed = raw.trim();
    let placeholder = false;
    if (trimmed.length) {
      const lead = parts[0].length - parts[0].trimStart().length;
      placeholder = parts.length === 1 && isRangeDim(L[i], firstStart + lead, firstStart + parts[0].trimEnd().length);
    }
    return { row: i, inputText: placeholder ? '' : trimmed, placeholder };
  }
  return null;
}

/**
 * Whether a busy line shows (above the input for Claude).
 * @param {object} snap
 * @param {string} provider
 * @param {number|null} inputRow
 * @returns {boolean}
 */
function detectBusy(snap, provider, inputRow) {
  const L = snap.lines;
  const end = inputRow !== null && inputRow !== undefined ? inputRow : L.length;
  for (let i = 0; i < end; i++) {
    const t = L[i].text;
    if (BUSY_HINT_RE.test(t)) return true;
    if (provider === 'codex') { if (/^\s*\S?\s*Working \(/.test(t)) return true; continue; } // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
    if (i >= end - 6 && BUSY_CLAUDE_RE.test(t) && !/ for \d+[smh]/.test(t)) return true;
  }
  return false;
}

/**
 * Parse a block of numbered options starting at a row.
 * @param {object[]} L - lines
 * @param {number} from
 * @param {string} kind - 'question' puts indented lines into descriptions
 * @returns {{options: object[], end: number, highlighted: (number|null)}}
 */
function parseOptions(L, from, kind) {
  const options = [];
  let highlighted = null;
  let i = from;
  let cur = null;
  for (; i < L.length; i++) {
    const text = L[i].text;
    const m = OPTION_RE.exec(text);
    if (m && Number(m[3]) === options.length + 1) {
      let label = m[4];
      let key = m[3];
      const hint = KEY_HINT_RE.exec(label);
      if (hint) { key = hint[1].toLowerCase(); label = label.slice(0, hint.index).trim(); }
      let checked = null;
      const cb = CHECKBOX_RE.exec(label);
      if (cb) { checked = /[xX☑☒◼■✔✓]/.test(cb[1]); label = label.slice(cb[0].length); }
      cur = { index: options.length, key, label, description: null, checked, indent: (m[1] || '').length + (m[2] ? 2 : 0), numberCol: text.indexOf(m[3] + '.') };
      if (m[2]) highlighted = options.length;
      options.push(cur);
      continue;
    }
    if (!text.trim()) { if (cur) cur._blank = (cur._blank || 0) + 1; if (cur && cur._blank > 1) { i++; break; } continue; }
    if (isRule(text)) { if (options.length) continue; break; }
    if (cur && text.length - text.trimStart().length > cur.numberCol) {
      const extra = text.trim();
      if (kind === 'question' || /^shift\+tab|^tab to|^enter to/i.test(extra)) cur.description = cur.description ? cur.description + ' ' + extra : extra;
      else cur.label = cur.label + ' ' + extra;
      continue;
    }
    break;
  }
  for (const o of options) { delete o._blank; delete o.indent; delete o.numberCol; }
  return { options, end: i, highlighted };
}

/**
 * The last rule row above a row.
 * @param {object[]} L
 * @param {number} row
 * @returns {number} -1 when none
 */
function ruleAbove(L, row) {
  for (let i = row - 1; i >= 0; i--) if (isRule(L[i].text)) return i;
  return -1;
}

/**
 * Plain text of rows, trimmed, capped for rawScreen.
 * @param {object[]} L
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function regionText(L, from, to) {
  const rows = [];
  for (let i = Math.max(0, from); i < Math.min(L.length, to) && rows.length < RAW_ROWS_MAX; i++) rows.push(L[i].text.replace(/\s+$/, '').slice(0, RAW_COLS_MAX));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  while (rows.length && !rows[0]) rows.shift();
  return rows.join('\n');
}

/**
 * Fingerprint of a dialog region (PROTOCOL.md 8.4): selector and check box glyphs removed.
 * @param {string} region
 * @returns {string}
 */
function fingerprintOf(region) {
  const norm = region.split('\n').map((r) => r.replace(/[❯›]/g, ' ').replace(CHECKBOX_MARKS_RE, '').replace(/\s+$/, '')).join('\n');
  return sha256b64url(norm).slice(0, 16);
}

/**
 * Claude dialogs on a snapshot.
 * @param {object} snap
 * @returns {object|null} parsed prompt (without ids)
 */
function detectClaudeDialog(snap) {
  const L = snap.lines;
  // Approval: "Do you want to ..." then numbered options.
  for (let i = L.length - 1; i >= 0; i--) {
    const t = L[i].text;
    if (/^\s*Do you want to /.test(t) && i + 1 < L.length) {
      const opt = parseOptions(L, i + 1, 'approval');
      if (opt.options.length < 2) continue;
      const top = ruleAbove(L, i);
      const bodyRows = [];
      for (let r = top + 1; r < i; r++) if (L[r].text.trim()) bodyRows.push(L[r].text.trim());
      const title = bodyRows.length ? bodyRows[0] : 'Permission';
      return { kind: 'approval', title, screenDetail: bodyRows.slice(1).join('\n') || null, options: opt.options, highlighted: opt.highlighted, region: regionText(L, top, L.length), top };
    }
  }
  // Plan: "Would you like to proceed?" with a Yes option.
  for (let i = L.length - 1; i >= 0; i--) {
    if (!/Would you like to proceed\?/.test(L[i].text)) continue;
    let j = i + 1;
    while (j < L.length && !L[j].text.trim()) j++;
    const opt = parseOptions(L, j, 'plan');
    if (opt.options.length < 2 || !/^Yes/i.test(opt.options[0].label)) continue;
    const top = ruleAbove(L, i);
    const planRows = [];
    for (let r = 0; r < top; r++) {
      const x = L[r].text.replace(/[│╭╮╰╯╌]/g, '').trim();
      if (x && !isRule(x)) planRows.push(x);
    }
    return { kind: 'plan', title: 'Ready to code?', screenDetail: planRows.slice(-30).join('\n') || null, options: opt.options, highlighted: opt.highlighted, region: regionText(L, top, L.length), top };
  }
  // Question: footer "Enter to select" and numbered options after a rule.
  const footer = L.findIndex((l) => /Enter to select/i.test(l.text) && /navigate|Esc to cancel/i.test(l.text));
  const review = L.findIndex((l) => /Submit answers|Review your answers/i.test(l.text));
  if (footer !== -1 || review !== -1) {
    let first = -1;
    for (let i = 0; i < L.length; i++) { const m = OPTION_RE.exec(L[i].text); if (m && m[3] === '1') first = i; }
    if (first !== -1) {
      const opt = parseOptions(L, first, 'question');
      const top = ruleAbove(L, first);
      const rows = [];
      for (let r = top + 1; r < first; r++) if (L[r].text.trim()) rows.push({ r, text: L[r].text.trim() });
      let tabs = null;
      let question = null;
      if (rows.length && /[☐☑☒✔✓◻◼]|Submit|←|→/.test(rows[0].text)) {
        tabs = parseTabs(L[rows[0].r]);
        question = rows.slice(1).map((x) => x.text).join(' ') || null;
      } else {
        question = rows.map((x) => x.text).join(' ') || null;
      }
      const isReview = review !== -1 && (!question || /review/i.test(question) || /Submit answers/i.test(opt.options.map((o) => o.label).join(' ')));
      const modelOptions = opt.options.filter((o) => !/^(Type something|Other|Chat about this)/i.test(o.label));
      const otherOpt = opt.options.find((o) => /^(Type something|Other)/i.test(o.label));
      const multi = opt.options.some((o) => o.checked !== null);
      return {
        kind: 'question',
        title: 'Claude has a question',
        header: tabs && tabs.current !== null ? tabs.labels[tabs.current] : (tabs && tabs.labels.length === 1 ? tabs.labels[0] : null),
        question,
        options: opt.options,
        modelOptions,
        otherIndex: otherOpt ? otherOpt.index : null,
        multiSelect: multi,
        highlighted: opt.highlighted,
        tabs,
        review: isReview,
        region: regionText(L, top, L.length),
        top,
      };
    }
  }
  return null;
}

/**
 * Parse a question tab row: chips with check boxes and a Submit chip.
 * @param {{text: string, runs: Array}} line
 * @returns {{labels: string[], current: (number|null), hasSubmit: boolean}}
 */
function parseTabs(line) {
  const text = line.text;
  const chips = [];
  const re = /([☐☑☒✔✓◻◼])\s*([^☐☑☒✔✓◻◼←→]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) chips.push({ label: m[2].trim(), s: m.index, e: m.index + m[0].length, done: /[☑☒✔✓◼]/.test(m[1]) });
  const labels = chips.map((c) => c.label).filter((l) => !/^Submit$/i.test(l));
  let current = null;
  const hot = (line.runs || []).find((r) => r.inverse || r.bold);
  if (hot) {
    const idx = chips.findIndex((c) => hot.s < c.e && hot.e > c.s);
    if (idx !== -1 && !/^Submit$/i.test(chips[idx].label)) current = labels.indexOf(chips[idx].label);
  }
  return { labels, current, hasSubmit: /Submit/i.test(text) };
}

/**
 * Codex dialogs on a snapshot.
 * @param {object} snap
 * @returns {object|null}
 */
function detectCodexDialog(snap) {
  const L = snap.lines;
  for (let i = L.length - 1; i >= 0; i--) {
    const t = L[i].text;
    if (/Would you like to (run|make|allow)|Allow command\?|wants to run/i.test(t)) {
      let j = i + 1;
      while (j < L.length && !OPTION_RE.test(L[j].text)) j++;
      const opt = parseOptions(L, j, 'approval');
      if (opt.options.length < 2) continue;
      const cmdRows = [];
      const dollarRows = [];
      for (let r = i + 1; r < j; r++) {
        const t2 = L[r].text.trim();
        if (!t2) continue;
        cmdRows.push(t2.replace(/^\$\s*/, ''));
        if (/^\$\s/.test(t2)) dollarRows.push(t2.replace(/^\$\s*/, ''));
      }
      // codex-cli 0.153.4 draws "Environment: local" and a "Reason: ..." line
      // above the "$ command" line (golden screen codex-0.153.4-approval); the
      // command is the detail when it is there.
      if (dollarRows.length) cmdRows.splice(0, cmdRows.length, ...dollarRows);
      const top = ruleAbove(L, i) === -1 ? Math.max(0, i - 2) : ruleAbove(L, i);
      return { kind: 'approval', title: 'Run command', screenDetail: cmdRows.join('\n') || null, options: opt.options, highlighted: opt.highlighted, region: regionText(L, top, L.length), top };
    }
  }
  return null;
}

/**
 * A modal no detector claims (PROTOCOL.md 8.2 unknown), including the folder trust dialog.
 * @param {object} snap
 * @returns {object|null}
 */
function detectUnknown(snap) {
  const L = snap.lines;
  const trust = L.findIndex((l) => TRUST_ANCHOR_RE.test(l.text));
  if (trust !== -1) {
    let j = trust + 1;
    while (j < L.length && !OPTION_RE.test(L[j].text)) j++;
    const opt = j < L.length ? parseOptions(L, j, 'approval') : { options: [], highlighted: null };
    const top = Math.max(0, ruleAbove(L, trust));
    return { kind: 'unknown', title: 'Trust this folder?', options: opt.options, highlighted: opt.highlighted, region: regionText(L, top, L.length), top, trust: true };
  }
  const boxTop = L.findIndex((l) => /^\s*╭/.test(l.text));
  if (boxTop !== -1) {
    const boxEnd = L.findIndex((l, i) => i > boxTop && /^\s*╰/.test(l.text));
    if (boxEnd - boxTop >= 2) {
      const inner = L.slice(boxTop, boxEnd + 1).map((l) => l.text).join('\n');
      if (inner.includes(SELECTOR) || /esc to|enter to/i.test(inner)) {
        let first = -1;
        for (let i = boxTop; i <= boxEnd; i++) if (OPTION_RE.test(L[i].text.replace(/^\s*│/, ''))) { first = i; break; }
        const opt = first !== -1 ? parseOptions(L.map((l) => ({ text: l.text.replace(/^\s*│/, '').replace(/│\s*$/, ''), runs: l.runs })), first, 'approval') : { options: [], highlighted: null };
        return { kind: 'unknown', title: 'A dialog is open', options: opt.options, highlighted: opt.highlighted, region: regionText(L, boxTop, boxEnd + 1), top: boxTop };
      }
    }
  }
  // A selector on a numbered option below a rule that no detector claimed.
  for (let i = L.length - 1; i >= 1; i--) {
    const m = OPTION_RE.exec(L[i].text);
    if (!m || !m[2]) continue;
    let first = i;
    while (first > 0 && (OPTION_RE.test(L[first - 1].text) || (L[first - 1].text.trim() && !isRule(L[first - 1].text) && /^\s{3,}/.test(L[first - 1].text)))) first--;
    const top = ruleAbove(L, first);
    if (top === -1) continue;
    const firstOpt = L.slice(top + 1).findIndex((l) => /^\s*(?:[❯>]\s*)?1\.\s/.test(l.text));
    if (firstOpt === -1) continue;
    const opt = parseOptions(L, top + 1 + firstOpt, 'approval');
    if (opt.options.length < 2) continue;
    return { kind: 'unknown', title: 'A dialog is open', options: opt.options, highlighted: opt.highlighted, region: regionText(L, top, L.length), top };
  }
  return null;
}

/**
 * Classify a screen (PROTOCOL.md 8.1): prompt, unknownModal, busy, idlePrompt or none.
 * @param {object} snap
 * @param {'claude'|'codex'} provider gsd:provider-literal-allowed
 * @returns {object}
 */
function classify(snap, provider) {
  if (!snap || !Array.isArray(snap.lines)) return { kind: 'none', input: null, busy: false };
  const input = detectInput(snap, provider);
  const busy = detectBusy(snap, provider, input ? input.row : null);
  const dialog = provider === 'codex' ? detectCodexDialog(snap) : detectClaudeDialog(snap); // gsd:provider-literal-allowed (mobile v2: the phone protocol names the two agent providers)
  if (dialog) return { kind: 'prompt', dialog, input, busy };
  const unknown = detectUnknown(snap);
  if (unknown && !input) return { kind: 'unknownModal', dialog: unknown, input, busy };
  if (busy) return { kind: 'busy', input, busy: true };
  if (input) return { kind: 'idlePrompt', input, busy: false, inputText: input.inputText, placeholder: input.placeholder };
  return { kind: 'none', input: null, busy: false };
}

// ── The prompt service ─────────────────────────────────────────────────────

/**
 * Create the per session prompt service.
 * @param {object} deps - {ctx, index, turns, now}
 * @returns {object}
 */
function createPromptService(deps) {
  const { index } = deps;
  const now = deps.now || Date.now;
  const open = new Map();
  const phoneKeys = new Map();
  const lastCls = new Map();
  const listeners = new Set();
  const hub = () => (deps.ctx && deps.ctx.mobile && deps.ctx.mobile.hub) || null;
  const turns = () => (deps.lazy && deps.lazy.turns ? deps.lazy.turns() : null);

  function pub(sessionId, type, data) {
    const h = hub();
    if (!h) return;
    try { h.publish('session:' + sessionId, type, data); } catch (err) { warn('prompt publish failed', err && err.message); }
  }

  /**
   * Transcript completion (PROTOCOL.md 8.3) from the open tool calls of the turn.
   * @param {string} sessionId
   * @param {string} kind
   * @returns {{toolName: string, toolCallId: string, input: object}|null}
   */
  function openToolFor(sessionId, kind) {
    const t = turns();
    const list = t && t.openToolsOf ? t.openToolsOf(sessionId) : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const [id, tool] = list[i];
      if (kind === 'question' && (tool.name === 'AskUserQuestion' || tool.name === 'request_user_input')) return { toolName: tool.name, toolCallId: id, input: tool.input || {} };
      if (kind === 'plan' && tool.name === 'ExitPlanMode') return { toolName: tool.name, toolCallId: id, input: tool.input || {} };
      if (kind === 'approval' && tool.name !== 'AskUserQuestion' && tool.name !== 'ExitPlanMode') return { toolName: tool.name, toolCallId: id, input: tool.input || {} };
    }
    return null;
  }

  /**
   * Build the Prompt object for a detected dialog.
   * @param {string} sessionId
   * @param {object} d - detector output
   * @param {object|null} prev - the open prompt it may continue
   * @returns {object}
   */
  function buildPrompt(sessionId, d, prev) {
    const ref = index.resolve(sessionId);
    const owner = ref ? ref.owner : 'none';
    const kind = d.kind;
    const tool = kind === 'unknown' ? null : openToolFor(sessionId, kind);
    const fingerprint = fingerprintOf(d.region);
    const sameQuestionTool = prev && prev.kind === 'question' && kind === 'question' && tool && prev.toolCallId === tool.toolCallId;
    const keepId = prev && (prev.fingerprint === fingerprint || sameQuestionTool);
    const openedAtMs = keepId ? prev.openedAtMs : now();
    const promptId = keepId ? prev.promptId : 'p_' + sha256b64url(sessionId + '\n' + openedAtMs + '\n' + fingerprint).slice(0, 20);
    const p = {
      promptId,
      sessionId,
      kind,
      openedAtMs,
      source: tool ? 'screenAndTranscript' : 'screen',
      title: d.title,
      detail: null,
      toolName: tool ? tool.toolName : null,
      toolCallId: tool ? String(tool.toolCallId) : null,
      questions: [],
      options: [],
      currentQuestionIndex: 0,
      consequence: null,
      answerable: owner === 'workbook',
      rawScreen: null,
      fingerprint,
    };
    const opts = (list) => list.map((o, i) => ({ index: i, key: o.key || null, label: o.label, description: o.description || null, recommended: /\(Recommended\)\s*$/.test(o.label), role: roleOf(o.label) }));
    if (kind === 'approval') {
      p.options = opts(d.options);
      const inp = tool ? tool.input : null;
      p.detail = inp && typeof inp.command === 'string' ? inp.command : (inp && typeof inp.file_path === 'string' ? inp.file_path : d.screenDetail);
      const wd = ref && ref.workingDir ? path.basename(String(ref.workingDir).replace(/[\\/]+$/, '').replace(/\\/g, '/')) : null;
      p.consequence = wd ? 'Runs in ../' + wd + ' as your user' : 'Runs on ' + index.computerName() + ' as your user';
    } else if (kind === 'plan') {
      p.options = opts(d.options);
      const planText = tool && tool.input && typeof tool.input.plan === 'string' ? tool.input.plan : d.screenDetail;
      p.detail = planText ? planText.slice(0, PLAN_DETAIL_MAX) : null;
    } else if (kind === 'question') {
      const qs = tool && Array.isArray(tool.input.questions) ? tool.input.questions : null;
      const allowOther = d.otherIndex !== null;
      if (qs && qs.length) {
        p.questions = qs.map((q, qi) => ({
          index: qi,
          header: typeof q.header === 'string' ? q.header : null,
          question: String(q.question || ''),
          multiSelect: !!q.multiSelect,
          allowOther,
          options: (Array.isArray(q.options) ? q.options : []).map((o, oi) => ({ index: oi, key: String(oi + 1), label: String(o.label || ''), description: o.description ? String(o.description) : null, recommended: /\(Recommended\)\s*$/.test(String(o.label || '')), role: 'neutral' })),
        }));
        let cur = 0;
        if (d.question) {
          const hit = p.questions.findIndex((q) => q.question && d.question.includes(q.question.slice(0, 40)));
          if (hit !== -1) cur = hit;
        } else if (d.tabs && d.tabs.current !== null) cur = d.tabs.current;
        p.currentQuestionIndex = d.review ? Math.max(0, p.questions.length - 1) : cur;
      } else {
        p.questions = [{ index: 0, header: d.header || null, question: d.question || '', multiSelect: !!d.multiSelect, allowOther, options: d.modelOptions.map((o, i) => ({ index: i, key: o.key || null, label: o.label, description: o.description || null, recommended: /\(Recommended\)\s*$/.test(o.label), role: 'neutral' })) }];
        if (!d.question) p.rawScreen = d.region.split('\n').slice(0, RAW_ROWS_MAX).join('\n');
      }
    } else {
      p.options = opts(d.options);
      p.rawScreen = d.region;
      if (!d.options.length) p.answerable = false;
    }
    p._screen = { highlighted: d.highlighted, options: d.options, otherIndex: d.otherIndex === undefined ? null : d.otherIndex, review: !!d.review, tabs: d.tabs || null };
    return p;
  }

  /**
   * Public copy of a prompt (private screen state removed).
   * @param {object} p
   * @returns {object}
   */
  function pub1(p) {
    const o = Object.assign({}, p);
    delete o._screen;
    delete o._missing;
    delete o._lastSeenAt;
    return o;
  }

  /**
   * A new classification for a session's screen.
   * @param {string} sessionId
   * @param {object} cls - classify() output
   */
  function onClassified(sessionId, cls) {
    lastCls.set(sessionId, cls);
    const prev = open.get(sessionId) || null;
    const d = cls.kind === 'prompt' || cls.kind === 'unknownModal' ? cls.dialog : null;
    if (d) {
      const p = buildPrompt(sessionId, d, prev);
      p._lastSeenAt = now();
      p._missing = [];
      open.set(sessionId, p);
      const changed = !prev || prev.promptId !== p.promptId || prev.currentQuestionIndex !== p.currentQuestionIndex || prev.source !== p.source || prev.fingerprint !== p.fingerprint;
      // The dialog changed in place into another prompt: the old one resolves,
      // and answers still aimed at it get PROMPT_CHANGED (PROTOCOL.md 8.5).
      if (prev && prev.promptId !== p.promptId) resolve(sessionId, prev, null, p.promptId);
      if (changed) {
        pub(sessionId, 'prompt.open', { prompt: pub1(p) });
        for (const fn of listeners) { try { fn('open', pub1(p), prev ? pub1(prev) : null); } catch (_) {} }
      }
      return;
    }
    if (!prev) return;
    // Resolved after 2 consecutive reads without the dialog, at least 150 ms apart.
    const t = now();
    const miss = prev._missing || [];
    if (!miss.length || t - miss[miss.length - 1] >= RESOLVE_MIN_GAP_MS) miss.push(t);
    prev._missing = miss;
    if (miss.length >= RESOLVE_READS) resolve(sessionId, prev, null);
  }

  /**
   * Close a prompt and publish prompt.resolved.
   * @param {string} sessionId
   * @param {object} p
   * @param {string|null} byOverride
   * @param {string|null} [replacedBy] - the prompt that took its place on screen, when it changed in place
   */
  function resolve(sessionId, p, byOverride, replacedBy) {
    if (open.get(sessionId) === p) open.delete(sessionId);
    const keys = phoneKeys.get(sessionId);
    let by = byOverride;
    let deviceId = null;
    let summary = null;
    if (!by) {
      if (keys && keys.promptId === p.promptId && now() - keys.at <= PHONE_KEYS_WINDOW_MS) { by = 'phone'; deviceId = keys.deviceId; summary = keys.summary || null; }
      else by = 'desktop';
    }
    if (by === 'phone' && keys) { deviceId = keys.deviceId; summary = keys.summary || null; }
    const data = { sessionId, promptId: p.promptId, by, deviceId: by === 'phone' ? deviceId : null, resolvedAtMs: now(), summary: summary || (by === 'desktop' ? 'Answered on ' + index.computerName() : null) };
    p._resolved = data;
    pub(sessionId, 'prompt.resolved', data);
    for (const fn of listeners) { try { fn('resolved', pub1(p), data, { replacedBy: replacedBy || null }); } catch (_) {} }
  }

  return {
    classify,
    onClassified,
    /** Open prompts of a session (0 or 1 in v1). */
    openFor(sessionId) { const p = open.get(sessionId); return p ? [pub1(p)] : []; },
    /** Internal prompt with screen state (answers). */
    internal(sessionId) { return open.get(sessionId) || null; },
    /** Record that phone keys were written to a prompt (resolution `by`). */
    notePhoneKeys(sessionId, promptId, deviceId, summary) { phoneKeys.set(sessionId, { promptId, deviceId, summary, at: now() }); },
    /** The PTY exited: every open prompt resolves by exit. */
    onExit(sessionId) { const p = open.get(sessionId); if (p) resolve(sessionId, p, 'exit'); },
    /**
     * The transcript caught up: rebuild an open prompt that was built from the
     * screen alone and publish it again with the same id (PROTOCOL.md 8.3).
     * @param {string} sessionId
     */
    recomplete(sessionId) {
      const p = open.get(sessionId);
      const cls = lastCls.get(sessionId);
      if (p && cls && p.source === 'screen' && p.kind !== 'unknown') onClassified(sessionId, cls);
    },
    /** Drop state without events (tests). */
    clear(sessionId) { open.delete(sessionId); },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    wasResolved(sessionId, promptId) { return null; },
  };
}

module.exports = {
  classify,
  createPromptService,
  detectInput,
  detectBusy,
  detectClaudeDialog,
  detectCodexDialog,
  detectUnknown,
  parseOptions,
  roleOf,
  fingerprintOf,
  isRule,
  SELECTOR,
};
