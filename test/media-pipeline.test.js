#!/usr/bin/env node
/**
 * media-pipeline.test.js - the hermetic half of the marketing media pipeline.
 * Created: 2026-08-18, media pipeline (docs/marketing/MEDIA-CONTRACT.md).
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
 *
 * The pipeline's expensive half drives a browser and shells out to ffmpeg. None
 * of that belongs in `npm test`: it takes minutes, needs Chromium on disk, and
 * would put a server and a PTY inside a unit run. So this file tests the parts
 * that are pure, and it tests them properly:
 *
 *   1. THE FIXTURE'S INVARIANTS. Everything the footage shows is invented, and
 *      the one way that can go wrong quietly is a real path, a real name or a
 *      real cost leaking into a frame that ends up in a public README. Those are
 *      assertions, not a review checklist.
 *   2. THE FORBIDDEN CODEX DEFAULT SET. The detail strip used to invent
 *      `gpt-5-codex / workspace-write / on-request / medium` when a thread
 *      carried no stored value. Seeing those four together in a frame means the
 *      fixture failed to populate state_5.sqlite and the footage is filming a
 *      placeholder. The contract forbids it; this makes the ban executable.
 *   3. DETERMINISM. buildFixture(now) must be a pure function of `now`, because
 *      that is what makes two shoots comparable after a UI change.
 *   4. THE ENCODE ARGUMENT BUILDERS, against the contract's own numbers, plus
 *      the five silent ffmpeg failures the research catalogues. Every one of
 *      them exits 0 and produces a plausible-looking file, so a builder that
 *      drops `-loop 0` or `-pix_fmt yuv420p` has to fail HERE.
 *   5. THE PLAYER'S GLYPH REPERTOIRE, MEASURED. A character the terminal face
 *      does not map is drawn by a fallback at a different advance width inside
 *      a cell grid, and every row containing it drifts. The woff2 cmap reader is
 *      borrowed from test/terminal-font-coverage.test.js, which exists because
 *      that bug shipped once already.
 *   6. THE CLAUDE PROJECTS DIRECTORY OVERRIDE added for this pipeline, in both
 *      directions: honoured when set, and byte-identical to the old behaviour
 *      when it is not.
 *
 * Nothing here launches a browser, spawns a server, reads a real profile or
 * writes outside a temporary directory it created.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const fixture = require('../scripts/media/fixture');
const player = require('../scripts/media/fake-agent');
const encode = require('../scripts/media/encode');
const capture = require('../scripts/media/capture');
const pathDecode = require('../src/providers/claude/path-decode');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FONT_DIR = path.join(PROJECT_ROOT, 'src', 'web', 'public', 'design', 'notion', 'fonts');

/** A fixed instant, so every determinism assertion has something to pin to. */
const FIXED_NOW = Date.parse('2026-08-18T12:00:00.000Z');

/** Prefix for any temporary directory this file creates. */
const TEMP_PREFIX = 'myrlin-media-test-';

let passed = 0;
let failed = 0;

/**
 * Run one named assertion.
 *
 * @param {string} name - Human-readable test name.
 * @param {Function} fn - Body that throws on failure.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('    \x1b[32m+\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('    \x1b[31mx\x1b[0m ' + name);
    console.log('      \x1b[31m' + err.message + '\x1b[0m');
  }
}

/**
 * Start a named group in the output.
 *
 * @param {string} name - Group name.
 * @returns {void}
 */
function section(name) {
  console.log('\n  \x1b[1m' + name + '\x1b[0m');
}

/* ═══════════════════════════════════════════════════════════════
   1. Fixture invariants
   ═══════════════════════════════════════════════════════════════ */

section('media fixture: everything on screen is invented');

/**
 * Every string the fixture can put on screen, flattened.
 *
 * Built by walking the whole descriptor rather than by listing the fields that
 * matter, because the failure this guards against is a NEW field carrying a
 * real path that nobody thought to add to a list.
 *
 * @param {*} value - Any value from the descriptor.
 * @param {string[]} [into] - Accumulator.
 * @returns {string[]} Every string found, in traversal order.
 */
function allStrings(value, into) {
  const out = into || [];
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) allStrings(value[key], out);
  return out;
}

const built = fixture.buildFixture({ now: FIXED_NOW });
const everyString = allStrings(built);

check('no real user profile path appears anywhere in the fixture', () => {
  // PATH-SHAPED occurrences only. An earlier, blunter version of this check
  // matched the bare word "Desktop" and failed on `"originator":"Codex Desktop"`,
  // which is the real value the Codex CLI writes into a rollout's session_meta
  // and has nothing to do with anybody's home directory. Requiring a separator
  // on both sides is what makes the check about paths rather than about words.
  const forbidden = [
    'C:\\Users\\', 'C:/Users/',
    '\\AppData\\', '/AppData/',
    '\\Desktop\\', '/Desktop/',
    '/home/',
  ];
  for (const needle of forbidden) {
    const hit = everyString.find((s) => s.indexOf(needle) !== -1);
    assert.ok(!hit, 'fixture string contains ' + JSON.stringify(needle) + ': ' + JSON.stringify(hit));
  }
});

check('the operator running the build is not named anywhere in the fixture', () => {
  // The check that catches a leak this suite's author could not have anticipated,
  // because it is derived from the machine rather than from a list: whatever the
  // account is called here, it must not be in a frame destined for a public
  // README. Skipped only when the platform reports no usable user name.
  let username = '';
  try { username = String((os.userInfo() || {}).username || ''); } catch (_) { username = ''; }
  if (username.length < 3) return;
  const lowered = username.toLowerCase();
  const hit = everyString.find((s) => s.toLowerCase().indexOf(lowered) !== -1);
  assert.ok(!hit, 'fixture string contains the build account name: ' + JSON.stringify(hit));
});

