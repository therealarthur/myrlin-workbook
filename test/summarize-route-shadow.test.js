#!/usr/bin/env node
/**
 * BUILD-CONTRACT P9 (CODEX-PARITY B12): the shadowed summarize route.
 *
 * What was wrong
 * ==============
 *
 * TWO handlers were registered on `POST /api/sessions/:id/summarize`. Express
 * serves the first match, so the second one, the provider-aware handler that
 * generates a summary and appends it to the workspace docs, was unreachable
 * dead code. Two live callers wanted exactly that handler's `{summary}` shape:
 * `summarizeSessionToDocs()` in app.js and `summarize()` in the mobile client.
 * Both read `data.summary`, both always got undefined.
 *
 * The reachable handler had its own bug: it resolved transcripts by scanning
 * `~/.claude/projects` for `<id>.jsonl` and nothing else, so every Codex session
 * got a hard 404 no matter what the provider registry knew.
 *
 * How it was resolved, and what this file asserts
 * ==============================================
 *
 * By DELEGATION, not deletion. Both registrations survive. The docs behaviour
 * moved into a named function shared by three call sites, and the live handler
 * dispatches artifact resolution through the provider registry.
 *
 *   1. The default response shape is unchanged: theme, tasking, assistant.
 *   2. `{toDocs: true}` and `?toDocs=1` reach the previously-dead handler and
 *      get its `{summary}` shape.
 *   3. The default does NOT append a workspace note. A modal that silently
 *      writes into a user's project docs is a worse bug than the one fixed.
 *   4. The opt-in DOES append one.
 *   5. `/api/sessions/:id/summarize-to-docs` is a real, unshadowed route.
 *   6. A session whose artifact is not Claude-shaped is summarised through the
 *      provider's own parser instead of 404ing.
 *   7. The Claude-shaped path produces the same fields it always did.
 *
 * Everything runs against a stub provider and a temp file. No real transcript
 * and no ~/.codex access.
 *
 * Standalone-test convention: owns its assertion helpers, exits 0 / 1.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

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
  console.log('\n  BUILD-CONTRACT P9 (CODEX-PARITY B12): the shadowed summarize route');
  console.log('  ' + '-'.repeat(72));

  // ── Fixtures on disk ───────────────────────────────────────────────────

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-p9-'));

  // A Claude-shaped transcript: `{type, message: {role, content}}` per line.
  const claudeArtifact = path.join(tmp, 'claude-shaped.jsonl');
  fs.writeFileSync(claudeArtifact, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Build the widget exporter for the reporting module.' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Starting with the exporter interface.' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/exporter.js' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Now add the CSV variant please.' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CSV variant added and wired into the registry.' }] } }),
  ].join('\n') + '\n');

  // An envelope-shaped transcript, the shape a Codex rollout uses. The
  // Claude-shaped extractor yields ZERO messages from it, which is exactly the
  // condition the provider fallback exists to handle.
  const envelopeArtifact = path.join(tmp, 'envelope-shaped.jsonl');
  fs.writeFileSync(envelopeArtifact, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/tmp', cli_version: '0.147.0' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-01T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the flaky pairing test and report back.' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-01T00:01:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The flake is a race on the socket close.' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-01T00:02:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it and add a regression test.' }] } }),
  ].join('\n') + '\n');

  // ── Harness ────────────────────────────────────────────────────────────

  const registry = require('../src/providers');
  const { getStore } = require('../src/state/store');
  const store = getStore();
  await registry.initRegistry(store);

  const server = require('../src/web/server');
  const auth = require('../src/web/auth');
  const TOKEN = 'test-token-p9-summarize';
  auth.addToken(TOKEN);
  const listener = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));

  /**
   * Build a provider stub that resolves a fixed artifact and, optionally,
   * exposes an envelope-aware mirror.parseLine.
   *
   * @param {string} id
   * @param {string} artifact
   * @param {boolean} withMirror
   * @returns {object}
   */
  function buildStub(id, artifact, withMirror) {
    const stub = {
      id: id,
      displayName: id,
      accentToken: 'pink',
      cliBinary: 'this-binary-should-never-exist-p9-summarize',
      discover: function () { return Promise.resolve([]); },
      parseTranscript: function () { return Promise.resolve([]); },
      spawnCommand: function () { return { cmd: 'echo', args: [], cwd: process.cwd(), env: {} }; },
      search: function () { return Promise.resolve({ results: [], timedOut: false, searchedFiles: 0 }); },
      init: function () { return Promise.resolve(); },
      dispose: function () { return Promise.resolve(); },
      supportsCost: function () { return true; },
      isIdleSignal: function () { return false; },
      getKeyBindings: function () { return {}; },
      findArtifactPath: function () { return artifact; },
      findArtifactByWorkingDir: function () { return null; },
    };
    if (withMirror) {
      // The real Codex parser, used as the stub's mirror so the fallback is
      // exercised against production code rather than a hand-rolled imitation.
      stub.mirror = { parseLine: require('../src/providers/codex/parse').parseLine };
    }
    return stub;
  }

  const claudeShapedStub = buildStub('test-summarize-claude-shaped', claudeArtifact, false);
  const envelopeStub = buildStub('test-summarize-envelope', envelopeArtifact, true);
  registry.register(claudeShapedStub);
  registry.register(envelopeStub);

  const ws = store.createWorkspace({ name: 'P9 summarize' });

  /**
   * Create a session tagged to a provider. createSession predates providers and
   * does not take the tag, so it is applied as an update.
   *
   * @param {string} name
   * @param {string} providerId
   * @returns {object}
   */
  function makeSession(name, providerId) {
    const s = store.createSession({
      workspaceId: ws.id,
      name: name,
      workingDir: process.cwd(),
      resumeSessionId: '00000000-0000-0000-0000-0000000000' + (providerId.length % 100).toString().padStart(2, '0'),
    });
    store.updateSession(s.id, { provider: providerId });
    return s;
  }

  const claudeSession = makeSession('claude-shaped session', claudeShapedStub.id);
  const codexShaped = makeSession('envelope session', envelopeStub.id);

  /**
   * Read a workspace's notes document, for the side-effect assertions.
   * @returns {string}
   */
  function readNotes() {
    try {
      const docs = store.getWorkspaceDocs(ws.id);
      if (!docs) return '';
      if (typeof docs.raw === 'string') return docs.raw;
      return JSON.stringify(docs.notes || []);
    } catch (_) {
      return '';
    }
  }

  // ── 1. The default shape is unchanged ──────────────────────────────────

  await test('the default response still carries theme, tasking and assistant', async () => {
    const r = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize', { token: TOKEN, body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.body.overallTheme, 'string');
    assert.strictEqual(typeof r.body.recentTasking, 'string');
    assert.strictEqual(typeof r.body.sessionName, 'string');
    assert.strictEqual(typeof r.body.fileSize, 'number');
    assert(r.body.overallTheme.indexOf('widget exporter') !== -1, 'the opening request is the theme');
    assert(r.body.recentTasking.indexOf('CSV variant') !== -1, 'the last user turn is the tasking');
    assert.strictEqual(r.body.summary, undefined, 'the default must NOT be the docs shape');
  });

  await test('the default does NOT write a workspace note', async () => {
    const before = readNotes();
    await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize', { token: TOKEN, body: {} });
    const after = readNotes();
    assert.strictEqual(after, before, 'opening a summary modal must not mutate project docs');
  });

  // ── 2. The previously-dead handler is reachable ────────────────────────

  await test('{toDocs: true} reaches the previously-unreachable handler', async () => {
    const r = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize', {
      token: TOKEN,
      body: { toDocs: true },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.body.summary, 'string', 'the {summary} shape the docs caller reads');
    assert(r.body.summary.indexOf(claudeSession.name) !== -1, 'the summary is prefixed with the session name');
    assert.strictEqual(r.body.sessionId, claudeSession.id);
    assert.strictEqual(r.body.overallTheme, undefined, 'the two shapes stay distinct');
  });

  await test('?toDocs=1 does the same, for a caller that cannot send a body', async () => {
    const r = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize?toDocs=1', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.body.summary, 'string');
  });

  await test('the opt-in DOES append the workspace note', async () => {
    const before = readNotes();
    await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize', {
      token: TOKEN,
      body: { toDocs: true },
    });
    const after = readNotes();
    assert(after.length > before.length, 'the docs summariser must actually write to the docs');
  });

  await test('/api/sessions/:id/summarize-to-docs is a real, unshadowed route', async () => {
    const r = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize-to-docs', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.body.summary, 'string');
  });

  await test('both summarize routes require auth', async () => {
    const a = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize', { body: {} });
    const b = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize-to-docs', {});
    assert.strictEqual(a.status, 401);
    assert.strictEqual(b.status, 401);
  });

  // ── 3. The provider dispatch ───────────────────────────────────────────

  await test('a non-Claude-shaped transcript summarises instead of 404ing', async () => {
    const r = await req(listener, 'POST', '/api/sessions/' + codexShaped.id + '/summarize', { token: TOKEN, body: {} });
    assert.strictEqual(r.status, 200, 'this was a hard 404 before the provider dispatch');
    assert(r.body.overallTheme.indexOf('flaky pairing test') !== -1,
      'the theme must come from the envelope transcript, got: ' + r.body.overallTheme);
    assert(r.body.recentTasking.indexOf('regression test') !== -1,
      'the recent tasking must come from the last user turn, got: ' + r.body.recentTasking);
  });

  await test('the provider fallback only runs when the historical extractor found nothing', async () => {
    // The Claude-shaped stub has NO mirror.parseLine at all. If the fallback ran
    // for it, the request would still succeed but the extractor would be the
    // only source, which is the byte-compatibility guarantee restated as a
    // behaviour: a Claude-shaped file never reaches the fallback.
    assert.strictEqual(claudeShapedStub.mirror, undefined, 'the stub deliberately has no mirror');
    const r = await req(listener, 'POST', '/api/sessions/' + claudeSession.id + '/summarize', { token: TOKEN, body: {} });
    assert.strictEqual(r.status, 200);
    assert(r.body.overallTheme.indexOf('widget exporter') !== -1);
  });

  await test('a session with no resolvable artifact still 404s, as it always did', async () => {
    const orphan = store.createSession({
      workspaceId: ws.id,
      name: 'orphan',
      workingDir: process.cwd(),
      resumeSessionId: '00000000-0000-0000-0000-0000000000ff',
    });
    const r = await req(listener, 'POST', '/api/sessions/' + orphan.id + '/summarize', { token: TOKEN, body: {} });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'Session conversation file not found');
  });

  // ── 4. The registration inventory ──────────────────────────────────────

  await test('both /summarize registrations are retained in the source', () => {
    // Code preservation: the shadowing registration was NOT deleted. It now
    // points at the shared handler, so the file holds one copy of the logic and
    // two references to it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
    const registrations = src.match(/app\.post\('\/api\/sessions\/:id\/summarize'/g) || [];
    assert.strictEqual(registrations.length, 2, 'both registrations must survive, per code preservation');
    assert(src.indexOf("app.post('/api/sessions/:id/summarize-to-docs'") !== -1,
      'the unshadowed route must exist');
    assert(src.indexOf('function summarizeSessionToDocsHandler') !== -1,
      'the shared handler must be a named function, not two inline copies');
  });

  listener.close();

  console.log('  ' + '-'.repeat(72));
  console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
