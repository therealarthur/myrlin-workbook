/**
 * b3-search.test.js: GET /search/names and GET /search/messages
 * (PROTOCOL.md 4.9; decision A15; critic F4; BUILD-CONTRACT 3.7.2
 * "Search").
 *
 * Name search answers from memory with ranked matches. Message search runs
 * Workbook's own provider search once per query (limit 200), maps hits to
 * phone ids through B2's index, pages over the cached run with totalHits,
 * sessionCount and hitsCapped equal on every page, counts tail read files
 * from file sizes, reports partial on a timed out provider, converts a
 * tail window line to a whole file line for the anchor, and refuses short
 * queries and expired cursors.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

require('./_harness');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kit = require('./b3-kit');
const { createDiscoveryCache } = require('../../src/web/mobile/chat/discovery-cache');

const sb = kit.sandbox();
const discovery = createDiscoveryCache({ registry: { getProvider: () => null } });
const dir = path.join(sb.work, 'search');
const ids = { a: crypto.randomUUID(), b: crypto.randomUUID(), big: crypto.randomUUID(), cx: crypto.randomUUID() };
const slow = { codex: false };
const calls = [];
let skew = 0;
let env;
let bigFile;

/** Workbook's racedSearch, as server.js passes it, with a switch to time Codex out. */
function racedSearch(provider, query, limit, budget, grace) {
  calls.push({ provider: provider.id, query, limit });
  if (slow.codex && provider.id === 'codex') return Promise.resolve({ __timedOut: true, providerId: 'codex' }); // gsd:provider-literal-allowed (test fixture)
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true, providerId: provider.id }), budget + grace); });
  return Promise.race([Promise.resolve().then(() => provider.search({ query, limit, timeBudgetMs: budget })), timeout]).then((v) => { clearTimeout(timer); return v; });
}