check('every project path sits under the invented work root', () => {
  for (const project of fixture.PROJECTS) {
    assert.ok(
      project.cwd.startsWith(fixture.WORK_ROOT),
      project.id + ' cwd escaped the invented root: ' + project.cwd
    );
  }
});

check('the invented work root is a Windows path with backslashes', () => {
  // Not cosmetic. The sidebar takes a project's short name with
  // realPath.split('\\').pop(), so a forward-slashed path renders every Claude
  // row as the whole path while the Codex rows render as a folder name.
  assert.ok(/^[A-Z]:\\/.test(fixture.WORK_ROOT), 'work root is not a Windows path: ' + fixture.WORK_ROOT);
});

check('both providers are represented, with the contract session counts', () => {
  const perProject = {};
  for (const spec of fixture.CLAUDE_SESSIONS) {
    perProject[spec.project] = (perProject[spec.project] || 0) + 1;
  }
  for (const spec of fixture.CODEX_SESSIONS) {
    perProject[spec.project] = (perProject[spec.project] || 0) + 1;
  }
  // The contract: storefront-api 6 Claude, mobile-app 4 Codex, docs-site 3
  // mixed, infra 2 Claude.
  assert.strictEqual(perProject['storefront-api'], 6, 'storefront-api session count');
  assert.strictEqual(perProject['mobile-app'], 4, 'mobile-app session count');
  assert.strictEqual(perProject['docs-site'], 3, 'docs-site session count');
  assert.strictEqual(perProject.infra, 2, 'infra session count');
  assert.ok(fixture.CLAUDE_SESSIONS.length > 0, 'no Claude sessions');
  assert.ok(fixture.CODEX_SESSIONS.length > 0, 'no Codex sessions');
});

check('docs-site is genuinely mixed, one project with both providers', () => {
  const claude = fixture.CLAUDE_SESSIONS.filter((s) => s.project === 'docs-site').length;
  const codex = fixture.CODEX_SESSIONS.filter((s) => s.project === 'docs-site').length;
  assert.ok(claude > 0 && codex > 0, 'docs-site carries only one provider: ' + claude + ' Claude, ' + codex + ' Codex');
});

check('the recent list opens with both providers inside the last hour', () => {
  const withinAnHour = (spec) => spec.ageMs < fixture.HOUR_MS;
  assert.ok(fixture.CLAUDE_SESSIONS.some(withinAnHour), 'no Claude session inside the last hour');
  assert.ok(fixture.CODEX_SESSIONS.some(withinAnHour), 'no Codex session inside the last hour');
});

check('costs are small, realistic numbers rather than round ones', () => {
  // The cost worker multiplies token counts by a per-million rate, so the guard
  // is on the counts: a round number of tokens produces a round number of
  // dollars, which reads as fabricated even though everything here is.
  for (const spec of fixture.CLAUDE_SESSIONS) {
    assert.ok(spec.inTok > 0 && spec.outTok > 0, spec.id + ' has no token counts');
    assert.notStrictEqual(spec.inTok % 10000, 0, spec.id + ' input tokens are a round 10k: ' + spec.inTok);
  }
});

section('media fixture: the Codex detail strip');

check('the strip shows exactly what the contract pins', () => {
  assert.deepStrictEqual(
    {
      model: fixture.CODEX_STRIP.model,
      reasoningEffort: fixture.CODEX_STRIP.reasoningEffort,
      approvalMode: fixture.CODEX_STRIP.approvalMode,
      sandboxPolicy: fixture.CODEX_STRIP.sandboxPolicy,
    },
    { model: 'gpt-5.5', reasoningEffort: 'high', approvalMode: 'on-request', sandboxPolicy: 'workspace-write' }
  );
});

check('the pinned strip is the FIRST Codex session, which is the one filmed', () => {
  const first = fixture.CODEX_SESSIONS[0];
  assert.strictEqual(first.model, fixture.CODEX_STRIP.model);
  assert.strictEqual(first.reasoningEffort, fixture.CODEX_STRIP.reasoningEffort);
  assert.strictEqual(first.approvalMode, fixture.CODEX_STRIP.approvalMode);
  assert.strictEqual(first.sandboxPolicy, fixture.CODEX_STRIP.sandboxPolicy);
});

check('no Codex session carries the four legacy invented defaults as a SET', () => {
  // The ban is on the SET, not on each literal: `workspace-write` and
  // `on-request` are both real values a thread can genuinely be running, and
  // the contract itself pins them. What can never happen is all four together,
  // because that combination is the placeholder the strip used to invent.
  const [model, sandbox, approval, effort] = fixture.FORBIDDEN_DEFAULT_SET;
  for (const spec of fixture.CODEX_SESSIONS) {
    const isTheSet = spec.model === model
      && spec.sandboxPolicy === sandbox
      && spec.approvalMode === approval
      && spec.reasoningEffort === effort;
    assert.ok(!isTheSet, spec.id + ' reproduces the retired default set');
  }
});

check('the retired model literal appears nowhere in the fixture at all', () => {
  // `gpt-5-codex` never occurred in any real thread on the machine that
  // reported the bug, so its presence anywhere would be a placeholder.
  const hit = everyString.find((s) => s.indexOf('gpt-5-codex') !== -1);
  assert.ok(!hit, 'fixture mentions gpt-5-codex: ' + JSON.stringify(hit));
});

check('every rollout carries its own model, effort, approval and sandbox', () => {
  for (const entry of built.codex) {
    const turnLine = entry.jsonl.split('\n').map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).find((p) => p && p.type === 'turn_context');
    assert.ok(turnLine, entry.spec.id + ' has no turn_context line');
    assert.strictEqual(turnLine.payload.model, entry.spec.model);
    assert.strictEqual(turnLine.payload.reasoning_effort, entry.spec.reasoningEffort);
    assert.strictEqual(turnLine.payload.approval_policy, entry.spec.approvalMode);
    assert.strictEqual(turnLine.payload.sandbox_policy.type, entry.spec.sandboxPolicy);
  }
});

