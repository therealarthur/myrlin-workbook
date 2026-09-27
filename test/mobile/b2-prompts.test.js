/**
 * B2: prompt detection (PROTOCOL.md 8.1 to 8.4). Every golden screen
 * captured from the real Claude Code 2.1.283 and codex-cli 0.153.4
 * (fixtures/screens, each one listed) classifies to its expected kind,
 * options, roles, keys and question; synthetic Codex,
 * folder trust and multi question screens do too; the fingerprint ignores
 * the selector, the prompt id survives a highlight move and a question
 * change of the same tool call, and the transcript completes the prompt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('../_test-data-dir');
const fs = require('fs');
const path = require('path');
const kit = require('./fakes/b2-kit');
const { classify, roleOf, fingerprintOf, createPromptService } = require('../../src/web/mobile/chat/prompt-detect');

const SCREENS = path.join(__dirname, 'fixtures', 'screens');
const load = (n) => JSON.parse(fs.readFileSync(path.join(SCREENS, 'claude-2.1.283-' + n + '.json'), 'utf8'));
const loadFile = (n) => JSON.parse(fs.readFileSync(path.join(SCREENS, n + '.json'), 'utf8'));
const SEL = String.fromCharCode(0x276f);
const RULE = String.fromCharCode(0x2500).repeat(80);
const NBSP = String.fromCharCode(0xa0);

/** Synthetic snapshot from text rows (runs optional). */
function screen(rows, runs) {
  return { cols: 120, rows: 30, cursorX: 0, cursorY: 0, altBuffer: true, lines: rows.map((text, i) => ({ text, runs: (runs && runs[i]) || [] })) };
}

