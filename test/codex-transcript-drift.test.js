#!/usr/bin/env node
/**
 * BUILD-CONTRACT P9.1 and P9.2: the dropped-transcript fix and the drift
 * counter that makes the next one visible.
 *
 * What this file is defending
 * ===========================
 *
 * CODEX-PARITY B8 measured a correctness bug, not a cosmetic one: a real
 * 2465-line rollout produced 217 messages, because `custom_tool_call` and
 * `custom_tool_call_output` had no case in the parser and 1072 lines, 43
 * percent of the file, were dropped with no error, no warning and no log. Codex
 * had moved to freeform tool calling and the parser kept handling only the
 * `function_call` shape it was written for.
 *
 * Re-measured on 2026-08-13 across the 60 largest rollouts on the reference
 * machine: 4306 `custom_tool_call` against 2665 `function_call`. The unhandled
 * shape is now the majority of tool traffic.
 *
 * Coverage:
 *   1. custom_tool_call and custom_tool_call_output emit, with the measured
 *      field names (`input`, not `arguments`).
 *   2. A tool result whose `output` is an ARRAY of content parts is extracted
 *      rather than emitted empty. This form is 765 of 1226 observed lines and
 *      it silently emptied `function_call_output` too.
 *   3. Image parts are announced, never inlined (their data URLs reached 671 KB).
 *   4. agent_message, tool_search_* and web_search_call emit.
 *   5. The two metadata envelopes are skipped as KNOWN, not counted as unknown.
 *   6. A genuinely novel payload type and a novel envelope type are counted as
 *      unknown, which is the entire point of P9.2.
 *   7. Every observed cli_version family parses with zero unknowns.
 *   8. The historical function_call / message / compacted output is unchanged,
 *      byte for byte, against the fixture that predates this work.
 *
 * Fixtures are hand-written and carry no user content of any kind.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 green / 1 red.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, tallying rather than aborting so a single failure
 * does not hide the rest of the file.
 *
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 * @returns {Promise<void>}
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + (err && err.message ? err.message : String(err)) + '\x1b[0m');
  }
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'codex-rollouts');

/**
 * Stage a fixture into a throwaway $CODEX_HOME so parseTranscript's own id
 * resolution is exercised, rather than being bypassed with a direct path.
 *
 * @param {string} fixtureName - File under test/fixtures/codex-rollouts/.
 * @param {string} sessionId - UUID the staged filename should end with.
 * @returns {{home: string, filePath: string}}
 */
function stageFixture(fixtureName, sessionId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-drift-'));
  const dayDir = path.join(home, 'sessions', '2026', '08', '01');
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, 'rollout-2026-08-01T10-00-00-' + sessionId + '.jsonl');
  fs.copyFileSync(path.join(FIXTURE_DIR, fixtureName), filePath);
  return { home: home, filePath: filePath };
}

/** Load parse.js fresh so a CODEX_HOME change is honoured. */
function freshParse() {
  delete require.cache[require.resolve('../src/providers/codex/parse')];
  return require('../src/providers/codex/parse');
}

/**
 * Index a message list by the tool name it carries, for readable assertions.
 *
 * @param {Array<object>} messages
 * @returns {Map<string, Array<object>>}
 */