section('media fixture: determinism');

check('buildFixture is a pure function of `now`', () => {
  const a = JSON.stringify(fixture.buildFixture({ now: FIXED_NOW }));
  const b = JSON.stringify(fixture.buildFixture({ now: FIXED_NOW }));
  assert.strictEqual(a, b, 'two builds at the same instant differ');
});

check('timestamps are fixed OFFSETS from `now`, not fixed instants', () => {
  const later = fixture.buildFixture({ now: FIXED_NOW + fixture.DAY_MS });
  const first = built.claude[0];
  const firstLater = later.claude[0];
  assert.strictEqual(
    firstLater.mtimeMs - first.mtimeMs,
    fixture.DAY_MS,
    'a session did not move with `now`, so the recent list would go stale'
  );
});

check('every transcript is valid JSONL with a cwd on its first line', () => {
  for (const entry of built.claude) {
    const lines = entry.jsonl.trim().split('\n');
    assert.ok(lines.length >= 3, entry.spec.id + ' transcript is too short');
    const first = JSON.parse(lines[0]);
    assert.strictEqual(first.cwd, entry.project.cwd, entry.spec.id + ' first line carries no cwd');
    for (const line of lines) JSON.parse(line);
  }
});

check('every transcript ends with the custom-title line the sidebar reads', () => {
  for (const entry of built.claude) {
    const lines = entry.jsonl.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.type, 'custom-title', entry.spec.id + ' has no trailing custom title');
    assert.strictEqual(last.customTitle, entry.spec.title);
  }
});

check('every assistant line carries the usage fields the cost worker reads', () => {
  for (const entry of built.claude) {
    const assistants = entry.jsonl.trim().split('\n')
      .map((l) => JSON.parse(l))
      .filter((p) => p.type === 'assistant');
    assert.ok(assistants.length > 0, entry.spec.id + ' has no assistant lines');
    for (const line of assistants) {
      const usage = line.message && line.message.usage;
      assert.ok(usage, entry.spec.id + ' assistant line has no usage');
      for (const field of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        assert.strictEqual(typeof usage[field], 'number', entry.spec.id + ' usage.' + field + ' is not a number');
      }
      assert.strictEqual(typeof line.message.model, 'string', entry.spec.id + ' assistant line has no model');
    }
  }
});

check('every rollout file name matches the pattern discovery accepts', () => {
  // src/providers/codex/discover.js extractIdFromFilename, verbatim.
  const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  for (const entry of built.codex) {
    const match = ROLLOUT.exec(entry.fileName);
    assert.ok(match, entry.fileName + ' would not be found by Codex discovery');
    assert.strictEqual(match[1], entry.spec.id, entry.fileName + ' carries the wrong id');
  }
});

check('the store seeds the credential switcher into a state that cannot refresh', () => {
  const settings = built.store.settings.credentialSwitcher;
  assert.strictEqual(settings.proactiveRefreshMinutes, 0, 'the proactive refresh sweep is not disabled');
  assert.strictEqual(settings.externalBridgeOwner, true, 'the external bridge owner flag is not set');
});

check('the board is seeded across every column so it films as a board', () => {
  const tasks = Object.values(built.store.worktreeTasks || {});
  assert.ok(tasks.length >= 5, 'not enough agent tasks to fill a board: ' + tasks.length);
  const statuses = new Set(tasks.map((t) => t.status));
  for (const column of ['backlog', 'planning', 'running', 'review', 'completed']) {
    assert.ok(statuses.has(column), 'no task in the ' + column + ' column');
  }
});

check('no agent task carries a worktree path, so no capture spawns git', () => {
  // GET /api/worktree-tasks shells out to `git rev-list` and `git diff` once per
  // task that has a worktree path. A shoot must stay hermetic.
  for (const task of Object.values(built.store.worktreeTasks || {})) {
    assert.strictEqual(task.worktreePath, null, task.id + ' would make the capture spawn git');
  }
});

/* ═══════════════════════════════════════════════════════════════
   2. Encode argument builders and the budget table
   ═══════════════════════════════════════════════════════════════ */

section('encode: the arguments, against the contract');

check('every animated WebP command carries -loop 0', () => {
  // The single most important gotcha in the research: `-loop` is a WebP MUXER
  // option and its default is 1, meaning play once and stop. A file without it
  // looks correct locally and broken on GitHub.
  const args = encode.buildWebpAnimArgs({
    input: 'in.webm', output: 'out.webp', fps: 12, width: 900, quality: 66, preset: 'text',
  });
  const loopAt = args.indexOf('-loop');
  assert.ok(loopAt !== -1, 'no -loop flag: the file will play once and stop');
  assert.strictEqual(args[loopAt + 1], '0', '-loop is not 0');
});

check('every animated WebP command uses the animated encoder, never the still one', () => {
  const args = encode.buildWebpAnimArgs({
    input: 'in.webm', output: 'out.webp', fps: 10, width: 900, quality: 68, preset: 'picture',
  });
  const codecAt = args.indexOf('-c:v');
  assert.strictEqual(args[codecAt + 1], 'libwebp_anim', 'the still encoder would write one frame and exit 0');
});

check('no command ever passes -lossless', () => {
  // Measured 10,772,346 bytes against 1,555,066 lossy on the same clip.
  const args = encode.buildWebpAnimArgs({
    input: 'in.webm', output: 'out.webp', fps: 12, width: 900, quality: 66, preset: 'text',
  });
  assert.strictEqual(args.indexOf('-lossless'), -1, '-lossless is a 6.9x size trap');
});