// Every capture in fixtures/screens, keyed by file name: the real Claude Code
// 2.1.283 and codex-cli 0.153.4 screens of the first run, the Workbook live
// check and the fix round (capture-real-fixround.js). A test below fails when
// a capture is missing from this table.
const expected = {
  'claude-2.1.283-permission': { kind: 'prompt', dialog: 'approval', title: 'Bash command', keys: ['1', '2', '3'], roles: ['allow', 'allowAlways', 'deny'], highlighted: 0 },
  'claude-2.1.283-permission-after-paste': { kind: 'prompt', dialog: 'approval' },
  'claude-2.1.283-permission-after-cr': { kind: 'busy' },
  'claude-2.1.283-ask-single': { kind: 'prompt', dialog: 'question', question: 'Pick a color', labels: ['Red', 'Blue'], otherIndex: 2, highlighted: 0 },
  // F1: a paste of "1 hello" into the open question dialog answered nothing.
  'claude-2.1.283-ask-single-after-paste': { kind: 'prompt', dialog: 'question', question: 'Pick a color' },
  // F1: a lone CR picked the highlighted option and the turn went on.
  'claude-2.1.283-ask-single-after-cr': { kind: 'busy' },
  'claude-2.1.283-ask-multi-q1': { kind: 'prompt', dialog: 'question', question: 'Pick a color', labels: ['Red', 'Blue'], tabs: ['Color', 'Sizes'], multi: false },
  'claude-2.1.283-ask-multi-q2': { kind: 'prompt', dialog: 'question', question: 'Pick sizes', labels: ['Small', 'Large'], tabs: ['Color', 'Sizes'], multi: true, checked: [false, false, false] },
  'claude-2.1.283-ask-multi-q2-checked': { kind: 'prompt', dialog: 'question', question: 'Pick sizes', multi: true, checked: [true, false, false] },
  'claude-2.1.283-ask-multi-review': { kind: 'prompt', dialog: 'question', review: true, optionLabels: ['Submit answers', 'Cancel'] },
  'claude-2.1.283-ask-multi-after-submit': { kind: 'busy' },
  'claude-2.1.283-plan-dialog': { kind: 'prompt', dialog: 'plan', roles: ['allow', 'allow', 'keepPlanning'] },
  // F1: a paste did not select a plan option; a lone CR did (the turn went on).
  'claude-2.1.283-plan-after-paste': { kind: 'prompt', dialog: 'plan' },
  'claude-2.1.283-plan-after-cr': { kind: 'busy' },
  'claude-2.1.283-plan-after-esc': { kind: 'idlePrompt', inputText: '' },
  'claude-2.1.283-idle-draft': { kind: 'idlePrompt', inputText: 'draft from the desktop' },
  'claude-2.1.283-after-submit-1s': { kind: 'busy' },
  'claude-2.1.283-fork-start': { kind: 'idlePrompt' },
  'claude-2.1.283-slash-menu': { kind: 'idlePrompt', inputText: '/' },
  // The folder trust dialog: unnumbered options, so an unknown modal with none (G2 holds sends).
  'claude-2.1.283-trust-dialog': { kind: 'unknownModal', dialog: 'unknown', title: 'Trust this folder?', optionLabels: [] },
  // Screens read through a Workbook PTY by the live check (fakes/live-check-workbook.js).
  'claude-2.1.283-live-idle': { kind: 'idlePrompt', inputText: '' },
  'claude-2.1.283-live-permission': { kind: 'prompt', dialog: 'approval', title: 'Bash command', keys: ['1', '2', '3'], roles: ['allow', 'allowAlways', 'deny'] },
  'claude-2.1.283-live-question': { kind: 'prompt', dialog: 'question', question: 'Pick a color', labels: ['Red', 'Blue'], otherIndex: 2 },
  'claude-2.1.283-live-after-interrupt': { kind: 'idlePrompt' },
  // codex-cli 0.153.4, captured in the fix round.
  'codex-0.153.4-idle-empty': { kind: 'idlePrompt', inputText: '', placeholder: true },
  'codex-0.153.4-idle-draft': { kind: 'idlePrompt', inputText: 'draft from the desktop', placeholder: false },
  'codex-0.153.4-busy': { kind: 'busy' },
  'codex-0.153.4-approval': { kind: 'prompt', dialog: 'approval', title: 'Run command', keys: ['y', 'p', 'esc'], roles: ['allow', 'allowAlways', 'deny'], highlighted: 0, detail: 'echo myrlin-check > probe.txt' },
  // F1: the paste's "1" approved the command; the rest landed in the composer.
  'codex-0.153.4-approval-after-paste': { kind: 'busy', inputText: 'hello' },
  'codex-0.153.4-after-interrupt': { kind: 'idlePrompt', inputText: '' },
  'codex-0.153.4-slash-menu': { kind: 'idlePrompt', inputText: '/' },
  'codex-0.153.4-trust-dialog': { kind: 'unknownModal', dialog: 'unknown', title: 'Trust this folder?', optionLabels: ['Yes, continue', 'No, quit'] },
};