/** Decode an anchor (B2's base64url JSON). */
function anchorOf(a) {
  return JSON.parse(Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

kit.test('boot with transcripts: two busy sessions, a 9 MB one, a Codex thread', async () => {
  env = await kit.bootWorkspace({
    chat: { discovery },
    search: { racedSearch, SEARCH_TOTAL_BUDGET_MS: 5000, SEARCH_TIMEOUT_GRACE_MS: 100 },
    workspace: { now: () => Date.now() + skew },
  });
  const ws = env.store.createWorkspace({ name: 'Search zoo' });
  let recsA = [];
  for (let i = 0; i < 60; i++) recsA = recsA.concat(kit.claudeExchange('quagga item ' + i));
  kit.writeClaude(sb.projects, dir, ids.a, recsA);
  let recsB = [];
  for (let i = 0; i < 50; i++) recsB = recsB.concat(kit.claudeExchange('quagga thing ' + i));
  recsB = recsB.concat(kit.claudeExchange('okapi near the start'));
  kit.writeClaude(sb.projects, dir, ids.b, recsB);
  // A transcript over 8 MiB: filler first, the match in the last 2 MiB.
  const filler = kit.claudeExchange('x'.repeat(1000));
  const lines = [];
  let bytes = 0;
  while (bytes < 9 * 1024 * 1024) {
    for (const r of filler) {
      const line = JSON.stringify(Object.assign({ sessionId: ids.big, cwd: dir }, r, { uuid: crypto.randomUUID() }));
      lines.push(line);
      bytes += line.length + 1;
    }
  }
  for (const r of kit.claudeExchange('okapi tail line')) lines.push(JSON.stringify(Object.assign({ sessionId: ids.big, cwd: dir }, r)));
  bigFile = path.join(sb.projects, dir.replace(/[^A-Za-z0-9]/g, '-'), ids.big + '.jsonl');
  fs.writeFileSync(bigFile, lines.join('\n') + '\n');
  kit.writeCodex(sb.codexHome, ids.cx, kit.codexExchange('quagga codex'), { cwd: dir });
  kit.tracked(env.store, { workspaceId: ws.id, provider: 'claude', workingDir: dir, resumeSessionId: ids.a, name: 'Zebra planning' });
  discovery._seed('claude', [ids.a, ids.b, ids.big].map((id) => ({ provider: 'claude', providerSessionId: id, projectPath: dir, lastActive: new Date(), sizeBytes: 100 })));
  discovery._seed('codex', [{ provider: 'codex', providerSessionId: ids.cx, projectPath: dir, lastActive: new Date(), sizeBytes: 100 }]);
  // Codex search is on (Workbook's provider toggle), as on a computer that uses both.
  const registry = require('../../src/providers');
  registry.setEnabled('codex', true); // gsd:provider-literal-allowed (test fixture)
  const codex = registry.listAll().find((x) => x.id === 'codex'); // gsd:provider-literal-allowed (test fixture)
  if (codex && typeof codex.init === 'function') await codex.init();
  env.chat.internals.index.invalidate();
  env.ws.onProviderChange();
  // The name index warms in the background after a change.
  await kit.sleep(400);
});

kit.test('name search answers from memory, ranked, with match ranges', async () => {
  const r = await env.api('GET', '/search/names?q=zeb');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.validate(r.body, 'search/search-names.json');
  kit.eq([r.body.results[0].kind, r.body.results[0].title, r.body.results[0].sessionId], ['session', 'Zebra planning', 'cl_' + ids.a]);
  kit.eq(r.body.results[0].matchRanges, [[0, 3]]);
  const p = await env.api('GET', '/search/names?q=zoo');
  kit.ok(p.body.results.some((x) => x.kind === 'project' && x.title === 'Search zoo'), 'projects are searched');
  const d = await env.api('GET', '/search/names?q=' + encodeURIComponent('search'));
  kit.ok(d.body.results.some((x) => x.kind === 'workingDir'), 'working directories are searched');
  kit.ok(r.body.durationMs < 100, 'from memory');
  const short = await env.api('GET', '/search/names?q=');
  kit.eq(short.body.code, 'QUERY_TOO_SHORT');
  const lim = await env.api('GET', '/search/names?q=z&limit=101');
  kit.eq([lim.status, lim.body.code], [400, 'INVALID_FIELD']);
});

kit.test('message search pages over one cached run of 200 with the same totals on every page', async () => {
  calls.length = 0;
  const first = await env.api('GET', '/search/messages?q=quagga&limit=50');
  kit.eq(first.status, 200, JSON.stringify(first.body));
  kit.validate(first.body, 'search/search-messages.json');
  kit.ok(calls.every((c) => c.limit === 200), 'each provider asked for 200');
  kit.eq(first.body.hitsCapped, true);
  kit.ok(first.body.totalHits > 150 && first.body.totalHits <= 200, String(first.body.totalHits));
  const pages = [first.body];
  let cursor = first.body.nextCursor;
  while (cursor) {
    const r = await env.api('GET', '/search/messages?q=quagga&limit=50&cursor=' + encodeURIComponent(cursor));
    kit.eq(r.status, 200, JSON.stringify(r.body));
    pages.push(r.body);
    cursor = r.body.nextCursor;
  }
  kit.eq(calls.length, 2, 'paging never searches again (one call per provider)');
  for (const pg of pages) kit.eq([pg.totalHits, pg.sessionCount, pg.hitsCapped], [first.body.totalHits, first.body.sessionCount, true]);
  const all = pages.flatMap((pg) => pg.results);
  kit.eq(all.length, first.body.totalHits, 'the pages add up');
  kit.eq(new Set(all.map((x) => x.anchor + x.snippet)).size, all.length, 'no hit twice');
  const known = new Set(['cl_' + ids.a, 'cl_' + ids.b, 'cx_' + ids.cx]);
  kit.ok(all.every((x) => known.has(x.sessionId)), 'every hit maps to a phone id');
  kit.eq(first.body.sessionCount, new Set(all.map((x) => x.sessionId)).size);
  const sample = all.find((x) => x.sessionId === 'cl_' + ids.a);
  kit.eq([sample.title, sample.projectName], ['Zebra planning', 'Search zoo']);
  kit.ok(sample.matchRanges.length >= 1, 'match ranges in the snippet');
  const a = anchorOf(sample.anchor);
  kit.eq([a.p, a.u], ['claude', ids.a]);
  const fileA = fs.readFileSync(path.join(sb.projects, dir.replace(/[^A-Za-z0-9]/g, '-'), ids.a + '.jsonl'), 'utf8').split('\n');
  kit.ok(/quagga/.test(fileA[a.l - 1]), 'the anchor names a line holding the query');
});

kit.test('a tail read file is counted and its anchor is a whole file line', async () => {
  const r = await env.api('GET', '/search/messages?q=okapi&provider=claude');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq(r.body.coverage.tailOnlyFiles, 1, 'one file over 8 MB');
  kit.eq(r.body.coverage.note, 'Files over 8 MB are searched in their last 2 MB.');
  kit.eq([r.body.coverage.partial, r.body.coverage.timedOutProviders], [false, []]);
  kit.ok(r.body.coverage.searchedFiles >= 3, String(r.body.coverage.searchedFiles));
  const hit = r.body.results.find((x) => x.sessionId === 'cl_' + ids.big);
  kit.ok(hit, 'the big file matched');
  const a = anchorOf(hit.anchor);
  const lines = fs.readFileSync(bigFile, 'utf8').split('\n');
  kit.ok(a.l > 1000, 'a whole file line, not a window line: ' + a.l);
  kit.ok(/okapi/.test(lines[a.l - 1]), 'that line holds the query');
  const around = await env.api('GET', '/sessions/cl_' + ids.big + '/messages?around=' + encodeURIComponent(hit.anchor) + '&limit=5');
  kit.eq(around.status, 200, 'B2 opens the anchor: ' + JSON.stringify(around.body).slice(0, 200));
  kit.ok(r.body.results.every((x) => x.provider === 'claude'), 'provider filter');
});

kit.test('a timed out provider makes the run partial', async () => {
  slow.codex = true;
  const r = await env.api('GET', '/search/messages?q=codex');
  kit.eq(r.status, 200, JSON.stringify(r.body));
  kit.eq([r.body.coverage.partial, r.body.coverage.timedOutProviders], [true, ['codex']]);
  slow.codex = false;
  const c = await env.api('GET', '/search/messages?q=quagga%20codex&provider=codex');
  kit.eq(c.body.results.map((x) => x.sessionId), ['cx_' + ids.cx, 'cx_' + ids.cx].slice(0, c.body.results.length));
  kit.ok(c.body.results.length >= 1, 'the Codex hit maps to cx_');
});

kit.test('QUERY_TOO_SHORT, INVALID_FIELD and CURSOR_EXPIRED', async () => {
  const s = await env.api('GET', '/search/messages?q=a');
  kit.eq(s.body.code, 'QUERY_TOO_SHORT');
  const p = await env.api('GET', '/search/messages?q=quagga&provider=gemini');
  kit.eq([p.status, p.body.code, p.body.field], [400, 'INVALID_FIELD', 'provider']);
  const bad = await env.api('GET', '/search/messages?q=quagga&cursor=garbage');
  kit.eq(bad.body.code, 'CURSOR_EXPIRED');
  const first = await env.api('GET', '/search/messages?q=quagga&limit=10');
  skew = 61 * 1000;
  const late = await env.api('GET', '/search/messages?q=quagga&limit=10&cursor=' + encodeURIComponent(first.body.nextCursor));
  kit.eq(late.body.code, 'CURSOR_EXPIRED', 'a run older than 60 s has gone');
  skew = 0;
});

kit.run(async () => { if (env) await env.close(); });