check('every scale filter uses :-2, never :-1', () => {
  // scale=-1 fails outright on odd dimensions.
  const commands = [
    encode.buildWebpAnimArgs({ input: 'i', output: 'o.webp', fps: 12, width: 900, quality: 66, preset: 'text' }),
    encode.buildMp4Args({ input: 'i', output: 'o.mp4', width: 1440, crf: 30 }),
    encode.buildPosterArgs({ input: 'i', output: 'o.webp', width: 900, atSeconds: 1 }),
  ];
  for (const args of commands) {
    const filter = args[args.indexOf('-vf') + 1];
    assert.ok(filter.indexOf('scale=') !== -1, 'no scale filter in ' + filter);
    assert.strictEqual(filter.indexOf('scale=-1'), -1, 'scale=-1 fails on odd dimensions: ' + filter);
    assert.ok(/scale=\d+:-2/.test(filter), 'scale is not W:-2: ' + filter);
  }
});

check('every H.264 command carries -pix_fmt yuv420p', () => {
  // From RGB input with no flag ffmpeg picks yuv444p, which is High 4:4:4
  // Predictive: it plays in Chrome and fails in QuickTime and Safari.
  const args = encode.buildMp4Args({ input: 'in.webm', output: 'out.mp4', width: 1440, crf: 30 });
  const at = args.indexOf('-pix_fmt');
  assert.ok(at !== -1, 'no -pix_fmt: ffmpeg will pick yuv444p and the file will not play in Safari');
  assert.strictEqual(args[at + 1], 'yuv420p');
});

check('every H.264 command asks for faststart and no audio', () => {
  const args = encode.buildMp4Args({ input: 'in.webm', output: 'out.mp4', width: 1440, crf: 30 });
  const at = args.indexOf('-movflags');
  assert.ok(at !== -1 && args[at + 1] === '+faststart', 'no +faststart: the file cannot stream');
  assert.ok(args.indexOf('-an') !== -1, 'the click-through is specified as silent');
});

check('the poster seeks BEFORE the input, and uses the still encoder', () => {
  const args = encode.buildPosterArgs({ input: 'in.webm', output: 'out.webp', width: 900, atSeconds: 0.5 });
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), '-ss after -i is a slow decode-and-discard seek');
  assert.strictEqual(args[args.indexOf('-c:v') + 1], 'libwebp', 'the poster is a still, not an animation');
});

check('the frame rate reaches the command exactly as the contract states it', () => {
  const args = encode.buildWebpAnimArgs({
    input: 'i', output: 'o.webp', fps: 8, width: 900, quality: 62, preset: 'text',
  });
  const filter = args[args.indexOf('-vf') + 1];
  assert.ok(filter.startsWith('fps=8,'), 'frame rate is not first in the filter chain: ' + filter);
});

section('encode: the budget table matches the contract');

/**
 * The contract's own numbers, transcribed from docs/marketing/MEDIA-CONTRACT.md.
 *
 * Written out here rather than read from the ASSETS table, because a test that
 * reads the same source it is checking proves nothing. If the contract changes,
 * BOTH this table and encode.js have to change, which is the point.
 */
const CONTRACT = Object.freeze({
  'hero.webp': { fps: 10, width: 900, maxKB: 2560 },
  'hero.mp4': { width: 1440, maxKB: 3277 },
  'hero-poster.webp': { width: 900, maxKB: 60 },
  'feature-sidebar.webp': { fps: 12, width: 900, maxKB: 500 },
  'feature-terminal.webp': { fps: 12, width: 900, maxKB: 500 },
  'feature-codex.webp': { fps: 12, width: 900, maxKB: 500 },
  'feature-phone.webp': { fps: 12, width: 390, maxKB: 350 },
  'feature-themes.webp': { fps: 8, width: 900, maxKB: 600 },
  'feature-board.webp': { fps: 12, width: 900, maxKB: 500 },
  'still-desktop-dark.png': { width: 1440, maxKB: 600 },
  'still-desktop-light.png': { width: 1440, maxKB: 600 },
  'still-phone.png': { width: 780, maxKB: 250 },
});

check('every contract asset has an encoder entry, and no entry is invented', () => {
  const declared = new Set();
  for (const asset of encode.ASSETS) for (const output of asset.outputs) declared.add(output.file);
  for (const file of Object.keys(CONTRACT)) {
    assert.ok(declared.has(file), 'the contract names ' + file + ' and the encoder does not produce it');
  }
  for (const file of declared) {
    assert.ok(CONTRACT[file], 'the encoder produces ' + file + ', which the contract does not name');
  }
});

check('every encoder entry uses the contract frame rate, width and budget', () => {
  for (const asset of encode.ASSETS) {
    for (const output of asset.outputs) {
      const want = CONTRACT[output.file];
      assert.strictEqual(output.width, want.width, output.file + ' width');
      assert.strictEqual(
        Math.round(output.maxBytes / encode.KB), want.maxKB,
        output.file + ' budget'
      );
      if (want.fps !== undefined) assert.strictEqual(output.fps, want.fps, output.file + ' frame rate');
    }
  }
});

check('the themes clip runs slower than the rest, because its deltas are larger', () => {
  const themes = encode.ASSETS.find((a) => a.name === 'feature-themes').outputs[0];
  const sidebar = encode.ASSETS.find((a) => a.name === 'feature-sidebar').outputs[0];
  assert.ok(themes.fps < sidebar.fps, 'a palette swap repaints most of the frame; it needs the lower rate');
});

check('the total committed budget stays under the repository ceiling', () => {
  // The contract's own ceiling for the committed set is 15 MB, and the research
  // recommends keeping the README's inline media under 6 MB.
  let total = 0;
  for (const asset of encode.ASSETS) for (const output of asset.outputs) total += output.maxBytes;
  assert.ok(total < 15 * encode.MB, 'the budgets sum to ' + encode.human(total) + ', over the 15 MB ceiling');
});