kit.test('every capture in fixtures/screens has an expected classification', async () => {
  const files = fs.readdirSync(SCREENS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  kit.eq(files, Object.keys(expected).sort());
});

for (const [name, exp] of Object.entries(expected)) {
  kit.test('real capture ' + name + ' classifies as ' + exp.kind + (exp.dialog ? ' ' + exp.dialog : ''), async () => {
    const snap = loadFile(name);
    const c = classify(snap, snap.cli || 'claude');
    kit.eq(c.kind, exp.kind);
    if (exp.dialog) kit.eq(c.dialog.kind, exp.dialog);
    if (exp.title) kit.eq(c.dialog.title, exp.title);
    if (exp.keys) kit.eq(c.dialog.options.map((o) => o.key), exp.keys);
    if (exp.roles) kit.eq(c.dialog.options.map((o) => roleOf(o.label)), exp.roles);
    if (exp.highlighted !== undefined) kit.eq(c.dialog.highlighted, exp.highlighted);
    if (exp.question) kit.eq(c.dialog.question, exp.question);
    if (exp.labels) kit.eq(c.dialog.modelOptions.map((o) => o.label), exp.labels);
    if (exp.optionLabels) kit.eq(c.dialog.options.map((o) => o.label), exp.optionLabels);
    if (exp.otherIndex !== undefined) kit.eq(c.dialog.otherIndex, exp.otherIndex);
    if (exp.tabs) kit.eq(c.dialog.tabs && c.dialog.tabs.labels, exp.tabs);
    if (exp.multi !== undefined) kit.eq(c.dialog.multiSelect, exp.multi);
    if (exp.checked) kit.eq(c.dialog.options.slice(0, exp.checked.length).map((o) => o.checked === true), exp.checked);
    if (exp.review) kit.eq(c.dialog.review, true);
    if (exp.detail) kit.eq(c.dialog.screenDetail, exp.detail);
    if (exp.inputText !== undefined) kit.eq(c.input.inputText, exp.inputText);
    if (exp.placeholder !== undefined) kit.eq(c.input.placeholder, exp.placeholder);
  });
}

kit.test('ticking a multi select box keeps the fingerprint (the prompt keeps its id)', async () => {
  const a = classify(loadFile('claude-2.1.283-ask-multi-q2'), 'claude');
  const b = classify(loadFile('claude-2.1.283-ask-multi-q2-checked'), 'claude');
  kit.eq(fingerprintOf(a.dialog.region), fingerprintOf(b.dialog.region));
});

kit.test('the permission option that wraps keeps one label', async () => {
  const c = classify(load('permission'), 'claude');
  kit.ok(/^Yes, and always allow access to .* from this project$/.test(c.dialog.options[1].label), c.dialog.options[1].label);
});

kit.test('a dim placeholder is not a draft', async () => {
  const row = SEL + NBSP + 'Try "write a test"';
  const c = classify(screen([RULE, row, RULE, '  status'], [null, [{ s: 2, e: row.length, dim: true, bold: false, inverse: false, fg: null }]]), 'claude');
  kit.eq([c.kind, c.input.inputText, c.input.placeholder], ['idlePrompt', '', true]);
});

kit.test('Codex: composer, busy status and the letter key approval', async () => {
  const idle = classify(screen(['', String.fromCharCode(0x203a) + ' fix the bug', '', '  100% context left']), 'codex');
  kit.eq([idle.kind, idle.input.inputText], ['idlePrompt', 'fix the bug']);
  const busy = classify(screen([String.fromCharCode(0x2022) + ' Working (3s ' + String.fromCharCode(0x2022) + ' esc to interrupt)', '', String.fromCharCode(0x203a) + ' ']), 'codex');
  kit.eq(busy.kind, 'busy');
  const appr = classify(screen(['Would you like to run the following command?', '', '  $ npm test', '', String.fromCharCode(0x203a) + ' 1. Yes, proceed (y)', "  2. Yes, and don't ask again for this command (a)", '  3. No, and tell Codex what to do differently (esc)']), 'codex');
  kit.eq(appr.dialog.kind, 'approval');
  kit.eq(appr.dialog.options.map((o) => o.key), ['y', 'a', 'esc']);
  kit.eq(appr.dialog.options.map((o) => roleOf(o.label)), ['allow', 'allowAlways', 'deny']);
  kit.eq(appr.dialog.screenDetail, 'npm test');
});

kit.test('the folder trust dialog is an unknown modal with options', async () => {
  const c = classify(screen([RULE, ' Do you trust the files in this folder?', '', ' ' + SEL + ' 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm ' + String.fromCharCode(0xb7) + ' Esc to exit']), 'claude');
  kit.eq([c.kind, c.dialog.kind, c.dialog.options.length], ['unknownModal', 'unknown', 2]);
});

kit.test('multi question: the tab row names the questions and marks the current one', async () => {
  const tabRow = ' ' + String.fromCharCode(0x2612) + ' Color  ' + String.fromCharCode(0x2610) + ' Sizes  ' + String.fromCharCode(0x2714) + ' Submit';
  const s = screen([RULE, tabRow, '', 'Pick sizes', '', SEL + ' 1. [ ] Small', '  2. [x] Large', '  3. Type something.', RULE, '  4. Chat about this', '', 'Enter to select ' + String.fromCharCode(0xb7) + ' Esc to cancel'],
    [null, [{ s: tabRow.indexOf('Sizes'), e: tabRow.indexOf('Sizes') + 5, dim: false, bold: true, inverse: false, fg: null }]]);
  const c = classify(s, 'claude');
  kit.eq(c.dialog.tabs.labels, ['Color', 'Sizes']);
  kit.eq(c.dialog.tabs.current, 1);
  kit.eq([c.dialog.multiSelect, c.dialog.options[1].checked], [true, true]);
});

kit.test('fingerprint ignores the selector; the prompt id survives a highlight move and completes from the transcript', async () => {
  const a = classify(load('permission'), 'claude');
  const moved = JSON.parse(JSON.stringify(load('permission')));
  for (const l of moved.lines) {
    if (l.text.includes(SEL + ' 1. Yes')) l.text = l.text.replace(SEL + ' 1.', '  1.');
    else if (/^\s+2\. Yes/.test(l.text)) l.text = l.text.replace('  2.', SEL + ' 2.');
  }
  const b = classify(moved, 'claude');
  kit.eq(b.dialog.highlighted, 1);
  kit.eq(fingerprintOf(a.dialog.region), fingerprintOf(b.dialog.region));
  const published = [];
  const svc = createPromptService({
    ctx: { mobile: { hub: { publish: (t, type, d) => published.push({ type, d }) } } },
    index: { resolve: (id) => ({ sessionId: id, owner: 'workbook', workingDir: 'C:\\work\\myrlin-ios', provider: 'claude' }), computerName: () => 'PC' },
    lazy: { turns: () => ({ openToolsOf: () => [['toolu_1', { name: 'Bash', input: { command: 'echo myrlin-check > probe.txt' } }]] }) },
  });
  svc.onClassified('cl_x', a);
  svc.onClassified('cl_x', b);
  const opens = published.filter((p) => p.type === 'prompt.open');
  kit.eq(opens.length, 1, 'one open for one dialog');
  const p = opens[0].d.prompt;
  kit.validate(p, 'sessions/prompt.json');
  kit.eq([p.kind, p.source, p.toolCallId, p.detail, p.consequence], ['approval', 'screenAndTranscript', 'toolu_1', 'echo myrlin-check > probe.txt', 'Runs in ../myrlin-ios as your user']);
  const idle = classify(load('plan-after-esc'), 'claude');
  svc.onClassified('cl_x', idle);
  kit.eq(published.filter((q) => q.type === 'prompt.resolved').length, 0, 'one read is not enough');
  await kit.sleep(160);
  svc.onClassified('cl_x', idle);
  const res = published.filter((q) => q.type === 'prompt.resolved');
  kit.eq([res.length, res[0].d.by], [1, 'desktop']);
});

kit.test('question prompts take every question from the AskUserQuestion input', async () => {
  const published = [];
  const svc = createPromptService({
    ctx: { mobile: { hub: { publish: (t, type, d) => published.push({ type, d }) } } },
    index: { resolve: (id) => ({ sessionId: id, owner: 'workbook', workingDir: null, provider: 'claude' }), computerName: () => 'PC' },
    lazy: { turns: () => ({ openToolsOf: () => [['toolu_q', { name: 'AskUserQuestion', input: { questions: [{ question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }] }] } }]] }) },
  });
  svc.onClassified('cl_q', classify(load('ask-single'), 'claude'));
  const p = published[0].d.prompt;
  kit.validate(p, 'sessions/prompt.json');
  kit.eq([p.questions.length, p.questions[0].header, p.questions[0].allowOther, p.currentQuestionIndex], [1, 'Color', true, 0]);
  kit.eq(p.questions[0].options.map((o) => o.description), ['The color red', 'The color blue']);
});

kit.run();
