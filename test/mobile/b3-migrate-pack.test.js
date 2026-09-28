/**
 * b3-migrate-pack.test.js: the deterministic side of a migration
 * (PROTOCOL.md 4.12, 4.12.6; R08 sections 1.7, 4.2 to 4.8, 5, 6.2; decision
 * A20; critic F15; BUILD-CONTRACT 3.7.1 item 7 and 3.7.2 "Migrations").
 *
 * The indexer runs in a worker thread and streams: a synthetic 160 MB Claude
 * transcript is indexed with bounded memory, reporting progress, and a line
 * over the 16 MiB cap is counted, never parsed. On fixture transcripts of
 * both providers the index writes the layered files (timeline, every human
 * message, decisions, checkpoints labelled as claims, the newest task list
 * only, errors, commands, files, turn aligned chunks with byte offsets) and
 * skips the noise. Redaction masks every secret shaped string as
 * [redacted:kind:sha8] (the same secret keeps one marker), the standards
 * never include credentials.md, a fromMessageId cut ends the snapshot at
 * that message, the plan picks tiers S, M and L by the target's context, the
 * charter is filled with no placeholder left and carries the "Solved and
 * verified" and "Learned" sections (A20, F15), the pack tools run, the git
 * tripwire flags an edit made after the snapshot, and the report header maps
 * the charter's snake case to camelCase with coveragePercent computed by
 * Workbook.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const kit = require('./b3-kit');
const pack = require('../../src/web/mobile/workspace/migrate/pack');
const report = require('../../src/web/mobile/workspace/migrate/report');
const charter = require('../../src/web/mobile/workspace/migrate/charter');
const { redact } = require('../../src/web/mobile/workspace/migrate/redact');
const { MAX_LINE_BYTES } = require('../../src/web/mobile/workspace/migrate/indexer-worker');

const MB = 1024 * 1024;
/** Size of the synthetic large transcript. */
const LARGE_BYTES = 160 * MB;
/** Memory the indexing of that file may add to this process at most. */
const LARGE_RSS_BUDGET = 400 * MB;

const sb = kit.sandbox();
const dataDir = path.join(sb.root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

/**
 * Secret shaped fixture values, built at run time so no literal token
 * pattern sits in this source file (secret scanners read committed code).
 *
 * @returns {object}
 */
function fakeSecrets() {
  const r = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
  return {
    anthropic: 'sk-' + 'ant-api03-' + r(40),
    github: 'gh' + 'p_' + r(36),
    dbPassword: 'Pw' + r(14),
    openai: 'sk-' + 'proj-' + r(32),
    jwt: 'ey' + 'J' + r(20) + '.' + 'ey' + 'J' + r(20) + '.' + r(24),
  };
}
const S = fakeSecrets();

/**
 * Every file under a folder, recursively.
 *
 * @param {string} dir - Folder.
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

/** A Claude user record. */
const cUser = (text, extra) => Object.assign({ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: sb.work, message: { role: 'user', content: text } }, extra || {});
/** A Claude assistant record with blocks. */
const cAsst = (blocks, id) => ({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: sb.work, requestId: 'r', message: { id: id || 'msg_' + crypto.randomBytes(6).toString('hex'), role: 'assistant', model: 'claude-opus-5-5', content: blocks } });
/** A Claude tool result record. */
const cResult = (id, text, isError) => ({ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!isError }] } });

let claudeFile;
let claudeIds;