check('the quality search can only ever walk downwards, and has a floor', () => {
  assert.ok(encode.QUALITY_STEP > 0, 'a non-positive step would loop forever');
  assert.ok(encode.QUALITY_FLOOR > 0 && encode.QUALITY_FLOOR < 100, 'the floor is not a quality');
  for (const asset of encode.ASSETS) {
    for (const output of asset.outputs) {
      if (output.kind !== 'webp-anim') continue;
      assert.ok(
        output.quality > encode.QUALITY_FLOOR,
        output.file + ' starts at or below the search floor, so the search cannot run'
      );
    }
  }
});

check('the WebP container inspector reads a real file correctly', () => {
  // Round trip on a byte pattern rather than on a real encode, so the test needs
  // no ffmpeg: a minimal RIFF/WEBP with one ANIM and two ANMF chunks.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    const anim = Buffer.alloc(8 + 6);
    anim.write('ANIM', 0, 'ascii');
    anim.writeUInt32LE(6, 4);
    anim.writeUInt32LE(0, 8);         // background colour
    anim.writeUInt16LE(0, 12);        // loop count: 0 means forever
    const frame = () => {
      const b = Buffer.alloc(8 + 16);
      b.write('ANMF', 0, 'ascii');
      b.writeUInt32LE(16, 4);
      b.writeUIntLE(100, 8 + 12, 3);  // 100 ms
      return b;
    };
    const body = Buffer.concat([Buffer.from('WEBPVP8X'), Buffer.alloc(4), anim, frame(), frame()]);
    const file = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), body]);
    file.writeUInt32LE(body.length, 4);
    const target = path.join(dir, 'probe.webp');
    fs.writeFileSync(target, file);

    const info = encode.inspectWebp(target);
    assert.strictEqual(info.animated, true, 'ANIM chunk not found');
    assert.strictEqual(info.loop, 0, 'loop count misread');
    assert.strictEqual(info.frames, 2, 'frame count misread');
    assert.strictEqual(info.durationMs, 200, 'summed frame delays misread');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ═══════════════════════════════════════════════════════════════
   3. The player's glyph repertoire, measured
   ═══════════════════════════════════════════════════════════════ */

section('fake agent: the player cannot tear the terminal grid');

// The woff2 known-tag table, in specification order, and the two readers below
// are lifted from test/terminal-font-coverage.test.js. That file exists because
// a face that maps none of the box-drawing block shipped as the FIRST family in
// --font-terminal and every framed row in the Codex TUI drifted. This file's job
// is to make sure the marketing player can never reproduce that.
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

/**
 * Read a woff2 UIntBase128 value.
 *
 * @param {Buffer} buf - The font file.
 * @param {{p: number}} posRef - Cursor, advanced in place.
 * @returns {number} The decoded value.
 */
function readBase128(buf, posRef) {
  let accum = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[posRef.p++];
    accum = (accum << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return accum;
  }
  throw new Error('malformed UIntBase128 in woff2 table directory');
}

/**
 * Locate and decompress the cmap table of a woff2 file.
 *
 * woff2 compresses every table as one brotli stream, concatenated in table
 * directory order, so summing the preceding tables' lengths lands exactly on
 * cmap. No font library is needed, which keeps the suite dependency free.
 *
 * @param {string} file - Absolute path to a .woff2 file.
 * @returns {{data: Buffer, offset: number}} Decompressed stream and cmap offset.
 */
function readCmapTable(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.toString('latin1', 0, 4), 'wOF2', file + ' is not a woff2 file');
  const numTables = buf.readUInt16BE(12);
  const posRef = { p: 48 };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[posRef.p++];
    const tagIdx = flags & 0x3f;
    let tag;
    if (tagIdx === 63) {
      tag = buf.toString('latin1', posRef.p, posRef.p + 4);
      posRef.p += 4;
    } else {
      tag = KNOWN_TAGS[tagIdx];
    }
    const transform = (flags >> 6) & 0x03;
    const origLength = readBase128(buf, posRef);
    const transformed = (tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0;
    const length = transformed ? readBase128(buf, posRef) : origLength;
    tables.push({ tag, length });
  }
  const data = zlib.brotliDecompressSync(buf.slice(posRef.p));
  let offset = 0;
  for (const t of tables) {
    if (t.tag === 'cmap') return { data, offset };
    offset += t.length;
  }
  throw new Error('no cmap table in ' + file);
}

/**
 * The set of code points a face maps, within a range.
 *
 * @param {string} file - Absolute path to a .woff2 file.
 * @param {number} lo - Inclusive range start.
 * @param {number} hi - Inclusive range end.
 * @returns {Set<number>} Mapped code points.
 */
function mappedCodePoints(file, lo, hi) {
  const { data, offset } = readCmapTable(file);
  const numSubtables = data.readUInt16BE(offset + 2);
  const seen = new Set();
  for (let i = 0; i < numSubtables; i++) {
    const rec = offset + 4 + i * 8;
    const sub = offset + data.readUInt32BE(rec + 4);
    const format = data.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = data.readUInt16BE(sub + 6);
      const segments = segX2 / 2;
      const endBase = sub + 14;
      const startBase = endBase + segX2 + 2;
      const deltaBase = startBase + segX2;
      const rangeBase = deltaBase + segX2;
      for (let s = 0; s < segments; s++) {
        const end = data.readUInt16BE(endBase + s * 2);
        const start = data.readUInt16BE(startBase + s * 2);
        const delta = data.readInt16BE(deltaBase + s * 2);
        const rangeOff = data.readUInt16BE(rangeBase + s * 2);
        if (start === 0xffff) continue;
        for (let c = Math.max(start, lo); c <= Math.min(end, hi); c++) {
          let gid;
          if (rangeOff === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const gidx = rangeBase + s * 2 + rangeOff + (c - start) * 2;
            if (gidx + 1 >= data.length) continue;
            gid = data.readUInt16BE(gidx);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) seen.add(c);
        }
      }
    } else if (format === 12) {
      const groups = data.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const go = sub + 16 + g * 12;
        const start = data.readUInt32BE(go);
        const end = data.readUInt32BE(go + 4);
        for (let c = Math.max(start, lo); c <= Math.min(end, hi); c++) seen.add(c);
      }
    }
  }
  return seen;
}