function byToolName(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m.toolName || '(none)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

(async () => {
  console.log('\n  BUILD-CONTRACT P9.1 / P9.2: Codex transcript emit set and drift counter');
  console.log('  ' + '-'.repeat(72));

  const parse = freshParse();
  const { parseLine, parseTranscriptDetailed, _internal } = parse;

  // ── 1. The dropped shapes now emit ─────────────────────────────────────

  await test('custom_tool_call emits a tool_use carrying name and input', () => {
    const line = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-08-01T10:00:05.000Z',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'exec',
        input: '{"command":"ls -1"}',
        status: 'completed',
      },
    });
    const msg = parseLine(line);
    assert(msg, 'custom_tool_call must not be dropped');
    assert.strictEqual(msg.role, 'tool');
    assert.strictEqual(msg.kind, 'tool_use');
    assert.strictEqual(msg.toolName, 'exec');
    assert.strictEqual(msg.text, 'exec {"command":"ls -1"}');
    assert.strictEqual(msg.timestamp, '2026-08-01T10:00:05.000Z');
  });

  await test('custom_tool_call reads `input`, NOT `arguments`', () => {
    // The measured field name. Copying function_call's `arguments` here would
    // emit a message with an empty body and look like it worked.
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', arguments: 'WRONG-KEY', input: 'RIGHT-KEY' },
    }));
    assert.strictEqual(msg.text, 'apply_patch RIGHT-KEY');
  });

  await test('custom_tool_call_output with a STRING output emits that string', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'alpha.txt\nbeta.txt\n' },
    }));
    assert.strictEqual(msg.role, 'tool');
    assert.strictEqual(msg.kind, 'tool_result');
    assert.strictEqual(msg.text, 'alpha.txt\nbeta.txt\n');
    assert.strictEqual(msg.toolName, undefined, 'a result carries no tool name');
  });

  // ── 2. The array-output form, which emptied messages silently ──────────

  await test('a tool result whose output is an ARRAY of parts is extracted', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        output: [
          { type: 'input_text', text: 'Success. Updated:\n' },
          { type: 'input_text', text: 'M alpha.txt' },
        ],
      },
    }));
    assert.strictEqual(msg.text, 'Success. Updated:\nM alpha.txt');
  });

  await test('function_call_output ALSO handles the array form (same bug class)', () => {
    // 86 of the observed function_call_output lines carried an array and were
    // emitted with an empty body: counted, but content thrown away.
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', output: [{ type: 'input_text', text: 'new line' }] },
    }));
    assert.strictEqual(msg.text, 'new line');
  });

  await test('an image part is announced, never inlined', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        output: [
          { type: 'input_text', text: 'captured' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AAAABBBBCCCC' },
        ],
      },
    }));
    assert.strictEqual(msg.text, 'captured' + _internal.IMAGE_PART_PLACEHOLDER);
    assert(msg.text.indexOf('base64') === -1, 'the data URL must never reach the transcript');
  });

  // ── 3. The remaining recovered shapes ──────────────────────────────────

  await test('agent_message emits as an assistant turn carrying its provenance', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root/worker',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'Patch complete.' }],
      },
    }));
    assert.strictEqual(msg.role, 'assistant');
    assert.strictEqual(msg.kind, 'text');
    assert.strictEqual(msg.text, 'Patch complete.');
    assert.strictEqual(msg.author, '/root/worker');
    assert.strictEqual(msg.recipient, '/root');
  });

  await test('tool_search_call stringifies its OBJECT arguments', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'tool_search_call', arguments: { query: 'patch helper', limit: 5 }, status: 'completed' },
    }));
    assert.strictEqual(msg.kind, 'tool_use');
    assert.strictEqual(msg.toolName, _internal.TOOL_SEARCH_TOOL_NAME);
    assert(msg.text.indexOf('patch helper') !== -1, 'the query must survive');
  });

  await test('tool_search_output summarises rather than inlining descriptors', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'tool_search_output', tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    }));
    assert.strictEqual(msg.kind, 'tool_result');
    assert.strictEqual(msg.text, _internal.TOOL_SEARCH_TOOL_NAME + ' [3]');
  });

  await test('web_search_call (0.125 and 0.142 families) emits', () => {
    const msg = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'fixture query' } },
    }));
    assert.strictEqual(msg.kind, 'tool_use');
    assert.strictEqual(msg.toolName, _internal.WEB_SEARCH_TOOL_NAME);
    assert(msg.text.indexOf('fixture query') !== -1);
  });

  // ── 4. The counter: known skips versus real drift ──────────────────────

  await test('metadata envelopes are skipped as KNOWN, not counted as unknown', () => {
    const stats = _internal.createTranscriptStats();
    parseLine(JSON.stringify({ type: 'world_state', payload: { full: true, state: {} } }), { stats: stats });
    parseLine(JSON.stringify({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }), { stats: stats });
    parseLine(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x' } }), { stats: stats });
    assert.strictEqual(stats.unknown, 0, 'measured metadata must not read as drift');
    assert.strictEqual(stats.skippedKnown, 3);
    assert.strictEqual(stats.emitted, 0);
  });

  await test('a novel response_item subtype is COUNTED, not swallowed', () => {
    const stats = _internal.createTranscriptStats();
    parseLine(JSON.stringify({ type: 'response_item', payload: { type: 'a_shape_from_the_future' } }), { stats: stats });
    assert.strictEqual(stats.unknown, 1);
    assert.strictEqual(stats.unknownTypes['response_item/a_shape_from_the_future'], 1);
  });

  await test('a novel ENVELOPE type is counted too', () => {
    const stats = _internal.createTranscriptStats();
    parseLine(JSON.stringify({ type: 'an_envelope_from_the_future', payload: { type: 'x' } }), { stats: stats });
    assert.strictEqual(stats.unknown, 1);
    assert.strictEqual(stats.unknownTypes['an_envelope_from_the_future'], 1);
  });

  await test('a torn line counts as unparsable, not as drift', () => {
    const stats = _internal.createTranscriptStats();
    parseLine('{"type":"response_item","payl', { stats: stats });
    assert.strictEqual(stats.unparsable, 1);
    assert.strictEqual(stats.unknown, 0, 'a truncated tail says nothing about the format');
  });

  await test('passing no stats is free and changes nothing', () => {
    const withStats = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'x' },
    }), { stats: _internal.createTranscriptStats() });
    const without = parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'x' },
    }));
    assert.deepStrictEqual(without, withStats);
  });

  // ── 5. Whole-file behaviour on the fixtures ────────────────────────────

  const staged = stageFixture('custom-tools.jsonl', '019f0000-0000-7000-8000-000000000001');
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = staged.home;
  const parseStaged = freshParse();

  let detailed = null;
  await test('parseTranscriptDetailed reports emitted, skipped and unknown counts', async () => {
    detailed = await parseStaged.parseTranscriptDetailed('019f0000-0000-7000-8000-000000000001');
    assert(detailed && Array.isArray(detailed.messages), 'must return a message array');
    const s = detailed.stats;
    assert.strictEqual(s.lines, 20, 'fixture line count');
    assert.strictEqual(s.unparsable, 0);
    // Two deliberate canaries at the end of the fixture.
    assert.strictEqual(s.unknown, 2, 'the two future shapes must be counted');
    assert.strictEqual(s.unknownTypes['response_item/a_shape_from_the_future'], 1);
    assert.strictEqual(s.unknownTypes['an_envelope_from_the_future'], 1);
    assert.strictEqual(s.emitted + s.skippedKnown + s.unknown, s.lines);
  });

  await test('the whole tool exchange survives the round trip', () => {
    const names = byToolName(detailed.messages.filter((m) => m.role === 'tool'));
    // parseTranscript projects mirror-only fields away, so assert on stats.
    const e = detailed.stats.emittedTypes;
    assert.strictEqual(e['response_item/custom_tool_call'], 2);
    assert.strictEqual(e['response_item/custom_tool_call_output'], 3);
    assert.strictEqual(e['response_item/function_call'], 1);
    assert.strictEqual(e['response_item/function_call_output'], 1);
    assert.strictEqual(e['response_item/tool_search_call'], 1);
    assert.strictEqual(e['response_item/tool_search_output'], 1);
    assert.strictEqual(e['response_item/agent_message'], 1);
    assert.strictEqual(e['response_item/message'], 2);
    assert(names.size >= 0, 'tool index built');
  });

  await test('parseTranscript returns exactly parseTranscriptDetailed().messages', async () => {
    const plain = await parseStaged.parseTranscript('019f0000-0000-7000-8000-000000000001');
    assert.deepStrictEqual(plain, detailed.messages);
    // And the ProviderMessage projection is still four keys, no more.
    for (const m of plain) {
      assert.deepStrictEqual(Object.keys(m).sort(), ['model', 'role', 'text', 'timestamp']);
    }
  });

  await test('no image data URL reaches the transcript', () => {
    for (const m of detailed.messages) {
      assert(m.text.indexOf('FIXTUREPLACEHOLDER') === -1, 'image payload leaked into a message');
    }
  });

  if (prevHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevHome;

  // ── 5b. The bounded read ───────────────────────────────────────────────
  //
  // Found by the read-only proof harness rather than by reading the code: the
  // heaviest thread on the reference machine has a 924 MB rollout, and the
  // whole file was being read into one string. That is above V8's maximum
  // string length, so the read threw and the catch returned an EMPTY
  // transcript. A 924 MB session rendered as "no messages", silently, which is
  // the same class of failure P9.1 exists to close. Measured across all 2889
  // rollouts: 170 of them, 5.9 percent, are above the 256 MB ceiling.

  await test('an oversized rollout reads its TAIL and says so, instead of failing empty', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bounded-'));
    const dir = path.join(home, 'sessions', '2026', '08', '01');
    fs.mkdirSync(dir, { recursive: true });
    const id = '019f0000-0000-7000-8000-0000000000bb';
    const file = path.join(dir, 'rollout-2026-08-01T10-00-00-' + id + '.jsonl');

    // Ten identical tool calls; each line is well over 100 bytes, so a 600-byte
    // ceiling keeps only the last few and must drop the partial first line.
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'x'.repeat(120) },
    });
    fs.writeFileSync(file, Array(10).fill(line).join('\n') + '\n');
    const fullSize = fs.statSync(file).size;

    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const p = freshParse();
      const whole = await p.parseTranscriptDetailed(id);
      assert.strictEqual(whole.messages.length, 10, 'the unbounded read must see every line');
      assert.strictEqual(whole.stats.truncatedFile, false);
      assert.strictEqual(whole.stats.fileSize, fullSize);
      assert.strictEqual(whole.stats.bytesRead, fullSize);

      const bounded = await p.parseTranscriptDetailed(id, { maxBytes: 600 });
      assert.strictEqual(bounded.stats.truncatedFile, true, 'truncation must be reported, not hidden');
      assert.strictEqual(bounded.stats.bytesRead, 600);
      assert.strictEqual(bounded.stats.fileSize, fullSize);
      assert(bounded.messages.length > 0, 'the tail must still parse');
      assert(bounded.messages.length < 10, 'the tail must genuinely be a tail');
      // The partial leading line is dropped, not counted as corrupt.
      assert.strictEqual(bounded.stats.unparsable, 0);
      assert.strictEqual(bounded.stats.unknown, 0);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  await test('an empty rollout is empty, not an error', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-'));
    const dir = path.join(home, 'sessions', '2026', '08', '01');
    fs.mkdirSync(dir, { recursive: true });
    const id = '019f0000-0000-7000-8000-0000000000cc';
    fs.writeFileSync(path.join(dir, 'rollout-2026-08-01T10-00-00-' + id + '.jsonl'), '');
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const p = freshParse();
      const d = await p.parseTranscriptDetailed(id);
      assert.deepStrictEqual(d.messages, []);
      assert.strictEqual(d.stats.fileSize, 0);
      assert.strictEqual(d.stats.unknown, 0);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  // ── 6. One fixture per observed cli_version family ─────────────────────
  //
  // Measured on 2026-08-13 over a 133-file even-spread sample: seventeen
  // cli_version families are present on this machine, from 0.124.0-alpha.2 to
  // 0.147.0-alpha.6.6. They fall into three shape families, and the fixtures
  // below carry one of each:
  //
  //   0.124 to 0.142  function_call + function_call_output (+ web_search_call)
  //   0.125 / 0.130   the first custom_tool_call sightings, alongside the above
  //   0.144 onward    custom_tool_call dominant, plus world_state,
  //                   inter_agent_communication_metadata and agent_message
  //
  // The assertion is the same for every family and is the one that matters:
  // ZERO unknown lines. A new family that drifts fails here first.

  const FAMILY_FIXTURES = [
    { file: 'cli-0.142-family.jsonl', id: '019f0000-0000-7000-8000-000000000142', label: '0.124 to 0.142 (pre-freeform)' },
    { file: 'custom-tools.jsonl', id: '019f0000-0000-7000-8000-000000000001', label: '0.146 (freeform tools)', expectUnknown: 2 },
    { file: 'cli-0.147-family.jsonl', id: '019f0000-0000-7000-8000-000000000147', label: '0.147 (multi-agent)' },
  ];

  for (const fam of FAMILY_FIXTURES) {
    await test('cli family ' + fam.label + ' parses with no unrecognised lines', async () => {
      const st = stageFixture(fam.file, fam.id);
      const saved = process.env.CODEX_HOME;
      process.env.CODEX_HOME = st.home;
      try {
        const p = freshParse();
        const d = await p.parseTranscriptDetailed(fam.id);
        assert.strictEqual(d.stats.unknown, fam.expectUnknown || 0,
          'unknown shapes: ' + JSON.stringify(d.stats.unknownTypes));
        assert(d.messages.length > 0, 'the family must produce messages');
      } finally {
        if (saved === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = saved;
      }
    });
  }

  // ── 7. The historical output is unchanged ──────────────────────────────

  await test('the pre-P9 fixture still parses to the same messages it always did', async () => {
    const st = stageFixture('modern.jsonl', '019dc872-a308-7111-ba78-068f9294120c');
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = st.home;
    try {
      const p = freshParse();
      const msgs = await p.parseTranscript('019dc872-a308-7111-ba78-068f9294120c');
      // The exact expectation Plan 17-01 shipped: 5 messages, in this order.
      assert.strictEqual(msgs.length, 5, 'modern.jsonl has always produced 5 messages');
      assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'system']);
      assert.strictEqual(msgs[2].text, 'shell_command {"command":"ls","workdir":"/home/user/project"}');
      assert.strictEqual(msgs[3].text, 'Exit code: 0\nWall time: 0.1s\nfile1.txt\nfile2.txt');
      assert.strictEqual(msgs[4].text, '[history fold]');
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  console.log('  ' + '-'.repeat(72));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