kit.test('redaction masks secret shaped strings with stable markers and leaves placeholders', () => {
  const counts = {};
  const text = 'key ' + S.anthropic + ' and ' + S.anthropic + ' token ' + S.github + ' db postgres://app:' + S.dbPassword + '@db.example.com/x OPENAI_API_KEY=' + S.openai + ' jwt ' + S.jwt + ' API_KEY=${API_KEY} PASSWORD=required';
  const out = redact(text, counts);
  for (const v of Object.values(S)) kit.ok(!out.includes(v), 'masked');
  const markers = out.match(/\[redacted:anthropic:[0-9a-f]{8}\]/g) || [];
  kit.eq(markers.length, 2);
  kit.eq(markers[0], markers[1], 'one secret, one marker, in every file');
  kit.ok(/\[redacted:github:/.test(out) && /\[redacted:dbUrl:/.test(out) && /\[redacted:jwt:/.test(out), out);
  kit.ok(out.includes('API_KEY=${API_KEY}') && out.includes('PASSWORD=required'), 'placeholders stay readable');
  kit.eq(redact(out), out, 'redacting twice changes nothing');
  kit.ok(counts.anthropic === 2 && counts.github === 1, JSON.stringify(counts));
});

kit.test('a Claude transcript indexes into the layered files, skipping the noise', async () => {
  const ask = 'toolu_ask1';
  const bash = 'toolu_bash1';
  const edit = 'toolu_edit1';
  const recs = [
    cUser('Build the pairing screen. The key is ' + S.anthropic),
    cAsst([{ type: 'text', text: 'Starting.' }, { type: 'tool_use', id: ask, name: 'AskUserQuestion', input: { questions: [{ question: 'Which layout?', options: [{ label: 'Grid' }, { label: 'List' }] }] } }]),
    cResult(ask, 'User has answered your questions: "Which layout?"="Grid".'),
    cAsst([{ type: 'tool_use', id: bash, name: 'Bash', input: { command: 'npm test' } }]),
    cResult(bash, 'FAIL 2 tests', true),
    cAsst([{ type: 'tool_use', id: edit, name: 'Edit', input: { file_path: 'C:\\work\\src\\pair.js', old_string: 'a', new_string: 'b' } }]),
    cResult(edit, 'ok'),
    { type: 'attachment', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), attachment: { type: 'task_reminder', content: [{ id: '1', subject: 'old task list' }] } },
    { type: 'file-history-snapshot', messageId: 'x', snapshot: { big: 'x'.repeat(5000) } },
    { type: 'progress', data: 'noise' },
    { type: 'system', subtype: 'turn_duration', durationMs: 1000 },
    cUser('This session is being continued from a previous conversation that ran out of context. Summary: all good', { isCompactSummary: true }),
    cUser([{ type: 'text', text: 'Now the settings page. Password is ' + S.github }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' + 'A'.repeat(4000) } }]),
    cAsst([{ type: 'text', text: 'Done with the settings page.' }]),
    { type: 'attachment', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), attachment: { type: 'task_reminder', content: [{ id: '2', subject: 'newest task list' }] } },
    { type: 'brand-new-type', note: 'drift sample' },
  ];
  claudeIds = { firstUser: recs[0].uuid, settingsAnswer: recs[13].message.id };
  claudeFile = kit.writeClaude(sb.projects, sb.work, crypto.randomUUID(), recs);
  // A line over the 16 MiB cap, appended raw (it must be counted, never parsed).
  fs.appendFileSync(claudeFile, '{"type":"user","message":{"content":"' + 'y'.repeat(MAX_LINE_BYTES + 1024) + '"}}\n');
  const snap = pack.snapshotSource(claudeFile, null);
  const entry = pack.ensureIndex({ dataDir, provider: 'claude', snap, useWorker: true });
  kit.eq(entry.state, 'building');
  const m = await entry.promise;
  kit.eq(entry.state, 'ready');
  kit.eq([m.turns, m.decisions, m.checkpoints, m.oversizeLines, m.images], [2, 1, 1, 1, 1]);
  kit.ok(m.toolErrors >= 1, 'the failed npm test is an error');
  kit.ok(m.unknownTypes && m.unknownTypes['brand-new-type'] === 1, JSON.stringify(m.unknownTypes));
  kit.eq(m.formatDrift, false, 'unknown metadata types alone never raise drift');
  const f = (n) => fs.readFileSync(path.join(entry.dir, n), 'utf8');
  kit.ok(/^T1 .*@0 "Build the pairing screen/m.test(f('timeline.md')), f('timeline.md'));
  kit.ok(/Which layout\?[\s\S]*Grid/.test(f('decisions.md')), 'the decision and the answer');
  kit.ok(/previous model's own summary/.test(f('checkpoints.md')), 'checkpoints labelled as claims');
  kit.ok(/newest task list/.test(f('last-tasks.md')) && !/old task list/.test(f('last-tasks.md')), 'only the newest task list');
  kit.ok(/npm test/.test(f('commands.tsv')), 'commands.tsv');
  kit.ok(/pair\.js\t1\t0/.test(f('files.tsv')), f('files.tsv'));
  kit.ok(/Bash: FAIL 2 tests/.test(f('errors.md')), f('errors.md'));
  kit.ok(fs.existsSync(path.join(entry.dir, 'chunks', 'c001.md')), 'L2 chunk');
  kit.ok(!f('chunks/c001.md').includes('A'.repeat(200)), 'no base64 image data');
  kit.ok(f('user-messages.md').includes('[image]'), 'images are named, not copied');
  for (const file of walk(entry.dir)) {
    const t = fs.readFileSync(file, 'utf8');
    for (const v of Object.values(S)) kit.ok(!t.includes(v), 'no secret in ' + path.basename(file));
  }
  // Reused by key: the same snapshot answers from the cache at once.
  const again = pack.ensureIndex({ dataDir, provider: 'claude', snap, useWorker: true });
  kit.eq(again.state, 'ready');
});

kit.test('a Codex rollout indexes turns, commands and compactions (not as turns)', async () => {
  const thread = crypto.randomUUID();
  const recs = kit.codexExchange('list the files').concat([
    { type: 'compacted', payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
  ]).concat(kit.codexExchange('run the tests'));
  const file = kit.writeCodex(sb.codexHome, thread, recs, { cwd: sb.work });
  const entry = pack.ensureIndex({ dataDir, provider: 'codex', snap: pack.snapshotSource(file, null), useWorker: true });
  const m = await entry.promise;
  kit.eq([m.turns, m.checkpoints], [2, 1]);
  kit.ok(/encrypted and not readable/.test(fs.readFileSync(path.join(entry.dir, 'checkpoints.md'), 'utf8')));
  kit.ok(!/environment_context/.test(fs.readFileSync(path.join(entry.dir, 'user-messages.md'), 'utf8')), 'injected context is not the user');
});

kit.test('a 160 MB transcript streams through the worker with bounded memory', async () => {
  const big = path.join(sb.root, 'big.jsonl');
  const ws = fs.createWriteStream(big);
  const filler = 'z'.repeat(64 * 1024);
  let written = 0;
  let n = 0;
  while (written < LARGE_BYTES) {
    const lines = JSON.stringify(cUser('question ' + n)) + '\n' + JSON.stringify(cAsst([{ type: 'text', text: 'answer ' + n + ' ' + filler }])) + '\n';
    written += Buffer.byteLength(lines);
    n += 1;
    if (!ws.write(lines)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((r) => ws.end(r));
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const progress = [];
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  try {
    const t0 = Date.now();
    const entry = pack.ensureIndex({ dataDir, provider: 'claude', snap: pack.snapshotSource(big, null), useWorker: true, onProgress: (p) => progress.push(p) });
    const m = await entry.promise;
    kit.eq(m.turns, n);
    kit.ok(progress.length >= 3 && progress[progress.length - 1].total === fs.statSync(big).size, 'progress from the worker: ' + progress.length);
    kit.ok(peak - rss0 < LARGE_RSS_BUDGET, 'memory grew by ' + Math.round((peak - rss0) / MB) + ' MB');
    console.log('    indexed ' + Math.round(written / MB) + ' MB in ' + (Date.now() - t0) + ' ms, peak growth ' + Math.round((peak - rss0) / MB) + ' MB');
  } finally {
    clearInterval(sampler);
    fs.rmSync(big, { force: true });
  }
});

kit.test('a fromMessageId cut ends the snapshot at the end of that message', async () => {
  const size = fs.statSync(claudeFile).size;
  const text = fs.readFileSync(claudeFile, 'utf8');
  const end = Buffer.byteLength(text.slice(0, text.indexOf('Done with the settings page.')));
  const lineEnd = Buffer.byteLength(text.slice(0, text.indexOf('\n', text.indexOf('Done with the settings page.')) + 1));
  kit.ok(end < lineEnd && lineEnd < size);
  const snap = pack.snapshotSource(claudeFile, lineEnd);
  kit.eq(snap.bytes, lineEnd);
  kit.ok(snap.tailSha !== pack.snapshotSource(claudeFile, null).tailSha, 'the tail hash covers the cut');
  kit.ok(pack.indexKey(snap) !== pack.indexKey(pack.snapshotSource(claudeFile, null)), 'a different index');
  const m = await pack.ensureIndex({ dataDir, provider: 'claude', snap, useWorker: true }).promise;
  kit.eq(m.oversizeLines, 0, 'the oversize line after the cut is not read');
  kit.eq(m.bytes, lineEnd);
});

kit.test('the plan picks tiers by the target context (R08 section 4.4)', () => {
  const chunks = (n) => Array.from({ length: n }, (_, i) => ({ file: 'chunks/c' + String(i + 1).padStart(3, '0') + '.md', fromTurn: i * 10 + 1, toTurn: i * 10 + 10 }));
  const s = pack.planFor({ chunkChars: 100000, chunks: chunks(1), targetProvider: 'claude', targetModel: 'claude-opus-5-5', depth: 'standard' });
  kit.eq([s.tier, s.ranges, s.maxReaders, s.readerModel], ['S', 1, 0, null]);
  const m = pack.planFor({ chunkChars: 2.6e6, chunks: chunks(12), targetProvider: 'claude', targetModel: 'claude-opus-5-5', depth: 'standard' });
  kit.eq([m.tier, m.ranges, m.maxReaders, m.readerModel], ['M', 12, 6, 'claude-sonnet-5']);
  const codexSame = pack.planFor({ chunkChars: 200000, chunks: chunks(1), targetProvider: 'codex', targetModel: 'gpt-6-astra', depth: 'standard' });
  kit.eq(codexSame.tier, 'M', 'the same history is tier M for a Codex lead (258,400 context)');
  const l = pack.planFor({ chunkChars: 46e6, chunks: chunks(191), targetProvider: 'claude', targetModel: 'claude-opus-5-5', depth: 'standard' });
  kit.eq([l.tier, l.ranges, l.rangeList[0].era, l.rangeList[95].era], ['L', 96, 'E1', 'E10']);
  const est = pack.estimate({ plan: m, chunkChars: 2.6e6, depth: 'standard', targetProvider: 'claude', targetModel: 'claude-opus-5-5' });
  kit.ok(est.estInputTokens.low < est.estInputTokens.high && est.estUsdListPrice.high >= 1, JSON.stringify(est));
  kit.eq(pack.needsCostConfirm('exhaustive', est), true);
  kit.eq(pack.needsCostConfirm('standard', { estUsdListPrice: { high: 50 } }), false);
  kit.eq(pack.needsCostConfirm('standard', { estUsdListPrice: { high: 101 } }), true, 'over the 100 USD rule');
});

kit.test('standards never include credentials.md and stop at the configured folder', () => {
  const home = path.join(sb.root, 'claude-home');
  const repo = path.join(sb.work, 'standards-repo', 'sub');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# Global\nNo em dashes. Token ' + S.github + '\n');
  fs.writeFileSync(path.join(home, 'credentials.md'), 'SECRET=' + S.anthropic);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Project\nTests first.\n');
  fs.writeFileSync(path.join(repo, 'credentials.md'), 'nope');
  fs.writeFileSync(path.join(path.dirname(repo), 'AGENTS.md'), '# Agents\n');
  const list = pack.collectStandards({ cwd: repo, claudeDir: home, codexHome: null, stopAt: sb.work });
  const names = list.map((x) => x.name);
  kit.ok(names.includes('global-CLAUDE.md') && names.includes('up00-CLAUDE.md') && names.includes('up01-AGENTS.md'), names.join(','));
  kit.ok(list.every((x) => !/credentials/i.test(x.from)), 'never credentials.md');
  kit.ok(!list.map((x) => x.text).join('\n').includes(S.github), 'redacted');
  const inside = (f) => path.resolve(f).toLowerCase().startsWith(path.resolve(sb.work).toLowerCase() + path.sep);
  kit.ok(list.filter((x) => x.name.startsWith('up')).every((x) => inside(x.from)), 'the upward walk stops at the configured folder');
});

kit.test('the pack: charter filled with the added sections, tools that run, focus as data', async () => {
  const entry = pack.ensureIndex({ dataDir, provider: 'claude', snap: pack.snapshotSource(claudeFile, null), useWorker: true });
  const m = await entry.promise;
  const packDir = path.join(dataDir, 'migrations', 'mg_packtest');
  const plan = pack.planFor({ chunkChars: m.chunkChars, chunks: m.chunks, targetProvider: 'claude', targetModel: 'claude-opus-5-5', depth: 'standard' });
  const focus = 'Check the pairing tests first & then the key ' + S.openai;
  const res = pack.writePack({
    packDir, indexDir: entry.dir, manifest: m, snap: pack.snapshotSource(claudeFile, null), provider: 'claude', targetProvider: 'claude',
    sourceName: 'Pairing work', rawPath: claudeFile, cwd: sb.work, focus, git: null, plan, depth: 'standard',
    standards: [{ from: 'x', name: 'global-CLAUDE.md', text: '# rules' }], subagents: { count: 0, bytes: 0 }, cutAtMessage: null,
    charterPath: path.join(packDir, 'CHARTER.md'),
  });
  kit.ok(/1 CLAUDE\.md/.test(res.detail), res.detail);
  const c = fs.readFileSync(path.join(packDir, 'CHARTER.md'), 'utf8');
  kit.ok(!/\{\{[A-Z_]+\}\}/.test(c), 'no placeholder left');
  kit.ok(c.includes('Solved and verified') && c.includes('Learned (environment facts, gotchas, dead ends, with turn ids)'), 'A20 and F15 sections');
  kit.ok(c.includes('"solved_verified": 0') && c.includes('"learned": 0'), 'counted in the JSON header');
  kit.ok(c.includes('present it with ExitPlanMode as your plan'), 'the Claude stop instruction');
  kit.ok(c.includes('MIGRATE: reading <done>/<total>'), 'the progress line');
  kit.ok(c.includes(packDir), 'the pack path');
  const focusMd = fs.readFileSync(path.join(packDir, 'FOCUS.md'), 'utf8');
  kit.ok(focusMd.includes('Check the pairing tests first & then the key') && !focusMd.includes(S.openai), 'focus is data, redacted');
  for (const n of ['manifest.json', 'ranges.json', 'READER.md', 'git.md', 'standards/INDEX.md', 'START.md', 'timeline.md', 'user-messages.md']) kit.ok(fs.existsSync(path.join(packDir, n)), n);
  const reader = fs.readFileSync(path.join(packDir, 'READER.md'), 'utf8');
  kit.ok(/Solved problems/.test(reader) && /Learned/.test(reader) && /read only/.test(reader), 'the reader brief asks for the same sections and stays read only');
  // The tools run with node from the pack, and print redacted records.
  const slice = childProcess.spawnSync(process.execPath, [path.join(packDir, 'tools', 'slice.js'), claudeFile, '0', '1'], { encoding: 'utf8' });
  kit.eq(slice.status, 0, slice.stderr);
  kit.ok(slice.stdout.includes('Build the pairing screen') && !slice.stdout.includes(S.anthropic) && slice.stdout.includes('[redacted:anthropic:'), slice.stdout.slice(0, 300));
  const find = childProcess.spawnSync(process.execPath, [path.join(packDir, 'tools', 'find.js'), 'settings page'], { encoding: 'utf8', cwd: packDir });
  kit.eq(find.status, 0, find.stderr);
  kit.ok(/T2/.test(find.stdout), find.stdout.slice(0, 300));
  // A Codex lead gets START.md with the Codex notes and its own stop instruction.
  const codexDir = path.join(dataDir, 'migrations', 'mg_packtest_codex');
  pack.writePack({
    packDir: codexDir, indexDir: entry.dir, manifest: m, snap: pack.snapshotSource(claudeFile, null), provider: 'claude', targetProvider: 'codex',
    sourceName: 'Pairing work', rawPath: claudeFile, cwd: sb.work, focus: null, git: null, plan, depth: 'standard', standards: [], subagents: { count: 0, bytes: 0 }, cutAtMessage: null,
    charterPath: path.join(codexDir, 'START.md'),
  });
  const start = fs.readFileSync(path.join(codexDir, 'START.md'), 'utf8');
  kit.ok(start.includes('Put the whole report in your final answer') && /collaboration\.spawn_agent/.test(start) && start.includes(path.join(codexDir, 'START.md')), 'Codex notes');
  kit.eq(charter.codexKickoff(path.join(codexDir, 'START.md')), 'Read ' + path.join(codexDir, 'START.md') + ' and follow it exactly.');
  kit.eq(charter.CLAUDE_KICKOFF, 'Begin the takeover described in your instructions.');
});

kit.test('coverage words follow the tier (F15)', () => {
  const s = charter.coverageWords('S', 'standard', null);
  const l = charter.coverageWords('L', 'standard', null);
  kit.ok(typeof s === 'string' && typeof l === 'string' && s !== l, s + ' | ' + l);
  kit.ok(/every turn/i.test(charter.tierWords('S', 'standard')), charter.tierWords('S', 'standard'));
});

kit.test('the git tripwire flags an edit made after the snapshot', async () => {
  const repo = path.join(sb.work, 'trip');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => childProcess.spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (git(['--version']).status !== 0) { console.log('    git missing, tripwire skipped'); return; }
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(['add', 'a.txt']);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  const before = await pack.gitState(repo, null);
  kit.ok(before && before.head && before.dirty === 0, JSON.stringify(before && before.status));
  kit.eq(await pack.tripwire(repo, before), { changed: false, diffStat: null });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'made during review\n');
  const trip = await pack.tripwire(repo, before);
  kit.eq(trip, { changed: true, diffStat: { added: 2, removed: 1, files: 2 } });
  kit.eq(await pack.tripwire(path.join(sb.root, 'not-a-repo'), null), { changed: false, diffStat: null });
});

kit.test('the report header maps snake case to camelCase; coveragePercent is Workbook\'s', () => {
  const md = '```json\n{"takeover_report": 1, "verdict": "The pairing work holds.", "claims_checked": 14, "claims_held": 11, "claims_failed": 2, "claims_unverifiable": 1, "suspected_mistakes": 3, "open_issues": 5, "solved_verified": 6, "learned": 4, "coverage": "all turns via readers", "confidence": "Medium"}\n```\n\n# Takeover report\n';
  const h = report.mapHeader(report.findHeader(md), md, 'fallback');
  kit.eq(h, { takeoverReport: 1, verdict: 'The pairing work holds.', claimsChecked: 14, claimsHeld: 11, claimsFailed: 2, claimsUnverifiable: 1, suspectedMistakes: 3, openIssues: 5, solvedVerified: 6, learned: 4, coverage: 'all turns via readers', confidence: 'medium' });
  kit.validate(h, 'migrate/report-header.json');
  // A header without the two counts: they are counted from the sections.
  const md2 = '{"takeover_report": 1, "verdict": "x", "claims_checked": 1, "confidence": "sure"}\n\n## 4. Solved and verified\n- one\n- two\n\n## 5. Learned\n- a fact (T3)\n\n## 6. Open issues\n- x\n';
  const h2 = report.mapHeader(report.findHeader(md2), md2, 'fallback words');
  kit.eq([h2.solvedVerified, h2.learned, h2.confidence, h2.coverage], [2, 1, 'low', 'fallback words']);
  kit.eq(report.coveragePercent('S', { done: 0, total: 1 }), 100);
  kit.eq(report.coveragePercent('M', { done: 34, total: 96 }), 35);
  kit.eq(report.coveragePercent('L', { done: 0, total: 96 }), 0);
});

kit.run();