/**
 * Every code point the player emits, across every story it can run.
 *
 * @returns {Set<number>} Emitted code points, escapes and newlines excluded.
 */
function emittedCodePoints() {
  const seen = new Set();
  for (const variant of Object.keys(player.VARIANTS)) {
    for (const ch of player.renderPlain(variant)) {
      const code = ch.codePointAt(0);
      if (code === 0x0a || code === 0x0d) continue;
      seen.add(code);
    }
  }
  return seen;
}

const emitted = emittedCodePoints();

check('the player emits nothing outside its declared repertoire', () => {
  const allowed = new Set(player.REPERTOIRE.extra);
  for (const code of emitted) {
    const isAscii = code >= player.REPERTOIRE.asciiLow && code <= player.REPERTOIRE.asciiHigh;
    assert.ok(
      isAscii || allowed.has(code),
      'the player emits U+' + code.toString(16).toUpperCase() + ', which is outside REPERTOIRE'
    );
  }
});

check('the repertoire excludes every range a mono face commonly misses', () => {
  // Block elements and braille are the two ranges test/terminal-font-coverage
  // measured at 0/32 and 0/256 on the vendored face. Emoji and anything astral
  // are wider than one cell by definition, so they tear a grid even when mapped.
  const banned = [
    { label: 'block elements', lo: 0x2580, hi: 0x259f },
    { label: 'braille patterns', lo: 0x2800, hi: 0x28ff },
    { label: 'heavy and double box drawing', lo: 0x2550, hi: 0x257f },
    { label: 'astral plane', lo: 0x10000, hi: 0x10ffff },
  ];
  for (const code of emitted) {
    for (const range of banned) {
      assert.ok(
        code < range.lo || code > range.hi,
        'the player emits U+' + code.toString(16).toUpperCase() + ' from ' + range.label
      );
    }
  }
});

check('the non-ASCII repertoire is the light box-drawing set and nothing else', () => {
  const LIGHT_BOX = new Set([0x2500, 0x2502, 0x250c, 0x2510, 0x2514, 0x2518, 0x251c, 0x2524]);
  for (const code of player.REPERTOIRE.extra) {
    assert.ok(LIGHT_BOX.has(code), 'U+' + code.toString(16).toUpperCase() + ' is not in the light box set');
  }
});

check('the vendored terminal face maps every ASCII character the player uses', () => {
  // The one coverage claim that can be MEASURED on any machine that can run this
  // repository, because iA Writer Mono S is vendored into the tree. The light
  // box set is supplied by the OS mono faces the --font-terminal chain leads
  // with (Cascadia Mono, Cascadia Code, Consolas on Windows), which is why the
  // repertoire is capped at those eight characters rather than measured here.
  const face = path.join(FONT_DIR, 'iAWriterMonoS-Regular.woff2');
  if (!fs.existsSync(face)) {
    throw new Error('the vendored terminal face is missing: ' + face);
  }
  const mapped = mappedCodePoints(face, 0x20, 0x7e);
  const missing = [];
  for (const code of emitted) {
    if (code > 0x7e) continue;
    if (!mapped.has(code)) missing.push('U+' + code.toString(16).toUpperCase());
  }
  assert.deepStrictEqual(missing, [], 'the vendored face does not map: ' + missing.join(', '));
});

check('the player prints enough rows for the scrollback the terminal clip needs', () => {
  assert.ok(
    player.lineCount('checkout') >= player.SCROLLBACK_FLOOR,
    'the long story emits ' + player.lineCount('checkout') + ' rows, below the ' +
    player.SCROLLBACK_FLOOR + ' row floor: the wheel gesture would hit the top of the buffer'
  );
});

check('the second story is shorter, so two panes never read as one repeated pane', () => {
  assert.ok(
    player.lineCount('push') < player.lineCount('checkout'),
    'both stories are the same length'
  );
  const a = player.renderPlain('checkout');
  const b = player.renderPlain('push');
  assert.notStrictEqual(a, b, 'the two stories are identical, so a two pane frame reads as a bug');
});

check('the player colours with the 16 colour palette, never with truecolor', () => {
  // Every colour on screen has to come from the ACTIVE TERMINAL PALETTE, or the
  // themes clip, whose whole subject is swapping that palette, shows nothing.
  const coloured = player.buildTurn({ colour: true }).map((c) => c.text).join('');
  assert.strictEqual(coloured.indexOf('[38;2;'), -1, 'a truecolor foreground escape would pin one palette');
  assert.strictEqual(coloured.indexOf('[38;5;'), -1, 'a 256 colour escape would pin one palette');
});

check('every line fits a pane without wrapping', () => {
  // The history surface wraps on CSS pixels a cell or two earlier than xterm
  // does, so a line at the terminal's exact width renders correctly live and
  // wraps the moment it is read back through the scrollback document.
  const MAX_COLUMNS = 80;
  for (const variant of Object.keys(player.VARIANTS)) {
    for (const line of player.renderPlain(variant).split('\n')) {
      const width = line.replace(/\r/g, '').length;
      assert.ok(width <= MAX_COLUMNS, variant + ' emits a ' + width + ' column line: ' + JSON.stringify(line));
    }
  }
});

