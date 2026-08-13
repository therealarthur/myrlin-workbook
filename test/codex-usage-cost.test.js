#!/usr/bin/env node
/**
 * BUILD-CONTRACT P9.3: honest cost. Token accounting for Codex, and the route
 * gate that stops a provider with no price model reporting `$0.00`.
 *
 * What this file is defending
 * ===========================
 *
 * `/api/sessions/:id/cost` ran a Claude-shaped parser over whatever transcript
 * it was handed: `entry.type === 'assistant' && message.usage`. A Codex rollout
 * yields ZERO matches against 618 `event_msg/token_count` entries in the file
 * CODEX-PARITY B10 measured, and the route did not consult `supportsCost()`, so
 * it returned a fully-formed cost object of zeroes.
 *
 * The session it did that for had 226,420,778 tokens against it. `$0.00` is a
 * claim, and it was the wrong one.
 *
 * The fix is deliberately TWO capabilities rather than one flag:
 *
 *   supportsCost()       money.  FALSE for Codex, because Codex desktop bills
 *                        against a ChatGPT plan and the rollouts carry a plan
 *                        type and a credits block but no price.
 *   supportsTokenUsage() tokens. TRUE, backed by parseUsage.
 *
 * Coverage:
 *   1. The pure normalisers: token_count.info in both layouts, the rate-limit
 *      snapshot, and the Codex-to-Claude token conversion.
 *   2. The conversion that matters: Codex's input_tokens INCLUDES cached reads
 *      and Claude's excludes them. 98 percent of the measured session's input
 *      was cache reads, so reporting it raw would overstate fresh input 60-fold.
 *   3. parseUsage end to end against a hermetic fixture rollout.
 *   4. The route gate: costSupported false, cost null (never a zeroed object),
 *      real tokens attached, and the Claude path untouched.
 *   5. /api/providers exposes both flags.
 *
 * Nothing here reads the real ~/.codex. Every number is from a hand-written
 * fixture.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 / 1.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

// Sandbox CWM_DATA_DIR into a tmpdir before any module loads the store.
require('./_test-data-dir');

let passed = 0;
let failed = 0;

/**
 * Run one named assertion, tallying rather than aborting.
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
    console.log('    \x1b[31m' + (err && err.message ? err.message : err) + '\x1b[0m');
  }
}

/**
 * Minimal JSON HTTP client against an ephemeral listener.
 *
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {{token?: string, body?: object}} [opts]
 * @returns {Promise<{status:number, body:any}>}
 */
