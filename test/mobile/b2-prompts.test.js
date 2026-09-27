/**
 * B2: prompt detection (PROTOCOL.md 8.1 to 8.4). Every golden screen
 * captured from the real Claude Code 2.1.283 (fixtures/screens) classifies
 * to its expected kind, options, roles and question; synthetic Codex,
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
const SEL = String.fromCharCode(0x276f);
const RULE = String.fromCharCode(0x2500).repeat(80);
const NBSP = String.fromCharCode(0xa0);

/** Synthetic snapshot from text rows (runs optional). */
function screen(rows, runs) {
  return { cols: 120, rows: 30, cursorX: 0, cursorY: 0, altBuffer: true, lines: rows.map((text, i) => ({ text, runs: (runs && runs[i]) || [] })) };
}

const expected = {
  permission: { kind: 'prompt', dialog: 'approval', title: 'Bash command', keys: ['1', '2', '3'], roles: ['allow', 'allowAlways', 'deny'], highlighted: 0 },
  'permission-after-paste': { kind: 'prompt', dialog: 'approval' },
  'permission-after-cr': { kind: 'busy' },
  'ask-single-after-cr': { kind: 'prompt', dialog: 'question', question: 'Pick a color', labels: ['Red', 'Blue'], otherIndex: 2 },
  'plan-dialog': { kind: 'prompt', dialog: 'plan', roles: ['allow', 'allow', 'keepPlanning'] },
  'plan-after-esc': { kind: 'idlePrompt', inputText: '' },
  'idle-draft': { kind: 'idlePrompt', inputText: 'draft from the desktop' },
  'after-submit-1s': { kind: 'busy' },
  'fork-start': { kind: 'idlePrompt' },
  'slash-menu': { kind: 'idlePrompt', inputText: '/' },
};

for (const [name, exp] of Object.entries(expected)) {
  kit.test('real capture ' + name + ' classifies as ' + exp.kind + (exp.dialog ? ' ' + exp.dialog : ''), async () => {
    const c = classify(load(name), 'claude');
    kit.eq(c.kind, exp.kind);
    if (exp.dialog) kit.eq(c.dialog.kind, exp.dialog);
    if (exp.title) kit.eq(c.dialog.title, exp.title);
    if (exp.keys) kit.eq(c.dialog.options.map((o) => o.key), exp.keys);
    if (exp.roles) kit.eq(c.dialog.options.map((o) => roleOf(o.label)), exp.roles);
    if (exp.highlighted !== undefined) kit.eq(c.dialog.highlighted, exp.highlighted);
    if (exp.question) kit.eq(c.dialog.question, exp.question);
    if (exp.labels) kit.eq(c.dialog.modelOptions.map((o) => o.label), exp.labels);
    if (exp.otherIndex !== undefined) kit.eq(c.dialog.otherIndex, exp.otherIndex);
    if (exp.inputText !== undefined) kit.eq(c.input.inputText, exp.inputText);
  });
}

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
  svc.onClassified('cl_q', classify(load('ask-single-after-cr'), 'claude'));
  const p = published[0].d.prompt;
  kit.validate(p, 'sessions/prompt.json');
  kit.eq([p.questions.length, p.questions[0].header, p.questions[0].allowOther, p.currentQuestionIndex], [1, 'Color', true, 0]);
  kit.eq(p.questions[0].options.map((o) => o.description), ['The color red', 'The color blue']);
});

kit.run();