check('the speed multiplier is clamped, so a typo cannot stall or flatten a shoot', () => {
  assert.strictEqual(player.clampSpeed(1), 1);
  assert.strictEqual(player.clampSpeed(0.22), 0.22);
  assert.strictEqual(player.clampSpeed(0), 1, 'zero would divide the pacing away');
  assert.strictEqual(player.clampSpeed(-3), 1, 'a negative speed is not a speed');
  assert.strictEqual(player.clampSpeed('nonsense'), 1, 'a non-number means "as authored"');
  assert.strictEqual(player.clampSpeed(1e6), player.SPEED_MAX, 'an unbounded speed would stall a shoot');
  assert.strictEqual(player.clampSpeed(1e-9), player.SPEED_MIN, 'an unbounded slowdown would stall a shoot');
});

check('the player never prints a bare double hyphen or an em dash', () => {
  // Two rules meet here. The project bans both in any output, and gate G12b in
  // scripts/do-not-break-gates.js fails the whole suite on an added line
  // carrying one. The player's transcript is source text, so a plausible
  // command like the npm form that separates its own arguments from a runner's
  // trips the gate from inside a marketing clip. Catching it here means the
  // gate is not the thing that finds it, three minutes of re-recording later.
  //
  // Both patterns are ASSEMBLED rather than written as literals, for the same
  // reason scripts/do-not-break-gates.js assembles its own: a test file that
  // spells out the character it forbids is inside the scanned tree and makes
  // the gate count its own source forever.
  const DOUBLE_HYPHEN = '-'.repeat(2);
  const prose = new RegExp('(?<=\\S) ' + DOUBLE_HYPHEN + ' (?=\\S)');
  const emDash = new RegExp('[\\u2014\\u2015]');
  for (const variant of Object.keys(player.VARIANTS)) {
    const text = player.renderPlain(variant);
    assert.strictEqual(emDash.test(text), false, variant + ' prints an em dash');
    for (const line of text.split('\n')) {
      assert.ok(!prose.test(line), variant + ' prints a bare double hyphen: ' + JSON.stringify(line.trim()));
    }
  }
});

check('the player writes no raw control character into its own source', () => {
  // A raw ESC byte committed into a source file is invisible in review and
  // survives copy and paste badly. The escape is built from a code point.
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'media', 'fake-agent.js'), 'utf8');
  for (const ch of source) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') {
      throw new Error('raw control character U+' + code.toString(16) + ' in fake-agent.js');
    }
  }
});

/* ═══════════════════════════════════════════════════════════════
   4. Capture safety, without launching anything
   ═══════════════════════════════════════════════════════════════ */

section('capture: the scene table honours the contract');

check('every contract clip and still has a scene', () => {
  const names = new Set(capture.SCENES.map((s) => s.name));
  for (const required of [
    'hero', 'feature-sidebar', 'feature-terminal', 'feature-codex',
    'feature-phone', 'feature-themes', 'feature-board',
    'still-desktop-dark', 'still-desktop-light', 'still-phone',
  ]) {
    assert.ok(names.has(required), 'no scene produces ' + required);
  }
});

check('desktop scenes capture at 1440x900 and the phone at 390x844', () => {
  for (const scene of capture.SCENES) {
    const isPhone = scene.name.indexOf('phone') !== -1;
    const want = isPhone ? capture.PHONE : capture.DESKTOP;
    assert.deepStrictEqual(scene.viewport, want, scene.name + ' viewport');
  }
});

check('stills are shot at deviceScaleFactor 2, and clips at 1', () => {
  // Screencast frames are 1x CSS pixels no matter what the context asks for, so
  // deviceScaleFactor on a clip buys nothing and costs render time. A still is
  // the opposite: it is the only way to get a retina frame at all.
  for (const scene of capture.SCENES) {
    const dsf = (scene.context || {}).deviceScaleFactor;
    if (scene.kind === 'still') {
      assert.strictEqual(dsf, 2, scene.name + ' is a still and must be shot at 2x');
    } else if (dsf !== undefined) {
      assert.strictEqual(dsf, 1, scene.name + ' is a clip and gains nothing above 1x');
    }
  }
});

check('the phone scene emulates touch and drops the mouse cursor overlay', () => {
  const phone = capture.SCENES.find((s) => s.name === 'feature-phone');
  assert.strictEqual(phone.context.isMobile, true);
  assert.strictEqual(phone.context.hasTouch, true);
  assert.strictEqual(phone.actions, false, 'a pointer drawn over a touch surface is wrong and covers two tabs');
});

check('every clip declares a duration budget, and the hero is the longest', () => {
  const clips = capture.SCENES.filter((s) => s.kind === 'clip');
  for (const clip of clips) {
    assert.ok(clip.budgetS > 0, clip.name + ' has no duration budget');
  }
  const hero = clips.find((s) => s.name === 'hero');
  for (const clip of clips) {
    if (clip.name === 'hero') continue;
    assert.ok(clip.budgetS <= hero.budgetS, clip.name + ' is budgeted longer than the hero');
    assert.ok(clip.budgetS <= 13, clip.name + ' exceeds the contract feature clip window');
  }
});

check('the themes clip walks both chromes and several palettes', () => {
  const chromes = new Set(capture.THEME_SEQUENCE.map((s) => s.chrome));
  const themes = new Set(capture.THEME_SEQUENCE.map((s) => s.theme));
  assert.ok(chromes.has('light') && chromes.has('dark'), 'the clip does not show both chromes');
  assert.ok(themes.size >= 4, 'fewer than four palettes: ' + themes.size);
  const crossed = capture.THEME_SEQUENCE.some((s) => s.chrome === 'light' && s.theme === 'mocha');
  assert.ok(crossed, 'no light-chrome-with-dark-palette pair, which is what proves the two axes are independent');
});