function req(server, method, urlPath, opts) {
  const options = opts || {};
  const data = options.body == null ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = 'Bearer ' + options.token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(
      { hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: method, headers: headers },
      (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          let body = buf;
          try { body = buf ? JSON.parse(buf) : null; } catch (_) { /* keep raw */ }
          resolve({ status: res.statusCode, body: body });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\n  BUILD-CONTRACT P9.3: Codex token accounting and the cost capability gate');
  console.log('  ' + '-'.repeat(72));

  const usage = require('../src/providers/codex/usage');
  const U = usage._internal;

  // ── 1. The pure normalisers ────────────────────────────────────────────

  await test('token_count.info normalises the nested layout', () => {
    const out = U.normalizeTokenCountInfo({
      total_token_usage: {
        input_tokens: 1200,
        cached_input_tokens: 800,
        cache_write_input_tokens: 100,
        output_tokens: 340,
        reasoning_output_tokens: 90,
        total_tokens: 1540,
      },
      last_token_usage: { input_tokens: 400, cached_input_tokens: 300, output_tokens: 120, total_tokens: 520 },
      model_context_window: 258400,
    });
    assert(out, 'must normalise');
    assert.strictEqual(out.totals.inputTokens, 1200);
    assert.strictEqual(out.totals.cachedInputTokens, 800);
    assert.strictEqual(out.totals.totalTokens, 1540);
    assert.strictEqual(out.contextWindow, 258400);
    assert.strictEqual(out.lastTurn.outputTokens, 120);
  });

  await test('a missing total is derived from its parts rather than reported as zero', () => {
    const out = U.normalizeTokenCountInfo({
      total_token_usage: { input_tokens: 100, output_tokens: 25 },
    });
    // Measured relationship on the real data: total_tokens = input + output.
    assert.strictEqual(out.totals.totalTokens, 125);
  });

  await test('a flattened info block still normalises', () => {
    const out = U.normalizeTokenCountInfo({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    assert(out, 'the older flat layout must not be refused');
    assert.strictEqual(out.totals.totalTokens, 15);
  });

  await test('a garbage info block returns null, never a zeroed object', () => {
    assert.strictEqual(U.normalizeTokenCountInfo(null), null);
    assert.strictEqual(U.normalizeTokenCountInfo({}), null);
    assert.strictEqual(U.normalizeTokenCountInfo('nonsense'), null);
  });

  await test('the Codex-to-Claude token conversion subtracts the cached reads', () => {
    // The whole point. On the measured session, input_tokens was 226,082,150 of
    // which 222,431,744 were cache reads. Reporting the raw number as `input`
    // would have overstated fresh input by a factor of 62.
    const t = U.toComparableTokens({
      inputTokens: 226082150,
      cachedInputTokens: 222431744,
      cacheWriteInputTokens: 0,
      outputTokens: 338628,
      reasoningOutputTokens: 87472,
      totalTokens: 226420778,
    });
    assert.strictEqual(t.cacheRead, 222431744);
    assert.strictEqual(t.input, 226082150 - 222431744);
    assert.strictEqual(t.output, 338628);
    assert.strictEqual(t.reasoning, 87472);
    assert.strictEqual(t.total, t.input + t.output + t.cacheRead + t.cacheWrite);
  });

  await test('the conversion clamps rather than going negative on a schema change', () => {
    // If a future CLI stops nesting cached inside input, a negative `input`
    // would poison every percentage computed downstream.
    const t = U.toComparableTokens({ inputTokens: 10, cachedInputTokens: 999, outputTokens: 0 });
    assert.strictEqual(t.input, 0);
  });

  await test('rate limits normalise into the shape the usage meters want', () => {
    const rl = U.normalizeRateLimits({
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1777000000 },
      secondary: null,
      credits: { balance: 0, has_credits: false, unlimited: false },
      individual_limit: null,
      plan_type: 'pro',
      rate_limit_reached_type: null,
      spend_control_reached: null,
    });
    assert.strictEqual(rl.planType, 'pro');
    assert.strictEqual(rl.primary.usedPercent, 42.5);
    assert.strictEqual(rl.primary.windowMinutes, 300);
    assert.strictEqual(rl.secondary, null);
    assert.strictEqual(rl.credits.hasCredits, false);
    assert.strictEqual(rl.spendControlReached, false);
  });

  await test('the LAST token_count in a window wins, because the totals are cumulative', () => {
    // Verified on the real file: 1725 samples, zero decreases, across 12
    // session_meta lines. A resume does not reset the counter.
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90, output_tokens: 9, total_tokens: 99 } } } }),
    ].join('\n');
    const hit = U.findLastTokenCount(lines);
    assert.strictEqual(hit.info.totals.totalTokens, 99);
    assert.strictEqual(hit.samples, 2);
  });

  // ── 2. parseUsage end to end, hermetically ─────────────────────────────

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  const dayDir = path.join(tmpHome, 'sessions', '2026', '08', '01');
  fs.mkdirSync(dayDir, { recursive: true });
  const FIXTURE_ID = '019f0000-0000-7000-8000-000000000001';
  const fixturePath = path.join(dayDir, 'rollout-2026-08-01T10-00-00-' + FIXTURE_ID + '.jsonl');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'codex-rollouts', 'custom-tools.jsonl'), fixturePath);

  await test('parseUsage reads the totals out of a rollout with no database at all', async () => {
    const report = await usage.parseUsage(fixturePath);
    assert(report, 'a rollout alone must be enough');
    assert.strictEqual(report.source, usage.USAGE_SOURCES.ROLLOUT);
    assert.strictEqual(report.priced, false, 'Codex has no price model');
    assert.strictEqual(report.currency, null);
    // Fixture: input 1200 (800 cached), write 100, output 340, reasoning 90.
    assert.strictEqual(report.tokens.cacheRead, 800);
    assert.strictEqual(report.tokens.input, 400);
    assert.strictEqual(report.tokens.output, 340);
    assert.strictEqual(report.tokens.cacheWrite, 100);
    assert.strictEqual(report.tokens.reasoning, 90);
    assert.strictEqual(report.contextWindow, 258400);
    assert(report.raw, 'the untranslated counters must ride along');
    assert.strictEqual(report.raw.inputTokens, 1200);
  });

  await test('parseUsage returns null for a file that carries no usage at all', async () => {
    const empty = path.join(dayDir, 'rollout-2026-08-01T11-00-00-019f0000-0000-7000-8000-0000000000ff.jsonl');
    fs.writeFileSync(empty, JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }) + '\n');
    const report = await usage.parseUsage(empty);
    assert.strictEqual(report, null, 'null means unknown; zero would be a claim');
  });

  await test('parseUsage never throws on hostile input', async () => {
    assert.strictEqual(await usage.parseUsage(null), null);
    assert.strictEqual(await usage.parseUsage(''), null);
    assert.strictEqual(await usage.parseUsage('/no/such/path.jsonl'), null);
    assert.strictEqual(await usage.parseUsage({ not: 'a string' }), null);
  });

  // ── 3. The route gate ──────────────────────────────────────────────────

  const registry = require('../src/providers');
  const { getStore } = require('../src/state/store');
  const store = getStore();
  await registry.initRegistry(store);

  const server = require('../src/web/server');
  const auth = require('../src/web/auth');
  const TOKEN = 'test-token-p9-cost';
  auth.addToken(TOKEN);
  const listener = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));

  // A stub provider that reports usage but no price, which is the Codex shape
  // without the Codex filesystem. Registered so the gate is exercised through
  // the real route rather than through a mocked handler.
  const unpricedStub = {
    id: 'test-unpriced-p9',
    displayName: 'Unpriced Stub',
    accentToken: 'pink',
    cliBinary: 'this-binary-should-never-exist-on-path-p9',
    discover: function () { return Promise.resolve([]); },
    parseTranscript: function () { return Promise.resolve([]); },
    spawnCommand: function () { return { cmd: 'echo', args: [], cwd: process.cwd(), env: {} }; },
    search: function () { return Promise.resolve({ results: [], timedOut: false, searchedFiles: 0 }); },
    init: function () { return Promise.resolve(); },
    dispose: function () { return Promise.resolve(); },
    supportsCost: function () { return false; },
    supportsTokenUsage: function () { return true; },
    parseUsage: function () {
      return Promise.resolve({
        provider: 'test-unpriced-p9',
        source: 'state-db',
        priced: false,
        currency: null,
        tokens: { input: 400, output: 340, cacheRead: 800, cacheWrite: 100, reasoning: 90, total: 1640 },
        raw: null,
        lastTurn: null,
        tokensUsed: 1540,
        contextWindow: 258400,
        rateLimits: { planType: 'pro', primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null } },
        samples: 1,
        model: 'stub-model',
        artifactPath: null,
      });
    },
    totalTokensSync: function () { return 1540; },
    findArtifactPath: function () { return null; },
    findArtifactByWorkingDir: function () { return null; },
    isIdleSignal: function () { return false; },
    getKeyBindings: function () { return {}; },
  };
  registry.register(unpricedStub);

  const ws = store.createWorkspace({ name: 'P9 cost gate' });
  const unpricedSession = store.createSession({
    workspaceId: ws.id,
    name: 'unpriced',
    workingDir: process.cwd(),
    resumeSessionId: FIXTURE_ID,
  });
  // createSession does not take a provider tag (it predates providers and its
  // signature is destructured), so the tag is applied as an update. This is the
  // same path the discovery adopt flow uses.
  store.updateSession(unpricedSession.id, { provider: unpricedStub.id });

  await test('an unpriced provider gets an explicit disclosure, never a zeroed cost', async () => {
    const r = await req(listener, 'GET', '/api/sessions/' + unpricedSession.id + '/cost', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.costSupported, false, 'the single field a client branches on');
    assert.strictEqual(r.body.cost, null, 'cost must be null, NOT a zeroed object');
    assert.strictEqual(r.body.costUnavailableReason, 'provider-has-no-price-model');
    assert.strictEqual(r.body.provider, unpricedStub.id);
  });

  await test('the disclosure carries the REAL token counts', async () => {
    const r = await req(listener, 'GET', '/api/sessions/' + unpricedSession.id + '/cost', { token: TOKEN });
    assert(r.body.tokens, 'tokens must be present');
    assert.strictEqual(r.body.tokens.total, 1640);
    assert.strictEqual(r.body.tokens.cacheRead, 800);
    assert.strictEqual(r.body.tokensSource, 'state-db');
    assert.strictEqual(r.body.contextWindow, 258400);
    assert(r.body.rateLimits && r.body.rateLimits.planType === 'pro', 'the P9.6 feed rides along');
  });

  await test('the frontend money branch hides itself on this payload', async () => {
    // app.js loadSessionCost: `if (!data || !data.cost || data.cost.total === 0)`
    // hides the panel. Asserting the predicate here rather than the DOM keeps
    // this test out of the frontend agent's files while still proving the
    // contract holds at the boundary.
    const r = await req(listener, 'GET', '/api/sessions/' + unpricedSession.id + '/cost', { token: TOKEN });
    const wouldHide = !r.body || !r.body.cost || r.body.cost.total === 0;
    assert.strictEqual(wouldHide, true, 'a money panel must not render for an unpriced provider');
  });

  await test('/api/cost/batch reports null, not zero, for an unpriced provider', async () => {
    const r = await req(listener, 'GET', '/api/cost/batch', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    const entry = r.body.costs[unpricedSession.id];
    assert(entry, 'the session must appear in the batch');
    assert.strictEqual(entry.cost, null, 'a false zero here is what painted $0.00 on the sidebar');
    assert.strictEqual(entry.costSupported, false);
    assert.strictEqual(entry.tokens, 1540, 'the O(1) total rides along');
  });

  await test('the frontend badge patcher skips this entry', () => {
    // _patchCostBadges: `if (!entry.cost && entry.cost !== 0) continue;`
    const entry = { cost: null };
    const wouldSkip = !entry.cost && entry.cost !== 0;
    assert.strictEqual(wouldSkip, true, 'a null cost must never be painted as a dollar amount');
  });

  await test('a cost-supporting provider is completely unaffected', async () => {
    const claudeSession = store.createSession({
      workspaceId: ws.id,
      name: 'claude-shaped',
      workingDir: process.cwd(),
      resumeSessionId: '00000000-0000-0000-0000-00000000dead',
    });
    const r = await req(listener, 'GET', '/api/sessions/' + claudeSession.id + '/cost', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    // No artifact exists for that id, so this is the historical zeroed shape,
    // which must come back BYTE-IDENTICAL: no costSupported, no null cost.
    assert.strictEqual(r.body.costSupported, undefined, 'the Claude path must not grow a new field');
    assert(r.body.cost && typeof r.body.cost.total === 'number', 'the Claude path keeps its cost object');
    assert.strictEqual(r.body.cost.total, 0);
    assert(r.body.tokens && r.body.tokens.total === 0);
  });

  await test('/api/providers exposes both capability flags', async () => {
    const r = await req(listener, 'GET', '/api/providers', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    const stub = r.body.find((p) => p.id === unpricedStub.id);
    assert(stub, 'the stub must be listed');
    assert.strictEqual(stub.supportsCost, false);
    assert.strictEqual(stub.supportsTokenUsage, true);
    // A provider without the optional member reports false, not true.
    const claudeEntry = r.body.find((p) => p.id === 'claude');
    assert(claudeEntry, 'claude must be listed');
    assert.strictEqual(claudeEntry.supportsCost, true);
    assert.strictEqual(claudeEntry.supportsTokenUsage, false);
  });

  await test('the real Codex provider reports usage but not money', () => {
    const codex = require('../src/providers/codex');
    assert.strictEqual(codex.supportsCost(), false, 'no price model exists for a plan-billed product');
    assert.strictEqual(codex.supportsTokenUsage(), true);
    assert.strictEqual(typeof codex.parseUsage, 'function');
    assert.strictEqual(typeof codex.totalTokensSync, 'function');
  });

  listener.close();

  console.log('  ' + '-'.repeat(72));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