check('the cursor overlay keeps the pointer and drops the action caption', () => {
  assert.strictEqual(capture.ACTION_OPTIONS.cursor, 'pointer');
  assert.ok(
    capture.ACTION_OPTIONS.fontSize > 0 && capture.ACTION_OPTIONS.fontSize <= 4,
    'fontSize 0 removes the pointer as well as the caption; above 4 the caption is legible in frame'
  );
  assert.strictEqual(
    capture.ACTION_OPTIONS.duration, undefined,
    'raising the annotation duration makes every mouse call block for it, which blew every budget'
  );
});

check('a selector lookup can never block for Playwright default timeout', () => {
  // locator.boundingBox() waits 30 s by default and a catch around it swallows
  // the failure without shortening the wait. Two missed selectors cost a 12 s
  // clip 60 s of frozen frames before this was bounded.
  assert.ok(capture.SELECTOR_TIMEOUT_MS > 0 && capture.SELECTOR_TIMEOUT_MS <= 5000,
    'the selector timeout is not bounded to a few seconds');
});

check('the player runs faster off camera than on', () => {
  assert.ok(
    capture.PLAYER_SPEED.offCamera < capture.PLAYER_SPEED.onCamera,
    'off-camera setup should be the fastest thing in the run'
  );
});

/* ═══════════════════════════════════════════════════════════════
   5. The Claude projects directory override
   ═══════════════════════════════════════════════════════════════ */

section('provider override: CWM_CLAUDE_PROJECTS_DIR');

/**
 * Run a function with one environment variable set, and restore it after.
 *
 * @param {string} name - Variable name.
 * @param {string|undefined} value - Value, or undefined to unset.
 * @param {Function} fn - Body.
 * @returns {*} Whatever the body returned.
 */
function withEnv(name, value, fn) {
  const saved = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

check('unset, the resolver returns exactly the path every call site used before', () => {
  withEnv('CWM_CLAUDE_PROJECTS_DIR', undefined, () => {
    assert.strictEqual(
      pathDecode.resolveClaudeProjectsDir(),
      path.join(os.homedir(), '.claude', 'projects'),
      'the default behaviour changed, which would move discovery for every existing user'
    );
  });
});

check('set, the resolver honours it strictly', () => {
  withEnv('CWM_CLAUDE_PROJECTS_DIR', 'D:\\fixtures\\claude-projects', () => {
    assert.strictEqual(pathDecode.resolveClaudeProjectsDir(), 'D:\\fixtures\\claude-projects');
  });
});

check('an empty or blank value is treated as unset', () => {
  // An exported but blank variable must not silently redirect discovery at the
  // filesystem root, which is what an unguarded read would do.
  const fallback = path.join(os.homedir(), '.claude', 'projects');
  withEnv('CWM_CLAUDE_PROJECTS_DIR', '', () => {
    assert.strictEqual(pathDecode.resolveClaudeProjectsDir(), fallback);
  });
  withEnv('CWM_CLAUDE_PROJECTS_DIR', '   ', () => {
    assert.strictEqual(pathDecode.resolveClaudeProjectsDir(), fallback);
  });
});

check('the value is read at CALL time, so a test can change it between cases', () => {
  const first = withEnv('CWM_CLAUDE_PROJECTS_DIR', 'D:\\one', () => pathDecode.resolveClaudeProjectsDir());
  const second = withEnv('CWM_CLAUDE_PROJECTS_DIR', 'D:\\two', () => pathDecode.resolveClaudeProjectsDir());
  assert.strictEqual(first, 'D:\\one');
  assert.strictEqual(second, 'D:\\two');
});

check('the override actually reaches discovery, not just the resolver', () => {
  // A resolver nobody calls is worse than no resolver. This proves the lookup
  // path uses it: a session id is findable under the override and not findable
  // once the override points somewhere empty.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    const projects = path.join(dir, 'projects');
    const project = path.join(projects, 'D--fixture-project');
    fs.mkdirSync(project, { recursive: true });
    const sessionId = '00000000-0000-4000-8000-000000000abc';
    fs.writeFileSync(path.join(project, sessionId + '.jsonl'), '{"type":"user","cwd":"D:\\\\fixture"}\n', 'utf8');

    const found = withEnv('CWM_CLAUDE_PROJECTS_DIR', projects, () => pathDecode.findJsonlFile(sessionId));
    assert.ok(found, 'findJsonlFile did not use the override');
    assert.ok(found.indexOf(sessionId) !== -1, 'the wrong file was returned: ' + found);

    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const missing = withEnv('CWM_CLAUDE_PROJECTS_DIR', empty, () => pathDecode.findJsonlFile(sessionId));
    assert.strictEqual(missing, null, 'the override is not honoured strictly: it fell back to the real home');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('a non-existent override yields nothing rather than falling back', () => {
  // "If you set it, you mean it", the same way CODEX_HOME behaves. A silent
  // fallback to the real home is exactly what a sandbox must never do.
  const nowhere = path.join(os.tmpdir(), TEMP_PREFIX + 'does-not-exist-' + Date.now());
  const found = withEnv('CWM_CLAUDE_PROJECTS_DIR', nowhere, () =>
    pathDecode.findJsonlFile('00000000-0000-4000-8000-000000000abc'));
  assert.strictEqual(found, null, 'discovery reached outside the override');
});

/* ── Results ──────────────────────────────────────────────────────────────── */

console.log('\n  ' + '-'.repeat(42));
console.log('  media pipeline: ' + passed + ' passed, ' + failed + ' failed');
console.log('  ' + '-'.repeat(42) + '\n');

process.exit(failed > 0 ? 1 : 0);
